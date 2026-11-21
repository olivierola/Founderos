import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";

// La machine d'équipe (migration 0296, fonction team-machine) : un poste Linux
// partagé par les agents d'une équipe, un utilisateur Linux par agent, des
// dossiers protégés dont seuls les membres présentent le secret. Les secrets ne
// passent JAMAIS par ici : l'interface voit les membres, pas les clés.

export interface MachineInfo {
  team_id: string;
  team_key: string;
  status: "active" | "paused";
  allow_system_packages: boolean;
  url: string | null;
  machine_path: string | null;
  last_seen_at: string | null;
  last_error: string | null;
}

export interface MachineAgent {
  team_id: string;
  agent_id: string;
  unix_user: string;
  home_path: string;
  last_used_at: string | null;
}

export interface MachineFolderMember {
  folder_id: string;
  agent_id: string;
  role: "owner" | "member";
  added_at: string;
}

export interface MachineFolder {
  id: string;
  team_id: string;
  name: string;
  path: string | null;
  purpose: string | null;
  status: string;
  created_by_agent: string | null;
  created_by_user: string | null;
  secret_rotated_at: string | null;
  created_at: string;
  members: MachineFolderMember[];
}

export interface MachineAuditRow {
  id: number;
  team_id: string;
  agent_id: string | null;
  user_id: string | null;
  action: string;
  folder_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface LiveTeam {
  id: string;
  key: string;
  path: string;
  suspended: boolean;
  usage_kb: number | null;
  agents: Array<{ id: string; user: string; jobs_running: number }>;
}

export interface TeamMachineState {
  team_id: string;
  machine: MachineInfo | null;
  agents: MachineAgent[];
  folders: MachineFolder[];
  audit: MachineAuditRow[];
  live: LiveTeam | null;
}

export interface MachineStatus {
  ok: boolean;
  /** TEAM_MACHINE_URL / TEAM_MACHINE_TOKEN posés côté serveur. */
  configured: boolean;
  live: { reachable: boolean; error?: string; apt?: boolean };
  teams: TeamMachineState[];
}

/** L'état complet (annuaire + machine vivante) — pour le panneau. */
export function useTeamMachineStatus(dashboardId: string, enabled = true) {
  return useQuery({
    queryKey: ["team_machine_status", dashboardId],
    queryFn: () => callEdge<MachineStatus>("team-machine", { action: "status", dashboard_id: dashboardId }),
    enabled,
    staleTime: 10_000,
    retry: false,
  });
}

/** Qui a une machine, d'un coup d'œil (lecture directe, RLS) — pour les cartes d'équipe. */
export function useTeamMachineFlags(dashboardId: string) {
  return useQuery({
    queryKey: ["team_machine_flags", dashboardId],
    queryFn: async () => {
      const { data, error } = await supabase.from("team_machines").select("team_id, status").eq("dashboard_id", dashboardId);
      // 0296 pas encore appliquée : aucune machine, sans erreur affichée.
      if (error) return new Map<string, "active" | "paused">();
      return new Map(((data ?? []) as Array<{ team_id: string; status: "active" | "paused" }>).map((r) => [r.team_id, r.status]));
    },
    staleTime: 30_000,
  });
}

export function useRefreshTeamMachine(dashboardId: string) {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ["team_machine_status", dashboardId] }),
    qc.invalidateQueries({ queryKey: ["team_machine_flags", dashboardId] }),
  ]);
}

type Res = { ok: boolean; error?: string };
export const machineApi = {
  enable: (dashboardId: string, teamId: string, allowSystemPackages = false) =>
    callEdge<Res>("team-machine", { action: "enable", dashboard_id: dashboardId, team_id: teamId, allow_system_packages: allowSystemPackages }),
  pause: (teamId: string) => callEdge<Res>("team-machine", { action: "pause", team_id: teamId }),
  settings: (teamId: string, patch: { allow_system_packages?: boolean }) =>
    callEdge<Res>("team-machine", { action: "settings", team_id: teamId, ...patch }),
  createFolder: (teamId: string, input: { name: string; purpose: string; memberIds: string[]; ownerId: string | null }) =>
    callEdge<Res & { folder?: { id: string; name: string; path: string } }>("team-machine", {
      action: "folder_create", team_id: teamId, name: input.name, purpose: input.purpose,
      member_ids: input.memberIds, owner_id: input.ownerId,
    }),
  members: (folderId: string, add: string[], remove: string[]) =>
    callEdge<Res>("team-machine", { action: "folder_members", folder_id: folderId, add, remove }),
  rotate: (folderId: string) => callEdge<Res>("team-machine", { action: "folder_rotate", folder_id: folderId }),
  archive: (folderId: string) => callEdge<Res>("team-machine", { action: "folder_archive", folder_id: folderId }),
  resetAgent: (teamId: string, agentId: string) => callEdge<Res>("team-machine", { action: "agent_reset", team_id: teamId, agent_id: agentId }),
};

/** Le nom de dossier que la machine retiendra (même règle que le serveur). */
export function folderSlug(raw: string): string {
  return raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
    .replace(/\s+/g, "-").replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-.]+$/g, "").slice(0, 48);
}

export const AUDIT_LABELS: Record<string, string> = {
  enable: "a donné une machine à l'équipe",
  resume: "a relancé la machine",
  pause: "a mis la machine en pause",
  folder_create: "a créé le dossier protégé",
  member_add: "a ajouté au dossier",
  member_remove: "a retiré du dossier",
  leave: "a quitté le dossier",
  rotate: "a renouvelé le secret du dossier",
  archive: "a archivé le dossier",
  agent_reset: "a réinitialisé l'identité de",
  apt_install: "a installé des paquets système",
};

export function formatSize(kb: number | null | undefined): string | null {
  if (kb == null) return null;
  if (kb < 1024) return `${kb} Ko`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} Mo`;
  return `${(kb / 1024 / 1024).toFixed(2)} Go`;
}
