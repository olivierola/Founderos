// Vercel Cron handler — triggered every minute by vercel.json cron config.
// Runs one tick of the FounderOS runner: tries each source in priority order.
//
// Sources included (serverless-compatible):
//   1. Security scans  — TCP port scans (non-destructive, consented)
//   2. Simulations     — LLM-driven multi-agent simulations (HTTP-only)
//
// Sources NOT included (need a real server):
//   - Ops jobs (SSH)
//   - E2E tests (Playwright/Chromium)

import { SUPABASE_URL, RUNNER_TOKEN, RUNNER_ID, ts } from "../src/env.js";
import { pollSecurity } from "../src/sources/security.js";
import { pollSimulation } from "../src/sources/simulation.js";

export default async function handler(req, res) {
  // Verify cron secret (Vercel sets CRON_SECRET for cron invocations).
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["authorization"] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!SUPABASE_URL || !RUNNER_TOKEN) {
    return res.status(500).json({ error: "SUPABASE_URL and RUNNER_TOKEN env vars required" });
  }

  const started = Date.now();
  const results = [];

  // Time budget: leave 10s margin before Vercel kills the function.
  const maxDuration = Number(process.env.MAX_DURATION_MS) || 120000;

  // 1) Security scans (fast, one-shot)
  try {
    const sec = await pollSecurity();
    if (sec.didWork) results.push({ source: "security", ...sec });
  } catch (e) {
    results.push({ source: "security", error: e.message });
  }

  // 2) Simulations (may run many rounds — gets remaining time budget)
  const remaining = maxDuration - (Date.now() - started);
  if (remaining > 5000) {
    try {
      const sim = await pollSimulation(remaining - 3000);
      if (sim.didWork) results.push({ source: "simulation", ...sim });
    } catch (e) {
      results.push({ source: "simulation", error: e.message });
    }
  }

  const elapsed = Date.now() - started;

  return res.status(200).json({
    ok: true,
    runner_id: RUNNER_ID,
    elapsed_ms: elapsed,
    work: results.length > 0 ? results : "idle",
    ts: ts(),
  });
}
