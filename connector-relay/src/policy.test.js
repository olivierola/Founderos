// node --test src/  (les variables sont posées avant l'import du module)
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RELAY_ALLOWED_HOSTS = "argocd.corp,*.monitoring.svc.cluster.local,vault.corp:8200,10.20.0.0/16";
process.env.RELAY_ALLOWED_BINARIES = "helm,kubectl";
const { hostAllowed, commandAllowed } = await import("./policy.js");

test("hôtes autorisés", () => {
  assert.equal(hostAllowed("https://argocd.corp/api/v1/applications").ok, true);
  assert.equal(hostAllowed("http://loki.monitoring.svc.cluster.local:3100/ready").ok, true);
  assert.equal(hostAllowed("https://vault.corp:8200/v1/sys/health").ok, true);
  assert.equal(hostAllowed("http://10.20.3.4:9090/api/v1/alerts").ok, true);
});

test("hôtes refusés", () => {
  assert.equal(hostAllowed("https://vault.corp/v1/sys/health").ok, false, "port non listé");
  assert.equal(hostAllowed("https://evil.com/").ok, false);
  assert.equal(hostAllowed("https://argocd.corp.evil.com/").ok, false);
  assert.equal(hostAllowed("https://monitoring.svc.cluster.local/").ok, false, "le joker exige un sous-domaine");
  assert.equal(hostAllowed("http://10.21.0.1/").ok, false);
  assert.equal(hostAllowed("http://169.254.169.254/latest/meta-data").ok, false);
  assert.equal(hostAllowed("file:///etc/passwd").ok, false);
});

test("commandes", () => {
  assert.equal(commandAllowed("helm", ["list", "--all-namespaces", "--output", "json"]).ok, true);
  assert.equal(commandAllowed("helm", ["uninstall", "payments"]).ok, false);
  assert.equal(commandAllowed("kubectl", ["delete", "pod", "x"]).ok, false);
  assert.equal(commandAllowed("kubectl", ["-n", "prod", "exec", "x"]).ok, false, "sous-commande après une option");
  assert.equal(commandAllowed("bash", ["-c", "id"]).ok, false);
  assert.equal(commandAllowed("helm", ["status", "x;rm -rf /"]).ok, false);
  assert.equal(commandAllowed("helm", ["status", "$(id)"]).ok, false);
});
