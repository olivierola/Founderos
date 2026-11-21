// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/harness-hooks.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// Les hooks du harnais, d'après le système de plugins d'OpenCode.
//
// Tout ce qui entourait un appel d'outil vivait dans une seule fonction du
// tick (loggingExecutor, internal-agent-run) : déduplication des recherches,
// réponse depuis la mémoire, garde-fous avant et après, faux outils des évals,
// disjoncteur, journal, trouvailles, sonde mémoire… Cent lignes où chaque
// ajout se glissait entre deux autres, et qu'aucun test ne pouvait isoler.
//
// Un hook est une ÉTAPE NOMMÉE d'un domaine. Les domaines :
//
//   tool.before — avant l'exécution : peut corriger les arguments, ou rendre
//                 un résultat à la place de l'outil (court-circuit) ;
//   tool.after  — après : peut remplacer le résultat (diagnostic, rédaction,
//                 enrichissement) ;
//   model.retry — avant de rejouer un appel de modèle en échec : peut refuser
//                 la nouvelle tentative ou changer son délai ;
//   run.idle    — quand le modèle a fini son tour : peut garder le run en vie
//                 (des messages à traiter) ou le mettre en attente.
//
// Les étapes s'exécutent dans l'ordre d'inscription. Un hook qui lève une
// erreur est ignoré (le pipeline continue), sauf s'il est CRITIQUE (un
// garde-fou : en cas de doute, on n'exécute pas) ou s'il lève un signal de
// contrôle (run annulé, attente d'un humain), qui remonte toujours.

import type { ChatMessage, ToolExecutor } from "./ai.ts";

const CONTROL_FLOW = new Set(["RunCancelledError", "AwaitingInputError", "AwaitingApprovalError"]);
const isControl = (e: unknown) => CONTROL_FLOW.has((e as { name?: string } | null)?.name ?? "");

export interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
  callId?: string;
  signal?: AbortSignal;
}

export interface ToolBeforeOutcome {
  /** Les arguments à utiliser à la place (étapes suivantes et outil). */
  args?: Record<string, unknown>;
  /** Un résultat rendu À LA PLACE de l'outil : il ne s'exécute pas. */
  result?: string;
}

export interface ToolAfterEvent extends ToolCallInfo {
  result: string;
  ok: boolean;
  /** Le hook qui a court-circuité l'outil, s'il y en a eu un. */
  shortCircuitBy?: string;
}

export interface RetryEvent {
  attempt: number;
  status: number | null;
  error: string;
  /** Le délai que la politique par défaut s'apprête à attendre. */
  delayMs: number;
}

export interface IdleEvent {
  runId: string;
  /** Le modèle a rendu une réponse finale (sinon : budget, arrêt…). */
  finished: boolean;
  content: string;
}

export interface IdleOutcome {
  /** Des messages à ajouter : le run continue au lieu de finir. */
  keepWorking?: ChatMessage[];
  /** Le run se met en attente (sans finir) ; la raison est tracée. */
  wait?: string;
}

type ToolBefore = (call: ToolCallInfo) => Promise<ToolBeforeOutcome | void> | ToolBeforeOutcome | void;
type ToolAfter = (e: ToolAfterEvent) => Promise<string | void> | string | void;
type RetryHook = (e: RetryEvent) => { retry?: boolean; delayMs?: number } | void;
type IdleHook = (e: IdleEvent) => Promise<IdleOutcome | void> | IdleOutcome | void;

interface Entry<F> { id: string; fn: F; critical: boolean }

export const isOkResult = (r: string) => !/^\s*(ERROR|ERREUR)\b/.test(r);

export class HarnessHooks {
  private readonly before: Entry<ToolBefore>[] = [];
  private readonly after: Entry<ToolAfter>[] = [];
  private readonly retry: Entry<RetryHook>[] = [];
  private readonly idle: Entry<IdleHook>[] = [];
  /** Les erreurs de hooks ignorées, pour la télémétrie du tick. */
  readonly failures: Array<{ hook: string; error: string }> = [];

  onToolBefore(id: string, fn: ToolBefore, opts: { critical?: boolean } = {}): this {
    this.before.push({ id, fn, critical: !!opts.critical });
    return this;
  }
  onToolAfter(id: string, fn: ToolAfter, opts: { critical?: boolean } = {}): this {
    this.after.push({ id, fn, critical: !!opts.critical });
    return this;
  }
  onRetry(id: string, fn: RetryHook): this {
    this.retry.push({ id, fn, critical: false });
    return this;
  }
  onIdle(id: string, fn: IdleHook): this {
    this.idle.push({ id, fn, critical: false });
    return this;
  }

  /** Les étapes inscrites, par domaine (télémétrie, tests). */
  describe(): Record<"tool.before" | "tool.after" | "model.retry" | "run.idle", string[]> {
    return {
      "tool.before": this.before.map((e) => e.id),
      "tool.after": this.after.map((e) => e.id),
      "model.retry": this.retry.map((e) => e.id),
      "run.idle": this.idle.map((e) => e.id),
    };
  }

  private fail(id: string, e: unknown) {
    this.failures.push({ hook: id, error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200) });
  }

  /** L'exécuteur entouré des étapes tool.before / tool.after. */
  wrapExecutor(exec: ToolExecutor): ToolExecutor {
    return async (name, rawArgs, callCtx) => {
      let args = rawArgs ?? {};
      let result: string | undefined;
      let shortCircuitBy: string | undefined;
      for (const h of this.before) {
        try {
          const out = await h.fn({ name, args, callId: callCtx?.callId, signal: callCtx?.signal });
          if (out?.args) args = out.args;
          if (typeof out?.result === "string") { result = out.result; shortCircuitBy = h.id; break; }
        } catch (e) {
          if (isControl(e)) throw e;
          if (h.critical) {
            result = `ERROR: contrôle « ${h.id} » indisponible (${e instanceof Error ? e.message.slice(0, 160) : "erreur"}) — l'outil n'a PAS été exécuté, par prudence.`;
            shortCircuitBy = h.id;
            break;
          }
          this.fail(h.id, e);
        }
      }
      if (result === undefined) result = String(await exec(name, args, callCtx));
      for (const h of this.after) {
        try {
          const out = await h.fn({ name, args, callId: callCtx?.callId, signal: callCtx?.signal, result, ok: isOkResult(result), shortCircuitBy });
          if (typeof out === "string") result = out;
        } catch (e) {
          if (isControl(e)) throw e;
          if (h.critical) {
            result = `ERROR: contrôle « ${h.id} » indisponible sur le résultat — résultat retenu par prudence.`;
            continue;
          }
          this.fail(h.id, e);
        }
      }
      return result;
    };
  }

  /** La décision de nouvelle tentative après les hooks model.retry. */
  decideRetry(e: RetryEvent): { retry: boolean; delayMs: number } {
    let decision = { retry: true, delayMs: e.delayMs };
    for (const h of this.retry) {
      try {
        const out = h.fn({ ...e, delayMs: decision.delayMs });
        if (!out) continue;
        if (out.retry === false) return { retry: false, delayMs: decision.delayMs };
        if (Number.isFinite(out.delayMs) && (out.delayMs as number) >= 0) decision = { retry: true, delayMs: Math.ceil(out.delayMs as number) };
      } catch (err) {
        this.fail(h.id, err);
      }
    }
    return decision;
  }

  /** Le premier hook run.idle qui rend une décision l'emporte. */
  async runIdle(e: IdleEvent): Promise<(IdleOutcome & { by: string }) | null> {
    for (const h of this.idle) {
      try {
        const out = await h.fn(e);
        if (out && (out.keepWorking?.length || out.wait)) return { ...out, by: h.id };
      } catch (err) {
        if (isControl(err)) throw err;
        this.fail(h.id, err);
      }
    }
    return null;
  }
}
