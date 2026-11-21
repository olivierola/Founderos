// Teamz de bout en bout : le vrai serveur auto-hébergé sur une base PGlite
// neuve (socle + toutes les migrations, 0298 comprise), supabase-js en face,
// et un modèle SIMULÉ pour l'architecte.
//
// Ce qui est vérifié :
//   · installer une Teamz du catalogue crée ses agents COMPLETS (prompt
//     composé avec l'équipe et le flux, outils), pose l'équipe dans les
//     réglages du service avec ses liens traduits en agent_id, et planifie
//     ses routines ;
//   · un homonyme déjà présent dans le service ne bloque rien : le nouveau
//     prend le nom de l'équipe en suffixe, et les prompts le citent ainsi ;
//   · l'architecte conçoit une équipe d'une phrase, le contrôle qualité fait
//     réécrire le rôle trop faible, le plan est enregistré puis déployé, et ne
//     peut pas l'être deux fois ;
//   · l'outil des assistants (manage_teams) rend la carte d'équipe et les
//     cartes « Connecter » des apps manquantes.
//
// Lent (les migrations, ~20 s) : PLATFORM_E2E=0 le saute.

const PORT = Number(process.env.TEAMZ_E2E_PORT ?? 18794);
process.env.PLATFORM = "self";
process.env.DATABASE_URL = "pglite://memory";
process.env.JWT_SECRET = "e2e-secret-e2e-secret-e2e-secret-e2e-secret";
process.env.FUNCTIONS_URL = `http://localhost:${PORT}`;
process.env.STORAGE_DIR = `${process.env.TEMP ?? "/tmp"}/founderos-teamz-e2e-${process.pid}`;
process.env.MGMT_PORT = "0";
process.env.DEEPSEEK_API_KEY = "test-deepseek";
delete process.env.LLM_UPSTREAM;
delete process.env.AUTH_SMTP_HOST;
delete process.env.RESEND_API_KEY;

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const skip = process.env.PLATFORM_E2E === "0";

// ── Le modèle simulé ─────────────────────────────────────────────────────────
const calls: string[] = [];
const fullRole = (key: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
  key, name, role, persona: `${role} rigoureux.`, soul: "Précis, honnête, utile.",
  mission: `Prendre en charge ${role.toLowerCase()} pour l'équipe juridique, de la demande au livrable vérifié, en citant chaque source.`,
  responsibilities: ["Qualifier la demande", "Produire l'analyse", "Rendre compte"],
  method: ["Lire la demande", "Chercher les textes applicables", "Rédiger l'analyse", "Faire relire", "Livrer"],
  quality: ["Chaque affirmation est sourcée", "Le risque est chiffré"],
  limits: ["Jamais de signature", "Jamais d'envoi sans validation"],
  deliverables: ["Note d'analyse"],
  tools: [{ kind: "web_search" }],
  connectors: ["notion"],
  minutes_per_task: 40,
  ...extra,
});
const reply = (system: string): unknown => {
  if (system.includes("RÉÉCRIRE des fiches de rôle")) {
    calls.push("refine");
    return { members: [fullRole("paralegal", "Léa", "Paralégale")] };
  }
  if (system.includes("ARCHITECTE D'ÉQUIPES")) {
    calls.push("design");
    return {
      name: "Cellule Juridique", emoji: "⚖️", mission: "Sécuriser les contrats et la conformité de l'entreprise.", lead: "counsel",
      outcomes: ["Contrats relus en 48 h"], playbook: ["Rien ne part sans validation"],
      members: [
        fullRole("counsel", "Marc", "Juriste senior"),
        fullRole("compliance", "Inès", "Responsable conformité"),
        // Trop faible : pas de méthode, pas de limites → réécrit.
        { key: "paralegal", name: "Léa", role: "Paralégale", mission: "Aider.", tools: [] },
      ],
      links: [
        { from: "counsel", to: "paralegal", kind: "handoff", when: "un contrat arrive" },
        { from: "paralegal", to: "counsel", kind: "review", when: "la note est prête" },
        { from: "counsel", to: "compliance", kind: "consult", when: "un point RGPD se pose" },
      ],
      routines: [{ owner: "compliance", label: "Veille réglementaire", cron: "0 9 * * 1", prompt: "Fais la veille réglementaire de la semaine." }],
      plugs: [{ slug: "notion", name: "Notion", why: "base juridique", required: true }],
      kickoff: { title: "Audit des contrats", brief: "Recense les contrats en cours et leurs échéances." },
    };
  }
  calls.push("?");
  return {};
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.deepseek.com") || url.startsWith("https://api.groq.com")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const sys = String(body.messages?.[0]?.content ?? "");
    return new Response(JSON.stringify({
      model: "deepseek-chat",
      choices: [{ message: { role: "assistant", content: JSON.stringify(reply(sys)) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(input, init);
}) as typeof fetch;

describe("Teamz : installer, concevoir, déployer (0298)", { skip, timeout: 300_000 }, () => {
  let server: import("node:http").Server;
  let platform: import("../platform/platform.ts").Platform;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let admin: any;
  let arch: typeof import("../edge/_shared/team-architect.ts");
  let teamz: typeof import("../edge/_shared/teamz.ts");
  let catalog: typeof import("../edge/_shared/teamz-catalog.ts");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let actor: any;
  const id: Record<string, string> = {};

  before(async () => {
    const { env } = await import("../env.ts");
    const { startPlatform } = await import("../platform/platform.ts");
    const { createServer } = await import("../server.ts");
    const { createClient } = await import("@supabase/supabase-js");
    platform = await startPlatform({
      ...env.platform!, publicUrl: env.functionsUrl, anonKey: env.supabaseAnonKey, serviceKey: env.supabaseServiceRoleKey,
      workers: false,
    }, () => {});
    server = createServer(undefined, { platform });
    await new Promise<void>((r) => server.listen(PORT, r));
    const opts = { auth: { persistSession: false, autoRefreshToken: false } };
    admin = createClient(env.functionsUrl, env.supabaseServiceRoleKey, opts);
    arch = await import("../edge/_shared/team-architect.ts");
    teamz = await import("../edge/_shared/teamz.ts");
    catalog = await import("../edge/_shared/teamz-catalog.ts");

    const anon = createClient(env.functionsUrl, env.supabaseAnonKey, opts);
    const su = await anon.auth.signUp({ email: `teamz-${Date.now()}@example.com`, password: "correct horse battery staple" });
    assert.equal(su.error, null, su.error?.message);
    id.user = su.data.user!.id;

    const one = async (table: string, row: Record<string, unknown>) => {
      const { data, error } = await admin.from(table).insert(row).select("id").single();
      assert.equal(error, null, `${table} : ${error?.message}`);
      return data.id as string;
    };
    id.ws = await one("workspaces", { name: "Espace", slug: `espace-${Date.now()}` });
    id.project = await one("projects", { workspace_id: id.ws, name: "Projet", slug: "projet" });
    const { error: planErr } = await admin.from("workspace_subscriptions")
      .upsert({ workspace_id: id.ws, plan_code: "enterprise" }, { onConflict: "workspace_id" });
    assert.equal(planErr, null, planErr?.message);
    id.dash = await one("service_dashboards", { workspace_id: id.ws, project_id: id.project, name: "Support" });
    // Un homonyme déjà là : « Nora » existe dans le service.
    id.oldNora = await one("internal_agents", {
      workspace_id: id.ws, project_id: id.project, service_dashboard_id: id.dash, name: "Nora", description: "Ancienne",
    });
    actor = {
      admin, workspaceId: id.ws, projectId: id.project, dashboardId: id.dash, roomId: null,
      userId: id.user, role: "owner", agentId: null, agentName: "Teamz",
    };
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((r) => server.close(() => r()));
    await platform.close();
  });

  it("installe une Teamz du catalogue : agents complets, équipe, flux, routines", async () => {
    const t = catalog.findTeamzTemplate("support-desk")!;
    const res = await arch.deployTeam(actor, teamz.blueprintFromTemplate(t), { service: id.dash, tzOffsetMinutes: -60 });
    assert.equal(res.agents.length, 4);
    assert.deepEqual(res.notes, []);

    const names = res.agents.map((a) => a.name);
    assert.ok(names.includes("Nora · Support Desk 24/7"), `homonyme suffixé : ${names.join(", ")}`);
    const { data: agents } = await admin.from("internal_agents")
      .select("id, name, instructions, soul, persona, accent_color").in("id", res.agents.map((a) => a.id));
    const sam = agents.find((a: { name: string }) => a.name === "Sam");
    assert.match(sam.instructions, /## TA PLACE DANS LE FLUX \(A2A\)/);
    assert.match(sam.instructions, /Nora · Support Desk 24\/7 anime l'équipe/, "le prompt cite le nom définitif");
    assert.ok(sam.soul && sam.persona);
    assert.equal(sam.accent_color, t.accent);

    const { data: tools } = await admin.from("internal_agent_tools").select("agent_id, kind").in("agent_id", res.agents.map((a) => a.id));
    const kindsOf = (agentId: string) => tools.filter((x: { agent_id: string }) => x.agent_id === agentId).map((x: { kind: string }) => x.kind).sort();
    assert.deepEqual(kindsOf(res.agents.find((a) => a.key === "resolver")!.id), ["rag_search", "support"]);

    const { data: board } = await admin.from("service_dashboards").select("settings").eq("id", id.dash).single();
    const team = board.settings.teams.find((x: { id: string }) => x.id === res.team.id);
    assert.ok(team, "l'équipe est dans les réglages");
    assert.equal(team.lead_id, res.agents.find((a) => a.lead)!.id);
    assert.equal(team.links.length, t.links.length);
    for (const l of team.links) assert.ok(team.agent_ids.includes(l.from) && team.agent_ids.includes(l.to), "liens en agent_id");
    assert.equal(team.template_key, "support-desk");

    const { data: missions } = await admin.from("internal_agent_missions")
      .select("title, schedule, next_run_at, status").in("agent_id", res.agents.map((a) => a.id));
    assert.equal(missions.length, 2);
    assert.ok(missions.every((m: { status: string; next_run_at: string }) => m.status === "active" && Date.parse(m.next_run_at) > Date.now()));
    assert.deepEqual(missions.map((m: { schedule: string }) => m.schedule).sort(), ["daily", "weekly"]);
    // Aucune app n'est connectée : toutes celles des membres restent à brancher.
    assert.ok(res.missingPlugs.includes("intercom"));
  });

  it("conçoit une équipe d'une phrase, fait réécrire le rôle faible, puis la déploie une seule fois", async () => {
    const design = await arch.designTeam({
      admin, workspaceId: id.ws, projectId: id.project,
      brief: "Monte une équipe juridique qui relit nos contrats et suit la conformité RGPD",
    });
    assert.deepEqual(calls.filter((c) => c !== "?"), ["design", "refine"]);
    assert.equal(design.origin, "architect");
    assert.deepEqual(design.refined, ["Léa"]);
    assert.equal(design.lint.members.find((m) => m.name === "Léa")!.score, 100);
    assert.equal(design.blueprint.members.find((m) => m.lead)!.name, "Marc");

    const blueprintId = await arch.saveBlueprint(actor, design, id.dash);
    assert.ok(blueprintId, "plan enregistré (0298)");
    const res = await arch.runTeamOps(actor, "deploy", { blueprint_id: blueprintId });
    assert.match(res.text, /Équipe « Cellule Juridique » créée/);
    const card = res.ui?.find((b) => b.component === "team_blueprint");
    assert.ok(card, "carte d'équipe");
    assert.equal((card!.props.deployed as { agents: unknown[] }).agents.length, 3);
    const plugs = res.ui?.find((b) => b.component === "connectors");
    assert.ok(plugs, "cartes Connecter pour les apps manquantes");
    assert.equal((plugs!.props.agent_ids as string[]).length, 3);

    const { data: row } = await admin.from("agent_team_blueprints").select("status, agent_ids, team_id").eq("id", blueprintId).single();
    assert.equal(row.status, "deployed");
    assert.equal(row.agent_ids.length, 3);

    const again = await arch.runTeamOps(actor, "deploy", { blueprint_id: blueprintId });
    assert.match(again.text, /déjà été déployé/);
  });

  it("un lecteur ne peut pas créer d'équipe", async () => {
    const res = await arch.runTeamOps({ ...actor, role: "viewer" }, "install", { template: "exec-office" });
    assert.match(res.text, /ACCÈS REFUSÉ/);
  });
});
