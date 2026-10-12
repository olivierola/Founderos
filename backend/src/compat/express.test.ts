import { ANON_KEY, listen } from "../test-env.ts";

import assert from "node:assert/strict";
import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import { createServer } from "../server.ts";
import type { EdgeRegistry } from "./express.ts";

const encode = (s: string) => new TextEncoder().encode(s);
let clientAborted = false;
let flakyLoads = 0;

const registry: EdgeRegistry = {
  echo: async () => ({
    default: async (req) => {
      const url = new URL(req.url);
      return Response.json({
        method: req.method,
        path: url.pathname,
        query: url.search,
        forwardedFor: req.headers.get("x-forwarded-for"),
        contentType: req.headers.get("content-type"),
        body: await req.text(),
      });
    },
  }),
  stream: async () => ({
    default: () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            for (const chunk of ["a", "b", "c"]) {
              controller.enqueue(encode(`data: ${chunk}\n\n`));
              await sleep(10);
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  }),
  cookies: async () => ({
    default: () => {
      const headers = new Headers({ location: "/next", "x-custom": "yes" });
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return new Response(null, { status: 302, headers });
    },
  }),
  boom: async () => ({
    default: () => {
      throw new Error("kaboom");
    },
  }),
  flaky: async () => {
    if (flakyLoads++ === 0) throw new Error("load failed");
    return { default: () => new Response("loaded") };
  },
  hang: async () => ({
    default: (req) => {
      req.signal.addEventListener("abort", () => {
        clientAborted = true;
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encode("first"));
          },
        }),
      );
    },
  }),
};

let server: Server;
let base: string;

before(async () => {
  server = createServer(registry);
  base = await listen(server);
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const call = (path: string, init: RequestInit = {}) =>
  fetch(`${base}/functions/v1/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${ANON_KEY}`, ...(init.headers as Record<string, string>) },
  });

test("la requête arrive intacte : méthode, chemin, query, en-têtes, corps brut", async () => {
  const res = await call("echo/sub/path?x=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"hello":"world"}',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    method: "POST",
    path: "/functions/v1/echo/sub/path",
    query: "?x=1",
    forwardedFor: "127.0.0.1",
    contentType: "application/json",
    body: '{"hello":"world"}',
  });
});

test("x-forwarded-for ne garde que l'IP résolue par Express, pas celles écrites par le client", async () => {
  // TRUST_PROXY=1 : seule la dernière entrée vient du proxy de confiance.
  const res = await call("echo", { headers: { "x-forwarded-for": "1.1.1.1, 6.6.6.6" } });
  assert.equal(((await res.json()) as { forwardedFor: string }).forwardedFor, "6.6.6.6");
});

test("une réponse en flux (SSE) est transmise en entier", async () => {
  const res = await call("stream");
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(await res.text(), "data: a\n\ndata: b\n\ndata: c\n\n");
});

test("statut, en-têtes et plusieurs Set-Cookie sont recopiés", async () => {
  const res = await call("cookies", { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/next");
  assert.equal(res.headers.get("x-custom"), "yes");
  assert.deepEqual(res.headers.getSetCookie(), ["a=1", "b=2"]);
});

test("un handler qui lève donne une 500 JSON", async () => {
  const res = await call("boom", { method: "POST" });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "kaboom" });
});

test("un module qui échoue au chargement est retenté à la requête suivante", async () => {
  assert.equal((await call("flaky")).status, 500);
  const res = await call("flaky");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "loaded");
});

test("le départ du client annule req.signal, comme sous Deno", async () => {
  const controller = new AbortController();
  const res = await call("hang", { signal: controller.signal });
  const reader = res.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  controller.abort();
  for (let i = 0; i < 50 && !clientAborted; i++) await sleep(20);
  assert.equal(clientAborted, true);
});
