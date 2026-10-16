// Disponibilité : /healthz répond tant que le processus vit ; /readyz rend
// l'état des vérifications (droits RBAC du module, OPA) et ne retire le pod du
// service que si une vérification critique échoue.
/* eslint-disable @typescript-eslint/no-explicit-any */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { loadCatalog } from "../src/lib/catalog.ts";
import { Metrics } from "../src/lib/metrics.ts";
import { BuiltinPolicyEngine } from "../src/lib/policy.ts";
import { startServer, type RunningServer } from "../src/lib/server.ts";
import { openshiftServer } from "../src/servers/openshift.ts";
import { fakeSecrets, fakeUpstream } from "./helpers.ts";

describe("vérifications et /readyz", () => {
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let server: RunningServer;
  let mgmt = "";
  let opaUp = false;
  let rbacOk = false;
  const metrics = new Metrics();

  before(async () => {
    up = await fakeUpstream({
      "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews": () => ({ json: { status: { allowed: rbacOk } } }),
    });
    const catalog = loadCatalog();
    server = await startServer({
      module: openshiftServer,
      config: openshiftServer.configSchema.parse({
        api: { url: up.url, caFile: "inutile" },
        namespaces: ["app-a"],
        readCredential: { type: "k8s-token", serviceAccount: "mcp-npr-reader" },
      }),
      cluster: "npr", catalog, policy: new BuiltinPolicyEngine(catalog),
      verifyToken: async () => { throw new Error("pas d'appel MCP dans ce test"); },
      secrets: fakeSecrets, audit: () => {}, metrics,
      mcpPort: 0, mgmtPort: 0, insecureHttp: true, host: "127.0.0.1",
      checks: [{ name: "opa", critical: true, run: async () => { if (!opaUp) throw new Error("OPA injoignable"); return "OPA répond"; } }],
      checkIntervalMs: 0,
    });
    mgmt = `http://127.0.0.1:${(server.mgmt.address() as AddressInfo).port}`;
  });
  after(async () => {
    await server.close();
    await up.close();
  });

  it("OPA injoignable : /readyz en 503, la cause dans le corps ; /healthz reste à 200", async () => {
    await server.runChecks();
    const ready = await fetch(`${mgmt}/readyz`);
    assert.equal(ready.status, 503);
    const body = (await ready.json()) as any;
    assert.equal(body.ready, false);
    assert.deepEqual(body.checks.find((c: { name: string }) => c.name === "opa"), { ...body.checks.find((c: { name: string }) => c.name === "opa"), ok: false, detail: "OPA injoignable" });
    assert.equal((await fetch(`${mgmt}/healthz`)).status, 200);
  });

  it("OPA rétabli, RBAC manquant : prêt mais « dégradé », le namespace en défaut nommé, la métrique à 0", async () => {
    opaUp = true;
    await server.runChecks();
    const ready = await fetch(`${mgmt}/readyz`);
    assert.equal(ready.status, 200);
    const body = (await ready.json()) as any;
    assert.equal(body.ready, true);
    assert.equal(body.degraded, true);
    assert.match(body.checks.find((c: { name: string }) => c.name === "openshift:lecture").detail, /list pods refusé dans : app-a/);
    assert.match(metrics.render(), /mcp_check_ok\{check="openshift:lecture"\} 0/);
  });

  it("tout passe : prêt, non dégradé, la métrique à 1", async () => {
    rbacOk = true;
    await server.runChecks();
    const body = (await (await fetch(`${mgmt}/readyz`)).json()) as any;
    assert.deepEqual([body.ready, body.degraded], [true, false]);
    assert.match(metrics.render(), /mcp_check_ok\{check="openshift:lecture"\} 1/);
    assert.match(metrics.render(), /mcp_check_ok\{check="opa"\} 1/);
  });
});
