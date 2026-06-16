// Simulation source — runs MiroFish-style multi-agent simulations. The engine
// itself is LLM-driven inside the edge (simulation-poll); the runner just claims
// a queued simulation and drives it round by round, then asks for the report.
//
// Rounds are sequential (each reacts to the previous), so we loop here rather
// than doing all rounds in one edge invocation (keeps each call short).
import { rpc, RUNNER_ID, ts } from "../env.js";

const MAX_ROUNDS_GUARD = 60; // hard safety cap regardless of sim config

export async function pollSimulation() {
  let sim;
  try {
    const resp = await rpc("simulation-prepare", { action: "claim", runner_id: RUNNER_ID });
    sim = resp?.simulation ?? null;
  } catch (e) {
    if (!/HTTP 40|not found/i.test(e.message)) console.error(`[${ts()}] simulation claim: ${e.message}`);
    return false;
  }
  if (!sim || !sim.id) return false; // nothing queued this tick

  const short = String(sim.id).slice(0, 8);
  console.log(`[${ts()}] Simulation ${short} — "${(sim.name || "").slice(0, 40)}" (${sim.total_rounds} rounds)`);

  try {
    for (let i = 0; i < MAX_ROUNDS_GUARD; i++) {
      const r = await rpc("simulation-prepare", { action: "round", simulation_id: sim.id, runner_id: RUNNER_ID });
      console.log(`  round ${r.round}/${sim.total_rounds} — ${r.actions} actions`);
      if (r.done) break;
    }
    await rpc("simulation-prepare", { action: "complete", simulation_id: sim.id, status: "completed" });
    console.log(`  ${short} completed — report generated`);
  } catch (e) {
    console.error(`  simulation error: ${e.message}`);
    await rpc("simulation-prepare", { action: "complete", simulation_id: sim.id, status: "failed", error: e.message }).catch(() => {});
  }
  return true;
}
