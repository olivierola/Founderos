// FounderOS Unified Runner.
//
// A single poll loop that claims and executes work from three sources, in
// priority order, using one runner token:
//   1. Ops jobs        — SSH / infra (ops-runner-poll)
//   2. E2E test runs   — Playwright (test-runner-poll)
//   3. Security scans  — defensive + consented active scans (security-scan-poll)
//
// Each source is a self-contained module exposing `poll()` that returns true if
// it did work this tick. We try them in order so infra/test work isn't starved.

import { RUNNER_ID, SUPABASE_URL, POLL_INTERVAL_MS, ts } from "./env.js";
import { pollOps } from "./sources/ops.js";
import { pollTest } from "./sources/test.js";
import { pollSecurity } from "./sources/security.js";
import { pollSimulation } from "./sources/simulation.js";
import { startVoiceServer } from "./voice.js";
import { startBrowserServer } from "./browser.js";
import net from "node:net";

const SOURCES = [pollOps, pollTest, pollSecurity, pollSimulation];

async function tick() {
  for (const source of SOURCES) {
    try {
      const didWork = await source();
      if (didWork) return true; // do one unit of work per tick, then re-poll
    } catch (e) {
      console.error(`[${ts()}] ${source.name} error: ${e.message}`);
    }
  }
  return false;
}

async function main() {
  console.log("FounderOS Unified Runner");
  console.log(`  runner_id: ${RUNNER_ID}`);
  console.log(`  url:       ${SUPABASE_URL}`);
  console.log(`  sources:   ops · tests · security · simulations`);
  startVoiceServer(); // persistent voice WS bridge (only if configured)
  // Choose a free port for the browser server. Start at BROWSER_PORT or 3847
  const basePort = Number(process.env.BROWSER_PORT) || 3847;
  async function isPortFree(port) {
    return new Promise((resolve) => {
      const tester = net.createServer()
        .once("error", (err) => {
          tester.close?.();
          resolve(false);
        })
        .once("listening", () => {
          tester.close(() => resolve(true));
        })
        .listen(port, "0.0.0.0");
    });
  }

  async function findAvailablePort(start, attempts = 20) {
    for (let i = 0; i < attempts; i++) {
      const p = start + i;
      // eslint-disable-next-line no-await-in-loop
      if (await isPortFree(p)) return p;
    }
    return null;
  }

  const browserPort = await findAvailablePort(basePort, 20);
  if (!browserPort) {
    console.error(`[${ts()}] No available port found starting at ${basePort}`);
    process.exit(1);
  }
  console.log(`[${ts()}] Starting browser server on port ${browserPort}`);
  startBrowserServer(browserPort); // Playwright HTTP API for AI agents
  while (true) {
    const didWork = await tick();
    if (!didWork) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));
main();
