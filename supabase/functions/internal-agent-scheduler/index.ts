// internal-agent-scheduler — cron tick for autonomous agents.
//
// Invoke periodically (e.g. every 10 minutes) with the service-role key, or
// with an `x-cron-secret` header matching the INTERNAL_CRON_SECRET env var:
//
//   curl -X POST $SUPABASE_URL/functions/v1/internal-agent-scheduler \
//     -H "Authorization: Bearer $SERVICE_ROLE_KEY"
//
// Each tick:
//   1. Launches due scheduled missions (status active, schedule set,
//      next_run_at <= now) — creates a run (triggered_via 'schedule') and
//      invokes internal-agent-run. next_run_at is bumped optimistically first
//      so a crashed worker can't cause a tight re-run loop.
//   2. Rescues stranded 'queued' runs older than 5 minutes (the fire-and-forget
//      launch from the UI failed) by re-invoking the worker.
//   3. Times out 'running' runs older than 30 minutes (worker died mid-flight).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

const MAX_LAUNCHES_PER_TICK = 3;
const MAX_RESCUES_PER_TICK = 3;
const QUEUED_RESCUE_AFTER_MS = 5 * 60 * 1000;
const RUNNING_TIMEOUT_MS = 30 * 60 * 1000;

function authorized(req: Request): boolean {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (token && token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) return true;
  const secret = Deno.env.get("INTERNAL_CRON_SECRET");
  return !!secret && req.headers.get("x-cron-secret") === secret;
}

async function invokeWorker(agentId: string, runId: string): Promise<boolean> {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return false;
  try {
    const res = await fetch(`${base}/functions/v1/internal-agent-run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId, mode: "mission", run_id: runId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function invokeA2A(messageId: string): Promise<boolean> {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return false;
  try {
    const res = await fetch(`${base}/functions/v1/internal-agent-a2a`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message_id: messageId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const MAX_A2A_PER_TICK = 5;
const A2A_RESCUE_AFTER_MS = 60 * 1000;

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;
  if (!authorized(req)) return jsonResponse({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceClient();
  const now = new Date();
  const report = { launched: [] as string[], rescued: [] as string[], timed_out: [] as string[], a2a: [] as string[] };

  // 1. Due scheduled missions.
  const { data: due } = await admin
    .from("internal_agent_missions")
    .select("id, agent_id, workspace_id, project_id, schedule, internal_agents!inner(id, mission_enabled, is_archived)")
    .eq("status", "active")
    .not("schedule", "is", null)
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(MAX_LAUNCHES_PER_TICK);

  for (const m of due ?? []) {
    const agentMeta = (m as Record<string, unknown>).internal_agents as
      | { mission_enabled: boolean; is_archived: boolean }
      | null;
    // Bump next_run_at first — even a crash below can't re-launch in a loop.
    const next = new Date(now);
    if (m.schedule === "daily") next.setDate(next.getDate() + 1);
    else if (m.schedule === "weekly") next.setDate(next.getDate() + 7);
    else next.setMonth(next.getMonth() + 1);
    await admin
      .from("internal_agent_missions")
      .update({ next_run_at: next.toISOString() })
      .eq("id", m.id);

    if (!agentMeta || !agentMeta.mission_enabled || agentMeta.is_archived) continue;

    const { data: run, error } = await admin
      .from("internal_agent_runs")
      .insert({
        mission_id: m.id,
        agent_id: m.agent_id,
        workspace_id: m.workspace_id,
        project_id: m.project_id,
        status: "queued",
        triggered_via: "schedule",
      })
      .select("id")
      .single();
    if (error || !run) continue;
    await invokeWorker(m.agent_id, run.id);
    report.launched.push(run.id);
  }

  // 2. Rescue stranded queued runs.
  const rescueBefore = new Date(now.getTime() - QUEUED_RESCUE_AFTER_MS).toISOString();
  const { data: stranded } = await admin
    .from("internal_agent_runs")
    .select("id, agent_id")
    .eq("status", "queued")
    .lt("created_at", rescueBefore)
    .order("created_at", { ascending: true })
    .limit(MAX_RESCUES_PER_TICK);
  for (const r of stranded ?? []) {
    if (await invokeWorker(r.agent_id, r.id)) report.rescued.push(r.id);
  }

  // 3. Time out zombie running runs.
  const timeoutBefore = new Date(now.getTime() - RUNNING_TIMEOUT_MS).toISOString();
  const { data: zombies } = await admin
    .from("internal_agent_runs")
    .select("id, agent_id")
    .eq("status", "running")
    .lt("started_at", timeoutBefore)
    .limit(10);
  for (const r of zombies ?? []) {
    await admin
      .from("internal_agent_runs")
      .update({
        status: "failed",
        finished_at: now.toISOString(),
        error_message: "Timed out (worker did not finish within 30 minutes)",
      })
      .eq("id", r.id)
      .eq("status", "running");
    await admin.from("internal_agent_run_events").insert({
      run_id: r.id,
      agent_id: r.agent_id,
      kind: "error",
      payload: { error: "Timed out by scheduler" },
    });
    report.timed_out.push(r.id);
  }

  // 4. Sweep A2A messages whose immediate trigger failed (pending past a grace
  //    period), so inter-agent collaboration is resilient to dropped invocations.
  const a2aBefore = new Date(now.getTime() - A2A_RESCUE_AFTER_MS).toISOString();
  const { data: pendingMsgs } = await admin
    .from("internal_agent_a2a_messages")
    .select("id")
    .eq("status", "pending")
    .lt("created_at", a2aBefore)
    .order("created_at", { ascending: true })
    .limit(MAX_A2A_PER_TICK);
  for (const m of pendingMsgs ?? []) {
    if (await invokeA2A((m as { id: string }).id)) report.a2a.push((m as { id: string }).id);
  }

  return jsonResponse({ ok: true, ...report });
});
