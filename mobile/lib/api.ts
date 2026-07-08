import { CONFIG } from "./config";
import type { RegisteredAgent } from "./storage";

export type ChatRole = "user" | "assistant" | "tool";

export interface Conversation {
  id: string;
  title: string | null;
  updated_at: string;
}

export interface Message {
  id: string;
  role: ChatRole;
  content: string;
  created_at: string;
}

export interface MessagesResult {
  messages: Message[];
  running: boolean;
}

// ── Real backend: internal-agent-run, mode "mobile", action dispatch ──────────
// Same agent + conversation store as the web chat (memory, tools, past sessions).
async function callMobile(agent: RegisteredAgent, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${CONFIG.supabaseUrl}/functions/v1/${CONFIG.chatFunction}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: CONFIG.supabaseAnonKey,
      Authorization: `Bearer ${CONFIG.supabaseAnonKey}`,
    },
    body: JSON.stringify({ agent_id: agent.id, mode: "mobile", secret: agent.secret, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Erreur ${res.status}`);
  return data;
}

export async function verifyAgent(agent: Omit<RegisteredAgent, "addedAt">): Promise<void> {
  if (CONFIG.mock) { await delay(400); return; }
  await callMobile(agent as RegisteredAgent, { action: "verify" });
}

export async function listConversations(agent: RegisteredAgent): Promise<Conversation[]> {
  if (CONFIG.mock) { await delay(300); return mockConvos[agent.id] ?? []; }
  const data = await callMobile(agent, { action: "list_conversations" });
  return (data.conversations ?? []) as Conversation[];
}

export async function getMessages(agent: RegisteredAgent, conversationId: string): Promise<MessagesResult> {
  if (CONFIG.mock) { await delay(200); return { messages: mockMsgs[conversationId] ?? [], running: false }; }
  const data = await callMobile(agent, { action: "get_messages", conversation_id: conversationId });
  return { messages: (data.messages ?? []) as Message[], running: !!data.running };
}

export async function sendMessage(
  agent: RegisteredAgent,
  message: string,
  conversationId: string | null,
): Promise<{ conversationId: string; runId: string | null }> {
  if (CONFIG.mock) return mockSend(agent, message, conversationId);
  const data = await callMobile(agent, {
    action: "send",
    message,
    conversation_id: conversationId,
  });
  return { conversationId: data.conversation_id, runId: data.run_id ?? null };
}

// ── Mock backend (CONFIG.mock=true): in-memory, for demoing the UI ────────────
const mockConvos: Record<string, Conversation[]> = {};
const mockMsgs: Record<string, Message[]> = {};

async function mockSend(agent: RegisteredAgent, message: string, conversationId: string | null) {
  await delay(500);
  const cid = conversationId ?? `mock-${Date.now()}`;
  const now = new Date().toISOString();
  const list = (mockMsgs[cid] ??= []);
  list.push({ id: `u-${Date.now()}`, role: "user", content: message, created_at: now });
  list.push({
    id: `a-${Date.now()}`,
    role: "assistant",
    content: `👋 (démo) Ici ${agent.name || "l'agent"}. Réponse simulée à : « ${message.trim()} ».`,
    created_at: new Date().toISOString(),
  });
  const convos = (mockConvos[agent.id] ??= []);
  const existing = convos.find((c) => c.id === cid);
  if (existing) existing.updated_at = now;
  else convos.unshift({ id: cid, title: message.slice(0, 60), updated_at: now });
  return { conversationId: cid, runId: null };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
