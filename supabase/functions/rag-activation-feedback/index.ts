// rag-activation-feedback — records the outcome of a proactive intervention.
//
// The widget calls this when the user reacts to a proactive bubble:
//   - clicks it / 👍  → outcome "accepted" (helpful: true)
//   - 👎              → outcome "dismissed" (helpful: false)
//   - auto-times out  → outcome "ignored"
//
// The outcome powers the dashboard's "interventions & acceptance rate" view and
// closes the activation feedback loop (which triggers actually help). It is
// public and identified by the agent public_key, like the other widget
// endpoints — but it can only *update* an existing intervention row it owns, so
// the anon surface stays write-limited.
//
// Body: {
//   public_key: string,
//   intervention_id: string,
//   outcome?: "accepted" | "dismissed" | "ignored",
//   helpful?: boolean,            // 👍/👎; defaults from outcome when omitted
// }
//
// Response: { ok: true }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

const ALLOWED_OUTCOMES = new Set(["accepted", "dismissed", "ignored"]);

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json();
    const { public_key, intervention_id } = body as {
      public_key?: string;
      intervention_id?: string;
      outcome?: string;
      helpful?: boolean;
    };

    if (!public_key) return jsonResponse({ error: "public_key required" }, { status: 400 });
    if (!intervention_id) return jsonResponse({ error: "intervention_id required" }, { status: 400 });

    const outcome = ALLOWED_OUTCOMES.has(body.outcome ?? "") ? (body.outcome as string) : "accepted";

    const admin = createServiceClient();

    // Resolve agent (scopes the update so a public caller can't touch arbitrary rows).
    const { data: agent } = await admin
      .from("rag_agents")
      .select("id")
      .eq("public_key", public_key)
      .maybeSingle();
    if (!agent) return jsonResponse({ error: "Unknown agent" }, { status: 404 });

    // Update only an intervention that belongs to this agent and hasn't been
    // resolved yet (don't overwrite a real reaction with a later timeout).
    const { data: updated, error } = await admin
      .from("activation_interventions")
      .update({ outcome, outcome_at: new Date().toISOString() })
      .eq("id", intervention_id)
      .eq("agent_id", agent.id)
      .eq("outcome", "shown")
      .select("id")
      .maybeSingle();

    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    if (!updated) {
      // Already resolved or not ours — treat as a no-op so the widget never errors.
      return jsonResponse({ ok: true, noop: true });
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
