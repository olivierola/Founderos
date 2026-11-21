// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/background-agents.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.
import { Deno } from "../../compat/index.ts";

// Les sous-agents en arrière-plan, d'après l'outil `subagent` d'OpenCode.
//
// Avant : spawn_parallel_agents lançait des clones DANS le worker du tick, par
// vagues de six, avec 75 s chacun et six tours au plus — tout devait revenir
// avant que le worker ne soit tué à ~150 s. Une sous-tâche un peu longue
// rendait un résultat tronqué, ou rien.
//
// Maintenant : chaque enfant est un RUN COMPLET sur le moteur de ticks durable
// (sa propre file, son propre budget, ses garde-fous, son contrat de fin). Le
// parent ne l'attend pas : l'appel rend aussitôt les identifiants, et le parent
// continue son travail. Quand un enfant finit, son résultat arrive dans la
// BOÎTE DE RÉCEPTION du parent (internal_agent_run_inbox, 0305) et le parent le
// lit au tick suivant sous forme d'un message `<background-result>`. Un parent
// qui n'a plus rien à faire en attendant se met EN ATTENTE (aucun tick ne
// tourne) et le premier résultat le réveille.
//
// Le réveil est atomique (agent_run_wake, 0305) : il ne relance une chaîne de
// ticks que si le parent est effectivement en attente, ce qui garantit qu'un
// run n'a jamais deux ticks en vol.
//
// Sans la migration 0305, rien de tout ça n'est disponible : l'appelant garde
// les vagues en mémoire d'avant (asyncSubagentsAvailable rend faux).

import type { SupabaseClient } from "@supabase/supabase-js";

export interface BackgroundChildSpec {
  label: string;
  brief: string;
  acceptance?: string;
}

export interface InboxItem {
  id: string;
  from_run_id: string | null;
  kind: "background_result" | "follow_up";
  label: string | null;
  status: string | null;
  content: string;
  created_at: string;
}

let available: { at: number; ok: boolean } | null = null;

/** La table de la boîte de réception existe (0305 jouée) et l'usage n'est pas
 *  coupé (AGENT_ASYNC_SUBAGENTS=0). Mémorisé cinq minutes par isolat. */
export async function asyncSubagentsAvailable(admin: SupabaseClient): Promise<boolean> {
  if ((Deno.env.get("AGENT_ASYNC_SUBAGENTS") ?? "").trim() === "0") return false;
  if (available && Date.now() - available.at < 5 * 60_000) return available.ok;
  const { error } = await admin.from("internal_agent_run_inbox").select("id").limit(1);
  available = { at: Date.now(), ok: !error };
  return available.ok;
}

/** Les consignes d'un enfant : sa sous-tâche, autonome, et comment finir. */
export function childBrief(spec: BackgroundChildSpec): string {
  return [
    "Tu es un SOUS-AGENT lancé en arrière-plan par un autre agent. Exécute ENTIÈREMENT la sous-tâche ci-dessous avec tes outils, puis termine par un résumé markdown concis du résultat : ce que tu as trouvé ou produit, avec les chiffres, liens, chemins et identifiants exacts, et ce qui reste incertain.",
    "Tu ne vois ni la conversation de l'agent qui t'a lancé ni les autres sous-agents : appuie-toi seulement sur ce qui suit. Ne lance pas d'autres sous-agents.",
    "",
    `## Sous-tâche : ${spec.label}`,
    spec.brief,
    spec.acceptance ? `\nC'est fini quand : ${spec.acceptance}` : "",
  ].join("\n");
}

/**
 * Crée un enfant : un run (sous-agent, rattaché au parent) et son état de tick,
 * puis met son premier tick en file. Rend son identifiant, ou une erreur.
 */
export async function spawnBackgroundChild(
  admin: SupabaseClient,
  input: {
    parentRunId: string;
    agent: { id: string; workspace_id: string; project_id: string };
    createdBy: string | null;
    spec: BackgroundChildSpec;
    system: string;
    provider: string;
    model: string | null;
    maxRounds: number;
    mcpGrants?: unknown;
  },
): Promise<{ runId: string } | { error: string }> {
  const label = input.spec.label.slice(0, 120);
  const { data: run, error } = await admin.from("internal_agent_runs").insert({
    agent_id: input.agent.id, workspace_id: input.agent.workspace_id, project_id: input.agent.project_id,
    mission_id: null, parent_run_id: input.parentRunId, run_kind: "subagent", label, is_ephemeral: true,
    status: "running", started_at: new Date().toISOString(), triggered_by: input.createdBy,
    triggered_via: "api",
    ...(input.mcpGrants ? { mcp_grants: input.mcpGrants } : {}),
  }).select("id").single();
  if (error || !run) return { error: error?.message ?? "run non créé" };
  const runId = (run as { id: string }).id;
  const { error: stErr } = await admin.from("internal_agent_run_state").upsert({
    run_id: runId,
    mode: "chat",
    agent_id: input.agent.id,
    conversation_id: null,
    mission_id: null,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: childBrief(input.spec) },
    ],
    round: 0,
    max_rounds: input.maxRounds,
    contract: null,
    provider: input.provider,
    model: input.model,
    meta: { tool_tier: "full", background_parent: { run_id: input.parentRunId, label } },
    processing_until: null,
    last_input_at: new Date().toISOString(),
  });
  if (stErr) {
    await admin.from("internal_agent_runs").update({
      status: "failed", finished_at: new Date().toISOString(), error_message: `état non créé : ${stErr.message}`.slice(0, 500),
    }).eq("id", runId);
    return { error: stErr.message };
  }
  await admin.rpc("agent_tick_enqueue", { p_run_id: runId });
  return { runId };
}

/** Réveille un run en attente (atomique : sans effet s'il ne l'est pas). */
export async function wakeRun(admin: SupabaseClient, runId: string): Promise<boolean> {
  const { data } = await admin.rpc("agent_run_wake", { p_run_id: runId });
  return data === true;
}

/**
 * Le résultat d'un enfant, déposé chez son parent, qui est réveillé s'il
 * attendait. Appelé par chaque fin de run d'un enfant (succès, échec, pause,
 * annulation, faucheur de zombies).
 */
export async function deliverBackgroundResult(
  admin: SupabaseClient,
  input: { parentRunId: string; childRunId: string; label: string | null; ok: boolean; output: string; status?: string },
): Promise<void> {
  // Un résultat par enfant : un deuxième chemin de fin ne le redépose pas.
  const { data: dup } = await admin.from("internal_agent_run_inbox").select("id")
    .eq("run_id", input.parentRunId).eq("from_run_id", input.childRunId).eq("kind", "background_result").limit(1);
  if ((dup ?? []).length) return;
  await admin.from("internal_agent_run_inbox").insert({
    run_id: input.parentRunId,
    from_run_id: input.childRunId,
    kind: "background_result",
    label: input.label,
    status: input.status ?? (input.ok ? "succeeded" : "failed"),
    content: input.output.slice(0, 16_000),
  });
  await wakeRun(admin, input.parentRunId).catch(() => false);
  // Le drainer passe toutes les 10 s ; le réveiller tout de suite fait gagner
  // ces secondes (sans effet si la file est vide).
  await admin.rpc("drain_agent_ticks").then(() => {}, () => {});
}

/** Une relance du parent vers un enfant EN COURS : elle entre dans son
 *  transcrit à son prochain tick, comme un message de l'utilisateur en cours
 *  de route. Un enfant fini ne reçoit plus rien. */
export async function sendFollowUp(
  admin: SupabaseClient,
  input: { parentRunId: string; childRunId: string; message: string },
): Promise<{ ok: true } | { error: string }> {
  const { data: child } = await admin.from("internal_agent_runs")
    .select("status, parent_run_id, label").eq("id", input.childRunId).maybeSingle();
  const c = child as { status?: string; parent_run_id?: string | null; label?: string | null } | null;
  if (!c || c.parent_run_id !== input.parentRunId) return { error: "ce sous-agent n'existe pas ou n'est pas l'un des tiens" };
  if (c.status !== "running" && c.status !== "queued") {
    return { error: `le sous-agent « ${c.label ?? input.childRunId} » est déjà terminé (${c.status}) — son résultat t'a été remis. Lance-en un nouveau avec ce résultat dans sa consigne si tu veux aller plus loin.` };
  }
  const { error } = await admin.from("internal_agent_run_inbox").insert({
    run_id: input.childRunId, from_run_id: input.parentRunId, kind: "follow_up",
    label: c.label ?? null, status: null, content: input.message.slice(0, 8_000),
  });
  if (error) return { error: error.message };
  await wakeRun(admin, input.childRunId).catch(() => false);
  return { ok: true };
}

/** Ce qui attend dans la boîte d'un run, marqué lu dans le même geste. */
export async function takeInbox(admin: SupabaseClient, runId: string): Promise<InboxItem[]> {
  const { data, error } = await admin.from("internal_agent_run_inbox")
    .select("id, from_run_id, kind, label, status, content, created_at")
    .eq("run_id", runId).is("consumed_at", null)
    .order("created_at", { ascending: true }).limit(50);
  if (error || !data?.length) return [];
  const items = data as InboxItem[];
  // Marqué lu seulement si on l'a pris : la condition sur consumed_at évite
  // qu'un tick concurrent (il ne devrait pas y en avoir) le prenne deux fois.
  const { data: taken } = await admin.from("internal_agent_run_inbox")
    .update({ consumed_at: new Date().toISOString() })
    .in("id", items.map((i) => i.id)).is("consumed_at", null)
    .select("id");
  const ok = new Set(((taken ?? []) as Array<{ id: string }>).map((t) => t.id));
  return items.filter((i) => ok.has(i.id));
}

/** Le message qu'un élément de la boîte devient dans le transcrit. */
export function inboxMessage(item: InboxItem): string {
  if (item.kind === "follow_up") {
    return `[Message de l'agent qui t'a lancé, reçu pendant ton travail — prends-le en compte, ajuste si besoin]\n${item.content}`;
  }
  const attrs = [
    `kind="subagent"`,
    item.from_run_id ? `run_id="${item.from_run_id}"` : "",
    item.label ? `label="${item.label.replace(/"/g, "'")}"` : "",
    `status="${item.status ?? "succeeded"}"`,
  ].filter(Boolean).join(" ");
  return `<background-result ${attrs}>\n${item.content}\n</background-result>`;
}

/** Les enfants en arrière-plan d'un run encore en cours. */
export async function outstandingChildren(
  admin: SupabaseClient, parentRunId: string, ids: string[],
): Promise<Array<{ id: string; label: string | null; status: string }>> {
  if (!ids.length) return [];
  const { data } = await admin.from("internal_agent_runs")
    .select("id, label, status").in("id", ids.slice(-200)).eq("parent_run_id", parentRunId);
  return ((data ?? []) as Array<{ id: string; label: string | null; status: string }>)
    .filter((r) => r.status === "running" || r.status === "queued");
}

/** La consigne donnée au parent quand il lance des enfants. */
export function spawnedNotice(children: Array<{ runId: string; label: string }>, failed: string[]): string {
  return [
    `${children.length} sous-agent(s) lancé(s) EN ARRIÈRE-PLAN :`,
    ...children.map((c) => `- « ${c.label} » → run_id ${c.runId}`),
    ...(failed.length ? [`Non lancés : ${failed.join(" ; ")}`] : []),
    "",
    "Chacun te renverra son résultat dans un message <background-result kind=\"subagent\"> dès qu'il aura fini (en général au tick suivant ou plus tard). D'ici là :",
    "- NE refais PAS leur travail, ne les relance pas, ne les attends pas activement ;",
    "- avance sur ce qui ne dépend pas d'eux ; si plus rien n'en est indépendant, termine ton tour par une phrase disant ce que tu attends — tu seras réveillé à l'arrivée des résultats ;",
    "- pour préciser une consigne à un sous-agent EN COURS : message_subagent(run_id, message).",
  ].join("\n");
}
