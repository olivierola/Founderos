// service-room-post — multi-agent room turn. The human posts into a shared room
// thread; the mentioned agent(s) (or the room's default responder) each reply,
// seeing the whole thread. Reuses the shared agent toolset (create_deliverable,
// render_ui, create_agent, create_mission, web/data/memory…). Runs in the
// background (EdgeRuntime.waitUntil) so long turns don't 504; the client polls
// service_room_messages.
import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { type ChatMessage } from "../_shared/ai.ts";
import { buildInternalToolset, type InternalToolContext, type AgentToolRow, type ArtifactDraft } from "../_shared/internal-agent-tools.ts";
import { runParallelSubagents } from "../_shared/subagents.ts";
import { classifyTier, modelForTier } from "../_shared/model-router.ts";

type Admin = ReturnType<typeof createServiceClient>;
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

// --- create_artifact content parsing ---------------------------------------
// Small, independent mirror of the shapes src/features/office/shared.ts uses
// (Plate document nodes / presentation slides / spreadsheet rows) — edge
// functions don't share a bundle with the frontend, so this stays minimal
// (headings, bullet/numbered lists, paragraphs) rather than importing it.

function parseMarkdownToSlateNodes(md: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of (md ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { out.push({ type: `h${h[1].length}`, children: [{ text: h[2] }] }); continue; }
    if (/^>\s+/.test(line)) { out.push({ type: "blockquote", children: [{ text: line.replace(/^>\s+/, "") }] }); continue; }
    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ul) { out.push({ type: "p", listStyleType: "disc", indent: 1, children: [{ text: ul[2] }] }); continue; }
    const ol = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (ol) { out.push({ type: "p", listStyleType: "decimal", indent: 1, children: [{ text: ol[2] }] }); continue; }
    if (line.trim() === "") continue;
    out.push({ type: "p", children: [{ text: line }] });
  }
  return out.length ? out : [{ type: "p", children: [{ text: "" }] }];
}

function parseSlideLines(text: string): Array<{ title: string; body: string; layout: string }> {
  const lines = (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const slides = lines.map((line) => {
    const idx = line.indexOf("|");
    const title = idx === -1 ? line : line.slice(0, idx).trim();
    const body = idx === -1 ? "" : line.slice(idx + 1).trim();
    return { title: title || "Untitled slide", body, layout: "title-content" };
  });
  return slides.length ? slides : [{ title: "Untitled presentation", body: "", layout: "title" }];
}

function parseCsvToSpreadsheet(csv: string): { columns: string[]; rows: (string | null)[][] } {
  const lines = (csv ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const splitLine = (l: string) => l.split(",").map((c) => c.trim());
  const columns = lines.length ? splitLine(lines[0]) : ["A", "B", "C", "D"];
  const rows = lines.slice(1).map((l) => {
    const cells: (string | null)[] = splitLine(l);
    while (cells.length < columns.length) cells.push("");
    return cells;
  });
  return { columns, rows: rows.length ? rows : Array.from({ length: 8 }, () => columns.map(() => "")) };
}

// create_artifact, room flow: office_documents for document/presentation/
// spreadsheet (tagged with service_room_id so the Artifacts tab can scope
// "in this room"), office-ai media.generate for images, and a table-less
// inline block for plain text. Always pushes an `artifact` ui block.
async function createRoomArtifact(
  admin: Admin,
  room: { id: string; workspace_id: string; project_id: string },
  createdBy: string | null,
  artifact: ArtifactDraft,
  uiBlocks: Array<Record<string, unknown>>,
): Promise<void> {
  if (artifact.kind === "image") {
    const base = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!base || !key) {
      uiBlocks.push({ component: "artifact", props: { table: "text", kind: "text", title: artifact.title, content: "Image generation is not configured." } });
      return;
    }
    const res = await fetch(`${base}/functions/v1/office-ai`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ op: "media.generate", workspace_id: room.workspace_id, project_id: room.project_id, kind: "image", prompt: artifact.content }),
    });
    const json = await res.json().catch(() => ({} as Record<string, unknown>));
    const media = (json as { media?: { id?: string } }).media;
    if (!res.ok || !media?.id) {
      const err = (json as { error?: string }).error ?? `HTTP ${res.status}`;
      uiBlocks.push({ component: "artifact", props: { table: "text", kind: "text", title: artifact.title, content: `Image generation failed: ${err}` } });
      return;
    }
    await admin.from("office_media").update({ service_room_id: room.id }).eq("id", media.id);
    uiBlocks.push({ component: "artifact", props: { id: media.id, table: "office_media", kind: "image", title: artifact.title } });
    return;
  }

  if (artifact.kind === "text") {
    uiBlocks.push({ component: "artifact", props: { table: "text", kind: "text", title: artifact.title, content: artifact.content } });
    return;
  }

  const content = artifact.kind === "document"
    ? { nodes: parseMarkdownToSlateNodes(artifact.content) }
    : artifact.kind === "presentation"
    ? { slides: parseSlideLines(artifact.content) }
    : parseCsvToSpreadsheet(artifact.content);

  const { data, error } = await admin.from("office_documents").insert({
    workspace_id: room.workspace_id, project_id: room.project_id, service_room_id: room.id,
    kind: artifact.kind, title: artifact.title, content, created_by: createdBy,
  }).select("id").single();
  if (error || !data) {
    uiBlocks.push({ component: "artifact", props: { table: "text", kind: "text", title: artifact.title, content: `Failed to create ${artifact.kind}: ${error?.message}` } });
    return;
  }
  uiBlocks.push({ component: "artifact", props: { id: (data as { id: string }).id, table: "office_documents", kind: artifact.kind, title: artifact.title } });
}

interface AgentRow {
  id: string; name: string; persona: string | null; instructions: string | null;
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

    // Post the human message — with an attached image (uploaded client-side
    // into office_media) shown as an artifact card on the user's own message.
    await admin.from("service_room_messages").insert({
      room_id: roomId, workspace_id: room.workspace_id, project_id: room.project_id,
      author_kind: "user", user_id: userId, content, status: "done",
      ui_blocks: attachmentMediaId
        ? [{ component: "artifact", props: { id: attachmentMediaId, table: "office_media", kind: "image", title: "Image" } }]
        : null,
    });
    await admin.from("service_rooms").update({ updated_at: new Date().toISOString() }).eq("id", roomId);

    // Who replies: explicitly-mentioned participants, else the dashboard's
    // configured default responder, else the orchestrator, else the first
    // participant. Cap concurrent responders.
    let responders = mentions.filter((id) => participantIds.includes(id));
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

    // Insert a "thinking" placeholder per responder so the UI shows them typing.
    const placeholders: Record<string, string> = {};
    for (const aid of responders) {
      const { data: ph } = await admin.from("service_room_messages").insert({
        room_id: roomId, workspace_id: room.workspace_id, project_id: room.project_id,
        author_kind: "agent", agent_id: aid, content: "", status: "thinking",
      }).select("id").single();
      if (ph) placeholders[aid] = (ph as { id: string }).id;
    }

    const work = async () => {
      for (const aid of responders) {
        try {
          await runResponder(admin, room, dashboardName, aid, placeholders[aid], participantIds);
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

async function runResponder(
  admin: Admin, room: { id: string; workspace_id: string; project_id: string; title: string; dashboard_id: string },
  dashboardName: string, agentId: string, placeholderId: string, participantIds: string[],
) {
  const { data: agent } = await admin.from("internal_agents")
    .select("id, name, persona, instructions, temperature, is_orchestrator, service_dashboard_id, created_by, swarm_enabled, swarm_max_concurrency")
    .eq("id", agentId).maybeSingle();
  if (!agent) throw new Error("Agent introuvable");
  const a = agent as AgentRow;
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
    serviceDashboardId: a.service_dashboard_id ?? room.dashboard_id, userId: a.created_by ?? null,
    createDeliverable: async (d) => {
      const { data } = await admin.from("internal_agent_deliverables").insert({
        agent_id: a.id, run_id: turnRunId, kind: d.kind, name: d.name, content: d.content, summary: d.summary,
      }).select("id").single();
      uiBlocks.push({ component: "deliverable", props: { id: (data as { id: string } | null)?.id, name: d.name, kind: d.kind } });
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
  if (ctx.swarmEnabled && turnRunId) ctx.spawnParallel = async (subtasks) => {
    return await runParallelSubagents({
      admin, parentRunId: turnRunId,
      agentId: a.id, workspaceId: room.workspace_id, projectId: room.project_id, createdBy: a.created_by ?? null,
      tools: (toolRows ?? []) as AgentToolRow[], provider: "deepseek", temperature: a.temperature ?? 0.4,
      makeChildContext: (childRunId) => ({ ...ctx, runId: childRunId, isSubagent: true, spawnParallel: undefined }),
      buildChildSystem: (cap) => [
        `You are ${a.name}${a.persona ? ` — ${a.persona}` : ""}, focused on a single subtask for the "${room.title}" room.`,
        a.instructions ? `Your instructions:\n${a.instructions}` : "",
        "Your tools:", cap,
      ].filter(Boolean).join("\n"),
      maxConcurrency: a.swarm_max_concurrency ?? undefined,
    }, subtasks);
  };

  // We only need the capability summary for the system prompt — the DURABLE tick
  // engine (internal-agent-run) rebuilds the real toolset + executor and runs the
  // loop, so a long room turn survives the edge wall-clock.
  const { capabilitySummary } = buildInternalToolset((toolRows ?? []) as AgentToolRow[], ctx);

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

  const orchNote = a.is_orchestrator
    ? "\nYou are this workspace's orchestrator: when asked, create agents (create_agent) or schedule recurring work (create_mission with a cron schedule), and confirm plainly."
    : "";
  const system = [
    `You are ${a.name}${a.persona ? ` — ${a.persona}` : ""}, an agent in a shared room "${room.title}" of the "${dashboardName}" workspace.`,
    a.instructions ? `Your instructions:\n${a.instructions}` : "",
    orchNote,
    "The human and possibly other agents talk here; each message is prefixed with the speaker in [brackets]. Reply AS YOURSELF, directly and concisely — no need to restate the question or your name. Don't answer for other agents.",
    "Use render_ui for metrics/tables/charts, and create_deliverable to produce a document/file/report (it appears as a card). Real data only.",
    "QUAND ON TE DEMANDE UN RAPPORT / UNE ANALYSE / UN LIVRABLE : NE demande PAS quoi faire, ne réponds PAS juste par du texte conversationnel. Fais l'analyse avec tes outils MAINTENANT et produis-la avec create_deliverable(kind=\"report\") (sections, KPIs, tableaux, risques — conçu avec ton skill report-designer). Pour un gros rapport, construis-le avec report_section puis finalise avec create_deliverable(kind=\"report\") sans content. Ne pose une question de clarification QUE si c'est réellement impossible d'avancer.",
    "",
    "Your tools:",
    capabilitySummary,
  ].filter(Boolean).join("\n");

  const messages: ChatMessage[] = [{ role: "system", content: system }, ...history];
  const model = modelForTier(classifyTier(history.at(-1)?.content ?? "", { mode: "chat" }));

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
