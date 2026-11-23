// Le seul point d'entrée pour faire travailler un agent (docs/harness-opencode,
// 04, étape R0) : chat, mission, salle, workflow, message d'un collègue.
//
// Ce que fait startAgentRun avant de confier le tour à OpenCode (chat.ts) :
//   - les garde-fous sur la demande (guard.ts) : un blocage clôt le run sans
//     appeler le modèle ;
//   - le contexte du run (prompt.ts, buildRunContext) : mode, skills classés,
//     mémoire, mémoire d'équipe, travail récent choisis pour SA tâche, état des
//     mondes d'exécution, page jointe depuis le navigateur ;
//   - le contrat de succès (agent-loop.ts), vérifié à la fin par lifecycle.ts ;
//   - pour une mission : la consigne complète (mission.ts), le kanban ;
//   - pour un chat : le principal du tour (turn-principal.ts) et
//     l'apprentissage sur la remarque de la personne (agent-learning.ts).
//
// Les appelants (route.ts pour HTTP, et le code des salles, workflows,
// collègues, en direct) passent tous par ici.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "../edge/_shared/supabase-admin.ts";
import { deriveContract, type SuccessContract } from "../edge/_shared/agent-loop.ts";
import { learnInBackground } from "../edge/_shared/agent-learning.ts";
import { claimTurn } from "../edge/_shared/turn-principal.ts";
import {
  COMPANION_NOTE, isCompanionConversation, loadActivatedSkills, loadAgentAndTools, loadRuntimeConfig,
  makeToolContext, probeRunner, probeSandbox, type AgentRow,
} from "../agents/context.ts";
import {
  buildRunContext, loadMemorySection, loadRecentWorkSection, loadTeamMemorySection, rankSkills, type RunMode,
} from "../agents/prompt.ts";
import { learnFromChatMessage } from "../agents/finalize.ts";
import { buildMissionPrompt, MISSION_COLUMNS, missionTaskText, type MissionRow } from "../agents/mission.ts";
import { startChatTurn, startTaskRun, type ChatTurn } from "./chat.ts";
import { guardPrompt } from "./guard.ts";
import { runResult } from "./lifecycle.ts";
import type { HarnessRuntime } from "./runtime.ts";
import type { HarnessAgent, RunKind } from "./store.ts";

type Admin = SupabaseClient;

/** Une erreur à rendre telle quelle à l'appelant HTTP (statut et message). */
export class RunRequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface AgentRunInput {
  agentId: string;
  kind: RunKind;
  /** Le run déjà créé par l'appelant (mission en file, tour de salle, workflow). */
  runId?: string | null;
  /** Chat : la conversation (le message de la personne y est déjà). */
  conversationId?: string | null;
  /** Le modèle choisi dans le composer (chat). */
  model?: string | null;
  /** Hors chat et mission : la consigne du tour. */
  text?: string;
  /** Un bloc ajouté au contexte du run (consignes de la salle, de l'étape…). */
  extraContext?: string;
  /** Les liaisons du run (salle, tâche de mission, workflow, message A2A) et un contrat déjà établi. */
  meta?: Record<string, unknown>;
  actingUserId?: string | null;
  via?: string;
}

const SMALL_TALK = /^\s*(hey|hello|hi|salut|coucou|bonjour|bonsoir|yo|ça va|ca va|merci|thanks|thank you|top|super|parfait|cool)\b/i;
const CONTINUATION = /^\s*(continue|continu|poursuis|reprends?|resume|go on|keep going|next|suite|encore|vas[-\s]?y|ok\b)/i;

/** Le sujet d'un message : les pages jointes depuis le navigateur réduites à leur titre. */
export function focusOf(text: string): string {
  return text.replace(
    /<(page|selection|element)_context\b([^>]*)>[\s\S]*?<\/\1_context>/g,
    (_w: string, kind: string, attrs: string) => ` [${kind} : ${attrs.match(/title="([^"]*)"/)?.[1] ?? "jointe"}]`,
  );
}

/** L'état des mondes d'exécution de l'agent : une note si l'un d'eux est injoignable. */
async function infraNotes(admin: Admin, agent: AgentRow): Promise<string> {
  if (agent.sandbox_mode === "cloud") return "";
  const ctx = makeToolContext({ admin: admin as never, agent, runId: null, missionId: null, runtimeConfig: await loadRuntimeConfig(admin as never) });
  const notes: string[] = [];
  if (ctx.sandboxUrl) {
    const down = await probeSandbox(ctx.sandboxUrl);
    if (down) notes.push(`NOTE INFRA : la sandbox d'exécution est HORS LIGNE (${down}) ; ses outils sandbox_* sont indisponibles pour ce run.${ctx.hybrid ? " Utilise ceux du runner s'il répond." : " Si on te demande d'exécuter, dis que l'infrastructure locale doit être relancée."}`);
  }
  if (ctx.runnerEnabled && ctx.runnerUrl) {
    const down = await probeRunner(ctx.runnerUrl);
    if (down) notes.push(`NOTE INFRA : le runner est HORS LIGNE (${down}) ; ses outils runner_* (navigateur, shell, code, fichiers) sont indisponibles pour ce run.${ctx.hybrid ? " Utilise ceux de la sandbox si elle répond." : " Si on te demande d'exécuter, dis qu'il doit être relancé."}`);
  }
  return notes.join("\n");
}

/** Le contexte d'un run, choisi pour sa tâche. */
async function runContext(admin: Admin, agent: AgentRow, runId: string | null, mode: RunMode, task: string, extra: string[]): Promise<string> {
  const focus = focusOf(task);
  const [memory, teamMemory, skills, recentWork, infra] = await Promise.all([
    loadMemorySection(admin as never, agent.id, focus || undefined).catch(() => ""),
    loadTeamMemorySection(admin as never, agent.project_id, agent.service_dashboard_id ?? null).catch(() => ""),
    loadActivatedSkills(admin as never, agent.id).catch(() => []),
    loadRecentWorkSection(admin as never, agent.id).catch(() => ""),
    infraNotes(admin, agent).catch(() => ""),
  ]);
  const skillBoost = await rankSkills({ admin: admin as never, workspaceId: agent.workspace_id, projectId: agent.project_id, runId }, skills as never, focus).catch(() => undefined);
  return buildRunContext({
    mode, taskText: focus, memory, teamMemory, recentWork, skills: skills as never, skillBoost,
    extra: [...extra, infra].filter((x) => x && x.trim()).join("\n\n"),
  });
}

/** Un run qui ne part pas (garde-fou) : clos en échec, avec la raison là où on l'attend. */
async function refuse(rt: HarnessRuntime, admin: Admin, agent: HarnessAgent, input: AgentRunInput, message: string): Promise<ChatTurn> {
  let runId = input.runId ?? null;
  if (!runId) {
    const { data } = await admin.from("internal_agent_runs").insert({
      agent_id: agent.id, workspace_id: agent.workspace_id, project_id: agent.project_id,
      conversation_id: input.conversationId ?? null, status: "failed", started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(), triggered_via: input.via ?? input.kind, error_message: message.slice(0, 500),
      run_meta: { kind: input.kind, ...(input.meta ?? {}) },
    }).select("id").single();
    runId = (data as { id: string } | null)?.id ?? null;
  }
  if (!runId) throw new Error(message);
  await admin.from("internal_agent_runs").update({
    status: "failed", finished_at: new Date().toISOString(), error_message: message.slice(0, 500),
  }).eq("id", runId);
  await admin.from("internal_agent_run_events").insert({ run_id: runId, agent_id: agent.id, kind: "error", payload: { error: message } });
  if (input.conversationId) {
    await admin.from("internal_agent_messages").insert({
      conversation_id: input.conversationId, agent_id: agent.id, role: "assistant", content: `⚠️ ${message}`, run_id: runId,
    });
    await rt.store.touchConversation(input.conversationId).catch(() => {});
  }
  return { ok: true, run_id: runId, queued: true };
}

/** Fait travailler un agent : le seul chemin, quel que soit ce que sert le run. */
export async function startAgentRun(rt: HarnessRuntime, input: AgentRunInput): Promise<ChatTurn> {
  const admin = createServiceClient() as unknown as Admin;
  const agent = await rt.store.agent(input.agentId);
  if (!agent) throw new RunRequestError(404, "agent introuvable");
  const { agent: row } = await loadAgentAndTools(input.agentId);
  const deps = { harness: rt.harness, store: rt.store, bridge: rt.bridge, agents: rt.agents };

  if (input.kind === "chat") {
    const conversationId = input.conversationId ?? "";
    if (!conversationId) throw new RunRequestError(400, "conversation_id requis pour un chat");
    // Une réponse à la question de l'agent, ou un message pendant son tour :
    // le run en cours le prend (chat.ts), sans nouveau contexte.
    const waiting = await rt.store.pendingQuestion?.(conversationId);
    const active = waiting ? null : await rt.store.activeRun(conversationId);
    if (waiting || active) {
      const out = await startChatTurn(deps, { agent, conversationId, model: input.model });
      // Une correction tapée pendant le travail est le retour le plus précis qui soit.
      learnInBackground(learnFromChatMessage(admin as never, agent.id, conversationId, out.run_id));
      return out;
    }
    const history = await rt.store.recentMessages(conversationId, 13);
    const text = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
    // Ce tour appartient à l'auteur du message qui l'ouvre (turn-principal.ts).
    await claimTurn(admin as never, conversationId).catch(() => null);
    const blocked = await guardPrompt(admin, row, "", text).catch(() => null);
    if (blocked) return refuse(rt, admin, agent, input, blocked);

    const extra: string[] = [];
    if (await isCompanionConversation(admin as never, conversationId).catch(() => false)) extra.push(COMPANION_NOTE);
    const trimmed = text.trim();
    const continuation = CONTINUATION.test(trimmed);
    if (!continuation && trimmed.length <= 40 && SMALL_TALK.test(trimmed)) {
      extra.push("[FOCUS] Le dernier message n'est qu'une formule de politesse. Réponds brièvement et chaleureusement (une ou deux phrases), sans reprendre ni relancer aucune tâche antérieure et sans appeler d'outil. Si un travail est resté inachevé, mentionne-le en une phrase et demande s'il faut le reprendre.");
    }
    let contract: SuccessContract | null = null;
    if (trimmed.length >= 24 || continuation) {
      contract = await deriveContract({ source: "chat", goal: trimmed.slice(0, 800), hasTodos: true }).catch(() => null);
    }
    const context = await runContext(admin, row, null, "chat", text, extra);
    const out = await startChatTurn(deps, {
      agent, conversationId, model: input.model, runContext: context,
      meta: { task: trimmed.slice(0, 2000), contract, ...(input.meta ?? {}) },
      actingUserId: input.actingUserId ?? null,
    });
    if (contract) {
      await admin.from("internal_agent_run_events").insert({
        run_id: out.run_id, agent_id: agent.id, kind: "loop",
        payload: { phase: "contract", goal: contract.goal, checks: contract.checks.map((c) => ({ label: c.label, kind: c.kind, required: c.required !== false })) },
      }).then(() => {}, () => {});
    }
    learnInBackground(learnFromChatMessage(admin as never, agent.id, conversationId, out.run_id));
    return out;
  }

  if (input.kind === "mission") {
    if (!input.runId) throw new RunRequestError(400, "run_id requis pour une mission");
    const { data: run } = await admin.from("internal_agent_runs")
      .select("id, agent_id, mission_id, status, trigger_payload, triggered_by").eq("id", input.runId).maybeSingle();
    const r = run as { id: string; agent_id: string; mission_id: string | null; status: string; trigger_payload: unknown; triggered_by: string | null } | null;
    if (!r) throw new RunRequestError(404, "run introuvable");
    if (r.agent_id !== agent.id) throw new RunRequestError(403, "ce run n'est pas celui de cet agent");
    // Idempotence : seul un run en file part (une double invocation ne fait rien).
    if (r.status !== "queued") throw new RunRequestError(409, `Run is ${r.status}, not queued`);
    const { data: m } = await admin.from("internal_agent_missions").select(MISSION_COLUMNS).eq("id", r.mission_id ?? "").maybeSingle();
    const mission = m as MissionRow | null;
    if (!mission) throw new RunRequestError(404, "mission introuvable");
    const prompt = await buildMissionPrompt(admin, r.id, r, mission);
    const blocked = await guardPrompt(admin, row, r.id, prompt).catch(() => null);
    if (blocked) {
      await admin.from("internal_agent_missions").update({ board_column: "todo" }).eq("id", mission.id).eq("board_column", "in_progress");
      return refuse(rt, admin, agent, input, blocked);
    }
    // Kanban : une mission qui tourne est « en cours ».
    await admin.from("internal_agent_missions").update({ board_column: "in_progress" }).eq("id", mission.id).in("board_column", ["backlog", "todo"]);
    const task = missionTaskText(mission);
    const contract = await deriveContract({
      source: "mission", goal: `${mission.title} — ${String(mission.brief ?? "").slice(0, 600)}`,
      acceptanceCriteria: mission.acceptance_criteria,
      expectedDeliverables: Array.isArray(mission.expected_deliverables) ? mission.expected_deliverables as never : [],
      hasTodos: true,
    }).catch(() => null);
    const context = await runContext(admin, row, r.id, "mission", task, input.extraContext ? [input.extraContext] : []);
    const out = await startTaskRun(deps, {
      agent, kind: "mission", runId: r.id, text: prompt, unattended: true, runContext: context,
      meta: { task: task.slice(0, 2000), mission_id: mission.id, contract, ...(input.meta ?? {}) },
      actingUserId: input.actingUserId ?? r.triggered_by ?? null,
      via: input.via,
    });
    await admin.from("internal_agent_run_events").insert({
      run_id: out.run_id, agent_id: agent.id, kind: "log",
      payload: { message: `Mission lancée : budget ${row.max_steps} étapes, ${row.max_run_cost_usd} $.` },
    }).then(() => {}, () => {});
    if (contract) {
      await admin.from("internal_agent_run_events").insert({
        run_id: out.run_id, agent_id: agent.id, kind: "loop",
        payload: { phase: "contract", goal: contract.goal, checks: contract.checks.map((c) => ({ label: c.label, kind: c.kind, required: c.required !== false })) },
      }).then(() => {}, () => {});
    }
    return out;
  }

  // Salle, workflow, collègue : la consigne vient de l'appelant.
  const text = String(input.text ?? "").trim();
  if (!text) throw new RunRequestError(400, "consigne vide");
  const blocked = await guardPrompt(admin, row, input.runId ?? "", text).catch(() => null);
  if (blocked) return refuse(rt, admin, agent, input, blocked);
  const context = await runContext(admin, row, input.runId ?? null, input.kind, text, input.extraContext ? [input.extraContext] : []);
  return startTaskRun(deps, {
    agent, kind: input.kind, runId: input.runId ?? null, text, unattended: true, runContext: context,
    meta: { task: text.slice(0, 2000), ...(input.meta ?? {}) },
    actingUserId: input.actingUserId ?? null,
    via: input.via,
  });
}

/** Le harnais en service, ou une erreur claire (le moteur d'agents n'a pas démarré). */
export async function requireRuntime(): Promise<HarnessRuntime> {
  const { harnessRuntime } = await import("./runtime.ts");
  const rt = harnessRuntime();
  if (!rt) throw new RunRequestError(503, "le moteur d'agents (harnais OpenCode) n'est pas démarré");
  return rt;
}

/**
 * Lance un run et attend sa fin : pour les appelants qui ont besoin de la
 * réponse (message d'un collègue, sous-étape synchrone). Rend le texte final,
 * ou lève une erreur si le run échoue ou dépasse le délai.
 */
export async function runAndWait(input: AgentRunInput, timeoutMs = 15 * 60_000): Promise<{ runId: string; text: string }> {
  const rt = await requireRuntime();
  const out = await startAgentRun(rt, input);
  const admin = createServiceClient() as unknown as Admin;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = runResult(out.run_id);
    if (done) {
      if (done.status !== "succeeded") throw new Error(done.text || `run ${done.status}`);
      return { runId: out.run_id, text: done.text };
    }
    const { data } = await admin.from("internal_agent_runs").select("status, final_output, error_message").eq("id", out.run_id).maybeSingle();
    const r = data as { status: string; final_output: string | null; error_message: string | null } | null;
    if (r && ["succeeded", "failed", "cancelled", "awaiting_input"].includes(r.status)) {
      const settled = runResult(out.run_id);
      if (r.status === "succeeded") return { runId: out.run_id, text: settled?.text ?? r.final_output ?? "" };
      throw new Error(r.error_message || settled?.text || `run ${r.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("le run n'a pas fini à temps");
}
