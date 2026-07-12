// rag-onboarding-next-step — public endpoint consumed by either the embedded
// widget (visitor_id) or the client SaaS backend (external_user_id).
//
// Body: {
//   agent_public_key: string,            // identifies the agent (no auth header needed)
//   flow_id?: string,                    // optional preselected flow
//   visitor_id?: string | external_user_id?: string,
//   event?: { type: string, data?: any },// signal an event to advance steps
//   complete_current?: boolean,          // mark the current step done
// }
//
// Response: {
//   run_id, flow: { id, name, kind }, step: { ... } | null, completed: boolean
// }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json();
    const {
      agent_public_key,
      flow_id,
      visitor_id,
      external_user_id,
      event,
      complete_current,
    } = body as {
      agent_public_key?: string;
      flow_id?: string;
      visitor_id?: string;
      external_user_id?: string;
      event?: { type: string; data?: unknown };
      complete_current?: boolean;
    };

    if (!agent_public_key) {
      return jsonResponse({ error: "agent_public_key required" }, { status: 400 });
    }
    if (!visitor_id && !external_user_id) {
      return jsonResponse({ error: "visitor_id or external_user_id required" }, { status: 400 });
    }

    const admin = createServiceClient();

    /* 1) Resolve the agent and its project context. */
    const { data: agent } = await admin
      .from("rag_agents")
      .select("id, workspace_id, project_id, onboarding_enabled")
      .eq("public_key", agent_public_key)
      .maybeSingle();
    if (!agent) return jsonResponse({ error: "Unknown agent" }, { status: 404 });
    if (!agent.onboarding_enabled) return jsonResponse({ error: "Onboarding disabled" }, { status: 403 });

    // Stable per-user hash in [0,1) — reused for holdout + A/B allocation so a
    // user is consistently assigned across requests (never flips A↔B).
    const userKey = visitor_id ?? external_user_id ?? "";
    function stableUnit(salt: number): number {
      let h = salt;
      for (let i = 0; i < userKey.length; i++) h = (h * 131 + userKey.charCodeAt(i)) % 1_000_000;
      return h / 1_000_000;
    }

    /* 2) Pick the active flow. */
    let flow;
    let assignedExperimentId: string | null = null;
    let assignedVariant: string | null = null;
    if (flow_id) {
      const { data } = await admin
        .from("rag_onboarding_flows")
        .select("id, name, kind, enabled, goal_id")
        .eq("id", flow_id)
        .maybeSingle();
      flow = data;
    } else {
      // A/B allocation: if a running experiment exists on one of this agent's
      // active goals, assign the user to a variant (stable, weighted) and serve
      // that variant's entry flow. Otherwise fall back to the first live flow.
      const { data: goalRows } = await admin
        .from("onboarding_goals").select("id").eq("agent_id", agent.id).eq("status", "active");
      const goalIds = (goalRows ?? []).map((g) => (g as { id: string }).id);
      if (goalIds.length > 0) {
        const { data: exp } = await admin
          .from("onboarding_experiments")
          .select("id, variants")
          .in("goal_id", goalIds).eq("status", "running")
          .order("started_at", { ascending: false }).limit(1).maybeSingle();
        const variants = ((exp?.variants ?? []) as { label: string; flow_id: string; weight?: number }[])
          .filter((v) => v && v.flow_id);
        if (exp && variants.length > 0) {
          const totalW = variants.reduce((s, v) => s + (v.weight ?? 0), 0) || variants.length;
          const r = stableUnit(7);
          let acc = 0;
          let chosen = variants[0]!;
          for (const v of variants) { acc += (v.weight ?? 1 / variants.length) / totalW; if (r <= acc) { chosen = v; break; } }
          const { data } = await admin
            .from("rag_onboarding_flows")
            .select("id, name, kind, enabled, goal_id")
            .eq("id", chosen.flow_id).maybeSingle();
          if (data?.enabled) { flow = data; assignedExperimentId = (exp as { id: string }).id; assignedVariant = chosen.label; }
        }
      }
      if (!flow) {
        const { data } = await admin
          .from("rag_onboarding_flows")
          .select("id, name, kind, enabled, goal_id")
          .eq("agent_id", agent.id)
          .eq("enabled", true)
          .order("position", { ascending: true })
          .limit(1)
          .maybeSingle();
        flow = data;
      }
    }
    if (!flow || !flow.enabled) return jsonResponse({ error: "No active flow" }, { status: 404 });

    /* 2b) Load the goal behind the flow (generative onboarding) — drives the
       activation aha-event and the causal holdout. */
    let goal: { id: string; activation_event: string | null; holdout_pct: number } | null = null;
    if (flow.goal_id) {
      const { data } = await admin
        .from("onboarding_goals")
        .select("id, activation_event, holdout_pct")
        .eq("id", flow.goal_id)
        .maybeSingle();
      goal = data;
    }
    // Stable holdout assignment: same user is always in/out of the control arm.
    // Independent salt from the A/B allocation so the two draws don't correlate.
    const isHoldout = !!goal && goal.holdout_pct > 0 && stableUnit(0) * 100 < goal.holdout_pct;

    /* 3) Find or create the run. */
    const identifier = visitor_id
      ? { visitor_id }
      : { external_user_id: external_user_id! };
    const { data: existingRun } = await admin
      .from("rag_onboarding_runs")
      .select("id, current_step_position, status, is_holdout, activated_at")
      .eq("flow_id", flow.id)
      .match(identifier)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let run = existingRun;
    if (!run) {
      const { data: created } = await admin
        .from("rag_onboarding_runs")
        .insert({
          workspace_id: agent.workspace_id,
          project_id: agent.project_id,
          agent_id: agent.id,
          flow_id: flow.id,
          goal_id: goal?.id ?? null,
          is_holdout: isHoldout,
          experiment_id: assignedExperimentId,
          variant_label: assignedVariant,
          ...identifier,
          status: "in_progress",
          current_step_position: 0,
        })
        .select("id, current_step_position, status, is_holdout, activated_at")
        .single();
      run = created!;
    }

    /* 3b) Causal control arm: enrolled but deliberately un-guided. We keep the
       run (to measure activation) but surface nothing to the widget. Activation
       is still stamped below if the aha-event fires. */
    if (run.is_holdout) {
      if (goal?.activation_event && event?.type === goal.activation_event && !run.activated_at) {
        await admin.from("rag_onboarding_runs")
          .update({ activated_at: new Date().toISOString(), last_activity_at: new Date().toISOString() })
          .eq("id", run.id);
      }
      return jsonResponse({ run_id: run.id, holdout: true, step: null, completed: false });
    }

    /* 4) Load the steps. */
    const { data: steps } = await admin
      .from("rag_onboarding_steps")
      .select("*")
      .eq("flow_id", flow.id)
      .order("position", { ascending: true });
    const stepList = steps ?? [];

    /* 5) Advance based on the incoming signal. */
    let cursor = run.current_step_position;
    let advanced = false;

    if (complete_current && stepList[cursor]) {
      await admin.from("rag_onboarding_progress").insert({
        run_id: run.id,
        step_id: stepList[cursor].id,
        status: "completed",
      });
      cursor += 1;
      advanced = true;
    }

    if (event && stepList[cursor]) {
      const expected = stepList[cursor].complete_on as { event?: string; route?: string } | null;
      const matches =
        (expected?.event && expected.event === event.type) ||
        (expected?.route && (event.data as { route?: string })?.route === expected.route);
      if (matches) {
        await admin.from("rag_onboarding_progress").insert({
          run_id: run.id,
          step_id: stepList[cursor].id,
          status: "completed",
        });
        cursor += 1;
        advanced = true;
      }
    }

    /* 6) Persist the cursor and detect completion. */
    const completed = cursor >= stepList.length;
    // The aha-moment: stamp activation the first time the goal's activation
    // event fires (drives activation rate, TTV and causal uplift).
    const activatedNow =
      goal?.activation_event && event?.type === goal.activation_event && !run.activated_at;
    await admin
      .from("rag_onboarding_runs")
      .update({
        current_step_position: cursor,
        status: completed ? "completed" : "in_progress",
        last_activity_at: new Date().toISOString(),
        completed_at: completed ? new Date().toISOString() : null,
        ...(activatedNow ? { activated_at: new Date().toISOString() } : {}),
      })
      .eq("id", run.id);

    const nextStep = stepList[cursor] ?? null;

    return jsonResponse({
      run_id: run.id,
      flow: { id: flow.id, name: flow.name, kind: flow.kind },
      step: nextStep
        ? {
            id: nextStep.id,
            position: nextStep.position,
            title: nextStep.title,
            body: nextStep.body,
            cta_label: nextStep.cta_label,
            cta_url: nextStep.cta_url,
            page_route: nextStep.page_route,
            element_selector: nextStep.element_selector,
          }
        : null,
      completed,
      advanced,
      total_steps: stepList.length,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
