import { Deno, FUNCTIONS_URL } from "../../compat/index.ts";

// Un tour, une seule personne (d'après eve : « A turn runs as one principal »).
//
// Dans un fil Slack, un canal Teams ou un groupe Telegram, plusieurs personnes
// parlent au même agent dans la même conversation. Avant :
//   · le message de Bob arrivé pendant le tour d'Alice était replié DANS ce tour
//     (pilotage en cours de route), qui continuait sous l'identité d'Alice ;
//   · la passerelle réécrivait l'auteur du fil (`external_user_ref`) à chaque
//     message : Bob devenait celui qui pouvait valider, depuis le canal, les
//     actions demandées pendant le tour d'Alice.
//
// Désormais :
//   · seul l'auteur du tour pilote son tour ; les messages des autres
//     attendent la fin du tour, puis ouvrent le leur ;
//   · l'auteur du fil ne change pas pendant un tour : il est fixé au départ
//     d'un tour (runChat), d'après le message qui l'ouvre.
//
// Les conversations de l'application n'ont pas d'auteur externe
// (`author_ref` nul) : rien ne change pour elles.

import type { SupabaseClient } from "@supabase/supabase-js";

/** Un message de la conversation, avec son auteur externe éventuel. */
export interface AuthoredMessage {
  author_ref?: string | null;
}

/** Ce message peut-il piloter le tour de `principal` ? Un message de
 *  l'application (sans auteur) ou un tour sans auteur connu : oui. */
export function steersTurn(principal: string | null | undefined, author: string | null | undefined): boolean {
  if (!author || !principal) return true;
  return author === principal;
}

/** Sépare les messages arrivés pendant un tour : ceux qui le pilotent, ceux
 *  qui attendront le suivant. L'ordre est conservé. */
export function splitForTurn<T extends AuthoredMessage>(
  messages: T[],
  principal: string | null | undefined,
): { steer: T[]; deferred: T[] } {
  const steer: T[] = [];
  const deferred: T[] = [];
  for (const m of messages) (steersTurn(principal, m.author_ref) ? steer : deferred).push(m);
  return { steer, deferred };
}

/** Enregistre le message d'une personne venu d'un canal, avec son auteur.
 *  Tant que la colonne `author_ref` (0300) n'existe pas, le message part sans
 *  elle : on perd la règle du tour, jamais le message. */
export async function insertChannelMessage(
  admin: SupabaseClient,
  row: { conversation_id: string; agent_id: string; content: string; author_ref: string | null },
): Promise<void> {
  const { error } = await admin.from("internal_agent_messages").insert({ ...row, role: "user" });
  if (error && /author_ref/i.test(error.message ?? "")) {
    const { author_ref: _a, ...rest } = row;
    await admin.from("internal_agent_messages").insert({ ...rest, role: "user" });
  }
}

/** Un tour tourne-t-il dans cette conversation ? */
export async function turnInProgress(admin: SupabaseClient, conversationId: string): Promise<boolean> {
  const { data } = await admin.from("internal_agent_runs")
    .select("id").eq("conversation_id", conversationId).eq("status", "running").limit(1)
    .then((r) => r, () => ({ data: null }));
  return Array.isArray(data) && data.length > 0;
}

/** La liaison d'un fil à mettre à jour par une passerelle : sans l'auteur
 *  quand un tour tourne, pour que la personne qui valide reste celle du tour. */
export async function bindingForUpdate<B extends { external_user_ref?: string | null }>(
  admin: SupabaseClient,
  conversationId: string,
  binding: B,
): Promise<Omit<B, "external_user_ref"> | B> {
  if (!(await turnInProgress(admin, conversationId))) return binding;
  const { external_user_ref: _kept, ...rest } = binding;
  return rest;
}

/** Au départ d'un tour : l'auteur du fil devient l'auteur du message qui
 *  ouvre ce tour (le dernier message utilisateur), s'il en a un. */
export async function claimTurn(admin: SupabaseClient, conversationId: string): Promise<string | null> {
  const { data } = await admin.from("internal_agent_messages")
    .select("author_ref").eq("conversation_id", conversationId).eq("role", "user")
    .order("created_at", { ascending: false }).limit(1).maybeSingle()
    .then((r) => r, () => ({ data: null }));
  const author = (data as { author_ref?: string | null } | null)?.author_ref ?? null;
  if (author) {
    await admin.from("internal_agent_conversations").update({ external_user_ref: author })
      .eq("id", conversationId).then(() => {}, () => {});
  }
  return author;
}

/** L'auteur du tour qui a lancé ce run : celui du dernier message de la
 *  conversation écrit avant son départ. C'est lui, et lui seul, qui valide
 *  depuis le canal ce que ce run a demandé, même si le tour d'une autre
 *  personne a commencé depuis. `null` : inconnu (message de l'application,
 *  ou 0300 non appliquée), l'appelant garde sa règle d'avant. */
export async function turnRequester(admin: SupabaseClient, runId: string, conversationId: string): Promise<string | null> {
  const { data: run } = await admin.from("internal_agent_runs").select("started_at").eq("id", runId).maybeSingle()
    .then((r) => r, () => ({ data: null }));
  const startedAt = (run as { started_at?: string | null } | null)?.started_at;
  if (!startedAt) return null;
  const { data } = await admin.from("internal_agent_messages")
    .select("author_ref").eq("conversation_id", conversationId).eq("role", "user")
    .lte("created_at", startedAt).order("created_at", { ascending: false }).limit(1).maybeSingle()
    .then((r) => r, () => ({ data: null }));
  return (data as { author_ref?: string | null } | null)?.author_ref ?? null;
}

/**
 * Après un tick : si le tour de chat vient de se terminer et que d'autres
 * personnes ont écrit pendant ce tour, leur tour commence. Sans effet tant que
 * le tour tourne, et une seule fois : un tour plus récent dans la conversation
 * veut dire que la relève a déjà eu lieu.
 */
export async function startDeferredTurn(admin: SupabaseClient, runId: string): Promise<boolean> {
  const { data: run } = await admin.from("internal_agent_runs")
    .select("agent_id, conversation_id, status, started_at").eq("id", runId).maybeSingle()
    .then((r) => r, () => ({ data: null }));
  const r = run as { agent_id: string; conversation_id: string | null; status: string; started_at: string | null } | null;
  if (!r?.conversation_id || !r.started_at || r.status === "running" || r.status === "queued") return false;
  if (await turnInProgress(admin, r.conversation_id)) return false;

  const { data: newer } = await admin.from("internal_agent_runs")
    .select("id").eq("conversation_id", r.conversation_id).gt("started_at", r.started_at).limit(1)
    .then((x) => x, () => ({ data: [] }));
  if (Array.isArray(newer) && newer.length > 0) return false;

  const [{ data: conv }, { data: waiting }] = await Promise.all([
    admin.from("internal_agent_conversations").select("external_user_ref").eq("id", r.conversation_id).maybeSingle()
      .then((x) => x, () => ({ data: null })),
    admin.from("internal_agent_messages").select("author_ref")
      .eq("conversation_id", r.conversation_id).eq("role", "user").gt("created_at", r.started_at)
      .not("author_ref", "is", null).limit(50)
      .then((x) => x, () => ({ data: [] })),
  ]);
  const principal = (conv as { external_user_ref?: string | null } | null)?.external_user_ref ?? null;
  const { deferred } = splitForTurn((waiting ?? []) as AuthoredMessage[], principal);
  if (!deferred.length) return false;

  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return false;
  await fetch(`${FUNCTIONS_URL}/functions/v1/internal-agent-run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: r.agent_id, mode: "chat", conversation_id: r.conversation_id }),
  }).catch(() => {});
  return true;
}
