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
  const { data: obj, error } = await supabase.from("crm_objects").insert({
    workspace_id: workspaceId, project_id: projectId, slug,
    label: o.label, label_plural: o.label_plural, icon: o.icon, color: o.color,
    is_system: false, title_property: "name", position: o.position, created_by: userId,
  }).select("*").single();
  if (error) throw new Error(error.message);
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

export async function saveView(id: string, patch: Partial<Pick<CrmView, "config" | "name" | "kind">>) {
  await supabase.from("crm_views").update(patch).eq("id", id);
}

export async function createView(workspaceId: string, projectId: string, objectId: string, v: { name: string; kind: CrmView["kind"]; position: number }) {
  const { data } = await supabase.from("crm_views").insert({
    workspace_id: workspaceId, project_id: projectId, object_id: objectId,
    name: v.name, kind: v.kind, position: v.position, config: {},
  }).select("*").single();
  return data as CrmView;
}

export async function deleteView(id: string) {
  await supabase.from("crm_views").delete().eq("id", id);
}

// Apply a view's filters + sorts to a record list (client-side).
export function applyView(records: CrmRecord[], properties: CrmProperty[], config: ViewConfig): CrmRecord[] {
  const byKey = new Map(properties.map((p) => [p.key, p]));
  let out = records;
  for (const f of config.filters ?? []) {
    out = out.filter((r) => matchFilter(r.data[f.key], f.op, f.value, byKey.get(f.key)?.type));
  }
  for (const s of [...(config.sorts ?? [])].reverse()) {
    const type = byKey.get(s.key)?.type;
    out = [...out].sort((a, b) => cmp(a.data[s.key], b.data[s.key], type) * (s.dir === "desc" ? -1 : 1));
  }
  return out;
}

export const FILTER_OPS = ["is", "is_not", "contains", "is_empty", "is_not_empty", "gt", "lt"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

function matchFilter(v: unknown, op: string, target: unknown, type?: PropertyType): boolean {
  const s = (x: unknown) => String(x ?? "").toLowerCase();
  switch (op) {
    case "is_empty": return v == null || v === "" || (Array.isArray(v) && v.length === 0);
    case "is_not_empty": return !(v == null || v === "" || (Array.isArray(v) && v.length === 0));
    case "is": return Array.isArray(v) ? v.includes(target) : s(v) === s(target);
    case "is_not": return Array.isArray(v) ? !v.includes(target) : s(v) !== s(target);
    case "contains": return s(v).includes(s(target));
    case "gt": return Number(v) > Number(target);
    case "lt": return Number(v) < Number(target);
    default: return true;
  }
}
function cmp(a: unknown, b: unknown, type?: PropertyType): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1; if (b == null) return 1;
  if (type === "number" || type === "currency" || type === "percent" || type === "rating") return Number(a) - Number(b);
  if (type === "date" || type === "datetime") return new Date(String(a)).getTime() - new Date(String(b)).getTime();
  if (type === "checkbox") return (a ? 1 : 0) - (b ? 1 : 0);
  return String(a).localeCompare(String(b));
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

// Display info for a related record (icon + color come from its object).
export interface RelatedDisplay { id: string; label: string; objectIcon: string; objectColor: string }

// For each relation property of `objectId`, resolve the titles + object styling
// of every linked target record, keyed by target record id. One pass, no N+1.
export async function fetchRelatedDisplays(objectId: string): Promise<Record<string, RelatedDisplay>> {
  const out: Record<string, RelatedDisplay> = {};
  // Which target objects do this object's relation props point at?
  const { data: props } = await supabase
    .from("crm_properties").select("relation_object_id")
    .eq("object_id", objectId).eq("type", "relation").not("relation_object_id", "is", null);
  const targetObjIds = [...new Set((props ?? []).map((p) => (p as { relation_object_id: string }).relation_object_id))];
  if (!targetObjIds.length) return out;

  // Target objects (icon/color/title_property).
  const { data: objs } = await supabase.from("crm_objects").select("id, icon, color, title_property").in("id", targetObjIds);
  const objById = new Map((objs ?? []).map((o) => [(o as CrmObject).id, o as Pick<CrmObject, "id" | "icon" | "color" | "title_property">]));

  // All records of those target objects → build display chips.
  const { data: recs } = await supabase.from("crm_records").select("id, object_id, data").in("object_id", targetObjIds);
  for (const r of (recs ?? []) as { id: string; object_id: string; data: Record<string, unknown> }[]) {
    const o = objById.get(r.object_id);
    const titleKey = o?.title_property ?? "name";
    out[r.id] = {
      id: r.id,
      label: String(r.data[titleKey] ?? r.data.name ?? "Untitled"),
      objectIcon: o?.icon ?? "Boxes",
      objectColor: o?.color ?? "text-muted-foreground",
    };
  }
  return out;
}

function slugifyKey(s: string): string {
  const base = s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
  return `${base}_${Math.random().toString(36).slice(2, 6)}`;
}
