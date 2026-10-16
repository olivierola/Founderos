// L'installateur (G5) : founderos.yaml validé, secrets générés une fois puis
// gardés, sorties de chaque profil.
import assert from "node:assert/strict";
import { createHmac, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import yaml from "js-yaml";
import {
  ConfigError, composeEnv, externalSecrets, generateSecrets, helmValues, k8sSecrets, normalizeConfig, supabaseEnv, supabaseKey,
} from "./config.mjs";

const profile = (name) => yaml.load(readFileSync(path.join(import.meta.dirname, "profiles", `${name}.yaml`), "utf8"));
const example = () => yaml.load(readFileSync(path.join(import.meta.dirname, "founderos.example.yaml"), "utf8"));

describe("founderos.yaml", () => {
  it("l'exemple et les quatre profils sont valables", () => {
    for (const c of [example(), profile("kubernetes"), profile("openshift-hub"), profile("openshift-scic"), profile("vm")]) assert.ok(normalizeConfig(c));
  });

  it("les adresses se déduisent du domaine, ou se donnent", () => {
    const c = normalizeConfig({ domain: "acme.fr", admins: ["a@acme.fr"] });
    assert.deepEqual(c.urls, { web: "https://founderos.acme.fr", api: "https://founderos-api.acme.fr", supabase: "https://founderos-sb.acme.fr" });
    assert.equal(normalizeConfig({ urls: { web: "https://x.fr/", api: "https://api.x.fr", supabase: "https://sb.x.fr" }, admins: ["a@x.fr"] }).urls.web, "https://x.fr");
  });

  it("toutes les erreurs d'un coup, chacune nommée", () => {
    try {
      normalizeConfig({ target: "nomad", domain: "pas un domaine", admins: ["pas-une-adresse"], llm: { gateway: "litellm" }, secrets: { source: "vault" } });
      assert.fail("aurait dû refuser");
    } catch (e) {
      assert.ok(e instanceof ConfigError);
      const all = e.issues.join("\n");
      for (const m of ["target", "domain", "admins", "llm.litellm.url", "secrets.vault.path"]) assert.match(all, new RegExp(m.replace(".", "\\.")));
    }
  });

  it("Supabase fourni : ses clés sont exigées ; une VM génère ses secrets", () => {
    assert.throws(() => normalizeConfig({ domain: "a.fr", admins: ["x@a.fr"], supabase: { mode: "provided" } }), /supabase\.anonKey/);
    assert.throws(() => normalizeConfig({ target: "vm", domain: "a.fr", admins: ["x@a.fr"], secrets: { source: "vault", vault: { path: "p" } } }), /target vm/);
  });
});

describe("secrets", () => {
  const cfg = normalizeConfig(profile("kubernetes"));

  it("clé de chiffrement de 32 octets, clé de signature EC P-256 en PKCS#8", () => {
    const s = generateSecrets(cfg);
    assert.equal(Buffer.from(s.CREDENTIAL_ENCRYPTION_KEY, "base64").length, 32);
    const key = createPrivateKey(s.APPROVAL_SIGNING_KEY);
    assert.equal(key.asymmetricKeyType, "ec");
    assert.equal(key.asymmetricKeyDetails?.namedCurve, "prime256v1");
  });

  it("Supabase auto-hébergé : clés anon et service_role signées par le secret JWT, base sur l'hôte du profil", () => {
    const s = generateSecrets(cfg);
    for (const [key, role] of [[s.SUPABASE_ANON_KEY, "anon"], [s.SUPABASE_SERVICE_ROLE_KEY, "service_role"]]) {
      const [h, p, sig] = key.split(".");
      const expected = createHmac("sha256", s.SUPABASE_JWT_SECRET).update(`${h}.${p}`).digest("base64url");
      assert.equal(sig, expected);
      assert.equal(JSON.parse(Buffer.from(p, "base64url").toString()).role, role);
    }
    assert.match(s.SUPABASE_DATABASE_URL, /^postgres:\/\/postgres:[A-Za-z0-9_-]+@supabase-db\.supabase\.svc:5432\/postgres$/);
    assert.equal(supabaseKey("s", "anon", 1).split(".").length, 3);
  });

  it("relancer garde les secrets ; --rotate les renouvelle", () => {
    const first = generateSecrets(cfg);
    const again = generateSecrets(cfg, first);
    assert.deepEqual(again, first);
    const rotated = generateSecrets(cfg, first, { rotate: true });
    assert.notEqual(rotated.CREDENTIAL_ENCRYPTION_KEY, first.CREDENTIAL_ENCRYPTION_KEY);
    assert.notEqual(rotated.SUPABASE_ANON_KEY, first.SUPABASE_ANON_KEY);
  });

  it("la clé LiteLLM vient de l'environnement, jamais du fichier", () => {
    process.env.LLM_API_KEY = "sk-env";
    try { assert.equal(generateSecrets(cfg).LLM_API_KEY, "sk-env"); } finally { delete process.env.LLM_API_KEY; }
    assert.equal("LLM_API_KEY" in generateSecrets(cfg), false);
  });
});

describe("sorties", () => {
  it("Kubernetes : valeurs du chart sans secret, Secrets aux noms attendus", () => {
    const cfg = normalizeConfig(profile("kubernetes"));
    const s = generateSecrets(cfg);
    const values = helmValues(cfg);
    assert.equal(values.platform, "kubernetes");
    assert.equal(values.backend.publicUrl, "https://founderos-api.acme.fr");
    assert.deepEqual(values.ingress, { className: "nginx", tlsSecretName: "founderos-tls" });
    const dumped = JSON.stringify(values);
    for (const secret of [s.CREDENTIAL_ENCRYPTION_KEY, s.SUPABASE_ANON_KEY, s.POSTGRES_PASSWORD]) assert.equal(dumped.includes(secret), false);
    const [backend, supabase] = k8sSecrets(cfg, s);
    assert.equal(backend.metadata.name, "founderos-backend");
    assert.deepEqual(Object.keys(supabase.stringData).sort(), ["anonKey", "databaseUrl", "jwtSecret", "serviceRoleKey"]);
    assert.match(supabaseEnv(cfg, s), /^SITE_URL=https:\/\/founderos\.acme\.fr$/m);
    assert.match(supabaseEnv(cfg, s), /^GOTRUE_SESSIONS_TIMEBOX=24h$/m, "sessions bornées par défaut");
    assert.match(supabaseEnv(cfg, s), /^GOTRUE_SESSIONS_INACTIVITY_TIMEOUT=8h$/m);
    assert.throws(() => normalizeConfig({ ...profile("kubernetes"), sessions: { timebox: "un jour" } }), /sessions\.timebox/);
  });

  it("OpenShift SCIC : Routes du shard interne, passerelle LiteLLM verrouillée, secrets recopiés de Vault", () => {
    const cfg = normalizeConfig(profile("openshift-scic"));
    const values = helmValues(cfg);
    assert.equal(values.platform, "openshift");
    assert.deepEqual(values.route.labels, { shard: "internal" });
    assert.equal(values.backend.env.LLM_UPSTREAM, "litellm");
    assert.equal(values.backend.env.LLM_MODEL_HEAVY, "ops-reasoning");
    assert.equal(values.backend.ssoMode, "dedicated");
    const [backend] = externalSecrets(cfg);
    assert.equal(backend.spec.secretStoreRef.name, "vault-ips");
    assert.ok(backend.spec.data.every((d) => d.remoteRef.key === "secret/data/founderos"));
  });

  it("OpenShift Hub : Azure OpenAI en direct, SSO dédié, secrets générés (ni Vault ni LiteLLM)", () => {
    const cfg = normalizeConfig(profile("openshift-hub"));
    const values = helmValues(cfg);
    assert.equal(values.platform, "openshift");
    assert.deepEqual(values.route.labels, { shard: "internal" });
    assert.equal(values.backend.ssoMode, "dedicated");
    assert.deepEqual(values.backend.env, {
      LLM_UPSTREAM: "azure", AZURE_OPENAI_BASE_URL: "https://entreprise-founderos.openai.azure.com/openai/v1",
      AZURE_OPENAI_DEPLOYMENT: "gpt-6-luna", AZURE_OPENAI_DEPLOYMENT_HEAVY: "gpt-6-sol",
    });
    assert.equal(values.supabase.internalUrl, "http://founderos-sb-kong.founderos.svc:8000");
    assert.equal(cfg.secrets.source, "generate");
    const [backend] = k8sSecrets(cfg, generateSecrets(cfg));
    assert.deepEqual(Object.keys(backend.stringData).sort(), ["APPROVAL_SIGNING_KEY", "CREDENTIAL_ENCRYPTION_KEY"], "la clé Azure vient de LLM_API_KEY, jamais du fichier");
    assert.deepEqual(values.mcp, {
      internalHosts: ["mcp.apps-int.*.interne.exemple"],
      clientCert: {
        secretName: "founderos-mcp-client", caConfigMap: "platform-internal-ca-bundle",
        certManager: { enabled: true, issuerKind: "ClusterIssuer", issuerName: "platform-internal-ca", commonName: "founderos-ai-platform" },
      },
    });
  });

  it("serveurs MCP : motifs d'hôtes valides, un certificat qui sert à quelque chose", () => {
    const hub = profile("openshift-hub");
    assert.throws(() => normalizeConfig({ ...hub, mcp: { internalHosts: ["https://mcp.x.fr"] } }), /mcp\.internalHosts/);
    assert.throws(() => normalizeConfig({ ...hub, mcp: { clientCert: { issuer: "ca" } } }), /sans mcp\.internalHosts/);
    assert.throws(() => normalizeConfig({ ...hub, mcp: { internalHosts: ["mcp.x.fr"], clientCert: { issuer: "ca", secretName: "s" } } }), /pas les deux/);
    const existing = helmValues(normalizeConfig({ ...hub, mcp: { internalHosts: ["mcp.x.fr"], clientCert: { secretName: "mon-cert" } } }));
    assert.deepEqual(existing.mcp.clientCert, { secretName: "mon-cert", caConfigMap: "", certManager: { enabled: false } });
    assert.equal(helmValues(normalizeConfig(profile("kubernetes"))).mcp, undefined, "sans section mcp, rien n'est ajouté");
  });

  it("VM : un .env que docker compose lit, clé PEM comprise", () => {
    const cfg = normalizeConfig(profile("vm"));
    const s = generateSecrets(cfg);
    const env = composeEnv(cfg, s);
    assert.match(env, /^FOUNDEROS_WEB_HOST=founderos\.acme\.fr$/m);
    assert.match(env, /^DATABASE_URL=postgres:\/\/postgres:.+@db:5432\/postgres$/m);
    const pem = /^APPROVAL_SIGNING_KEY="(.+)"$/m.exec(env)?.[1];
    assert.ok(pem, "la clé PEM tient sur une ligne, entre guillemets");
    assert.ok(createPrivateKey(pem.replace(/\\n/g, "\n")));
  });
});
