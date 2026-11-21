// Outils de test du harnais : un magasin en mémoire (à la place de la base)
// et une fausse passerelle compatible OpenAI (à la place du fournisseur).
// Utilisés par les *.test.ts de ce dossier seulement.

import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BoundRun, HarnessAgent, HarnessStore, UsageRow } from "./store.ts";

// ── Magasin en mémoire ───────────────────────────────────────────────────────

export interface MemoryRun extends Record<string, unknown> {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  opencode_session_id: string;
  status: string;
}

export function memoryStore(seed: {
  agents: HarnessAgent[];
  conversations: Array<{ id: string; agentId: string; sessionId?: string | null }>;
  messages?: Array<{ conversationId: string; role: string; content: string }>;
  access?: Array<{ agentId: string; userId: string }>;
}) {
  const runs: MemoryRun[] = [];
  const events: Array<{ runId: string; kind: string; payload: Record<string, unknown> }> = [];
  const messages = [...(seed.messages ?? [])];
  const usage: UsageRow[] = [];
  const conversations = seed.conversations.map((c) => ({ ...c, sessionId: c.sessionId ?? null }));
  let n = 0;
  const store: HarnessStore = {
    agent: async (id) => seed.agents.find((a) => a.id === id) ?? null,
    hasAgentAccess: async (agentId, userId) => (seed.access ?? []).some((a) => a.agentId === agentId && a.userId === userId),
    conversation: async (id, agentId) => {
      const c = conversations.find((x) => x.id === id && x.agentId === agentId);
      return c ? { sessionId: c.sessionId } : null;
    },
    setConversationSession: async (id, sessionId) => {
      const c = conversations.find((x) => x.id === id);
      if (c) c.sessionId = sessionId;
    },
    recentMessages: async (id, limit) => messages.filter((m) => m.conversationId === id).slice(-limit).map((m) => ({ role: m.role, content: m.content })),
    activeRun: async (conversationId) => {
      const r = [...runs].reverse().find((x) => x.conversation_id === conversationId && x.status === "running");
      return r ? { runId: r.id, sessionId: r.opencode_session_id } : null;
    },
    createRun: async ({ agent, conversationId, sessionId }) => {
      const id = `run-${++n}`;
      runs.push({ id, agent_id: agent.id, conversation_id: conversationId, opencode_session_id: sessionId, status: "running" });
      return id;
    },
    runningRuns: async () => runs.filter((r) => r.status === "running").map((r): BoundRun => ({
      runId: r.id, sessionId: r.opencode_session_id, agentId: r.agent_id,
      workspaceId: "ws", projectId: "pj", conversationId: r.conversation_id,
    })),
    cancelledAmong: async (ids) => runs.filter((r) => ids.includes(r.id) && r.status === "cancelled").map((r) => r.id),
    insertEvent: async (runId, _agentId, kind, payload) => { events.push({ runId, kind, payload }); },
    updateRun: async (runId, patch) => {
      const r = runs.find((x) => x.id === runId);
      if (r) Object.assign(r, patch);
    },
    insertAssistantMessage: async (row) => { messages.push({ conversationId: row.conversationId, role: "assistant", content: row.content }); },
    touchConversation: async () => {},
    logUsage: async (row) => { usage.push(row); },
  };
  return { store, runs, events, messages, usage, conversations };
}

// ── Fausse passerelle compatible OpenAI ──────────────────────────────────────

/** Un tour scripté : du texte, des appels d'outil, ou une erreur HTTP. */
export interface FakeTurn {
  text?: string;
  tools?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  status?: number;
  error?: string;
}

export interface FakeLlm {
  baseUrl: string;
  /** Les requêtes du tour d'agent (avec outils), dans l'ordre. */
  requests: Array<Record<string, any>>;
  /** Les requêtes annexes (titre, compaction : sans outils). */
  annex: Array<Record<string, any>>;
  script: FakeTurn[];
  close(): Promise<void>;
}

function sse(res: ServerResponse, chunks: unknown[]) {
  res.setHeader("Content-Type", "text/event-stream");
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

export async function startFakeLlm(): Promise<FakeLlm> {
  const fake: FakeLlm = { baseUrl: "", requests: [], annex: [], script: [], close: async () => {} };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      // Les requêtes annexes (titre de la session) n'ont pas d'outils : un
      // titre, sans consommer le script du tour d'agent.
      const annex = !Array.isArray(body.tools) || body.tools.length === 0;
      (annex ? fake.annex : fake.requests).push(body);
      const turn: FakeTurn = annex ? { text: "Titre" } : fake.script.shift() ?? { text: "fin" };
      if (turn.status) {
        res.statusCode = turn.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: { message: turn.error ?? "erreur", type: "invalid_request_error" } }));
        return;
      }
      const base = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: body.model };
      const chunks: unknown[] = [];
      if (turn.text) chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: turn.text }, finish_reason: null }] });
      (turn.tools ?? []).forEach((t, index) => chunks.push({
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index, id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } }] }, finish_reason: null }],
      }));
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: turn.tools?.length ? "tool_calls" : "stop" }] });
      chunks.push({ ...base, choices: [], usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 } });
      sse(res, chunks);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  fake.close = async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return fake;
}

/** La configuration OpenCode qui pointe sur la fausse passerelle. */
export const fakeProviderConfig = (baseUrl: string) => ({
  model: "fake/test-model",
  providers: {
    fake: {
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: baseUrl, apiKey: "test" },
      models: { "test-model": {} },
    },
  },
});
