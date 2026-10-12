// Réglages de l'installation (G4) : l'environnement prioritaire, un catalogue
// fermé, qui administre, et la surcouche vue par le code porté.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Deno, setEnvOverlay } from "../compat/index.ts";
import {
  applyInstallationOverlay, applySettingChanges, effectiveSettings, overlayFrom, resolveInstallationAdmin, secretsPresence, SETTINGS, SettingsError,
} from "./installation.ts";
import { pinnedUpstream } from "../edge/_shared/llm-upstream.ts";

describe("réglages effectifs", () => {
  it("l'environnement verrouille, puis le réglage d'installation, puis le défaut", () => {
    const eff = effectiveSettings(
      { LLM_BASE_URL: "https://litellm.db/v1", MCP_INTERNAL_HOSTS: "*.int.exemple" },
      { MCP_INTERNAL_HOSTS: "*.apps-int.*.scic", APPROVAL_ISSUER: "" },
    );
    const by = Object.fromEntries(eff.map((s) => [s.key, s]));
    assert.deepEqual([by.LLM_BASE_URL.source, by.LLM_BASE_URL.locked, by.LLM_BASE_URL.value], ["installation", false, "https://litellm.db/v1"]);
    assert.deepEqual([by.MCP_INTERNAL_HOSTS.source, by.MCP_INTERNAL_HOSTS.locked, by.MCP_INTERNAL_HOSTS.stored], ["env", true, "*.int.exemple"]);
    assert.equal(by.SSO_DNS_RESOLVER_URL.source, "default");
    assert.equal(by.APPROVAL_ISSUER.source, "unset", "une variable vide ne verrouille pas");
    assert.equal(eff.length, SETTINGS.length);
  });

  it("aucun secret au catalogue", () => {
    for (const s of SETTINGS) assert.doesNotMatch(s.key, /KEY|SECRET|TOKEN|PASSWORD|WEBHOOK/, s.key);
  });
});

describe("changements", () => {
  const env = { OPA_URL: "http://opa:8181" };

  it("valide, retire une valeur vidée, ignore ce qui ne change pas", () => {
    const { next, changed } = applySettingChanges(
      { LLM_MODEL_DEFAULT: "ops-default", APP_BASE_URL: "https://old.exemple" },
      { LLM_UPSTREAM: "litellm", LLM_BASE_URL: " https://litellm.interne/v1 ", APP_BASE_URL: "", LLM_MODEL_DEFAULT: "ops-default" },
      env,
    );
    assert.deepEqual(next, { LLM_MODEL_DEFAULT: "ops-default", LLM_UPSTREAM: "litellm", LLM_BASE_URL: "https://litellm.interne/v1" });
    assert.deepEqual(changed.map((c) => c.key).sort(), ["APP_BASE_URL", "LLM_BASE_URL", "LLM_UPSTREAM"]);
    assert.equal(changed.find((c) => c.key === "APP_BASE_URL")?.value, null);
  });

  it("refuse : réglage inconnu, secret, verrouillé par l'environnement, forme invalide", () => {
    assert.throws(() => applySettingChanges({}, { LLM_API_KEY: "sk-x" }, env), SettingsError);
    assert.throws(() => applySettingChanges({}, { PATH: "/tmp" }, env), /inconnu/);
    assert.throws(() => applySettingChanges({}, { OPA_URL: "http://autre:8181" }, env), /fixé par l'environnement/);
    assert.throws(() => applySettingChanges({}, { LLM_UPSTREAM: "openai" }, env), /litellm ou azure/);
    assert.throws(() => applySettingChanges({}, { LLM_BASE_URL: "ftp://x" }, env), /URL/);
    assert.throws(() => applySettingChanges({}, { MCP_INTERNAL_HOSTS: "a.exemple\nb" }, env), /plusieurs lignes/);
    assert.throws(() => applySettingChanges({}, { LLM_MODEL_DEFAULT: 42 }, env), /chaîne/);
  });

  it("les secrets : présents ou non, jamais leur valeur ; une clé de chiffrement mal formée est signalée", () => {
    const out = secretsPresence({ APPROVAL_SIGNING_KEY: "-----BEGIN PRIVATE KEY-----x", CREDENTIAL_ENCRYPTION_KEY: Buffer.from("court").toString("base64") });
    assert.equal(JSON.stringify(out).includes("BEGIN"), false);
    assert.equal(out.find((s) => s.key === "APPROVAL_SIGNING_KEY")?.present, true);
    assert.equal(out.find((s) => s.key === "LLM_API_KEY")?.present, false);
    assert.match(String(out.find((s) => s.key === "CREDENTIAL_ENCRYPTION_KEY")?.detail), /32 octets/);
  });
});

describe("qui administre l'installation", () => {
  const base = { email: "ops@scic.fr", adminsEnv: undefined, ownerWorkspaceId: null, homeWorkspaceId: null, roles: {}, workspaceCount: 3 };

  it("une adresse de INSTALLATION_ADMINS, sans tenir compte de la casse", () => {
    assert.deepEqual(resolveInstallationAdmin({ ...base, adminsEnv: "root@x.fr, OPS@scic.fr" }), { isAdmin: true, canClaim: false, via: "INSTALLATION_ADMINS" });
  });

  it("un owner ou admin de l'organisation propriétaire, à défaut de celle du SSO dédié ; pas un membre", () => {
    assert.equal(resolveInstallationAdmin({ ...base, ownerWorkspaceId: "ws-1", roles: { "ws-1": "admin" } }).isAdmin, true);
    assert.equal(resolveInstallationAdmin({ ...base, ownerWorkspaceId: "ws-1", roles: { "ws-1": "member" } }).isAdmin, false);
    assert.equal(resolveInstallationAdmin({ ...base, homeWorkspaceId: "ws-home", roles: { "ws-home": "owner" } }).via, "organisation du SSO dédié");
  });

  it("revendication : seulement sur une instance neuve, par l'owner de sa seule organisation", () => {
    assert.equal(resolveInstallationAdmin({ ...base, workspaceCount: 1, roles: { "ws-1": "owner" } }).canClaim, true);
    assert.equal(resolveInstallationAdmin({ ...base, workspaceCount: 2, roles: { "ws-1": "owner" } }).canClaim, false, "le cloud partagé : plusieurs organisations");
    assert.equal(resolveInstallationAdmin({ ...base, workspaceCount: 1, roles: { "ws-1": "member" } }).canClaim, false);
    assert.equal(resolveInstallationAdmin({ ...base, workspaceCount: 1, roles: { "ws-1": "owner" }, adminsEnv: "root@x.fr" }).canClaim, false,
      "INSTALLATION_ADMINS renseigné : personne d'autre ne revendique");
    assert.equal(resolveInstallationAdmin({ ...base, workspaceCount: 1, roles: { "ws-1": "owner" }, ownerWorkspaceId: "ws-9" }).canClaim, false);
  });
});

describe("la surcouche, vue par le code porté des edge functions", () => {
  it("un réglage d'installation est lu comme une variable ; l'environnement l'emporte ; hors catalogue, rien", () => {
    const saved = { up: process.env.LLM_UPSTREAM, url: process.env.LLM_BASE_URL };
    delete process.env.LLM_UPSTREAM;
    delete process.env.LLM_BASE_URL;
    try {
      assert.equal(pinnedUpstream(), null);
      applyInstallationOverlay({ LLM_UPSTREAM: "litellm", LLM_BASE_URL: "https://litellm.db/v1", PATH: "/injecté" });
      assert.equal(pinnedUpstream()?.baseUrl, "https://litellm.db/v1", "la passerelle réglée à l'écran est celle des agents");
      assert.notEqual(Deno.env.get("PATH"), "/injecté");
      process.env.LLM_BASE_URL = "https://litellm.env/v1";
      assert.equal(pinnedUpstream()?.baseUrl, "https://litellm.env/v1", "l'environnement garde la main");
      assert.deepEqual(overlayFrom({ OPA_URL: "http://opa", SUPABASE_URL: "http://x", LLM_MODEL_DEFAULT: "" }), { OPA_URL: "http://opa" });
    } finally {
      setEnvOverlay({});
      if (saved.up === undefined) delete process.env.LLM_UPSTREAM; else process.env.LLM_UPSTREAM = saved.up;
      if (saved.url === undefined) delete process.env.LLM_BASE_URL; else process.env.LLM_BASE_URL = saved.url;
    }
  });
});
