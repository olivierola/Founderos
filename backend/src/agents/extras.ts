// Les autres services de l'ancienne fonction internal-agent-run : l'API de
// l'application mobile, la conception d'un agent par l'IA, et le rattrapage du
// graphe de connaissances. Sortis tels quels ; seul le lancement d'un tour de
// chat passe par le harnais.

import { jsonResponse } from "../edge/_shared/cors.ts";
import { createServiceClient, createUserClient } from "../edge/_shared/supabase-admin.ts";
import { callAi, safeParseJson } from "../edge/_shared/ai.ts";
import { curateKnowledge } from "../edge/_shared/knowledge-graph.ts";
import { loadAgentAndTools } from "./context.ts";

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Mobile companion app. Two ways in — a logged-in Anduran **account** (user JWT
// in Authorization) which unlocks every agent the user can access, or the legacy
// per-agent **secret** which unlocks that one agent. Then dispatched on `action`,
// using the SAME agent + conversation store as the web chat (shared memory, tools,
// past sessions). Actions:
//   list_agents         → (account only) the agents this user can talk to
//   verify              → credentials check (registration)
//   list_conversations  → the agent's recent conversations
//   get_messages        → messages of a conversation (+ whether a run is running)
//   send                → append the user message and run the real agentic chat
// Body: { agent_id?, secret?, action?, conversation_id?, message?, verify? }
export async function handleMobile(body: Record<string, unknown>, authHeader: string | null): Promise<Response> {
  const admin = createServiceClient();
  const agentId = String(body.agent_id ?? "");
  const secret = body.secret ? String(body.secret) : "";
  const action = String(body.action ?? (body.verify ? "verify" : "send"));

  // ── Resolve the caller ──
  // No secret → account mode: authenticate the Anduran user from the JWT.
  let userId: string | null = null;
  let userClient: ReturnType<typeof createUserClient> | null = null;
  if (!secret) {
    userClient = createUserClient(authHeader);
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return jsonResponse({ error: "authentication required" }, { status: 401 });
    userId = u.user.id;
  }

  // ── Account-only: list every agent this user can talk to (RLS-scoped) ──
  if (action === "list_agents") {
    if (!userClient) return jsonResponse({ error: "account required" }, { status: 401 });
    const { data, error } = await userClient
      .from("internal_agents")
      .select("id, name, avatar_url, avatar_emoji, accent_color, description, updated_at")
      .eq("is_archived", false)
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    return jsonResponse({ agents: data ?? [] });
  }

  // Every other action is agent-scoped.
  if (!agentId) return jsonResponse({ error: "agent_id required" }, { status: 400 });

  // ── Authorize this agent for the caller (secret hash OR account access) ──
  if (secret) {
    const { data: sec } = await admin
      .from("internal_agents")
      .select("mobile_secret_hash, mobile_enabled, is_archived")
      .eq("id", agentId)
      .maybeSingle();
    if (!sec || sec.is_archived) return jsonResponse({ error: "unknown agent" }, { status: 404 });
    if (!sec.mobile_enabled || !sec.mobile_secret_hash) {
      return jsonResponse({ error: "mobile access is disabled for this agent" }, { status: 403 });
    }
    if ((await sha256Hex(secret)) !== sec.mobile_secret_hash) {
      return jsonResponse({ error: "invalid secret" }, { status: 401 });
    }
  } else {
    const { data: allowed } = await admin.rpc("has_internal_agent_access", {
      p_agent_id: agentId,
      p_user_id: userId,
    });
    if (!allowed) return jsonResponse({ error: "not authorized for this agent" }, { status: 403 });
  }

  if (action === "verify") return jsonResponse({ ok: true });

  if (action === "list_conversations") {
    const { data } = await admin
      .from("internal_agent_conversations")
      .select("id, title, updated_at, created_at")
      .eq("agent_id", agentId)
      .order("updated_at", { ascending: false })
      .limit(50);
    return jsonResponse({ conversations: data ?? [] });
  }

  if (action === "get_messages") {
    const cid = String(body.conversation_id ?? "");
    if (!cid) return jsonResponse({ error: "conversation_id required" }, { status: 400 });
    const { data } = await admin
      .from("internal_agent_messages")
      .select("id, role, content, created_at, run_id")
      .eq("conversation_id", cid)
      .order("created_at", { ascending: true })
      .limit(300);
    // A run in flight for this conversation → the client keeps polling / shows "thinking".
    const { data: active } = await admin
      .from("internal_agent_runs")
      .select("id")
      .eq("conversation_id", cid)
      .eq("status", "running")
      .limit(1);
    return jsonResponse({ messages: data ?? [], running: (active ?? []).length > 0 });
  }

  if (action === "send") {
    const message = String(body.message ?? "").trim();
    if (!message) return jsonResponse({ error: "message required" }, { status: 400 });
    const { agent } = await loadAgentAndTools(agentId);

    let cid = body.conversation_id ? String(body.conversation_id) : null;
    if (!cid) {
      const { data: convo } = await admin
        .from("internal_agent_conversations")
        .insert({
          agent_id: agent.id,
          workspace_id: agent.workspace_id,
          project_id: agent.project_id,
          title: message.slice(0, 60),
        })
        .select("id")
        .single();
      cid = convo?.id ?? null;
    }
    if (!cid) return jsonResponse({ error: "could not open conversation" }, { status: 500 });

    await admin.from("internal_agent_messages").insert({
      conversation_id: cid,
      agent_id: agent.id,
      role: "user",
      content: message.slice(0, 4000),
    });

    // Le même tour de chat que l'application web, sur le harnais ; la réponse
    // arrive dans internal_agent_messages. Crédits et quota vérifiés comme ailleurs.
    const { requireRuntime, startAgentRun } = await import("../harness/runs.ts");
    const rt = await requireRuntime();
    await rt.checkCredits(agent.workspace_id);
    const turn = await startAgentRun(rt, { agentId: agent.id, kind: "chat", conversationId: cid, via: "mobile" });
    return jsonResponse({ conversation_id: cid, run_id: turn.run_id, queued: true });
  }

  return jsonResponse({ error: "unknown mobile action" }, { status: 400 });
}

// ── Agent designer ──────────────────────────────────────────────────────────
// One request in, one runnable agent spec out. The model picks the studio when
// the request is really about coding / testing / simulating an app, because a
// studio agent gets a real engine instead of generic web tools.
export const DESIGNABLE_TOOL_KINDS = [
  "web_search", "web_fetch", "rag_search", "db_read", "vibe_code",
] as const;

export const DESIGNER_SYSTEM = `You design internal AI agents for a company workspace. Given a plain-language request, output ONE agent that would actually do that job.

Return STRICT JSON, no prose, with this shape:
{
  "name": "short human name, e.g. 'Release Tester'",
  "tagline": "one line: what you get",
  "category": "Support|Revenue|Growth|Ops|Leadership|Product|Cybersecurity|Data|HR|Supply chain|Design|QA|R&D|Finance|Legal|Marketing|Assistant",
  "studio": "vibe_code|testing|simulation|null",
  "persona": "2-3 sentences describing who this agent is and how it behaves",
  "soul": "3-5 lines, second person ('Tu…'): its CHARACTER — its voice, what it cares about most, what it refuses to do even when pushed, the habit that makes it recognisable. NOT a procedure, NOT a repeat of the instructions: write what no numbered step can say.",
  "instructions": "the agent's operating procedure: numbered steps it follows for every task, plus explicit rules about what it must never do. Be specific to the request — no generic filler.",
  "autonomy": "advisor|assisted|autopilot",
  "max_steps": 8,
  "tools": [{ "kind": "web_search|web_fetch|rag_search|db_read|vibe_code", "name": "short label", "description": "why this agent needs it" }],
  "outcomes": ["3 concrete results the owner gets"],
  "suggestedSchedule": { "label": "string", "cron": "0 9 * * 1", "prompt": "what to do on each run" } or null
}

Rules:
- studio="vibe_code" ONLY when the agent writes/modifies real code in a repository. Give it the vibe_code tool.
- studio="testing" for agents that run test suites against an app; "simulation" for agents that simulate users/scenarios. Otherwise null.
- autonomy: "advisor" when the job is analysis/recommendation, "assisted" when it acts but a human should approve writes, "autopilot" only for low-risk repetitive work.
- max_steps: 6-10 for simple jobs, up to 20 for coding/testing agents.
- Instructions are the product. Write what a competent operator would write, in the language of the request.`;

/** One batch of pre-graph memories through the curator. Marked as curated
 *  whatever the gate decided, so a memory is never judged twice. */
export async function backfillKnowledge(admin: ReturnType<typeof createServiceClient>, workspaceId: string) {
  const BATCH = 24;
  const [{ data: mems }, { data: team }] = await Promise.all([
    admin.from("internal_agent_memories").select("id, agent_id, project_id, kind, content")
      .eq("workspace_id", workspaceId).is("knowledge_curated_at", null)
      .order("importance", { ascending: false }).order("created_at", { ascending: false }).limit(BATCH),
    admin.from("internal_agent_team_memories").select("id, content, kind")
      .eq("workspace_id", workspaceId).is("knowledge_curated_at", null)
      .order("created_at", { ascending: false }).limit(BATCH),
  ]);
  const rows = [
    ...((mems ?? []) as Array<{ id: string; agent_id: string | null; project_id: string | null; kind: string; content: string }>).map((m) => ({ ...m, table: "internal_agent_memories" })),
    ...((team ?? []) as Array<{ id: string; kind: string; content: string }>).map((m) => ({ ...m, agent_id: null, project_id: null, table: "internal_agent_team_memories" })),
  ].slice(0, BATCH);
  if (!rows.length) return { ok: true, processed: 0, remaining: 0, saved: 0 };

  const res = await curateKnowledge(admin, {
    workspaceId, source: "backfill",
    context: "Reprise de la mémoire existante des agents de l'espace vers le graphe de connaissances.",
    text: rows.map((r) => `- (${r.kind}) ${r.content}`).join("\n"),
  });
  const now = new Date().toISOString();
  for (const table of ["internal_agent_memories", "internal_agent_team_memories"]) {
    const ids = rows.filter((r) => r.table === table).map((r) => r.id);
    if (ids.length) await admin.from(table).update({ knowledge_curated_at: now }).in("id", ids);
  }
  const [{ count: a }, { count: b }] = await Promise.all([
    admin.from("internal_agent_memories").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).is("knowledge_curated_at", null),
    admin.from("internal_agent_team_memories").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).is("knowledge_curated_at", null),
  ]);
  return {
    ok: true, processed: rows.length, remaining: (a ?? 0) + (b ?? 0),
    saved: res.facts.saved, entities: res.entities.created.length + res.entities.merged.length, relations: res.relations,
  };
}

export async function designAgent(request: string, projectId: string | null): Promise<Response> {
  // Ground the design in what this project actually has, so the model doesn't
  // invent a repo-driven agent for a project with no repository connected.
  let context = "";
  if (projectId) {
    const admin = createServiceClient();
    const [{ data: repos }, { data: connectors }] = await Promise.all([
      admin.from("repositories").select("full_name").eq("project_id", projectId).limit(10),
      admin.from("connectors").select("provider").eq("project_id", projectId).eq("status", "connected").limit(20),
    ]);
    const repoNames = ((repos ?? []) as Array<{ full_name: string }>).map((r) => r.full_name);
    const providers = ((connectors ?? []) as Array<{ provider: string }>).map((c) => c.provider);
    context =
      `\n\nProject context — repositories: ${repoNames.length ? repoNames.join(", ") : "none connected"}.` +
      ` Connected tools: ${providers.length ? providers.join(", ") : "none"}.`;
  }

  const { content } = await callAi({
    task: "json_extraction",
    systemPrompt: DESIGNER_SYSTEM,
    userPrompt: `Request: ${request}${context}`,
    jsonMode: true,
    temperature: 0.4,
    maxTokens: 2000,
  });

  const spec = safeParseJson<Record<string, unknown>>(content);
  if (!spec || typeof spec.name !== "string") {
    return jsonResponse({ error: "Could not design an agent from this request", detail: content.slice(0, 300) }, { status: 422 });
  }

  // Normalise everything the UI will instantiate — a hallucinated tool kind or
  // autonomy level would fail at insert time (the tool-kind CHECK constraint),
  // so they're filtered here rather than surfacing as a broken agent.
  const rawTools = Array.isArray(spec.tools) ? spec.tools as Array<Record<string, unknown>> : [];
  const tools = rawTools
    .filter((t) => DESIGNABLE_TOOL_KINDS.includes(String(t.kind) as typeof DESIGNABLE_TOOL_KINDS[number]))
    .slice(0, 6)
    .map((t) => ({
      kind: String(t.kind),
      name: String(t.name ?? t.kind).slice(0, 60),
      description: t.description ? String(t.description).slice(0, 200) : undefined,
      ...(String(t.kind) === "vibe_code" ? { config: { actions: ["run", "apply", "pr_status", "fix_pr"] } } : {}),
    }));

  const studio = ["vibe_code", "testing", "simulation"].includes(String(spec.studio)) ? String(spec.studio) : null;
  const autonomy = ["advisor", "assisted", "autopilot"].includes(String(spec.autonomy)) ? String(spec.autonomy) : "assisted";
  const maxSteps = Number(spec.max_steps);

  return jsonResponse({
    spec: {
      name: String(spec.name).slice(0, 60),
      tagline: String(spec.tagline ?? "").slice(0, 160),
      category: String(spec.category ?? "Assistant"),
      studio,
      persona: String(spec.persona ?? ""),
      soul: String(spec.soul ?? "").slice(0, 2400),
      instructions: String(spec.instructions ?? ""),
      autonomy,
      max_steps: Number.isFinite(maxSteps) ? Math.min(Math.max(Math.round(maxSteps), 4), 24) : 10,
      // A studio agent is useless without its engine — add it back if the model
      // described the studio but forgot the tool.
      tools: studio === "vibe_code" && !tools.some((t) => t.kind === "vibe_code")
        ? [{ kind: "vibe_code", name: "Vibe Code", config: { actions: ["run", "apply", "pr_status", "fix_pr"] } }, ...tools]
        : tools,
      outcomes: Array.isArray(spec.outcomes) ? (spec.outcomes as unknown[]).slice(0, 4).map(String) : [],
      suggestedSchedule: spec.suggestedSchedule && typeof spec.suggestedSchedule === "object"
        ? spec.suggestedSchedule
        : null,
    },
  });
}
