// Le pont : les événements d'OpenCode deviennent les lignes que le front lit
// déjà (docs/harness-opencode, phase 1).
//
//   outil appelé / réussi / échoué → internal_agent_run_events (tool_call, tool_result),
//                                    au format que lit RunTimeline
//   texte en cours d'écriture      → internal_agent_runs.live_output (au plus toutes les 700 ms)
//   fin d'étape (coût, tokens)     → internal_agent_runs + llm_usage
//   fin d'exécution                → run terminé, message de l'agent dans la conversation
//   nouvelle tentative, compaction → événements « status »
//
// Un run est attaché à SA session OpenCode (bind). Les écritures d'une même
// session passent dans l'ordre (une file par session). Les runs encore en
// cours au démarrage sont réattachés : OpenCode reprend leur session, et le
// pont reprend leur timeline.

import type { OpenCodeHost } from "./host.ts";
import type { BoundRun, HarnessStore } from "./store.ts";

type Ev = { type: string; data?: Record<string, any> };

interface SessionState {
  run: BoundRun;
  queue: Promise<void>;
  toolNames: Map<string, string>;
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
  ended: boolean;
}

export interface Bridge {
  /** Attache un run à sa session : ses événements vont désormais à ce run. */
  bind(run: BoundRun): void;
  /** Résolu quand le run de cette session est terminé (tests, arrêt). */
  settled(sessionId: string): Promise<void>;
  stop(): Promise<void>;
}

export interface BridgeOptions {
  liveIntervalMs?: number;
  /** Intervalle de vérification des runs annulés depuis le front. */
  cancelPollMs?: number;
  log?: (message: string) => void;
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

export function startBridge(opencode: OpenCodeHost, store: HarnessStore, options: BridgeOptions = {}): Bridge {
  const liveInterval = options.liveIntervalMs ?? 700;
  const log = options.log ?? ((m: string) => console.warn(`[harness] ${m}`));
  const sessions = new Map<string, SessionState>();
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
      run, queue: Promise.resolve(), toolNames: new Map(), texts: new Map(), lastAssistant: null,
      live: "", liveTimer: null, liveAt: 0, model: { id: "", provider: "" },
      cost: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, toolCalls: 0, ended: false,
    });
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
    });
  };

  const handle = (ev: Ev) => {
    const d = ev.data ?? {};
    const s = typeof d.sessionID === "string" ? sessions.get(d.sessionID) : undefined;
    if (!s || s.ended) return;
    const { runId, agentId } = s.run;
    switch (ev.type) {
      case "session.step.started":
        if (d.model) s.model = { id: String(d.model.id ?? ""), provider: String(d.model.providerID ?? "") };
        return;
      case "session.tool.input.started":
        s.toolNames.set(`${d.assistantMessageID}:${d.id}`, String(d.name ?? "outil"));
        return;
      case "session.tool.called": {
        s.toolCalls++;
        const tool = s.toolNames.get(`${d.assistantMessageID}:${d.id}`) ?? "outil";
        enqueue(s, () => store.insertEvent(runId, agentId, "tool_call", { tool, args: compactArgs(d.input) }));
        return;
      }
      case "session.tool.success": {
        const tool = s.toolNames.get(`${d.assistantMessageID}:${d.id}`) ?? "outil";
        enqueue(s, () => store.insertEvent(runId, agentId, "tool_result", { tool, preview: contentText(d.content).slice(0, 1000), ok: true }));
        return;
      }
      case "session.tool.failed": {
        const tool = s.toolNames.get(`${d.assistantMessageID}:${d.id}`) ?? "outil";
        const message = String(d.error?.message ?? "échec");
        enqueue(s, () => store.insertEvent(runId, agentId, "tool_result", { tool, preview: `ERROR: ${message}`.slice(0, 1000), ok: false }));
        return;
      }
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
        enqueue(s, async () => {
          if (s.run.conversationId) {
            await store.insertAssistantMessage({
              conversationId: s.run.conversationId, agentId, runId, content: final,
              tokensIn: s.tokensIn, tokensOut: s.tokensOut, costUsd: Number(s.cost.toFixed(6)),
            });
            await store.touchConversation(s.run.conversationId);
          }
          await store.updateRun(runId, {
            status: "succeeded", finished_at: new Date().toISOString(), final_output: final.slice(0, 2000),
            live_output: null, action_count: s.toolCalls, steps: s.toolCalls,
          });
        });
        enqueue(s, async () => finish(d.sessionID));
        return;
      }
      case "session.execution.failed": {
        s.ended = true;
        if (s.liveTimer) clearTimeout(s.liveTimer);
        const message = String(d.error?.message ?? "échec de l'exécution").slice(0, 500);
        enqueue(s, async () => {
          await store.insertEvent(runId, agentId, "error", { error: message });
          if (s.run.conversationId) {
            await store.insertAssistantMessage({
              conversationId: s.run.conversationId, agentId, runId, content: `⚠️ Le run a échoué : ${message}`,
              tokensIn: s.tokensIn, tokensOut: s.tokensOut, costUsd: Number(s.cost.toFixed(6)),
            });
            await store.touchConversation(s.run.conversationId);
          }
          await store.updateRun(runId, { status: "failed", finished_at: new Date().toISOString(), error_message: message, live_output: null });
        });
        enqueue(s, async () => finish(d.sessionID));
        return;
      }
      case "session.execution.interrupted":
        // Arrêt du backend : la session sera reprise au redémarrage, le run reste attaché.
        if (d.reason === "shutdown") return;
        s.ended = true;
        enqueue(s, () => store.updateRun(runId, { status: "cancelled", finished_at: new Date().toISOString(), live_output: null }));
        enqueue(s, async () => finish(d.sessionID));
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
