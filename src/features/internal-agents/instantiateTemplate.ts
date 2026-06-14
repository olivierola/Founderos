import { supabase } from "@/lib/supabase";
import { autonomyToFlags, type AgentTemplate } from "./agentTemplates";

// Instantiate a template into a real, runnable internal agent: the agent row
// (persona/instructions/autonomy) + its preset tools. Returns the new agent id.
export async function instantiateTemplate(
  template: AgentTemplate,
  ctx: { workspaceId: string; projectId: string; userId: string },
): Promise<string> {
  const flags = autonomyToFlags(template.autonomy);

  const { data: agent, error } = await supabase
    .from("internal_agents")
    .insert({
      workspace_id: ctx.workspaceId,
      project_id: ctx.projectId,
      created_by: ctx.userId,
      name: template.name,
      description: template.tagline,
      avatar_emoji: template.emoji,
      accent_color: template.accent,
      persona: template.persona,
      instructions: template.instructions,
      max_steps: template.max_steps,
      requires_approval: flags.requires_approval,
      chat_enabled: true,
      mission_enabled: true,
    })
    .select("id")
    .single();
  if (error || !agent) throw new Error(error?.message ?? "Could not create the agent");

  if (template.tools.length > 0) {
    const rows = template.tools.map((t) => ({
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
