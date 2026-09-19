// service-room-post — multi-agent room turn. The human posts into a shared room
// thread; the mentioned agent(s) (or the room's default responder) each reply,
// seeing the whole thread. Reuses the shared agent toolset (create_deliverable,
// render_ui, create_agent, create_mission, web/data/memory…). Runs in the
// background (EdgeRuntime.waitUntil) so long turns don't 504; the client polls
// service_room_messages.
import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { type ChatMessage } from "../_shared/ai.ts";
import { type InternalToolContext, type AgentToolRow, type ArtifactDraft } from "../_shared/internal-agent-tools.ts";
import { runParallelSubagents } from "../_shared/subagents.ts";
import { classifyTier, modelForTier, resolveProvider } from "../_shared/model-router.ts";
import {
  routeTurn, ensureAgents, createMission, createEmptyMission, advanceRoomMission, logMissionEvent,
  buildRoomSystemPrompt, postSystemMessage,
  type RoomRef, type RosterAgent,
} from "../_shared/room-orchestrator.ts";
import { insertArtifact, generateArtifactImage, isDocKind } from "../_shared/artifact-content.ts";
import {
  loadCompanyContext, renderCompanySection, type CompanyContext,
} from "../_shared/company-context.ts";

type Admin = ReturnType<typeof createServiceClient>;
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

// create_artifact, room flow: office_documents for document/presentation/
// spreadsheet (tagged with service_room_id so the Artifacts tab can scope
// "in this room"), office-ai media.generate for images, and a table-less
// inline block for plain text. Always pushes an `artifact` ui block.
//
// The parsing and persistence themselves live in _shared/artifact-content.ts:
// the room flow and the plain-chat flow must build the SAME artifact from the
// same agent text, and they used to drift (the chat flow dropped images and
// stored raw, unparsed lines).
async function createRoomArtifact(
  admin: Admin,
  room: { id: string; workspace_id: string; project_id: string },
  createdBy: string | null,
  artifact: ArtifactDraft,
  uiBlocks: Array<Record<string, unknown>>,
): Promise<void> {
  const scope = {
    workspaceId: room.workspace_id, projectId: room.project_id,
    roomId: room.id, createdBy,
  };

  if (artifact.kind === "image") {
    const mediaId = await generateArtifactImage(admin, artifact.content, scope);
    uiBlocks.push(mediaId
      ? { component: "artifact", props: { id: mediaId, table: "office_media", kind: "image", title: artifact.title } }
      : { component: "artifact", props: { table: "text", kind: "text", title: artifact.title, content: "Image generation failed or is not configured." } });
    return;
  }

  if (!isDocKind(artifact.kind)) {
    uiBlocks.push({ component: "artifact", props: { table: "text", kind: "text", title: artifact.title, content: artifact.content } });
    return;
  }

  const id = await insertArtifact(admin, artifact.kind, artifact.title, artifact.content, scope);
  uiBlocks.push(id
    ? { component: "artifact", props: { id, table: "office_documents", kind: artifact.kind, title: artifact.title } }
    : { component: "artifact", props: { table: "text", kind: "text", title: artifact.title, content: `Failed to create ${artifact.kind}.` } });
}

interface AgentRow {
  id: string; name: string; persona: string | null; instructions: string | null;
  /** The other two files (0210) — see agent-context.ts. */
  soul?: string | null; preferences?: string | null;
  model: string | null;
  temperature: number | null; is_orchestrator: boolean | null;
  service_dashboard_id: string | null; created_by: string | null;
  swarm_enabled: boolean | null; swarm_max_concurrency: number | null;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const { data: u } = await createUserClient(auth).auth.getUser();
    if (!u.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
    const userId = u.user.id;

    const body = await req.json().catch(() => ({}));

    // Human override on the mission board (reassign, move a card back to "à
    // faire", resume a paused mission) → re-enter the orchestrator's frontier.
    // Folded in here rather than shipped as its own edge function: the project
    // is two slots from Supabase's 100-function ceiling.
    if (str(body.op) === "advance_mission") {
      const missionId = str(body.mission_id);
      if (!missionId) return jsonResponse({ error: "mission_id required" }, { status: 400 });
      const admin = createServiceClient();
      const { data: m } = await admin.from("service_room_missions")
        .select("id, workspace_id").eq("id", missionId).maybeSingle();
      if (!m) return jsonResponse({ error: "Mission not found" }, { status: 404 });
      const { data: mem } = await admin.from("workspace_members").select("role")
        .eq("workspace_id", (m as { workspace_id: string }).workspace_id).eq("user_id", userId).maybeSingle();
      if (!mem) return jsonResponse({ error: "Not authorized" }, { status: 403 });
      const er0 = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      const job = advanceRoomMission(admin, missionId);
      if (er0?.waitUntil) er0.waitUntil(job); else await job;
      return jsonResponse({ ok: true });
    }

    // Create a mission from the board's "Nouvelle mission" form, without going
    // through a conversation. Two modes: "auto" hands the brief to the
    // assistant to decompose and starts it, "empty" creates the shell so the
    // human can author the cards themselves.
    if (str(body.op) === "create_mission") {
      const admin = createServiceClient();
      const created = await createMissionFromForm(admin, {
        roomId: str(body.room_id),
        title: str(body.title).trim(),
        objective: str(body.objective).trim(),
        mode: str(body.mode) === "empty" ? "empty" : "auto",
        userId,
      });
      if ("error" in created) return jsonResponse({ error: created.error }, { status: created.status });
      return jsonResponse({ ok: true, mission_id: created.missionId });
    }

    const roomId = str(body.room_id);
    const content = str(body.content).trim();
    const mentions: string[] = Array.isArray(body.mention_agent_ids) ? body.mention_agent_ids.map(String) : [];
    const attachmentMediaId = str(body.attachment_media_id);
    if (!roomId || !content) return jsonResponse({ error: "room_id and content required" }, { status: 400 });

    const admin = createServiceClient();
    const { data: room } = await admin.from("service_rooms").select("id, dashboard_id, workspace_id, project_id, title").eq("id", roomId).maybeSingle();
    if (!room) return jsonResponse({ error: "Room not found" }, { status: 404 });
    const { data: member } = await admin.from("workspace_members").select("role").eq("workspace_id", room.workspace_id).eq("user_id", userId).maybeSingle();
    if (!member) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    // Participants + dashboard name (for the agents' context).
    const { data: parts } = await admin.from("service_room_agents").select("agent_id").eq("room_id", roomId);
    const participantIds = (parts ?? []).map((p: { agent_id: string }) => p.agent_id);
    const { data: dash } = await admin.from("service_dashboards").select("name, settings").eq("id", room.dashboard_id).maybeSingle();
    const dashboardName = dash?.name ?? "workspace";
    // Settings → Rooms (migration 0158) can name an agent other than the
    // orchestrator as the service's default responder.
    const roomSettings = ((dash?.settings ?? {}) as { rooms?: { default_responder_agent_id?: string | null } }).rooms;
    const defaultResponder = roomSettings?.default_responder_agent_id ?? null;

    // A follow-up typed while a mission is open belongs to that mission — the
    // client passes it so the message lands under the right badge.
    const explicitMissionId = str(body.mission_id) || null;

    // Post the human message — with an attached image (uploaded client-side
    // into office_media) shown as an artifact card on the user's own message.
    const { data: postedUserMsg } = await admin.from("service_room_messages").insert({
      room_id: roomId, workspace_id: room.workspace_id, project_id: room.project_id,
      author_kind: "user", user_id: userId, content, status: "done",
      mission_id: explicitMissionId,
      ui_blocks: attachmentMediaId
        ? [{ component: "artifact", props: { id: attachmentMediaId, table: "office_media", kind: "image", title: "Image" } }]
        : null,
    }).select("id").single();
    const userMessageId = (postedUserMsg as { id: string } | null)?.id ?? null;
    await admin.from("service_rooms").update({ updated_at: new Date().toISOString() }).eq("id", roomId);

    // Who replies: explicitly-mentioned participants, else the dashboard's
    // configured default responder, else the orchestrator, else the first
    // participant. Cap concurrent responders.
    let responders = mentions.filter((id) => participantIds.includes(id));
    const explicitlyAddressed = responders.length > 0;
    if (responders.length === 0 && participantIds.length) {
      if (defaultResponder && participantIds.includes(defaultResponder)) {
        responders = [defaultResponder];
      } else {
        const { data: orch } = await admin.from("internal_agents").select("id").in("id", participantIds).eq("is_orchestrator", true).limit(1).maybeSingle();
        responders = [orch?.id ?? participantIds[0]];
      }
    }
    responders = responders.slice(0, 3);
    if (responders.length === 0) return jsonResponse({ ok: true, responders: [] });

    const roomRef: RoomRef = {
      id: room.id, dashboard_id: room.dashboard_id,
      workspace_id: room.workspace_id, project_id: room.project_id, title: room.title,
    };

    // ── Orchestration ────────────────────────────────────────────────────────
    // An UNADDRESSED turn goes through the room's assistant, which decides what
    // this is: something it answers itself, something one specialist should own,
    // or real multi-agent work worth a mission. An @mention is the human taking
    // that decision back — it is always obeyed verbatim.
    if (!explicitlyAddressed) {
      const { data: orchRow } = await admin.from("internal_agents")
        .select("id, name, persona, instructions, role, is_orchestrator, created_by, service_dashboard_id, swarm_enabled, swarm_max_concurrency")
        .in("id", participantIds).eq("is_orchestrator", true).limit(1).maybeSingle();
      if (orchRow) {
        const routed = await orchestrateTurn(admin, {
          room: roomRef, dashboardName,
          assistant: orchRow as RosterAgent,
          participantIds, userId, userText: content, userMessageId,
        }).catch((e) => {
          // Routing is an OPTIMISATION, never a gate: on any failure the turn
          // falls through to the plain responder path below.
          console.error("room routing failed", e);
          return null;
        });
        if (routed?.handled) return jsonResponse({ ok: true, ...routed.result });
        if (routed?.responder) responders = [routed.responder];
      }
    }

    // Insert a "thinking" placeholder per responder so the UI shows them typing.
    const placeholders: Record<string, string> = {};
    for (const aid of responders) {
      const { data: ph } = await admin.from("service_room_messages").insert({
        room_id: roomId, workspace_id: room.workspace_id, project_id: room.project_id,
        author_kind: "agent", agent_id: aid, content: "", status: "thinking",
        mission_id: explicitMissionId,
      }).select("id").single();
      if (ph) placeholders[aid] = (ph as { id: string }).id;
    }

    const work = async () => {
      for (const aid of responders) {
        try {
          await runResponder(admin, room, dashboardName, aid, placeholders[aid], participantIds, explicitMissionId);
        } catch (e) {
          await admin.from("service_room_messages").update({
            status: "failed", content: `⚠️ ${e instanceof Error ? e.message : "erreur"}`,
          }).eq("id", placeholders[aid]);
        }
      }
    };
    const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
    if (er?.waitUntil) er.waitUntil(work());
    else await work();

    return jsonResponse({ ok: true, responders });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Erreur serveur" }, { status: 500 });
  }
});

/**
 * Create a mission from the board form.
 *
 * "auto" is the interesting path: the brief goes to the same planner the room
 * uses, so a mission authored from the board and one born in a conversation are
 * the same object, planned the same way, driven by the same frontier. "empty"
 * exists because a human who already knows the plan should not have to argue
 * with a planner to get it on the board.
 */
async function createMissionFromForm(admin: Admin, opts: {
  roomId: string; title: string; objective: string; mode: "auto" | "empty"; userId: string;
}): Promise<{ missionId: string } | { error: string; status: number }> {
  if (!opts.roomId || !opts.title) return { error: "room_id et title requis", status: 400 };

  const { data: roomRow } = await admin.from("service_rooms")
    .select("id, dashboard_id, workspace_id, project_id, title").eq("id", opts.roomId).maybeSingle();
  if (!roomRow) return { error: "Room introuvable", status: 404 };
  const room = roomRow as RoomRef;
  const { data: mem } = await admin.from("workspace_members").select("role")
    .eq("workspace_id", room.workspace_id).eq("user_id", opts.userId).maybeSingle();
  if (!mem) return { error: "Non autorisé", status: 403 };

  const { data: parts } = await admin.from("service_room_agents").select("agent_id").eq("room_id", room.id);
  const participantIds = (parts ?? []).map((p: { agent_id: string }) => p.agent_id);
  const { data: rosterRows } = await admin.from("internal_agents")
    .select("id, name, persona, instructions, role, is_orchestrator, created_by, service_dashboard_id")
    .in("id", participantIds.length ? participantIds : ["00000000-0000-0000-0000-000000000000"]);
  const roster = (rosterRows ?? []) as RosterAgent[];
  const assistant = roster.find((a) => a.is_orchestrator) ?? null;

  if (opts.mode === "empty" || !assistant) {
    const id = await createEmptyMission(admin, room, assistant, { title: opts.title, objective: opts.objective }, opts.userId);
    if (!id) return { error: "Création impossible", status: 500 };
    return { missionId: id };
  }

  const { data: dash } = await admin.from("service_dashboards").select("name").eq("id", room.dashboard_id).maybeSingle();
  const decision = await routeTurn({
    room, dashboardName: (dash as { name?: string } | null)?.name ?? "workspace",
    assistant, roster, thread: [], openMissions: [], forceMission: true,
    userText: [opts.title, opts.objective].filter(Boolean).join("\n\n"),
  });

  // A planner that came back empty must not lose the user's brief — fall back
  // to the shell so the mission still exists and can be authored by hand.
  if (decision.mode !== "mission" || !decision.mission) {
    const id = await createEmptyMission(admin, room, assistant, { title: opts.title, objective: opts.objective }, opts.userId);
    if (!id) return { error: "Planification impossible", status: 500 };
    return { missionId: id };
  }

  const idByName = new Map(roster.map((a) => [a.name, a.id]));
  if (decision.new_agents?.length) {
    const created = await ensureAgents(admin, room, decision.new_agents, assistant.created_by ?? opts.userId);
    for (const [name, id] of created) idByName.set(name, id);
  }
  for (const t of decision.mission.tasks) if (!idByName.has(t.agent)) t.agent = assistant.name;
  idByName.set(assistant.name, assistant.id);

  // The form's own wording wins over the planner's paraphrase — the user wrote
  // that title on purpose.
  decision.mission.title = opts.title;
  if (opts.objective) decision.mission.objective = opts.objective;

  const missionId = await createMission(admin, room, assistant, decision.mission, idByName, opts.userId);
  if (!missionId) return { error: "Création impossible", status: 500 };

  await logMissionEvent(admin, missionId, {
    kind: "routed", agent_id: assistant.id,
    message: decision.reason, payload: { source: "form" },
  });
  await postSystemMessage(admin, room, missionId, [
    `🎯 **${decision.mission.title}** — mission créée depuis le tableau.`,
    `${decision.mission.milestones.length} jalon(s), ${decision.mission.tasks.length} tâche(s).`,
  ].join("\n\n"));

  const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  const job = advanceRoomMission(admin, missionId);
  if (er?.waitUntil) er.waitUntil(job); else await job;
  return { missionId };
}

/**
 * Run the assistant's routing decision for one unaddressed turn.
 *
 * Returns `{ handled: true }` when the turn is fully taken care of here (a
 * mission was planned and its first agents are already working), or a
 * `responder` override when the turn should be answered by a specific agent —
 * either the one the assistant picked, or one it just created for the purpose.
 * Returning nothing means "let the default responder handle it".
 */
async function orchestrateTurn(admin: Admin, opts: {
  room: RoomRef;
  dashboardName: string;
  assistant: RosterAgent;
  participantIds: string[];
  userId: string;
  userText: string;
  /** The message that triggered the turn — stamped with the mission it spawned. */
  userMessageId: string | null;
}): Promise<{ handled: boolean; responder?: string; result?: Record<string, unknown> } | null> {
  const { room, assistant } = opts;

  const [{ data: rosterRows }, { data: threadRows }, { data: openRows }] = await Promise.all([
    admin.from("internal_agents")
      .select("id, name, persona, instructions, role, is_orchestrator")
      .in("id", opts.participantIds.length ? opts.participantIds : [assistant.id]),
    admin.from("service_room_messages")
      .select("author_kind, agent_id, content").eq("room_id", room.id).eq("status", "done")
      .order("created_at", { ascending: false }).limit(14),
    admin.from("service_room_missions")
      .select("id, title").eq("room_id", room.id).in("status", ["planning", "running", "blocked"]).limit(6),
  ]);
  const roster = (rosterRows ?? []) as RosterAgent[];
  const nameById = new Map(roster.map((a) => [a.id, a.name]));
  const thread = ((threadRows ?? []) as Array<{ author_kind: string; agent_id: string | null; content: string }>)
    .reverse()
    .filter((m) => m.content?.trim())
    .map((m) => ({
      who: m.author_kind === "user" ? "Utilisateur" : m.author_kind === "system" ? "Système" : (nameById.get(m.agent_id ?? "") ?? "Agent"),
      text: m.content,
    }));

  const decision = await routeTurn({
    room, dashboardName: opts.dashboardName, assistant, roster, thread,
    userText: opts.userText,
    openMissions: (openRows ?? []) as Array<{ id: string; title: string }>,
  });

  // Staffing first: an agent named by the plan must exist before anything is
  // routed to it.
  const idByName = new Map(roster.map((a) => [a.name, a.id]));
  if (decision.new_agents?.length) {
    const created = await ensureAgents(admin, room, decision.new_agents, assistant.created_by ?? opts.userId);
    for (const [name, id] of created) idByName.set(name, id);
    if (created.size) {
      await postSystemMessage(admin, room, null,
        `🤖 ${[...created.keys()].map((n) => `« ${n} »`).join(", ")} ${created.size > 1 ? "créés et ajoutés" : "créé et ajouté"} à la room par ${assistant.name}.`);
    }
  }

  if (decision.mode === "route" && decision.agent) {
    const target = idByName.get(decision.agent);
    if (!target) return null;
    if (target !== assistant.id) {
      await postSystemMessage(admin, room, null, `↪️ ${assistant.name} confie ce point à @${decision.agent} — ${decision.reason}`);
    }
    return { handled: false, responder: target };
  }

  if (decision.mode !== "mission" || !decision.mission) return null;

  // Any task pointing at an agent that neither existed nor could be created
  // falls back to the assistant, which can at least do it or say why not.
  for (const t of decision.mission.tasks) {
    if (!idByName.has(t.agent)) t.agent = assistant.name;
  }
  idByName.set(assistant.name, assistant.id);

  const missionId = await createMission(
    admin, room, assistant, decision.mission, idByName, assistant.created_by ?? opts.userId,
  );
  if (!missionId) return null;

  // The request that started it carries the badge too, so the thread reads as
  // one continuous story rather than starting at the assistant's announcement.
  if (opts.userMessageId) {
    await admin.from("service_room_messages").update({ mission_id: missionId }).eq("id", opts.userMessageId).then(() => {}, () => {});
  }
  await logMissionEvent(admin, missionId, {
    kind: "routed", agent_id: assistant.id,
    message: decision.reason, payload: { mode: "mission" },
  });
  const byAgent = new Map<string, number>();
  for (const t of decision.mission.tasks) byAgent.set(t.agent, (byAgent.get(t.agent) ?? 0) + 1);
  await postSystemMessage(admin, room, missionId, [
    `🎯 **${decision.mission.title}** — mission créée par ${assistant.name}.`,
    decision.reason,
    `${decision.mission.milestones.length} jalon(s), ${decision.mission.tasks.length} tâche(s) — ${[...byAgent].map(([n, c]) => `@${n} (${c})`).join(", ")}.`,
    `Suivez-la dans l'onglet **Missions**.`,
  ].join("\n\n"));

  // Dispatch the ready frontier. Everything after this is driven by task
  // completions re-entering the orchestrator from the tick engine.
  await advanceRoomMission(admin, missionId);
  return { handled: true, result: { mission_id: missionId, mode: "mission" } };
}

async function runResponder(
  admin: Admin, room: { id: string; workspace_id: string; project_id: string; title: string; dashboard_id: string },
  dashboardName: string, agentId: string, placeholderId: string, participantIds: string[],
  missionId: string | null = null,
) {
  const { data: agent } = await admin.from("internal_agents")
    .select("id, name, persona, instructions, soul, preferences, model, temperature, is_orchestrator, service_dashboard_id, created_by, swarm_enabled, swarm_max_concurrency")
    .eq("id", agentId).maybeSingle();
  if (!agent) throw new Error("Agent introuvable");
  const a = agent as AgentRow;
  // Each agent answers on ITS OWN provider — a room turn is the same agent as
  // its direct chat, and must not silently run on a different vendor.
  const agentProvider = resolveProvider(a.model);
  const { data: toolRows } = await admin.from("internal_agent_tools")
    .select("id, kind, name, description, config, enabled, requires_approval").eq("agent_id", agentId);

  // Create the turn run UP-FRONT (not lazily) so the UI can show this agent's
  // LIVE activity — click the working agent → floating drawer with its timeline,
  // sub-agents and deliverables. The placeholder message points at it; steps are
  // streamed to run_events; a killed turn is reconciled by cron.
  const { data: tr } = await admin.from("internal_agent_runs").insert({
    agent_id: a.id, workspace_id: room.workspace_id, project_id: room.project_id,
    run_kind: "primary", status: "running", started_at: new Date().toISOString(),
    triggered_by: a.created_by ?? null,
  }).select("id").single();
  const turnRunId: string | null = (tr as { id: string } | null)?.id ?? null;
  if (turnRunId) await admin.from("service_room_messages").update({ run_id: turnRunId }).eq("id", placeholderId);
  const logRunEvent = (kind: string, payload: Record<string, unknown>) =>
    turnRunId
      ? admin.from("internal_agent_run_events").insert({ run_id: turnRunId, agent_id: a.id, kind, payload }).then(() => {}, () => {})
      : Promise.resolve();

  // Room-scoped tool context (cloud-ish: no sandbox). Captures render_ui blocks
  // and created deliverables so we can attach them to the agent's room message.
  const uiBlocks: Array<Record<string, unknown>> = [];
  const ctx: InternalToolContext = {
    admin, workspaceId: room.workspace_id, projectId: room.project_id,
    agentId: a.id, agentName: a.name,
    collaborationEnabled: true, autopilot: false, runId: turnRunId,
    missionMode: false, delegationDepth: 0,
    serviceDashboardId: a.service_dashboard_id ?? room.dashboard_id,
    serviceRoomId: room.id,
    userId: a.created_by ?? null,
    createDeliverable: async (d) => {
      const { data } = await admin.from("internal_agent_deliverables").insert({
        agent_id: a.id, run_id: turnRunId, kind: d.kind, name: d.name, content: d.content, summary: d.summary,
      }).select("id").single();
      uiBlocks.push({ component: "deliverable", props: { id: (data as { id: string } | null)?.id, name: d.name, kind: d.kind, agentId: a.id } });
      await logRunEvent("status", { message: `Livrable créé : ${d.name}` });
    },
    createArtifact: (artifact: ArtifactDraft) => createRoomArtifact(admin, room, a.created_by, artifact, uiBlocks),
    requestApproval: async () => "approval-skipped-in-room",
    // deno-lint-ignore no-explicit-any
    logEvent: (async (kind: string, payload: any) => {
      if (kind === "ui" && payload?.block) uiBlocks.push(payload.block);
      else await logRunEvent(kind, payload ?? {});
    }) as InternalToolContext["logEvent"],
    isCancelled: async () => false,
  };

  // Parallel sub-agents: a room turn can fan INDEPENDENT subtasks out to
  // ephemeral sub-agents (same shared engine as the agent chat). They attach to
  // the turn run created above, so the UI renders the instance cards.
  // Essaim: only expose the fan-out when the owner left it on. The tool is
  // registered from ctx.swarmEnabled below, so keep the two in sync.
  ctx.swarmEnabled = a.swarm_enabled !== false;
  // Mémoïsé : lu seulement si un fan-out a effectivement lieu.
  let childCompany: Promise<CompanyContext | null> | null = null;
  if (ctx.swarmEnabled && turnRunId) ctx.spawnParallel = async (subtasks) => {
    return await runParallelSubagents({
      admin, parentRunId: turnRunId,
      agentId: a.id, workspaceId: room.workspace_id, projectId: room.project_id, createdBy: a.created_by ?? null,
      tools: (toolRows ?? []) as AgentToolRow[], provider: agentProvider, temperature: a.temperature ?? 0.4,
      makeChildContext: (childRunId) => ({ ...ctx, runId: childRunId, isSubagent: true, spawnParallel: undefined }),
      // Un sous-agent de room hérite de l'employeur comme le ferait un
      // sous-agent de mission : le ton et les non-négociables de l'entreprise
      // s'appliquent à ce qu'il produit. Chargé au premier enfant, partagé
      // ensuite — une vague de huit ne paie qu'une lecture.
      buildChildSystem: async (cap) => {
        const comp = renderCompanySection(
          await (childCompany ??= loadCompanyContext(admin, room.project_id, {
            agentId: a.id, dashboardId: a.service_dashboard_id ?? room.dashboard_id,
          })),
          "", 900,
        );
        return [
          `You are ${a.name}${a.persona ? ` — ${a.persona}` : ""}, focused on a single subtask for the "${room.title}" room.`,
          comp.body ? `## L'entreprise pour laquelle tu travailles\n${comp.body}` : "",
          a.instructions ? `Your instructions:\n${a.instructions}` : "",
          "Your tools:", cap,
        ].filter(Boolean).join("\n");
      },
      maxConcurrency: a.swarm_max_concurrency ?? undefined,
    }, subtasks);
  };

  // Build the shared-thread history from the responder's point of view.
  const { data: msgs } = await admin.from("service_room_messages")
    .select("author_kind, agent_id, content, status").eq("room_id", room.id)
    .eq("status", "done").order("created_at", { ascending: true }).limit(40);
  const nameCache = new Map<string, string>();
  for (const p of participantIds) nameCache.set(p, "");
  const { data: agentNames } = await admin.from("internal_agents").select("id, name").in("id", participantIds.length ? participantIds : [a.id]);
  for (const an of (agentNames ?? []) as Array<{ id: string; name: string }>) nameCache.set(an.id, an.name);

  const history: ChatMessage[] = ((msgs ?? []) as Array<{ author_kind: string; agent_id: string | null; content: string }>)
    .filter((m) => m.content.trim())
    .map((m) => {
      if (m.author_kind === "user") return { role: "user", content: `[Utilisateur] ${m.content}` } as ChatMessage;
      if (m.agent_id === a.id) return { role: "assistant", content: m.content } as ChatMessage;
      return { role: "user", content: `[${nameCache.get(m.agent_id ?? "") || "Agent"}] ${m.content}` } as ChatMessage;
    });

  // The prompt compiler owns the shape: canonical section order, budgeted
  // knowledge, one place that decides what a room turn sees. The DURABLE tick
  // engine (internal-agent-run) rebuilds the real toolset + executor and runs
  // the loop, so a long room turn survives the edge wall-clock.
  const company = await loadCompanyContext(admin, room.project_id, {
    agentId: a.id,
    dashboardId: a.service_dashboard_id ?? room.dashboard_id,
  });
  const system = buildRoomSystemPrompt({
    admin, agent: a as RosterAgent,
    room: { id: room.id, dashboard_id: room.dashboard_id, workspace_id: room.workspace_id, project_id: room.project_id, title: room.title },
    dashboardName, toolRows: (toolRows ?? []) as AgentToolRow[],
    extraContext: missionId
      ? "Cette conversation appartient à une mission en cours de la room : tiens-en compte et reste dans son périmètre."
      : undefined,
    company,
  });

  const messages: ChatMessage[] = [{ role: "system", content: system }, ...history];
  const model = modelForTier(classifyTier(history.at(-1)?.content ?? "", { mode: "chat" }), agentProvider);

  if (!turnRunId) {
    await admin.from("service_room_messages").update({
      status: "failed", content: "⚠️ Impossible de démarrer le run.",
    }).eq("id", placeholderId);
    return;
  }

  // Run on the DURABLE tick engine (same as agent chats): persist resumable state
  // + enqueue a tick, instead of executing inline in this edge invocation. A long
  // room turn (analyse + sourcing + rapport) now survives the edge wall-clock —
  // pg_cron drains ticks server-side. The tick loop finalises back to THIS
  // placeholder via meta.room (finalizeRoomSuccess), attaching UI blocks +
  // deliverable cards.
  await admin.from("internal_agent_run_state").upsert({
    run_id: turnRunId,
    mode: "chat",
    agent_id: a.id,
    conversation_id: null,
    mission_id: null,
    messages,
    round: 0,
    max_rounds: 400,
    provider: "deepseek",
    model,
    processing_until: null,
    last_input_at: new Date().toISOString(),
    meta: { room: { room_id: room.id, placeholder_id: placeholderId } },
  });
  await admin.rpc("agent_tick_enqueue", { p_run_id: turnRunId });
}
