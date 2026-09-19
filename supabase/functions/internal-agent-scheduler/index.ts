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
//   4b. Lets agents pick up the work items they are assigned to — when the item
//      is armed (agent_autorun + agent_brief, 0242) or when its START DATE
//      arrives (0250). Mission + run + passage « en cours ».
//   5. Launches due scheduled WORKFLOWS (agent_workflows.next_run_at <= now).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { startWorkflowRun, syncWorkflowSchedule } from "../_shared/workflow-engine.ts";

const MAX_LAUNCHES_PER_TICK = 3;
const MAX_RESCUES_PER_TICK = 3;
const QUEUED_RESCUE_AFTER_MS = 5 * 60 * 1000;
const RUNNING_TIMEOUT_MS = 30 * 60 * 1000;

type Cadence = "hourly" | "daily" | "weekly" | "monthly";
interface Alignment {
  schedule_minute: number | null;
  schedule_hour: number | null;
  schedule_dow: number | null;   // 0 = Sunday
  schedule_dom: number | null;   // 1..28
}

// Next run strictly after `from`, aligned (in UTC) to the mission's chosen
// minute/hour/day. When an alignment field is null we fall back to "from +
// interval" so legacy rows (no alignment) keep their old cadence.
function computeNextRun(from: Date, cadence: Cadence, a: Alignment): Date {
  const minute = a.schedule_minute ?? from.getUTCMinutes();
  const hour = a.schedule_hour ?? from.getUTCHours();

  if (cadence === "hourly") {
    // Next occurrence of `minute` within the hour, strictly after `from`.
    const n = new Date(from);
    n.setUTCSeconds(0, 0);
    n.setUTCMinutes(minute);
    if (n <= from) n.setUTCHours(n.getUTCHours() + 1);
    return n;
  }

  const base = new Date(from);
  base.setUTCSeconds(0, 0);
  base.setUTCHours(hour, minute);

  if (cadence === "daily") {
    if (base <= from) base.setUTCDate(base.getUTCDate() + 1);
    return base;
  }
  if (cadence === "weekly") {
    const dow = a.schedule_dow ?? from.getUTCDay();
    let delta = (dow - base.getUTCDay() + 7) % 7;
    if (delta === 0 && base <= from) delta = 7;
    base.setUTCDate(base.getUTCDate() + delta);
    return base;
  }
  // monthly
  const dom = a.schedule_dom ?? Math.min(from.getUTCDate(), 28);
  base.setUTCDate(dom);
  if (base <= from) base.setUTCMonth(base.getUTCMonth() + 1, dom);
  return base;
}

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
const MAX_WORKFLOWS_PER_TICK = 3;
/** Work items pris en charge par tick. Bas exprès : chaque lancement engage un
 *  budget, et une file de cinquante items armés d'un coup ne doit pas partir en
 *  une seule minute. */
const MAX_ISSUE_RUNS_PER_TICK = 5;
const A2A_RESCUE_AFTER_MS = 60 * 1000;

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;
  if (!authorized(req)) return jsonResponse({ error: "Unauthorized" }, { status: 401 });

  const admin = createServiceClient();
  const now = new Date();
  const report = {
    launched: [] as string[], rescued: [] as string[], timed_out: [] as string[], a2a: [] as string[],
    workflows: [] as string[], workflow_errors: [] as string[],
    issue_runs: [] as string[], issue_errors: [] as string[],
  };

  // 1. Due scheduled missions.
  const { data: due } = await admin
    .from("internal_agent_missions")
    .select("id, agent_id, workspace_id, project_id, schedule, schedule_minute, schedule_hour, schedule_dow, schedule_dom, internal_agents!inner(id, mission_enabled, is_archived)")
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
    const next = computeNextRun(now, m.schedule as Cadence, {
      schedule_minute: m.schedule_minute ?? null,
      schedule_hour: m.schedule_hour ?? null,
      schedule_dow: m.schedule_dow ?? null,
      schedule_dom: m.schedule_dom ?? null,
    });
    await admin
      .from("internal_agent_missions")
      .update({ next_run_at: next.toISOString(), last_run_at: now.toISOString() })
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

  // 1b. Due ONE-OFF missions (create_mission run_at — reminders, "do it on
  //     Thursday"). No cadence: the run_once tag (RUN_ONCE_TAG in
  //     _shared/internal-agent-tools.ts) marks them, so a stale next_run_at left
  //     on a row whose schedule was removed never fires. next_run_at is cleared
  //     by a conditional update first — only the tick that clears it launches.
  const { data: dueOnce } = await admin
    .from("internal_agent_missions")
    .select("id, agent_id, workspace_id, project_id, next_run_at, internal_agents!inner(id, mission_enabled, is_archived)")
    .eq("status", "active")
    .is("schedule", null)
    .contains("tags", ["run_once"])
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(MAX_LAUNCHES_PER_TICK);

  for (const m of dueOnce ?? []) {
    const agentMeta = (m as Record<string, unknown>).internal_agents as
      | { mission_enabled: boolean; is_archived: boolean }
      | null;
    const { data: claimed } = await admin
      .from("internal_agent_missions")
      .update({ next_run_at: null, last_run_at: now.toISOString() })
      .eq("id", m.id)
      .eq("next_run_at", m.next_run_at as string)
      .select("id");
    if (!claimed?.length) continue;
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

  /**
   * 4 bis. Les work items confiés à un agent.
   *
   * Un agent assigné à un work item, autorisé sur son projet, et dont l'item
   * est ARMÉ (`agent_autorun`) et BRIEFÉ (`agent_brief`) se met au travail seul.
   * Toutes les conditions d'éligibilité vivent dans `pj_agent_autorun_queue`
   * (0242) et nulle part ailleurs : écrites deux fois, elles divergeraient, et
   * le désaccord se paierait ici en exécutions fantômes.
   *
   * Pour chaque item, dans cet ordre :
   *   1. la trace `agent_last_run_at` est posée D'ABORD — un crash plus bas ne
   *      doit pas relancer le même item au tick suivant ;
   *   2. une MISSION porte le travail : titre = nom de l'item, brief = travail
   *      à faire + description. C'est elle qui rattache les livrables à l'item,
   *      donc qui en fait des preuves (0235) ;
   *   3. l'item passe « en cours » — sur un board, un item qu'une machine
   *      travaille doit se distinguer d'un item que personne n'a ouvert ;
   *   4. le run part, sans attendre sa fin.
   *
   * Placé AVANT les workflows : un lancement ici est un aller-retour court,
   * alors que l'étape 5 exécute en ligne et peut durer.
   */
  const { data: workQueue, error: workQueueError } = await admin
    .rpc("pj_agent_autorun_queue", { p_limit: MAX_ISSUE_RUNS_PER_TICK });
  if (workQueueError) report.issue_errors.push(`queue: ${workQueueError.message}`);

  for (const w of (workQueue ?? []) as Array<{
    issue_id: string; agent_id: string; pj_project_id: string; workspace_id: string;
    project_id: string; issue_name: string; issue_ref: string;
    brief: string | null; description: string | null;
  }>) {
    await admin.from("pj_issues")
      .update({ agent_last_run_at: now.toISOString() })
      .eq("id", w.issue_id);

    // Le brief d'abord, la description ensuite : l'un dit à la machine ce
    // qu'elle doit produire, l'autre le contexte que l'équipe a écrit pour
    // elle-même. Dans l'autre ordre, l'agent lit trois paragraphes d'historique
    // avant d'apprendre ce qu'on attend de lui.
    const brief = [
      // Un item déclenché par sa DATE DE DÉBUT (0250) peut n'avoir qu'une
      // description : c'est alors elle qui fait office de consigne.
      w.brief?.trim()
        ? `Travail à faire :\n${w.brief.trim()}`
        : `Travail à faire : réaliser ce work item, planifié pour démarrer aujourd'hui — ${w.issue_name}.`,
      w.description?.trim() ? `Contexte (description du work item) :\n${w.description.trim()}` : "",
    ].filter(Boolean).join("\n\n");

    const { data: mission, error: missionError } = await admin
      .from("internal_agent_missions")
      .insert({
        agent_id: w.agent_id,
        workspace_id: w.workspace_id,
        project_id: w.project_id,
        pj_project_id: w.pj_project_id,
        pj_issue_id: w.issue_id,
        title: `${w.issue_ref} — ${w.issue_name}`.slice(0, 200),
        brief,
        status: "active",
      })
      .select("id")
      .single();
    if (missionError || !mission) {
      report.issue_errors.push(`${w.issue_ref}: ${missionError?.message ?? "mission non créée"}`);
      continue;
    }

    await admin.rpc("pj_issue_mark_started", { p_issue: w.issue_id, p_agent: w.agent_id });

    const { data: run, error: runError } = await admin
      .from("internal_agent_runs")
      .insert({
        mission_id: mission.id,
        agent_id: w.agent_id,
        workspace_id: w.workspace_id,
        project_id: w.project_id,
        status: "queued",
        triggered_via: "schedule",
      })
      .select("id")
      .single();
    if (runError || !run) {
      report.issue_errors.push(`${w.issue_ref}: ${runError?.message ?? "run non créé"}`);
      continue;
    }

    // Un échec d'appel n'est pas perdu : le run reste en file, et l'étape 2 le
    // rattrape au bout de cinq minutes.
    await invokeWorker(w.agent_id, run.id);
    report.issue_runs.push(`${w.issue_ref}:${run.id}`);
  }

  /**
   * 5. Les workflows planifiés.
   *
   * `syncWorkflowSchedule` écrivait `next_run_at` depuis le bloc déclencheur
   * depuis le début — et PERSONNE ne lisait cette colonne. « À heure fixe »
   * s'affichait, s'enregistrait, calculait sa prochaine échéance, et ne partait
   * jamais. C'est ce tick-ci qui manquait.
   *
   * En dernier, exprès : une automatisation s'exécute EN LIGNE (le moteur
   * déterministe marche la chaîne lui-même), donc ce bloc peut durer. Les
   * missions, sauvetages et A2A sont déjà faits quand on y arrive.
   */
  const { data: dueWf } = await admin
    .from("agent_workflows")
    .select("id, name, kind")
    .eq("status", "active")
    .not("next_run_at", "is", null)
    .lte("next_run_at", now.toISOString())
    .order("next_run_at", { ascending: true })
    .limit(MAX_WORKFLOWS_PER_TICK);

  for (const w of (dueWf ?? []) as Array<{ id: string; name: string; kind: string | null }>) {
    // Désarmé AVANT de lancer : un démarrage lent ou un crash ne doit pas
    // relancer le même workflow au tick suivant. Les deux chemins de
    // `startWorkflowRun` réarment via syncWorkflowSchedule ; le `catch`
    // ci-dessous couvre les sorties en erreur, qui elles ne réarment pas et
    // laisseraient la planification morte en silence.
    await admin.from("agent_workflows").update({ next_run_at: null }).eq("id", w.id);
    try {
      const started = await startWorkflowRun(admin, {
        workflowId: w.id, trigger: "schedule", payload: { trigger: "schedule", at: now.toISOString() },
      });
      if ("error" in started) {
        await syncWorkflowSchedule(admin, w.id).catch(() => {});
        report.workflow_errors.push(`${w.name}: ${started.error}`);
      } else report.workflows.push(started.runId);
    } catch (e) {
      await syncWorkflowSchedule(admin, w.id).catch(() => {});
      report.workflow_errors.push(`${w.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return jsonResponse({ ok: true, ...report });
});
