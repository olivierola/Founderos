// rag-agent-public-config — return the public-facing configuration of an agent
// so the embed widget can render itself (name, welcome message, accent color,
// widget_config overrides, onboarding flag). No JWT required.
//
// Body: { public_key }

import type { Request, Response } from "express";
import { HttpError } from "../shared/http.ts";
import { createServiceClient } from "../shared/supabase.ts";

export async function ragAgentPublicConfig(req: Request, res: Response): Promise<void> {
  const { public_key } = req.body as { public_key?: string };
  if (!public_key) throw new HttpError(400, "public_key required");

  const { data: agent } = await createServiceClient()
    .from("rag_agents")
    .select("name, welcome_message, widget_config, accent_color, enabled, onboarding_enabled, onboarding_copilot_enabled")
    .eq("public_key", public_key)
    .maybeSingle();
  if (!agent || agent.enabled === false) {
    throw new HttpError(404, "Agent not available");
  }

  res.json({
    name: agent.name,
    welcome_message: agent.welcome_message,
    accent_color: agent.accent_color ?? "#001BB7",
    widget_config: agent.widget_config ?? {},
    onboarding_enabled: !!agent.onboarding_enabled,
    onboarding_copilot_enabled: !!agent.onboarding_copilot_enabled,
  });
}
