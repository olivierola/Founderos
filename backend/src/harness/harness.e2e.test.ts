// Harnais OpenCode, de bout en bout sur la plateforme locale : le vrai serveur
// (comme index.ts) sur une base PGlite neuve — toutes les migrations, 0307
// comprise —, un appel HTTP à internal-agent-run pour un agent marqué
// « opencode », et les lignes que le front lit vérifiées dans la base.
//
// Lent (les migrations, ~20 s) : PLATFORM_E2E=0 le saute.

const PORT = Number(process.env.HARNESS_E2E_PORT ?? 18791);
process.env.PLATFORM = "self";
process.env.DATABASE_URL = "pglite://memory";
process.env.JWT_SECRET = "e2e-secret-e2e-secret-e2e-secret-e2e-secret";
process.env.FUNCTIONS_URL = `http://localhost:${PORT}`;
process.env.STORAGE_DIR = `${process.env.TEMP ?? "/tmp"}/founderos-harness-e2e-${process.pid}`;
process.env.MGMT_PORT = "0";
delete process.env.AUTH_SMTP_HOST;
delete process.env.RESEND_API_KEY;

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";
import { fakeProviderConfig, startFakeLlm, type FakeLlm } from "./testing.ts";

const skip = process.env.PLATFORM_E2E === "0";

describe("harnais OpenCode sur la plateforme locale (HTTP ↔ OpenCode ↔ PostgreSQL)", { skip, timeout: 240_000 }, () => {
  let server: import("node:http").Server;
  let platform: import("../platform/platform.ts").Platform;
  let llm: FakeLlm;
  let dataDir: string;
  let stop: () => Promise<void>;
  let serviceKey: string;
  const id: Record<string, string> = {};

  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await platform.db.query<T>(sql, params))[0];

  before(async () => {
    const { env } = await import("../env.ts");
    const { startPlatform } = await import("../platform/platform.ts");
    const { createServer } = await import("../server.ts");
    const { createClient } = await import("@supabase/supabase-js");
    const { createHarness } = await import("./host.ts");
    const { startRuntime, stopRuntime } = await import("./runtime.ts");

    platform = await startPlatform({
      ...env.platform!, publicUrl: env.functionsUrl, anonKey: env.supabaseAnonKey, serviceKey: env.supabaseServiceRoleKey,
    }, () => {});
    server = createServer(undefined, { platform });
    await new Promise<void>((r) => server.listen(PORT, r));
    serviceKey = env.supabaseServiceRoleKey;

    llm = await startFakeLlm();
    dataDir = await mkdtemp(path.join(os.tmpdir(), "founderos-harness-e2e-"));
    const lookup = Plugin.define({
      id: "founderos-e2e",
      setup: async (ctx) => {
        await ctx.tool.transform((t) => {
          t.add({
            name: "founderos_lookup_client",
            options: { codemode: false },
            description: "Look up a FounderOS client record.",
            input: Schema.Struct({ name: Schema.String }),
            execute: async ({ name }) => ({ content: `Client ${name} : responsable = Léa Martin` }),
          });
        });
      },
    });
    const host = await createHarness({ dataDir, plugins: [lookup], config: fakeProviderConfig(llm.baseUrl) });
    const admin = createClient(env.functionsUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const rt = startRuntime(host, admin, serviceKey);
    // Un espace neuf n'a pas de crédits : le contrôle est testé ailleurs.
    rt.checkCredits = async () => {};
    stop = async () => { await stopRuntime(); await host.close(); };

    id.ws = (await one<{ id: string }>("insert into public.workspaces (name, slug) values ('Espace', 'espace-harness') returning id"))!.id;
    id.project = (await one<{ id: string }>("insert into public.projects (workspace_id, name, slug) values ($1, 'Projet', 'projet-harness') returning id", [id.ws]))!.id;
    id.agent = (await one<{ id: string }>(
      "insert into public.internal_agents (workspace_id, project_id, name, harness) values ($1, $2, 'Ops', 'opencode') returning id",
      [id.ws, id.project]))!.id;
    id.conv = (await one<{ id: string }>(
      "insert into public.internal_agent_conversations (agent_id, workspace_id, project_id, title) values ($1, $2, $3, 'Acme') returning id",
      [id.agent, id.ws, id.project]))!.id;
    await platform.db.command(
      "insert into public.internal_agent_messages (conversation_id, agent_id, role, content) values ($1, $2, 'user', 'Qui gère le client Acme ?')",
      [id.conv, id.agent]);
  });

  after(async () => {
    await stop?.();
    await llm?.close();
    await new Promise<void>((r) => server.close(() => r()));
    await platform.close();
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it("la colonne harness existe et refuse une valeur inconnue (0307)", async () => {
    await assert.rejects(platform.db.command("update public.internal_agents set harness = 'autre' where id = $1", [id.agent]));
  });

  it("un tour de chat : run, timeline, message de l'agent, consommation et session écrits en base", async () => {
    llm.script = [
      { tools: [{ id: "c1", name: "founderos_lookup_client", args: { name: "Acme" } }] },
      { text: "Léa Martin gère Acme." },
    ];
    const res = await fetch(`http://localhost:${PORT}/functions/v1/internal-agent-run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: id.agent, mode: "chat", conversation_id: id.conv }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const out = (await res.json()) as { run_id: string; queued?: boolean };
    assert.equal(out.queued, true);

    const end = Date.now() + 30_000;
    let run: Record<string, unknown> | undefined;
    while (Date.now() < end) {
      run = await one("select status, final_output, opencode_session_id, tokens_in, live_output from public.internal_agent_runs where id = $1", [out.run_id]);
      if (run?.status !== "running") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(run?.status, "succeeded");
    assert.equal(run?.final_output, "Léa Martin gère Acme.");
    assert.equal(run?.live_output, null);
    assert.ok(Number(run?.tokens_in) > 0);

    const conv = await one<{ opencode_session_id: string }>("select opencode_session_id from public.internal_agent_conversations where id = $1", [id.conv]);
    assert.equal(conv?.opencode_session_id, run?.opencode_session_id);

    const events = await platform.db.query<{ kind: string; payload: { tool?: string } }>(
      "select kind, payload from public.internal_agent_run_events where run_id = $1 order by created_at", [out.run_id]);
    assert.deepEqual(events.map((e) => `${e.kind}:${e.payload.tool}`), ["tool_call:founderos_lookup_client", "tool_result:founderos_lookup_client"]);

    const reply = await one<{ content: string; run_id: string }>(
      "select content, run_id from public.internal_agent_messages where conversation_id = $1 and role = 'assistant'", [id.conv]);
    assert.equal(reply?.content, "Léa Martin gère Acme.");
    assert.equal(reply?.run_id, out.run_id);

    const usage = await platform.db.query<{ metadata: Record<string, unknown> }>(
      "select metadata from public.llm_usage where metadata->>'run_id' = $1", [out.run_id]);
    assert.ok(usage.length >= 2, `${usage.length} ligne(s) de consommation`);
    assert.equal(usage[0].metadata.harness, "opencode");
  });
});
