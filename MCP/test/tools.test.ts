// Les tools, serveur par serveur : paramètres refusés (exigés par la doc pour
// chaque tool), puis appels de bout en bout contre de faux outils.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { paramsHash } from "../src/lib/canonical.ts";
import type { Cluster } from "../src/lib/catalog.ts";
import type { SecretResolver } from "../src/lib/secrets.ts";
import type { ServerModule } from "../src/lib/server.ts";
import { executeTool, type AnyToolSpec, type ToolContext } from "../src/lib/tool.ts";
import { argocdServer } from "../src/servers/argocd.ts";
import { fleetConfig, fleetServer } from "../src/servers/fleet.ts";
import { gitServer, isAllowedPath, proposalBranch } from "../src/servers/git.ts";
import { observabilityServer } from "../src/servers/observability.ts";
import { openshiftServer } from "../src/servers/openshift.ts";
import { prtgServer } from "../src/servers/prtg.ts";
import { approvalToken, fakeSecrets, fakeUpstream, operator, reader, resultJson, resultText, runtime, signingKey } from "./helpers.ts";

function toolsOf<C>(mod: ServerModule<C>, rawConfig: unknown, cluster: Cluster, secrets: SecretResolver = fakeSecrets): Map<string, AnyToolSpec> {
  const config = mod.configSchema.parse(rawConfig);
  return new Map(mod.createTools({ config, cluster, secrets }).map((t) => [t.name, t]));
}

async function call(mod: ServerModule<any>, rawConfig: unknown, cluster: Cluster, tool: string, args: unknown, ctx: ToolContext, opts: { approval?: string; approvalJwks?: any; secrets?: SecretResolver } = {}) {
  const spec = toolsOf(mod, rawConfig, cluster, opts.secrets).get(tool);
  assert.ok(spec, `${tool} absent de ${mod.name}`);
  const { rt, audit } = await runtime(mod.name, cluster, { approvalJwks: opts.approvalJwks });
  const result = await executeTool(rt, spec, args, ctx, opts.approval);
  return { result, audit, rt };
}

function assertInvalid(result: { isError?: boolean; content: Array<{ type: string; text?: string }> }, re?: RegExp) {
  assert.equal(result.isError, true);
  const body = resultJson(result);
  assert.equal(body.error, "invalid_params", JSON.stringify(body));
  if (re) assert.match(body.message, re);
}

// ── mcp-observability ────────────────────────────────────────────────────────
describe("mcp-observability", async () => {
  const keys = await signingKey();
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let cfg: Record<string, unknown>;
  // Silences déjà posés, rendus par GET /api/v2/silences ; alertes actives.
  let silences: unknown[] = [];
  const firing = [{ labels: { alertname: "HighLatency" } }, { labels: { alertname: "HighLatency" } }];

  before(async () => {
    up = await fakeUpstream({
      "GET /loki/api/v1/query_range": () => ({
        json: { data: { result: [{ stream: { kubernetes_pod_name: "payment-api-1" }, values: [[String(Date.now() * 1_000_000), 'ERROR db connect failed password=hunter2hunter2 host=db']] }] } },
      }),
      "GET /api/v2/alerts": () => ({ json: firing }),
      "GET /api/v2/silences": () => ({ json: silences }),
      "POST /api/v2/silences": () => ({ json: { silenceID: "s-123" } }),
      "GET /api/v1/query": () => ({ json: { status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [0, "1"] }] } } }),
    });
    const ep = { url: up.url, token: { type: "kv", path: "mcp-observability/x", key: "token" } };
    cfg = {
      clusters: ["sdb", "npr", "prd"],
      observatorium: ep, loki: { ...ep, orgId: "application" }, alertmanager: ep, grafana: ep,
      apps: { "payment-api": { namespace: "payment-prd", cluster: "prd" } },
      databases: { orders: { engine: "mysql", selector: 'namespace="db-orders"' } },
    };
  });
  after(() => up.close());

  it("logs_query refuse une application hors liste blanche", async () => {
    assertInvalid((await call(observabilityServer, cfg, "hub", "logs_query", { app: "billing" }, reader)).result, /non autorisée/);
  });
  it("logs_query refuse plus d'une heure", async () => {
    assertInvalid((await call(observabilityServer, cfg, "hub", "logs_query", { app: "payment-api", minutes: 61 }, reader)).result);
  });
  it("logs_query refuse plus de 500 lignes", async () => {
    assertInvalid((await call(observabilityServer, cfg, "hub", "logs_query", { app: "payment-api", limit: 501 }, reader)).result);
  });
  it("metrics_query refuse plus de 24 h et un pas sous 30 s", async () => {
    assertInvalid((await call(observabilityServer, cfg, "hub", "metrics_query", { query: "up", minutes: 1441 }, reader)).result);
    assertInvalid((await call(observabilityServer, cfg, "hub", "metrics_query", { query: "up", step_seconds: 29 }, reader)).result);
  });
  it("alert_silence_create refuse plus de 2 h et un commentaire vide", async () => {
    assertInvalid((await call(observabilityServer, cfg, "hub", "alert_silence_create", { alertname: "X", cluster: "npr", duration_minutes: 121, comment: "un commentaire valable" }, operator)).result);
    assertInvalid((await call(observabilityServer, cfg, "hub", "alert_silence_create", { alertname: "X", cluster: "npr", duration_minutes: 30, comment: "court" }, operator)).result, /commentaire/);
  });
  it("db_health refuse une base non suivie", async () => {
    assertInvalid((await call(observabilityServer, cfg, "hub", "db_health", { database: "payroll" }, reader)).result, /non suivie/);
  });

  it("logs_query construit la requête LogQL et masque les secrets", async () => {
    const { result, audit } = await call(observabilityServer, cfg, "hub", "logs_query", { app: "payment-api" }, reader);
    assert.equal(result.isError, undefined, resultText(result));
    const text = resultText(result);
    assert.match(text, /NON FIABLES/);
    assert.ok(!text.includes("hunter2hunter2"), text);
    const q = new URL(up.calls.at(-1)!.url, "http://x").searchParams.get("query");
    assert.equal(q, '{kubernetes_namespace_name="payment-prd"} | json | level=~"(?i)error"');
    assert.equal(up.calls.at(-1)!.headers["x-scope-orgid"], "application");
    assert.equal(up.calls.at(-1)!.headers.authorization, "Bearer secret-mcp-observability/x");
    assert.equal(audit[0].status, "ok");
    assert.equal(audit[0].user, "u-alice");
    assert.equal(audit[0].agent, "agent-ops-investigator");
    assert.equal(audit[0].target_cluster, "prd");
  });

  it("un lecteur ne crée pas de silence", async () => {
    const { result } = await call(observabilityServer, cfg, "hub", "alert_silence_create", { alertname: "X", cluster: "npr", duration_minutes: 30, comment: "maintenance prévue" }, reader);
    assert.deepEqual(resultJson(result), { error: "denied", reason: "scope_missing" });
  });

  it("un silence visant PRD attend une approbation, sans rien appeler", async () => {
    const before = up.calls.length;
    const { result, audit } = await call(observabilityServer, cfg, "hub", "alert_silence_create", { alertname: "HighLatency", cluster: "prd", duration_minutes: 60, comment: "incident en cours INC-42" }, operator);
    const body = resultJson(result);
    assert.equal(body.error, "approval_required");
    assert.equal(body.target_cluster, "prd");
    // L'empreinte porte sur les paramètres complétés par leurs défauts (dry_run).
    assert.equal(body.params_hash, paramsHash({ alertname: "HighLatency", cluster: "prd", duration_minutes: 60, comment: "incident en cours INC-42", dry_run: false }));
    assert.equal(up.calls.length, before);
    assert.equal(audit[0].status, "approval_required");
  });

  it("approuvé par une autre personne, le silence est créé", async () => {
    const args = { alertname: "HighLatency", cluster: "prd", duration_minutes: 60, comment: "incident en cours INC-42", dry_run: false };
    const token = await approvalToken(keys.privateKey, { aud: "mcp-observability-hub", sub: "u-bob", approver: "u-carol", tool: "alert_silence_create", target_cluster: "prd", params_hash: paramsHash(args) });
    const { result, audit } = await call(observabilityServer, cfg, "hub", "alert_silence_create", args, operator, { approval: token, approvalJwks: keys.jwks });
    assert.equal(result.isError, undefined, resultText(result));
    assert.equal(resultJson(result).silence_id, "s-123");
    assert.equal(resultJson(result).matching_alerts, 2);
    const sent = JSON.parse(up.calls.at(-1)!.body);
    assert.deepEqual(sent.matchers.map((m: { name: string }) => m.name), ["alertname", "managed_cluster"]);
    assert.equal(sent.createdBy, "bob");
    assert.equal(audit[0].approver, "u-carol");
    assert.equal(audit[0].approval_id, "approval-1");
  });

  it("simulation : ce qui serait créé et les alertes couvertes, sans rien écrire", async () => {
    const { result } = await call(observabilityServer, cfg, "hub", "alert_silence_create", { alertname: "HighLatency", cluster: "npr", duration_minutes: 30, comment: "maintenance prévue", dry_run: true }, operator);
    const body = resultJson(result);
    assert.equal(body.dry_run, true);
    assert.equal(body.matching_alerts, 2);
    assert.equal(body.would_create.matchers.length, 2);
    assert.ok(!up.calls.some((c) => c.method === "POST" && c.url.startsWith("/api/v2/silences") && JSON.parse(c.body).matchers?.[1]?.value === "npr"));
  });

  it("un silence identique encore valable est rendu, pas recréé", async () => {
    const posts = () => up.calls.filter((c) => c.method === "POST").length;
    const before = posts();
    silences = [{
      id: "s-existant", status: { state: "active" }, createdBy: "alice", comment: "déjà posé",
      endsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      matchers: [{ name: "managed_cluster", value: "npr", isRegex: false, isEqual: true }, { name: "alertname", value: "HighLatency", isRegex: false }],
    }];
    const { result } = await call(observabilityServer, cfg, "hub", "alert_silence_create", { alertname: "HighLatency", cluster: "npr", duration_minutes: 30, comment: "maintenance prévue" }, operator);
    assert.deepEqual([resultJson(result).silence_id, resultJson(result).unchanged], ["s-existant", true]);
    assert.equal(posts(), before);
    // Plus court que demandé : un nouveau silence est posé.
    silences = [{ ...(silences[0] as object), endsAt: new Date(Date.now() + 5 * 60_000).toISOString() }];
    const again = await call(observabilityServer, cfg, "hub", "alert_silence_create", { alertname: "HighLatency", cluster: "npr", duration_minutes: 30, comment: "maintenance prévue" }, operator);
    assert.equal(resultJson(again.result).silence_id, "s-123");
    silences = [];
  });

  it("une auto-approbation ne suffit pas", async () => {
    const args = { alertname: "HighLatency", cluster: "prd", duration_minutes: 60, comment: "incident en cours INC-42", dry_run: false };
    const token = await approvalToken(keys.privateKey, { aud: "mcp-observability-hub", sub: "u-bob", approver: "u-bob", tool: "alert_silence_create", target_cluster: "prd", params_hash: paramsHash(args) });
    const { result } = await call(observabilityServer, cfg, "hub", "alert_silence_create", args, operator, { approval: token, approvalJwks: keys.jwks });
    assert.equal(resultJson(result).error, "approval_required");
  });

  it("db_health n'exécute que les requêtes prédéfinies", async () => {
    const { result } = await call(observabilityServer, cfg, "hub", "db_health", { database: "orders" }, reader);
    assert.equal(resultJson(result).indicators.up, 1);
    assert.match(new URL(up.calls.at(-1)!.url, "http://x").searchParams.get("query")!, /\{namespace="db-orders"\}/);
  });
});

// ── mcp-fleet ────────────────────────────────────────────────────────────────
describe("mcp-fleet", async () => {
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let cfg: Record<string, unknown>;
  before(async () => {
    up = await fakeUpstream({
      "POST /searchapi/graphql": () => ({ json: { data: { searchResult: [{ count: 2, items: [{ kind: "Pod", name: "a", cluster: "prd" }, { kind: "Secret", name: "leak", cluster: "prd" }] }] } } }),
    });
    cfg = {
      clusters: ["sdb", "npr", "prd"],
      search: { url: `${up.url}/searchapi/graphql`, token: { type: "kv", path: "mcp-fleet/search", key: "token" } },
      hubApi: { url: up.url, token: { type: "kv", path: "mcp-fleet/hub", key: "token" }, caFile: "unused" },
    };
  });
  after(() => up.close());

  it("la configuration refuse Secret dans la liste des types", () => {
    assert.throws(() => fleetConfig.parse({ ...cfg, kinds: ["Pod", "Secret"] }), /Secret/);
  });
  it("fleet_search refuse le type Secret", async () => {
    assertInvalid((await call(fleetServer, cfg, "hub", "fleet_search", { kind: "Secret" }, reader)).result);
  });
  it("fleet_search ne renvoie jamais de Secret, même si l'API en renvoie", async () => {
    const { result } = await call(fleetServer, cfg, "hub", "fleet_search", { kind: "Pod", cluster: "prd" }, reader);
    const body = resultJson(result);
    assert.deepEqual(body.items.map((i: { name: string }) => i.name), ["a"]);
    const sent = JSON.parse(up.calls.at(-1)!.body);
    assert.deepEqual(sent.variables.input[0].filters, [{ property: "kind", values: ["Pod"] }, { property: "cluster", values: ["prd"] }]);
  });
});

// ── mcp-openshift ────────────────────────────────────────────────────────────
describe("mcp-openshift", async () => {
  const keys = await signingKey();
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let cfg: Record<string, unknown>;
  before(async () => {
    up = await fakeUpstream({
      "GET /api/v1/namespaces/app-a/pods": () => ({ json: { items: [{ metadata: { name: "p1", creationTimestamp: "2026-10-10T00:00:00Z" }, spec: { containers: [{ name: "c" }] }, status: { phase: "Running", containerStatuses: [{ name: "c", ready: false, restartCount: 7, state: { waiting: { reason: "CrashLoopBackOff" } } }] } }] } }),
      "PATCH /apis/apps/v1/namespaces/app-a/deployments/api": () => ({ json: {} }),
      "GET /api/v1/namespaces/app-a/pods/p1/log": () => ({ text: "line1\nAuthorization: Bearer abcdefghijklmnopqrst\nline3" }),
    });
    cfg = {
      api: { url: up.url, caFile: "unused" },
      namespaces: ["app-a", "app-b"],
      readCredential: { type: "k8s-token", serviceAccount: "mcp-npr-reader" },
      writeCredential: { type: "k8s-token", serviceAccount: "mcp-npr-operator" },
    };
  });
  after(() => up.close());

  it("refuse un namespace hors liste blanche", async () => {
    assertInvalid((await call(openshiftServer, cfg, "npr", "pods_list", { namespace: "kube-system" }, reader)).result);
  });
  it("pod_logs refuse plus de 500 lignes et un nom de pod invalide", async () => {
    assertInvalid((await call(openshiftServer, cfg, "npr", "pod_logs", { namespace: "app-a", pod: "p1", lines: 501 }, reader)).result);
    assertInvalid((await call(openshiftServer, cfg, "npr", "pod_logs", { namespace: "app-a", pod: "../../etc" }, reader)).result);
  });
  it("events_list refuse plus d'une heure", async () => {
    assertInvalid((await call(openshiftServer, cfg, "npr", "events_list", { namespace: "app-a", minutes: 61 }, reader)).result);
  });

  it("pods_list lit avec le jeton court du compte lecteur, pour ce namespace", async () => {
    fakeSecrets.requests.length = 0;
    const { result } = await call(openshiftServer, cfg, "npr", "pods_list", { namespace: "app-a" }, reader);
    const pods = resultJson(result);
    assert.equal(pods[0].reason, "CrashLoopBackOff");
    assert.equal(pods[0].restarts, 7);
    assert.deepEqual(fakeSecrets.requests[0], { ref: { type: "k8s-token", serviceAccount: "mcp-npr-reader" }, namespace: "app-a" });
    assert.equal(up.calls.at(-1)!.headers.authorization, "Bearer k8s-mcp-npr-reader");
  });

  it("pod_logs masque les secrets", async () => {
    const { result } = await call(openshiftServer, cfg, "npr", "pod_logs", { namespace: "app-a", pod: "p1" }, reader);
    assert.ok(!resultText(result).includes("abcdefghijklmnopqrst"));
  });

  it("deployment_restart en NPR : un seul patch, avec le compte opérateur", async () => {
    const { result } = await call(openshiftServer, cfg, "npr", "deployment_restart", { namespace: "app-a", name: "api" }, operator);
    assert.equal(result.isError, undefined, resultText(result));
    const last = up.calls.at(-1)!;
    assert.equal(last.method, "PATCH");
    assert.equal(last.headers["content-type"], "application/strategic-merge-patch+json");
    assert.equal(last.headers.authorization, "Bearer k8s-mcp-npr-operator");
    assert.ok(JSON.parse(last.body).spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]);
  });

  it("deployment_restart en PRD : approbation requise, aucun appel", async () => {
    const before = up.calls.length;
    const { result } = await call(openshiftServer, cfg, "prd", "deployment_restart", { namespace: "app-a", name: "api" }, operator);
    assert.equal(resultJson(result).error, "approval_required");
    assert.equal(up.calls.length, before);
  });

  it("deployment_restart en PRD avec approbation valide", async () => {
    // L'empreinte porte sur les paramètres complétés par leurs défauts (dry_run) :
    // FounderOS reprend celle que le serveur renvoie avec approval_required.
    const args = { namespace: "app-a", name: "api", dry_run: false };
    const token = await approvalToken(keys.privateKey, { aud: "mcp-openshift-prd", sub: "u-bob", approver: "u-carol", tool: "deployment_restart", target_cluster: "prd", params_hash: paramsHash(args) });
    const { result } = await call(openshiftServer, cfg, "prd", "deployment_restart", args, operator, { approval: token, approvalJwks: keys.jwks });
    assert.equal(result.isError, undefined, resultText(result));
  });

  it("sans rôle d'écriture configuré, le redémarrage est refusé", async () => {
    const { writeCredential: _, ...readOnly } = cfg;
    assertInvalid((await call(openshiftServer, readOnly, "npr", "deployment_restart", { namespace: "app-a", name: "api" }, operator)).result, /non configurée/);
  });
});

// ── mcp-argocd ───────────────────────────────────────────────────────────────
describe("mcp-argocd", async () => {
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let cfg: Record<string, unknown>;
  const history = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, revision: `r${i + 1}`, deployedAt: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
  let phase: string | undefined;
  before(async () => {
    up = await fakeUpstream({
      "GET /api/v1/applications/payment": () => ({ json: { metadata: { name: "payment" }, spec: { project: "team-pay" }, status: { sync: { status: "OutOfSync" }, health: { status: "Degraded" }, history, operationState: phase ? { phase } : undefined, resources: [{ kind: "Deployment", name: "api", status: "OutOfSync", health: { status: "Degraded" } }, { kind: "Service", name: "api", status: "Synced", health: { status: "Healthy" } }] } } }),
      "GET /api/v1/applications/infra": () => ({ json: { metadata: { name: "infra" }, spec: { project: "platform" }, status: {} } }),
      "POST /api/v1/applications/payment/sync": () => ({ json: { status: { operationState: { phase: "Running" } } } }),
    });
    cfg = { url: up.url, token: { type: "kv", path: "mcp-argocd/token", key: "token" }, projects: ["team-pay"] };
  });
  after(() => up.close());

  it("refuse une application hors des projets autorisés", async () => {
    assertInvalid((await call(argocdServer, cfg, "npr", "app_status", { app: "infra" }, reader)).result, /hors des projets/);
  });
  it("app_history : les 10 derniers, du plus récent au plus ancien", async () => {
    const h = resultJson((await call(argocdServer, cfg, "npr", "app_history", { app: "payment" }, reader)).result);
    assert.equal(h.length, 10);
    assert.equal(h[0].revision, "r12");
    assert.equal(h[9].revision, "r3");
  });
  it("app_diff ne liste que l'écart", async () => {
    const d = resultJson((await call(argocdServer, cfg, "npr", "app_diff", { app: "payment" }, reader)).result);
    assert.deepEqual(d.drift.map((r: { kind: string }) => r.kind), ["Deployment"]);
  });
  it("app_sync : simulation transmise à Argo CD, sans prune", async () => {
    const { result } = await call(argocdServer, cfg, "npr", "app_sync", { app: "payment", dry_run: true }, operator);
    assert.equal(result.isError, undefined, resultText(result));
    assert.deepEqual(JSON.parse(up.calls.at(-1)!.body), { prune: false, dryRun: true });
  });
  it("app_sync : une opération déjà en cours n'est pas relancée", async () => {
    phase = "Running";
    const posts = up.calls.filter((c) => c.method === "POST").length;
    const body = resultJson((await call(argocdServer, cfg, "npr", "app_sync", { app: "payment" }, operator)).result);
    assert.deepEqual([body.unchanged, body.operation], [true, "Running"]);
    assert.equal(up.calls.filter((c) => c.method === "POST").length, posts);
    phase = undefined;
  });
});

// ── mcp-git ──────────────────────────────────────────────────────────────────
describe("mcp-git", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const pemSecrets: SecretResolver = { resolve: async () => privateKey };
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let cfg: Record<string, unknown>;
  // Pull requests ouvertes rendues par GET /pulls.
  let openPrs: unknown[] = [];
  before(async () => {
    up = await fakeUpstream({
      "POST /app/installations/77/access_tokens": () => ({ json: { token: "ghs_installation" } }),
      "GET /app/installations/77": () => ({ json: { account: { login: "org" } } }),
      "GET /repos/org/app-config/pulls": () => ({ json: openPrs }),
      "GET /repos/org/app-config/git/ref/heads/main": () => ({ json: { object: { sha: "abc" } } }),
      "POST /repos/org/app-config/git/refs": () => ({ json: {} }),
      "GET /repos/org/app-config/contents/apps/payment/values-npr.yaml": () => ({ status: 404, json: { message: "Not Found" } }),
      "PUT /repos/org/app-config/contents/apps/payment/values-npr.yaml": () => ({ json: {} }),
      "POST /repos/org/app-config/pulls": () => ({ json: { number: 42, html_url: "https://github.test/org/app-config/pull/42" } }),
    });
    cfg = { apiUrl: up.url, appId: "123", installationId: "77", privateKey: { type: "kv", path: "mcp-git/app", key: "private_key" }, repos: { "org/app-config": { paths: ["apps/*/values-*.yaml"] } }, maxFiles: 2 };
  });
  after(() => up.close());

  it("chemins : liste blanche, jamais .github ni de remontée", () => {
    assert.ok(isAllowedPath("apps/payment/values-prd.yaml", ["apps/*/values-*.yaml"]));
    assert.ok(!isAllowedPath("apps/payment/sub/values-prd.yaml", ["apps/*/values-*.yaml"]));
    assert.ok(isAllowedPath("overlays/npr/a/b.yaml", ["overlays/**"]));
    assert.ok(!isAllowedPath("apps/../secrets/values-x.yaml", ["apps/**"]));
    assert.ok(!isAllowedPath(".github/workflows/ci.yml", ["**"]));
    assert.ok(!isAllowedPath("/apps/a/values-x.yaml", ["**"]));
  });

  const pr = {
    repo: "org/app-config",
    title: "Augmente la mémoire de payment-api en NPR",
    diagnostic: "Le pod payment-api redémarre en boucle : OOMKilled toutes les 20 minutes depuis 08:00.",
    evidence: ["events_list : OOMKilled x12", "metrics_query : container_memory_working_set_bytes au plafond"],
    impact: "Limite mémoire 512Mi → 1Gi ; aucun impact fonctionnel attendu.",
    files: [{ path: "apps/payment/values-npr.yaml", content: "resources:\n  limits:\n    memory: 1Gi\n" }],
  };

  it("refuse un chemin hors liste blanche et trop de fichiers", async () => {
    assertInvalid((await call(gitServer, cfg, "ips", "pr_create", { ...pr, files: [{ path: "apps/payment/deploy.yaml", content: "x" }] }, operator, { secrets: pemSecrets })).result, /non autorisé/);
    const three = [1, 2, 3].map((i) => ({ path: `apps/a${i}/values-npr.yaml`, content: "x" }));
    assertInvalid((await call(gitServer, cfg, "ips", "pr_create", { ...pr, files: three }, operator, { secrets: pemSecrets })).result, /au plus/);
  });

  it("crée une branche ai/…, le fichier et la pull request, sans fusionner", async () => {
    const { result } = await call(gitServer, cfg, "ips", "pr_create", pr, operator, { secrets: pemSecrets });
    assert.equal(result.isError, undefined, resultText(result));
    const out = resultJson(result);
    assert.equal(out.number, 42);
    assert.match(out.branch, /^ai\/\d{8}-[0-9a-f]{8}$/);
    const tokenReq = JSON.parse(up.calls.find((c) => c.url.includes("access_tokens"))!.body);
    assert.deepEqual(tokenReq.repositories, ["app-config"]);
    const prReq = JSON.parse(up.calls.find((c) => c.url.endsWith("/pulls"))!.body);
    assert.match(prReq.body, /Demandé par \*\*bob\*\*/);
    assert.match(prReq.body, /agent-ops-change/);
    assert.ok(!up.calls.some((c) => /merge|reviews/.test(c.url)));
    assert.equal(out.branch, proposalBranch("org/app-config", "main", pr.title, pr.files), "branche tirée du contenu");
  });

  it("simulation : fichiers créés ou modifiés, jeton en lecture seule, aucune écriture", async () => {
    const writes = () => up.calls.filter((c) => c.method === "PUT" || (c.method === "POST" && !c.url.includes("access_tokens"))).length;
    const before = writes();
    const { result } = await call(gitServer, cfg, "ips", "pr_create", { ...pr, dry_run: true }, operator, { secrets: pemSecrets });
    const out = resultJson(result);
    assert.deepEqual(out.files, [{ path: "apps/payment/values-npr.yaml", action: "create", bytes: Buffer.byteLength(pr.files[0].content) }]);
    assert.equal(writes(), before);
    const tokenReq = JSON.parse(up.calls.filter((c) => c.url.includes("access_tokens")).at(-1)!.body);
    assert.deepEqual(tokenReq.permissions, { contents: "read", pull_requests: "read" });
  });

  it("la même proposition déjà ouverte est rendue, pas dupliquée", async () => {
    openPrs = [{ number: 42, html_url: "https://github.test/org/app-config/pull/42" }];
    const before = up.calls.filter((c) => c.method === "PUT").length;
    const out = resultJson((await call(gitServer, cfg, "ips", "pr_create", pr, operator, { secrets: pemSecrets })).result);
    assert.deepEqual([out.number, out.unchanged], [42, true]);
    assert.equal(up.calls.filter((c) => c.method === "PUT").length, before);
    const q = new URL(up.calls.filter((c) => c.url.startsWith("/repos/org/app-config/pulls?")).at(-1)!.url, "http://x").searchParams;
    assert.equal(q.get("head"), `org:${proposalBranch("org/app-config", "main", pr.title, pr.files)}`);
    openPrs = [];
  });

  it("la branche dépend du contenu et du jour", () => {
    const d = new Date("2026-10-12T10:00:00Z");
    const a = proposalBranch("org/app-config", "main", pr.title, pr.files, d);
    assert.equal(a, proposalBranch("org/app-config", "main", pr.title, pr.files, d));
    assert.notEqual(a, proposalBranch("org/app-config", "main", pr.title, [{ ...pr.files[0], content: "autre" }], d));
    assert.match(a, /^ai\/20261012-[0-9a-f]{8}$/);
  });
});

// ── mcp-prtg ─────────────────────────────────────────────────────────────────
describe("mcp-prtg", async () => {
  let up: Awaited<ReturnType<typeof fakeUpstream>>;
  let cfg: Record<string, unknown>;
  before(async () => {
    up = await fakeUpstream({ "GET /api/table.json": () => ({ json: { sensors: [{ objid: 1, sensor: "Ping", status: "Down" }] } }) });
    cfg = { url: up.url, apiKey: { type: "kv", path: "mcp-prtg/api", key: "key" } };
  });
  after(() => up.close());

  it("refuse plus de 24 h d'historique", async () => {
    assertInvalid((await call(prtgServer, cfg, "ips", "sensors_down", { sensor_id: 1, hours: 25 }, reader)).result);
  });
  it("liste les capteurs en erreur, sans laisser la clé dans l'audit", async () => {
    const { result, audit } = await call(prtgServer, cfg, "ips", "sensors_down", {}, reader);
    assert.equal(resultJson(result).count, 1);
    const q = new URL(up.calls.at(-1)!.url, "http://x").searchParams;
    assert.deepEqual(q.getAll("filter_status"), ["5", "14", "13"]);
    assert.equal(q.get("apitoken"), "secret-mcp-prtg/api");
    assert.ok(!JSON.stringify(audit).includes("secret-mcp-prtg/api"));
  });
});
