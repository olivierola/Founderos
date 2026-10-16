// mcp-openshift, outils étendus : vue d'ensemble, lecture générique sur liste
// blanche (jamais de Secret), historique, consommation, mise à l'échelle bornée,
// simulation côté serveur, et vérifications RBAC de démarrage.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { paramsHash } from "../src/lib/canonical.ts";
import type { Cluster } from "../src/lib/catalog.ts";
import type { ServerModule } from "../src/lib/server.ts";
import { executeTool, type AnyToolSpec, type ToolContext } from "../src/lib/tool.ts";
import { openshiftServer, parseCpuMillis, parseMemMiB, sanitize } from "../src/servers/openshift.ts";
import { approvalToken, fakeSecrets, fakeUpstream, operator, reader, resultJson, resultText, runtime, signingKey } from "./helpers.ts";

const now = new Date().toISOString();

describe("mcp-openshift, outils étendus", async () => {
  const keys = await signingKey();
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let cfg: Record<string, unknown>;
  let scaleReplicas = 2;

  before(async () => {
    up = await fakeUpstream({
      "GET /apis/apps/v1/namespaces/app-a/deployments": () => ({ json: { items: [
        { metadata: { name: "api", creationTimestamp: now }, spec: { replicas: 3 }, status: { readyReplicas: 3, updatedReplicas: 3, availableReplicas: 3 } },
        { metadata: { name: "worker", creationTimestamp: now }, spec: { replicas: 2 }, status: { readyReplicas: 0, availableReplicas: 0 } },
      ] } }),
      "GET /apis/apps/v1/namespaces/app-a/statefulsets": () => ({ json: { items: [] } }),
      "GET /apis/apps/v1/namespaces/app-a/daemonsets": () => ({ json: { items: [] } }),
      "GET /api/v1/namespaces/app-a/pods": () => ({ json: { items: [
        { metadata: { name: "api-1" }, status: { phase: "Running", containerStatuses: [{ restartCount: 0 }] } },
        { metadata: { name: "worker-1" }, status: { phase: "Pending", containerStatuses: [{ restartCount: 9 }] } },
      ] } }),
      "GET /api/v1/namespaces/app-a/persistentvolumeclaims": () => ({ json: { items: [{ metadata: { name: "data" }, status: { phase: "Pending" } }] } }),
      "GET /api/v1/namespaces/app-a/events": () => ({ json: { items: [
        { type: "Warning", reason: "BackOff", message: "back-off", count: 4, lastTimestamp: now, metadata: { creationTimestamp: now }, involvedObject: { kind: "Pod", name: "worker-1" } },
      ] } }),
      "GET /api/v1/namespaces/app-a/configmaps/app-config": () => ({ json: {
        metadata: { name: "app-config", managedFields: [{ manager: "kubectl" }], annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{…}", keep: "oui" } },
        data: { "db.url": "postgres://admin:motdepasse@db/app", feature: "on" },
      } }),
      "GET /apis/apps/v1/namespaces/app-a/deployments/api": () => ({ json: {
        metadata: { name: "api", generation: 2 },
        spec: { replicas: 3, template: { spec: { containers: [{ name: "api", image: "api:2", env: [{ name: "API_KEY", value: "sk-tres-secret" }, { name: "DB", valueFrom: { secretKeyRef: { name: "db", key: "url" } } }] }] } } },
        status: { observedGeneration: 2, readyReplicas: 3, updatedReplicas: 3, availableReplicas: 3 },
      } }),
      "GET /apis/batch/v1/namespaces/app-a/jobs": () => ({ json: { items: [{ metadata: { name: "j1" }, status: { succeeded: 1 } }], metadata: { continue: "suite" } } }),
      "GET /apis/apps/v1/namespaces/app-a/replicasets": () => ({ json: { items: [
        { metadata: { name: "api-1", creationTimestamp: now, annotations: { "deployment.kubernetes.io/revision": "1" }, ownerReferences: [{ kind: "Deployment", name: "api" }] }, spec: { template: { spec: { containers: [{ name: "api", image: "api:1" }] } } }, status: { replicas: 0 } },
        { metadata: { name: "api-2", creationTimestamp: now, annotations: { "deployment.kubernetes.io/revision": "2" }, ownerReferences: [{ kind: "Deployment", name: "api" }] }, spec: { template: { spec: { containers: [{ name: "api", image: "api:2" }] } } }, status: { replicas: 3 } },
        { metadata: { name: "other-1", annotations: { "deployment.kubernetes.io/revision": "9" }, ownerReferences: [{ kind: "Deployment", name: "other" }] }, spec: {}, status: {} },
      ] } }),
      "GET /apis/metrics.k8s.io/v1beta1/namespaces/app-a/pods": () => ({ json: { items: [
        { metadata: { name: "api-1" }, window: "30s", containers: [{ name: "api", usage: { cpu: "250m", memory: "128Mi" } }] },
        { metadata: { name: "worker-1" }, window: "30s", containers: [{ name: "w", usage: { cpu: "1200000000n", memory: "524288Ki" } }] },
      ] } }),
      "GET /apis/apps/v1/namespaces/app-a/deployments/api/scale": () => ({ json: { spec: { replicas: scaleReplicas } } }),
      "PATCH /apis/apps/v1/namespaces/app-a/deployments/api/scale": (req) => { scaleReplicas = JSON.parse(req.body).spec.replicas; return { json: {} }; },
      "PATCH /apis/apps/v1/namespaces/app-a/deployments/api": () => ({ json: {} }),
      "POST /apis/authorization.k8s.io/v1/selfsubjectaccessreviews": (req) => {
        const a = JSON.parse(req.body).spec.resourceAttributes;
        const token = String(req.headers.authorization);
        // Lecteur : lecture dans app-a seulement ; opérateur : patch partout.
        const allowed = token.includes("reader") ? a.verb === "list" && a.namespace === "app-a" : a.verb === "patch";
        return { json: { status: { allowed } } };
      },
    });
    cfg = {
      api: { url: up.url, caFile: "inutile" },
      namespaces: ["app-a", "app-b"],
      readCredential: { type: "k8s-token", serviceAccount: "mcp-npr-reader" },
      writeCredential: { type: "k8s-token", serviceAccount: "mcp-npr-operator" },
      maxReplicas: 5,
    };
  });
  after(() => up.close());

  const tools = (cluster: Cluster, rawCfg = cfg) => new Map(openshiftServer.createTools({ config: openshiftServer.configSchema.parse(rawCfg), cluster, secrets: fakeSecrets }).map((t) => [t.name, t]));
  async function call(cluster: Cluster, tool: string, args: unknown, ctx: ToolContext = reader, approval?: string) {
    const spec = tools(cluster).get(tool) as AnyToolSpec;
    const { rt } = await runtime("mcp-openshift", cluster, { approvalJwks: keys.jwks });
    return executeTool(rt, spec, args, ctx, approval);
  }

  it("namespace_overview : charges en défaut, pods par phase, redémarrages, PVC en attente, avertissements récents", async () => {
    const o = resultJson(await call("npr", "namespace_overview", { namespace: "app-a" }));
    assert.deepEqual(o.unhealthy.map((u: { name: string }) => u.name), ["worker"]);
    assert.deepEqual(o.pods, { Running: 1, Pending: 1 });
    assert.deepEqual(o.most_restarted, [{ name: "worker-1", restarts: 9 }]);
    assert.deepEqual(o.pvc_pending, ["data"]);
    assert.deepEqual(o.warnings_15min, { BackOff: 4 });
    assert.equal(up.calls.at(-1)!.headers.authorization, "Bearer k8s-mcp-npr-reader");
  });

  it("resource_list : une ligne d'état par objet, troncature signalée, limite transmise à l'API", async () => {
    const r = resultJson(await call("npr", "resource_list", { namespace: "app-a", kind: "Job", limit: 1 }));
    // created est absent de l'objet de test : le JSON ne garde pas la clé.
    assert.deepEqual(r.items, [{ name: "j1", active: 0, succeeded: 1, failed: 0, completed: null }]);
    assert.equal(r.truncated, true);
    assert.match(up.calls.at(-1)!.url, /limit=1/);
  });

  it("aucun type ne désigne un Secret ; un namespace hors liste est refusé", async () => {
    assert.equal(resultJson(await call("npr", "resource_get", { namespace: "app-a", kind: "Secret", name: "db" })).error, "invalid_params");
    assert.equal(resultJson(await call("npr", "resource_list", { namespace: "kube-system", kind: "Pod" })).error, "invalid_params");
  });

  it("resource_get : sans champs de gestion, sans valeurs de ConfigMap, sans valeurs littérales d'env", async () => {
    const cm = resultJson(await call("npr", "resource_get", { namespace: "app-a", kind: "ConfigMap", name: "app-config" }));
    assert.equal(cm.metadata.managedFields, undefined);
    assert.equal(cm.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"], undefined);
    assert.equal(cm.metadata.annotations.keep, "oui");
    assert.match(cm.data["db.url"], /octets, valeur non renvoyée/);
    const dep = await call("npr", "resource_get", { namespace: "app-a", kind: "Deployment", name: "api" });
    assert.ok(!resultText(dep).includes("sk-tres-secret"));
    const env = resultJson(dep).spec.template.spec.containers[0].env;
    assert.equal(env[0].value, "[masqué]");
    assert.deepEqual(env[1].valueFrom, { secretKeyRef: { name: "db", key: "url" } }, "une référence n'est pas une valeur : elle reste");
  });

  it("rollout_history : les révisions du seul déploiement visé, de la plus récente à la plus ancienne", async () => {
    const h = resultJson(await call("npr", "rollout_history", { namespace: "app-a", name: "api" }));
    assert.deepEqual(h.map((r: { revision: number }) => r.revision), [2, 1]);
    assert.equal(h[0].images[0].image, "api:2");
  });

  it("pod_metrics : unités converties, tri par CPU", async () => {
    const m = resultJson(await call("npr", "pod_metrics", { namespace: "app-a" }));
    assert.deepEqual(m.map((p: { pod: string; cpu_m: number; mem_mib: number }) => [p.pod, p.cpu_m, p.mem_mib]), [["worker-1", 1200, 512], ["api-1", 250, 128]]);
    assert.equal(parseCpuMillis("2"), 2000);
    assert.equal(parseMemMiB("1Gi"), 1024);
  });

  it("deployment_scale : plafond du cluster, simulation côté serveur, valeur inchangée sans appel d'écriture", async () => {
    assert.match(resultJson(await call("npr", "deployment_scale", { namespace: "app-a", name: "api", replicas: 6 }, operator)).message, /5 au plus/);
    scaleReplicas = 2;
    const dry = resultJson(await call("npr", "deployment_scale", { namespace: "app-a", name: "api", replicas: 4, dry_run: true }, { ...operator, identity: { ...operator.identity, scopes: [...operator.identity.scopes, "ocp:scale"] } }));
    assert.deepEqual([dry.from, dry.to, dry.dry_run], [2, 4, true]);
    const patch = up.calls.at(-1)!;
    assert.match(patch.url, /dryRun=All/);
    assert.equal(patch.headers["content-type"], "application/merge-patch+json");
    assert.equal(patch.headers.authorization, "Bearer k8s-mcp-npr-operator");
    scaleReplicas = 4;
    const before = up.calls.length;
    const same = resultJson(await call("npr", "deployment_scale", { namespace: "app-a", name: "api", replicas: 4 }, { ...operator, identity: { ...operator.identity, scopes: [...operator.identity.scopes, "ocp:scale"] } }));
    assert.equal(same.unchanged, true);
    assert.equal(up.calls.length, before + 1, "une lecture, pas d'écriture");
  });

  it("deployment_scale : refusé sans le scope ocp:scale ; en PRD, approbation requise puis exécution", async () => {
    assert.equal(resultJson(await call("npr", "deployment_scale", { namespace: "app-a", name: "api", replicas: 3 }, operator)).error, "denied");
    const op = { ...operator, identity: { ...operator.identity, scopes: [...operator.identity.scopes, "ocp:scale"] } };
    const pending = resultJson(await call("prd", "deployment_scale", { namespace: "app-a", name: "api", replicas: 3 }, op));
    assert.equal(pending.error, "approval_required");
    const token = await approvalToken(keys.privateKey, { aud: "mcp-openshift-prd", sub: "u-bob", approver: "u-carol", tool: "deployment_scale", target_cluster: "prd", params_hash: pending.params_hash });
    assert.equal(pending.params_hash, paramsHash({ namespace: "app-a", name: "api", replicas: 3, dry_run: false }));
    const done = await call("prd", "deployment_scale", { namespace: "app-a", name: "api", replicas: 3 }, op, token);
    assert.equal(done.isError, undefined, resultText(done));
  });

  it("deployment_restart en simulation : dryRun=All transmis à l'API", async () => {
    const r = resultJson(await call("npr", "deployment_restart", { namespace: "app-a", name: "api", dry_run: true }, operator));
    assert.equal(r.dry_run, true);
    assert.match(up.calls.at(-1)!.url, /dryRun=All/);
  });

  it("vérifications de démarrage : les droits réels de chaque compte, namespace par namespace", async () => {
    const config = openshiftServer.configSchema.parse(cfg);
    const checks = (openshiftServer as ServerModule<typeof config>).checks!({ config, cluster: "npr", secrets: fakeSecrets });
    assert.deepEqual(checks.map((c) => [c.name, c.critical]), [["openshift:lecture", false], ["openshift:écriture", false]]);
    await assert.rejects(checks[0].run(), /list pods refusé dans : app-b/);
    assert.match(String(await checks[1].run()), /patch apps\/deployments permis dans 2 namespace/);
  });

  it("sanitize ne touche pas à l'objet d'origine", () => {
    const o = { metadata: { managedFields: [1] }, data: { a: "b" } };
    sanitize("ConfigMap", o);
    assert.deepEqual(o, { metadata: { managedFields: [1] }, data: { a: "b" } });
  });
});
