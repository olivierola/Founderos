// Le contrôleur de boucle (ancien moteur, runMissionTick + agent-loop.ts), sur
// les étapes d'OpenCode. Après chaque étape d'un run, il lit les appels d'outils
// nouveaux et décide avec la même fonction pure (decideNext) :
//
//   boucle      le même appel répété (4 fois), ou un cycle (la moitié des appels
//               récents déjà vus) ; et, quand rien d'autre n'a sonné, la boucle
//               DÉGUISÉE que juge AgentPilot (judgeSemanticLoop) ;
//   disjoncteur un outil en échec 3 fois d'affilée ;
//   stagnation  des étapes sans progrès (ni tâche cochée, ni livrable, ni outil neuf) ;
//   garde-fous  des refus en série ;
//   budgets     étapes et dépense du run (max_steps, max_run_cost_usd).
//
// Ce qu'il fait de la décision : une consigne glissée dans la session (« steer »),
// le modèle lourd pour la suite (escalade), une question à la personne quand le
// blocage ne dépend que d'elle (AgentPilot, judgeNeedsHuman), la consigne de
// finir avec l'acquis au budget, l'arrêt du run quand il s'emballe. Chaque
// décision hors « continuer » est tracée (événement « loop », AgentPilot).

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "../edge/_shared/supabase-admin.ts";
import { decideNext, resolveBudgets, type LoopSignals } from "../edge/_shared/agent-loop.ts";
import { judgeNeedsHuman, judgeSemanticLoop, recordDecision } from "../edge/_shared/agentpilot.ts";
import type { TrailEntry } from "./bridge.ts";
import type { BoundRun } from "./store.ts";
import { legacyNameFor } from "./toolkit/catalogue.ts";

type Admin = SupabaseClient;

/** Les appels qui produisent quelque chose : leur succès compte comme un progrès. */
const PRODUCING = new Set([
  "create_deliverable", "report_section", "request_report", "create_artifact", "update_artifact", "add_block",
  "publish_artifact", "generate_pdf", "generate_image", "link_artifact", "render_ui",
]);
const GUARDRAIL_DENIAL = /^ERROR: Action bloquée par le guardrail/;
/** Étapes sans progrès qui valent un « tick » stagnant de l'ancien moteur. */
const STEPS_PER_TICK = 4;
/** Le jugement d'AgentPilot au plus toutes les N étapes (il coûte un appel). */
const JUDGE_EVERY = 4;

interface ControlState {
  seen: number;
  lastSig: string;
  sigCount: number;
  recentSigs: string[];
  toolFails: Map<string, number>;
  errorCount: number;
  recentErrors: string[];
  replans: number;
  progressKey: string;
  stepsNoProgress: number;
  lastJudgeStep: number;
  denialsConsecutive: number;
  denialsTotal: number;
  wrapupSent: boolean;
  abort: string | null;
  budgets: { maxRounds: number; maxCostUsd: number } | null;
}

export interface ControllerDeps {
  /** Glisse une consigne dans la session en cours (pris en compte à l'étape suivante). */
  steer(sessionId: string, text: string): Promise<void>;
  /** Le modèle lourd pour la suite de la session ; null s'il n'y en a pas d'autre. */
  escalate(run: BoundRun): Promise<string | null>;
  /** Arrête la session (le run s'emballe). */
  interrupt(sessionId: string): Promise<void>;
  admin?: () => Admin;
}

/** Les consignes de l'ancien contrôleur, avec les outils du harnais. */
function translate(text: string, attended: boolean): string {
  let t = text
    .replace(/update_todos\s*(\(([^)]*)\))?/g, "todowrite")
    .replace(/search_context\(scope="run"[^)]*\)/g, "grep")
    .replace(/spawn_parallel_agents/g, "subagent");
  if (attended) t = t.replace(/ask_user/g, "question");
  else {
    // Personne ne répond en direct : l'agent ne peut pas poser de question.
    t = t.replace(/Call ask_user NOW with ONE precise question:[^.]*\./, "Personne ne te répond en direct : termine MAINTENANT ton travail en écrivant précisément ce qui manque, ce que tu as déjà fait et ce que tu feras une fois l'élément obtenu.")
      .replace(/appelle ask_user en expliquant/g, "termine en expliquant")
      .replace(/ask_user/g, "ton compte rendu final");
  }
  return t;
}

/** Ce qui mesure l'avancement : tâches cochées, livrables produits, outils distincts réussis. */
function progressKey(trail: TrailEntry[]): string {
  let done = 0;
  for (const t of trail) {
    if (t.name !== "todowrite" || !t.ok) continue;
    const todos = (t.args as { todos?: Array<{ status?: string }> }).todos;
    if (Array.isArray(todos)) done = todos.filter((x) => x?.status === "completed").length;
  }
  const produced = trail.filter((t) => t.ok && PRODUCING.has(legacyNameFor(t.name, t.args))).length;
  const distinct = new Set(trail.filter((t) => t.ok).map((t) => legacyNameFor(t.name, t.args))).size;
  return `${done}:${produced}:${distinct}`;
}

export function createController(deps: ControllerDeps) {
  const states = new Map<string, ControlState>();
  const admin = () => (deps.admin?.() ?? createServiceClient()) as unknown as Admin;
  const stateOf = (runId: string): ControlState => {
    let s = states.get(runId);
    if (!s) {
      s = {
        seen: 0, lastSig: "", sigCount: 0, recentSigs: [], toolFails: new Map(), errorCount: 0, recentErrors: [],
        replans: 0, progressKey: "", stepsNoProgress: 0, lastJudgeStep: 0, denialsConsecutive: 0, denialsTotal: 0,
        wrapupSent: false, abort: null, budgets: null,
      };
      states.set(runId, s);
      while (states.size > 128) states.delete(states.keys().next().value as string);
    }
    return s;
  };

  const event = (run: BoundRun, kind: string, payload: Record<string, unknown>) =>
    admin().from("internal_agent_run_events").insert({ run_id: run.runId, agent_id: run.agentId, kind, payload }).then(() => {}, () => {});

  return {
    /** Après chaque étape du run : les signaux, la décision, son application. */
    async afterStep(run: BoundRun, info: { trail: TrailEntry[]; steps: number; costUsd: number }): Promise<void> {
      const s = stateOf(run.runId);
      if (s.abort) return;
      const fresh = info.trail.slice(s.seen);
      s.seen = info.trail.length;

      // ── Les appels nouveaux ──
      let loopDetected = false;
      let cycleHits = 0;
      for (const c of fresh) {
        const legacy = legacyNameFor(c.name, c.args);
        const sig = `${legacy}:${JSON.stringify(c.args ?? {}).slice(0, 180)}`;
        if (sig === s.lastSig) s.sigCount++;
        else { s.lastSig = sig; s.sigCount = 1; }
        if (s.sigCount >= 4) loopDetected = true;
        if (s.recentSigs.includes(sig)) cycleHits++;
        s.recentSigs.push(sig);
        if (s.recentSigs.length > 12) s.recentSigs.shift();
        if (c.ok) {
          s.toolFails.set(legacy, 0);
        } else {
          s.toolFails.set(legacy, (s.toolFails.get(legacy) ?? 0) + 1);
          s.errorCount++;
          s.recentErrors.push(c.result.slice(0, 300));
          if (s.recentErrors.length > 12) s.recentErrors.shift();
        }
        if (GUARDRAIL_DENIAL.test(c.result)) { s.denialsConsecutive++; s.denialsTotal++; } else if (c.ok) s.denialsConsecutive = 0;
      }
      if (fresh.length >= 4 && cycleHits >= Math.ceil(fresh.length / 2)) loopDetected = true;

      // ── L'avancement ──
      const key = progressKey(info.trail);
      if (key !== s.progressKey) { s.progressKey = key; s.stepsNoProgress = 0; } else s.stepsNoProgress++;

      // ── AgentPilot : la boucle déguisée, quand rien d'autre n'a sonné ──
      const task = String((run.meta as { task?: string } | undefined)?.task ?? "");
      const pilotCtx = { admin: admin() as never, workspaceId: run.workspaceId, projectId: run.projectId, runId: run.runId, agentId: run.agentId };
      let loopSource: "signature" | "semantic" | null = loopDetected ? "signature" : null;
      if (!loopDetected && fresh.length >= 1 && info.steps - s.lastJudgeStep >= JUDGE_EVERY && s.recentSigs.length >= 6) {
        s.lastJudgeStep = info.steps;
        if (await judgeSemanticLoop(pilotCtx, task, s.recentSigs, s.recentErrors).catch(() => false)) {
          loopDetected = true;
          loopSource = "semantic";
        }
      }

      // ── Les budgets de l'agent ──
      if (!s.budgets) {
        const { data } = await admin().from("internal_agents").select("max_steps, max_run_cost_usd").eq("id", run.agentId).maybeSingle();
        s.budgets = resolveBudgets((data ?? {}) as { max_steps?: number; max_run_cost_usd?: number }, run.kind === "chat" ? "chat" : "mission");
      }

      const signals: LoopSignals = {
        finished: false,
        roundsUsed: info.steps,
        maxRounds: s.budgets.maxRounds,
        costUsd: info.costUsd,
        maxCostUsd: s.budgets.maxCostUsd,
        errorCount: s.errorCount,
        loopDetected,
        brokenTools: [...s.toolFails].filter(([, n]) => n >= 3).map(([t]) => t),
        stagnantTicks: Math.floor(s.stepsNoProgress / STEPS_PER_TICK),
        replans: s.replans,
        maxReplans: 3,
        guardrailDenials: { consecutive: s.denialsConsecutive, total: s.denialsTotal },
      };
      let decision = decideNext(signals);
      // AgentPilot : avant de replanifier, ce qui manque est-il hors de portée de l'agent ?
      if (decision.action === "replan") {
        const needsHuman = await judgeNeedsHuman(pilotCtx, task, decision.reason, s.recentErrors, "").catch(() => false);
        if (needsHuman) {
          signals.needsHuman = true;
          decision = decideNext(signals);
        }
      }

      const attended = (run.kind ?? "chat") === "chat";
      const steerText = decision.interventions.map((i) => translate(i.content, attended)).join("\n\n");

      switch (decision.action) {
        case "continue":
          // Un outil en panne ou des refus en série : la consigne part, sans replanifier.
          if (steerText) await deps.steer(run.sessionId, steerText).catch(() => {});
          // Les compteurs de ces consignes repartent de zéro : on ne la répète pas à chaque étape.
          if (signals.brokenTools.length) for (const t of signals.brokenTools) s.toolFails.set(t, 0);
          if (s.denialsConsecutive >= 3) s.denialsConsecutive = 0;
          return;
        case "replan": {
          if (steerText) await deps.steer(run.sessionId, steerText).catch(() => {});
          if (decision.consumesReplan) { s.replans++; s.errorCount = 0; s.stepsNoProgress = 0; s.sigCount = 0; s.recentSigs = []; }
          let escalated: string | null = null;
          if (decision.escalateModel) escalated = await deps.escalate(run).catch(() => null);
          await event(run, "status", { message: `${decision.reason}${escalated ? ` Modèle de raisonnement pour la suite : ${escalated}.` : ""}` });
          break;
        }
        case "finalize":
          // Budget atteint : on demande de finir avec l'acquis, une fois.
          if (s.wrapupSent) {
            if (info.steps >= s.budgets.maxRounds * 1.25) {
              s.abort = `${decision.reason} L'agent n'a pas conclu après la consigne de fin : arrêt.`;
              await deps.interrupt(run.sessionId).catch(() => {});
            }
            return;
          }
          s.wrapupSent = true;
          await deps.steer(run.sessionId, [
            steerText,
            `STOP : ${decision.reason} N'explore plus rien. Mets ta liste de tâches à jour une dernière fois (todowrite), enregistre ce qui est livrable, puis donne ta réponse finale : ce qui est FAIT, ce qui RESTE, et pourquoi.`,
          ].filter(Boolean).join("\n\n")).catch(() => {});
          await event(run, "status", { message: decision.reason });
          break;
        case "abort":
          s.abort = decision.reason;
          await event(run, "error", { error: decision.reason });
          await deps.interrupt(run.sessionId).catch(() => {});
          break;
      }
      await event(run, "loop", {
        phase: "control", action: decision.action, reason: decision.reason, loop: loopSource,
        needs_human: !!signals.needsHuman, steps: info.steps, cost_usd: Number(info.costUsd.toFixed(4)),
        errors: signals.errorCount, broken_tools: signals.brokenTools, stagnant: signals.stagnantTicks,
      });
      void recordDecision(pilotCtx, {
        kind: "controller", applied: true, decision: decision.action,
        detail: { reason: decision.reason, loop: loopSource, needs_human: !!signals.needsHuman, escalated_model: decision.escalateModel, steps: info.steps },
      });
    },

    /** La raison d'un arrêt décidé par le contrôleur (le run se termine en échec, pas en annulation). */
    abortReason: (runId: string) => states.get(runId)?.abort ?? null,
    forget: (runId: string) => { states.delete(runId); },
  };
}

export type Controller = ReturnType<typeof createController>;
