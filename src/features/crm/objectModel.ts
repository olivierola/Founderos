// CRM object system (Attio/Notion-style). Everything is an object with typed
// properties; records are rows whose values live in JSONB keyed by property key.
import { supabase } from "@/lib/supabase";

export type PropertyType =
  | "text" | "long_text" | "number" | "currency" | "percent" | "checkbox"
  | "select" | "multi_select" | "date" | "datetime" | "email" | "phone" | "url"
  | "relation" | "user" | "rating";

export interface SelectOption { value: string; label: string; color?: string }

export interface CrmObject {
  id: string;
  slug: string;
  label: string;
  label_plural: string | null;
  icon: string;
  color: string;
  is_system: boolean;
  source_table: string | null;
  title_property: string;
  position: number;
}

export interface CrmProperty {
  id: string;
  object_id: string;
  key: string;
  label: string;
  type: PropertyType;
  options: SelectOption[];
  relation_object_id: string | null;
  is_title: boolean;
  is_system: boolean;
  required: boolean;
  position: number;
  width: number | null;
}

export interface CrmRecord {
  id: string;
  object_id: string;
  source_id: string | null;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ViewConfig {
  filters?: { key: string; op: string; value: unknown }[];
  sorts?: { key: string; dir: "asc" | "desc" }[];
  hidden?: string[];
  column_order?: string[];
  group_by?: string;
}
export interface CrmView {
  id: string;
  object_id: string;
  name: string;
  kind: "table" | "kanban" | "gallery";
  config: ViewConfig;
  is_default: boolean;
  position: number;
}

export const PROPERTY_TYPE_META: Record<PropertyType, { label: string; icon: string }> = {
  text: { label: "Text", icon: "Type" },
  long_text: { label: "Long text", icon: "AlignLeft" },
  number: { label: "Number", icon: "Hash" },
  currency: { label: "Currency", icon: "DollarSign" },
  percent: { label: "Percent", icon: "Percent" },
  checkbox: { label: "Checkbox", icon: "CheckSquare" },
  select: { label: "Select", icon: "ChevronDownCircle" },
  multi_select: { label: "Multi-select", icon: "Tags" },
  date: { label: "Date", icon: "Calendar" },
  datetime: { label: "Date & time", icon: "Clock" },
  email: { label: "Email", icon: "Mail" },
  phone: { label: "Phone", icon: "Phone" },
  url: { label: "URL", icon: "Link" },
  relation: { label: "Relation", icon: "GitBranch" },
  user: { label: "User", icon: "User" },
  rating: { label: "Rating", icon: "Star" },
};

// ───────────────────────────────────────────────────────── data access
export async function ensureSeeded(workspaceId: string, projectId: string, userId: string | null) {
  // Idempotent server-side seed of the default system objects.
  await supabase.rpc("crm_seed_project", { p_workspace: workspaceId, p_project: projectId, p_user: userId });
}

export async function fetchObjects(projectId: string): Promise<CrmObject[]> {
  const { data } = await supabase.from("crm_objects").select("*").eq("project_id", projectId).order("position");
  return (data ?? []) as CrmObject[];
}

export async function fetchProperties(objectId: string): Promise<CrmProperty[]> {
  const { data } = await supabase.from("crm_properties").select("*").eq("object_id", objectId).order("position");
  return (data ?? []) as CrmProperty[];
}

export async function fetchRecords(objectId: string): Promise<CrmRecord[]> {
  const { data } = await supabase.from("crm_records").select("*").eq("object_id", objectId).order("created_at", { ascending: false });
  return (data ?? []) as CrmRecord[];
}

export async function fetchViews(objectId: string): Promise<CrmView[]> {
  const { data } = await supabase.from("crm_views").select("*").eq("object_id", objectId).order("position");
  return (data ?? []) as CrmView[];
}

export async function createRecord(workspaceId: string, projectId: string, objectId: string, data: Record<string, unknown>, userId: string | null) {
  const { data: row } = await supabase.from("crm_records")
    .insert({ workspace_id: workspaceId, project_id: projectId, object_id: objectId, data, created_by: userId })
    .select("*").single();
  return row as CrmRecord;
}

export async function updateRecordValue(recordId: string, key: string, value: unknown) {
  // Read-modify-write the JSONB cell.
  const { data: cur } = await supabase.from("crm_records").select("data").eq("id", recordId).single();
  const next = { ...((cur?.data as Record<string, unknown>) ?? {}), [key]: value };
  await supabase.from("crm_records").update({ data: next, updated_at: new Date().toISOString() }).eq("id", recordId);
}

export async function deleteRecords(ids: string[]) {
  if (ids.length) await supabase.from("crm_records").delete().in("id", ids);
}

export async function createProperty(workspaceId: string, projectId: string, objectId: string, p: {
  label: string; type: PropertyType; options?: SelectOption[]; relation_object_id?: string | null; position: number;
}) {
  const key = slugifyKey(p.label);
  const { data } = await supabase.from("crm_properties").insert({
    workspace_id: workspaceId, project_id: projectId, object_id: objectId,
    key, label: p.label, type: p.type, options: p.options ?? [],
    relation_object_id: p.relation_object_id ?? null, position: p.position,
  }).select("*").single();
  return data as CrmProperty;
}

export async function updateProperty(id: string, patch: Partial<CrmProperty>) {
  await supabase.from("crm_properties").update(patch).eq("id", id);
}

export async function deleteProperty(id: string) {
  await supabase.from("crm_properties").delete().eq("id", id);
}

export async function createObject(workspaceId: string, projectId: string, o: {
  label: string; label_plural: string; icon: string; color: string; position: number;
}, userId: string | null) {
  const slug = slugifyKey(o.label_plural || o.label);
  const { data: obj } = await supabase.from("crm_objects").insert({
    workspace_id: workspaceId, project_id: projectId, slug,
    label: o.label, label_plural: o.label_plural, icon: o.icon, color: o.color,
    is_system: false, title_property: "name", position: o.position, created_by: userId,
  }).select("*").single();
  if (obj) {
    // Every object gets a title "Name" property + a default table view.
    await supabase.from("crm_properties").insert({
      workspace_id: workspaceId, project_id: projectId, object_id: (obj as CrmObject).id,
      key: "name", label: "Name", type: "text", is_title: true, is_system: true, position: 0,
    });
    await supabase.from("crm_views").insert({
      workspace_id: workspaceId, project_id: projectId, object_id: (obj as CrmObject).id,
      name: `All ${o.label_plural || o.label}`, kind: "table", is_default: true, position: 0, created_by: userId,
    });
  }
  return obj as CrmObject;
}

export async function deleteObject(id: string) {
  await supabase.from("crm_objects").delete().eq("id", id);
}

export async function saveView(id: string, config: ViewConfig) {
  await supabase.from("crm_views").update({ config }).eq("id", id);
}

// Relations: set the related record ids for a relation property on a record.
export async function setRelations(workspaceId: string, projectId: string, propertyId: string, fromRecordId: string, toRecordIds: string[]) {
  await supabase.from("crm_record_links").delete().eq("property_id", propertyId).eq("from_record_id", fromRecordId);
  if (toRecordIds.length) {
    await supabase.from("crm_record_links").insert(
      toRecordIds.map((to) => ({ workspace_id: workspaceId, project_id: projectId, property_id: propertyId, from_record_id: fromRecordId, to_record_id: to })),
    );
  }
}

export async function fetchRelations(objectId: string): Promise<Record<string, Record<string, string[]>>> {
  // → { propertyId: { fromRecordId: [toRecordId,…] } } for all relation props of an object.
  const { data: props } = await supabase.from("crm_properties").select("id").eq("object_id", objectId).eq("type", "relation");
  const ids = (props ?? []).map((p) => (p as { id: string }).id);
  const out: Record<string, Record<string, string[]>> = {};
  if (!ids.length) return out;
  const { data: links } = await supabase.from("crm_record_links").select("property_id, from_record_id, to_record_id").in("property_id", ids);
  for (const l of (links ?? []) as { property_id: string; from_record_id: string; to_record_id: string }[]) {
    (out[l.property_id] ??= {});
    (out[l.property_id][l.from_record_id] ??= []).push(l.to_record_id);
  }
  return out;
}

function slugifyKey(s: string): string {
  const base = s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
  return `${base}_${Math.random().toString(36).slice(2, 6)}`;
}
