// Shared env loading + config for the unified runner.
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf-8").split("\n")) {
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

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const RUNNER_TOKEN = process.env.RUNNER_TOKEN;
export const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
export const RUNNER_ID = process.env.RUNNER_ID || `${os.hostname()}-${process.pid}`;
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 3000;

if (!SUPABASE_URL || !RUNNER_TOKEN) {
  console.error("SUPABASE_URL and RUNNER_TOKEN are required in the environment / .env");
  process.exit(1);
}

export const ts = () => new Date().toISOString();

// POST to an edge function with the runner token. Returns parsed JSON.
export async function rpc(fn, body) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Runner-Token": RUNNER_TOKEN },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`);
  return json;
}
