// Identifiants Kubernetes sans Vault : jetons de courte durée par l'API
// TokenRequest, demandés avec le jeton du pod, gardés jusqu'à une minute avant
// leur fin ; vérification des droits par SelfSubjectAccessReview.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { KubernetesApi, KubernetesTokenCache } from "../src/lib/kubernetes.ts";
import { ClusterSecretResolver } from "../src/lib/secrets.ts";
import { fakeUpstream } from "./helpers.ts";

describe("API Kubernetes du pod", () => {
  let api: Awaited<ReturnType<typeof fakeUpstream>>;
  let dir = "";
  let issued = 0;
  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "k8s-"));
    writeFileSync(path.join(dir, "token"), "jeton-du-pod\n");
    writeFileSync(path.join(dir, "namespace"), "ai-mcp\n");
    api = await fakeUpstream({
      "POST /api/v1/namespaces/ai-mcp/serviceaccounts/mcp-prd-reader/token": (req) => {
        issued++;
        const body = JSON.parse(req.body);
        return { json: { status: { token: `court-${issued}-${body.spec.expirationSeconds}`, expirationTimestamp: new Date(Date.now() + body.spec.expirationSeconds * 1000).toISOString() } } };
      },
      "POST /api/v1/namespaces/ai-mcp/serviceaccounts/inconnu/token": () => ({ status: 404, json: { message: "not found" } }),
      "POST /api/v1/namespaces/ai-mcp/serviceaccounts/interdit/token": () => ({ status: 403, json: { message: "forbidden" } }),
      "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews": (req) => {
        const attrs = JSON.parse(req.body).spec.resourceAttributes;
        return { json: { status: { allowed: attrs.namespace === "app-a" && attrs.verb === "list" } } };
      },
    });
  });
  after(() => api.close());

  const k8s = () => new KubernetesApi({ url: api.url, caFile: "inutile", tokenFile: path.join(dir, "token"), namespaceFile: path.join(dir, "namespace") });

  it("TokenRequest : le compte du pod demande un jeton de 10 minutes pour le compte dédié de son namespace", async () => {
    const t = await k8s().requestToken("mcp-prd-reader");
    assert.match(t.token, /^court-\d+-600$/);
    assert.ok(t.expiresAt > Date.now() + 590_000);
    const call = api.calls.at(-1)!;
    assert.equal(call.headers.authorization, "Bearer jeton-du-pod");
    assert.deepEqual(JSON.parse(call.body), { apiVersion: "authentication.k8s.io/v1", kind: "TokenRequest", spec: { expirationSeconds: 600 } });
  });

  it("erreurs nommées : compte absent, droit de demander manquant", async () => {
    await assert.rejects(k8s().requestToken("inconnu"), /introuvable/);
    await assert.rejects(k8s().requestToken("interdit"), /create serviceaccounts\/token/);
  });

  it("cache : le même jeton jusqu'à une minute avant sa fin, une seule demande pour des appels simultanés", async () => {
    let now = Date.now();
    const cache = new KubernetesTokenCache(k8s(), () => now);
    const before = issued;
    const [a, b, c] = await Promise.all([cache.token("mcp-prd-reader"), cache.token("mcp-prd-reader"), cache.token("mcp-prd-reader")]);
    assert.equal(issued, before + 1);
    assert.equal(a, b);
    assert.equal(b, c);
    now += 8 * 60_000;
    assert.equal(await cache.token("mcp-prd-reader"), a, "encore valable plus d'une minute");
    now += 2 * 60_000;
    assert.notEqual(await cache.token("mcp-prd-reader"), a, "renouvelé avant son expiration");
  });

  it("SelfSubjectAccessReview : le droit réel du porteur, namespace par namespace", async () => {
    assert.equal(await k8s().can("t", { verb: "list", resource: "pods", namespace: "app-a" }), true);
    assert.equal(await k8s().can("t", { verb: "list", resource: "pods", namespace: "kube-system" }), false);
  });

  it("le résolveur : k8s-token par l'API, file en local ; sans Vault, kv est refusé avec la bonne piste", async () => {
    const file = path.join(dir, "argocd-token");
    writeFileSync(file, "jeton-argocd\n");
    const resolver = new ClusterSecretResolver({ kubernetes: new KubernetesTokenCache(k8s()) });
    assert.match(await resolver.resolve({ type: "k8s-token", serviceAccount: "mcp-prd-reader" }), /^court-/);
    assert.equal(await resolver.resolve({ type: "file", path: file }), "jeton-argocd");
    await assert.rejects(resolver.resolve({ type: "kv", path: "mcp/x", key: "token" }), /sans Vault, utilisez k8s-token ou file/);
    await assert.rejects(new ClusterSecretResolver().resolve({ type: "k8s-token", serviceAccount: "x" }), /non configuré/);
  });
});
