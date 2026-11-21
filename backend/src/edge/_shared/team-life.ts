// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/team-life.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// La VIE D'ÉQUIPE : ce que les agents font entre eux sans qu'on le leur demande.
//
// De temps en temps, un agent disponible fait le point sur ce qui se passe
// autour de lui — les livrables récents de ses collègues, ses propres échecs,
// les sujets en cours — et décide LUI-MÊME s'il y a quelque chose à dire à un
// collègue : une idée qui servirait l'équipe, une décision à challenger, un
// livrable à faire relire ou à relire. S'il n'y a rien d'utile, il se tait.
// Sinon, l'échange part (0294) et se déroule tour à tour, pour de vrai.
//
// À la fin de chaque échange, chacun des deux en tire — ou non — UNE leçon
// durable, rangée dans sa mémoire (kind « learning ») : c'est ainsi que l'équipe
// s'améliore et se corrige d'un échange à l'autre.
//
// Borné par service : un rythme (« calme » ou « active », réglable, coupé avec
// « off ») et un plafond par jour. Une initiative au plus par passage du
// planificateur, tous services confondus.

import type { SupabaseClient } from "@supabase/supabase-js";
import { callAi } from "./ai.ts";
import { logLlmUsage } from "./llm-tracking.ts";
import { loadSelfModel } from "./self-model.ts";

type Admin = SupabaseClient;

const RHYTHM: Record<string, { gapMin: number; perDay: number }> = {
  calm: { gapMin: 90, perDay: 6 },
  active: { gapMin: 20, perDay: 24 },
};

interface Agent {
  id: string; name: string; description: string | null; persona: string | null; instructions: string | null;
  workspace_id: string; project_id: string; service_dashboard_id: string | null; collaboration_enabled: boolean | null;
}

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
function parseJson<T>(raw: string): T | null {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t) as T; } catch { /* */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) as T; } catch { /* */ } }
  return null;
}

/**
 * Un passage : au plus UNE initiative, dans le premier service dont le rythme
 * l'autorise. Renvoie l'identifiant du message d'ouverture à faire répondre.
 */
export async function teamLifeTick(admin: Admin): Promise<{ messageId: string | null; note: string }> {
  const { data: dashes } = await admin.from("service_dashboards").select("id, settings").limit(200);
  const candidates = ((dashes ?? []) as Array<{ id: string; settings: Record<string, unknown> | null }>)
    .map((d) => ({ id: d.id, mode: String((d.settings ?? {}).team_life ?? "calm") }))
    .filter((d) => RHYTHM[d.mode]);
  // Un ordre différent à chaque passage : aucun service ne monopolise la place.
  candidates.sort(() => Math.random() - 0.5);

  for (const d of candidates) {
    const rhythm = RHYTHM[d.mode];
    const { data: life } = await admin.from("service_team_life").select("*").eq("dashboard_id", d.id).maybeSingle();
    const today = new Date().toISOString().slice(0, 10);
    const row = life as { last_attempt_at: string | null; day: string | null; attempts: number } | null;
    const attempts = row && row.day === today ? row.attempts : 0;
    if (attempts >= rhythm.perDay) continue;
    if (row?.last_attempt_at && Date.now() - new Date(row.last_attempt_at).getTime() < rhythm.gapMin * 60 * 1000) continue;

    const { data: ag } = await admin.from("internal_agents")
      .select("id, name, description, persona, instructions, workspace_id, project_id, service_dashboard_id, collaboration_enabled")
      .eq("service_dashboard_id", d.id).eq("is_archived", false).limit(40);
    const agents = ((ag ?? []) as Agent[]).filter((a) => a.collaboration_enabled !== false);
    if (agents.length < 2) continue;

    // On note la tentative AVANT l'appel au modèle : un passage qui plante ne
    // doit pas en déclencher un autre à la minute suivante.
    await admin.from("service_team_life").upsert({
      dashboard_id: d.id, last_attempt_at: new Date().toISOString(), day: today, attempts: attempts + 1,
    }, { onConflict: "dashboard_id" });

    // L'initiateur : un agent qui ne travaille pas en ce moment.
    const { data: busy } = await admin.from("internal_agent_runs").select("agent_id")
      .in("agent_id", agents.map((a) => a.id)).in("status", ["queued", "running"]);
    const busyIds = new Set((busy ?? []).map((b: { agent_id: string }) => b.agent_id));
    const idle = agents.filter((a) => !busyIds.has(a.id));
    if (!idle.length) return { messageId: null, note: `${d.id}: tout le monde travaille` };
    const me = idle[Math.floor(Math.random() * idle.length)];
    const others = agents.filter((a) => a.id !== me.id);

    const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const [selfModel, deliv, threads] = await Promise.all([
      loadSelfModel(admin, me),
      admin.from("internal_agent_deliverables").select("agent_id, name, created_at")
        .in("agent_id", agents.map((a) => a.id)).gte("created_at", since).order("created_at", { ascending: false }).limit(12),
      admin.from("internal_agent_a2a_threads").select("topic, updated_at")
        .or(`agent_a.eq.${me.id},agent_b.eq.${me.id}`).gte("updated_at", since).order("updated_at", { ascending: false }).limit(6),
    ]);
    const nameOf = new Map(agents.map((a) => [a.id, a.name]));
    const recentWork = ((deliv.data ?? []) as Array<{ agent_id: string; name: string; created_at: string }>)
      .map((x) => `- ${nameOf.get(x.agent_id) ?? "?"} a livré « ${clip(x.name, 90)} » (${x.created_at.slice(0, 10)})`).join("\n");
    const recentTopics = ((threads.data ?? []) as Array<{ topic: string | null }>).map((t) => t.topic).filter(Boolean)
      .map((t) => `- ${clip(t, 120)}`).join("\n");
    const roster = others.map((a) => `- ${a.name} [id: ${a.id}] — ${clip(a.description, 140) || "rôle non décrit"}`).join("\n");

    type R = { act?: boolean; kind?: string; to?: string; topic?: string; opener?: string; why?: string };
    const res = await callAi({
      task: "json_extraction",
      jsonMode: true,
      systemPrompt: [
        `Tu es ${me.persona || me.name}${me.description ? ` — ${clip(me.description, 200)}` : ""}.`,
        me.instructions ? `Ta façon de travailler (extrait) :\n${clip(me.instructions, 900)}` : "",
        selfModel,
        "Tu as un moment devant toi. Regarde ce qui se passe dans ton équipe et décide, TOI, s'il y a quelque chose qui mérite d'être dit à UN collègue maintenant :",
        "- idea : une idée concrète qui améliorerait le travail de l'équipe ou un livrable ;",
        "- challenge : une décision, une méthode ou un livrable récent qui te semble discutable — dis pourquoi ;",
        "- review : demander à un collègue de relire ton travail récent, ou proposer de relire le sien.",
        "Si rien d'utile ne se présente, ne dis rien (act: false) — le bavardage coûte et n'apporte rien.",
        "Réponds UNIQUEMENT en JSON : {act: boolean, kind: \"idea\"|\"challenge\"|\"review\", to: \"<id du collègue>\", topic: \"<sujet en une ligne>\", opener: \"<ton premier message, 120 mots max, direct et argumenté>\", why: \"<pourquoi maintenant>\"}.",
      ].filter(Boolean).join("\n\n"),
      userPrompt: [
        `## Tes collègues\n${roster}`,
        recentWork ? `## Livrables récents de l'équipe\n${recentWork}` : "## Livrables récents de l'équipe\n(aucun)",
        recentTopics ? `## Tes derniers échanges\n${recentTopics}` : "",
      ].filter(Boolean).join("\n\n"),
      maxTokens: 900,
      temperature: 0.7,
    });
    await logLlmUsage({
      workspace_id: me.workspace_id, project_id: me.project_id, provider: res.provider, model: res.model,
      task: "json_extraction", feature: "team-life", usage: res.usage,
    }).catch(() => {});
    const r = parseJson<R>(res.content);
    if (!r?.act || !r.opener?.trim() || !r.topic?.trim()) return { messageId: null, note: `${me.name} n'a rien jugé utile à dire` };
    const kind = r.kind === "challenge" || r.kind === "review" ? r.kind : "idea";
    const peer = others.find((a) => a.id === r.to) ?? others.find((a) => a.name.toLowerCase() === String(r.to ?? "").toLowerCase());
    if (!peer) return { messageId: null, note: `${me.name} visait un collègue introuvable` };

    const [aId, bId] = [me.id, peer.id].sort();
    const { data: existing } = await admin.from("internal_agent_a2a_threads").select("id").eq("agent_a", aId).eq("agent_b", bId).maybeSingle();
    let threadId = (existing as { id: string } | null)?.id ?? null;
    const topic = clip(r.topic, 300);
    if (threadId) {
      await admin.from("internal_agent_a2a_threads").update({ topic, updated_at: new Date().toISOString() }).eq("id", threadId);
    } else {
      const { data: th } = await admin.from("internal_agent_a2a_threads")
        .insert({ workspace_id: me.workspace_id, project_id: me.project_id, agent_a: aId, agent_b: bId, topic }).select("id").single();
      threadId = (th as { id: string } | null)?.id ?? null;
    }
    if (!threadId) return { messageId: null, note: "fil impossible à créer" };
    const { data: msg } = await admin.from("internal_agent_a2a_messages").insert({
      thread_id: threadId, workspace_id: me.workspace_id, project_id: me.project_id,
      from_agent: me.id, to_agent: peer.id, content: clip(r.opener, 1500), kind, turns_left: 3, initiated_by_agent: true,
    }).select("id").single();
    return { messageId: (msg as { id: string } | null)?.id ?? null, note: `${me.name} → ${peer.name} (${kind}) : ${topic}` };
  }
  return { messageId: null, note: "aucun service disponible" };
}

/**
 * Fin d'un échange : chacun des deux agents en tire — s'il y a lieu — UNE
 * leçon durable sur sa façon de travailler, rangée dans SA mémoire. C'est la
 * boucle qui fait qu'un challenge juste change la suite, au lieu de mourir
 * dans le fil.
 */
export async function distillLessons(admin: Admin, threadId: string, agentIds: string[]): Promise<number> {
  const { data: msgs } = await admin.from("internal_agent_a2a_messages").select("from_agent, content, created_at")
    .eq("thread_id", threadId).order("created_at", { ascending: false }).limit(10);
  const { data: th } = await admin.from("internal_agent_a2a_threads").select("topic").eq("id", threadId).maybeSingle();
  const { data: ags } = await admin.from("internal_agents").select("id, name, persona, workspace_id, project_id").in("id", agentIds);
  const agents = (ags ?? []) as Array<{ id: string; name: string; persona: string | null; workspace_id: string; project_id: string }>;
  const nameOf = new Map(agents.map((a) => [a.id, a.name]));
  const transcript = [...(msgs ?? [])].reverse()
    .map((m: { from_agent: string; content: string }) => `${nameOf.get(m.from_agent) ?? "?"} : ${clip(m.content, 900)}`).join("\n\n");
  let saved = 0;
  for (const a of agents) {
    try {
      const res = await callAi({
        task: "json_extraction",
        jsonMode: true,
        systemPrompt: `Tu es ${a.persona || a.name}. Tu viens de finir l'échange ci-dessous avec un collègue${(th as { topic?: string } | null)?.topic ? `, sur « ${(th as { topic: string }).topic} »` : ""}. ` +
          "En tires-tu UNE leçon durable pour ta propre façon de travailler — quelque chose que tu feras différemment, ou une erreur que tu ne referas pas ? " +
          "Seulement si l'échange t'a vraiment appris quelque chose : sinon, null. " +
          "Réponds en JSON : {lesson: \"<une phrase impérative, réutilisable hors de cet échange>\" | null}.",
        userPrompt: transcript,
        maxTokens: 300,
        temperature: 0.2,
      });
      await logLlmUsage({
        workspace_id: a.workspace_id, project_id: a.project_id, provider: res.provider, model: res.model,
        task: "json_extraction", feature: "team-life-lesson", usage: res.usage,
      }).catch(() => {});
      const lesson = parseJson<{ lesson?: string | null }>(res.content)?.lesson?.trim();
      if (!lesson || lesson.length < 12) continue;
      await admin.from("internal_agent_memories").insert({
        agent_id: a.id, workspace_id: a.workspace_id, project_id: a.project_id,
        kind: "learning", content: clip(lesson, 400), importance: 3, source: "agent",
      });
      saved++;
    } catch { /* une leçon manquée n'arrête rien */ }
  }
  return saved;
}
