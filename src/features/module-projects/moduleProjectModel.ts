import { supabase } from "@/lib/supabase";

export interface ModuleProject {
  id: string;
  workspace_id: string;
  project_id: string;
  module_slug: string;
  project_type: string;
  name: string;
  description: string | null;
  status: "planning" | "active" | "on_hold" | "completed" | "archived";
  color: string;
  icon: string;
  start_date: string | null;
  due_date: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const COLS = "id, workspace_id, project_id, module_slug, project_type, name, description, status, color, icon, start_date, due_date, metadata, created_by, created_at, updated_at";

export async function fetchModuleProjects(projectId: string, moduleSlug: string): Promise<ModuleProject[]> {
  const { data } = await supabase
    .from("module_projects").select(COLS)
    .eq("project_id", projectId).eq("module_slug", moduleSlug)
    .order("updated_at", { ascending: false });
  return (data ?? []) as ModuleProject[];
}

export async function fetchModuleProject(id: string): Promise<ModuleProject | null> {
  const { data } = await supabase.from("module_projects").select(COLS).eq("id", id).maybeSingle();
  return (data as ModuleProject) ?? null;
}

export interface CreateModuleProjectParams {
  workspace_id: string;
  project_id: string;
  module_slug: string;
  project_type: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  created_by?: string;
}

export async function createModuleProject(params: CreateModuleProjectParams): Promise<ModuleProject> {
  const { data, error } = await supabase.from("module_projects").insert(params).select(COLS).single();
  if (error) throw new Error(error.message);
  return data as ModuleProject;
}

export async function updateModuleProject(id: string, patch: Partial<ModuleProject>): Promise<void> {
  const { error } = await supabase
    .from("module_projects")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteModuleProject(id: string): Promise<void> {
  const { error } = await supabase.from("module_projects").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
