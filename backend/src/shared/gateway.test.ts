import { ANON_KEY, JWT_SECRET, listen, SERVICE_ROLE_KEY } from "../test-env.ts";

import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, test } from "node:test";
import { SignJWT } from "jose";
import type { EdgeRegistry } from "../compat/express.ts";
import { createServer } from "../server.ts";

const ok = async () => ({ default: () => new Response("ok") });
// rag-chat est protégée en production ; stripe-webhook et simulation-prepare
// sont des exceptions de supabase/config.toml ; « other » n'est ni l'un ni l'autre.
const registry: EdgeRegistry = {
  "rag-chat": ok,
  "stripe-webhook": ok,
  "simulation-prepare": ok,
  other: ok,
};

const sign = (secret: string, expiresIn = "1h") =>
  new SignJWT({ sub: "user-1", role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));

function startServer(gateway: "production" | "strict") {
  let server: Server;
  let base = "";
  before(async () => {
    server = createServer(registry, { gateway });
    base = await listen(server);
  });
  after(() => {
    server.close();
  });
  return (name: string, token?: string) =>
    fetch(`${base}/functions/v1/${name}`, {
      method: "POST",
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    });
}

describe("mode strict (config.toml)", () => {
  const call = startServer("strict");

  test("sans Authorization : 401 avec le code de la passerelle Supabase", async () => {
    const res = await call("other");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      code: "UNAUTHORIZED_NO_AUTH_HEADER",
      message: "Missing authorization header",
      error: "Missing authorization header",
    });
  });

  test("un jeton qui n'est pas un JWT est refusé", async () => {
    const res = await call("other", "not-a-jwt");
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, "UNAUTHORIZED_INVALID_JWT_FORMAT");
  });

  test("la clé anon et la clé service role passent, comme chez Supabase", async () => {
    assert.equal((await call("other", ANON_KEY)).status, 200);
    assert.equal((await call("other", SERVICE_ROLE_KEY)).status, 200);
  });

  test("un JWT signé avec le secret du projet passe", async () => {
    assert.equal((await call("other", await sign(JWT_SECRET))).status, 200);
  });

  test("un JWT expiré ou signé avec un autre secret est refusé", async () => {
    const expired = await call("other", await sign(JWT_SECRET, "-1m"));
    const forged = await call("other", await sign("another-secret-that-is-also-32-chars-long"));
    assert.equal(expired.status, 401);
    assert.equal(forged.status, 401);
    assert.equal(((await forged.json()) as { code: string }).code, "UNAUTHORIZED_LEGACY_JWT");
  });

  test("les exceptions de config.toml passent sans jeton", async () => {
    assert.equal((await call("stripe-webhook")).status, 200);
    assert.equal((await call("simulation-prepare")).status, 200);
  });

  test("une fonction inconnue répond 404, pas 401", async () => {
    assert.equal((await call("nope")).status, 404);
  });
});

describe("mode production (défaut)", () => {
  const call = startServer("production");

  test("une fonction protégée en production exige un JWT", async () => {
    assert.equal((await call("rag-chat")).status, 401);
    assert.equal((await call("rag-chat", ANON_KEY)).status, 200);
  });

  test("une fonction ouverte en production le reste", async () => {
    assert.equal((await call("other")).status, 200);
  });

  test("une exception de config.toml l'emporte sur le relevé de production", async () => {
    assert.equal((await call("simulation-prepare")).status, 200);
  });
});
