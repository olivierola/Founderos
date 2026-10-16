// Garde-fous d'exécution : débit par appelant, exécutions simultanées, délai,
// jeton d'approbation consommé une fois, codes d'erreur stables.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { paramsHash } from "../src/lib/canonical.ts";
import { UpstreamError } from "../src/lib/http.ts";
import { ApprovalLedger, BusyError, RateLimiter, Semaphore, TimeoutError, withTimeout } from "../src/lib/limits.ts";
import { defineTool, executeTool } from "../src/lib/tool.ts";
import { approvalToken, operator, reader, resultJson, runtime, signingKey } from "./helpers.ts";

describe("briques", () => {
  it("débit : une rafale, puis un jeton par intervalle ; le délai à attendre est donné", () => {
    let now = 0;
    const rl = new RateLimiter({ perMinute: 60, burst: 3 }, () => now);
    for (let i = 0; i < 3; i++) assert.equal(rl.take("a").ok, true);
    const r = rl.take("a");
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.retryAfterSeconds, 1);
    assert.equal(rl.take("b").ok, true, "un autre appelant a son propre seau");
    now += 1000;
    assert.equal(rl.take("a").ok, true);
  });

  it("exécutions simultanées : au-delà, attente bornée puis BusyError ; une place libérée profite au suivant", async () => {
    const s = new Semaphore(1);
    const release = await s.acquire(10);
    await assert.rejects(s.acquire(20), BusyError);
    const waiting = s.acquire(1000);
    release();
    const r2 = await waiting;
    assert.equal(s.inUse, 1);
    r2();
    r2();
    assert.equal(s.inUse, 0, "une double libération ne fausse pas le compte");
  });

  it("registre des approbations : un jti ne sert qu'une fois tant qu'il est valable", () => {
    let now = 0;
    const l = new ApprovalLedger(() => now);
    assert.equal(l.claim("a1", 300_000), true);
    assert.equal(l.claim("a1", 300_000), false);
    now = 400_000;
    assert.equal(l.claim("a1", 700_000), true, "oublié après expiration");
  });

  it("délai : TimeoutError au-delà", async () => {
    await assert.rejects(withTimeout(new Promise((r) => setTimeout(r, 200)), 20), TimeoutError);
    assert.equal(await withTimeout(Promise.resolve(7), 20), 7);
  });
});

describe("dans la chaîne d'exécution", () => {
  const read = (run: () => Promise<unknown>) => defineTool({ name: "pods_list", description: "test", write: false, input: { namespace: z.string().max(63) }, run });

  it("rate_limited, avec retry_after_seconds, et l'appel est audité", async () => {
    const { rt, audit } = await runtime("mcp", "npr", { limits: { rate: new RateLimiter({ perMinute: 1, burst: 1 }) } });
    const spec = read(async () => ({ ok: true }));
    assert.equal((await executeTool(rt, spec, { namespace: "a" }, reader)).isError, undefined);
    const body = resultJson(await executeTool(rt, spec, { namespace: "a" }, reader));
    assert.equal(body.error, "rate_limited");
    assert.ok(body.retry_after_seconds >= 1);
    assert.equal(audit.at(-1)!.status, "rate_limited");
  });

  it("timeout : le tool trop long rend timeout, avec la consigne de vérifier avant de relancer", async () => {
    const { rt, audit } = await runtime("mcp", "npr", { limits: { timeoutMs: 20 } });
    const body = resultJson(await executeTool(rt, read(() => new Promise((r) => setTimeout(r, 200))), { namespace: "a" }, reader));
    assert.equal(body.error, "timeout");
    assert.match(body.message, /vérifiez avant de relancer/);
    assert.equal(audit.at(-1)!.status, "timeout");
  });

  it("busy : plus de place dans la limite d'attente", async () => {
    const concurrency = new Semaphore(1);
    const hold = await concurrency.acquire(10);
    const { rt } = await runtime("mcp", "npr", { limits: { concurrency, queueWaitMs: 20 } });
    assert.equal(resultJson(await executeTool(rt, read(async () => 1), { namespace: "a" }, reader)).error, "busy");
    hold();
  });

  it("codes de l'outil : not_found (404), forbidden (403), upstream_error (le reste)", async () => {
    const { rt } = await runtime("mcp", "npr");
    for (const [status, code] of [[404, "not_found"], [403, "forbidden"], [500, "upstream_error"]] as const) {
      const body = resultJson(await executeTool(rt, read(async () => { throw new UpstreamError(`API : ${status}`, status); }), { namespace: "a" }, reader));
      assert.equal(body.error, code);
    }
  });

  it("une écriture approuvée consomme son jeton : le rejeu est refusé ; une simulation ne le consomme pas", async () => {
    const keys = await signingKey();
    const { rt, audit } = await runtime("mcp-openshift", "prd", { approvalJwks: keys.jwks, limits: { approvals: new ApprovalLedger() } });
    let runs = 0;
    const spec = defineTool({
      name: "deployment_restart", description: "test", write: true,
      input: { namespace: z.string().max(63), name: z.string().max(63), dry_run: z.boolean().default(false) },
      async run() { runs++; return { ok: true }; },
    });
    const sign = async (args: Record<string, unknown>) => approvalToken(keys.privateKey, {
      aud: "mcp-openshift-prd", sub: "u-bob", approver: "u-carol", tool: "deployment_restart", target_cluster: "prd", params_hash: paramsHash(args),
    });
    const dry = { namespace: "app-a", name: "api", dry_run: true };
    const dryToken = await sign(dry);
    assert.equal((await executeTool(rt, spec, dry, operator, dryToken)).isError, undefined);
    assert.equal((await executeTool(rt, spec, dry, operator, dryToken)).isError, undefined, "la simulation ne consomme pas");
    const real = { namespace: "app-a", name: "api", dry_run: false };
    const token = await sign(real);
    assert.equal((await executeTool(rt, spec, real, operator, token)).isError, undefined);
    const replay = resultJson(await executeTool(rt, spec, real, operator, token));
    assert.equal(replay.reason, "approval_replayed");
    assert.equal(runs, 3, "le rejeu n'a rien exécuté");
    assert.equal(audit.at(-1)!.policy_decision, "deny:approval_replayed");
  });
});
