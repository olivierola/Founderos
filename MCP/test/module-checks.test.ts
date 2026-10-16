// Vérifications de disponibilité des modules : chaque outil répond avec
// l'identifiant configuré. Un outil qui refuse le jeton fait échouer la
// vérification avec une cause lisible, sans jamais exposer le secret.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { SecretResolver } from "../src/lib/secrets.ts";
import type { ReadinessCheck, ServerModule } from "../src/lib/server.ts";
import { argocdServer } from "../src/servers/argocd.ts";
import { fleetServer } from "../src/servers/fleet.ts";
import { gitServer } from "../src/servers/git.ts";
import { observabilityServer } from "../src/servers/observability.ts";
import { prtgServer } from "../src/servers/prtg.ts";
import { fakeSecrets, fakeUpstream } from "./helpers.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

function checksOf<C>(mod: ServerModule<C>, raw: unknown, secrets: SecretResolver = fakeSecrets): ReadinessCheck[] {
  return mod.checks!({ config: mod.configSchema.parse(raw), cluster: "hub", secrets });
}

async function runAll(checks: ReadinessCheck[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const c of checks) {
    try {
      out[c.name] = `ok ${(await c.run()) ?? ""}`.trim();
    } catch (err) {
      out[c.name] = `échec ${(err as Error).message}`;
    }
  }
  return out;
}

describe("vérifications des modules", () => {
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let denied = false;
  const answer = (json: unknown) => () => (denied ? { status: 401, json: { message: "jeton refusé" } } : { json });

  before(async () => {
    up = await fakeUpstream({
      "GET /api/v1/query": answer({ status: "success", data: { resultType: "vector", result: [] } }),
      "GET /loki/api/v1/labels": answer({ status: "success", data: [] }),
      "GET /api/v2/status": answer({ cluster: { status: "ready" } }),
      "GET /api/search": answer([]),
      "GET /api/v1/applications": answer({ items: [{ metadata: { name: "payment" } }] }),
      "GET /app/installations/77": answer({ account: { login: "org" } }),
      "GET /api/status.json": answer({ Version: "24.1" }),
      "POST /searchapi/graphql": answer({ data: { searchResult: [{ count: 1, items: [] }] } }),
      "GET /apis/policy.open-cluster-management.io/v1/policies": answer({ items: [] }),
    });
  });
  after(() => up.close());

  const all = () => {
    const ep = { url: up.url, token: { type: "env", name: "X" } };
    return [
      ...checksOf(observabilityServer, { clusters: ["npr"], observatorium: ep, loki: { ...ep, orgId: "application" }, alertmanager: ep, grafana: ep, apps: {} }),
      ...checksOf(argocdServer, { url: up.url, token: { type: "file", path: "/etc/mcp-secrets/argocd/token" }, projects: ["team-a"] }),
      ...checksOf(gitServer, { apiUrl: up.url, appId: "1", installationId: "77", privateKey: { type: "file", path: "/k" }, repos: { "org/app": { paths: ["**"] } } }, { resolve: async () => privateKey }),
      ...checksOf(prtgServer, { url: up.url, apiKey: { type: "env", name: "PRTG" } }),
      ...checksOf(fleetServer, { clusters: ["npr"], search: { url: `${up.url}/searchapi/graphql`, token: { type: "env", name: "S" } }, hubApi: { url: up.url, token: { type: "env", name: "H" }, caFile: "inutile" } }),
    ];
  };

  it("tous les outils répondent : chaque vérification passe, avec un détail utile", async () => {
    const out = await runAll(all());
    assert.deepEqual(Object.keys(out).sort(), [
      "argocd:projets", "flotte:politiques", "flotte:recherche", "git:github-app",
      "observabilité:alertmanager", "observabilité:grafana", "observabilité:loki", "observabilité:observatorium", "prtg:api",
    ]);
    for (const [name, v] of Object.entries(out)) assert.match(v, /^ok /, `${name} : ${v}`);
    assert.equal(out["argocd:projets"], "ok team-a : 1 application(s)");
    assert.equal(out["prtg:api"], "ok PRTG 24.1 répond");
    assert.equal(up.calls.find((c) => c.url.startsWith("/loki/"))!.headers["x-scope-orgid"], "application");
  });

  it("un jeton refusé fait échouer chaque vérification ; la clé PRTG n'apparaît pas dans la cause", async () => {
    denied = true;
    const out = await runAll(all());
    denied = false;
    for (const [name, v] of Object.entries(out)) assert.match(v, /^échec .*401/, `${name} : ${v}`);
    assert.ok(!out["prtg:api"].includes("apitoken"), out["prtg:api"]);
  });
});
