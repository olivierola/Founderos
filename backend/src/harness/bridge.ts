// Le pont : les événements d'OpenCode deviennent les lignes que le front lit
// déjà (docs/harness-opencode).
//
//   outil appelé / réussi / échoué → internal_agent_run_events (tool_call, tool_result),
//                                    au format que lit RunTimeline
//   liste de tâches (todowrite)    → internal_agent_runs.todos + événement « todos »
//   question à la personne (form)  → run « awaiting_input » (le cycle de vie l'affiche)
//   texte en cours d'écriture      → internal_agent_runs.live_output (au plus toutes les 700 ms)
//   fin d'étape (coût, tokens)     → internal_agent_runs + llm_usage ; plafond de dépense
//   fin d'exécution                → le cycle de vie (lifecycle.ts) : contrat, livrables,
//                                    réponse, salle, mission, workflow ; ou, sans lui,
//                                    le run terminé et la réponse dans la conversation
//   nouvelle tentative, compaction → événements « status »
//
// Un run est attaché à SA session OpenCode (bind). Les écritures d'une même
// session passent dans l'ordre (une file par session). Les runs encore en
// cours au démarrage sont réattachés : OpenCode reprend leur session, et le
// pont reprend leur timeline. Un sous-agent écrit dans le run de la session
// qui l'a lancé.

import type { OpenCodeHost } from "./host.ts";
import type { BoundRun, HarnessStore } from "./store.ts";

type Ev = { type: string; data?: Record<string, any> };

/** Un appel d'outil du run, pour le contrat (preuves) et la timeline. */
export interface TrailEntry {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result: string;
}

/** Ce qu'une exécution a donné, remis au cycle de vie. */
export interface RunOutcome {
  status: "succeeded" | "failed" | "cancelled";
  /** La réponse finale de l'agent (succès), ou le message d'erreur. */
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  toolCalls: number;
  model: { id: string; provider: string };
  trail: TrailEntry[];
}

/** Une question que l'agent pose (outil question d'OpenCode : un formulaire). */
export interface RunQuestion {
  formId: string;
  sessionId: string;
  title: string;
  fields: Array<{ key: string; title?: string; description?: string; options?: string[]; multiple?: boolean }>;
}

interface SessionState {
  run: BoundRun;
  queue: Promise<void>;
  toolNames: Map<string, string>;
  toolArgs: Map<string, Record<string, unknown>>;
  /** Les textes de chaque message de l'agent, dans l'ordre (le dernier = la réponse). */
  texts: Map<string, string[]>;
  lastAssistant: string | null;
  live: string;
  liveTimer: ReturnType<typeof setTimeout> | null;
  liveAt: number;
  model: { id: string; provider: string };
  cost: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  toolCalls: number;
  trail: TrailEntry[];
  ended: boolean;
}

export interface Bridge {
  /** Attache un run à sa session : ses événements vont désormais à ce run. */
  bind(run: BoundRun): void;
  /** Résolu quand le run de cette session est terminé (tests, arrêt). */
  settled(sessionId: string): Promise<void>;
  /** Le run d'une session, ou de la session parente d'un sous-agent ; null hors run. */
  binding(sessionId: string): BoundRun | null;
  stop(): Promise<void>;
}

export interface BridgeOptions {
  liveIntervalMs?: number;
  /** Intervalle de vérification des runs annulés depuis le front. */
  cancelPollMs?: number;
  log?: (message: string) => void;
  /**
   * La fin d'une exécution, confiée au cycle de vie des runs. « continue » : il
   * a relancé la session (contrat non tenu, livrable manquant) et le run reste
   * attaché ; « done » : le run est clos. Absent : le pont clôt lui-même le run
   * et écrit la réponse dans la conversation.
   */
  settle?: (run: BoundRun, outcome: RunOutcome) => Promise<"done" | "continue">;
  /** L'agent pose une question : absent, la question reste en attente dans OpenCode. */
  question?: (run: BoundRun, q: RunQuestion) => Promise<void>;
  /** Après chaque étape : vrai pour arrêter le run (plafond de dépense atteint). */
  overBudget?: (run: BoundRun, totals: { costUsd: number; tokensIn: number; tokensOut: number }) => Promise<string | null>;
}

/** Les arguments longs raccourcis pour la timeline (comme l'ancien moteur). */
function compactArgs(a: unknown): unknown {
  if (!a || typeof a !== "object") return a;
  return Object.fromEntries(Object.entries(a as Record<string, unknown>).map(([k, v]) => [
    k, typeof v === "string" && v.length > 700 ? `${v.slice(0, 700)}… (+${v.length - 700} chars)` : v,
  ]));
}

/** Le texte d'un contenu d'outil (parties texte seulement). */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : "")).filter(Boolean).join("\n");
}

/** La liste de tâches d'OpenCode (todowrite) au format de internal_agent_runs.todos. */
export function todosFromTodowrite(input: unknown): Array<{ id: string; title: string; status: string }> | null {
  const list = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(list)) return null;
  const status = (s: unknown) => {
    switch (String(s ?? "")) {
      case "in_progress": return "active";
      case "completed": return "done";
      case "cancelled": return "blocked";
      default: return "pending";
    }
  };
  return list.map((t, i) => {
    const o = (t ?? {}) as Record<string, unknown>;
    return { id: String(o.id ?? `step-${i + 1}`), title: String(o.content ?? o.title ?? "").slice(0, 140), status: status(o.status) };
  });
}

export function startBridge(opencode: OpenCodeHost, store: HarnessStore, options: BridgeOptions = {}): Bridge {
  const liveInterval = options.liveIntervalMs ?? 700;
  const log = options.log ?? ((m: string) => console.warn(`[harness] ${m}`));
  const sessions = new Map<string, SessionState>();
  // Sous-agent → session qui l'a lancé (événement session.created).
  const parents = new Map<string, string>();
  const waiters = new Map<string, Array<() => void>>();
  let stopped = false;

  const finish = (sessionId: string) => {
    sessions.delete(sessionId);
    for (const w of waiters.get(sessionId) ?? []) w();
    waiters.delete(sessionId);
  };

  const enqueue = (s: SessionState, work: () => Promise<void>) => {
    s.queue = s.queue.then(work).catch((e) => log(`pont : ${e instanceof Error ? e.message : String(e)}`));
  };

  const flushLive = (s: SessionState) => {
    s.liveTimer = null;
    s.liveAt = Date.now();
    const text = s.live;
    enqueue(s, () => store.updateRun(s.run.runId, { live_output: text.slice(-8000) || null, live_output_at: new Date().toISOString() }));
  };

  const bind = (run: BoundRun) => {
    sessions.set(run.sessionId, {
      run, queue: Promise.resolve(), toolNames: new Map(), toolArgs: new Map(), texts: new Map(), lastAssistant: null,
      live: "", liveTimer: null, liveAt: 0, model: { id: "", provider: "" },
      cost: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, toolCalls: 0, trail: [], ended: false,
    });
  };

  /** La session liée à ce sessionID : la sienne, ou celle qui a lancé ce sous-agent. */
  const stateOf = (sessionId: string): SessionState | undefined => {
    let id: string | undefined = sessionId;
    for (let hops = 0; id && hops < 8; hops++) {
      const s = sessions.get(id);
      if (s) return s;
      id = parents.get(id);
    }
    return undefined;
  };

  const usage = (s: SessionState, d: Record<string, any>, source: "step" | "title" | "compaction" | "generate") => {
    const tokens = d.tokens ?? {};
    const input = Number(tokens.input) || 0;
    const output = (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0);
    const cached = Number(tokens.cache?.read) || 0;
    const cost = Number(d.cost) || 0;
    s.cost += cost; s.tokensIn += input; s.tokensOut += output; s.tokensCached += cached;
    enqueue(s, async () => {
      await store.logUsage({
        workspaceId: s.run.workspaceId, projectId: s.run.projectId, runId: s.run.runId, agentId: s.run.agentId,
        model: s.model.id, provider: s.model.provider, promptTokens: input, completionTokens: output,
        cachedTokens: cached, costUsd: cost, source,
      });
      await store.updateRun(s.run.runId, {
        cost_usd: Number(s.cost.toFixed(6)), tokens_in: s.tokensIn, tokens_out: s.tokensOut, action_count: s.toolCalls,
      });
      // Le plafond de dépense du run et les crédits de l'espace : au-delà, on arrête.
      if (options.overBudget && source === "step" && !s.ended) {
        const reason = await options.overBudget(s.run, { costUsd: s.cost, tokensIn: s.tokensIn, tokensOut: s.tokensOut }).catch(() => null);
        if (reason) {
          await store.insertEvent(s.run.runId, s.run.agentId, "error", { error: reason });
          await opencode.session.interrupt({ sessionID: s.run.sessionId }).catch(() => {});
        }
      }
    });
  };

  const outcomeOf = (s: SessionState, status: RunOutcome["status"], text: string): RunOutcome => ({
    status, text, tokensIn: s.tokensIn, tokensOut: s.tokensOut, costUsd: Number(s.cost.toFixed(6)),
    toolCalls: s.toolCalls, model: s.model, trail: s.trail,
  });

  /** Fin d'exécution : le cycle de vie décide ; sans lui, le comportement de base. */
  const settleRun = (s: SessionState, outcome: RunOutcome) => {
    const sessionId = s.run.sessionId;
    enqueue(s, async () => {
      if (options.settle) {
        let next: "done" | "continue" = "done";
        try {
          next = await options.settle(s.run, outcome);
        } catch (e) {
          log(`cycle de vie du run ${s.run.runId} : ${e instanceof Error ? e.message : String(e)}`);
          await store.updateRun(s.run.runId, {
            status: "failed", finished_at: new Date().toISOString(), live_output: null,
            error_message: `fin de run impossible : ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
          }).catch(() => {});
        }
        if (next === "continue") {
          // Relancé dans la même session : un nouveau tour du même run.
          s.ended = false;
          s.texts.clear();
          s.lastAssistant = null;
          return;
        }
        finish(sessionId);
        return;
      }
      // Sans cycle de vie (tests du pont) : le run clos, la réponse écrite.
      if (outcome.status === "succeeded") {
        if (s.run.conversationId) {
          await store.insertAssistantMessage({
            conversationId: s.run.conversationId, agentId: s.run.agentId, runId: s.run.runId, content: outcome.text,
            tokensIn: outcome.tokensIn, tokensOut: outcome.tokensOut, costUsd: outcome.costUsd,
          });
          await store.touchConversation(s.run.conversationId);
        }
        await store.updateRun(s.run.runId, {
          status: "succeeded", finished_at: new Date().toISOString(), final_output: outcome.text.slice(0, 2000),
          live_output: null, action_count: s.toolCalls, steps: s.toolCalls,
        });
      } else if (outcome.status === "failed") {
        await store.insertEvent(s.run.runId, s.run.agentId, "error", { error: outcome.text });
        if (s.run.conversationId) {
          await store.insertAssistantMessage({
            conversationId: s.run.conversationId, agentId: s.run.agentId, runId: s.run.runId, content: `⚠️ Le run a échoué : ${outcome.text}`,
            tokensIn: outcome.tokensIn, tokensOut: outcome.tokensOut, costUsd: outcome.costUsd,
          });
          await store.touchConversation(s.run.conversationId);
        }
        await store.updateRun(s.run.runId, { status: "failed", finished_at: new Date().toISOString(), error_message: outcome.text, live_output: null });
      } else {
        await store.updateRun(s.run.runId, { status: "cancelled", finished_at: new Date().toISOString(), live_output: null });
      }
      finish(sessionId);
    });
  };

  const handle = (ev: Ev) => {
    const d = ev.data ?? {};
    if (ev.type === "session.created") {
      const info = (d.info ?? d) as { id?: unknown; parentID?: unknown };
      if (typeof info.id === "string" && typeof info.parentID === "string") parents.set(info.id, info.parentID);
      return;
    }
    if (ev.type === "form.created") {
      const form = (d.form ?? {}) as { id?: string; sessionID?: string; title?: string; fields?: Array<Record<string, any>> };
      const s = form.sessionID ? stateOf(form.sessionID) : undefined;
      if (!s || s.ended || !form.id || !options.question) return;
      const q: RunQuestion = {
        formId: form.id, sessionId: form.sessionID!, title: String(form.title ?? ""),
        fields: (form.fields ?? []).filter((f) => !f.hidden).map((f) => ({
          key: String(f.key), title: f.title, description: f.description,
          options: Array.isArray(f.options) ? f.options.map((o: Record<string, unknown>) => String(o.label ?? o.title ?? o.value ?? "")) : undefined,
          multiple: f.type === "multiselect",
        })),
      };
      enqueue(s, () => options.question!(s.run, q));
      return;
    }
    if (typeof d.sessionID !== "string") return;
    const own = sessions.get(d.sessionID);
    // Un sous-agent : ses appels d'outils vont dans la timeline du run qui l'a lancé.
    const s = own ?? stateOf(d.sessionID);
    if (!s || s.ended) return;
    const { runId, agentId } = s.run;
    switch (ev.type) {
      case "session.step.started":
        if (own && d.model) s.model = { id: String(d.model.id ?? ""), provider: String(d.model.providerID ?? "") };
        return;
      case "session.tool.input.started":
        s.toolNames.set(`${d.sessionID}:${d.assistantMessageID}:${d.id}`, String(d.name ?? "outil"));
        return;
      case "session.tool.called": {
        s.toolCalls++;
        const key = `${d.sessionID}:${d.assistantMessageID}:${d.id}`;
        const tool = s.toolNames.get(key) ?? "outil";
        const args = (d.input && typeof d.input === "object" ? d.input : {}) as Record<string, unknown>;
        s.toolArgs.set(key, args);
        enqueue(s, () => store.insertEvent(runId, agentId, "tool_call", { tool, args: compactArgs(args), ...(own ? {} : { subagent: true }) }));
        if (tool === "todowrite" && own) {
          const todos = todosFromTodowrite(args);
          if (todos) {
            enqueue(s, async () => {
              await store.updateRun(runId, { todos });
              await store.insertEvent(runId, agentId, "todos", { todos });
            });
          }
        }
        return;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const key = `${d.sessionID}:${d.assistantMessageID}:${d.id}`;
        const tool = s.toolNames.get(key) ?? "outil";
        const ok = ev.type === "session.tool.success";
        const preview = ok ? contentText(d.content) : `ERROR: ${String(d.error?.message ?? "échec")}`;
        s.trail.push({ name: tool, args: s.toolArgs.get(key) ?? {}, ok: ok && !preview.startsWith("ERROR"), result: preview.slice(0, 2000) });
        if (s.trail.length > 400) s.trail.splice(0, s.trail.length - 400);
        enqueue(s, () => store.insertEvent(runId, agentId, "tool_result", { tool, preview: preview.slice(0, 1000), ok, ...(own ? {} : { subagent: true }) }));
        return;
      }
      default:
        break;
    }
    // Le reste ne vaut que pour la session du run elle-même.
    if (!own) return;
    switch (ev.type) {
      case "session.text.delta":
        s.live += String(d.delta ?? "");
        if (!s.liveTimer) s.liveTimer = setTimeout(() => flushLive(s), Math.max(0, liveInterval - (Date.now() - s.liveAt)));
        return;
      case "session.text.ended": {
        const key = String(d.assistantMessageID ?? "");
        const list = s.texts.get(key) ?? [];
        list.push(String(d.text ?? ""));
        s.texts.set(key, list);
        s.lastAssistant = key;
        return;
      }
      case "session.step.ended":
        if (s.liveTimer) { clearTimeout(s.liveTimer); s.liveTimer = null; }
        s.live = "";
        usage(s, d, "step");
        enqueue(s, () => store.updateRun(runId, { live_output: null }));
        return;
      case "session.step.failed":
        if (d.tokens) usage(s, d, "step");
        return;
      case "session.usage.recorded":
        usage(s, d, (d.source as "title" | "compaction" | "generate") ?? "generate");
        return;
      case "session.retry.scheduled":
        enqueue(s, () => store.insertEvent(runId, agentId, "status", {
          message: `Nouvelle tentative (${d.attempt}) : ${String(d.error?.message ?? "erreur du fournisseur").slice(0, 200)}`,
        }));
        return;
      case "session.compaction.ended":
        enqueue(s, () => store.insertEvent(runId, agentId, "status", { message: "Contexte compacté : résumé structuré de l'historique ancien." }));
        return;
      case "session.execution.succeeded": {
        s.ended = true;
        if (s.liveTimer) clearTimeout(s.liveTimer);
        const final = (s.lastAssistant ? s.texts.get(s.lastAssistant) ?? [] : []).join("\n\n").trim()
          || "Terminé — voir le détail des étapes ci-dessus.";
        settleRun(s, outcomeOf(s, "succeeded", final));
        return;
      }
      case "session.execution.failed": {
        s.ended = true;
        if (s.liveTimer) clearTimeout(s.liveTimer);
        settleRun(s, outcomeOf(s, "failed", String(d.error?.message ?? "échec de l'exécution").slice(0, 500)));
        return;
      }
      case "session.execution.interrupted":
        // Arrêt du backend : la session sera reprise au redémarrage, le run reste attaché.
        if (d.reason === "shutdown") return;
        s.ended = true;
        if (s.liveTimer) clearTimeout(s.liveTimer);
        settleRun(s, outcomeOf(s, "cancelled", String(d.reason ?? "interrompu")));
        return;
      default:
        return;
    }
  };

  // Les événements de tout l'hôte, une seule souscription.
  const loop = (async () => {
    for await (const ev of opencode.events.subscribe()) {
      if (stopped) return;
      try { handle(ev as Ev); } catch (e) { log(`événement ${String((ev as Ev).type)} : ${e instanceof Error ? e.message : String(e)}`); }
    }
  })().catch((e) => { if (!stopped) log(`flux d'événements interrompu : ${e instanceof Error ? e.message : String(e)}`); });

  // Les runs annulés depuis le front (statut « cancelled » en base) : on
  // interrompt leur session ; OpenCode arrête les outils proprement.
  const cancelTimer = setInterval(() => {
    const ids = [...sessions.values()].filter((s) => !s.ended).map((s) => s.run.runId);
    if (!ids.length) return;
    store.cancelledAmong(ids).then(async (cancelled) => {
      for (const s of [...sessions.values()].filter((x) => cancelled.includes(x.run.runId))) {
        await opencode.session.interrupt({ sessionID: s.run.sessionId }).catch(() => {});
      }
    }).catch(() => {});
  }, options.cancelPollMs ?? 2000);
  // Une minuterie de surveillance ne doit pas, seule, garder le processus en vie.
  cancelTimer.unref?.();

  // Les runs en cours avant un redémarrage : réattachés.
  void store.runningRuns().then((runs) => { for (const r of runs) if (!sessions.has(r.sessionId)) bind(r); }).catch(() => {});

  return {
    bind,
    binding: (sessionId) => stateOf(sessionId)?.run ?? null,
    settled: (sessionId) => {
      if (!sessions.has(sessionId)) return Promise.resolve();
      return new Promise((resolve) => waiters.set(sessionId, [...(waiters.get(sessionId) ?? []), resolve]));
    },
    stop: async () => {
      stopped = true;
      clearInterval(cancelTimer);
      await Promise.all([...sessions.values()].map((s) => s.queue));
      void loop;
    },
  };
}
