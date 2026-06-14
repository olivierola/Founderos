// FounderOS Ops Runner — main poll loop.
//
// 1. Load .env (without an extra dep — just parse).
// 2. Poll the ops-runner-poll edge function for the next job.
// 3. Dispatch to the matching handler.
// 4. Stream logs + final status back to FounderOS.

import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import { api } from "./api.js";
import { handlers } from "./handlers.js";

// Minimal .env loader (avoids the dotenv dep).
function loadEnv() {
  if (!existsSync(".env")) return;
  const text = readFileSync(".env", "utf-8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const RUNNER_ID = process.env.RUNNER_ID || `${os.hostname()}-${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 3000;

function ts() {
  return new Date().toISOString();
}

function makeLogger(jobId) {
  return async (level, step, message, metadata) => {
    // Mirror to stdout for the operator.
    console.log(`[${ts()}] [${jobId.slice(0, 8)}] [${level}] ${step ?? "-"}: ${message}`);
    try {
      await api.log(jobId, level, step, message, metadata);
    } catch (e) {
      console.error(`[log-error] ${e.message}`);
    }
  };
}

async function runOne(job) {
  const log = makeLogger(job.id);
  await log("info", "lifecycle", `Picked up by runner ${RUNNER_ID}`);

  const handler = handlers[job.job_type];
  if (!handler) {
    await log("error", null, `No handler for job_type '${job.job_type}'`);
    await api.complete(job.id, "failed", {}, -1, `Unknown job_type '${job.job_type}'`);
    return;
  }

  try {
    const outcome = await handler({ job, api, log });
    await log(
      outcome.status === "succeeded" ? "info" : "error",
      "lifecycle",
      outcome.status === "succeeded" ? "Done." : `Failed: ${outcome.error ?? "unknown"}`,
    );
    await api.complete(
      job.id,
      outcome.status,
      outcome.result ?? {},
      outcome.exitCode ?? (outcome.status === "succeeded" ? 0 : 1),
      outcome.error ?? null,
    );
  } catch (e) {
    await log("error", "lifecycle", `Unhandled exception: ${e.message}`);
    await api.complete(job.id, "failed", {}, -1, e.message);
  }
}

async function pollOnce() {
  try {
    const { job } = await api.claim(RUNNER_ID);
    if (!job) return false;
    console.log(`[${ts()}] Claimed job ${job.id} (${job.job_type})`);
    await runOne(job);
    return true;
  } catch (e) {
    console.error(`[${ts()}] Poll error: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log(`FounderOS Ops Runner starting`);
  console.log(`  runner_id: ${RUNNER_ID}`);
  console.log(`  url:       ${process.env.SUPABASE_URL}`);
  console.log(`  interval:  ${POLL_INTERVAL_MS}ms`);
  while (true) {
    const didWork = await pollOnce();
    // If we just executed a job, immediately try again — there may be a queue.
    if (!didWork) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Export the single-tick poll so the unified runner can reuse it.
export { pollOnce as pollOps };

import { pathToFileURL } from "node:url";
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  process.on("SIGINT", () => { console.log("Shutting down."); process.exit(0); });
  process.on("SIGTERM", () => { console.log("Shutting down."); process.exit(0); });
  process.on("unhandledRejection", (e) => { console.error("Unhandled rejection:", e); });
  main();
}
