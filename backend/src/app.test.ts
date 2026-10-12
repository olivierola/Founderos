import { ANON_KEY, listen } from "./test-env.ts";

import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { createServer } from "./server.ts";

let server: Server;
let base: string;

before(async () => {
  server = createServer();
  base = await listen(server);
});

after(() => {
  server.close();
});

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON_KEY}`, ...headers },
    body,
  });

const errorOf = async (res: globalThis.Response) => ((await res.json()) as { error?: string }).error;

test("GET /health répond", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("le preflight CORS autorise les en-têtes envoyés par callEdge", async () => {
  const res = await fetch(`${base}/functions/v1/delete-workspace`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:5173",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, apikey, content-type",
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /apikey/);
});

test("delete-workspace exige une vraie session, pas seulement la clé anon", async () => {
  const res = await post("/functions/v1/delete-workspace", JSON.stringify({ workspace_id: "w", confirm_slug: "s" }));
  assert.equal(res.status, 401);
  assert.equal(await errorOf(res), "Invalid session");
});

test("report-error valide son corps avant toute requête en base", async () => {
  const res = await post("/functions/v1/report-error", JSON.stringify({ workspace_id: "w" }));
  assert.equal(res.status, 400);
  assert.equal(await errorOf(res), "workspace_id, project_id, message required");
});

test("rag-agent-public-config exige une public_key, même sans corps", async () => {
  const res = await fetch(`${base}/functions/v1/rag-agent-public-config`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ANON_KEY}` },
  });
  assert.equal(res.status, 400);
  assert.equal(await errorOf(res), "public_key required");
});

test("un JSON invalide donne 400", async () => {
  const res = await post("/functions/v1/report-error", "{not json");
  assert.equal(res.status, 400);
  assert.equal(await errorOf(res), "Invalid JSON body");
});

test("une fonction inconnue donne 404 en JSON", async () => {
  const res = await post("/functions/v1/does-not-exist", "{}");
  assert.equal(res.status, 404);
  assert.equal(await errorOf(res), "Not found");
});

test("POST /functions/v1/installation-admin : fonction native, refusée sans session", async () => {
  const res = await fetch(`${base}/functions/v1/installation-admin`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "status" }),
  });
  assert.equal(res.status, 401);
  assert.match(String(await errorOf(res)), /Authorization/);
});
