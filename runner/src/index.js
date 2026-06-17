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
  while (true) {
    const didWork = await tick();
    if (!didWork) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("unhandledRejection", (e) => console.error("Unhandled rejection:", e));
main();
