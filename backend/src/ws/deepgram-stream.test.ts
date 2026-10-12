import { listen } from "../test-env.ts";

import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { createServer } from "../server.ts";

let server: Server;
let base: string;

before(async () => {
  server = createServer({});
  base = await listen(server);
});

after(() => {
  server.close();
});

/** Statut HTTP renvoyé au lieu de l'ouverture du WebSocket. */
function upgradeStatus(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}${path}`);
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.on("open", () => reject(new Error("le WebSocket n'aurait pas dû s'ouvrir")));
    ws.on("error", () => resolve(0));
  });
}

test("une requête HTTP ordinaire reçoit 426, sans exiger de JWT", async () => {
  const res = await fetch(`${base}/functions/v1/deepgram-stream`);
  assert.equal(res.status, 426);
});

test("sans clé Deepgram, l'ouverture est refusée en 501", async () => {
  delete process.env.DEEPGRAM_API_KEY;
  assert.equal(await upgradeStatus("/functions/v1/deepgram-stream?token=x"), 501);
});

test("avec une session invalide, l'ouverture est refusée en 401", async () => {
  process.env.DEEPGRAM_API_KEY = "dg-test";
  try {
    assert.equal(await upgradeStatus("/functions/v1/deepgram-stream?token=bad"), 401);
  } finally {
    delete process.env.DEEPGRAM_API_KEY;
  }
});

test("un WebSocket vers un autre chemin est coupé", async () => {
  assert.equal(await upgradeStatus("/functions/v1/autre-chose"), 0);
});
