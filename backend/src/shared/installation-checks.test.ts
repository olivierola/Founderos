// Diagnostic de l'installation (G4) : chaque brique en panne est nommée, avec
// sa cause et ce qu'il faut faire.

import "../test-env.ts";

import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { setEnvOverlay } from "../compat/index.ts";
import {
  checkApprovalKey, checkDatabase, checkEncryption, checkIdp, checkLlm, checkMcpServers, checkMetrics, checkOpa, checkRelays,
  checkSsoGuard, type CheckDeps,
} from "./installation-checks.ts";
import { approvalJwks } from "../edge/_shared/founderos-jwt.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Une base où chaque table rend ce qu'on lui dit (`missing` : table absente). */
function fakeAdmin(tables: Record<string, { data?: unknown; count?: number; missing?: boolean }>, rpc: Record<string, unknown> = {}) {
  return {
    from: (table: string) => {
      const t = tables[table] ?? {};
      const result = t.missing
        ? { data: null, count: null, error: { message: `relation "public.${table}" does not exist` } }
        : { data: t.data ?? [], count: t.count ?? 0, error: null };
      const q: any = { select: () => q, eq: () => q, limit: () => q, then: (r: any, j: any) => Promise.resolve(result).then(r, j) };
      return q;
    },
    rpc: async (name: string) => ({ data: rpc[name] ?? null, error: null }),
  } as any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Un fetch qui répond selon l'URL. */
function fakeFetch(routes: Array<[RegExp, (init?: RequestInit) => Response | Promise<Response>]>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const hit = routes.find(([re]) => re.test(url));
    if (!hit) throw new Error(`connect ECONNREFUSED ${url}`);
    return hit[1](init);
  }) as typeof fetch;
}

const deps = (over: Partial<CheckDeps> = {}): CheckDeps => ({
  admin: fakeAdmin({}), env: (k) => process.env[k], fetch: fakeFetch([]), functionsUrl: "http://backend.test",
  mgmtPort: 9090, authHeader: "Bearer user", workspaceId: "ws-1", timeoutMs: 2000, ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("base de données et migrations", () => {
  it("joignable et à jour", async () => {
    const r = await checkDatabase(deps({ admin: fakeAdmin({ workspaces: { count: 4 } }) }));
    assert.equal(r.status, "ok");
    assert.match(r.detail, /4 organisation/);
  });
  it("une migration absente est nommée", async () => {
    const r = await checkDatabase(deps({ admin: fakeAdmin({ workspaces: { count: 1 }, installation_settings: { missing: true } }) }));
    assert.equal(r.status, "error");
    assert.match(r.detail, /0283 \(installation_settings\)/);
    assert.match(r.fix ?? "", /migrations/);
  });
});

describe("secrets et signature", () => {
  it("sans clé de chiffrement : erreur, avec la commande pour la créer", async () => {
    const r = await checkEncryption(deps({ env: () => undefined }));
    assert.equal(r.status, "error");
    assert.match(r.fix ?? "", /openssl rand -base64 32/);
  });
  it("avec la clé : chiffrement et déchiffrement vérifiés", async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    assert.equal((await checkEncryption(deps())).status, "ok");
  });

  it("clé de signature : signature vérifiée et JWKS public servi ; JWKS injoignable : averti", async () => {
    process.env.APPROVAL_ISSUER = "https://founderos.test";
    process.env.APPROVAL_SIGNING_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwks = await approvalJwks();
    const ok = await checkApprovalKey(deps({ fetch: fakeFetch([[/approval-jwks$/, () => json(jwks)]]) }));
    assert.equal(ok.status, "ok", ok.detail);
    const down = await checkApprovalKey(deps({ fetch: fakeFetch([]) }));
    assert.equal(down.status, "warn");
    assert.match(down.detail, /injoignable/);
    const none = await checkApprovalKey(deps({ env: (k) => (k === "APPROVAL_ISSUER" ? undefined : process.env[k]) }));
    assert.equal(none.status, "warn");
  });
});

describe("passerelle LLM", () => {
  const withUpstream = async (fn: () => Promise<void>) => {
    setEnvOverlay({ LLM_UPSTREAM: "litellm", LLM_BASE_URL: "https://litellm.test/v1", LLM_MODEL_DEFAULT: "ops-default" });
    process.env.LLM_API_KEY = "sk-test";
    try { await fn(); } finally { setEnvOverlay({}); delete process.env.LLM_API_KEY; }
  };

  it("sans passerelle ni clé par défaut : erreur ; avec une clé par défaut : ok", async () => {
    assert.equal((await checkLlm(deps({ env: () => undefined }))).status, "error");
    assert.equal((await checkLlm(deps({ env: (k) => (k === "DEEPSEEK_API_KEY" ? "sk" : undefined) }))).status, "ok");
  });

  it("passerelle réglée à l'écran : un appel court ; clé refusée ou alias inconnu, la cause est dite", async () => {
    await withUpstream(async () => {
      let sent: any = null;
      const ok = await checkLlm(deps({ fetch: fakeFetch([[/litellm\.test\/v1\/chat\/completions$/, (init) => { sent = JSON.parse(String(init?.body)); return json({ choices: [] }); }]]) }));
      assert.equal(ok.status, "ok", ok.detail);
      assert.equal(sent.model, "ops-default");
      assert.equal(sent.max_tokens, 1);
      const denied = await checkLlm(deps({ fetch: fakeFetch([[/chat\/completions$/, () => json({ error: "invalid key" }, 401)]]) }));
      assert.equal(denied.status, "error");
      assert.match(denied.fix ?? "", /Clé refusée/);
      const unknown = await checkLlm(deps({ fetch: fakeFetch([[/chat\/completions$/, () => json({ error: "no alias" }, 404)]]) }));
      assert.match(unknown.fix ?? "", /Alias/);
      const unreachable = await checkLlm(deps({ fetch: fakeFetch([]) }));
      assert.match(unreachable.detail, /ECONNREFUSED/);
    });
  });
});

describe("IdP, garde SSO, relais, serveurs MCP, métriques, OPA", () => {
  it("un IdP qui se déclare sous un autre issuer est nommé", async () => {
    const admin = fakeAdmin({ enterprise_sso_providers: { data: [
      { name: "Entra", protocol: "oidc", issuer: "https://login.microsoftonline.com/t/v2.0" },
      { name: "Keycloak", protocol: "oidc", issuer: "https://kc.interne/realms/platform" },
    ] } });
    const r = await checkIdp(deps({ admin, fetch: fakeFetch([
      [/microsoftonline/, () => json({ issuer: "https://login.microsoftonline.com/t/v2.0" })],
      [/kc\.interne/, () => json({ issuer: "https://kc.interne/realms/autre" })],
    ]) }));
    assert.equal(r.status, "error");
    assert.match(r.detail, /Keycloak : l'IdP se déclare « https:\/\/kc\.interne\/realms\/autre »/);
    assert.doesNotMatch(r.detail, /Entra/);
    assert.equal((await checkIdp(deps())).status, "skipped");
  });

  it("garde SSO : vérifiée en mode partagé seulement", async () => {
    assert.equal((await checkSsoGuard(deps({ admin: fakeAdmin({}, { sso_guard_installed: true }) }), "shared")).status, "ok");
    assert.equal((await checkSsoGuard(deps({ admin: fakeAdmin({}, { sso_guard_installed: false }) }), "shared")).status, "error");
    assert.equal((await checkSsoGuard(deps(), "dedicated")).status, "skipped");
  });

  it("relais : en contact, en retard, sans contact", async () => {
    const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const run = (rows: unknown[]) => checkRelays(deps({ admin: fakeAdmin({ connector_relays: { data: rows } }) }));
    assert.equal((await run([{ name: "r1", last_seen_at: at(0.5) }])).status, "ok");
    assert.equal((await run([{ name: "r1", last_seen_at: at(10) }])).status, "warn");
    const down = await run([{ name: "r1", last_seen_at: at(0.5) }, { name: "r2", last_seen_at: null }]);
    assert.equal(down.status, "error");
    assert.match(down.detail, /r2 \(jamais vu\)/);
  });

  it("serveurs MCP : testés par mcp-gateway sous la session de la personne ; un serveur en panne est nommé", async () => {
    const admin = fakeAdmin({ mcp_servers: { data: [{ id: "s1", name: "cluster-prd" }, { id: "s2", name: "cluster-npr" }] } });
    const seen: string[] = [];
    const r = await checkMcpServers(deps({ admin, fetch: fakeFetch([[/mcp-gateway$/, (init) => {
      seen.push(String((init?.headers as Record<string, string>).Authorization));
      const id = JSON.parse(String(init?.body)).server_id;
      return id === "s1" ? json({ ok: true, count: 5 }) : json({ ok: false, error: "Jeton d'appel refusé : 401" });
    }]]) }));
    assert.equal(r.status, "warn");
    assert.match(r.detail, /cluster-prd : 5 tools/);
    assert.match(r.detail, /cluster-npr : Jeton d'appel refusé/);
    assert.deepEqual([...new Set(seen)], ["Bearer user"]);
  });

  it("métriques et OPA", async () => {
    const metrics = await checkMetrics(deps({ fetch: fakeFetch([[/127\.0\.0\.1:9090\/metrics$/, () => new Response("# HELP ai_tool_calls_total x\n")]]) }));
    assert.equal(metrics.status, "ok");
    assert.equal((await checkMetrics(deps({ mgmtPort: 0 }))).status, "skipped");
    assert.equal((await checkOpa(deps({ env: () => undefined }))).status, "skipped");
    const opa = await checkOpa(deps({ env: (k) => (k === "OPA_URL" ? "http://opa:8181" : undefined), fetch: fakeFetch([[/opa:8181\/health$/, () => new Response("{}", { status: 500 })]]) }));
    assert.equal(opa.status, "error");
  });
});
