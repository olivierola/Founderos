// rag-activation-tick — the heart of the Activation Engine.
//
// The embedded widget posts a periodic "tick" carrying the live UI context and
// any behavioural signal (idle, rage_click, route_change). This function:
//   1. upserts the per-visitor activation_sessions row (visited routes, used
//      features, completed intents, conversation turns, last route/seen),
//   2. recomputes the configurable weighted activation_score (and flips
//      `activated` when it crosses the project threshold),
//   3. evaluates the agent's activation_rules against the signal + state and,
//      on the first matching rule (respecting the per-session cooldown),
//      produces a proactive intervention — delegating message+UI generation to
//      the existing rag-onboarding-orchestrate function (no duplicated AI logic).
//
// It is intentionally public (no auth header): the agent is identified by its
// public_key, exactly like rag-onboarding-orchestrate / -next-step.
//
// Body: {
//   agent_public_key: string,
//   visitor_id?: string,            // anonymous widget id
//   external_user_id?: string,      // host SaaS user id (once identified)
//   user_email?: string,
//   signal?: { type: "idle"|"rage_click"|"route_change"|"feature_used"|"heartbeat",
//              rage_clicks?: number, feature?: string },
//   context: {
//     route: string,
//     page_title?: string,
//     seconds_on_page?: number,
//     visible_elements?: Array<{ label: string; selector: string }>,
//     completed_intents?: string[],
//     recent_event?: { type: string; data?: unknown },
//   }
// }
//
// Response: {
//   session: { activation_score, activated, conversation_turns },
//   proactive: null | {
//     intervention_id: string,
//     rule_id: string | null,
//     trigger_type: string,
//     text: string,
//     actions: unknown[],          // UI commands (orchestrate schema)
//     flow_id?: string | null,
//   }
// }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

interface Signal {
  type: "idle" | "rage_click" | "route_change" | "feature_used" | "heartbeat";
  rage_clicks?: number;
  feature?: string;
}

interface TickContext {
  route?: string;
  page_title?: string;
  seconds_on_page?: number;
  visible_elements?: Array<{ label: string; selector: string }>;
  completed_intents?: string[];
  recent_event?: { type: string; data?: unknown };
}

interface TickBody {
  agent_public_key?: string;
  visitor_id?: string;
  external_user_id?: string;
  user_email?: string;
  signal?: Signal;
  context?: TickContext;
}

// Static, tuned activation scoring config (no per-project table / UI).
//
// Calibration rationale — a visitor reaches the threshold (50) through *real*
// product progress, not noise:
//   - completing 2 key actions (10 each) + 1 onboarding step (8) + adopting 2
//     features (5 each) + a couple of agent turns (2 each, capped) ≈ 52.
//   - any single signal alone stays well below 50, so "activated" means a
//     visitor genuinely engaged across several axes.
// Key actions are weighted higher (10) than features (5) because is_key_action
// is the user's own declared definition of meaningful product use; onboarding
// steps sit between (8) as they prove guided progress.
const WEIGHTS = {
  default_key_weight: 10, // points per distinct is_key_action event performed
  feature_weight: 5, // points per distinct feature adopted
  step_weight: 8, // points per completed onboarding step/intent
  turn_weight: 2, // points per agent conversation turn …
  turn_cap: 5, // … capped so chat alone can't activate (max 10)
  activation_threshold: 50,
} as const;

type Weights = typeof WEIGHTS;

// Static default rule set — used when an agent has no enabled activation_rules.
// Tuned to be helpful without nagging: react to genuine friction (rage clicks)
// immediately, offer help on a new page only after the user has had time to
// look around, and nudge a long-idle visitor. All share a 5-minute cooldown.
const DEFAULT_RULES: Rule[] = [
  {
    id: "default:rage_click",
    trigger_type: "rage_click",
    idle_seconds: null,
    rage_click_threshold: 4,
    on_route: null,
    score_below: null,
    unused_feature: null,
    min_seconds_on_page: 0,
    action_kind: "orchestrate",
    flow_id: null,
    message: null,
    cooldown_seconds: 300,
  },
  {
    id: "default:route_change",
    trigger_type: "route_change",
    idle_seconds: null,
    rage_click_threshold: null,
    on_route: null,
    score_below: null,
    unused_feature: null,
    min_seconds_on_page: 4, // only after the user has settled on the page
    action_kind: "orchestrate",
    flow_id: null,
    message: null,
    cooldown_seconds: 300,
  },
  {
    id: "default:idle",
    trigger_type: "idle",
    idle_seconds: 90,
    rage_click_threshold: null,
    on_route: null,
    score_below: null,
    unused_feature: null,
    min_seconds_on_page: 0,
    action_kind: "orchestrate",
    flow_id: null,
    message: null,
    cooldown_seconds: 300,
  },
];

interface SessionRow {
  id: string;
  visited_routes: string[];
  used_features: string[];
  completed_intents: string[];
  conversation_turns: number;
  activation_score: number;
  activated: boolean;
  proactive_cooldown_until: string | null;
}

interface Rule {
  id: string;
  trigger_type: string;
  idle_seconds: number | null;
  rage_click_threshold: number | null;
  on_route: string | null;
  score_below: number | null;
  unused_feature: string | null;
  min_seconds_on_page: number | null;
  action_kind: string;
  flow_id: string | null;
  message: string | null;
  cooldown_seconds: number;
}

/** Simple trailing-* glob match for rule.on_route (e.g. "/billing*"). */
function routeMatches(pattern: string | null, route: string): boolean {
  if (!pattern) return true; // no constraint
  if (pattern.endsWith("*")) return route.startsWith(pattern.slice(0, -1));
  return route === pattern;
}

/** Recompute the weighted activation score from the session + key events. */
async function computeScore(
  admin: SupabaseClient,
  projectId: string,
  session: SessionRow,
  weights: Weights,
  keyActions: Set<string>,
  identity: { user_email?: string | null; external_user_id?: string | null },
): Promise<number> {
  let score = 0;

  // 1) Key-action events *this visitor* performed (from product_events). We can
  //    only attribute events that share an identity with the session: the host
  //    SaaS's user_email or the external/customer id. Each distinct key action
  //    scores once (presence-based, not frequency) to keep the score stable.
  if (keyActions.size > 0 && (identity.user_email || identity.external_user_id)) {
    let query = admin
      .from("product_events")
      .select("event_name")
      .eq("project_id", projectId)
      .in("event_name", Array.from(keyActions))
      .limit(500);
    query = identity.user_email
      ? query.eq("user_email", identity.user_email)
      : query.eq("customer_external_id", identity.external_user_id!);

    const { data: rows } = await query;
    const seen = new Set<string>();
    for (const r of (rows ?? []) as Array<{ event_name: string }>) {
      if (seen.has(r.event_name)) continue;
      seen.add(r.event_name);
      score += weights.default_key_weight;
    }
  }

  // 2) Features adopted + onboarding steps completed + capped conversation turns.
  score += session.used_features.length * weights.feature_weight;
  score += session.completed_intents.length * weights.step_weight;
  score += Math.min(session.conversation_turns, weights.turn_cap) * weights.turn_weight;

  return score;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = (await req.json()) as TickBody;
    const { agent_public_key, visitor_id, external_user_id, user_email, signal, context } = body;

    if (!agent_public_key) return jsonResponse({ error: "agent_public_key required" }, { status: 400 });
    if (!visitor_id && !external_user_id) {
      return jsonResponse({ error: "visitor_id or external_user_id required" }, { status: 400 });
    }
    if (!context) return jsonResponse({ error: "context required" }, { status: 400 });

    const admin = createServiceClient();

    // 1) Resolve agent + project.
    const { data: agent } = await admin
      .from("rag_agents")
      .select("id, workspace_id, project_id, onboarding_enabled, public_key")
      .eq("public_key", agent_public_key)
      .maybeSingle();
    if (!agent) return jsonResponse({ error: "Unknown agent" }, { status: 404 });

    const identity = visitor_id ? { visitor_id } : { external_user_id: external_user_id! };
    const route = context.route ?? "/";

    // 2) Load (or create) the activation session.
    const { data: existing } = await admin
      .from("activation_sessions")
      .select(
        "id, visited_routes, used_features, completed_intents, conversation_turns, activation_score, activated, proactive_cooldown_until",
      )
      .eq("agent_id", agent.id)
      .match(identity)
      .maybeSingle();

    let session = existing as SessionRow | null;
    if (!session) {
      const { data: created } = await admin
        .from("activation_sessions")
        .insert({
          workspace_id: agent.workspace_id,
          project_id: agent.project_id,
          agent_id: agent.id,
          ...identity,
          user_email: user_email ?? null,
          last_route: route,
        })
        .select(
          "id, visited_routes, used_features, completed_intents, conversation_turns, activation_score, activated, proactive_cooldown_until",
        )
        .single();
      session = created as SessionRow;
    }

    // 3) Fold the incoming signal/context into the session state.
    const visited = new Set(session.visited_routes);
    visited.add(route);
    const features = new Set(session.used_features);
    if (signal?.type === "feature_used" && signal.feature) features.add(signal.feature);
    const intents = new Set(session.completed_intents);
    for (const i of context.completed_intents ?? []) intents.add(i);

    // 4) Score with the static tuned WEIGHTS. The only per-project input is the
    //    set of key actions (event_definitions.is_key_action) — the user's own
    //    declaration of what meaningful product use looks like.
    const { data: defs } = await admin
      .from("event_definitions")
      .select("event_name")
      .eq("project_id", agent.project_id)
      .eq("is_key_action", true);
    const keyActions = new Set<string>(
      ((defs ?? []) as Array<{ event_name: string }>).map((d) => d.event_name),
    );

    const stagedSession: SessionRow = {
      ...session,
      visited_routes: Array.from(visited),
      used_features: Array.from(features),
      completed_intents: Array.from(intents),
    };
    const score = await computeScore(admin, agent.project_id, stagedSession, WEIGHTS, keyActions, {
      user_email: user_email ?? null,
      external_user_id: external_user_id ?? null,
    });
    const wasActivated = session.activated;
    const activated = wasActivated || score >= WEIGHTS.activation_threshold;

    // 5) Persist the updated session.
    await admin
      .from("activation_sessions")
      .update({
        visited_routes: stagedSession.visited_routes,
        used_features: stagedSession.used_features,
        completed_intents: stagedSession.completed_intents,
        activation_score: score,
        activated,
        activated_at: !wasActivated && activated ? new Date().toISOString() : undefined,
        last_route: route,
        last_seen_at: new Date().toISOString(),
        user_email: user_email ?? undefined,
      })
      .eq("id", session.id);

    // 6) Decide whether to fire a proactive intervention.
    let proactive: Record<string, unknown> | null = null;
    const now = Date.now();
    const onCooldown = session.proactive_cooldown_until
      ? now < new Date(session.proactive_cooldown_until).getTime()
      : false;

    if (signal && signal.type !== "heartbeat" && signal.type !== "feature_used" && !onCooldown) {
      const { data: dbRules } = await admin
        .from("activation_rules")
        .select(
          "id, trigger_type, idle_seconds, rage_click_threshold, on_route, score_below, unused_feature, min_seconds_on_page, action_kind, flow_id, message, cooldown_seconds",
        )
        .eq("agent_id", agent.id)
        .eq("enabled", true)
        .order("priority", { ascending: true });

      // Per-agent rows override the static defaults; otherwise use the defaults
      // so the engine is proactive with zero configuration.
      const rules = (dbRules as Rule[] | null)?.length ? (dbRules as Rule[]) : DEFAULT_RULES;

      const secondsOnPage = context.seconds_on_page ?? 0;
      const matched = rules.find((r) => {
        if (r.trigger_type !== signal.type) return false;
        if (!routeMatches(r.on_route, route)) return false;
        if ((r.min_seconds_on_page ?? 0) > secondsOnPage) return false;
        if (signal.type === "rage_click" && (signal.rage_clicks ?? 0) < (r.rage_click_threshold ?? 4)) return false;
        if (signal.type === "low_score" && score >= (r.score_below ?? 0)) return false;
        if (r.trigger_type === "feature_unused" && r.unused_feature && features.has(r.unused_feature)) return false;
        return true;
      });

      if (matched) {
        proactive = await fireRule(admin, agent, matched, stagedSession, context, route, signal);
        // Arm the per-session cooldown so we don't spam the user.
        await admin
          .from("activation_sessions")
          .update({
            proactive_cooldown_until: new Date(now + matched.cooldown_seconds * 1000).toISOString(),
          })
          .eq("id", session.id);
      }
    }

    return jsonResponse({
      session: {
        activation_score: score,
        activated,
        conversation_turns: session.conversation_turns,
      },
      proactive,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});

/** Produce the proactive payload for a matched rule + log the intervention. */
async function fireRule(
  admin: SupabaseClient,
  agent: {
    id: string;
    workspace_id: string;
    project_id: string;
    onboarding_enabled: boolean;
    public_key: string;
  },
  rule: Rule,
  session: SessionRow,
  context: TickContext,
  route: string,
  signal: Signal,
): Promise<Record<string, unknown> | null> {
  let text = rule.message ?? "";
  let actions: unknown[] = [];
  const flowId: string | null = rule.flow_id;

  if (rule.action_kind === "orchestrate" && agent.onboarding_enabled) {
    // Reuse the existing orchestration brain — same prompt, same UI command
    // schema — instead of re-implementing AI logic here.
    try {
      const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/rag-onboarding-orchestrate`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({
          agent_public_key: agent.public_key,
          visitor_id: session.id, // orchestrate only needs an identity for logging
          context: {
            route,
            recent_event: { type: `proactive:${signal.type}` },
            completed_intents: session.completed_intents,
          },
        }),
      });
      if (res.ok) {
        const d = (await res.json()) as { text?: string; actions?: unknown[] };
        if (d.text) text = d.text;
        if (Array.isArray(d.actions)) actions = d.actions;
      }
    } catch {
      /* non-fatal — fall through to whatever text we have */
    }
  }

  if (!text) {
    // Sensible default copy per trigger so the widget always has something.
    text =
      signal.type === "rage_click"
        ? "Looks like this isn't working as expected — want a hand?"
        : signal.type === "idle"
          ? "Need help getting started on this page?"
          : "Here's a quick tip for this screen.";
  }

  // Default rules have synthetic ids ("default:*"); rule_id is a UUID FK, so
  // only persist it for real DB-backed rules.
  const persistedRuleId = rule.id.startsWith("default:") ? null : rule.id;

  const { data: intervention } = await admin
    .from("activation_interventions")
    .insert({
      workspace_id: agent.workspace_id,
      project_id: agent.project_id,
      agent_id: agent.id,
      session_id: session.id,
      rule_id: persistedRuleId,
      trigger_type: rule.trigger_type,
      route,
      message: text,
      outcome: "shown",
    })
    .select("id")
    .single();

  return {
    intervention_id: intervention?.id ?? null,
    rule_id: persistedRuleId,
    trigger_type: rule.trigger_type,
    text,
    actions,
    flow_id: flowId,
  };
}
