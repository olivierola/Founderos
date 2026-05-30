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

    /* 2) Pick the active flow. */
    let flow;
    if (flow_id) {
      const { data } = await admin
        .from("rag_onboarding_flows")
        .select("id, name, kind, enabled")
        .eq("id", flow_id)
        .maybeSingle();
      flow = data;
    } else {
      const { data } = await admin
        .from("rag_onboarding_flows")
        .select("id, name, kind, enabled")
        .eq("agent_id", agent.id)
        .eq("enabled", true)
        .order("position", { ascending: true })
        .limit(1)
        .maybeSingle();
      flow = data;
    }
    if (!flow || !flow.enabled) return jsonResponse({ error: "No active flow" }, { status: 404 });

    /* 3) Find or create the run. */
    const identifier = visitor_id
      ? { visitor_id }
      : { external_user_id: external_user_id! };
    const { data: existingRun } = await admin
      .from("rag_onboarding_runs")
      .select("id, current_step_position, status")
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
          ...identifier,
          status: "in_progress",
          current_step_position: 0,
        })
        .select()
        .single();
      run = created!;
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
    await admin
      .from("rag_onboarding_runs")
      .update({
        current_step_position: cursor,
        status: completed ? "completed" : "in_progress",
        last_activity_at: new Date().toISOString(),
        completed_at: completed ? new Date().toISOString() : null,
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
