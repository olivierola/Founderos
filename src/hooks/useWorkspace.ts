import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";

export interface WorkspaceMembership {
  workspace_id: string;
  role: string;
  workspaces: { id: string; name: string; slug: string; plan: string; created_at?: string };
}

export function useWorkspaces() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["workspaces", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("workspace_members")
        .select("workspace_id, role, workspaces(id, name, slug, plan, created_at)")
        .eq("user_id", user!.id);
      if (error) throw error;
      return (data ?? []) as unknown as WorkspaceMembership[];
    },
  });
}

export interface WorkspaceStats {
  projects: number;
  members: number;
}

export function useWorkspaceStats(workspaceIds: string[]) {
  return useQuery({
    queryKey: ["workspace-stats", [...workspaceIds].sort()],
    enabled: workspaceIds.length > 0,
    queryFn: async () => {
      const stats: Record<string, WorkspaceStats> = {};
      await Promise.all(
        workspaceIds.map(async (id) => {
          const [{ count: projects }, { count: members }] = await Promise.all([
            supabase.from("projects").select("id", { count: "exact", head: true }).eq("workspace_id", id),
            supabase.from("workspace_members").select("id", { count: "exact", head: true }).eq("workspace_id", id),
          ]);
          stats[id] = { projects: projects ?? 0, members: members ?? 0 };
        }),
      );
      return stats;
    },
  });
}

export function useProjects(workspaceId: string | null) {
  return useQuery({
    queryKey: ["projects", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("projects")
        .select("*")
        .eq("workspace_id", workspaceId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org"
  );
}

export async function createWorkspace(userId: string, name: string) {
  const base = slugify(name);
  const slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  const { data: ws, error } = await supabase
    .from("workspaces")
    .insert({ name, slug, owner_id: userId })
    .select()
    .single();
  if (error) throw error;
  // The new_user trigger only fires on signup; create membership explicitly here.
  await supabase
    .from("workspace_members")
    .insert({ workspace_id: ws.id, user_id: userId, role: "owner" });
  return ws;
}

export async function createProject(workspaceId: string, name: string) {
  const base = slugify(name);
  const { data: existing } = await supabase
    .from("projects")
    .select("slug")
    .eq("workspace_id", workspaceId);
  const taken = new Set((existing ?? []).map((p: { slug: string }) => p.slug));
  let slug = base;
  let i = 2;
  while (taken.has(slug)) slug = `${base}-${i++}`;

  const { data, error } = await supabase
    .from("projects")
    .insert({ workspace_id: workspaceId, name, slug })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function ensureDefaultProject(workspaceId: string) {
  const { data: existing } = await supabase
    .from("projects")
    .select("*")
    .eq("workspace_id", workspaceId)
    .limit(1)
    .maybeSingle();
  if (existing) return existing;
  return createProject(workspaceId, "Default project");
}

export async function renameWorkspace(workspaceId: string, name: string) {
  const { error } = await supabase.from("workspaces").update({ name }).eq("id", workspaceId);
  if (error) throw error;
}

export async function renameProject(projectId: string, name: string) {
  const { error } = await supabase.from("projects").update({ name }).eq("id", projectId);
  if (error) throw error;
}

export async function deleteProject(projectId: string) {
  const { error } = await supabase.from("projects").delete().eq("id", projectId);
  if (error) throw error;
}

export async function deleteRepository(repositoryId: string) {
  const { error } = await supabase.from("repositories").delete().eq("id", repositoryId);
  if (error) throw error;
}
