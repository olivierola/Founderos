import { supabase } from "@/lib/supabase";

/** A folder groups agents inside one service dashboard (migration 0161). */
export interface AgentFolder {
  id: string;
  dashboard_id: string;
  name: string;
  color: string;
  position: number;
  created_at: string;
}

export const FOLDER_COLORS = [
  "bg-slate-500", "bg-indigo-500", "bg-violet-500", "bg-rose-500",
  "bg-orange-500", "bg-amber-500", "bg-emerald-500", "bg-sky-500",
];

export async function fetchAgentFolders(dashboardId: string): Promise<AgentFolder[]> {
  const { data, error } = await supabase
    .from("agent_folders")
    .select("id, dashboard_id, name, color, position, created_at")
    .eq("dashboard_id", dashboardId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as AgentFolder[];
}

export async function createAgentFolder(
  dashboardId: string, workspaceId: string, projectId: string, userId: string | null,
  input: { name: string; color?: string },
): Promise<AgentFolder | null> {
  const { data, error } = await supabase.from("agent_folders").insert({
    dashboard_id: dashboardId, workspace_id: workspaceId, project_id: projectId,
    created_by: userId, name: input.name.trim(), color: input.color ?? FOLDER_COLORS[0],
  }).select("id, dashboard_id, name, color, position, created_at").single();
  if (error) throw new Error(error.message);
  return (data as AgentFolder) ?? null;
}

export async function renameAgentFolder(id: string, name: string, color?: string) {
  const patch: Record<string, unknown> = { name: name.trim() };
  if (color) patch.color = color;
  const { error } = await supabase.from("agent_folders").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Agents inside are kept — the FK is `on delete set null`, so they go unfiled. */
export async function deleteAgentFolder(id: string) {
  const { error } = await supabase.from("agent_folders").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function moveAgentToFolder(agentId: string, folderId: string | null) {
  const { error } = await supabase.from("internal_agents").update({ folder_id: folderId }).eq("id", agentId);
  if (error) throw new Error(error.message);
}
