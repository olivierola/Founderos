import { supabase } from "@/lib/supabase";
import { autonomyToFlags, templateAvatar, type AgentTemplate, type AutonomyLevel, type TemplateTool } from "./agentTemplates";

// Optional per-instance overrides chosen in the config stepper.
export interface TemplateOverrides {
  name?: string;
  description?: string;
  avatar?: string;
  accent?: string;
  instructions?: string;
  autonomy?: AutonomyLevel;
  /** Subset of the template's tools to enable (defaults to all). */
  tools?: TemplateTool[];
}

// Instantiate a template into a real, runnable internal agent: the agent row
// (persona/instructions/autonomy) + its preset tools. Returns the new agent id.
/**
 * Turn the database's opaque RLS refusal into something actionable. The policy
 * has exactly two clauses, so a rejection means one of two things: the session
 * is gone (auth.uid() is null), or the account is not in that workspace.
 */
export function explainAgentInsertError(message: string | undefined, hasSession: boolean): string {
  if (!message) return "Création de l'agent impossible.";
  if (!/row-level security/i.test(message)) return message;
  return hasSession
    ? "Création refusée : votre compte n'est pas membre de cet espace de travail."
    : "Session expirée — reconnectez-vous puis réessayez.";
}

export async function instantiateTemplate(
  template: AgentTemplate,
  ctx: { workspaceId: string; projectId: string; userId: string; serviceDashboardId?: string | null },
  overrides: TemplateOverrides = {},
): Promise<string> {
  const autonomy = overrides.autonomy ?? template.autonomy;
  const flags = autonomyToFlags(autonomy);
  const tools = overrides.tools ?? template.tools;

  // created_by is read back from the LIVE session rather than trusted from the
  // caller: the INSERT policy demands `created_by = auth.uid()`, so an id
  // threaded through props (stale context, account switch) fails the check with
  // an opaque "violates row-level security policy".
  const { data: authData } = await supabase.auth.getUser();
  const uid = authData.user?.id ?? ctx.userId;

  // Core columns guaranteed by the base schema. We add the v2 columns
  // (max_steps / sandbox_mode / studio) in a follow-up update so a stale
  // PostgREST schema cache on those columns can never block agent creation.
  const base = {
    workspace_id: ctx.workspaceId,
    project_id: ctx.projectId,
    created_by: uid,
    // Scope the agent to a service dashboard when created from one, so it shows
    // up in that dashboard's Agents tab (and nowhere else).
    service_dashboard_id: ctx.serviceDashboardId ?? null,
    name: overrides.name?.trim() || template.name,
    description: overrides.description?.trim() || template.tagline,
    avatar_emoji: null,
    avatar_url: overrides.avatar || templateAvatar(template),
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
  if (error || !agent) throw new Error(explainAgentInsertError(error?.message, !!authData.user));

  // Step budget + the execution world the template needs (security agents
  // require the sandbox).
  //
  // Autonomy is deliberately NOT written here: approval is a per-TOOL flag
  // (internal_agent_tools.requires_approval, applied below) — internal_agents
  // has no such column, and naming it made PostgREST reject the whole update,
  // silently dropping max_steps / sandbox_mode / studio with it.
  const upd: Record<string, unknown> = { max_steps: template.max_steps };
  if (template.sandboxMode) upd.sandbox_mode = template.sandboxMode;
  // Studio agents (vibe code / testing / simulation) — drives the premium
  // border and which session artifact renderer their deliverables get.
  if (template.studio) upd.studio = template.studio;
  const { error: updErr } = await supabase.from("internal_agents").update(upd).eq("id", agent.id);
  if (updErr) console.warn("Agent guardrails not applied:", updErr.message);

  // Activate the template's system skills (progressive-disclosure playbooks).
  if (template.skillSlugs?.length) {
    try {
      const { data: skills } = await supabase
        .from("agent_skills").select("id, slug")
        .is("workspace_id", null).in("slug", template.skillSlugs);
      const rows = (skills ?? []).map((s) => ({ agent_id: agent.id, skill_id: s.id }));
      if (rows.length) await supabase.from("agent_skill_activations").insert(rows);
    } catch {
      /* skills are best-effort — the agent still runs without them */
    }
  }

  if (tools.length > 0) {
    const rows = tools.map((t) => ({
      agent_id: agent.id,
      kind: t.kind,
      name: t.name,
      description: t.description ?? null,
      config: t.config ?? {},
      // Where autonomy actually lands: a non-autopilot template gates its tools.
      requires_approval: t.requires_approval ?? flags.requires_approval,
      enabled: true,
    }));
    const { error: toolErr } = await supabase.from("internal_agent_tools").insert(rows);
    // Tools are best-effort: the agent is still usable without every tool.
    if (toolErr) console.warn("Some tools could not be added:", toolErr.message);
  }

  return agent.id as string;
}
