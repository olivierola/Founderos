// Les outils des connecteurs d'applications comme ressources de pool (0293),
// en base : le catalogue des connecteurs maison, leurs connexions au registre,
// le risque des actions Composio, et la cohérence qui les reconnaît — sur une
// base PGlite neuve, socle + toutes les migrations.
//
// Lent (les migrations, ~20 s) : PLATFORM_E2E=0 le saute.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openDb, type Db } from "./db.ts";
import { migrateDatabase } from "./migrate.ts";

const skip = process.env.PLATFORM_E2E === "0";

type Issue = { severity: string; code: string; message: string };
type Reg = { id: string; status: string; risk: string; kind: string; name: string; service_dashboard_id: string | null; metadata: Record<string, unknown> };

describe("connecteurs d'applications : leurs outils sont des ressources de pool", { skip, timeout: 240_000 }, () => {
  let db: Db;
  const id: Record<string, string> = {};

  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params))[0];
  const reg = (source: string, sourceId: string, itemKey = "") => one<Reg>(
    "select id, status, risk, kind, name, service_dashboard_id, metadata from public.resource_registry where source = $1 and source_id = $2 and item_key = $3",
    [source, sourceId, itemKey]);
  const connector = async (provider: string, source: string, extra: { status?: string; scope?: string; metadata?: unknown; dash?: string | null; owner?: string | null } = {}) =>
    (await one<{ id: string }>(
      `insert into public.connectors (workspace_id, project_id, provider, source, status, scope, metadata, service_dashboard_id)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) returning id`,
      [id.ws, id.project, provider, source, extra.status ?? "connected", extra.scope ?? "project", JSON.stringify(extra.metadata ?? {}), extra.dash ?? null]))!.id;
  const newPool = async (name: string) =>
    (await one<{ id: string }>("insert into public.resource_pools (workspace_id, project_id, name) values ($1, $2, $3) returning id", [id.ws, id.project, name]))!.id;
  const add = (pool: string, registryId: string) =>
    db.command("insert into public.resource_pool_items (pool_id, registry_id) values ($1, $2)", [pool, registryId]);
  const issues = (pool: string) => db.query<Issue>("select severity, code, message from public.resource_pool_issues($1)", [pool]);

  before(async () => {
    db = await openDb("pglite://memory");
    await migrateDatabase(db);
    id.ws = (await one<{ id: string }>("insert into public.workspaces (name, slug) values ('Espace', 'espace-apps') returning id"))!.id;
    id.project = (await one<{ id: string }>("insert into public.projects (workspace_id, name, slug) values ($1, 'Projet', 'projet-apps') returning id", [id.ws]))!.id;
    id.agent = (await one<{ id: string }>(
      `insert into public.internal_agents (workspace_id, project_id, name, collaboration_enabled) values ($1, $2, 'Agent', true) returning id`,
      [id.ws, id.project]))!.id;
  });

  after(async () => { await db?.close(); });

  it("le catalogue des connecteurs maison est en base", async () => {
    const slack = await db.query<{ action: string; is_write: boolean }>(
      "select action, is_write from public.connector_action_catalog where provider = 'slack' order by action");
    assert.deepEqual(slack, [
      { action: "list_channels", is_write: false },
      { action: "post_message", is_write: true },
      { action: "post_webhook", is_write: true },
    ]);
  });

  it("une connexion maison partagée devient une source, une ligne par action, avec son risque", async () => {
    id.slack = await connector("slack", "in_house");
    const set = await reg("app_connector", id.slack);
    assert.equal(set?.kind, "toolset");
    assert.equal(set?.name, "Slack");
    assert.equal(set?.metadata.provider, "slack");
    assert.equal((await reg("app_connector", id.slack, "list_channels"))?.risk, "read");
    assert.equal((await reg("app_connector", id.slack, "post_message"))?.risk, "write");
    const kids = await db.query("select 1 from public.resource_registry where source = 'app_connector' and parent_id = $1", [set!.id]);
    assert.equal(kids.length, 3);
  });

  it("un fournisseur sans catalogue n'entre pas ; une connexion coupée devient indisponible, une connexion supprimée « removed »", async () => {
    const aws = await connector("aws", "in_house");
    assert.equal(await reg("app_connector", aws), undefined, "aucune action d'agent : rien à distribuer");

    await db.command("update public.connectors set status = 'needs_attention' where id = $1", [id.slack]);
    assert.equal((await reg("app_connector", id.slack))?.status, "unavailable");
    assert.equal((await reg("app_connector", id.slack, "post_message"))?.status, "unavailable");
    await db.command("update public.connectors set status = 'connected' where id = $1", [id.slack]);
    assert.equal((await reg("app_connector", id.slack))?.status, "active");

    const hub = await connector("hubspot", "in_house");
    assert.equal((await reg("app_connector", hub))?.status, "active");
    await db.command("delete from public.connectors where id = $1", [hub]);
    assert.equal((await reg("app_connector", hub))?.status, "removed");
  });

  it("une action Composio prend son risque des indications de Composio", async () => {
    id.gh = await connector("github", "composio", {
      metadata: {
        tools: [
          { slug: "GITHUB_LIST_ISSUES", name: "Lister", tags: ["readOnlyHint"] },
          { slug: "GITHUB_ARCHIVE_REPO", name: "Archiver", tags: ["destructiveHint"] },
          { slug: "GITHUB_STAR_REPO", name: "Étoiler" },
        ],
      },
    });
    assert.equal((await reg("composio", id.gh, "GITHUB_LIST_ISSUES"))?.risk, "read");
    assert.equal((await reg("composio", id.gh, "GITHUB_ARCHIVE_REPO"))?.risk, "destructive", "par l'indication, le nom ne le disait pas");
    assert.equal((await reg("composio", id.gh, "GITHUB_STAR_REPO"))?.risk, "write");
  });

  it("une automatisation qui appelle un connecteur maison est couverte par l'app ou par l'action dans le pool", async () => {
    const blocks = { nodes: [{ id: "t", type: "trigger", data: {} }, { id: "o", type: "tool", data: { provider: "slack", action: "post_message" } }], edges: [] };
    id.wf = (await one<{ id: string }>(
      `insert into public.agent_workflows (workspace_id, project_id, name, status, kind, blocks)
       values ($1, $2, 'Alerte Slack', 'active', 'automation', $3::jsonb) returning id`, [id.ws, id.project, JSON.stringify(blocks)]))!.id;
    const wf = (await reg("workflow", id.wf))!;

    const bare = await newPool("Sans Slack");
    await add(bare, wf.id);
    assert.ok((await issues(bare)).some((i) => i.code === "workflow_app_outside_pool"), "l'app manque");

    const wrong = await newPool("Mauvaise action");
    await add(wrong, wf.id);
    await add(wrong, (await reg("app_connector", id.slack, "list_channels"))!.id);
    assert.ok((await issues(wrong)).some((i) => i.code === "workflow_app_outside_pool"), "l'action utilisée n'est pas donnée");

    const action = await newPool("La bonne action");
    await add(action, wf.id);
    await add(action, (await reg("app_connector", id.slack, "post_message"))!.id);
    assert.ok(!(await issues(action)).some((i) => i.code === "workflow_app_outside_pool"), JSON.stringify(await issues(action)));

    const whole = await newPool("Tout Slack");
    await add(whole, wf.id);
    await add(whole, (await reg("app_connector", id.slack))!.id);
    assert.ok(!(await issues(whole)).some((i) => i.code === "workflow_app_outside_pool"));
  });

  it("un connecteur maison configuré sur l'agent : signalé s'il manque aux pools, repris par « Créer un pool depuis ses accès »", async () => {
    await db.command(
      "insert into public.internal_agent_tools (agent_id, kind, name, config) values ($1, 'connector_action', 'Slack', '{\"provider\":\"slack\"}')", [id.agent]);
    const pool = await newPool("Vide");
    await add(pool, (await reg("builtin", id.project, "web_search"))!.id);
    await db.command("insert into public.agent_resource_pools (agent_id, pool_id) values ($1, $2)", [id.agent, pool]);
    const mine = await db.query<Issue>("select severity, code, message from public.agent_resource_issues($1)", [id.agent]);
    assert.ok(mine.some((i) => i.code === "granular_ignored" && /Slack/.test(i.message)), JSON.stringify(mine));

    await add(pool, (await reg("app_connector", id.slack))!.id);
    const after = await db.query<Issue>("select severity, code, message from public.agent_resource_issues($1)", [id.agent]);
    assert.ok(!after.some((i) => i.code === "granular_ignored" && /Slack/.test(i.message)), JSON.stringify(after));

    const made = await one<{ r: { pool_id: string } }>("select public.resource_pool_from_agent($1, 'Depuis ses accès', false) as r", [id.agent]);
    const items = await db.query<{ source: string; item_key: string }>(
      `select reg.source, reg.item_key from public.resource_pool_items i join public.resource_registry reg on reg.id = i.registry_id where i.pool_id = $1`,
      [made!.r.pool_id]);
    assert.ok(items.some((i) => i.source === "app_connector" && i.item_key === ""), JSON.stringify(items));
    assert.ok(!items.some((i) => i.source === "builtin" && i.item_key === "connector_action"), "l'app, plus la famille entière");
  });

  it("« Resynchroniser » reprend les connexions maison", async () => {
    await db.command("delete from public.resource_registry where source = 'app_connector' and source_id = $1 and item_key = 'post_webhook'", [id.slack]);
    await one("select public.resource_registry_rebuild_internal($1)", [id.project]);
    assert.ok(await reg("app_connector", id.slack, "post_webhook"));
  });
});
