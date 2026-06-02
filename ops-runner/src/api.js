// Thin wrapper around the ops-runner-poll edge function.
//
// All runner ↔ FounderOS exchanges go through this single endpoint, keeping the
// runner agnostic of the Supabase project structure.

import fetch from "node-fetch";

const RUNNER_POLL_URL = `${process.env.SUPABASE_URL}/functions/v1/ops-runner-poll`;
const TOKEN = process.env.RUNNER_TOKEN;

if (!process.env.SUPABASE_URL) throw new Error("SUPABASE_URL not set");
if (!TOKEN) throw new Error("RUNNER_TOKEN not set");

async function call(body) {
  const resp = await fetch(RUNNER_POLL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Runner-Token": TOKEN,
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok || !json.ok) {
    throw new Error(json.message ?? `HTTP ${resp.status}`);
  }
  return json;
}

export const api = {
  claim: (runnerId) => call({ mode: "claim", runner_id: runnerId }),
  log: (jobId, level, step, message, metadata) =>
    call({ mode: "log", job_id: jobId, level, step, message, metadata: metadata ?? {} }),
  complete: (jobId, status, result, exitCode, errorMessage) =>
    call({
      mode: "complete", job_id: jobId, status,
      result: result ?? {}, exit_code: exitCode ?? null, error_message: errorMessage ?? null,
    }),
  updateServer: (serverId, patch) =>
    call({ mode: "update_server", server_id: serverId, patch }),
  credential: (serverId) =>
    call({ mode: "credential", server_id: serverId }),
};
