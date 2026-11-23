// Lancer une mission tout de suite : un run « en file » sur la mission, puis
// internal-agent-run en mode mission (harnais OpenCode). C'est le chemin que
// prennent déjà le front, l'ordonnanceur et les délégations.
//
// Deux appelants (create_mission avec start_now, et le lancement d'un agent sur
// un work item) envoyaient seulement { mode: "mission", mission_id } : l'ancien
// moteur répondait 400 et la mission ne partait jamais.

import type { SupabaseClient } from "@supabase/supabase-js";
import { Deno, FUNCTIONS_URL } from "../../compat/index.ts";

export async function launchMissionNow(admin: SupabaseClient, input: {
  missionId: string;
  agentId: string;
  workspaceId: string;
  projectId: string;
  /** Qui l'a demandé (personne), pour les outils qui agissent en son nom. */
  triggeredBy?: string | null;
  via?: string;
}): Promise<string | null> {
  const { data: run, error } = await admin.from("internal_agent_runs").insert({
    agent_id: input.agentId, workspace_id: input.workspaceId, project_id: input.projectId,
    mission_id: input.missionId, status: "queued", triggered_via: input.via ?? "api",
    triggered_by: input.triggeredBy ?? null,
  }).select("id").single();
  if (error || !run) return null;
  const runId = (run as { id: string }).id;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (key) {
    // Sans attendre : un run dure des minutes. Si l'appel échoue, l'ordonnanceur
    // reprend les runs restés en file.
    fetch(`${FUNCTIONS_URL}/functions/v1/internal-agent-run`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: input.agentId, mode: "mission", run_id: runId }),
    }).catch(() => {});
  }
  return runId;
}
