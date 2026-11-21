// Le cadrage d'une mission par l'équipe d'agents (0295), de bout en bout : le
// vrai serveur auto-hébergé sur une base PGlite neuve (socle + toutes les
// migrations), supabase-js en face — comme dans la fonction —, et un modèle
// SIMULÉ qui répond, étape par étape, ce que répondraient le pilote, les
// relecteurs et les responsables d'équipe.
//
// Ce qui est vérifié : l'enchaînement des étapes et leur réservation, les
// questions à l'humain, le plan (items, calendrier, dépendances), la
// répartition par équipe (sous-tâches, assignations, équipage), le report des
// dépendances sur les sous-tâches, la file autonome au lancement, puis la vie
// d'équipe et les leçons qu'un échange laisse.
//
// Lent (les migrations, ~20 s) : PLATFORM_E2E=0 le saute.

const PORT = Number(process.env.MISSION_E2E_PORT ?? 18793);
process.env.PLATFORM = "self";
process.env.DATABASE_URL = "pglite://memory";
process.env.JWT_SECRET = "e2e-secret-e2e-secret-e2e-secret-e2e-secret";
process.env.FUNCTIONS_URL = `http://localhost:${PORT}`;
process.env.STORAGE_DIR = `${process.env.TEMP ?? "/tmp"}/founderos-mission-e2e-${process.pid}`;
process.env.MGMT_PORT = "0";
process.env.DEEPSEEK_API_KEY = "test-deepseek";
delete process.env.LLM_UPSTREAM;
delete process.env.AUTH_SMTP_HOST;
delete process.env.RESEND_API_KEY;

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const skip = process.env.PLATFORM_E2E === "0";

// ── Le modèle simulé ─────────────────────────────────────────────────────────
// Chaque appel est reconnu à sa consigne (le message système) ; la réponse est
// celle qu'un agent compétent donnerait, au format attendu.
const calls: string[] = [];
const reply = (system: string, user: string): unknown => {
  if (system.includes("Tu PILOTES le cadrage")) {
    calls.push("lead");
    return {
      understanding: "Produire une étude de marché exploitable pour décider du lancement.",
      approach: "Recherche, analyse, puis rédaction et visuels.",
      assumptions: ["Marché français uniquement"], risks: ["Données publiques rares"],
      questions: [{ question: "Quel budget pour les sources payantes ?", why: "Change la profondeur", suggestion: "Aucun" }],
    };
  }
  if (system.includes("CHALLENGE son analyse")) {
    calls.push("review");
    // Des points rendus en OBJETS, comme le fait parfois le modèle : ils doivent
    // s'afficher en phrases, jamais en « [object Object] ».
    return {
      challenges: [{ point: "Le calendrier est optimiste", why: "les pics du lundi ne sont pas chiffrés" }],
      additions: [{ title: "Ajouter une synthèse d'une page" }],
      questions: [], verdict: "Solide, à resserrer.",
    };
  }
  if (system.includes("CONSOLIDE le cadrage")) {
    calls.push("consolidate");
    return {
      summary: "**Objectif** — une étude de marché de 10 pages, avec synthèse.",
      decisions: ["Synthèse d'une page ajoutée"],
      questions: [{ question: "Quel budget pour les sources payantes ?", why: "Change la profondeur", suggestion: "Aucun" }],
    };
  }
  if (system.includes("Découpe la mission en WORK ITEMS")) {
    calls.push("plan");
    return {
      rationale: "La recherche d'abord, la rédaction ensuite.",
      items: [
        { key: "A1", title: "Recherche des sources", brief: "Rassembler 20 sources.", team_id: "t-data", priority: "high", hours: 2, depends_on: [] },
        { key: "A2", title: "Analyse des données", brief: "Dégager 5 tendances.", team_id: "t-data", priority: "high", hours: 3, depends_on: ["A1"] },
        { key: "B1", title: "Rédaction de l'étude", brief: "10 pages, synthèse comprise.", team_id: "t-content", priority: "medium", hours: 2, depends_on: ["A2"] },
        { key: "B2", title: "Visuels", brief: "4 graphiques.", team_id: "t-content", priority: "low", hours: 1, depends_on: [] },
        { key: "X9", title: "Équipe inconnue", brief: "Un item mal rangé.", team_id: "nope", hours: 1, depends_on: ["ZZ"] },
      ],
    };
  }
  if (system.includes("Tu animes l'équipe")) {
    calls.push("team");
    const issues = [...user.matchAll(/\[issue_id: ([0-9a-f-]{36})\]/g)].map((m) => m[1]);
    const agents = [...user.matchAll(/\[agent_id: ([0-9a-f-]{36})\]/g)].map((m) => m[1]);
    return {
      note: "Répartition selon les outils.",
      items: issues.map((issue_id, k) => k === 0
        ? { issue_id, subtasks: [
            { title: "Première moitié", brief: "La première moitié.", agent_id: agents[0], hours: 1 },
            { title: "Seconde moitié", brief: "La seconde moitié.", agent_id: agents[1] ?? agents[0], hours: 1 },
          ] }
        : { issue_id, agent_id: agents[agents.length - 1], brief: "Brief précisé par le responsable d'équipe." }),
    };
  }
  if (system.includes("Tu as un moment devant toi")) {
    calls.push("life");
    const to = /\[id: ([0-9a-f-]{36})\]/.exec(user)?.[1];
    return { act: true, kind: "idea", to, topic: "Mutualiser les sources", opener: "Et si on partageait une base de sources commune ?", why: "Deux équipes cherchent les mêmes données." };
  }
  if (system.includes("En tires-tu UNE leçon")) {
    calls.push("lesson");
    return { lesson: "Vérifier la base de sources commune avant toute recherche." };
  }
  calls.push("?");
  return {};
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.deepseek.com") || url.startsWith("https://api.groq.com")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const sys = String(body.messages?.[0]?.content ?? ""), usr = String(body.messages?.[1]?.content ?? "");
    return new Response(JSON.stringify({
      model: "deepseek-chat",
      choices: [{ message: { role: "assistant", content: JSON.stringify(reply(sys, usr)) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(input, init);
}) as typeof fetch;

describe("cadrage d'une mission par l'équipe d'agents (0295)", { skip, timeout: 300_000 }, () => {
  let server: import("node:http").Server;
  let platform: import("../platform/platform.ts").Platform;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let admin: any;
  let mp: typeof import("../edge/_shared/mission-planning.ts");
  let life: typeof import("../edge/_shared/team-life.ts");
  const id: Record<string, string> = {};

  before(async () => {
    const { env } = await import("../env.ts");
    const { startPlatform } = await import("../platform/platform.ts");
    const { createServer } = await import("../server.ts");
    const { createClient } = await import("@supabase/supabase-js");
    platform = await startPlatform({
      ...env.platform!, publicUrl: env.functionsUrl, anonKey: env.supabaseAnonKey, serviceKey: env.supabaseServiceRoleKey,
      // Pas de planificateur en arrière-plan : le test joue lui-même chaque étape.
      workers: false,
    }, () => {});
    server = createServer(undefined, { platform });
    await new Promise<void>((r) => server.listen(PORT, r));
    const opts = { auth: { persistSession: false, autoRefreshToken: false } };
    admin = createClient(env.functionsUrl, env.supabaseServiceRoleKey, opts);
    mp = await import("../edge/_shared/mission-planning.ts");
    life = await import("../edge/_shared/team-life.ts");

    // Un humain, pour signer ses réponses.
    const anon = createClient(env.functionsUrl, env.supabaseAnonKey, opts);
    const su = await anon.auth.signUp({ email: `mission-${Date.now()}@example.com`, password: "correct horse battery staple" });
    assert.equal(su.error, null, su.error?.message);
    id.user = su.data.user!.id;

    const one = async (table: string, row: Record<string, unknown>) => {
      const { data, error } = await admin.from(table).insert(row).select("id").single();
      assert.equal(error, null, `${table} : ${error?.message}`);
      return data.id as string;
    };
    id.ws = await one("workspaces", { name: "Espace", slug: `espace-${Date.now()}` });
    id.project = await one("projects", { workspace_id: id.ws, name: "Projet", slug: "projet" });
    // L'offre gratuite plafonne à deux agents : l'équipe en compte quatre.
    const { error: planErr } = await admin.from("workspace_subscriptions")
      .upsert({ workspace_id: id.ws, plan_code: "enterprise" }, { onConflict: "workspace_id" });
    assert.equal(planErr, null, planErr?.message);
    id.dash = await one("service_dashboards", { workspace_id: id.ws, project_id: id.project, name: "Études" });
    const agent = (name: string, description: string) => one("internal_agents", {
      workspace_id: id.ws, project_id: id.project, service_dashboard_id: id.dash, name, description,
      collaboration_enabled: true, mission_enabled: true,
    });
    id.nova = await agent("Nova", "Analyste de données");
    id.atlas = await agent("Atlas", "Chercheur documentaire");
    id.iris = await agent("Iris", "Rédactrice");
    id.lumen = await agent("Lumen", "Designer de visuels");
    await admin.from("internal_agent_tools").insert([
      { agent_id: id.atlas, kind: "builtin", name: "web_search", enabled: true },
      { agent_id: id.lumen, kind: "builtin", name: "generate_image", enabled: true },
    ]);
    const { error: setErr } = await admin.from("service_dashboards").update({
      settings: {
        team_life: "active",
        teams: [
          { id: "t-data", name: "Data", color: "#5fa8d3", agent_ids: [id.nova, id.atlas], lead_id: id.nova, focus: "Analyse" },
          { id: "t-content", name: "Contenu", color: "#e0a458", agent_ids: [id.iris, id.lumen], lead_id: id.iris, focus: "Rédaction" },
        ],
      },
    }).eq("id", id.dash);
    assert.equal(setErr, null, setErr?.message);
    id.mission = await one("pj_projects", {
      workspace_id: id.ws, project_id: id.project, dashboard_id: id.dash, name: "Étude de marché", identifier: "ETUDE",
      description: "Évaluer le marché avant lancement.", brief: "Une étude de marché complète du secteur, en français.",
      deliverables: [{ title: "Étude de 10 pages" }, { title: "Synthèse d'une page" }], planning_teams: [],
    });
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((r) => server.close(() => r()));
    await platform.close();
  });

  const mission = async () => (await admin.from("pj_projects").select("*").eq("id", id.mission).single()).data;
  const advanceUntil = async (stop: (m: { planning_status: string }) => boolean, max = 12) => {
    for (let k = 0; k < max; k++) {
      const out = await mp.advanceMission(admin, id.mission);
      const m = await mission();
      if (stop(m) || !out.next) return m;
    }
    return mission();
  };

  it("cadrage : analyse du pilote, challenges des autres équipes, questions à l'humain", async () => {
    await mp.startMissionPlanning(admin, id.mission, id.user);
    let m = await mission();
    assert.equal(m.planning_status, "scoping");
    assert.equal(m.planning_step, "lead");
    assert.equal(m.planning_lead_agent_id, id.nova, "le responsable de la première équipe pilote");

    // Une étape réservée par un autre appel ne se joue pas deux fois.
    await admin.from("pj_projects").update({ planning_step: "lead@run" }).eq("id", id.mission);
    assert.deepEqual(await mp.advanceMission(admin, id.mission), { next: false });
    await admin.from("pj_projects").update({ planning_step: "lead" }).eq("id", id.mission);

    m = await advanceUntil((x) => x.planning_status === "questions");
    assert.equal(m.planning_status, "questions", m.planning_error ?? "");
    assert.deepEqual(calls.slice(0, 4), ["lead", "review", "review", "consolidate"], "deux relecteurs : Iris (autre équipe) et Atlas");
    assert.match(m.planning_summary, /étude de marché de 10 pages/);

    const { data: qs } = await admin.from("pj_mission_questions").select("*").eq("pj_project_id", id.mission);
    assert.equal(qs.length, 1);
    assert.equal(qs[0].suggestion, "Aucun");
    const { data: thread } = await admin.from("pj_mission_discussion").select("kind, agent_id").eq("pj_project_id", id.mission).order("created_at");
    assert.deepEqual(thread.map((t: { kind: string }) => t.kind), ["note", "analysis", "challenge", "challenge", "decision", "question"]);
    assert.equal(thread[2].agent_id, id.iris);
    const { data: texts } = await admin.from("pj_mission_discussion").select("content").eq("pj_project_id", id.mission);
    for (const t of texts as Array<{ content: string }>) assert.ok(!t.content.includes("[object Object]"), t.content);
    assert.ok((texts as Array<{ content: string }>).some((t) => t.content.includes("Le calendrier est optimiste — les pics du lundi ne sont pas chiffrés")));
  });

  it("plan : work items, calendrier, dépendances, puis répartition équipe par équipe", async () => {
    await admin.from("pj_mission_questions").update({ status: "answered", answer: "500 € maximum", answered_by: id.user })
      .eq("pj_project_id", id.mission);
    await mp.resumeMission(admin, id.mission, id.user, false);
    const m = await advanceUntil((x) => x.planning_status === "planned");
    assert.equal(m.planning_status, "planned", m.planning_error ?? "");
    assert.ok(m.start_date && m.target_date, "la mission porte ses dates");

    const { data: issues } = await admin.from("pj_issues")
      .select("id, name, parent_id, team_id, agent_brief, start_date, target_date, estimate_hours, pj_issue_agents(agent_id)")
      .eq("pj_project_id", id.mission);
    type I = { id: string; name: string; parent_id: string | null; team_id: string; agent_brief: string; start_date: string; target_date: string; pj_issue_agents: Array<{ agent_id: string }> };
    const top = (issues as I[]).filter((i) => !i.parent_id);
    const kids = (issues as I[]).filter((i) => i.parent_id);
    assert.equal(top.length, 5, "les cinq items du plan");
    assert.equal(top.find((i) => i.name === "Équipe inconnue")!.team_id, "t-data", "une équipe inconnue retombe sur une équipe engagée");
    assert.equal(kids.length, 4, "chaque équipe découpe son premier item en deux");
    const byName = new Map(top.map((i) => [i.name, i]));
    assert.ok(byName.get("Rédaction de l'étude")!.start_date >= byName.get("Recherche des sources")!.start_date);

    // Chaque feuille a un agent de SON équipe ; les parents découpés n'en ont pas.
    const team = { "t-data": [id.nova, id.atlas], "t-content": [id.iris, id.lumen] } as Record<string, string[]>;
    const leaves = (issues as I[]).filter((i) => !(issues as I[]).some((c) => c.parent_id === i.id));
    for (const l of leaves) {
      assert.equal(l.pj_issue_agents.length, 1, `${l.name} : un agent`);
      assert.ok(team[l.team_id].includes(l.pj_issue_agents[0].agent_id), `${l.name} : un agent de l'équipe`);
    }
    const { data: crew } = await admin.from("pj_project_agents").select("agent_id, role").eq("pj_project_id", id.mission);
    assert.ok(crew.length >= 3 && crew.every((c: { role: string }) => c.role === "contributor"));

    // Les dépendances suivent les sous-tâches : A2 attend les deux moitiés de A1.
    const a1 = byName.get("Recherche des sources")!, a2 = byName.get("Analyse des données")!;
    const a1kids = kids.filter((k) => k.parent_id === a1.id).map((k) => k.id).sort();
    const { data: rels } = await admin.from("pj_issue_relations").select("issue_id, related_id").eq("relation_type", "blocked_by");
    const a2waits = (rels as Array<{ issue_id: string; related_id: string }>).filter((r) => r.issue_id === a2.id).map((r) => r.related_id).sort();
    assert.deepEqual(a2waits, a1kids);
    // B1 (découpé) attendait A2 : ses deux sous-tâches l'attendent aussi.
    const b1 = byName.get("Rédaction de l'étude")!;
    for (const k of kids.filter((x) => x.parent_id === b1.id)) {
      assert.ok((rels as Array<{ issue_id: string; related_id: string }>).some((r) => r.issue_id === k.id && r.related_id === a2.id));
    }
  });

  it("lancement : seules les tâches prêtes partent dans la file autonome", async () => {
    const armed = await mp.launchMission(admin, id.mission);
    // Data : deux moitiés de A1, A2, et l'item rangé chez elle faute d'équipe connue ; Contenu : deux moitiés de B1, B2.
    assert.equal(armed, 7, "les sept feuilles confiées à un agent, avec leur brief");
    assert.equal((await mission()).planning_status, "executing");
    const { data: queue, error } = await admin.rpc("pj_agent_autorun_queue", { p_cooldown: "0 minutes", p_limit: 50 });
    assert.equal(error, null, error?.message);
    const names = new Set(((queue ?? []) as Array<{ issue_name: string }>).map((q) => q.issue_name));
    assert.ok(names.has("Première moitié") && names.has("Visuels"), "ce qui n'attend rien part");
    assert.ok(!names.has("Analyse des données"), "A2 attend la recherche");
  });

  it("vie d'équipe : un agent prend la parole de lui-même, puis chacun tire sa leçon", async () => {
    const out = await life.teamLifeTick(admin);
    assert.ok(out.messageId, out.note);
    const { data: msg } = await admin.from("internal_agent_a2a_messages").select("*").eq("id", out.messageId).single();
    assert.equal(msg.kind, "idea");
    assert.equal(msg.initiated_by_agent, true);
    assert.equal(msg.turns_left, 3);
    const { data: pace } = await admin.from("service_team_life").select("attempts").eq("dashboard_id", id.dash).single();
    assert.equal(pace.attempts, 1);
    // Le rythme tient : pas de seconde initiative dans la foulée.
    assert.equal((await life.teamLifeTick(admin)).messageId, null);

    const saved = await life.distillLessons(admin, msg.thread_id, [msg.from_agent, msg.to_agent]);
    assert.equal(saved, 2);
    const { data: mem } = await admin.from("internal_agent_memories").select("kind, content").eq("agent_id", msg.from_agent);
    assert.ok(mem.some((r: { kind: string; content: string }) => r.kind === "learning" && /base de sources commune/.test(r.content)));
  });
});
