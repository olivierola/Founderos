import { supabase } from "@/lib/supabase";
import type { CrmObject } from "./objectModel";

// Catalog of module classes that can be added to the CRM as live-synced objects.
// Keep slugs/icons in sync with crm_source_catalog (migration 0074).
export interface ObjectTemplate {
  slug: string;
  label: string;
  label_plural: string;
  icon: string;      // crmIcons name
  color: string;
  description: string;
}

export const OBJECT_TEMPLATES: ObjectTemplate[] = [
  { slug: "documents", label: "Document", label_plural: "Documents", icon: "FileText", color: "text-zinc-400", description: "Docs, spreadsheets & presentations from Création." },
  { slug: "discussions", label: "Discussion", label_plural: "Discussions", icon: "MessageSquare", color: "text-sky-500", description: "Project inbox channels." },
  { slug: "simulations", label: "Simulation", label_plural: "Simulations", icon: "FlaskConical", color: "text-purple-500", description: "Persona simulations." },
  { slug: "autonomous_agents", label: "Autonomous agent", label_plural: "Autonomous agents", icon: "Bot", color: "text-fuchsia-500", description: "Internal autonomous agents." },
  { slug: "public_agents", label: "Public agent", label_plural: "Public agents", icon: "Bot", color: "text-emerald-500", description: "RAG / public-facing agents." },
];

// Instantiate a template as a live-synced CRM object (+ backfill existing rows).
export async function addObjectFromTemplate(workspaceId: string, projectId: string, slug: string, userId: string | null): Promise<CrmObject | null> {
  const { error } = await supabase.rpc("crm_add_from_catalog", {
    p_workspace: workspaceId, p_project: projectId, p_slug: slug, p_user: userId,
  });
  if (error) throw new Error(error.message);
  const { data } = await supabase.from("crm_objects").select("*").eq("project_id", projectId).eq("slug", slug).maybeSingle();
  return (data as CrmObject) ?? null;
}
