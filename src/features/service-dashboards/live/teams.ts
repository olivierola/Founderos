import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import {
  fetchServiceDashboards, updateTeams, updateTeamLife, createRoom, addRoomAgent,
  type AgentTeam, type ServiceDashboard, type TeamLifeMode,
} from "../model";

// Les équipes, telles que les écrans les lisent et les écrivent.
//
// Lues dans la liste des tableaux déjà en cache (la coque la charge) : pas de
// requête de plus pour une donnée qui tient dans `settings`. Écrites de façon
// OPTIMISTE — la scène déplace l'agent dans son nouveau bureau tout de suite —
// puis confirmées par la base, et défaites si l'écriture échoue.

export function useTeams(dashboardId: string) {
  const { projectId } = useCurrentContext();
  const qc = useQueryClient();
  const key = ["service_dashboards", projectId];
  const { data: dashboards } = useQuery({
    queryKey: key,
    enabled: !!projectId,
    queryFn: () => fetchServiceDashboards(projectId!),
  });
  const teams = dashboards?.find((d) => d.id === dashboardId)?.settings.teams ?? [];
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(async (fn: (teams: AgentTeam[]) => AgentTeam[]) => {
    const k = ["service_dashboards", projectId];
    const prev = qc.getQueryData<ServiceDashboard[]>(k);
    qc.setQueryData<ServiceDashboard[]>(k, (list) => list?.map((d) => (
      d.id === dashboardId ? { ...d, settings: { ...d.settings, teams: fn(d.settings.teams) } } : d
    )));
    try {
      await updateTeams(dashboardId, fn);
      setError(null);
    } catch (e) {
      qc.setQueryData(k, prev);
      setError(e instanceof Error ? e.message : "Enregistrement impossible");
    } finally {
      qc.invalidateQueries({ queryKey: k });
    }
  }, [qc, projectId, dashboardId]);

  // La vie d'équipe (0295) : le rythme auquel les agents se parlent d'eux-mêmes.
  const teamLife = dashboards?.find((d) => d.id === dashboardId)?.settings.team_life ?? "calm";
  const setTeamLife = useCallback(async (mode: TeamLifeMode) => {
    const k = ["service_dashboards", projectId];
    qc.setQueryData<ServiceDashboard[]>(k, (list) => list?.map((d) => (
      d.id === dashboardId ? { ...d, settings: { ...d.settings, team_life: mode } } : d
    )));
    try {
      await updateTeamLife(dashboardId, mode);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enregistrement impossible");
    } finally {
      qc.invalidateQueries({ queryKey: k });
    }
  }, [qc, projectId, dashboardId]);

  return { teams, mutate, error, teamLife, setTeamLife };
}

/** Les agents du tableau, sous la forme légère que partagent la barre du haut,
 *  la barre latérale et les équipes (même clé, même sélection). */
export interface LiteAgent { id: string; name: string; avatar_url: string | null; accent_color: string | null; is_orchestrator: boolean }

export function useLiteAgents(dashboardId: string) {
  return useQuery({
    queryKey: ["sd_panel_agents", dashboardId],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents")
        .select("id, name, avatar_url, accent_color, is_orchestrator")
        .eq("service_dashboard_id", dashboardId).eq("is_archived", false)
        .order("is_orchestrator", { ascending: false }).order("created_at", { ascending: true });
      return (data ?? []) as LiteAgent[];
    },
  });
}

/**
 * « Réunir l'équipe » : une room avec tous ses membres, intitulée par ce sur
 * quoi elle travaille. C'est ce qui donne à une équipe une existence au-delà
 * du plan des locaux — on lui parle d'un seul coup, et elle se répartit le
 * travail entre elle.
 */
export async function gatherTeam(
  team: AgentTeam,
  dashboard: { id: string; name: string },
  workspaceId: string, projectId: string, userId: string | null,
): Promise<string | null> {
  const title = team.focus.trim() ? `${team.name} · ${team.focus.trim()}` : team.name;
  const roomId = await createRoom(dashboard, workspaceId, projectId, userId, title);
  if (!roomId) return null;
  // L'animateur d'abord : c'est lui qui répond quand personne n'est nommé.
  const order = team.lead_id ? [team.lead_id, ...team.agent_ids.filter((x) => x !== team.lead_id)] : team.agent_ids;
  for (const id of order) await addRoomAgent(roomId, id);
  return roomId;
}
