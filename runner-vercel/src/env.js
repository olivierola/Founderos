// Env config for Vercel — all values come from Vercel Environment Variables.

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const RUNNER_TOKEN = process.env.RUNNER_TOKEN;
export const RUNNER_ID = process.env.RUNNER_ID || "vercel-runner";

export const ts = () => new Date().toISOString();

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
