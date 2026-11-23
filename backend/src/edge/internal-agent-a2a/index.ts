import { Deno, FUNCTIONS_URL, defineHandler } from "../../compat/index.ts";

// internal-agent-a2a — make an agent react autonomously to a peer's message.
//
// Body: { message_id }  — the pending A2A message the recipient should process.
//
// The recipient runs a bounded agentic turn (its full toolset, including the
// collaboration tools, so it can in turn delegate, search, or reply). Its reply
// is persisted as an A2A message back to the sender, and the original message is
// marked answered/ignored. Triggered immediately on send (fire-and-forget) and
// also swept by the scheduler as a safety net.
//
// Body: { action: "start_exchange", from_agent, to_agent, topic, kind?, turns? }
//   — called by a PERSON (their JWT), from the Live Space: two agents of a
//   workspace they belong to exchange on a topic — an idea ('idea'), a
//   challenge ('challenge') or a debate ('debate'). The opener writes its first
//   statement itself, then each reply consumes one turn (0294) and hands the
//   ball back, until turns run out. Nothing is staged: every line is a real
//   turn of the agent, with its persona, instructions, team memory and tools.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { callAi } from "../_shared/ai.ts";
import { requireWorkspaceMember } from "../_shared/authz.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";
import { advanceMission, launchMission, resumeMission, retryMission, startMissionPlanning } from "../_shared/mission-planning.ts";
import { distillLessons } from "../_shared/team-life.ts";
import {
  connectedApps, deployTeam, designTeam, loadBlueprint, saveBlueprint,
} from "../_shared/team-architect.ts";
import { blueprintFromTemplate, lintBlueprint, normalizeBlueprint, type TeamBlueprint } from "../_shared/teamz.ts";
import { findTeamzTemplate } from "../_shared/teamz-catalog.ts";
import type { OpsActor, OpsRole } from "../_shared/assistant-ops.ts";

function authorized(req: Request): boolean {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return !!token && token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}

export default defineHandler(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  let body: { message_id?: string; action?: string; [k: string]: unknown };
  try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, { status: 400 }); }
  if (body?.action === "start_exchange") return startExchange(req, body);
  // Le cadrage d'une mission par l'équipe (0295) : lancé, relancé, débloqué
  // ou démarré par une PERSONNE ; chaque étape jouée en service role.
  if (typeof body?.action === "string" && USER_MISSION_ACTIONS.has(body.action)) return missionAction(req, body);
  // Les Teamz (0298) : concevoir une équipe d'une phrase, la déployer — par une
  // PERSONNE, depuis l'écran Teamz. Même implémentation que les assistants.
  if (body?.action === "team_design" || body?.action === "team_deploy") return teamAction(req, body);
  if (body?.action === "mission_step") {
    if (!authorized(req)) return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    const admin = createServiceClient();
    const id = String(body.mission_id ?? "");
    const out = await advanceMission(admin, id);
    if (out.next) await kickMission(id);
    return jsonResponse({ ok: true, ...out });
  }

  if (!authorized(req)) return jsonResponse({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceClient();
  try {
    const { message_id } = body;
    if (!message_id) return jsonResponse({ error: "message_id required" }, { status: 400 });

    // Claim the message (pending → processing) atomically-ish to avoid double work.
    const { data: msg } = await admin
      .from("internal_agent_a2a_messages")
      .select("id, thread_id, from_agent, to_agent, content, status, workspace_id, project_id, kind, turns_left")
      .eq("id", message_id)
      .maybeSingle();
    if (!msg) return jsonResponse({ error: "Message not found" }, { status: 404 });
    if ((msg as any).status !== "pending") return jsonResponse({ ok: true, skipped: (msg as any).status });

    const { data: claimed } = await admin
      .from("internal_agent_a2a_messages")
      .update({ status: "processing" })
      .eq("id", message_id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (!claimed) return jsonResponse({ ok: true, skipped: "already claimed" });

    const recipientId = (msg as any).to_agent as string;
    const senderId = (msg as any).from_agent as string;

    // Load recipient + its tools.
    const [{ data: agent }, { data: tools }, { data: sender }] = await Promise.all([
      admin.from("internal_agents")
        .select("id, name, persona, instructions, model, temperature, max_steps, workspace_id, project_id, is_archived, collaboration_enabled, autonomy_level, service_dashboard_id, created_by")
        .eq("id", recipientId).maybeSingle(),
      admin.from("internal_agent_tools")
        .select("id, kind, name, description, config, enabled, requires_approval")
        .eq("agent_id", recipientId),
      admin.from("internal_agents").select("name").eq("id", senderId).maybeSingle(),
    ]);
    if (!agent || (agent as any).is_archived || (agent as any).collaboration_enabled === false) {
      await admin.from("internal_agent_a2a_messages").update({ status: "ignored" }).eq("id", message_id);
      return jsonResponse({ ok: true, ignored: true });
    }
    const a = agent as any;

    // Recent thread history for context.
    const { data: history } = await admin
      .from("internal_agent_a2a_messages")
      .select("from_agent, content, created_at")
      .eq("thread_id", (msg as any).thread_id)
      .order("created_at", { ascending: true })
      .limit(12);

    // Top team memory for shared context.
    const { data: teamMem } = await admin
      .from("internal_agent_team_memories")
      .select("kind, content")
      .eq("project_id", a.project_id)
      .order("is_pinned", { ascending: false })
      .order("importance", { ascending: false })
      .limit(10);
    const teamMemSection = (teamMem ?? []).map((m: any) => `- [${m.kind}] ${m.content}`).join("\n");

    const senderName = (sender as any)?.name ?? "a teammate agent";

    // Un échange borné (0294) : idée, challenge ou débat. La consigne change, la
    // réplique est courte, et le dernier tour conclut.
    const kind = String((msg as any).kind ?? "message") as ExchangeKind;
    const turnsLeft = (msg as any).turns_left as number | null;
    const exchange = kind !== "message";
    let topic = "";
    if (exchange) {
      const { data: th } = await admin.from("internal_agent_a2a_threads").select("topic").eq("id", (msg as any).thread_id).maybeSingle();
      topic = String((th as { topic?: string } | null)?.topic ?? "");
    }
    const lastWord = exchange && turnsLeft !== null && turnsLeft <= 1;

    // La consigne propre à l'échange ; le reste (identité, outils de ses pools,
    // garde-fous, mémoire d'équipe) est celui de l'agent sur le harnais.
    const extraContext = exchange
      ? `${exchangePrompt(a, senderName, kind, topic, lastWord ? "close" : "reply")}\n\nN'utilise un outil que si un fait précis renforce ton propos. Ta réplique est courte.`
      : [
        `Ton collègue ${senderName} t'a écrit. Réagis utilement et en autonomie :`,
        "- si tu peux répondre ou aider directement, fais-le, brièvement ;",
        "- utilise tes outils si besoin (recherche, données, délégation, mémoire d'équipe) ;",
        "- si un autre agent est mieux placé, délègue-lui ;",
        `- reste centré : ta réponse part telle quelle chez ${senderName}.`,
      ].join("\n");
    const thread = ((history ?? []) as Array<{ from_agent: string; content: string }>)
      .map((h) => `[${h.from_agent === a.id ? "Toi" : senderName}] ${String(h.content ?? "").slice(0, 2000)}`);
    const text = thread.length
      ? `# L'échange avec ${senderName} (du plus ancien au plus récent)\n${thread.join("\n\n")}`
      : String((msg as any).content ?? "");

    let reply: string | undefined;
    try {
      const { runAndWait } = await import("../../harness/runs.ts");
      const out = await runAndWait({
        agentId: a.id, kind: "a2a", text, extraContext, via: "a2a",
        actingUserId: a.created_by ?? null, meta: { a2a: { message_id } },
      }, exchange ? 5 * 60_000 : 15 * 60_000);
      reply = out.text.trim();
    } catch (e) {
      reply = `Je n'ai pas pu traiter ta demande : ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;
    }
    if (reply) {
      // Dans un échange borné, la réplique consomme un tour. La dernière naît
      // « answered » : personne ne la relancera, pas même le planificateur.
      const nextTurns = exchange && turnsLeft !== null ? turnsLeft - 1 : null;
      const done = nextTurns !== null && nextTurns <= 0;
      const { data: replyRow } = await admin.from("internal_agent_a2a_messages").insert({
        thread_id: (msg as any).thread_id,
        workspace_id: a.workspace_id,
        project_id: a.project_id,
        from_agent: a.id,
        to_agent: senderId,
        content: reply.slice(0, 4000),
        reply_to: message_id,
        kind,
        turns_left: nextTurns,
        ...(done ? { status: "answered" } : {}),
      }).select("id").maybeSingle();
      await admin.from("internal_agent_a2a_messages").update({ status: "answered" }).eq("id", message_id);
      // La balle repart tout de suite chez l'autre — sans attendre le balayage.
      if (exchange && !done && replyRow) await kick((replyRow as { id: string }).id);
      // Fin de l'échange : chacun en tire sa leçon, s'il y en a une. En tâche
      // de fond — la réponse n'a pas à l'attendre.
      if (exchange && done) background(distillLessons(admin, (msg as any).thread_id, [a.id, senderId]).catch(() => 0));
    } else {
      await admin.from("internal_agent_a2a_messages").update({ status: "ignored" }).eq("id", message_id);
    }
    await admin.from("internal_agent_a2a_threads")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", (msg as any).thread_id);

    // La consommation est comptée par le harnais, sur le run de l'échange.

    return jsonResponse({ ok: true, replied: !!reply });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "a2a failed" }, { status: 500 });
  }
});

// ---------------------------------------------------------------------------
// Échanges bornés (0294) : idée, challenge, débat
// ---------------------------------------------------------------------------

type ExchangeKind = "message" | "idea" | "challenge" | "debate" | "review";
const EXCHANGE_KINDS = new Set<ExchangeKind>(["idea", "challenge", "debate", "review"]);

/** Ce qui doit continuer après la réponse (leçons, étape suivante). */
function background(p: Promise<unknown>) {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p); else void p;
}

/** La consigne d'un tour d'échange. Courte, et propre au rôle de l'agent :
 *  c'est sa persona et ses instructions qui argumentent, pas un script. */
function exchangePrompt(
  me: { name: string; persona?: string | null; instructions?: string | null },
  peer: string,
  kind: ExchangeKind,
  topic: string,
  phase: "open" | "reply" | "close",
): string {
  const task = phase === "close"
    ? `This is your LAST word in this exchange with ${peer}. Say where you now agree, what remains open, and the decision or next step you would propose.`
    : phase === "open"
      ? kind === "idea"
        ? `Share ONE concrete idea with ${peer} about the topic: what it is, why it matters for your work, and the first step. Ask for their honest take.`
        : kind === "challenge"
          ? `Open a challenge with ${peer} on the topic: state your position with your strongest argument, then ask them to find the flaw.`
          : kind === "review"
            ? `Open a review with ${peer} on the topic: say precisely what should be reviewed (your recent work or theirs) and the 2 or 3 points that deserve a critical eye.`
            : `Open a debate with ${peer} on the topic: take a clear stance, give two arguments grounded in your role, and invite them to argue the other side.`
      : kind === "idea"
        ? `${peer} shared an idea. Build on it: what is strong, what is missing or risky, and one concrete improvement. Then hand the ball back.`
        : kind === "review"
          ? `Continue the review with ${peer}: be concrete — what holds, what is wrong or missing, and the exact correction you propose (or accept, if you are the author and the critique is right).`
          : `Answer ${peer}'s last point directly. Concede what is right, challenge the weakest assumption with a counter-argument or a fact, and end with one pointed question.`;
  return `You are ${me.persona || me.name}, an internal agent of a team, in a live ${kind} with your colleague ${peer}.
Topic: ${topic || "(open topic)"}
${me.instructions ? `\nYour role and instructions:\n${me.instructions}\n` : ""}
${task}
Rules: at most 120 words, no preamble, no headings; be specific to your role, direct and respectful. Reply in the language the topic is written in.`;
}

/** Relance la fonction pour le message suivant, sans attendre sa réponse
 *  complète : le tour d'après s'exécute dans sa propre invocation. Si l'appel
 *  se perd, le planificateur reprend le message « pending » une minute après. */
async function kick(messageId: string): Promise<void> {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return;
  const p = fetch(`${FUNCTIONS_URL}/functions/v1/internal-agent-a2a`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message_id: messageId }),
    signal: AbortSignal.timeout(2500),
  }).then(() => {}, () => {});
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(p); else await p;
}

/** Une personne lance un échange entre deux agents de son workspace. L'agent
 *  qui ouvre écrit lui-même sa première prise de parole ; l'autre répond dans
 *  la foulée, puis chacun à son tour. */
async function startExchange(req: Request, body: Record<string, unknown>): Promise<Response> {
  const admin = createServiceClient();
  const from = String(body.from_agent ?? "");
  const to = String(body.to_agent ?? "");
  const kind: ExchangeKind = EXCHANGE_KINDS.has(body.kind as ExchangeKind) ? body.kind as ExchangeKind : "debate";
  const topic = String(body.topic ?? "").trim().slice(0, 400);
  const turns = Math.max(2, Math.min(8, Math.round(Number(body.turns) || 6)));
  if (!from || !to || from === to) return jsonResponse({ error: "Deux agents différents sont requis." }, { status: 400 });
  if (!topic) return jsonResponse({ error: "Le sujet de l'échange est requis." }, { status: 400 });

  try {
    const { data: rows } = await admin.from("internal_agents")
      .select("id, name, persona, instructions, temperature, workspace_id, project_id, is_archived, collaboration_enabled")
      .in("id", [from, to]);
    const opener = (rows ?? []).find((r: any) => r.id === from) as any;
    const peer = (rows ?? []).find((r: any) => r.id === to) as any;
    if (!opener || !peer) return jsonResponse({ error: "Agent introuvable." }, { status: 404 });
    if (opener.workspace_id !== peer.workspace_id) {
      return jsonResponse({ error: "Les deux agents doivent appartenir au même workspace." }, { status: 400 });
    }
    const auth = await requireWorkspaceMember(req, opener.workspace_id, "member");
    if (!auth.ok) return auth.response;
    for (const ag of [opener, peer]) {
      if (ag.is_archived || ag.collaboration_enabled === false) {
        return jsonResponse({ error: `${ag.name} n'accepte pas les échanges entre agents.` }, { status: 409 });
      }
    }

    // Le fil canonique de la paire (agent_a < agent_b), au sujet du jour.
    const [aId, bId] = [from, to].sort();
    const { data: existing } = await admin.from("internal_agent_a2a_threads")
      .select("id").eq("agent_a", aId).eq("agent_b", bId).maybeSingle();
    let threadId = (existing as { id: string } | null)?.id ?? null;
    if (threadId) {
      await admin.from("internal_agent_a2a_threads")
        .update({ topic, updated_at: new Date().toISOString() }).eq("id", threadId);
    } else {
      const { data: th, error } = await admin.from("internal_agent_a2a_threads")
        .insert({ workspace_id: opener.workspace_id, project_id: opener.project_id, agent_a: aId, agent_b: bId, topic })
        .select("id").single();
      if (error || !th) throw new Error(error?.message ?? "fil impossible à créer");
      threadId = (th as { id: string }).id;
    }

    const res = await callAi({
      task: "chat_simple",
      systemPrompt: exchangePrompt(opener, peer.name, kind, topic, "open"),
      userPrompt: `Open the ${kind} with ${peer.name} now.`,
      maxTokens: 400,
      temperature: Math.max(opener.temperature ?? 0.3, 0.6),
    });
    const content = (res.content ?? "").trim();
    if (!content) return jsonResponse({ error: `${opener.name} n'a rien trouvé à dire.` }, { status: 502 });

    const { data: msg, error: insErr } = await admin.from("internal_agent_a2a_messages").insert({
      thread_id: threadId,
      workspace_id: opener.workspace_id,
      project_id: opener.project_id,
      from_agent: from,
      to_agent: to,
      content: content.slice(0, 4000),
      kind,
      turns_left: turns - 1,
      started_by: auth.userId,
    }).select("id").single();
    if (insErr || !msg) throw new Error(insErr?.message ?? "message impossible à écrire");

    await logLlmUsage({
      workspace_id: opener.workspace_id, project_id: opener.project_id,
      provider: res.provider, model: res.model,
      task: "chat_simple", feature: "internal-agent-a2a", usage: res.usage,
    });
    await kick((msg as { id: string }).id);
    return jsonResponse({ ok: true, thread_id: threadId, message_id: (msg as { id: string }).id });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "échange impossible" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Le cadrage d'une mission par l'équipe (0295)
// ---------------------------------------------------------------------------

const USER_MISSION_ACTIONS = new Set(["mission_kickoff", "mission_resume", "mission_launch", "mission_retry"]);

/** Relance la fonction pour l'étape suivante du cadrage, dans sa propre
 *  invocation. Perdue, le planificateur la reprend une minute et demie après. */
async function kickMission(missionId: string): Promise<void> {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return;
  background(fetch(`${FUNCTIONS_URL}/functions/v1/internal-agent-a2a`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "mission_step", mission_id: missionId }),
    signal: AbortSignal.timeout(2500),
  }).then(() => {}, () => {}));
}

/** Une personne confie la mission à l'équipe, répond à ses questions, donne
 *  le feu vert ou relance un cadrage arrêté. Membre de l'espace, au moins. */
async function missionAction(req: Request, body: Record<string, unknown>): Promise<Response> {
  const admin = createServiceClient();
  const id = String(body.mission_id ?? "");
  if (!id) return jsonResponse({ error: "mission_id requis." }, { status: 400 });
  const { data: m } = await admin.from("pj_projects").select("id, workspace_id").eq("id", id).maybeSingle();
  if (!m) return jsonResponse({ error: "Mission introuvable." }, { status: 404 });
  const auth = await requireWorkspaceMember(req, (m as { workspace_id: string }).workspace_id, "member");
  if (!auth.ok) return auth.response;
  try {
    switch (body.action) {
      case "mission_kickoff":
        await startMissionPlanning(admin, id, auth.userId);
        await kickMission(id);
        return jsonResponse({ ok: true, status: "scoping" });
      case "mission_resume":
        await resumeMission(admin, id, auth.userId, body.skip === true);
        await kickMission(id);
        return jsonResponse({ ok: true, status: "planning" });
      case "mission_retry":
        await retryMission(admin, id);
        await kickMission(id);
        return jsonResponse({ ok: true });
      case "mission_launch": {
        const n = await launchMission(admin, id);
        return jsonResponse({ ok: true, armed: n });
      }
    }
    return jsonResponse({ error: "Action inconnue." }, { status: 400 });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "action impossible" }, { status: 400 });
  }
}

// ── Teamz : concevoir et déployer une équipe depuis l'écran ─────────────────
//
// Body : { action: "team_design", dashboard_id, brief?, template_key? }
//        { action: "team_deploy", dashboard_id, blueprint_id? | template_key?,
//          blueprint? (version éditée à l'écran), kickoff?, routines?, tz_offset? }
// Le rôle « member » suffit, comme pour créer un agent à la main.
async function teamAction(req: Request, body: Record<string, unknown>): Promise<Response> {
  const admin = createServiceClient();
  const dashboardId = String(body.dashboard_id ?? "");
  if (!dashboardId) return jsonResponse({ error: "dashboard_id requis." }, { status: 400 });
  const { data: dash } = await admin.from("service_dashboards")
    .select("id, workspace_id, project_id").eq("id", dashboardId).maybeSingle();
  if (!dash) return jsonResponse({ error: "Service introuvable." }, { status: 404 });
  const d = dash as { id: string; workspace_id: string; project_id: string };
  const auth = await requireWorkspaceMember(req, d.workspace_id, "member");
  if (!auth.ok) return auth.response;
  const actor: OpsActor = {
    admin, workspaceId: d.workspace_id, projectId: d.project_id, dashboardId: d.id, roomId: null,
    userId: auth.userId, role: (auth.role ?? "member") as OpsRole, agentId: null, agentName: "Teamz",
  };
  try {
    if (body.action === "team_design") {
      const brief = String(body.brief ?? "").trim().slice(0, 2000);
      const templateKey = body.template_key ? String(body.template_key) : null;
      if (brief.length < 8 && !templateKey) {
        return jsonResponse({ error: "Décris l'équipe dont tu as besoin en une ou deux phrases." }, { status: 400 });
      }
      const design = await designTeam({
        admin, workspaceId: d.workspace_id, projectId: d.project_id,
        brief: brief || String(templateKey), templateKey, connected: await connectedApps(actor, d.id),
      });
      const blueprintId = await saveBlueprint(actor, design, d.id);
      return jsonResponse({ ok: true, blueprint_id: blueprintId, ...design });
    }

    let bp: TeamBlueprint | null = null;
    let blueprintId: string | null = null;
    if (body.blueprint_id) {
      blueprintId = String(body.blueprint_id);
      const saved = await loadBlueprint(actor, blueprintId);
      if (!saved) return jsonResponse({ error: "Plan d'équipe introuvable." }, { status: 404 });
      if (saved.status === "deployed") return jsonResponse({ error: "Ce plan a déjà été déployé." }, { status: 409 });
      bp = saved.blueprint;
    } else if (body.template_key) {
      const t = findTeamzTemplate(String(body.template_key));
      if (!t) return jsonResponse({ error: "Teamz inconnue." }, { status: 404 });
      bp = blueprintFromTemplate(t);
    }
    // Une version retouchée à l'écran (noms, rôles retirés) remplace le plan
    // enregistré — normalisée comme une sortie de modèle.
    if (body.blueprint && typeof body.blueprint === "object") {
      bp = normalizeBlueprint(body.blueprint, {
        source: bp?.source ?? "architect", templateKey: bp?.template_key ?? null, brief: bp?.brief ?? "",
      });
    }
    if (!bp) return jsonResponse({ error: "blueprint_id ou template_key requis." }, { status: 400 });
    const tz = Number(body.tz_offset);
    const res = await deployTeam(actor, bp, {
      service: d.id, kickoff: body.kickoff === true, routines: body.routines !== false,
      tzOffsetMinutes: Number.isFinite(tz) ? tz : null, blueprintId,
    });
    return jsonResponse({ ok: true, ...res, lint: lintBlueprint(bp) });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "action impossible" }, { status: 400 });
  }
}
