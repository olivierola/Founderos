// La passerelle de ressources (0291), en base : le registre suit ses sources,
// les pools restent dans leur périmètre, et la cohérence est tenue — sur une
// base PGlite neuve, socle + toutes les migrations.
//
// Lent (les migrations, ~20 s) : PLATFORM_E2E=0 le saute.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openDb, type Db } from "./db.ts";
import { migrateDatabase } from "./migrate.ts";

const skip = process.env.PLATFORM_E2E === "0";

type Issue = { severity: string; code: string; message: string; pool_id: string | null; registry_id: string | null; agent_id: string | null };

describe("passerelle de ressources : registre, pools, cohérence", { skip, timeout: 240_000 }, () => {
  let db: Db;
  const id: Record<string, string> = {};

  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params))[0];
  const issuesOfPool = (pool: string) => db.query<Issue>("select * from public.resource_pool_issues($1)", [pool]);
  const issuesOfAgent = (agent: string) => db.query<Issue>("select * from public.agent_resource_issues($1)", [agent]);
  const reg = (source: string, sourceId: string, itemKey = "") =>
    one<{ id: string; status: string; risk: string; kind: string; service_dashboard_id: string | null; metadata: Record<string, unknown> }>(
      "select id, status, risk, kind, service_dashboard_id, metadata from public.resource_registry where source = $1 and source_id = $2 and item_key = $3",
      [source, sourceId, itemKey]);
  const newPool = async (name: string, service: string | null) =>
    (await one<{ id: string }>(
      "insert into public.resource_pools (workspace_id, project_id, service_dashboard_id, name) values ($1, $2, $3, $4) returning id",
      [id.ws, id.project, service, name]))!.id;
  const add = (pool: string, registryId: string) =>
    db.command("insert into public.resource_pool_items (pool_id, registry_id) values ($1, $2)", [pool, registryId]);
  const assign = (agent: string, pool: string) =>
    db.command("insert into public.agent_resource_pools (agent_id, pool_id) values ($1, $2)", [agent, pool]);
  const rejects = async (p: Promise<unknown>, re: RegExp) => {
    await assert.rejects(p, (e: Error) => { assert.match(e.message, re); return true; });
  };

  before(async () => {
    db = await openDb("pglite://memory");
    await migrateDatabase(db);

    id.ws = (await one<{ id: string }>("insert into public.workspaces (name, slug) values ('Espace', 'espace-rp') returning id"))!.id;
    id.project = (await one<{ id: string }>("insert into public.projects (workspace_id, name, slug) values ($1, 'Projet', 'projet') returning id", [id.ws]))!.id;
    // L'offre gratuite plafonne à un service : celui-ci en a besoin de deux.
    await db.command(
      `insert into public.workspace_subscriptions (workspace_id, plan_code) values ($1, 'enterprise')
       on conflict (workspace_id) do update set plan_code = 'enterprise'`, [id.ws]);
    id.s1 = (await one<{ id: string }>("insert into public.service_dashboards (workspace_id, project_id, name) values ($1, $2, 'Support') returning id", [id.ws, id.project]))!.id;
    id.s2 = (await one<{ id: string }>("insert into public.service_dashboards (workspace_id, project_id, name) values ($1, $2, 'Infra') returning id", [id.ws, id.project]))!.id;
    const agent = async (name: string, service: string, orchestrator = false) => (await one<{ id: string }>(
      `insert into public.internal_agents (workspace_id, project_id, service_dashboard_id, name, is_orchestrator, collaboration_enabled)
       values ($1, $2, $3, $4, $5, true) returning id`, [id.ws, id.project, service, name, orchestrator]))!.id;
    id.a = await agent("Assistant", id.s1, true);
    id.b = await agent("Bérénice", id.s1);
    id.c = await agent("Cyrus", id.s2);

    id.mcp = (await one<{ id: string }>(
      `insert into public.mcp_servers (workspace_id, name, url, cached_tools) values ($1, 'openshift-prd', 'https://mcp.example/mcp', $2::jsonb) returning id`,
      [id.ws, JSON.stringify([{ name: "pods_list" }, { name: "deployment_restart", annotations: { destructiveHint: true } }, { name: "scale_deployment" }])]))!.id;
    id.mcp2 = (await one<{ id: string }>(
      `insert into public.mcp_servers (workspace_id, name, url, cached_tools) values ($1, 'argocd', 'https://argo.example/mcp', '[]'::jsonb) returning id`, [id.ws]))!.id;
    id.custom = (await one<{ id: string }>(
      `insert into public.custom_connectors (workspace_id, project_id, service_dashboard_id, name, slug, status, operations)
       values ($1, $2, $3, 'Helpdesk', 'helpdesk', 'active', $4::jsonb) returning id`,
      [id.ws, id.project, id.s1, JSON.stringify([{ name: "get_ticket", description: "Lire", risk: "read" }, { name: "close_ticket", description: "Clore", risk: "write" }])]))!.id;
    id.composio = (await one<{ id: string }>(
      `insert into public.connectors (workspace_id, project_id, provider, source, status, scope, metadata)
       values ($1, $2, 'github', 'composio', 'connected', 'project', $3::jsonb) returning id`,
      [id.ws, id.project, JSON.stringify({ tools: [{ slug: "github_create_an_issue", name: "Créer une issue" }] })]))!.id;
    id.rag = (await one<{ id: string }>(
      "insert into public.rag_collections (workspace_id, project_id, name) values ($1, $2, 'Procédures internes') returning id", [id.ws, id.project]))!.id;
    id.guard = (await one<{ id: string }>(
      "insert into public.aiops_guardrails (workspace_id, project_id, title, body) values ($1, $2, 'Pas de PII', 'Jamais de numéro de carte') returning id", [id.ws, id.project]))!.id;
    const blocks = {
      nodes: [
        { id: "t", type: "trigger", data: {} },
        { id: "s1", type: "step", data: { label: "Analyser", agent_id: id.b, refs: [{ kind: "collection", id: id.rag, label: "Procédures internes" }] } },
        { id: "h1", type: "handoff", data: { agent_ids: [id.c] } },
        { id: "o1", type: "tool", data: { tool: "mcp", mcp: [{ server_id: id.mcp, server_name: "openshift-prd", tools: ["pods_list"] }] } },
        { id: "o2", type: "tool", data: { provider: "github", action: "GITHUB_CREATE_AN_ISSUE" } },
      ],
      edges: [],
    };
    id.wf = (await one<{ id: string }>(
      `insert into public.agent_workflows (workspace_id, project_id, service_dashboard_id, name, status, kind, blocks)
       values ($1, $2, $3, 'Incident client', 'active', 'procedure', $4::jsonb) returning id`,
      [id.ws, id.project, id.s1, JSON.stringify(blocks)]))!.id;
  });

  after(async () => { await db?.close(); });

  it("le registre suit chaque source connectée, avec sa liste d'outils", async () => {
    const builtin = await db.query("select item_key from public.resource_registry where source = 'builtin' and source_id = $1", [id.project]);
    assert.equal(builtin.length, 17, "les familles intégrées sont posées à la création du projet");

    assert.equal((await reg("mcp", id.mcp))?.kind, "toolset");
    assert.equal((await reg("mcp", id.mcp, "pods_list"))?.risk, "read");
    assert.equal((await reg("mcp", id.mcp, "deployment_restart"))?.risk, "destructive", "annotation destructiveHint");
    assert.equal((await reg("mcp", id.mcp, "scale_deployment"))?.risk, "write");

    const custom = await reg("custom_connector", id.custom, "close_ticket");
    assert.equal(custom?.risk, "write");
    assert.equal(custom?.service_dashboard_id, id.s1, "un outil customisé réservé à un service le reste dans le registre");

    assert.equal((await reg("composio", id.composio))?.metadata.toolkit, "github");
    assert.ok(await reg("composio", id.composio, "GITHUB_CREATE_AN_ISSUE"), "les actions en cache deviennent des outils");
    assert.equal((await reg("rag", id.rag))?.kind, "knowledge");
    assert.equal((await reg("guardrail", id.guard))?.kind, "guardrail");
    assert.equal((await reg("agent", id.c))?.service_dashboard_id, id.s2);

    const wf = await reg("workflow", id.wf);
    assert.equal(wf?.kind, "procedure");
    assert.deepEqual([...(wf!.metadata.agent_ids as string[])].sort(), [id.b, id.c].sort());
    assert.deepEqual(wf!.metadata.collection_ids, [id.rag]);
    assert.deepEqual(wf!.metadata.apps, [{ provider: "github", action: "GITHUB_CREATE_AN_ISSUE" }]);
  });

  it("un outil qui disparaît de sa source passe « removed », une source désactivée « unavailable »", async () => {
    await db.command("update public.mcp_servers set cached_tools = $2::jsonb where id = $1",
      [id.mcp, JSON.stringify([{ name: "pods_list" }, { name: "deployment_restart", annotations: { destructiveHint: true } }])]);
    assert.equal((await reg("mcp", id.mcp, "scale_deployment"))?.status, "removed");
    assert.equal((await reg("mcp", id.mcp, "pods_list"))?.status, "active");

    await db.command("update public.mcp_servers set enabled = false where id = $1", [id.mcp2]);
    assert.equal((await reg("mcp", id.mcp2))?.status, "unavailable");
    await db.command("update public.mcp_servers set enabled = true where id = $1", [id.mcp2]);
  });

  it("une procédure qui fait intervenir des agents, un serveur MCP, une app ou une collection hors du pool est une erreur", async () => {
    id.pool1 = await newPool("Support — incidents", id.s1);
    await add(id.pool1, (await reg("workflow", id.wf))!.id);
    const codes = (await issuesOfPool(id.pool1)).filter((i) => i.severity === "error").map((i) => i.code).sort();
    assert.deepEqual(codes, [
      "workflow_agent_outside_pool", "workflow_agent_outside_pool",
      "workflow_app_outside_pool", "workflow_knowledge_outside_pool", "workflow_tool_outside_pool",
    ]);
  });

  it("un pool incohérent ne se donne pas ; une fois complété, il se donne", async () => {
    await rejects(assign(id.a, id.pool1), /resource_pool_incoherent/);

    await add(id.pool1, (await reg("agent", id.b))!.id);
    await add(id.pool1, (await reg("agent", id.c))!.id);
    // Un outil précis du serveur suffit, puisque la procédure ne cite que lui.
    await add(id.pool1, (await reg("mcp", id.mcp, "pods_list"))!.id);
    await add(id.pool1, (await reg("composio", id.composio))!.id);
    await add(id.pool1, (await reg("rag", id.rag))!.id);
    assert.deepEqual((await issuesOfPool(id.pool1)).filter((i) => i.severity === "error"), []);
    await assign(id.a, id.pool1);
  });

  it("le périmètre est gardé : service du pool, service de l'agent, ressource disparue", async () => {
    const projectWide = await newPool("Projet entier", null);
    await rejects(add(projectWide, (await reg("custom_connector", id.custom))!.id), /réservée à un autre service/);
    await rejects(add(projectWide, (await reg("mcp", id.mcp, "scale_deployment"))!.id), /n'existe plus/);
    await rejects(assign(id.c, id.pool1), /réservé à un autre service/);
  });

  it("l'A2A doit être réciproque entre agents en mode pools", async () => {
    // Bérénice passe en mode pools sans avoir l'Assistant : elle ne pourrait
    // ni lui répondre ni lui rendre compte.
    const poolB = await newPool("Bérénice", id.s1);
    await add(poolB, (await reg("builtin", id.project, "web_search"))!.id);
    await assign(id.b, poolB);
    const recip = (await issuesOfAgent(id.a)).filter((i) => i.code === "a2a_not_reciprocal");
    assert.equal(recip.length, 1);
    assert.equal(recip[0].agent_id, id.b);
    // Cyrus n'a aucun pool : il garde l'A2A d'avant, rien à signaler.

    await add(poolB, (await reg("agent", id.a))!.id);
    assert.equal((await issuesOfAgent(id.a)).filter((i) => i.code === "a2a_not_reciprocal").length, 0);
    // Bérénice, elle, est sollicitée par la procédure sans l'avoir dans ses pools.
    assert.ok((await issuesOfAgent(id.b)).some((i) => i.code === "workflow_targets_agent"));
  });

  it("les accès granulaires hors pools sont signalés comme ignorés", async () => {
    await db.command("insert into public.agent_mcp_servers (agent_id, server_id) values ($1, $2)", [id.a, id.mcp2]);
    const ignored = (await issuesOfAgent(id.a)).filter((i) => i.code === "granular_ignored");
    assert.equal(ignored.length, 1);
    assert.match(ignored[0].message, /argocd/);
  });

  it("une source supprimée laisse une erreur dans le pool qui la contenait", async () => {
    const pool = await newPool("Helpdesk", id.s1);
    await add(pool, (await reg("custom_connector", id.custom, "get_ticket"))!.id);
    await db.command("delete from public.custom_connectors where id = $1", [id.custom]);
    const removed = (await issuesOfPool(pool)).filter((i) => i.code === "item_removed");
    assert.equal(removed.length, 1);
    assert.equal((await reg("custom_connector", id.custom, "get_ticket"))?.status, "removed");
  });

  it("un pool se fait à partir des accès actuels d'un agent, et ne se donne que s'il est cohérent", async () => {
    id.d = (await one<{ id: string }>(
      `insert into public.internal_agents (workspace_id, project_id, service_dashboard_id, name, collaboration_enabled)
       values ($1, $2, $3, 'Dalia', true) returning id`, [id.ws, id.project, id.s2]))!.id;
    await db.command("insert into public.agent_mcp_servers (agent_id, server_id) values ($1, $2)", [id.d, id.mcp]);
    await db.command(
      "insert into public.internal_agent_tools (agent_id, kind, name, config) values ($1, 'web_search', 'Recherche', '{}'), ($1, 'composio_toolkit', 'Use GitHub', '{\"toolkit\":\"github\"}')",
      [id.d]);
    const out = (await one<{ r: { pool_id: string; assigned: boolean; errors: string[] } }>(
      "select public.resource_pool_from_agent($1, null, true) as r", [id.d]))!.r;
    assert.equal(out.assigned, true, out.errors.join(" · "));
    const keys = (await db.query<{ source: string; item_key: string; source_id: string }>(
      `select r.source, r.item_key, r.source_id from public.resource_pool_items i join public.resource_registry r on r.id = i.registry_id where i.pool_id = $1`,
      [out.pool_id])).map((r) => `${r.source}:${r.source === "agent" ? r.source_id : r.item_key}`).sort();
    assert.deepEqual(keys, [`agent:${id.c}`, "builtin:web_search", "composio:", "mcp:"].sort());

    // Cyrus (service Infra) reçoit une passation de la procédure du service
    // Support : son pool généré l'inclut, mais elle fait intervenir Bérénice, un
    // serveur MCP, une app et une collection qu'il n'a pas — le pool reste à
    // corriger, non attribué, et la réponse dit pourquoi.
    const outC = (await one<{ r: { assigned: boolean; errors: string[] } }>(
      "select public.resource_pool_from_agent($1, 'Cyrus', true) as r", [id.c]))!.r;
    assert.equal(outC.assigned, false);
    assert.ok(outC.errors.some((e) => /Incident client/.test(e)), outC.errors.join(" · "));
  });

  it("le rapport du projet rassemble pools et agents", async () => {
    const report = await db.query<Issue>("select * from public.resource_coherence_report($1)", [id.project]);
    const codes = new Set(report.map((r) => r.code));
    for (const c of ["item_removed", "granular_ignored", "workflow_targets_agent"]) assert.ok(codes.has(c), c);
  });
});
