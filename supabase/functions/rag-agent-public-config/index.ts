// rag-agent-public-config — return the public-facing configuration of an agent
// so the embed widget can render itself (name, welcome message, accent color,
// widget_config overrides, onboarding flag). No JWT required.
//
// Body: { public_key }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json().catch(() => ({}));
    const { public_key } = body as { public_key?: string };
    if (!public_key) return jsonResponse({ error: "public_key required" }, { status: 400 });

    const admin = createServiceClient();
    const { data: agent } = await admin
      .from("rag_agents")
      .select("name, welcome_message, widget_config, accent_color, enabled, onboarding_enabled")
      .eq("public_key", public_key)
      .maybeSingle();
    if (!agent || agent.enabled === false) {
      return jsonResponse({ error: "Agent not available" }, { status: 404 });
    }

    return jsonResponse({
      name: agent.name,
      welcome_message: agent.welcome_message,
      accent_color: agent.accent_color ?? "#001BB7",
      widget_config: agent.widget_config ?? {},
      onboarding_enabled: !!agent.onboarding_enabled,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
