// Les agents embarqués (0316) sur la plateforme locale : le manifeste qu'on
// fige, l'archive du conteneur, et la passerelle /embedded/v1 qu'une instance
// appelle avec sa clé d'API, bornée à SON agent.
//
// Lent (les migrations) : PLATFORM_E2E=0 le saute.

const PORT = Number(process.env.EMBEDDED_E2E_PORT ?? 18796);
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
    const { LOCAL_ONLY } = await import("./manifest.ts");
    assert.ok(!a.manifest.tools.some((t) => LOCAL_ONLY.test(t)), "les outils de team machine restent locaux");
    assert.ok(LOCAL_ONLY.test("team_shell") && !LOCAL_ONLY.test("team_memory"), "la mémoire d'équipe passe la passerelle");
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
    for (const f of ["Dockerfile", "compose.yaml", ".env.example", "manifest.json", "knowledge.jsonl", "README.md", "workspace/config/erp.yaml"]) {
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

  it("un workflow confié à l'instance : run en file, liaisons en base, ordre « run »", async () => {
    const { startAgentRun } = await import("../harness/runs.ts");
    const { supabaseStore } = await import("../harness/store.ts");
    const { usageToLlm } = await import("../harness/runtime.ts");
    const rt = { store: supabaseStore(admin, usageToLlm) } as never;
    const out = await startAgentRun(rt, {
      agentId: id.agent, kind: "workflow", text: "Relance les commandes en retard de plus de 3 jours.",
      meta: { workflow_run: { id: "00000000-0000-0000-0000-000000000001" } }, via: "workflow",
    });
    assert.equal(out.queued, true);
    id.wfRun = out.run_id;
    const run = await one<{ status: string; run_meta: Record<string, unknown> }>("select status, run_meta from public.internal_agent_runs where id = $1", [id.wfRun]);
    assert.equal(run!.status, "queued");
    assert.equal(run!.run_meta.kind, "workflow");
    assert.deepEqual(run!.run_meta.workflow_run, { id: "00000000-0000-0000-0000-000000000001" });
    const cmd = await one<{ command: string; payload: Record<string, unknown> }>(
      "select command, payload from public.embedded_agent_commands where agent_id = $1 and command = 'run' order by id desc limit 1", [id.agent]);
    assert.equal(cmd!.payload.kind, "workflow");
    assert.equal(cmd!.payload.run_id, id.wfRun);
    assert.match(String(cmd!.payload.run_context ?? ""), /run_context|commandes/i);
  });

  it("le conteneur reprend le run sans réécrire ses liaisons ; il ne crée pas de run hors d'une conversation", async () => {
    const took = await gw("/store", { op: "createRun", args: [{ runId: id.wfRun, conversationId: null, sessionId: "ses_wf", via: "workflow", meta: { kind: "workflow", workflow_run: { id: "autre" } } }] });
    assert.equal(took.status, 200, JSON.stringify(took.json));
    const run = await one<{ status: string; opencode_session_id: string; run_meta: Record<string, unknown> }>(
      "select status, opencode_session_id, run_meta from public.internal_agent_runs where id = $1", [id.wfRun]);
    assert.equal(run!.status, "running");
    assert.equal(run!.opencode_session_id, "ses_wf");
    assert.deepEqual(run!.run_meta.workflow_run, { id: "00000000-0000-0000-0000-000000000001" }, "les liaisons restent celles de la plateforme");
    const loose = await gw("/store", { op: "createRun", args: [{ conversationId: null, sessionId: "ses_x", via: "a2a" }] });
    assert.equal(loose.status, 403);
  });

  it("la plateforme conduit les runs du conteneur : étape, fin de run, question", async () => {
    await platform.db.command("update public.embedded_agent_configs set sync_level = 'full' where agent_id = $1", [id.agent]);
    const ref = { run_id: id.wfRun, session_id: "ses_wf" };
    const foreign = (await one<{ id: string }>(
      "insert into public.internal_agent_runs (agent_id, workspace_id, project_id, status) values ($1, $2, $3, 'running') returning id",
      [id.other, id.ws, id.project]))!.id;
    assert.equal((await gw("/runs/step", { run_id: foreign, session_id: "s", trail: [], steps: 1, cost_usd: 0 })).status, 403);
    const step = await gw("/runs/step", { ...ref, trail: [{ name: "grep", args: {}, ok: true, result: "3 lignes" }], steps: 1, cost_usd: 0.001, heavy: "e2e-heavy" });
    assert.equal(step.status, 200, JSON.stringify(step.json));
    assert.ok(Array.isArray(step.json!.actions));

    // La réponse annonce un déploiement sans appel qui le prouve : la plateforme demande une reprise.
    const outcome = (text: string) => ({ status: "succeeded", text, tokensIn: 10, tokensOut: 5, costUsd: 0, toolCalls: 1, model: { id: "m", provider: "p" }, trail: [] });
    const retry = await gw("/runs/settle", { ...ref, outcome: outcome("J'ai bien déployé la nouvelle version.") });
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(retry.json!.next, "continue");
    const prompt = (retry.json!.actions as Array<{ type: string; text?: string }>).find((a) => a.type === "prompt");
    assert.match(String(prompt?.text), /VÉRIFICATION ÉCHOUÉE/);

    const done = await gw("/runs/settle", { ...ref, outcome: outcome("Trois commandes relancées, le détail est dans le journal.") });
    assert.equal(done.json!.next, "done");
    const run = await one<{ status: string; final_output: string }>("select status, final_output from public.internal_agent_runs where id = $1", [id.wfRun]);
    assert.equal(run!.status, "succeeded");
    assert.match(run!.final_output, /Trois commandes relancées/);

    // Une question dans un tour de chat : le run attend la personne, la question est dans la conversation.
    const chatRun = (await one<{ id: string }>(
      "insert into public.internal_agent_runs (agent_id, workspace_id, project_id, conversation_id, status, run_meta) values ($1, $2, $3, $4, 'running', '{\"kind\":\"chat\"}') returning id",
      [id.agent, id.ws, id.project, id.conv]))!.id;
    const asked = await gw("/runs/question", { run_id: chatRun, session_id: "ses_chat", question: { formId: "f1", title: "Quel entrepôt ?", fields: [{ key: "q", title: "Entrepôt", options: ["Lyon", "Lille"] }] } });
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    const waiting = await one<{ status: string; pending_question: Record<string, unknown> }>("select status, pending_question from public.internal_agent_runs where id = $1", [chatRun]);
    assert.equal(waiting!.status, "awaiting_input");
    assert.deepEqual(waiting!.pending_question.options, ["Lyon", "Lille"]);
    const msg = await one<{ content: string }>("select content from public.internal_agent_messages where run_id = $1 order by created_at desc limit 1", [chatRun]);
    assert.match(msg!.content, /Quel entrepôt/);
  });

  it("au niveau « statuts et coûts », la réponse reste sur l'instance", async () => {
    await platform.db.command("update public.embedded_agent_configs set sync_level = 'metadata' where agent_id = $1", [id.agent]);
    const chatRun = (await one<{ id: string }>(
      "insert into public.internal_agent_runs (agent_id, workspace_id, project_id, conversation_id, status, run_meta) values ($1, $2, $3, $4, 'running', '{\"kind\":\"chat\"}') returning id",
      [id.agent, id.ws, id.project, id.conv]))!.id;
    const settled = await gw("/runs/settle", {
      run_id: chatRun, session_id: "ses_m",
      outcome: { status: "succeeded", text: "Le client Durand doit 4 200 €.", tokensIn: 1, tokensOut: 1, costUsd: 0, toolCalls: 0, model: { id: "m", provider: "p" }, trail: [] },
    });
    assert.equal(settled.json!.next, "done", JSON.stringify(settled.json));
    const rows = await platform.db.query<{ content: string }>("select content from public.internal_agent_messages where run_id = $1", [chatRun]);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => !/Durand|4 200/.test(r.content)), JSON.stringify(rows));
    const run = await one<{ status: string; final_output: string | null }>("select status, final_output from public.internal_agent_runs where id = $1", [chatRun]);
    assert.equal(run!.status, "succeeded");
    assert.doesNotMatch(String(run!.final_output ?? ""), /Durand/);
  });

  it("la connaissance embarquée : ce que l'agent lit en ligne, cherché de la même façon hors ligne", async () => {
    const { knowledgeSnapshot, localIndex } = await import("./knowledge.ts");
    const { buildPatterns } = await import("../harness/toolkit/grep.ts");
    const collA = "11111111-1111-4111-8111-111111111111";
    const collB = "22222222-2222-4222-8222-222222222222";
    const otherProject = (await one<{ id: string }>("insert into public.projects (workspace_id, name, slug) values ($1, 'Autre', 'autre-emb') returning id", [id.ws]))!.id;
    const put = (type: string, content: string, o: { project?: string | null; agent?: string | null; coll?: string; title?: string; at?: string } = {}) =>
      platform.db.command(
        `insert into public.search_index (workspace_id, project_id, agent_id, type, source_table, source_id, grp, path, title, content, meta, updated_at)
         values ($1, $2, $3, $4, 'e2e', gen_random_uuid(), gen_random_uuid()::text, $4 || '/e2e', $5, $6, $7::jsonb, coalesce($8::timestamptz, now()))`,
        [id.ws, o.project === undefined ? id.project : o.project, o.agent ?? null, type, o.title ?? null, content,
          JSON.stringify(o.coll ? { collection_id: o.coll } : {}), o.at ?? null]);
    await put("documents", "Procédure de facturation : la facture part le 5.", { coll: collA, title: "Facturation", at: "2026-11-01" });
    await put("documents", "Les avoirs suivent la facture initiale.", { coll: collA, at: "2026-11-02" });
    await put("documents", "Facture confidentielle d'une autre équipe.", { coll: collB });
    await put("documents", "Facture d'un autre projet.", { coll: collA, project: otherProject });
    await put("memory", "Durand veut ses factures en papier.", { agent: id.agent });
    await put("memory", "Mémoire d'un autre agent sur les factures.", { agent: id.other });

    const scope = { workspaceId: id.ws, projectId: id.project, agentId: id.agent, collections: [collA] };
    const snap = await knowledgeSnapshot(admin, { ...scope, tools: ["search_knowledge", "search_memory"] });
    const contents = snap.rows.map((r) => r.content).join(" | ");
    assert.equal(snap.rows.length, 3, contents);
    assert.doesNotMatch(contents, /confidentielle|autre projet|autre agent/);
    const none = await knowledgeSnapshot(admin, { ...scope, tools: [] });
    assert.equal(none.rows.length, 0, "un agent sans outil de recherche n'embarque rien");

    // Hors ligne comme en ligne : mêmes lignes, même ordre, mêmes scores.
    const local = localIndex(snap.rows);
    for (const [pattern, mode] of [["factur", "any"], ["facture avoirs", "all"], ["facture avoirs", "any"], ["papier", "any"]] as const) {
      const p = buildPatterns(pattern, mode);
      if (typeof p === "string") throw new Error(p);
      const args = { types: ["documents", "memory"], regexes: p.regexes, all: p.all, path: null, limit: 50, offset: 0 };
      const { data, error } = await admin.rpc("search_grep", {
        p_workspace: id.ws, p_project: id.project, p_agent: id.agent, p_collections: [collA],
        p_types: args.types, p_regexes: args.regexes, p_all: args.all, p_path: null, p_limit: 50, p_offset: 0,
      });
      assert.equal(error, null);
      const online = (data as Array<{ id: string; score: number }>).map((r) => `${r.id}:${r.score}`);
      const offline = (await local.grep(args)).map((r) => `${r.id}:${r.score}`);
      assert.deepEqual(offline, online, `${pattern} (${mode})`);
    }

    // La passerelle sert l'instantané à jour quand l'option est active.
    await platform.db.command("update public.embedded_agent_configs set knowledge_snapshot = true where agent_id = $1", [id.agent]);
    const served = await gw("/knowledge/snapshot");
    assert.equal(served.status, 200, JSON.stringify(served.json));
    assert.equal(served.json!.enabled, true);
  });

  it("le journal d'une instance isolée s'importe sous l'agent, une seule fois, au niveau de synchronisation choisi", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { localStore } = await import("./local-store.ts");
    const { importJournal } = await import("./import.ts");
    const { syncText } = await import("./gateway.ts");
    const dir = await mkdtemp(path.join(os.tmpdir(), "fos-import-"));
    try {
      // Le journal porte d'autres identifiants d'espace et de projet : l'import les ignore.
      const local = await localStore({ agent: { id: "ailleurs", name: "x", workspace_id: "w", project_id: "p", harness: "opencode" }, file: path.join(dir, "j.jsonl"), instanceName: "site-lyon" });
      const conv = await local.createConversation("Inventaire");
      await local.addUserMessage(conv, "Combien de palettes ?");
      const run = await local.store.createRun({ agent: { id: "ailleurs", name: "x", workspace_id: "w", project_id: "p", harness: "opencode" }, conversationId: conv, sessionId: "s", via: "chat" });
      await local.store.insertEvent(run, "ailleurs", "status", { message: "recherche" });
      await local.store.updateRun(run, { status: "succeeded", final_output: "42 palettes chez Durand." });
      await local.store.insertAssistantMessage({ conversationId: conv, agentId: "ailleurs", runId: run, content: "42 palettes chez Durand.", tokensIn: 3, tokensOut: 4, costUsd: 0 });
      const orphan = await local.store.createRun({ agent: { id: "ailleurs", name: "x", workspace_id: "w", project_id: "p", harness: "opencode" }, conversationId: conv, sessionId: "s2", via: "chat" });
      const text = await local.journal();

      const agentRow = { id: id.agent, workspace_id: id.ws, project_id: id.project };
      const first = await importJournal(admin, { agent: agentRow, text, sync: (t) => syncText("metadata", t) });
      assert.deepEqual({ ...first }, { conversations: 1, messages: 2, runs: 2, events: 1, instance: "site-lyon" });
      const again = await importJournal(admin, { agent: agentRow, text, sync: (t) => syncText("metadata", t) });
      assert.deepEqual([again.conversations, again.messages, again.runs, again.events], [0, 0, 0, 0], "réimporter n'ajoute rien");

      const c = await one<{ agent_id: string; workspace_id: string }>("select agent_id, workspace_id from public.internal_agent_conversations where id = $1", [conv]);
      assert.equal(c!.agent_id, id.agent);
      assert.equal(c!.workspace_id, id.ws);
      const msgs = await platform.db.query<{ role: string; content: string }>("select role, content from public.internal_agent_messages where conversation_id = $1 order by created_at", [conv]);
      assert.equal(msgs[0].content, "Combien de palettes ?", "les messages de la personne restent");
      assert.doesNotMatch(msgs[1].content, /Durand/, "la réponse suit le niveau « statuts et coûts »");
      const r = await one<{ status: string; final_output: string; run_meta: Record<string, unknown> }>("select status, final_output, run_meta from public.internal_agent_runs where id = $1", [run]);
      assert.equal(r!.status, "succeeded");
      assert.doesNotMatch(r!.final_output, /Durand/);
      assert.equal(r!.run_meta.isolated, true);
      const o = await one<{ status: string }>("select status from public.internal_agent_runs where id = $1", [orphan]);
      assert.equal(o!.status, "failed", "un run resté en cours sur l'instance est clos à l'import");
      await assert.rejects(importJournal(admin, { agent: agentRow, text: "pas un journal", sync: (t) => t }), /vide ou illisible/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("un agent embarqué avec des outils du catalogue : ils entrent dans son conteneur", async () => {
    const { compileManifest } = await import("./manifest.ts");
    const { dockerfile } = await import("./bundle.ts");
    // 0318 : la sélection d'outils se garde sur les machines du parc comme sur les agents embarqués.
    await platform.db.query("select tools from public.machines limit 0");
    const before = await compileManifest(admin, id.agent);
    assert.deepEqual(before.manifest.machine.catalog_tools, [], "sans outil, le manifeste ne change pas");
    await platform.db.command("update public.embedded_agent_configs set tools = '{data-analysis,defsec-sast}' where agent_id = $1", [id.agent]);
    const { manifest, config, sha } = await compileManifest(admin, id.agent);
    assert.deepEqual([...manifest.machine.catalog_tools].sort(), ["data-analysis", "defsec-sast"]);
    assert.notEqual(sha, before.sha, "changer d'outils se voit sur l'empreinte");
    const df = dockerfile(manifest, config);
    assert.match(df, /Outils du catalogue : .*Analyse de données/);
    assert.match(df, /pip3 install .*'pandas'/);
    assert.match(df, /'semgrep'/);
    assert.ok(df.indexOf("'pandas'") < df.indexOf("COPY manifest.json"), "les outils avant la configuration");
    await platform.db.command("update public.embedded_agent_configs set tools = '{}' where agent_id = $1", [id.agent]);
  });

  it("la machine d'une instance apparaît dans le parc, décrite par son conteneur", async () => {
    const { machineInfo } = await import("./machine-info.ts");
    const { embeddedMachines } = await import("../edge/machines/index.ts");
    const os = await import("node:os");
    await platform.db.command("update public.embedded_agent_configs set tools = '{defsec-logs}', connectivity = 'connected' where agent_id = $1", [id.agent]);
    const info = await machineInfo({ workspaceDir: os.tmpdir(), version: "agent-runtime 1", tools: ["defsec-logs"], built: true });
    const beat = await gw("/heartbeat", { instance_id: id.instance, status: "online", info });
    assert.equal(beat.status, 200, JSON.stringify(beat.json));

    const fleet = await embeddedMachines(admin, { id: id.board });
    const mine = fleet.find((m) => m.id === id.instance);
    assert.ok(mine, "l'instance est dans le parc du service");
    assert.equal(mine!.agent_name, "Agent ERP Lyon");
    assert.equal(mine!.status, "online");
    assert.equal(mine!.connectivity, "connected");
    assert.deepEqual(mine!.tools, ["defsec-logs"]);
    const shown = mine!.info as { cpus?: number; mem?: { total_kb: number }; version?: string };
    assert.ok((shown.cpus ?? 0) > 0 && (shown.mem?.total_kb ?? 0) > 0, "mêmes jauges qu'une machine d'équipe");
    assert.equal(shown.version, "agent-runtime 1");
    // Un autre service ne voit pas cette machine.
    assert.deepEqual(await embeddedMachines(admin, { id: "00000000-0000-0000-0000-000000000000" }), []);
    await platform.db.command("update public.embedded_agent_configs set tools = '{}' where agent_id = $1", [id.agent]);
  });

  it("une clé révoquée ne sert plus", async () => {
    await platform.db.command("update public.embedded_agent_api_keys set revoked_at = now() where id = $1", [id.key]);
    assert.equal((await gw("/manifest")).status, 401);
  });
});
