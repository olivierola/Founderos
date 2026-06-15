import { supabase } from "@/lib/supabase";
import { autonomyToFlags, type AgentTemplate, type AutonomyLevel, type TemplateTool } from "./agentTemplates";

// Optional per-instance overrides chosen in the config stepper.
export interface TemplateOverrides {
  name?: string;
  description?: string;
  emoji?: string;
  accent?: string;
  instructions?: string;
  autonomy?: AutonomyLevel;
  /** Subset of the template's tools to enable (defaults to all). */
  tools?: TemplateTool[];
}

// Instantiate a template into a real, runnable internal agent: the agent row
// (persona/instructions/autonomy) + its preset tools. Returns the new agent id.
export async function instantiateTemplate(
  template: AgentTemplate,
  ctx: { workspaceId: string; projectId: string; userId: string },
  overrides: TemplateOverrides = {},
): Promise<string> {
  const autonomy = overrides.autonomy ?? template.autonomy;
  const flags = autonomyToFlags(autonomy);
  const tools = overrides.tools ?? template.tools;

  // Core columns guaranteed by the base schema. We add the v2 columns
  // (max_steps / requires_approval) in a follow-up update so a stale PostgREST
  // schema cache on those columns can never block agent creation.
  const base = {
    workspace_id: ctx.workspaceId,
    project_id: ctx.projectId,
    created_by: ctx.userId,
    name: overrides.name?.trim() || template.name,
    description: overrides.description?.trim() || template.tagline,
    avatar_emoji: overrides.emoji || template.emoji,
    accent_color: overrides.accent || template.accent,
    persona: template.persona,
    instructions: overrides.instructions?.trim() || template.instructions,
    chat_enabled: true,
    mission_enabled: true,
  };

  const { data: agent, error } = await supabase
    .from("internal_agents")
    .insert(base)
    .select("id")
    .single();
  if (error || !agent) throw new Error(error?.message ?? "Could not create the agent");

  // Best-effort: set autonomy guardrails (v2 columns). Ignore if unavailable.
  try {
    await supabase
      .from("internal_agents")
      .update({ max_steps: template.max_steps, requires_approval: flags.requires_approval })
      .eq("id", agent.id);
  } catch {
    /* v2 columns not in cache yet — agent still works with defaults */
  }

  if (tools.length > 0) {
    const rows = tools.map((t) => ({
      agent_id: agent.id,
      kind: t.kind,
      name: t.name,
      description: t.description ?? null,
      config: t.config ?? {},
      requires_approval: t.requires_approval ?? false,
      enabled: true,
    }));
    const { error: toolErr } = await supabase.from("internal_agent_tools").insert(rows);
    // Tools are best-effort: the agent is still usable without every tool.
    if (toolErr) console.warn("Some tools could not be added:", toolErr.message);
  }

  return agent.id as string;
}
