import { supabase } from "@/lib/supabase";
import { autonomyToFlags, templateAvatar, type AgentTemplate, type AutonomyLevel, type TemplateTool } from "./agentTemplates";

// Optional per-instance overrides chosen in the config stepper.
export interface TemplateOverrides {
  name?: string;
  description?: string;
  avatar?: string;
  accent?: string;
  instructions?: string;
  soul?: string;
  autonomy?: AutonomyLevel;
  /** Subset of the template's tools to enable (defaults to all). */
  tools?: TemplateTool[];
}

/** The shape supabase-js returns; only the fields worth branching on. */
export interface AgentInsertError {
  message?: string;
  code?: string;
  hint?: string | null;
  details?: string | null;
}

/**
 * Explain why creating an agent was refused — by checking, not by guessing.
 *
 * The refusal arrives as one opaque line, and the previous version turned every
 * RLS rejection into "your account is not a member of this workspace". That
 * reads as a fact and is usually false: this screen cannot render until the
 * client has already read the caller's own workspace_members row, so membership
 * is the one thing we know holds. At least three other causes produce the same
 * line — an expired token, the billing quota trigger, or an INSERT policy that
 * predates 0163 — and each needs a different action from the user.
 *
 * So ask the database the membership question directly: is_workspace_member is
 * SECURITY DEFINER and granted to the authenticated role, so it answers about
 * auth.uid() rather than about what the caller happens to be allowed to read.
 * Only then say something — and keep the raw error either way, because a
 * confident wrong diagnosis costs more than a vague one that shows its source.
 */
export async function diagnoseAgentInsertError(
  error: AgentInsertError | null | undefined,
  workspaceId: string | null,
): Promise<string> {
  const message = error?.message;
  if (!message) return "Création de l'agent impossible.";

  // The billing trigger raises check_violation with hint 'billing_limit' and a
  // message that already names the limit reached — pass it through untouched.
  if (error?.hint === "billing_limit" || error?.code === "23514") return message;

  if (!/row-level security/i.test(message)) return message;

  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return "Session expirée — reconnectez-vous puis réessayez.";

  if (!workspaceId) {
    return `Création refusée par la base, et aucun espace de travail n'est résolu côté client. Erreur : ${message}`;
  }

  const { data: isMember, error: rpcErr } = await supabase
    .rpc("is_workspace_member", { p_workspace: workspaceId });

  if (rpcErr) {
    // Helper missing or not granted → the schema predates migration 0159.
    return "Création refusée : la fonction is_workspace_member est introuvable côté base. "
      + `Appliquez les migrations à partir de 0159. Erreur : ${rpcErr.message}`;
  }
  if (isMember === false) {
    return "Création refusée : votre compte n'est pas membre de cet espace de travail.";
  }

  // Session valide et appartenance confirmée par la base : les deux conditions
  // de la policy d'ÉCRITURE sont réunies. Ce qui reste est la policy de
  // LECTURE, que PostgreSQL applique aussi à la ligne proposée parce que la
  // création lit l'id qu'elle vient d'écrire (`.select("id")` → INSERT …
  // RETURNING). Les deux vérifications rendent le même message, et c'est ce qui
  // a fait accuser la policy d'insertion deux fois de suite (0163, puis 0219).
  // Voir 0220, qui juge la lecture sur les colonnes de la ligne au lieu d'aller
  // la relire dans une table où elle n'est pas encore.
  return "Création refusée alors que la base confirme votre session ET votre appartenance à "
    + "l'espace de travail — les deux conditions de la policy d'insertion. C'est donc la policy "
    + "de LECTURE qui refuse la ligne : la création relit l'agent qu'elle écrit, et PostgreSQL "
    + "lui applique aussi les policies SELECT, avec le même message. Appliquez la migration "
    + `0220_agent_select_policy_on_insert.sql. Erreur : ${message}`;
}

// Instantiate a template into a real, runnable internal agent: the agent row
// (persona/instructions/autonomy) + its preset tools. Returns the new agent id.
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
  if (error || !agent) throw new Error(await diagnoseAgentInsertError(error, ctx.workspaceId));

  // Step budget + the execution world the template needs (security agents
  // require the sandbox).
  //
  // Autonomy is deliberately NOT written here: approval is a per-TOOL flag
  // (internal_agent_tools.requires_approval, applied below) — internal_agents
  // has no such column, and naming it made PostgREST reject the whole update,
  // silently dropping max_steps / sandbox_mode / studio with it.
  const upd: Record<string, unknown> = { max_steps: template.max_steps };
  // L'âme part avec l'agent (0210) — mais dans l'update, pas dans l'insert de
  // base : un cache PostgREST en retard sur la colonne ferait échouer toute la
  // création, alors qu'ici il ne coûte qu'un agent sans caractère, réparable.
  //
  // Le fichier de préférences, lui, reste VIDE volontairement : ce sont les
  // préférences de l'utilisateur, apprises en travaillant avec lui. En livrer
  // de pré-écrites reviendrait à lui prêter des habitudes qu'il n'a jamais
  // exprimées, et l'agent les respecterait comme si elles venaient de lui.
  if (overrides.soul?.trim() || template.soul) upd.soul = overrides.soul?.trim() || template.soul;
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
