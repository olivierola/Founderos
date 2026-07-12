// onboarding-engine — the generative brain of Agentic Onboarding (palier 1).
// The PM declares an activation *goal*; this function composes, revises,
// publishes and optimises the flows/tours/checklists that serve it.
//
// Actions (JSON body { action, ... }) — all require a workspace-member session:
//   "generate" { goal_id }                    → compose a fresh parcours (draft version)
//   "revise"   { goal_id, instruction }        → conversational edit of the latest draft
//   "publish"  { goal_id, version }            → make a version live (archives others)
//   "optimize" { goal_id }                     → hypothesise + spin up an A/B experiment
//
// The app map comes from scan_results.app_structure.enriched (see
// enrich-app-structure); when absent we fall back to a natural-language
// description on the goal's constraints.app_description.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi, safeParseJson } from "../_shared/ai.ts";

type Admin = ReturnType<typeof createServiceClient>;

interface GoalRow {
  id: string;
  workspace_id: string;
  project_id: string;
  agent_id: string | null;
  name: string;
  objective: string;
  segment: Record<string, unknown>;
  activation_event: string | null;
  activation_rule: Record<string, unknown>;
  constraints: Record<string, unknown>;
  status: string;
}

// The parcours shape the LLM must return and we persist into flows + steps.
interface GenStep {
  title: string;
  body?: string;
  cta_label?: string | null;
  cta_url?: string | null;
  page_route?: string | null;
  element_selector?: string | null;
  complete_on?: Record<string, unknown>;
}
interface GenFlow {
  kind: "flow" | "tour" | "checklist";
  name: string;
  description?: string;
  trigger?: Record<string, unknown>;
  steps: GenStep[];
}
interface Parcours {
  flows: GenFlow[];
  rationale?: string;
}

const PARCOURS_SHAPE = `{
  "flows": [
    {
      "kind": "flow" | "tour" | "checklist",
      "name": string,
      "description": string,
      "trigger": { "event"?: string, "route"?: string },   // when this artefact fires
      "steps": [
        {
          "title": string,
          "body": string,                                    // markdown shown by the widget
          "cta_label": string | null,
          "cta_url": string | null,                          // route the CTA opens
          "page_route": string | null,                       // tour: page the step lives on
          "element_selector": string | null,                 // tour: CSS-ish hint for the element
          "complete_on": { "event"?: string, "route"?: string } // auto-complete rule
        }
      ]
    }
  ],
  "rationale": string
}`;

async function memberOf(admin: Admin, workspaceId: string, userId: string): Promise<boolean> {
  const { data } = await admin
    .from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  return !!data && ["owner", "admin", "member"].includes((data as { role: string }).role);
}

// Latest enriched app map for the project, or null.
async function loadAppMap(admin: Admin, projectId: string): Promise<Record<string, unknown> | null> {
  const { data } = await admin
    .from("scan_results").select("app_structure")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const struct = (data?.app_structure ?? {}) as { enriched?: Record<string, unknown> };
  return struct.enriched ?? null;
}

// Persist a parcours as generated flows + steps at a given version.
async function persistParcours(
  admin: Admin,
  goal: GoalRow,
  parcours: Parcours,
  version: number,
  source: "scan" | "description",
  model: string,
): Promise<{ flow_ids: string[] }> {
  const flowIds: string[] = [];
  for (let i = 0; i < parcours.flows.length; i++) {
    const f = parcours.flows[i]!;
    const { data: flow, error } = await admin
      .from("rag_onboarding_flows")
      .insert({
        workspace_id: goal.workspace_id,
        project_id: goal.project_id,
        agent_id: goal.agent_id,
        goal_id: goal.id,
        name: f.name,
        description: f.description ?? null,
        kind: f.kind,
        trigger: f.trigger ?? {},
        enabled: false, // draft — not served until published
        position: i,
        generated: true,
        version,
        lifecycle_status: "draft",
        generation_meta: { source, model, rationale: parcours.rationale ?? null },
      })
      .select("id").single();
    if (error || !flow) throw new Error(`insert flow failed: ${error?.message}`);
    flowIds.push(flow.id);
    const steps = (f.steps ?? []).map((s, j) => ({
      flow_id: flow.id,
      position: j,
      title: s.title,
      body: s.body ?? null,
      cta_label: s.cta_label ?? null,
      cta_url: s.cta_url ?? null,
      page_route: s.page_route ?? null,
      element_selector: s.element_selector ?? null,
      complete_on: s.complete_on ?? {},
    }));
    if (steps.length > 0) {
      const { error: se } = await admin.from("rag_onboarding_steps").insert(steps);
      if (se) throw new Error(`insert steps failed: ${se.message}`);
    }
  }
  return { flow_ids: flowIds };
}

async function nextVersion(admin: Admin, goalId: string): Promise<number> {
  const { data } = await admin
    .from("rag_onboarding_flows").select("version")
    .eq("goal_id", goalId).order("version", { ascending: false }).limit(1).maybeSingle();
  return ((data?.version as number | undefined) ?? 0) + 1;
}

// Read a version's flows+steps back into the parcours shape (for revise/optimize).
async function loadParcours(admin: Admin, goalId: string, version: number): Promise<Parcours> {
  const { data: flows } = await admin
    .from("rag_onboarding_flows")
    .select("id, name, description, kind, trigger, position")
    .eq("goal_id", goalId).eq("version", version).order("position");
  const out: GenFlow[] = [];
  for (const f of flows ?? []) {
    const { data: steps } = await admin
      .from("rag_onboarding_steps")
      .select("title, body, cta_label, cta_url, page_route, element_selector, complete_on, position")
      .eq("flow_id", (f as { id: string }).id).order("position");
    out.push({
      kind: (f as { kind: GenFlow["kind"] }).kind,
      name: (f as { name: string }).name,
      description: (f as { description?: string }).description ?? "",
      trigger: (f as { trigger?: Record<string, unknown> }).trigger ?? {},
      steps: (steps ?? []) as GenStep[],
    });
  }
  return { flows: out };
}

async function latestDraftVersion(admin: Admin, goalId: string): Promise<number | null> {
  const { data } = await admin
    .from("rag_onboarding_flows").select("version")
    .eq("goal_id", goalId).eq("lifecycle_status", "draft")
    .order("version", { ascending: false }).limit(1).maybeSingle();
  return (data?.version as number | undefined) ?? null;
}

async function latestVersion(admin: Admin, goalId: string): Promise<number | null> {
  const { data } = await admin
    .from("rag_onboarding_flows").select("version")
    .eq("goal_id", goalId).order("version", { ascending: false }).limit(1).maybeSingle();
  return (data?.version as number | undefined) ?? null;
}

// Persona archetypes we sample from — a light echo of the Simulations module,
// without booting its runner. Flavoured by the goal's target segment.
const PERSONA_ARCHETYPES = [
  "early_adopter", "mainstream_user", "skeptic", "power_user",
  "non_technical", "in_a_hurry", "decision_maker",
];

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(auth);
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = body.action as string | undefined;
    const goalId = body.goal_id as string | undefined;
    if (!action || !goalId) return jsonResponse({ error: "action and goal_id required" }, { status: 400 });

    const admin = createServiceClient();
    const { data: goalData } = await admin
      .from("onboarding_goals").select("*").eq("id", goalId).maybeSingle();
    if (!goalData) return jsonResponse({ error: "goal not found" }, { status: 404 });
    const goal = goalData as GoalRow;
    if (!(await memberOf(admin, goal.workspace_id, u.user.id))) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    // ── generate ────────────────────────────────────────────────────────────
    if (action === "generate") {
      const enriched = await loadAppMap(admin, goal.project_id);
      const description = (goal.constraints as { app_description?: string }).app_description;
      const source: "scan" | "description" = enriched ? "scan" : "description";
      if (!enriched && !description) {
        return jsonResponse({
          error: "no_app_context",
          detail: "Run a code scan + enrichment, or add an app description on the goal.",
        }, { status: 400 });
      }
      const mapText = enriched
        ? JSON.stringify(enriched).slice(0, 12000)
        : `App description provided by the client:\n${description}`;

      const prompt = `You design an in-product onboarding parcours for a SaaS app.

GOAL (natural language): ${goal.objective}
TARGET SEGMENT: ${JSON.stringify(goal.segment)}
ACTIVATION EVENT (the aha-moment): ${goal.activation_event ?? "not specified"}
CONSTRAINTS (respect these): ${JSON.stringify(goal.constraints)}

APP MAP (pages, actions, routes, journeys):
${mapText}

Compose the shortest parcours that reliably drives a targeted user to the
activation event. Prefer a checklist for milestone tracking, tours for
element-level guidance (set page_route + element_selector from the map),
and flows for conversational sequences. Auto-complete steps via complete_on
using the real event/route names from the map. Max 4 artefacts, max 6 steps each.

Output ONLY minified JSON, no prose, matching exactly:
${PARCOURS_SHAPE}`;

      const ai = await callAi({
        task: "json_extraction",
        systemPrompt: "You are a precise product-onboarding designer. Reply only with valid JSON.",
        userPrompt: prompt,
        jsonMode: true,
        temperature: 0.3,
        maxTokens: 3500,
      });
      const parcours = safeParseJson<Parcours>(ai.content);
      if (!parcours || !Array.isArray(parcours.flows)) {
        return jsonResponse({ error: "LLM returned invalid JSON", detail: ai.content.slice(0, 300) }, { status: 502 });
      }
      const version = await nextVersion(admin, goal.id);
      const { flow_ids } = await persistParcours(admin, goal, parcours, version, source, ai.model);
      await admin.from("activity_logs").insert({
        workspace_id: goal.workspace_id, project_id: goal.project_id,
        actor_user_id: u.user.id, event_type: "onboarding.generated",
        title: `Parcours generated for goal "${goal.name}"`,
        payload: { goal_id: goal.id, version, source, flows: flow_ids.length },
      });
      return jsonResponse({ ok: true, version, source, flow_ids, rationale: parcours.rationale ?? null });
    }

    // ── revise ──────────────────────────────────────────────────────────────
    if (action === "revise") {
      const instruction = (body.instruction as string | undefined)?.trim();
      if (!instruction) return jsonResponse({ error: "instruction required" }, { status: 400 });
      const draftV = await latestDraftVersion(admin, goal.id);
      if (draftV == null) return jsonResponse({ error: "no draft to revise — generate first" }, { status: 400 });
      const current = await loadParcours(admin, goal.id, draftV);

      const prompt = `Here is the current onboarding parcours (JSON) for the goal "${goal.objective}":
${JSON.stringify(current).slice(0, 10000)}

Apply this change requested by the product manager, keeping everything else intact:
"${instruction}"

Return the COMPLETE updated parcours as minified JSON matching exactly:
${PARCOURS_SHAPE}`;
      const ai = await callAi({
        task: "json_extraction",
        systemPrompt: "You edit onboarding parcours JSON precisely. Reply only with valid JSON.",
        userPrompt: prompt,
        jsonMode: true,
        temperature: 0.2,
        maxTokens: 3500,
      });
      const revised = safeParseJson<Parcours>(ai.content);
      if (!revised || !Array.isArray(revised.flows)) {
        return jsonResponse({ error: "LLM returned invalid JSON", detail: ai.content.slice(0, 300) }, { status: 502 });
      }
      // New draft version preserves history; the old draft is archived.
      const version = await nextVersion(admin, goal.id);
      await persistParcours(admin, goal, revised, version, "scan", ai.model);
      await admin.from("rag_onboarding_flows")
        .update({ lifecycle_status: "archived" })
        .eq("goal_id", goal.id).eq("version", draftV).eq("lifecycle_status", "draft");
      return jsonResponse({ ok: true, version, rationale: revised.rationale ?? null });
    }

    // ── publish ─────────────────────────────────────────────────────────────
    if (action === "publish") {
      const version = body.version as number | undefined;
      if (version == null) return jsonResponse({ error: "version required" }, { status: 400 });
      // Archive any currently-live version, then promote the chosen one.
      await admin.from("rag_onboarding_flows")
        .update({ lifecycle_status: "archived", enabled: false })
        .eq("goal_id", goal.id).eq("lifecycle_status", "live");
      const { error } = await admin.from("rag_onboarding_flows")
        .update({ lifecycle_status: "live", enabled: true })
        .eq("goal_id", goal.id).eq("version", version);
      if (error) return jsonResponse({ error: error.message }, { status: 500 });
      await admin.from("onboarding_goals")
        .update({ status: "active", updated_at: new Date().toISOString() })
        .eq("id", goal.id);
      await admin.from("activity_logs").insert({
        workspace_id: goal.workspace_id, project_id: goal.project_id,
        actor_user_id: u.user.id, event_type: "onboarding.published",
        title: `Onboarding published for goal "${goal.name}" (v${version})`,
        payload: { goal_id: goal.id, version },
      });
      return jsonResponse({ ok: true, version });
    }

    // ── optimize ──────────────────────────────────────────────────────────────
    if (action === "optimize") {
      // Find the live parcours + its worst-drop-off step, then generate a variant.
      const { data: liveFlows } = await admin
        .from("rag_onboarding_flows").select("id, version")
        .eq("goal_id", goal.id).eq("lifecycle_status", "live");
      if (!liveFlows || liveFlows.length === 0) {
        return jsonResponse({ error: "no live parcours to optimize" }, { status: 400 });
      }
      const liveVersion = (liveFlows[0] as { version: number }).version;
      const flowIds = (liveFlows as { id: string }[]).map((f) => f.id);

      // Aggregate drop-off: for each step position, how many runs reached it.
      const { data: runs } = await admin
        .from("rag_onboarding_runs")
        .select("id, current_step_position, status")
        .in("flow_id", flowIds).eq("is_holdout", false).limit(2000);
      const reached: Record<number, number> = {};
      let total = 0;
      for (const r of runs ?? []) {
        total++;
        const p = (r as { current_step_position: number }).current_step_position ?? 0;
        for (let i = 0; i <= p; i++) reached[i] = (reached[i] ?? 0) + 1;
      }
      const current = await loadParcours(admin, goal.id, liveVersion);

      const prompt = `Onboarding parcours (JSON) for goal "${goal.objective}":
${JSON.stringify(current).slice(0, 9000)}

Run stats: ${total} runs. Users reaching each step index: ${JSON.stringify(reached)}.

Identify the single biggest drop-off, state a one-sentence hypothesis for WHY,
and produce a VARIANT of the parcours that should fix it (reorder, reword, make
skippable, or move an early ask later). Output ONLY minified JSON:
{ "hypothesis": string, "variant": ${PARCOURS_SHAPE} }`;
      const ai = await callAi({
        task: "json_extraction",
        systemPrompt: "You are a growth/activation optimiser. Reply only with valid JSON.",
        userPrompt: prompt,
        jsonMode: true,
        temperature: 0.4,
        maxTokens: 3500,
      });
      const parsed = safeParseJson<{ hypothesis: string; variant: Parcours }>(ai.content);
      if (!parsed?.variant?.flows) {
        return jsonResponse({ error: "LLM returned invalid JSON", detail: ai.content.slice(0, 300) }, { status: 502 });
      }
      // Persist the variant as a new live version tagged 'B', keep 'A' live too.
      const version = await nextVersion(admin, goal.id);
      const { flow_ids: bIds } = await persistParcours(admin, goal, parsed.variant, version, "scan", ai.model);
      await admin.from("rag_onboarding_flows")
        .update({ lifecycle_status: "live", enabled: true, variant: "B" })
        .eq("goal_id", goal.id).eq("version", version);
      await admin.from("rag_onboarding_flows")
        .update({ variant: "A" })
        .eq("goal_id", goal.id).eq("version", liveVersion);
      const { data: exp } = await admin.from("onboarding_experiments").insert({
        workspace_id: goal.workspace_id, project_id: goal.project_id, goal_id: goal.id,
        name: `Optimisation v${liveVersion} → v${version}`,
        hypothesis: parsed.hypothesis,
        status: "running",
        variants: [
          { label: "A", flow_id: flowIds[0], weight: 0.5 },
          { label: "B", flow_id: bIds[0], weight: 0.5 },
        ],
        control: "holdout", metric: "activation",
      }).select("id").single();
      return jsonResponse({ ok: true, experiment_id: exp?.id, hypothesis: parsed.hypothesis, version });
    }

    // ── preview ─────────────────────────────────────────────────────────────
    // Dry-run the parcours: make synthetic personas "walk" it and predict where
    // they activate or drop off — before publishing. Not persisted.
    if (action === "preview") {
      const version = (body.version as number | undefined) ?? (await latestVersion(admin, goal.id));
      if (version == null) return jsonResponse({ error: "no parcours to preview — generate first" }, { status: 400 });
      const parcours = await loadParcours(admin, goal.id, version);
      if (parcours.flows.length === 0) return jsonResponse({ error: "empty parcours" }, { status: 400 });

      const segment = JSON.stringify(goal.segment);
      const personaCount = 5;
      const prompt = `Simulate ${personaCount} distinct end users going through this SaaS onboarding parcours.

GOAL: ${goal.objective}
ACTIVATION EVENT (aha-moment): ${goal.activation_event ?? "reaching the end of the parcours"}
TARGET SEGMENT: ${segment}
Sample personas from these archetypes (flavour them to the segment): ${PERSONA_ARCHETYPES.join(", ")}.

PARCOURS (ordered flows, each with ordered steps):
${JSON.stringify(parcours).slice(0, 9000)}

For each persona, reason step-by-step whether they would complete each step and
reach activation, or where they'd drop off and why (confusion, friction, too
early an ask, unclear CTA…). Be realistic — some personas should struggle.

Output ONLY minified JSON:
{
  "personas": [
    { "name": string, "archetype": string, "activated": boolean,
      "drop_step": number | null, "friction": string }
  ],
  "predicted_activation_rate": number,   // 0..1 across the personas
  "top_friction": string[],               // 1-3 recurring friction points
  "summary": string                       // 2 sentences
}`;
      const ai = await callAi({
        task: "json_extraction",
        systemPrompt: "You realistically simulate user onboarding. Reply only with valid JSON.",
        userPrompt: prompt,
        jsonMode: true,
        temperature: 0.6,
        maxTokens: 2500,
      });
      const parsed = safeParseJson<Record<string, unknown>>(ai.content);
      if (!parsed || !Array.isArray(parsed.personas)) {
        return jsonResponse({ error: "LLM returned invalid JSON", detail: ai.content.slice(0, 300) }, { status: 502 });
      }
      return jsonResponse({ ok: true, version, ...parsed });
    }

    // ── decide ──────────────────────────────────────────────────────────────
    // Close the A/B loop: if a running experiment has a statistically clear
    // winner (min sample + two-proportion z-test), promote it and archive the
    // loser so the runtime serves only the winner. Idempotent / safe to re-run.
    if (action === "decide") {
      const experimentId = body.experiment_id as string | undefined;
      if (!experimentId) return jsonResponse({ error: "experiment_id required" }, { status: 400 });
      const { data: expData } = await admin
        .from("onboarding_experiments").select("*").eq("id", experimentId).eq("goal_id", goal.id).maybeSingle();
      if (!expData) return jsonResponse({ error: "experiment not found" }, { status: 404 });
      const exp = expData as { id: string; status: string; variants: { label: string; flow_id: string }[] };
      if (exp.status !== "running") return jsonResponse({ error: "experiment not running" }, { status: 400 });

      const variants = (exp.variants ?? []).filter((v) => v && v.flow_id);
      if (variants.length < 2) return jsonResponse({ error: "need ≥2 variants" }, { status: 400 });

      // Activation rate per variant from the served (non-holdout) runs.
      const { data: runs } = await admin
        .from("rag_onboarding_runs")
        .select("variant_label, activated_at")
        .eq("goal_id", goal.id).eq("experiment_id", exp.id).eq("is_holdout", false).limit(20000);
      const agg: Record<string, { n: number; a: number }> = {};
      for (const v of variants) agg[v.label] = { n: 0, a: 0 };
      for (const r of runs ?? []) {
        const lbl = (r as { variant_label: string | null }).variant_label;
        if (!lbl || !agg[lbl]) continue;
        agg[lbl].n++;
        if ((r as { activated_at: string | null }).activated_at) agg[lbl].a++;
      }
      const ranked = variants
        .map((v) => ({ ...v, ...agg[v.label], rate: agg[v.label].n ? agg[v.label].a / agg[v.label].n : 0 }))
        .sort((x, y) => y.rate - x.rate);
      const win = ranked[0]!;
      const lose = ranked[ranked.length - 1]!;

      const MIN_SAMPLE = 30;
      if (win.n < MIN_SAMPLE || lose.n < MIN_SAMPLE) {
        return jsonResponse({ decided: false, reason: "insufficient_sample", min_sample: MIN_SAMPLE, agg });
      }
      // Two-proportion z-test.
      const p = (win.a + lose.a) / (win.n + lose.n);
      const se = Math.sqrt(p * (1 - p) * (1 / win.n + 1 / lose.n)) || 1e-9;
      const z = (win.rate - lose.rate) / se;
      if (Math.abs(z) < 1.96) {
        return jsonResponse({ decided: false, reason: "not_significant", z, agg });
      }

      // Promote the winner, archive the loser's variant flows.
      const { data: winFlow } = await admin
        .from("rag_onboarding_flows").select("version").eq("id", win.flow_id).maybeSingle();
      const { data: loseFlow } = await admin
        .from("rag_onboarding_flows").select("version").eq("id", lose.flow_id).maybeSingle();
      if (winFlow) {
        await admin.from("rag_onboarding_flows")
          .update({ lifecycle_status: "live", enabled: true, variant: null })
          .eq("goal_id", goal.id).eq("version", (winFlow as { version: number }).version);
      }
      if (loseFlow) {
        await admin.from("rag_onboarding_flows")
          .update({ lifecycle_status: "archived", enabled: false })
          .eq("goal_id", goal.id).eq("version", (loseFlow as { version: number }).version);
      }
      const uplift = win.rate - lose.rate;
      await admin.from("onboarding_experiments")
        .update({ status: "decided", winner_flow_id: win.flow_id, uplift, decided_at: new Date().toISOString() })
        .eq("id", exp.id);
      await admin.from("activity_logs").insert({
        workspace_id: goal.workspace_id, project_id: goal.project_id,
        actor_user_id: u.user.id, event_type: "onboarding.experiment_decided",
        title: `A/B decided for "${goal.name}": variant ${win.label} wins`,
        payload: { experiment_id: exp.id, winner: win.label, uplift, z },
      });
      return jsonResponse({ decided: true, winner_label: win.label, winner_flow_id: win.flow_id, uplift, z });
    }

    return jsonResponse({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
