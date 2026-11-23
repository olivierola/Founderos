// Le magasin d'un agent embarqué en mode isolé : sans liaison avec FounderOS,
// ses conversations, ses runs, leurs étapes et sa consommation sont tenus ici,
// dans un journal (JSON Lines) qui est aussi ce qu'on rapporte dans FounderOS
// (onglet Agents embarqués, « Importer un journal »).
//
// Chaque ligne est un fait daté ; l'état se reconstruit en les rejouant au
// démarrage. Les identifiants sont des UUID : un même journal importé deux fois
// ne crée rien de plus.

import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import type { BoundRun, HarnessAgent, HarnessStore } from "../harness/store.ts";

export type JournalRecord =
  | { t: "instance"; name: string; agent_id: string; at: string }
  | { t: "conversation"; id: string; title: string; at: string }
  | { t: "session"; conversation_id: string; session_id: string; at: string }
  | { t: "message"; id: string; conversation_id: string; role: "user" | "assistant"; content: string; run_id: string | null; tokens_in?: number; tokens_out?: number; cost_usd?: number; at: string }
  | { t: "run"; id: string; conversation_id: string | null; session_id: string; meta: Record<string, unknown>; at: string }
  | { t: "run_patch"; id: string; patch: Record<string, unknown>; at: string }
  | { t: "event"; id: string; run_id: string; kind: string; payload: Record<string, unknown>; at: string }
  | { t: "usage"; run_id: string; model: string; provider: string; prompt_tokens: number; completion_tokens: number; cost_usd: number; at: string };

export interface LocalRun {
  id: string;
  conversation_id: string | null;
  session_id: string;
  status: string;
  meta: Record<string, unknown>;
  created_at: string;
  final_output?: string | null;
  error_message?: string | null;
  pending_question?: { formId: string; sessionId: string; fields: Array<{ key: string; options?: string[]; multiple?: boolean }> } | null;
  [k: string]: unknown;
}

export interface LocalState {
  conversations: Map<string, { id: string; title: string; sessionId: string | null; created_at: string; updated_at: string }>;
  messages: Array<Extract<JournalRecord, { t: "message" }>>;
  runs: Map<string, LocalRun>;
  events: Array<Extract<JournalRecord, { t: "event" }>>;
}

/** Rejoue un journal : l'état qu'il décrit. */
export function replay(records: JournalRecord[]): LocalState {
  const s: LocalState = { conversations: new Map(), messages: [], runs: new Map(), events: [] };
  for (const r of records) {
    switch (r.t) {
      case "conversation": s.conversations.set(r.id, { id: r.id, title: r.title, sessionId: null, created_at: r.at, updated_at: r.at }); break;
      case "session": { const c = s.conversations.get(r.conversation_id); if (c) c.sessionId = r.session_id; break; }
      case "message": {
        s.messages.push(r);
        const c = s.conversations.get(r.conversation_id);
        if (c) c.updated_at = r.at;
        break;
      }
      case "run": s.runs.set(r.id, { id: r.id, conversation_id: r.conversation_id, session_id: r.session_id, status: "running", meta: r.meta, created_at: r.at }); break;
      case "run_patch": { const run = s.runs.get(r.id); if (run) Object.assign(run, r.patch); break; }
      case "event": s.events.push(r); break;
      default: break;
    }
  }
  return s;
}

export function parseJournal(text: string): JournalRecord[] {
  const out: JournalRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as JournalRecord;
      if (r && typeof r === "object" && typeof r.t === "string") out.push(r);
    } catch { /* une ligne abîmée (arrêt brutal) ne bloque pas le reste */ }
  }
  return out;
}

const RUN_FIELDS = new Set([
  "status", "finished_at", "final_output", "live_output", "error_message", "tokens_in", "tokens_out",
  "cost_usd", "action_count", "steps", "todos", "pending_question",
]);

/** Le magasin local : l'interface du pont, tenue dans le journal. */
export async function localStore(opts: { agent: HarnessAgent; file: string; instanceName: string }) {
  const records = parseJournal(await readFile(opts.file, "utf8").catch(() => ""));
  const state = replay(records);
  const now = () => new Date().toISOString();
  let chain = Promise.resolve();
  const write = (r: JournalRecord) => {
    chain = chain.then(() => appendFile(opts.file, JSON.stringify(r) + "\n")).catch(() => {});
    return chain;
  };
  const apply = async (r: JournalRecord) => {
    // Appliqué à l'état courant sans tout rejouer.
    const one = replay([r]);
    switch (r.t) {
      case "conversation": state.conversations.set(r.id, one.conversations.get(r.id)!); break;
      case "session": { const c = state.conversations.get(r.conversation_id); if (c) c.sessionId = r.session_id; break; }
      case "message": { state.messages.push(r); const c = state.conversations.get(r.conversation_id); if (c) c.updated_at = r.at; break; }
      case "run": state.runs.set(r.id, one.runs.get(r.id)!); break;
      case "run_patch": { const run = state.runs.get(r.id); if (run) Object.assign(run, r.patch); break; }
      case "event": state.events.push(r); break;
      default: break;
    }
    await write(r);
  };
  if (!records.some((r) => r.t === "instance")) await write({ t: "instance", name: opts.instanceName, agent_id: opts.agent.id, at: now() });

  const store: HarnessStore = {
    agent: async (id) => (id === opts.agent.id ? opts.agent : null),
    hasAgentAccess: async () => true,
    conversation: async (id, agentId) => {
      const c = state.conversations.get(id);
      return c && agentId === opts.agent.id ? { sessionId: c.sessionId } : null;
    },
    setConversationSession: (id, sessionId) => apply({ t: "session", conversation_id: id, session_id: sessionId, at: now() }),
    recentMessages: async (id, limit) =>
      state.messages.filter((m) => m.conversation_id === id).slice(-limit).map((m) => ({ role: m.role, content: m.content })),
    activeRun: async (conversationId) => {
      const r = [...state.runs.values()].reverse().find((x) => x.conversation_id === conversationId && x.status === "running");
      return r ? { runId: r.id, sessionId: r.session_id } : null;
    },
    pendingQuestion: async (conversationId) => {
      const r = [...state.runs.values()].reverse().find((x) => x.conversation_id === conversationId && x.status === "awaiting_input" && x.pending_question);
      return r?.pending_question ? { runId: r.id, sessionId: r.pending_question.sessionId, formId: r.pending_question.formId, fields: r.pending_question.fields } : null;
    },
    createRun: async ({ conversationId, sessionId, runId, meta }) => {
      if (runId && state.runs.has(runId)) {
        await apply({ t: "run_patch", id: runId, patch: { status: "running", session_id: sessionId }, at: now() });
        return runId;
      }
      const id = runId ?? randomUUID();
      await apply({ t: "run", id, conversation_id: conversationId, session_id: sessionId, meta: { kind: "chat", ...(meta ?? {}) }, at: now() });
      return id;
    },
    runningRuns: async () => [...state.runs.values()].filter((r) => r.status === "running").map((r): BoundRun => ({
      runId: r.id, sessionId: r.session_id, agentId: opts.agent.id, workspaceId: opts.agent.workspace_id, projectId: opts.agent.project_id,
      conversationId: r.conversation_id, kind: ((r.meta.kind as string | undefined) ?? "chat") as BoundRun["kind"], meta: r.meta,
    })),
    cancelledAmong: async (ids) => ids.filter((id) => state.runs.get(id)?.status === "cancelled"),
    insertEvent: (runId, _agentId, kind, payload) => apply({ t: "event", id: randomUUID(), run_id: runId, kind, payload, at: now() }),
    updateRun: async (runId, patch) => {
      const kept = Object.fromEntries(Object.entries(patch).filter(([k]) => RUN_FIELDS.has(k)));
      // Le texte en direct change sans cesse : gardé en mémoire, pas dans le journal.
      const { live_output: live, ...durable } = kept;
      const run = state.runs.get(runId);
      if (run && live !== undefined) run.live_output = live;
      if (Object.keys(durable).length) await apply({ t: "run_patch", id: runId, patch: durable, at: now() });
    },
    insertAssistantMessage: (row) => apply({
      t: "message", id: randomUUID(), conversation_id: row.conversationId, role: "assistant", content: row.content, run_id: row.runId,
      tokens_in: row.tokensIn, tokens_out: row.tokensOut, cost_usd: row.costUsd, at: now(),
    }),
    touchConversation: async () => {},
    logUsage: (row) => apply({
      t: "usage", run_id: row.runId, model: row.model, provider: row.provider,
      prompt_tokens: row.promptTokens, completion_tokens: row.completionTokens, cost_usd: row.costUsd, at: now(),
    }),
  };

  return {
    store,
    state,
    createConversation: async (title: string) => {
      const id = randomUUID();
      await apply({ t: "conversation", id, title: title.slice(0, 120) || "Conversation", at: now() });
      return id;
    },
    addUserMessage: (conversationId: string, content: string) =>
      apply({ t: "message", id: randomUUID(), conversation_id: conversationId, role: "user", content, run_id: null, at: now() }),
    /** L'agent pose une question : le run attend, la question est dans la conversation. */
    question: async (run: BoundRun, q: { formId: string; sessionId: string; title: string; fields: Array<{ key: string; title?: string; description?: string; options?: string[]; multiple?: boolean }> }) => {
      const first = q.fields[0];
      const text = [q.title, first?.title, first?.description].filter((x) => x && String(x).trim()).join("\n") || "J'ai besoin d'une précision pour continuer.";
      const options = (first?.options ?? []).slice(0, 6);
      await store.updateRun(run.runId, {
        status: "awaiting_input",
        pending_question: { formId: q.formId, sessionId: q.sessionId, fields: q.fields.map((f) => ({ key: f.key, options: f.options, multiple: f.multiple })) },
      });
      if (run.conversationId) {
        await apply({ t: "message", id: randomUUID(), conversation_id: run.conversationId, role: "assistant", content: [text, ...options.map((o) => `- ${o}`)].join("\n"), run_id: run.runId, at: now() });
      }
    },
    journal: async () => { await chain; return readFile(opts.file, "utf8").catch(() => ""); },
  };
}

export type LocalStore = Awaited<ReturnType<typeof localStore>>;
