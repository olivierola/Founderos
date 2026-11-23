// Les garde-fous d'un run sur le harnais (aiops_guardrails, 0259 ; pools 0291) :
// les mêmes passes que l'ancien moteur, aux mêmes endroits.
//
//   prompt       la demande, avant que le run ne parte : un blocage le fait
//                échouer avec un incident, sans appeler le modèle.
//   tool_call    l'appel d'outil, avant son exécution : un blocage rend une
//                ERROR au modèle, l'outil ne part jamais.
//   tool_result  le résultat, avant qu'il n'atteigne le modèle : un blocage le
//                remplace par une ERROR.
//
// Deux passes à chaque fois : l'expression régulière (ce qui s'écrit) et le
// jugement sémantique (ce qui se comprend, si l'usage est allumé). Une panne de
// chargement vaut « aucun garde-fou », pas un run cassé.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkGuardrails, judgeGuardrails, loadGuardrails, mergeViolations, strongestEnforcement,
  type GuardrailRow, type GuardrailScope, type GuardrailViolation,
} from "../edge/_shared/guardrails.ts";
import { recordGuardrailIncident } from "../edge/_shared/governance-incidents.ts";
import { loadPoolScope } from "../edge/_shared/resource-pools.ts";

export interface GuardAgent {
  id: string;
  workspace_id: string;
  project_id: string;
  service_dashboard_id?: string | null;
}

/** Les garde-fous qui s'appliquent à un agent : ceux de l'espace pour son équipe, plus ceux de ses pools. */
export async function loadAgentGuardrails(admin: SupabaseClient, agent: GuardAgent): Promise<GuardrailRow[]> {
  try {
    const scope = await loadPoolScope(admin, agent.id).catch(() => null);
    return await loadGuardrails(admin as never, agent.workspace_id, agent.project_id, {
      teamId: agent.service_dashboard_id ?? null, surface: "internal",
      extraIds: scope ? [...scope.guardrails] : undefined,
    });
  } catch {
    return [];
  }
}

async function evaluate(
  admin: SupabaseClient, agent: GuardAgent, runId: string | null, rows: GuardrailRow[], scope: GuardrailScope, text: string,
): Promise<GuardrailViolation[]> {
  if (!rows.length || !text.trim()) return [];
  return mergeViolations(
    checkGuardrails(rows, scope, text),
    await judgeGuardrails({ admin: admin as never, workspaceId: agent.workspace_id, projectId: agent.project_id, runId }, rows, scope, text).catch(() => []),
  );
}

async function logHits(admin: SupabaseClient, agent: GuardAgent, runId: string | null, scope: string, hits: GuardrailViolation[], blocked: boolean, tool?: string) {
  if (!runId) return;
  for (const v of hits) {
    await admin.from("internal_agent_run_events").insert({
      run_id: runId, agent_id: agent.id, kind: "guardrail",
      payload: { scope, guardrail: v.title, category: v.category, enforcement: v.enforcement, matched: v.matched, blocked, ...(tool ? { tool } : {}) },
    }).then(() => {}, () => {});
  }
}

/** La demande d'un run : null si elle passe, sinon le message de refus (incident enregistré). */
export async function guardPrompt(admin: SupabaseClient, agent: GuardAgent, runId: string, text: string, rows?: GuardrailRow[]): Promise<string | null> {
  const g = rows ?? await loadAgentGuardrails(admin, agent);
  const hits = await evaluate(admin, agent, runId, g, "prompt", text);
  if (!hits.length) return null;
  const block = strongestEnforcement(hits) === "block";
  await logHits(admin, agent, runId, "prompt", hits, block);
  if (!block) return null;
  await recordGuardrailIncident(admin as never, agent, runId, hits[0].title, "prompt", hits[0].matched).catch(() => {});
  return `Demande refusée par le guardrail « ${hits[0].title} »${hits[0].matched ? ` (correspondance : « ${hits[0].matched} »)` : ""}. La consigne enfreint une règle de sécurité de cet espace : reformulez votre demande.`;
}

/** Un appel d'outil : null s'il passe, sinon l'ERROR rendue au modèle (l'outil ne part pas). */
export async function guardToolCall(
  admin: SupabaseClient, agent: GuardAgent, runId: string | null, rows: GuardrailRow[], name: string, args: Record<string, unknown>,
): Promise<string | null> {
  const hits = await evaluate(admin, agent, runId, rows, "tool_call", `${name}\n${JSON.stringify(args ?? {})}`);
  if (!hits.length) return null;
  const block = strongestEnforcement(hits) === "block";
  await logHits(admin, agent, runId, "tool_call", hits, block, name);
  if (!block) return null;
  if (runId) await recordGuardrailIncident(admin as never, agent, runId, hits[0].title, "tool_call", hits[0].matched).catch(() => {});
  return `ERROR: Action bloquée par le guardrail « ${hits[0].title} » (${hits[0].matched ? `correspondance : ${hits[0].matched}` : "règle de sécurité"}). Ne la contourne pas avec une variante : fais sans, ou explique à la personne pourquoi elle est nécessaire.`;
}

/** Le résultat d'un outil : tel quel s'il passe, sinon remplacé par une ERROR. */
export async function guardToolResult(
  admin: SupabaseClient, agent: GuardAgent, runId: string | null, rows: GuardrailRow[], name: string, result: string,
): Promise<string> {
  const hits = await evaluate(admin, agent, runId, rows, "tool_result", result.slice(0, 4000));
  if (!hits.length) return result;
  const block = strongestEnforcement(hits) === "block";
  await logHits(admin, agent, runId, "tool_result", hits, block, name);
  if (!block) return result;
  if (runId) await recordGuardrailIncident(admin as never, agent, runId, hits[0].title, "tool_result", hits[0].matched).catch(() => {});
  return `ERROR: Résultat bloqué par le guardrail « ${hits[0].title} » : le contenu renvoyé enfreint une règle de sécurité et n'est pas transmis.`;
}
