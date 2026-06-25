// Simulation source — claims a queued simulation and drives it round by round.
// Adapted for serverless: runs rounds within a time budget, then exits.
// If rounds remain, the sim stays "running" and the next cron tick continues it.
import { rpc, RUNNER_ID, ts } from "../env.js";

const MAX_ROUNDS_GUARD = 60;

export async function pollSimulation(timeBudgetMs = 120000) {
  const deadline = Date.now() + timeBudgetMs;

  // 1) Check if we have an in-progress simulation to continue.
  let sim;
  try {
    const resp = await rpc("simulation-prepare", { action: "claim", runner_id: RUNNER_ID });
    sim = resp?.simulation ?? null;
  } catch (e) {
    if (!/HTTP 40|not found/i.test(e.message)) console.error(`[${ts()}] simulation claim: ${e.message}`);
    return { didWork: false };
  }
  if (!sim || !sim.id) return { didWork: false };

  const short = String(sim.id).slice(0, 8);
  const log = [`claimed ${short} "${(sim.name || "").slice(0, 40)}" (${sim.total_rounds} rounds)`];

  try {
    let lastRound = sim.current_round || 0;
    for (let i = 0; i < MAX_ROUNDS_GUARD; i++) {
      if (Date.now() > deadline) {
        log.push(`time budget reached after round ${lastRound} — will continue next tick`);
        break;
      }
      const r = await rpc("simulation-prepare", { action: "round", simulation_id: sim.id, runner_id: RUNNER_ID });
      lastRound = r.round;
      log.push(`round ${r.round}/${sim.total_rounds} — ${r.actions} actions`);
      if (r.done) {
        await rpc("simulation-prepare", { action: "complete", simulation_id: sim.id, status: "completed" });
        log.push("completed — report generated");
        break;
      }
    }
  } catch (e) {
    log.push(`error: ${e.message}`);
    await rpc("simulation-prepare", { action: "complete", simulation_id: sim.id, status: "failed", error: e.message }).catch(() => {});
  }

  return { didWork: true, simulation: short, log };
}
