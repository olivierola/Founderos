// Rapporter dans FounderOS le journal d'un agent embarqué isolé : ses
// conversations, leurs messages, ses runs et leurs étapes, sous CET agent (les
// identifiants d'agent, d'espace et de projet du journal sont ignorés).
//
// Les identifiants du journal sont des UUID gardés tels quels : réimporter un
// même journal, ou un journal plus long, n'ajoute que ce qui manque. Ce qui
// remonte des réponses suit le niveau de synchronisation de l'agent.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseJournal, replay, type JournalRecord } from "./local-store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINAL = new Set(["succeeded", "failed", "cancelled"]);

export interface ImportResult {
  conversations: number;
  messages: number;
  runs: number;
  events: number;
  instance: string | null;
}

/** Insère par paquets, sans écraser ce qui existe déjà (même identifiant). */
async function insertNew(admin: SupabaseClient, table: string, rows: Array<Record<string, unknown>>) {
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const ids = chunk.map((r) => String(r.id));
    const { data: existing } = await admin.from(table).select("id").in("id", ids);
    const have = new Set(((existing ?? []) as Array<{ id: string }>).map((r) => r.id));
    const fresh = chunk.filter((r) => !have.has(String(r.id)));
    if (!fresh.length) continue;
    const { error } = await admin.from(table).insert(fresh);
    if (error) throw new Error(`${table} : ${error.message}`);
    n += fresh.length;
  }
  return n;
}

export async function importJournal(admin: SupabaseClient, input: {
  agent: { id: string; workspace_id: string; project_id: string };
  text: string;
  /** Le niveau de synchronisation de l'agent, appliqué aux réponses. */
  sync: (text: string) => string;
}): Promise<ImportResult> {
  const records = parseJournal(input.text);
  if (!records.length) throw new Error("journal vide ou illisible");
  const state = replay(records);
  const { agent } = input;
  const instance = (records.find((r) => r.t === "instance") as Extract<JournalRecord, { t: "instance" }> | undefined)?.name ?? null;

  const conversations = [...state.conversations.values()].filter((c) => UUID.test(c.id)).map((c) => ({
    id: c.id, agent_id: agent.id, workspace_id: agent.workspace_id, project_id: agent.project_id,
    title: c.title.slice(0, 200), created_at: c.created_at, updated_at: c.updated_at,
  }));
  const convIds = new Set(conversations.map((c) => c.id));

  const runs = [...state.runs.values()].filter((r) => UUID.test(r.id)).map((r) => {
    // Un run resté « en cours » dans le journal (conteneur arrêté) est clos à l'import.
    const status = FINAL.has(r.status) ? r.status : r.status === "awaiting_input" ? "cancelled" : "failed";
    const final = typeof r.final_output === "string" ? input.sync(r.final_output) : null;
    return {
      id: r.id, agent_id: agent.id, workspace_id: agent.workspace_id, project_id: agent.project_id,
      conversation_id: r.conversation_id && convIds.has(r.conversation_id) ? r.conversation_id : null,
      status, triggered_via: "api", started_at: r.created_at,
      finished_at: typeof r.finished_at === "string" ? r.finished_at : r.created_at,
      final_output: final?.slice(0, 12000) ?? null,
      error_message: typeof r.error_message === "string" ? r.error_message.slice(0, 500)
        : FINAL.has(r.status) ? null : "Run interrompu sur l'instance isolée (arrêté avant sa fin).",
      tokens_in: Number(r.tokens_in) || 0, tokens_out: Number(r.tokens_out) || 0,
      cost_usd: Number(r.cost_usd) || 0, action_count: Number(r.action_count) || 0,
      run_meta: { ...(r.meta ?? {}), embedded: true, isolated: true, ...(instance ? { instance } : {}) },
    };
  });
  const runIds = new Set(runs.map((r) => r.id));

  const messages = state.messages.filter((m) => UUID.test(m.id) && convIds.has(m.conversation_id)).map((m) => ({
    id: m.id, conversation_id: m.conversation_id, agent_id: agent.id, role: m.role,
    content: m.role === "assistant" ? input.sync(m.content) : m.content,
    run_id: m.run_id && runIds.has(m.run_id) ? m.run_id : null,
    tokens_in: m.tokens_in ?? null, tokens_out: m.tokens_out ?? null, cost_usd: m.cost_usd ?? null, created_at: m.at,
  }));
  const events = state.events.filter((e) => UUID.test(e.id) && runIds.has(e.run_id)).map((e) => ({
    id: e.id, run_id: e.run_id, agent_id: agent.id, kind: e.kind, payload: e.payload ?? {}, created_at: e.at,
  }));

  // Dans l'ordre des liens : conversations, runs, messages, étapes.
  const out: ImportResult = { conversations: 0, messages: 0, runs: 0, events: 0, instance };
  out.conversations = await insertNew(admin, "internal_agent_conversations", conversations);
  out.runs = await insertNew(admin, "internal_agent_runs", runs);
  out.messages = await insertNew(admin, "internal_agent_messages", messages);
  out.events = await insertNew(admin, "internal_agent_run_events", events);
  return out;
}
