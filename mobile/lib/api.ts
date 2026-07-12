import { CONFIG } from "./config";

export type ChatRole = "user" | "assistant" | "tool";

// An agent the signed-in FounderOS user can talk to (returned by list_agents).
export interface Agent {
  id: string;
  name: string;
  avatar_url?: string | null;
  avatar_emoji?: string | null;
  accent_color?: string | null;
  description?: string | null;
  updated_at?: string;
}

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

// ── internal-agent-run, mode "mobile" — authenticated by the user's account JWT ──
// Same agent + conversation store as the web chat (memory, tools, past sessions).
async function callMobile(token: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${CONFIG.supabaseUrl}/functions/v1/${CONFIG.chatFunction}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: CONFIG.supabaseAnonKey,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ mode: "mobile", ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string })?.error ?? `Erreur ${res.status}`);
  return data;
}

export async function listAgents(token: string): Promise<Agent[]> {
  const data = await callMobile(token, { action: "list_agents" });
  return (data.agents ?? []) as Agent[];
}

export async function listConversations(token: string, agentId: string): Promise<Conversation[]> {
  const data = await callMobile(token, { action: "list_conversations", agent_id: agentId });
  return (data.conversations ?? []) as Conversation[];
}

export async function getMessages(
  token: string,
  agentId: string,
  conversationId: string,
): Promise<MessagesResult> {
  const data = await callMobile(token, {
    action: "get_messages",
    agent_id: agentId,
    conversation_id: conversationId,
  });
  return { messages: (data.messages ?? []) as Message[], running: !!data.running };
}

export async function sendMessage(
  token: string,
  agentId: string,
  message: string,
  conversationId: string | null,
): Promise<{ conversationId: string; runId: string | null }> {
  const data = await callMobile(token, {
    action: "send",
    agent_id: agentId,
    message,
    conversation_id: conversationId,
  });
  return { conversationId: data.conversation_id, runId: data.run_id ?? null };
}
