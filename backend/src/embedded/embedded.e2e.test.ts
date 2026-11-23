// Les agents embarqués (0316) sur la plateforme locale : le manifeste qu'on
// fige, l'archive du conteneur, et la passerelle /embedded/v1 qu'une instance
// appelle avec sa clé d'API, bornée à SON agent.
//
// Lent (les migrations) : PLATFORM_E2E=0 le saute.

const PORT = Number(process.env.EMBEDDED_E2E_PORT ?? 18793);
process.env.PLATFORM = "self";
process.env.DATABASE_URL = "pglite://memory";
process.env.JWT_SECRET = "e2e-secret-e2e-secret-e2e-secret-e2e-secret";
process.env.FUNCTIONS_URL = `http://localhost:${PORT}`;
process.env.STORAGE_DIR = `${process.env.TEMP ?? "/tmp"}/founderos-embedded-e2e-${process.pid}`;
process.env.MGMT_PORT = "0";
delete process.env.AUTH_SMTP_HOST;
delete process.env.RESEND_API_KEY;
// La connexion LLM de la plateforme (jamais appelée ici) : le manifeste en lit les routes.
Object.assign(process.env, {
  LLM_UPSTREAM: "litellm", LLM_BASE_URL: "http://127.0.0.1:9/v1", LLM_API_KEY: "test",
  LLM_MODEL_DEFAULT: "e2e-std", LLM_MODEL_HEAVY: "e2e-heavy", LLM_MODEL_LIGHT: "e2e-light",
});

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BlobReader, TextWriter, ZipReader } from "@zip.js/zip.js";

const skip = process.env.PLATFORM_E2E === "0";

describe("agents embarqués : manifeste, archive, passerelle", { skip, timeout: 240_000 }, () => {
  let server: import("node:http").Server;
  let platform: import("../platform/platform.ts").Platform;
  // deno-lint-ignore no-explicit-any
  let admin: any;
  let key = "";
  const id: Record<string, string> = {};

  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await platform.db.query<T>(sql, params))[0];
  const gw = async (path: string, body?: unknown, k = key) => {
    const res = await fetch(`http://localhost:${PORT}/embedded/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(k ? { Authorization: `Bearer ${k}` } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };

  before(async () => {
    const { env } = await import("../env.ts");
    const { startPlatform } = await import("../platform/platform.ts");
    const { createServer } = await import("../server.ts");
    const { createClient } = await import("@supabase/supabase-js");
    const { newKey } = await import("./keys.ts");
    const { resetUpstreamCaches } = await import("../edge/_shared/llm-upstream.ts");
    resetUpstreamCaches();

    platform = await startPlatform({
      ...env.platform!, publicUrl: env.functionsUrl, anonKey: env.supabaseAnonKey, serviceKey: env.supabaseServiceRoleKey,
    }, () => {});
    server = createServer(undefined, { platform });
    await new Promise<void>((r) => server.listen(PORT, r));
    admin = createClient(env.functionsUrl, env.supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

    id.ws = (await one<{ id: string }>("insert into public.workspaces (name, slug) values ('Espace', 'espace-emb') returning id"))!.id;
    id.project = (await one<{ id: string }>("insert into public.projects (workspace_id, name, slug) values ($1, 'Projet', 'projet-emb') returning id", [id.ws]))!.id;
    // L'offre gratuite plafonne les agents : ce test en crée plusieurs.
    await platform.db.command(
      `insert into public.workspace_subscriptions (workspace_id, plan_code) values ($1, 'enterprise')
       on conflict (workspace_id) do update set plan_code = 'enterprise'`, [id.ws]);
    id.board = (await one<{ id: string }>("insert into public.service_dashboards (workspace_id, project_id, name) values ($1, $2, 'Exploitation') returning id", [id.ws, id.project]))!.id;
    const agent = async (name: string, deployment: string) => (await one<{ id: string }>(
      `insert into public.internal_agents (workspace_id, project_id, service_dashboard_id, name, instructions, deployment)
       values ($1, $2, $3, $4, 'Tu surveilles les commandes en retard.', $5) returning id`,
      [id.ws, id.project, id.board, name, deployment]))!.id;
    id.agent = await agent("Agent ERP Lyon", "embedded");
    id.other = await agent("Ops", "platform");
    await platform.db.command(
      `insert into public.embedded_agent_configs (agent_id, workspace_id, project_id, service_dashboard_id, apt_packages, seed_files)
       values ($1, $2, $3, $4, '{jq}', $5::jsonb)`,
      [id.agent, id.ws, id.project, id.board, JSON.stringify([{ path: "config/erp.yaml", content: "site: lyon\n" }, { path: "../evasion.txt", content: "non" }])]);
    const conv = async (agentId: string) => (await one<{ id: string }>(
      "insert into public.internal_agent_conversations (agent_id, workspace_id, project_id, title) values ($1, $2, $3, 'Fil') returning id",
      [agentId, id.ws, id.project]))!.id;
    id.conv = await conv(id.agent);
    id.otherConv = await conv(id.other);
    id.run = (await one<{ id: string }>(
      "insert into public.internal_agent_runs (agent_id, workspace_id, project_id, conversation_id, status) values ($1, $2, $3, $4, 'running') returning id",
      [id.agent, id.ws, id.project, id.conv]))!.id;

    const k = newKey();
    key = k.key;
    id.key = (await one<{ id: string }>(
      "insert into public.embedded_agent_api_keys (agent_id, workspace_id, label, prefix, key_hash) values ($1, $2, 'serveur Lyon', $3, $4) returning id",
      [id.agent, id.ws, k.prefix, k.hash]))!.id;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await platform.close();
  });

  it("0316 : un agent est « platform » par défaut, et le choix est borné", async () => {
    const row = await one<{ deployment: string }>(
      "insert into public.internal_agents (workspace_id, project_id, name) values ($1, $2, 'Par défaut') returning deployment", [id.ws, id.project]);
    assert.equal(row!.deployment, "platform");
    await assert.rejects(platform.db.query(
      "insert into public.internal_agents (workspace_id, project_id, name, deployment) values ($1, $2, 'X', 'ailleurs')", [id.ws, id.project]));
  });

  it("le manifeste : l'agent et sa machine, sans secret, et une empreinte qui suit la configuration", async () => {
    const { compileManifest } = await import("./manifest.ts");
    const a = await compileManifest(admin, id.agent);
    assert.equal(a.manifest.agent.name, "Agent ERP Lyon");
    assert.equal(a.manifest.llm.route, "founderos");
    assert.equal(a.manifest.sync_level, "full");
    assert.deepEqual(a.manifest.machine.apt, ["jq"]);
    assert.match(a.manifest.system, /commandes en retard/);
    assert.ok(!a.manifest.tools.some((t) => /^team_/.test(t)), "les outils de team machine restent locaux");
    assert.doesNotMatch(JSON.stringify(a.manifest), /fos_emb_|key_hash|service_role/i);

    const again = await compileManifest(admin, id.agent);
    assert.equal(again.sha, a.sha, "même configuration, même empreinte");
    await platform.db.command("update public.embedded_agent_configs set sync_level = 'summary' where agent_id = $1", [id.agent]);
    const changed = await compileManifest(admin, id.agent);
    assert.notEqual(changed.sha, a.sha);
    assert.equal(changed.manifest.sync_level, "summary");
    assert.equal(changed.manifest.routes.standard, "e2e-std", "par FounderOS : les routes de la plateforme");
  });

  it("en accès direct : le modèle et l'adresse du client, même sans connexion de la plateforme", async () => {
    const { compileManifest } = await import("./manifest.ts");
    const { resetUpstreamCaches } = await import("../edge/_shared/llm-upstream.ts");
    await platform.db.command(
      "update public.embedded_agent_configs set llm_route = 'direct', llm_base_url = 'https://llm.client.example/v1', llm_model = 'client-model' where agent_id = $1", [id.agent]);
    const saved = process.env.LLM_UPSTREAM;
    delete process.env.LLM_UPSTREAM;
    resetUpstreamCaches();
    try {
      const { manifest } = await compileManifest(admin, id.agent);
      assert.equal(manifest.llm.route, "direct");
      assert.equal(manifest.llm.base_url, "https://llm.client.example/v1");
      assert.deepEqual(manifest.routes, { standard: "client-model" });
    } finally {
      process.env.LLM_UPSTREAM = saved;
      resetUpstreamCaches();
      await platform.db.command(
        "update public.embedded_agent_configs set llm_route = 'founderos', llm_base_url = null, llm_model = null where agent_id = $1", [id.agent]);
    }
  });

  it("l'archive : Dockerfile, compose, manifeste, .env sans clé, fichiers de départ dans /workspace", async () => {
    const { compileManifest } = await import("./manifest.ts");
    const { makeBundle } = await import("./bundle.ts");
    const { manifest, sha, config } = await compileManifest(admin, id.agent);
    const zip = await makeBundle({ manifest, sha, version: 3, config, founderosUrl: "https://founderos.example" });
    const reader = new ZipReader(new BlobReader(new Blob([zip as BlobPart])));
    const files: Record<string, string> = {};
    for (const e of await reader.getEntries()) if (!e.directory && e.getData) files[e.filename] = await e.getData(new TextWriter());
    await reader.close();
    const root = "agent-erp-lyon-v3";
    for (const f of ["Dockerfile", "compose.yaml", ".env.example", "manifest.json", "README.md", "workspace/config/erp.yaml"]) {
      assert.ok(`${root}/${f}` in files, `${f} manque : ${Object.keys(files).join(", ")}`);
    }
    assert.ok(!Object.keys(files).some((f) => f.includes("evasion")), "un chemin qui sort de /workspace est écarté");
    assert.match(files[`${root}/Dockerfile`], /ARG RUNTIME_IMAGE=founderos\/agent-runtime:1\nFROM \$\{RUNTIME_IMAGE\}/);
    assert.doesNotMatch(files[`${root}/Dockerfile`], /fos_emb_|API_KEY=/, "aucun secret dans l'image");
    assert.match(files[`${root}/Dockerfile`], /jq/);
    assert.match(files[`${root}/.env.example`], /FOUNDEROS_URL=https:\/\/founderos\.example/);
    assert.match(files[`${root}/.env.example`], /^FOUNDEROS_API_KEY=$/m);
    const m = JSON.parse(files[`${root}/manifest.json`]);
    assert.equal(m.sha, sha);
    assert.equal(m.version, 3);
  });

  it("la passerelle refuse sans clé, ou avec une clé inconnue", async () => {
    assert.equal((await gw("/manifest", undefined, "")).status, 401);
    assert.equal((await gw("/manifest", undefined, "fos_emb_" + "x".repeat(40))).status, 401);
  });

  it("l'instance s'annonce, bat, et lit son manifeste", async () => {
    const hello = await gw("/hello", { name: "lyon-1", manifest_sha: "abc", info: { host: "srv-lyon" } });
    assert.equal(hello.status, 200, JSON.stringify(hello.json));
    id.instance = String(hello.json!.instance_id);
    assert.equal(hello.json!.agent_id, id.agent);
    const inst = await one<{ status: string; last_seen_at: string | null; info: Record<string, unknown> }>(
      "select status, last_seen_at, info from public.embedded_agent_instances where id = $1", [id.instance]);
    assert.equal(inst!.status, "online");
    assert.ok(inst!.last_seen_at);
    assert.equal(inst!.info.host, "srv-lyon");

    // Une seconde annonce sous le même nom reprend la même instance.
    const again = await gw("/hello", { name: "lyon-1" });
    assert.equal(again.json!.instance_id, id.instance);

    assert.equal((await gw("/heartbeat", { instance_id: "" })).status, 400, "un battement sans instance est refusé");
    const beat = await gw("/heartbeat", { instance_id: id.instance, status: "paused" });
    assert.equal(beat.status, 200);
    assert.equal((await one<{ status: string }>("select status from public.embedded_agent_instances where id = $1", [id.instance]))!.status, "paused");

    const man = await gw("/manifest");
    assert.equal(man.status, 200);
    assert.equal((man.json!.manifest as { agent: { id: string } }).agent.id, id.agent);
    const used = await one<{ last_used_at: string | null }>("select last_used_at from public.embedded_agent_api_keys where id = $1", [id.key]);
    assert.ok(used!.last_used_at, "la clé note son dernier usage");
  });

  it("le pont d'écriture reste dans l'agent de la clé", async () => {
    const own = await gw("/store", { op: "recentMessages", args: [id.conv, 5] });
    assert.equal(own.status, 200);
    const foreign = await gw("/store", { op: "recentMessages", args: [id.otherConv, 5] });
    assert.equal(foreign.status, 403);
    const asOther = await gw("/store", { op: "agent", args: [id.other] });
    assert.equal(asOther.json!.result, null);
    const unknown = await gw("/store", { op: "dropEverything", args: [] });
    assert.equal(unknown.status, 400);

    // sync_level « summary » (posé plus haut) : la sortie remonte tronquée ; les champs hors liste sont ignorés.
    const long = "x".repeat(1000);
    const upd = await gw("/store", { op: "updateRun", args: [id.run, { final_output: long, agent_id: id.other }] });
    assert.equal(upd.status, 200, JSON.stringify(upd.json));
    const run = await one<{ final_output: string; agent_id: string }>("select final_output, agent_id from public.internal_agent_runs where id = $1", [id.run]);
    assert.equal(run!.agent_id, id.agent);
    assert.ok(run!.final_output.length <= 401, `tronquée : ${run!.final_output.length}`);
  });

  it("les ordres : pris une seule fois, dans l'ordre, puis marqués faits", async () => {
    await platform.db.command("insert into public.embedded_agent_commands (agent_id, command) values ($1, 'reload'), ($1, 'pause')", [id.agent]);
    await platform.db.command("insert into public.embedded_agent_commands (agent_id, command) values ($1, 'stop')", [id.other]);
    const first = await gw("/commands/take", { instance_id: id.instance });
    const cmd = first.json!.command as { id: number; command: string };
    assert.equal(cmd.command, "reload");
    const second = await gw("/commands/take", { instance_id: id.instance });
    assert.equal((second.json!.command as { command: string }).command, "pause");
    assert.equal((await gw("/commands/take", { instance_id: id.instance })).json!.command, null, "l'ordre d'un autre agent n'est pas servi");
    await gw("/commands/done", { id: cmd.id });
    const done = await one<{ done_at: string | null; instance_id: string | null }>("select done_at, instance_id from public.embedded_agent_commands where id = $1", [cmd.id]);
    assert.ok(done!.done_at);
    assert.equal(done!.instance_id, id.instance);
  });

  it("une clé révoquée ne sert plus", async () => {
    await platform.db.command("update public.embedded_agent_api_keys set revoked_at = now() where id = $1", [id.key]);
    assert.equal((await gw("/manifest")).status, 401);
  });
});
