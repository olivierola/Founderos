// Best-effort auto-incident recording from the agent runtime into the governance
// register (gov_incidents). The runtime is the only writer here — RLS is bypassed
// by the service role, so nothing a member does is at risk. Failures never block
// the agent loop: every function swallows its errors.

import { createServiceClient } from "./supabase-admin.ts";

export type GovIncidentCategory = "bias" | "harmful_output" | "data_leak" | "outage" | "privacy" | "other";
export type GovSeverity = "low" | "medium" | "high" | "critical";

interface AgentLite {
  id: string;
  workspace_id: string;
  project_id: string;
}

/** Link an internal_agent to its gov_ai_systems row (source 'internal_agent'). */
export async function resolveSystemId(
  admin: ReturnType<typeof createServiceClient>,
  agentId: string,
): Promise<string | null> {
  try {
    const { data } = await admin
      .from("gov_ai_systems")
      .select("id")
      .eq("agent_id", agentId)
      .eq("source", "internal_agent")
      .limit(1)
      .maybeSingle();
    return (data as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

export interface RecordRunIncidentInput {
  title: string;
  description: string;
  category: GovIncidentCategory;
  severity: GovSeverity;
}

/** Insert a gov_incidents row for a run (service role). Deduplicates by a stable
 *  natural key stored in the title so the same failure doesn't stack rows. */
export async function recordRunIncident(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentLite,
  runId: string,
  input: RecordRunIncidentInput,
): Promise<void> {
  try {
    // One incident per run per kind: skip if this run already produced one.
    const marker = `run ${runId}`;
    const { data: existing } = await admin
      .from("gov_incidents")
      .select("id")
      .eq("project_id", agent.project_id)
      .eq("description", marker)
      .limit(1);
    if (existing && existing.length > 0) return;

    const systemId = await resolveSystemId(admin, agent.id);
    await admin.from("gov_incidents").insert({
      workspace_id: agent.workspace_id,
      project_id: agent.project_id,
      system_id: systemId,
      title: input.title.slice(0, 300),
      description: `${marker}\n\n${input.description.slice(0, 2000)}`,
      category: input.category,
      severity: input.severity,
      status: "open",
      occurred_at: new Date().toISOString(),
    });
  } catch { /* best-effort */ }
}

/** Record a guardrail BLOCK as a governance incident (privacy/data leak mapping
 *  by the guardrail's category wording, otherwise 'other'). */
export async function recordGuardrailIncident(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentLite,
  runId: string,
  guardrailTitle: string,
  scope: string,
  matched: string,
): Promise<void> {
  const t = `${guardrailTitle}`.toLowerCase();
  const category: GovIncidentCategory =
    /pii|personnel|privacy|donn[eé]es personnelles/.test(t) ? "privacy"
    : /secret|cl[eé]|token|credential|fuite|exfiltration|data.?leak/.test(t) ? "data_leak"
    : "other";
  await recordRunIncident(admin, agent, runId, {
    title: `Guardrail bloqué — ${guardrailTitle}`,
    description: `Guardrail « ${guardrailTitle} » (scope ${scope})${matched ? ` — correspondance : « ${matched} »` : ""}. Action non exécutée.`,
    category,
    severity: "high",
  });
}
