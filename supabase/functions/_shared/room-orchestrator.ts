// Room orchestrator — the assistant as the room's conductor.
//
// A service dashboard's rooms used to be flat: the human wrote, the mentioned
// agent (or the default responder) answered the whole request alone. Anything
// needing two specialists in a given order had to be hand-routed message by
// message.
//
// This module makes the room's assistant the CENTRAL NODE instead. On every
// unaddressed turn it decides one of four things:
//
//   answer   — it can handle this itself; reply directly.
//   route    — one teammate is clearly the right hands for it; hand the prompt
//              over, with the reason stated in the room.
//   mission  — this is real multi-agent work; decompose it into MILESTONES
//              holding TASKS, assign each task to the best-fitting agent,
//              declare what each task depends on, then DRIVE it.
//   staff    — nobody in the room fits; create the specialist first (from the
//              user's plain-language description), then route or plan.
//
// Driving a mission is the part that matters. `advanceRoomMission` runs the
// frontier: it dispatches exactly the tasks whose dependencies are satisfied,
// pauses on the rest, and is re-entered when a task's run finishes — at which
// point the finished task's RESULT is folded into the briefs of the tasks that
// were waiting on it, the kanban card moves, the outcome is written to the
// agents' shared memory, and the next frontier goes out. When nothing is left,
// the orchestrator posts the mission's closing report in the room.
//
// Everything an agent does inside a mission runs on the SAME durable tick engine
// as a normal room turn (run_state + agent_tick_enqueue), so a task that takes
// twenty minutes survives the edge wall-clock exactly like a chat turn does.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { callAi, safeParseJson, type ChatMessage } from "./ai.ts";
import { buildInternalToolset, type AgentToolRow, type InternalToolContext } from "./internal-agent-tools.ts";
import { classifyTier, modelForTier, resolveProvider, cheapProvider } from "./model-router.ts";
import { compileSystemPrompt, type SectionInput } from "./prompt-compiler.ts";
import { ORCHESTRATOR_PROACTIVITY } from "./proactivity.ts";
import { deriveContract } from "./agent-loop.ts";

type Admin = SupabaseClient;
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

export interface RoomRef {
  id: string;
  dashboard_id: string;
  workspace_id: string;
  project_id: string;
  title: string;
}

export interface RosterAgent {
  id: string;
  name: string;
  persona: string | null;
  instructions: string | null;
  role?: string | null;
  /** Provider/model pin from the agent's settings — see resolveProvider. */
  model?: string | null;
  is_orchestrator: boolean | null;
  temperature?: number | null;
  created_by?: string | null;
  swarm_enabled?: boolean | null;
  swarm_max_concurrency?: number | null;
  service_dashboard_id?: string | null;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface PlannedTask {
  ref: string;                 // planner-local id ("t1"), used to express deps
  title: string;
  brief: string;
  agent: string;               // agent NAME as written by the planner
  milestone: string;           // milestone ref ("m1")
  depends_on: string[];        // planner-local task refs
}

export interface PlannedMilestone {
  ref: string;                 // "m1"
  title: string;
  description?: string;
  /** Relative planning window in days from the mission start — the timeline
   *  needs something to draw before anything has run. */
  day_start?: number;
  day_end?: number;
}

export interface NewAgentSpec {
  name: string;
  role: string;
  instructions: string;
}

export interface RouteDecision {
  mode: "answer" | "route" | "mission";
  /** Chosen agent NAME for "route". */
  agent?: string;
  /** One short sentence, shown in the room. */
  reason: string;
  /** Agents to create before executing (any mode). */
  new_agents?: NewAgentSpec[];
  mission?: {
    title: string;
    objective: string;
    rationale: string;
    milestones: PlannedMilestone[];
    tasks: PlannedTask[];
  };
}

/** The decomposition contract, shared by the router and the explicit
 *  "plan me a mission" path so both produce the same shape. */
const MISSION_SHAPE = [
  `POUR UNE MISSION :`,
  `- "milestones" = les JALONS, dans l'ordre chronologique (3 à 6). Chacun a un "ref" ("m1", "m2"…), un titre court, et une fenêtre indicative en jours depuis le départ ("day_start", "day_end", entiers ≥ 0).`,
  `- "tasks" = les TÂCHES (3 à 12). Chacune : "ref" ("t1"…), "title" court, "brief" (consigne complète et autonome donnée à l'agent : quoi produire, avec quoi, comment vérifier), "agent" (NOM EXACT d'un agent de la liste ou d'un new_agent), "milestone" (ref du jalon) et "depends_on" (refs des tâches dont elle a besoin — vide si elle peut démarrer tout de suite).`,
  `- LE PARALLÉLISME EST GRATUIT : deux tâches qui n'ont pas besoin l'une de l'autre doivent avoir des depends_on vides ou disjoints — elles partiront en même temps. Ne chaîne QUE ce qui est réellement séquentiel.`,
  `- La dernière tâche est en général une synthèse/consolidation qui dépend des autres.`,
].join("\n");

/** How the roster is described to the router — name, role, and what it is for. */
function rosterCard(a: RosterAgent): string {
  const bits = [a.role, a.persona].filter(Boolean).join(" — ");
  const how = a.instructions ? ` Instructions: ${String(a.instructions).replace(/\s+/g, " ").slice(0, 220)}` : "";
  return `- ${a.name}${a.is_orchestrator ? " (l'assistant — toi)" : ""}: ${bits || "(pas de rôle décrit)"}.${how}`;
}

/**
 * Decide what happens to this turn. Deliberately ONE call: routing must be
 * cheap enough to run on every unaddressed message, or the room gets slow and
 * people go back to @mentioning by hand.
 *
 * The router is told to prefer the *smallest* thing that works — answering
 * beats routing, routing beats a mission — because a mission that should have
 * been a sentence is the most annoying failure mode of an orchestrator.
 */
export async function routeTurn(opts: {
  room: RoomRef;
  dashboardName: string;
  assistant: RosterAgent;
  roster: RosterAgent[];
  thread: Array<{ who: string; text: string }>;
  userText: string;
  /** Missions already running in this room — a follow-up usually belongs to one. */
  openMissions: Array<{ id: string; title: string }>;
  /**
   * The human explicitly asked for a mission (the "Nouvelle mission" form), so
   * the routing question is settled — only the DECOMPOSITION is still open.
   * Skipping the answer/route branches here matters: asked to plan, the router
   * would otherwise sometimes decide the brief was "just a question".
   */
  forceMission?: boolean;
}): Promise<RouteDecision> {
  const roster = opts.roster.filter((a) => !a.is_orchestrator);
  const system = opts.forceMission ? [
    `Tu es « ${opts.assistant.name} », l'assistant-chef d'orchestre du service « ${opts.dashboardName} ».`,
    `Un humain te demande de PLANIFIER une mission collective. Tu ne fais pas le travail : tu le DÉCOUPES et tu le RÉPARTIS.`,
    ``,
    `AGENTS DISPONIBLES DANS LA ROOM :`,
    roster.length ? roster.map(rosterCard).join("\n") : "(aucun agent spécialisé — seulement toi)",
    ``,
    `SI PERSONNE NE CONVIENT pour une partie du travail : ajoute dans "new_agents" le ou les agents à créer (nom court, rôle en une ligne, instructions opérationnelles précises) puis utilise leur nom dans les tâches. Max 3.`,
    ``,
    MISSION_SHAPE,
    ``,
    `Réponds en JSON STRICT, sans prose ni fence :`,
    `{"mode":"mission","reason":"une phrase, en français","new_agents":[{"name":"","role":"","instructions":""}],`,
    ` "mission":{"title":"","objective":"","rationale":"pourquoi ce découpage, 2 phrases","milestones":[{"ref":"m1","title":"","description":"","day_start":0,"day_end":2}],`,
    `  "tasks":[{"ref":"t1","title":"","brief":"","agent":"","milestone":"m1","depends_on":[]}]}}`,
    `Omets "new_agents" quand il n'y en a pas. "mode" vaut TOUJOURS "mission".`,
  ].join("\n") : [
    `Tu es « ${opts.assistant.name} », l'assistant-chef d'orchestre du service « ${opts.dashboardName} ».`,
    `Tu reçois chaque message d'une room et tu décides QUI fait QUOI. Tu ne fais pas le travail ici : tu ORIENTES.`,
    ``,
    `AGENTS DISPONIBLES DANS LA ROOM :`,
    roster.length ? roster.map(rosterCard).join("\n") : "(aucun agent spécialisé — seulement toi)",
    opts.openMissions.length
      ? `\nMISSIONS DÉJÀ EN COURS DANS CETTE ROOM : ${opts.openMissions.map((m) => `"${m.title}"`).join(", ")}\n` +
        `⚠️ Si le message est un SUIVI de l'une d'elles (question sur l'avancement, correction, précision, relance), NE crée PAS une nouvelle mission : réponds toi-même ("answer") ou route vers l'agent concerné ("route"). On ne crée une mission que pour du travail NOUVEAU.`
      : "",
    ``,
    `CHOISIS LE PLUS PETIT MODE QUI SUFFIT — dans cet ordre :`,
    `1. "answer" — question, information, avis, précision, salutation, ou tâche courte que tu fais toi-même. C'est le cas LE PLUS FRÉQUENT : n'invente pas de projet là où on te pose une question.`,
    `2. "route" — un seul agent de la liste est manifestement le bon exécutant (une seule compétence, un seul livrable). Donne son NOM EXACT dans "agent".`,
    `3. "mission" — le travail demande PLUSIEURS interventions (plusieurs compétences, ou des étapes qui dépendent les unes des autres, ou un vrai livrable composite). Découpe-le.`,
    ``,
    `SI PERSONNE NE CONVIENT : ajoute dans "new_agents" le ou les agents à créer (nom court, rôle en une ligne, instructions opérationnelles précises) puis utilise leur nom dans "agent" / dans les tâches. Ne crée un agent que si aucun agent existant ne peut raisonnablement faire le travail. Max 3.`,
    ``,
    MISSION_SHAPE,
    ``,
    `Réponds en JSON STRICT, sans prose ni fence :`,
    `{"mode":"answer"|"route"|"mission","reason":"une phrase, en français","agent":"Nom exact (mode route)","new_agents":[{"name":"","role":"","instructions":""}],`,
    ` "mission":{"title":"","objective":"","rationale":"pourquoi ce découpage, 2 phrases","milestones":[{"ref":"m1","title":"","description":"","day_start":0,"day_end":2}],`,
    `  "tasks":[{"ref":"t1","title":"","brief":"","agent":"","milestone":"m1","depends_on":[]}]}}`,
    `Omets "mission" hors du mode mission, et "new_agents" quand il n'y en a pas.`,
  ].filter(Boolean).join("\n");

  const thread = opts.thread.slice(-12).map((m) => `[${m.who}] ${m.text.slice(0, 600)}`).join("\n");
  const res = await callAi({
    task: "classification",
    provider: cheapProvider(),
    jsonMode: true,
    maxTokens: 2200,
    temperature: 0.2,
    systemPrompt: system,
    userPrompt: opts.forceMission
      ? `# Mission à planifier\n${opts.userText.slice(0, 4000)}${thread ? `\n\n# Contexte de la room\n${thread}` : ""}`
      : `# Fil de la room\n${thread || "(vide)"}\n\n# Message à traiter\n${opts.userText.slice(0, 3000)}`,
  });
  const parsed = safeParseJson<RouteDecision>(res.content);
  if (!parsed?.mode) {
    return opts.forceMission
      ? { mode: "answer", reason: "Planification indisponible." }
      : { mode: "answer", reason: "Routage indisponible — je réponds moi-même." };
  }
  if (opts.forceMission) parsed.mode = "mission";
  return normalizeDecision(parsed, roster, opts.forceMission === true);
}

/** Trust nothing the model wrote about names, refs or dependencies — a bad ref
 *  here would deadlock a mission forever. */
function normalizeDecision(d: RouteDecision, roster: RosterAgent[], forceMission = false): RouteDecision {
  const out: RouteDecision = {
    mode: d.mode === "mission" || d.mode === "route" ? d.mode : "answer",
    reason: str(d.reason).slice(0, 300) || "—",
    new_agents: (d.new_agents ?? []).filter((a) => str(a?.name).trim()).slice(0, 3).map((a) => ({
      name: str(a.name).trim().slice(0, 60),
      role: str(a.role).trim().slice(0, 200),
      instructions: str(a.instructions).trim().slice(0, 4000),
    })),
  };
  const known = new Set([...roster.map((a) => a.name), ...(out.new_agents ?? []).map((a) => a.name)]);
  if (out.mode === "route") {
    const wanted = str(d.agent).trim();
    const match = [...known].find((n) => n.toLowerCase() === wanted.toLowerCase())
      ?? [...known].find((n) => wanted && n.toLowerCase().includes(wanted.toLowerCase()));
    if (!match) return { ...out, mode: "answer", reason: out.reason };
    out.agent = match;
    return out;
  }
  if (out.mode !== "mission") return out;

  const m = d.mission;
  const milestones = (m?.milestones ?? []).filter((x) => str(x?.title).trim()).slice(0, 8)
    .map((x, i) => ({
      ref: str(x.ref).trim() || `m${i + 1}`,
      title: str(x.title).trim().slice(0, 160),
      description: str(x.description).slice(0, 600),
      day_start: Number.isFinite(Number(x.day_start)) ? Math.max(0, Math.round(Number(x.day_start))) : i,
      day_end: Number.isFinite(Number(x.day_end)) ? Math.max(0, Math.round(Number(x.day_end))) : i + 1,
    }));
  const msRefs = new Set(milestones.map((x) => x.ref));

  const rawTasks = (m?.tasks ?? []).filter((t) => str(t?.title).trim()).slice(0, 16);
  const taskRefs = new Set(rawTasks.map((t, i) => str(t.ref).trim() || `t${i + 1}`));
  const tasks: PlannedTask[] = rawTasks.map((t, i) => {
    const ref = str(t.ref).trim() || `t${i + 1}`;
    const wanted = str(t.agent).trim();
    const agent = [...known].find((n) => n.toLowerCase() === wanted.toLowerCase())
      ?? [...known].find((n) => wanted && n.toLowerCase().includes(wanted.toLowerCase()))
      ?? "";
    return {
      ref,
      title: str(t.title).trim().slice(0, 160),
      brief: str(t.brief).trim().slice(0, 4000) || str(t.title),
      agent,
      milestone: msRefs.has(str(t.milestone).trim()) ? str(t.milestone).trim() : (milestones[0]?.ref ?? ""),
      // Drop unknown refs and self-references — either would make the task
      // permanently unready, which is a silent hang rather than an error.
      depends_on: (Array.isArray(t.depends_on) ? t.depends_on : [])
        .map(String).filter((r) => r !== ref && taskRefs.has(r)).slice(0, 8),
    };
  });
  // A mission with fewer than two real tasks is not a mission — downgrade it
  // rather than ceremonially tracking a single step. Unless the human asked
  // for one explicitly: then their intent outranks the heuristic.
  if (tasks.length < 2 && !forceMission) {
    return { ...out, mode: tasks.length === 1 && tasks[0].agent ? "route" : "answer", agent: tasks[0]?.agent, reason: out.reason };
  }
  out.mission = {
    title: str(m?.title).trim().slice(0, 160) || "Mission",
    objective: str(m?.objective).trim().slice(0, 2000),
    rationale: str(m?.rationale).trim().slice(0, 1200),
    milestones: milestones.length ? milestones : [{ ref: "m1", title: "Exécution", day_start: 0, day_end: 3 }],
    tasks,
  };
  return out;
}

// ---------------------------------------------------------------------------
// Staffing — the orchestrator can hire
// ---------------------------------------------------------------------------

/** Create the agents the router asked for, add them to the room, and return a
 *  name → id map. Failures are skipped, never fatal: a mission with one
 *  unstaffed task is still worth running. */
export async function ensureAgents(
  admin: Admin, room: RoomRef, specs: NewAgentSpec[], createdBy: string | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const spec of specs) {
    const { data, error } = await admin.from("internal_agents").insert({
      workspace_id: room.workspace_id, project_id: room.project_id,
      service_dashboard_id: room.dashboard_id,
      name: spec.name, role: spec.role || null, instructions: spec.instructions || null,
      chat_enabled: true, mission_enabled: true, created_by: createdBy,
    }).select("id, name").single();
    if (error || !data) continue;
    const id = (data as { id: string }).id;
    out.set(spec.name, id);
    await admin.from("service_room_agents").insert({ room_id: room.id, agent_id: id }).then(() => {}, () => {});
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mission persistence
// ---------------------------------------------------------------------------

export async function createMission(
  admin: Admin,
  room: RoomRef,
  assistant: RosterAgent,
  plan: NonNullable<RouteDecision["mission"]>,
  agentIdByName: Map<string, string>,
  createdBy: string | null,
): Promise<string | null> {
  const { data: mission, error } = await admin.from("service_room_missions").insert({
    room_id: room.id, dashboard_id: room.dashboard_id,
    workspace_id: room.workspace_id, project_id: room.project_id,
    orchestrator_agent_id: assistant.id,
    title: plan.title, objective: plan.objective, plan_rationale: plan.rationale,
    status: "planning", created_by: createdBy, started_at: new Date().toISOString(),
  }).select("id").single();
  if (error || !mission) return null;
  const missionId = (mission as { id: string }).id;

  const day0 = Date.now();
  const DAY = 24 * 3600 * 1000;
  const msIdByRef = new Map<string, string>();
  for (let i = 0; i < plan.milestones.length; i++) {
    const ms = plan.milestones[i];
    const { data } = await admin.from("service_room_milestones").insert({
      mission_id: missionId, title: ms.title, description: ms.description ?? null, position: i,
      starts_at: new Date(day0 + (ms.day_start ?? i) * DAY).toISOString(),
      ends_at: new Date(day0 + Math.max((ms.day_end ?? i + 1), (ms.day_start ?? i) + 1) * DAY).toISOString(),
    }).select("id").single();
    if (data) msIdByRef.set(ms.ref, (data as { id: string }).id);
  }

  // Two passes: insert every task to get real ids, then rewrite depends_on from
  // planner refs to those ids.
  const taskIdByRef = new Map<string, string>();
  for (let i = 0; i < plan.tasks.length; i++) {
    const t = plan.tasks[i];
    const { data } = await admin.from("service_room_tasks").insert({
      mission_id: missionId,
      milestone_id: msIdByRef.get(t.milestone) ?? null,
      agent_id: agentIdByName.get(t.agent) ?? null,
      title: t.title, description: t.brief, position: i, status: "todo",
    }).select("id").single();
    if (data) taskIdByRef.set(t.ref, (data as { id: string }).id);
  }
  for (const t of plan.tasks) {
    const id = taskIdByRef.get(t.ref);
    if (!id || t.depends_on.length === 0) continue;
    const deps = t.depends_on.map((r) => taskIdByRef.get(r)).filter(Boolean) as string[];
    if (deps.length) await admin.from("service_room_tasks").update({ depends_on: deps }).eq("id", id);
  }

  await logMissionEvent(admin, missionId, {
    kind: "planned", agent_id: assistant.id,
    message: `Mission découpée en ${plan.milestones.length} jalon(s) et ${plan.tasks.length} tâche(s).`,
    payload: { rationale: plan.rationale },
  });
  return missionId;
}

/**
 * A mission the human will fill in themselves: title, objective, one default
 * milestone, no tasks. The board is then the authoring surface — add cards,
 * assign agents, hit "relancer". Deliberately NOT an LLM call: someone who
 * already knows the plan should not have to argue with a planner about it.
 */
export async function createEmptyMission(
  admin: Admin, room: RoomRef, assistant: RosterAgent | null,
  input: { title: string; objective: string }, createdBy: string | null,
): Promise<string | null> {
  const { data, error } = await admin.from("service_room_missions").insert({
    room_id: room.id, dashboard_id: room.dashboard_id,
    workspace_id: room.workspace_id, project_id: room.project_id,
    orchestrator_agent_id: assistant?.id ?? null,
    title: input.title.slice(0, 160), objective: input.objective.slice(0, 2000),
    plan_rationale: "Mission créée à la main — le plan est défini depuis le tableau.",
    status: "planning", created_by: createdBy, started_at: new Date().toISOString(),
  }).select("id").single();
  if (error || !data) return null;
  const missionId = (data as { id: string }).id;
  const now = Date.now();
  await admin.from("service_room_milestones").insert({
    mission_id: missionId, title: "Exécution", position: 0,
    starts_at: new Date(now).toISOString(),
    ends_at: new Date(now + 3 * 24 * 3600 * 1000).toISOString(),
  }).then(() => {}, () => {});
  await logMissionEvent(admin, missionId, {
    kind: "planned", message: "Mission créée manuellement — en attente de tâches.",
  });
  return missionId;
}

export async function logMissionEvent(
  admin: Admin, missionId: string,
  e: { kind: string; message: string; task_id?: string | null; agent_id?: string | null; payload?: Record<string, unknown> },
) {
  await admin.from("service_room_mission_events").insert({
    mission_id: missionId, task_id: e.task_id ?? null, agent_id: e.agent_id ?? null,
    kind: e.kind, message: e.message.slice(0, 1000), payload: e.payload ?? {},
  }).then(() => {}, () => {});
}

// ---------------------------------------------------------------------------
// Dispatch — one room turn, on the durable tick engine
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string; mission_id: string; milestone_id: string | null; agent_id: string | null;
  title: string; description: string | null; status: string; position: number;
  depends_on: string[]; run_id: string | null; result_summary: string | null;
}

/**
 * Hand one brief to one agent as a room turn. Creates the run, the "thinking"
 * placeholder the thread shows, and the resumable state the tick engine drains
 * — exactly the path a human-addressed turn takes, so a mission task is not a
 * second-class citizen with its own (divergent) execution semantics.
 */
export async function dispatchRoomTurn(admin: Admin, opts: {
  room: RoomRef;
  agentId: string;
  /** The instruction handed to the agent. */
  brief: string;
  /** Extra grounding placed before the brief (upstream results, mission goal). */
  context?: string;
  missionId?: string | null;
  taskId?: string | null;
  /** Thread messages for continuity; omit for an isolated task brief. */
  thread?: ChatMessage[];
  dashboardName: string;
}): Promise<{ runId: string; messageId: string } | null> {
  const { data: agentRow } = await admin.from("internal_agents")
    .select("id, name, persona, instructions, model, temperature, is_orchestrator, service_dashboard_id, created_by, swarm_enabled, swarm_max_concurrency")
    .eq("id", opts.agentId).maybeSingle();
  if (!agentRow) return null;
  const a = agentRow as RosterAgent;
  const taskProvider = resolveProvider(a.model);

  const { data: toolRows } = await admin.from("internal_agent_tools")
    .select("id, kind, name, description, config, enabled, requires_approval").eq("agent_id", a.id);

  const { data: tr } = await admin.from("internal_agent_runs").insert({
    agent_id: a.id, workspace_id: opts.room.workspace_id, project_id: opts.room.project_id,
    run_kind: "primary", status: "running", started_at: new Date().toISOString(),
    triggered_by: a.created_by ?? null,
  }).select("id").single();
  const runId = (tr as { id: string } | null)?.id ?? null;
  if (!runId) return null;

  const { data: ph } = await admin.from("service_room_messages").insert({
    room_id: opts.room.id, workspace_id: opts.room.workspace_id, project_id: opts.room.project_id,
    author_kind: "agent", agent_id: a.id, content: "", status: "thinking",
    run_id: runId, mission_id: opts.missionId ?? null, task_id: opts.taskId ?? null,
  }).select("id").single();
  const messageId = (ph as { id: string } | null)?.id ?? null;
  if (!messageId) return null;

  const system = buildRoomSystemPrompt({
    agent: a, room: opts.room, dashboardName: opts.dashboardName,
    toolRows: (toolRows ?? []) as AgentToolRow[], admin,
    mission: opts.missionId ? { taskTitle: opts.brief.slice(0, 120) } : null,
  });

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...(opts.thread ?? []),
    { role: "user", content: [opts.context ? `# Contexte\n${opts.context}` : "", opts.brief].filter(Boolean).join("\n\n") },
  ];

  // A MISSION TASK gets a success contract; a plain room turn does not.
  //
  // These runs go through the tick engine in "chat" mode, and the chat path
  // only derives a contract when the request enters through internal-agent-run
  // itself — a task dispatched from here had NO verification at all. That is how
  // "j'ai produit le rapport" became a `done` card with nothing saved: nobody
  // ever checked. With a contract, evaluateContract's deterministic
  // `deliverable_exists` runs against the DB, and the controller replans instead
  // of finalising on a claim.
  const contract = opts.taskId
    ? await deriveContract({
        source: "mission",
        goal: opts.brief.slice(0, 800),
        doneWhen: opts.context?.slice(0, 400) ?? null,
        hasTodos: false,
      }).catch(() => null)
    : null;

  await admin.from("internal_agent_run_state").upsert({
    run_id: runId,
    mode: "chat",
    agent_id: a.id,
    conversation_id: null,
    mission_id: null,
    contract,
    messages,
    round: 0,
    max_rounds: 400,
    // The assignee's OWN provider, not a hard-coded one: a mission task must run
    // on whatever the agent it was handed to is configured for.
    provider: taskProvider,
    model: modelForTier(classifyTier(opts.brief, { mode: "chat" }), taskProvider),
    processing_until: null,
    last_input_at: new Date().toISOString(),
    meta: {
      room: { room_id: opts.room.id, placeholder_id: messageId },
      // The tick engine reads this on finalization and re-enters the
      // orchestrator with the task's result.
      mission_task: opts.taskId ? { mission_id: opts.missionId, task_id: opts.taskId } : undefined,
    },
  });
  await admin.rpc("agent_tick_enqueue", { p_run_id: runId });
  return { runId, messageId };
}

/** The room system prompt, assembled by the prompt compiler so a room turn gets
 *  the same canonical, budgeted shape as an agent chat. */
export function buildRoomSystemPrompt(opts: {
  admin: Admin;
  agent: RosterAgent;
  room: RoomRef;
  dashboardName: string;
  toolRows: AgentToolRow[];
  mission?: { taskTitle: string } | null;
  extraContext?: string;
}): string {
  // A throwaway context: buildInternalToolset is only asked for its capability
  // TREE here — the durable tick engine rebuilds the real executor. Everything
  // in this stub is therefore inert by design.
  const ctx = {
    admin: opts.admin, workspaceId: opts.room.workspace_id, projectId: opts.room.project_id,
    agentId: opts.agent.id, agentName: opts.agent.name,
    collaborationEnabled: true, autopilot: false, runId: null,
    missionMode: false, delegationDepth: 0,
    serviceDashboardId: opts.agent.service_dashboard_id ?? opts.room.dashboard_id,
    userId: opts.agent.created_by ?? null,
    swarmEnabled: opts.agent.swarm_enabled !== false,
    createDeliverable: async () => {},
    requestApproval: async () => "approval-skipped-in-room",
    logEvent: async () => {},
    isCancelled: async () => false,
  } as unknown as InternalToolContext;
  const { capabilitySummary } = buildInternalToolset(opts.toolRows, ctx);

  const sections: SectionInput[] = [
    {
      id: "identity",
      body: [
        `You are ${opts.agent.name}${opts.agent.persona ? ` — ${opts.agent.persona}` : ""}, an agent in the shared room "${opts.room.title}" of the "${opts.dashboardName}" workspace.`,
        "The human and possibly other agents talk here; each message is prefixed with the speaker in [brackets]. Reply AS YOURSELF, directly and concisely — no need to restate the question or your name. Don't answer for other agents.",
      ].join("\n"),
    },
  ];
  if (opts.agent.instructions) sections.push({ id: "instructions", body: `Your instructions:\n${opts.agent.instructions}` });
  if (opts.agent.is_orchestrator) {
    sections.push({
      id: "doctrine",
      body: [
        "## Tu es le chef d'orchestre de cette room",
        "Tu es le nœud central du service : tu réponds, tu routes, tu organises, et tu peux CONSTRUIRE l'espace de travail à la demande.",
        "- Crée un agent sur mesure (create_agent) dès que l'utilisateur décrit un besoin qu'aucun agent existant ne couvre — nom clair, rôle, instructions opérationnelles.",
        "- Planifie du récurrent avec create_mission (schedule cron), lance de l'immédiat avec create_mission (start_now) sur l'agent le mieux placé.",
        "- Quand une mission de room est en cours, tu en es le responsable : tu suis l'avancement, tu synthétises les résultats des autres agents, et tu conclus.",
        "Confirme chaque action faite, en une phrase (« Agent X créé », « Brief quotidien planifié à 6h »).",
        "",
        ORCHESTRATOR_PROACTIVITY,
      ].join("\n"),
    });
  }
  if (opts.mission) {
    sections.push({
      id: "context",
      body: [
        "## Tu exécutes UNE tâche d'une mission collective",
        `Tâche : ${opts.mission.taskTitle}`,
        "Traite EXACTEMENT cette tâche — ni plus (les autres tâches ont leurs propres agents), ni moins.",
        "Termine par un compte rendu court et factuel : ce que tu as produit, les chiffres/faits clés, et ce qui bloque encore s'il y a lieu. Un autre agent va s'appuyer dessus — écris pour lui.",
      ].join("\n"),
    });
  }
  if (opts.extraContext) sections.push({ id: "context", body: opts.extraContext });
  sections.push({
    id: "rules",
    body: [
      "- Use render_ui for metrics/tables/charts, and create_deliverable to produce a document/file/report (it appears as a card). Real data only.",
      "- QUAND ON TE DEMANDE UN RAPPORT / UNE ANALYSE / UN LIVRABLE : NE demande PAS quoi faire, ne réponds PAS juste par du texte conversationnel. Fais l'analyse avec tes outils MAINTENANT et produis-la avec create_deliverable(kind=\"report\"). Pour un gros rapport, construis-le avec report_section puis finalise avec create_deliverable(kind=\"report\") sans content.",
      "- Ne pose une question de clarification QUE si c'est réellement impossible d'avancer.",
      "- ARTIFACTS : list_artifacts pour voir ce qui existe déjà, read_artifact pour le relire, update_artifact pour le corriger EN PLACE. Ne crée pas un deuxième document là où il faut modifier le premier.",
    ].join("\n"),
  });
  sections.push({ id: "toolbox", body: `Your tools (full schemas are provided separately):\n${capabilitySummary}` });

  return compileSystemPrompt(sections).system;
}

// ---------------------------------------------------------------------------
// The frontier — driving a mission
// ---------------------------------------------------------------------------

/** A task may start when every dependency is finished. `skipped` counts as
 *  finished (a dependency the orchestrator gave up on must not deadlock the
 *  rest); `failed` does NOT — the dependent work would be built on sand. */
/** A task claimed for this long with no run at all is a dispatch that never
 *  landed. Generous: a legitimate turn ticks for minutes. */
const ORPHAN_GRACE_MS = 20 * 60 * 1000;

/**
 * Close tasks whose run is already over.
 *
 * A task moves out of `in_progress` when its run's tick engine reports back.
 * Every terminal path in that engine does report — but a run can also die
 * OUTSIDE it: the edge worker is killed mid-turn and the SQL zombie reconciler
 * flips the run to `failed` from the database, where no TypeScript observes it.
 * The task then stays `in_progress` for ever, the frontier reads "something is
 * in flight", and the mission sits at "en cours" with nothing running — the
 * exact deadlock a human sees as "l'agent s'est arrêté".
 *
 * So the frontier verifies its own in-flight set on every pass: any task whose
 * run is terminal (or which never got a run) is closed here, with the room's
 * own reply as the result when there is one. Mutates `tasks` so the caller
 * continues on the healed shape.
 */
async function healOrphanedTasks(admin: Admin, missionId: string, tasks: TaskRow[]): Promise<boolean> {
  const inflight = tasks.filter((t) => ["in_progress", "waiting", "review"].includes(t.status));
  if (inflight.length === 0) return false;

  const runIds = inflight.map((t) => t.run_id).filter((id): id is string => !!id);
  const runById = new Map<string, { status: string; error_message: string | null }>();
  if (runIds.length > 0) {
    const { data } = await admin.from("internal_agent_runs")
      .select("id, status, error_message").in("id", runIds);
    for (const r of (data ?? []) as Array<{ id: string; status: string; error_message: string | null }>) {
      runById.set(r.id, { status: r.status, error_message: r.error_message });
    }
  }

  let healed = false;
  for (const t of inflight) {
    const run = t.run_id ? runById.get(t.run_id) : undefined;
    const missingRun = !t.run_id || (t.run_id && !run);
    const terminal = run && ["succeeded", "failed", "cancelled"].includes(run.status);
    if (!terminal && !missingRun) continue;
    // A task with no run row yet may simply have been claimed a second ago.
    if (missingRun) {
      const { data: fresh } = await admin.from("service_room_tasks")
        .select("started_at").eq("id", t.id).maybeSingle();
      const startedAt = (fresh as { started_at?: string | null } | null)?.started_at;
      if (!startedAt || Date.now() - +new Date(startedAt) < ORPHAN_GRACE_MS) continue;
    }

    // The agent may have answered in the room before its run was cut down; that
    // reply is the task's real result and must not be thrown away.
    const { data: msg } = await admin.from("service_room_messages")
      .select("content, status").eq("task_id", t.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const reply = ((msg as { content?: string } | null)?.content ?? "").trim();
    const replyFailed = (msg as { status?: string } | null)?.status === "failed";
    const ok = run?.status === "succeeded" && !replyFailed && reply.length > 0;

    const summary = ok
      ? condense(reply)
      : condense(reply || run?.error_message || "Le run de cette tâche s'est arrêté sans rendre de résultat (worker interrompu).");

    await admin.from("service_room_tasks").update({
      status: ok ? "done" : "failed",
      result_summary: summary,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", t.id);
    t.status = ok ? "done" : "failed";
    t.result_summary = summary;
    healed = true;

    await logMissionEvent(admin, missionId, {
      kind: ok ? "completed" : "failed", task_id: t.id, agent_id: t.agent_id,
      message: ok
        ? `« ${t.title} » récupérée : le run s'était terminé sans notifier la mission.`
        : `« ${t.title} » abandonnée : son run s'est arrêté (${run?.status ?? "run introuvable"}) sans rendre de résultat.`,
    });
  }
  return healed;
}

function isReady(t: TaskRow, byId: Map<string, TaskRow>): boolean {
  if (t.status !== "todo") return false;
  if (!t.agent_id) return false;
  return t.depends_on.every((d) => {
    const dep = byId.get(d);
    return !dep || dep.status === "done" || dep.status === "skipped";
  });
}

/**
 * Push the mission one step forward.
 *
 * Called when a mission is created and again every time one of its tasks
 * finishes. Idempotent by construction: it only ever dispatches tasks still in
 * `todo`, and flips them to `in_progress` as it goes, so a double delivery
 * cannot double-dispatch.
 */
export async function advanceRoomMission(admin: Admin, missionId: string): Promise<void> {
  const { data: missionRow } = await admin.from("service_room_missions")
    .select("id, room_id, dashboard_id, workspace_id, project_id, title, objective, status, orchestrator_agent_id")
    .eq("id", missionId).maybeSingle();
  if (!missionRow) return;
  const mission = missionRow as {
    id: string; room_id: string; dashboard_id: string; workspace_id: string; project_id: string;
    title: string; objective: string | null; status: string; orchestrator_agent_id: string | null;
  };
  // Only a HUMAN stop halts the frontier here. 'done'/'failed' must fall
  // through: the rollup trigger flips the mission the instant its last task
  // closes, so bailing on those statuses would swallow the closing report.
  // finishMission is idempotent, which is what makes that safe.
  if (["cancelled", "paused"].includes(mission.status)) return;

  const { data: roomRow } = await admin.from("service_rooms")
    .select("id, dashboard_id, workspace_id, project_id, title").eq("id", mission.room_id).maybeSingle();
  if (!roomRow) return;
  const room = roomRow as RoomRef;
  const { data: dash } = await admin.from("service_dashboards").select("name").eq("id", room.dashboard_id).maybeSingle();
  const dashboardName = (dash as { name?: string } | null)?.name ?? "workspace";

  const { data: taskRows } = await admin.from("service_room_tasks")
    .select("id, mission_id, milestone_id, agent_id, title, description, status, position, depends_on, run_id, result_summary")
    .eq("mission_id", missionId).order("position", { ascending: true });
  const tasks = (taskRows ?? []) as TaskRow[];
  if (tasks.length === 0) return;

  // Verify the in-flight set before trusting it — see healOrphanedTasks. Without
  // this, one killed worker freezes the mission permanently: the branch below
  // would report "en attente de 1 tâche en cours" on every pass, for ever.
  await healOrphanedTasks(admin, missionId, tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // ── Finished? Close it with the orchestrator's report ──────────────────────
  const open = tasks.filter((t) => !["done", "skipped", "failed"].includes(t.status));
  if (open.length === 0) {
    await finishMission(admin, room, mission, tasks, dashboardName);
    return;
  }

  // ── Dispatch the ready frontier ───────────────────────────────────────────
  const ready = tasks.filter((t) => isReady(t, byId));
  if (ready.length === 0) {
    const running = tasks.filter((t) => ["in_progress", "waiting", "review"].includes(t.status));
    if (running.length > 0) {
      // Normal pause: something is in flight and the rest depends on it.
      await logMissionEvent(admin, missionId, {
        kind: "waiting",
        message: `En attente de ${running.length} tâche(s) en cours avant de poursuivre : ${running.map((t) => t.title).join(", ")}.`,
      });
      return;
    }
    // Nothing running, nothing ready: everything left sits behind a FAILED
    // dependency, or a task has no assignee. A human orchestrator would not
    // give up here — it would look at what broke and route around it. So
    // before declaring the mission dead, REPLAN once.
    const replanned = await replanMission(admin, room, mission, tasks, dashboardName);
    if (replanned) {
      // The plan changed (a task was retried, reassigned or skipped) — re-enter
      // the frontier on the new shape.
      await advanceRoomMission(admin, missionId);
      return;
    }

    const stuck = tasks.filter((t) => t.status === "todo");
    for (const t of stuck) {
      await admin.from("service_room_tasks").update({ status: "blocked", updated_at: new Date().toISOString() }).eq("id", t.id);
    }
    await admin.from("service_room_missions").update({ status: "blocked", updated_at: new Date().toISOString() }).eq("id", missionId);
    await logMissionEvent(admin, missionId, {
      kind: "failed",
      message: stuck.some((t) => !t.agent_id)
        ? "Mission bloquée : une tâche n'a pas d'agent assigné."
        : "Mission bloquée : les tâches restantes dépendent d'une tâche en échec, et la replanification n'a rien trouvé.",
    });
    await postSystemMessage(admin, room, missionId,
      "⛔ Mission bloquée — les tâches restantes attendent un résultat qui n'arrivera pas, et je n'ai pas trouvé de contournement. Ouvrez la mission pour réassigner ou relancer.");
    return;
  }

  for (const t of ready) {
    // Claim it first: an update that changes 0 rows means another delivery got
    // there first, and we must not dispatch twice.
    const { data: claimed } = await admin.from("service_room_tasks")
      .update({ status: "in_progress", started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", t.id).eq("status", "todo").select("id").maybeSingle();
    if (!claimed) continue;

    const upstream = t.depends_on
      .map((d) => byId.get(d))
      .filter((d): d is TaskRow => Boolean(d?.result_summary))
      .map((d) => `### ${d.title} (par un autre agent)\n${d.result_summary}`)
      .join("\n\n");
    const context = [
      `Mission : ${mission.title}`,
      mission.objective ? `Objectif global : ${mission.objective}` : "",
      upstream ? `\nRésultats des tâches dont dépend la tienne — appuie-toi dessus, ne les refais pas :\n${upstream}` : "",
    ].filter(Boolean).join("\n");

    const sent = await dispatchRoomTurn(admin, {
      room, agentId: t.agent_id!, brief: t.description || t.title,
      context, missionId, taskId: t.id, dashboardName,
    });
    if (!sent) {
      await admin.from("service_room_tasks").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", t.id);
      await logMissionEvent(admin, missionId, { kind: "failed", task_id: t.id, message: `Impossible de lancer « ${t.title} ».` });
      continue;
    }
    await admin.from("service_room_tasks").update({ run_id: sent.runId, message_id: sent.messageId }).eq("id", t.id);
    await logMissionEvent(admin, missionId, {
      kind: "dispatched", task_id: t.id, agent_id: t.agent_id,
      message: `« ${t.title} » lancée.`, payload: { run_id: sent.runId },
    });
  }
  await admin.from("service_room_missions")
    .update({ status: "running", updated_at: new Date().toISOString() }).eq("id", missionId);
}

// ---------------------------------------------------------------------------
// Replanning — routing around a failure instead of dying on it
// ---------------------------------------------------------------------------

/** How many times one mission may be replanned. Two is enough to route around
 *  a bad task or a wrong assignee; past that the failure is structural and a
 *  human needs to look at it, not another LLM round. */
const MAX_REPLANS = 2;

interface ReplanAction {
  task_id: string;
  action: "retry" | "reassign" | "skip";
  /** For reassign: the NAME of the agent to hand it to. */
  agent?: string;
  /** For retry/reassign: a corrected brief that accounts for what went wrong. */
  brief?: string;
  reason?: string;
}

/**
 * The frontier stalled with work still open. Ask the orchestrator what to do
 * about the tasks that failed — the same decision a human lead makes when a
 * teammate comes back empty:
 *
 *   retry    — the brief was the problem; run it again with a better one.
 *   reassign — the agent was the problem; give it to someone else.
 *   skip     — it is not worth it; unblock whatever depended on it.
 *
 * Returns true when it actually changed something (the caller then re-enters
 * the frontier), false when the mission really is stuck.
 */
async function replanMission(
  admin: Admin, room: RoomRef,
  mission: { id: string; title: string; objective: string | null; orchestrator_agent_id: string | null },
  tasks: TaskRow[], dashboardName: string,
): Promise<boolean> {
  const { count } = await admin.from("service_room_mission_events")
    .select("id", { count: "exact", head: true })
    .eq("mission_id", mission.id).eq("kind", "replanned");
  if ((count ?? 0) >= MAX_REPLANS) return false;

  const failed = tasks.filter((t) => t.status === "failed");
  const blocked = tasks.filter((t) => t.status === "todo");
  // Nothing to route around, or nothing left that would benefit — a task with
  // no assignee is a planning bug the LLM can fix, so that counts too.
  if (failed.length === 0 && !blocked.some((t) => !t.agent_id)) return false;

  const { data: roster } = await admin.from("internal_agents")
    .select("id, name, role, persona, is_orchestrator")
    .eq("service_dashboard_id", room.dashboard_id).eq("is_archived", false);
  const team = ((roster ?? []) as RosterAgent[]).filter((a) => !a.is_orchestrator);
  const byName = new Map(team.map((a) => [a.name.toLowerCase(), a.id]));

  const system = [
    `Tu es l'assistant-chef d'orchestre du service « ${dashboardName} ». Une mission que tu as planifiée est bloquée.`,
    `Des tâches ont ÉCHOUÉ, et tout ce qui en dépendait attend un résultat qui n'arrivera pas.`,
    ``,
    `Pour CHAQUE tâche en échec, choisis UNE action :`,
    `- "retry" : le problème venait du BRIEF (trop vague, mauvaise cible, information manquante). Réécris-le dans "brief" en corrigeant précisément ce qui a manqué.`,
    `- "reassign" : le problème venait de l'EXÉCUTANT (pas les bonnes compétences/outils). Donne le NOM EXACT d'un autre agent dans "agent", et un brief adapté à lui.`,
    `- "skip" : cette tâche n'est pas indispensable au résultat. Ce qui en dépendait pourra continuer sans elle.`,
    ``,
    `AGENTS DISPONIBLES :`,
    team.length ? team.map(rosterCard).join("\n") : "(aucun autre agent)",
    ``,
    `Sois honnête : si relancer à l'identique ne changerait rien, choisis "skip" ou "reassign". Ne relance pas deux fois la même chose en espérant un autre résultat.`,
    ``,
    `JSON STRICT, sans prose ni fence : {"actions":[{"task_id":"","action":"retry|reassign|skip","agent":"","brief":"","reason":"une phrase"}]}`,
  ].join("\n");

  const digest = tasks.map((t) =>
    `- [${t.status}] id=${t.id} « ${t.title} »${t.agent_id ? "" : " (AUCUN AGENT ASSIGNÉ)"}` +
    `${t.description ? `\n  brief: ${t.description.slice(0, 300)}` : ""}` +
    `${t.result_summary ? `\n  résultat/erreur: ${t.result_summary.slice(0, 400)}` : ""}`,
  ).join("\n");

  let actions: ReplanAction[] = [];
  try {
    const res = await callAi({
      task: "classification", provider: cheapProvider(), jsonMode: true,
      maxTokens: 1400, temperature: 0.2, systemPrompt: system,
      userPrompt: `# Mission\n${mission.title}${mission.objective ? `\n${mission.objective}` : ""}\n\n# État des tâches\n${digest}`,
    });
    actions = safeParseJson<{ actions?: ReplanAction[] }>(res.content)?.actions ?? [];
  } catch {
    return false;
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  let changed = 0;
  for (const a of actions.slice(0, 8)) {
    const task = byId.get(str(a?.task_id));
    // Only tasks that are actually stuck may be rewritten — a replan must never
    // reopen work that succeeded.
    if (!task || !["failed", "todo"].includes(task.status)) continue;
    const action = str(a?.action);
    const brief = str(a?.brief).trim().slice(0, 4000);

    if (action === "skip") {
      await admin.from("service_room_tasks")
        .update({ status: "skipped", result_summary: `Abandonnée à la replanification : ${str(a?.reason) || "non indispensable"}.`, updated_at: new Date().toISOString() })
        .eq("id", task.id);
      changed++;
      continue;
    }
    if (action === "reassign") {
      const wanted = str(a?.agent).trim().toLowerCase();
      const newId = byName.get(wanted) ?? [...byName.entries()].find(([n]) => wanted && n.includes(wanted))?.[1];
      // An unknown name would silently produce an unassignable task — treat it
      // as a plain retry on the current assignee instead.
      if (newId && newId !== task.agent_id) {
        await admin.from("service_room_tasks").update({
          agent_id: newId, status: "todo", run_id: null, message_id: null,
          description: brief || task.description, updated_at: new Date().toISOString(),
        }).eq("id", task.id);
        changed++;
        continue;
      }
    }
    // retry (and reassign fallbacks): back to todo with the corrected brief. A
    // retry with an IDENTICAL brief is refused — that is the loop we are here
    // to avoid.
    if (!brief || brief === (task.description ?? "")) continue;
    await admin.from("service_room_tasks").update({
      status: "todo", run_id: null, message_id: null,
      description: brief, updated_at: new Date().toISOString(),
    }).eq("id", task.id);
    changed++;
  }

  if (changed === 0) return false;

  const summary = actions.slice(0, 8)
    .map((a) => `${str(a?.action)} « ${byId.get(str(a?.task_id))?.title ?? "?"} »${a?.reason ? ` — ${str(a.reason)}` : ""}`)
    .join(" · ");
  await logMissionEvent(admin, mission.id, {
    kind: "replanned",
    message: `Replanification après échec : ${changed} tâche(s) ajustée(s). ${summary}`.slice(0, 900),
    payload: { actions },
  });
  await admin.from("service_room_missions")
    .update({ status: "running", updated_at: new Date().toISOString() }).eq("id", mission.id);
  await postSystemMessage(admin, room, mission.id,
    `🔄 Une étape a échoué — j'ai réorganisé la suite plutôt que d'arrêter la mission : ${summary}`.slice(0, 900));
  return true;
}

/**
 * A mission task's run just finished. Record the result, write it to the shared
 * team memory so the knowledge outlives the mission, then re-enter the frontier
 * — which is what makes the next agent start.
 */
export async function completeMissionTask(admin: Admin, opts: {
  missionId: string;
  taskId: string;
  ok: boolean;
  output: string;
}): Promise<void> {
  const { data: taskRow } = await admin.from("service_room_tasks")
    .select("id, mission_id, title, agent_id, status, run_id").eq("id", opts.taskId).maybeSingle();
  if (!taskRow) return;
  const task = taskRow as { id: string; mission_id: string; title: string; agent_id: string | null; status: string; run_id: string | null };
  if (["done", "failed", "skipped"].includes(task.status)) return; // already reconciled

  // Stamp the summary with what the run actually persisted. The summary is the
  // agent's own prose — "j'ai produit le rapport" costs it nothing to write —
  // and it is what every downstream task and the closing report read. Recording
  // the real inventory next to it is what keeps the claim checkable.
  const { data: produced } = task.run_id
    ? await admin.from("internal_agent_deliverables").select("name, kind").eq("run_id", task.run_id)
    : { data: [] as Array<{ name: string; kind: string }> };
  const madeList = (produced ?? []) as Array<{ name: string; kind: string }>;
  const inventory = madeList.length
    ? `\n\n[Livrables enregistrés : ${madeList.map((d) => `« ${d.name} » (${d.kind})`).join(", ")}]`
    : "\n\n[Aucun livrable enregistré par cette tâche.]";
  const summary = condense(opts.output) + inventory;
  await admin.from("service_room_tasks").update({
    status: opts.ok ? "done" : "failed",
    result_summary: summary,
    finished_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", opts.taskId);

  await logMissionEvent(admin, opts.missionId, {
    kind: opts.ok ? "completed" : "failed", task_id: opts.taskId, agent_id: task.agent_id,
    message: opts.ok ? `« ${task.title} » terminée.` : `« ${task.title} » a échoué.`,
  });

  // The result becomes shared knowledge, not just a transcript line: the next
  // agents read the team memory, and the mission's findings should survive it.
  if (opts.ok && summary.length > 40) {
    const { data: mission } = await admin.from("service_room_missions")
      .select("workspace_id, project_id, title").eq("id", opts.missionId).maybeSingle();
    const m = mission as { workspace_id: string; project_id: string; title: string } | null;
    if (m) {
      await admin.from("internal_agent_team_memories").insert({
        workspace_id: m.workspace_id, project_id: m.project_id,
        author_agent: task.agent_id, source: "agent",
        // 'context' is the closest allowed kind: this is what the NEXT agents
        // need to know, not a durable fact about the world.
        kind: "context", importance: 3,
        content: `[Mission « ${m.title} » / ${task.title}] ${summary.slice(0, 900)}`,
      }).then(() => {}, () => {});
      await logMissionEvent(admin, opts.missionId, {
        kind: "memorised", task_id: opts.taskId,
        message: `Résultat de « ${task.title} » enregistré dans la mémoire d'équipe.`,
      });
    }
  }

  await advanceRoomMission(admin, opts.missionId);
}

/** Keep the head and the tail: an agent's report states its subject first and
 *  its conclusions last, so a head-only cut loses the answer. */
function condense(text: string): string {
  const clean = (text ?? "").replace(/\[\[ui:\d+\]\]/g, "").trim();
  if (clean.length <= 1400) return clean;
  return `${clean.slice(0, 900)}\n…\n${clean.slice(-400)}`;
}

async function finishMission(
  admin: Admin, room: RoomRef,
  mission: { id: string; title: string; objective: string | null; orchestrator_agent_id: string | null },
  tasks: TaskRow[], dashboardName: string,
): Promise<void> {
  // Idempotence: several tasks can finish within the same second, each
  // re-entering the frontier. The 'finished' event is the claim — without it
  // the room would get one closing report per straggler.
  const { data: already } = await admin.from("service_room_mission_events")
    .select("id").eq("mission_id", mission.id).eq("kind", "finished").limit(1);
  if (already && already.length > 0) return;

  const done = tasks.filter((t) => t.status === "done");
  const failed = tasks.filter((t) => t.status === "failed");
  await admin.from("service_room_missions").update({
    status: failed.length && !done.length ? "failed" : "done",
    completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", mission.id);
  await logMissionEvent(admin, mission.id, {
    kind: "finished", message: `Mission terminée : ${done.length} tâche(s) réussie(s), ${failed.length} en échec.`,
  });

  // The orchestrator writes the closing report itself, from the task results —
  // it is the only participant that saw the whole mission.
  if (!mission.orchestrator_agent_id) return;
  const digest = tasks.map((t) =>
    `- [${t.status}] ${t.title}${t.result_summary ? `\n  ${t.result_summary.replace(/\n/g, "\n  ").slice(0, 900)}` : ""}`,
  ).join("\n");

  // Ground the report in what was ACTUALLY persisted. A task summary is the
  // agent's own prose, and an agent that says "j'ai produit le rapport" without
  // having called create_deliverable would otherwise see that claim copied
  // verbatim into the closing report — the human then looks for a file that
  // does not exist. The list below is the record, not a claim.
  const runIds = tasks.map((t) => t.run_id).filter((id): id is string => !!id);
  const { data: delivRows } = runIds.length
    ? await admin.from("internal_agent_deliverables")
        .select("name, kind, created_at").in("run_id", runIds).order("created_at", { ascending: true })
    : { data: [] as Array<{ name: string; kind: string }> };
  const delivs = (delivRows ?? []) as Array<{ name: string; kind: string }>;
  const inventory = delivs.length
    ? delivs.map((d) => `- « ${d.name} » (${d.kind})`).join("\n")
    : "(aucun)";

  await dispatchRoomTurn(admin, {
    room, agentId: mission.orchestrator_agent_id, missionId: mission.id, dashboardName,
    brief: [
      `La mission « ${mission.title} » est terminée. Rédige le compte rendu final pour la room.`,
      `Structure : ce qui a été accompli, les résultats clés (chiffres/faits concrets tirés des tâches), ce qui reste ouvert ou a échoué, et la prochaine action recommandée.`,
      `Sois factuel : n'invente rien qui ne soit pas dans les résultats ci-dessus.`,
      `RÈGLE STRICTE sur les livrables : la seule liste qui fait foi est « Livrables réellement enregistrés » ci-dessous.`,
      delivs.length
        ? `Ne cite QUE ces livrables. Si un résumé de tâche en annonce un autre, écris explicitement qu'il n'a pas été enregistré.`
        : `Aucun livrable n'existe : ne dis PAS qu'un rapport a été produit. Si le contenu est là, produis-le maintenant toi-même avec create_deliverable ; sinon dis clairement qu'il manque.`,
    ].join("\n"),
    context: [
      mission.objective ? `Objectif : ${mission.objective}` : "",
      `\nRésultats des tâches :\n${digest}`,
      `\nLivrables réellement enregistrés :\n${inventory}`,
    ].filter(Boolean).join("\n"),
  });
}

export async function postSystemMessage(
  admin: Admin, room: RoomRef, missionId: string | null, content: string,
): Promise<void> {
  await admin.from("service_room_messages").insert({
    room_id: room.id, workspace_id: room.workspace_id, project_id: room.project_id,
    author_kind: "system", content, status: "done", mission_id: missionId,
  }).then(() => {}, () => {});
  await admin.from("service_rooms").update({ updated_at: new Date().toISOString() }).eq("id", room.id);
}
