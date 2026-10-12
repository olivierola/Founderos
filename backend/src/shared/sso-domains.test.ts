// SSO pour toutes les organisations (0282) : le mode, la preuve de propriété
// d'un domaine par DNS, et l'identifiant d'un fournisseur en mode partagé.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  configuredSsoMode, effectiveSsoMode, lookupTxt, newVerificationToken, sharedAuthRef, verificationRecordName, verifyDomainTxt,
} from "../edge/_shared/sso-domains.ts";

const env = (vars: Record<string, string>) => (k: string) => vars[k];

describe("le mode du SSO", () => {
  it("partagé par défaut ; dédié avec SSO_MODE ou l'ancien SSO_ADMIN_ENABLED ; fermé avec off", () => {
    assert.equal(configuredSsoMode(env({})), "shared");
    assert.equal(configuredSsoMode(env({ SSO_ADMIN_ENABLED: "1" })), "dedicated");
    assert.equal(configuredSsoMode(env({ SSO_MODE: "dedicated" })), "dedicated");
    assert.equal(configuredSsoMode(env({ SSO_MODE: "SHARED", SSO_ADMIN_ENABLED: "1" })), "shared");
    assert.equal(configuredSsoMode(env({ SSO_MODE: "off", SSO_ADMIN_ENABLED: "1" })), "off");
  });

  it("une organisation « maison » déjà revendiquée : dédié, comme la base le voit", () => {
    assert.equal(effectiveSsoMode("shared", true), "dedicated");
    assert.equal(effectiveSsoMode("shared", false), "shared");
    assert.equal(effectiveSsoMode("dedicated", false), "dedicated");
    assert.equal(effectiveSsoMode("off", true), "off");
  });
});

describe("la preuve de propriété d'un domaine", () => {
  it("un jeton au format que la base accepte, différent à chaque fois", () => {
    const a = newVerificationToken();
    assert.match(a, /^founderos-sso=[A-Za-z0-9_-]{20,64}$/);
    assert.notEqual(a, newVerificationToken());
    assert.equal(verificationRecordName("acme.com"), "_founderos-sso.acme.com");
  });

  it("lit les TXT par DNS-over-HTTPS, y compris une valeur en plusieurs morceaux", async () => {
    let asked = "";
    const fake = (async (url: string) => {
      asked = url;
      return new Response(JSON.stringify({
        Status: 0,
        Answer: [
          { type: 16, data: "\"v=spf1 -all\"" },
          { type: 16, data: "\"founderos-sso=abc\" \"def\"" },
          { type: 5, data: "cname.example." },
        ],
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const values = await lookupTxt("_founderos-sso.acme.com", { fetch: fake, resolver: "https://dns.test/q" });
    assert.deepEqual(values, ["v=spf1 -all", "founderos-sso=abcdef"]);
    assert.equal(asked, "https://dns.test/q?name=_founderos-sso.acme.com&type=TXT");
  });

  it("un nom absent (NXDOMAIN) : aucune valeur ; un résolveur en panne : une erreur", async () => {
    const nx = (async () => new Response(JSON.stringify({ Status: 3 }), { status: 200 })) as unknown as typeof fetch;
    assert.deepEqual(await lookupTxt("x", { fetch: nx, resolver: "https://dns.test/q" }), []);
    const down = (async () => new Response("boom", { status: 502 })) as unknown as typeof fetch;
    await assert.rejects(lookupTxt("x", { fetch: down, resolver: "https://dns.test/q" }), /HTTP 502/);
  });

  it("vérifié seulement si la valeur exacte est publiée", async () => {
    const token = "founderos-sso=" + "b".repeat(32);
    assert.equal((await verifyDomainTxt("acme.com", token, async () => ["autre", token])).ok, true);
    const wrong = await verifyDomainTxt("acme.com", token, async () => ["founderos-sso=autre"]);
    assert.equal(wrong.ok, false);
    assert.match(wrong.detail, /sans la valeur attendue/);
    assert.match((await verifyDomainTxt("acme.com", token, async () => [])).detail, /Aucun enregistrement/);
    assert.match((await verifyDomainTxt("acme.com", token, async () => { throw new Error("timeout"); })).detail, /Lecture DNS impossible/);
  });
});

describe("l'identifiant d'un fournisseur en mode partagé", () => {
  it("préfixé par l'organisation : deux organisations peuvent choisir « entra »", () => {
    const a = sharedAuthRef("1a2b3c4d-0000-4000-8000-000000000001", "entra");
    const b = sharedAuthRef("9f8e7d6c-0000-4000-8000-000000000002", "entra");
    assert.equal(a, "custom:o1a2b3c4d-entra");
    assert.notEqual(a, b);
    assert.match(a, /^custom:[a-z0-9-]+$/);
  });
});
