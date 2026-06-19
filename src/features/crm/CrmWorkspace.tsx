import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Plus, Search, Settings2, Trash2, X, Database, Maximize2, Copy, Check,
  Clock, CheckSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { iconByName, OBJECT_ICON_CHOICES, OBJECT_COLOR_CHOICES } from "./crmIcons";
import { Cell } from "./Cell";
import {
  ensureSeeded, fetchObjects, fetchProperties, fetchRecords, fetchRelations, fetchViews,
  fetchRelatedDisplays,
  createRecord, updateRecordValue, deleteRecords, createProperty, deleteProperty,
  updateProperty, createObject, deleteObject, setRelations,
  createView, deleteView, saveView, applyView,
  PROPERTY_TYPE_META,
  type CrmObject, type CrmProperty, type CrmRecord, type CrmView, type ViewConfig, type PropertyType, type SelectOption, type RelatedDisplay,
} from "./objectModel";
import { ViewBar } from "./ViewBar";
import { Kanban } from "./Kanban";
import { OBJECT_TEMPLATES, addObjectFromTemplate } from "./objectTemplates";

// The object list lives in the secondary sidebar (CrmObjectsItem) — this page
// renders only the table for the object in the route (crm/workspace/:objectSlug).
// `?new=1` opens the New-object dialog (triggered from the sidebar link).
export function CrmWorkspacePage() {
  const { workspaceSlug, projectSlug, objectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [seeding, setSeeding] = useState(true);
  const newObjOpen = searchParams.get("new") === "1";

  useEffect(() => {
    if (!workspaceId || !projectId) return;
    let cancelled = false;
    (async () => {
      setSeeding(true);
      await ensureSeeded(workspaceId, projectId, user?.id ?? null);
      if (!cancelled) { queryClient.invalidateQueries({ queryKey: ["crm_objects", projectId] }); setSeeding(false); }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, projectId, user?.id, queryClient]);

  const { data: objects } = useQuery({
    queryKey: ["crm_objects", projectId],
    enabled: !!projectId && !seeding,
    queryFn: () => fetchObjects(projectId!),
  });

  const active = objects?.find((o) => o.slug === objectSlug) ?? objects?.[0] ?? null;

  // No object in the URL → land on the first object. Preserve ?new=1 so the
  // "New object" action from the sidebar still opens the dialog.
  useEffect(() => {
    if (!objectSlug && active && objects?.length) {
      const suffix = newObjOpen ? "?new=1" : "";
      navigate(`/app/${workspaceSlug}/${projectSlug}/crm/workspace/${active.slug}${suffix}`, { replace: true });
    }
  }, [objectSlug, active, objects, navigate, workspaceSlug, projectSlug, newObjOpen]);

  return (
    <div className="-mx-4 -my-4 h-[calc(100vh-3.5rem)] sm:-mx-6 sm:-my-6 lg:-mx-12 xl:-mx-20">
      {seeding || !objects ? <Centered><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></Centered>
        : !active ? <Centered><EmptyState icon={Database} title="No objects" description="Create your first object from the sidebar." /></Centered>
        : <ObjectTable key={active.id} object={active} objects={objects} />}

      {newObjOpen && (
        <NewObjectDialog
          objects={objects ?? []}
          onClose={() => { searchParams.delete("new"); setSearchParams(searchParams, { replace: true }); }}
          onCreated={(slug) => {
            queryClient.invalidateQueries({ queryKey: ["crm_objects", projectId] });
            navigate(`/app/${workspaceSlug}/${projectSlug}/crm/workspace/${slug}`);
          }}
        />
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────── records table
function ObjectTable({ object, objects }: { object: CrmObject; objects: CrmObject[] }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addColOpen, setAddColOpen] = useState(false);
  const [editProp, setEditProp] = useState<CrmProperty | null>(null);
  const [relationFor, setRelationFor] = useState<{ property: CrmProperty; record: CrmRecord } | null>(null);
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [config, setConfig] = useState<ViewConfig>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const propsQ = useQuery({ queryKey: ["crm_props", object.id], queryFn: () => fetchProperties(object.id) });
  const recsQ = useQuery({ queryKey: ["crm_records", object.id], queryFn: () => fetchRecords(object.id) });
  const relQ = useQuery({ queryKey: ["crm_relations", object.id], queryFn: () => fetchRelations(object.id) });
  const relDispQ = useQuery({ queryKey: ["crm_rel_displays", object.id], queryFn: () => fetchRelatedDisplays(object.id) });
  const viewsQ = useQuery({ queryKey: ["crm_views", object.id], queryFn: () => fetchViews(object.id) });

  const properties = propsQ.data ?? [];
  const records = recsQ.data ?? [];
  const relations = relQ.data ?? {};
  const views = viewsQ.data ?? [];
  const activeView = views.find((v) => v.id === activeViewId) ?? views[0] ?? null;

  // Select the default view + load its config when views load / object changes.
  useEffect(() => {
    if (views.length && (!activeViewId || !views.some((v) => v.id === activeViewId))) {
      const v = views.find((x) => x.is_default) ?? views[0];
      setActiveViewId(v.id); setConfig(v.config ?? {});
    }
  }, [views, activeViewId]);

  // Persist view config (debounced).
  function updateConfig(c: ViewConfig) {
    setConfig(c);
    if (!activeView) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveView(activeView.id, { config: c }); }, 500);
  }
  function selectView(id: string) {
    setActiveViewId(id);
    setConfig(views.find((v) => v.id === id)?.config ?? {});
  }
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const filtered = useMemo(() => {
    let list = applyView(records, properties, config);
    const s = search.trim().toLowerCase();
    if (s) list = list.filter((r) => Object.values(r.data).some((v) => String(v ?? "").toLowerCase().includes(s)));
    return list;
  }, [records, properties, config, search]);

  function invRecords() { queryClient.invalidateQueries({ queryKey: ["crm_records", object.id] }); }
  function invProps() { queryClient.invalidateQueries({ queryKey: ["crm_props", object.id] }); }

  async function addRow() {
    if (!workspaceId || !projectId) return;
    await createRecord(workspaceId, projectId, object.id, {}, user?.id ?? null);
    invRecords();
  }
  async function setCell(rec: CrmRecord, key: string, value: unknown) {
    // optimistic
    queryClient.setQueryData<CrmRecord[]>(["crm_records", object.id], (prev) =>
      (prev ?? []).map((r) => (r.id === rec.id ? { ...r, data: { ...r.data, [key]: value } } : r)));
    await updateRecordValue(rec.id, key, value);
  }
  async function removeSelected() {
    await deleteRecords([...selected]); setSelected(new Set()); invRecords();
  }
  async function addProperty(p: { label: string; type: PropertyType; options?: SelectOption[]; relation_object_id?: string | null }) {
    if (!workspaceId || !projectId) return;
    await createProperty(workspaceId, projectId, object.id, { ...p, position: properties.length });
    invProps(); setAddColOpen(false);
  }
  function invViews() { queryClient.invalidateQueries({ queryKey: ["crm_views", object.id] }); }
  async function addView(kind: CrmView["kind"]) {
    if (!workspaceId || !projectId) return;
    const v = await createView(workspaceId, projectId, object.id, { name: kind === "kanban" ? "Board" : "Table", kind, position: views.length });
    invViews(); if (v) { setActiveViewId(v.id); setConfig({}); }
  }
  async function removeView(id: string) { await deleteView(id); invViews(); if (activeViewId === id) setActiveViewId(null); }

  const relDisplays = relDispQ.data ?? {};
  // Rich chips for a relation cell: the linked records with their object icon/color.
  const relDisplaysFor = useMemo(() => {
    return (property: CrmProperty, rec: CrmRecord): RelatedDisplay[] => {
      const ids = relations[property.id]?.[rec.id] ?? [];
      return ids.map((id) => relDisplays[id] ?? { id, label: "…", objectIcon: "Boxes", objectColor: "text-muted-foreground" });
    };
  }, [relations, relDisplays]);

  if (propsQ.isLoading || recsQ.isLoading) return <Centered><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></Centered>;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        {(() => { const Icon = iconByName(object.icon); return <Icon className={cn("h-4 w-4", object.color)} />; })()}
        <span className="text-sm font-semibold">All {object.label_plural ?? object.label}</span>
        <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">{records.length}</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className="h-8 w-48 pl-7" />
          </div>
          {!object.is_system && (
            <Button size="sm" variant="ghost" className="h-8 text-muted-foreground hover:text-destructive"
              onClick={async () => { if (confirm(`Delete the "${object.label}" object and all its records?`)) { await deleteObject(object.id); queryClient.invalidateQueries({ queryKey: ["crm_objects", projectId] }); } }}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* View bar (tabs + filter/sort/group) */}
      <ViewBar
        views={views} activeViewId={activeView?.id ?? null} onSelectView={selectView}
        onAddView={addView} onDeleteView={removeView}
        properties={properties} config={config} onConfigChange={updateConfig}
      />

      {/* Selection bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-1.5 text-sm">
          <span>{selected.size} selected</span>
          <Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={removeSelected}><Trash2 className="mr-1 h-3.5 w-3.5" /> Delete</Button>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* Kanban view */}
      {activeView?.kind === "kanban" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <Kanban
            object={object} properties={properties} records={filtered} groupByKey={config.group_by}
            onMove={(rec, value) => setCell(rec, config.group_by!, value)}
            onOpen={(rec) => setOpenRecordId(rec.id)}
          />
        </div>
      ) : (
      /* Table */
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border">
              <th className="w-9 border-r border-border px-2 py-2">
                <input type="checkbox" className="accent-primary" checked={selected.size > 0 && selected.size === filtered.length}
                  onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((r) => r.id)) : new Set())} />
              </th>
              {properties.map((p) => (
                <th key={p.id} className="group/h border-r border-border px-3 py-2 text-left font-medium" style={{ minWidth: p.width ?? 180 }}>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="truncate">{p.label}</span>
                    {!p.is_title && (
                      <button onClick={() => setEditProp(p)} className="opacity-0 group-hover/h:opacity-100"><Settings2 className="h-3 w-3" /></button>
                    )}
                  </div>
                </th>
              ))}
              <th className="px-2 py-2">
                <button onClick={() => setAddColOpen(true)} className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted"><Plus className="h-4 w-4" /></button>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((rec) => (
              <tr key={rec.id} className="group/r border-b border-border hover:bg-muted/20">
                <td className="border-r border-border px-2 text-center">
                  <input type="checkbox" className="accent-primary" checked={selected.has(rec.id)}
                    onChange={(e) => setSelected((s) => { const n = new Set(s); e.target.checked ? n.add(rec.id) : n.delete(rec.id); return n; })} />
                </td>
                {properties.map((p) => (
                  <td key={p.id} className="h-9 border-r border-border p-0" style={{ minWidth: p.width ?? 180 }}>
                    {p.is_title ? (
                      <div className="relative flex h-full items-center">
                        <div className="min-w-0 flex-1">
                          <Cell property={p} record={rec} value={rec.data[p.key]} onChange={(v) => setCell(rec, p.key, v)} />
                        </div>
                        <button onClick={() => setOpenRecordId(rec.id)}
                          className="mr-1 hidden shrink-0 items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground group-hover/r:flex">
                          <Maximize2 className="h-3 w-3" /> Open
                        </button>
                      </div>
                    ) : (
                      <Cell
                        property={p} record={rec} value={rec.data[p.key]}
                        onChange={(v) => setCell(rec, p.key, v)}
                        relationChips={p.type === "relation" ? relDisplaysFor(p, rec) : undefined}
                        onEditRelation={p.type === "relation" ? () => setRelationFor({ property: p, record: rec }) : undefined}
                      />
                    )}
                  </td>
                ))}
                <td />
              </tr>
            ))}
            {/* Add row */}
            <tr className="border-b border-border">
              <td />
              <td colSpan={properties.length + 1}>
                <button onClick={addRow} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/30">
                  <Plus className="h-3.5 w-3.5" /> Add {object.label}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        {records.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">No {object.label_plural?.toLowerCase() ?? "records"} yet — add one above.</div>
        )}
      </div>
      )}

      {addColOpen && <AddPropertyDialog objects={objects} onClose={() => setAddColOpen(false)} onAdd={addProperty} />}
      {editProp && <EditPropertyDialog property={editProp} onClose={() => setEditProp(null)} onSaved={() => { invProps(); setEditProp(null); }} onDeleted={() => { invProps(); setEditProp(null); }} />}
      {relationFor && (
        <RelationPicker
          property={relationFor.property} record={relationFor.record} object={object}
          current={relations[relationFor.property.id]?.[relationFor.record.id] ?? []}
          onClose={() => setRelationFor(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ["crm_relations", object.id] });
            queryClient.invalidateQueries({ queryKey: ["crm_rel_displays", object.id] });
            setRelationFor(null);
          }}
        />
      )}

      {openRecordId && (() => {
        const rec = records.find((r) => r.id === openRecordId);
        if (!rec) return null;
        return (
          <RecordPanel
            object={object} record={rec} properties={properties} relations={relations}
            relationChips={relDisplaysFor}
            onClose={() => setOpenRecordId(null)}
            onChange={(key, v) => setCell(rec, key, v)}
            onEditRelation={(p) => setRelationFor({ property: p, record: rec })}
            onDelete={async () => { await deleteRecords([rec.id]); setOpenRecordId(null); invRecords(); }}
          />
        );
      })()}
    </div>
  );
}

// ───────────────────────────────────────────────────────── record detail panel
function RecordPanel({ object, record, properties, relations, relationChips, onClose, onChange, onEditRelation, onDelete }: {
  object: CrmObject;
  record: CrmRecord;
  properties: CrmProperty[];
  relations: Record<string, Record<string, string[]>>;
  relationChips: (p: CrmProperty, r: CrmRecord) => RelatedDisplay[];
  onClose: () => void;
  onChange: (key: string, v: unknown) => void;
  onEditRelation: (p: CrmProperty) => void;
  onDelete: () => void;
}) {
  const Icon = iconByName(object.icon);
  const titleProp = properties.find((p) => p.is_title);
  const title = titleProp ? String(record.data[titleProp.key] ?? "Untitled") : "Untitled";
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"properties" | "timeline" | "tasks">("properties");

  const TABS = [
    { key: "properties" as const, label: "Properties", icon: Settings2 },
    { key: "timeline" as const, label: "Timeline", icon: Clock },
    { key: "tasks" as const, label: "Tasks", icon: CheckSquare },
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      {/* Attio-style dark record panel */}
      <aside className="flex h-full w-full max-w-md flex-col border-l border-border bg-background shadow-2xl dark:bg-[#0a0a0b]" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3">
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-4 w-4" /></button>
          <span className={cn("flex h-7 w-7 items-center justify-center rounded-md bg-muted", object.color)}><Icon className="h-4 w-4" /></span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{title}</div>
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground">Created {timeAgo(record.created_at)}</span>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border px-3">
          {TABS.map((t) => {
            const TI = t.icon;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={cn("flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-sm transition-colors",
                  tab === t.key ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
                <TI className="h-3.5 w-3.5" /> {t.label}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "properties" && (
            <div className="p-2">
              {properties.map((p) => (
                <div key={p.id} className="flex items-start gap-2 rounded-md px-2 py-1 hover:bg-muted/30">
                  <div className="mt-2 w-28 shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{p.label}</div>
                  <div className="min-h-[34px] min-w-0 flex-1 rounded border border-transparent hover:border-border">
                    <Cell
                      property={p} record={record} value={record.data[p.key]}
                      onChange={(v) => onChange(p.key, v)}
                      relationChips={p.type === "relation" ? relationChips(p, record) : undefined}
                      onEditRelation={p.type === "relation" ? () => onEditRelation(p) : undefined}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
          {tab === "timeline" && (
            <div className="p-4">
              <div className="mb-3 text-[11px] uppercase tracking-wide text-muted-foreground">{new Date(record.created_at).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</div>
              <ul className="space-y-3 text-sm">
                <TimelineRow label="Created" when={record.created_at} />
                {record.updated_at !== record.created_at && <TimelineRow label="Updated" when={record.updated_at} />}
              </ul>
            </div>
          )}
          {tab === "tasks" && (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              No linked tasks yet.
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex items-center gap-2 border-t border-border px-3 py-2.5">
          <Button size="sm" variant="ghost" className="h-8 text-destructive" onClick={() => { if (confirm("Delete this record?")) onDelete(); }}>
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-8" onClick={() => { navigator.clipboard.writeText(record.id); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? <Check className="mr-1 h-3.5 w-3.5 text-emerald-500" /> : <Copy className="mr-1 h-3.5 w-3.5" />} Copy ID
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function TimelineRow({ label, when }: { label: string; when: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground"><Clock className="h-3.5 w-3.5" /></span>
      <span className="font-medium">{label}</span>
      <span className="ml-auto text-[11px] text-muted-foreground">{timeAgo(when)}</span>
    </li>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m > 1 ? "s" : ""} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `about ${h} hour${h > 1 ? "s" : ""} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}

// A module-level cache of record id → title label, populated by relation pickers
// so relation cells can show names without N queries.
const relationCache = new Map<string, string>();

// ───────────────────────────────────────────────────────── dialogs
function NewObjectDialog({ objects, onClose, onCreated }: { objects: CrmObject[]; onClose: () => void; onCreated: (slug: string) => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const [mode, setMode] = useState<"catalog" | "blank">("catalog");
  const [label, setLabel] = useState("");
  const [plural, setPlural] = useState("");
  const [icon, setIcon] = useState("Boxes");
  const [color, setColor] = useState(OBJECT_COLOR_CHOICES[0]);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const existingSlugs = new Set(objects.map((o) => o.slug));
  const available = OBJECT_TEMPLATES.filter((t) => !existingSlugs.has(t.slug));

  async function addTemplate(slug: string) {
    if (!workspaceId || !projectId) return;
    setSaving(slug); setError(null);
    try {
      const obj = await addObjectFromTemplate(workspaceId, projectId, slug, user?.id ?? null);
      if (obj) { onCreated(obj.slug); onClose(); } else setError("Could not add this object.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not add this object."); }
    finally { setSaving(null); }
  }

  async function submitBlank() {
    if (!label.trim() || !workspaceId || !projectId) return;
    setSaving("blank"); setError(null);
    try {
      const obj = await createObject(workspaceId, projectId, { label: label.trim(), label_plural: plural.trim() || label.trim() + "s", icon, color, position: objects.length }, user?.id ?? null);
      if (obj) { onCreated(obj.slug); onClose(); } else setError("Could not create the object.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create the object."); }
    finally { setSaving(null); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{mode === "catalog" ? "Add object" : "New custom object"}</DialogTitle></DialogHeader>

        {mode === "catalog" ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Add a module as a live object — its records mirror the real data and stay in sync. Or create a blank custom object.</p>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {available.map((t) => { const I = iconByName(t.icon); return (
                <button key={t.slug} disabled={!!saving} onClick={() => addTemplate(t.slug)}
                  className="flex items-start gap-2.5 rounded-lg border border-border p-3 text-left hover:border-primary/50 hover:bg-muted/30 disabled:opacity-50">
                  <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted", t.color)}>
                    {saving === t.slug ? <Loader2 className="h-4 w-4 animate-spin" /> : <I className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{t.label_plural}</span>
                    <span className="block text-[11px] text-muted-foreground">{t.description}</span>
                  </span>
                </button>
              ); })}
              {available.length === 0 && <p className="col-span-2 py-2 text-center text-xs text-muted-foreground">All module objects are already added.</p>}
            </div>
            <button onClick={() => setMode("blank")} className="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-border p-3 text-left text-sm hover:border-primary/50 hover:bg-muted/30">
              <span className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground"><Plus className="h-4 w-4" /></span>
              <span><span className="block font-medium">Blank custom object</span><span className="block text-[11px] text-muted-foreground">Define your own object + properties.</span></span>
            </button>
            {error && <p className="rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{error}</p>}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <L label="Singular name"><Input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus placeholder="Invoice" /></L>
              <L label="Plural name"><Input value={plural} onChange={(e) => setPlural(e.target.value)} placeholder="Invoices" /></L>
            </div>
            <L label="Icon">
              <div className="flex flex-wrap gap-1">
                {OBJECT_ICON_CHOICES.map((nm) => { const I = iconByName(nm); return (
                  <button key={nm} onClick={() => setIcon(nm)} className={cn("flex h-8 w-8 items-center justify-center rounded-md border", icon === nm ? "border-primary bg-primary/10" : "border-border")}><I className={cn("h-4 w-4", color)} /></button>
                ); })}
              </div>
            </L>
            <L label="Color">
              <div className="flex flex-wrap gap-1.5">
                {OBJECT_COLOR_CHOICES.map((c) => <button key={c} onClick={() => setColor(c)} className={cn("h-6 w-6 rounded-full", c.replace("text-", "bg-"), color === c && "ring-2 ring-primary ring-offset-1 ring-offset-background")} />)}
              </div>
            </L>
            {error && <p className="rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{error}</p>}
            <div className="flex justify-between gap-2 pt-2">
              <Button variant="ghost" onClick={() => setMode("catalog")}>← Back</Button>
              <Button onClick={submitBlank} disabled={!!saving || !label.trim()}>{saving === "blank" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Create</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddPropertyDialog({ objects, onClose, onAdd }: { objects: CrmObject[]; onClose: () => void; onAdd: (p: { label: string; type: PropertyType; options?: SelectOption[]; relation_object_id?: string | null }) => void }) {
  const [label, setLabel] = useState("");
  const [type, setType] = useState<PropertyType>("text");
  const [relObj, setRelObj] = useState<string>("");
  const [options, setOptions] = useState<SelectOption[]>([]);
  const [optInput, setOptInput] = useState("");
  const needsOptions = type === "select" || type === "multi_select";
  const needsRelation = type === "relation";

  function addOption() {
    const v = optInput.trim(); if (!v) return;
    setOptions((o) => [...o, { value: v.toLowerCase().replace(/\s+/g, "_"), label: v, color: PALETTE[o.length % PALETTE.length] }]);
    setOptInput("");
  }
  function submit() {
    if (!label.trim()) return;
    onAdd({ label: label.trim(), type, options: needsOptions ? options : undefined, relation_object_id: needsRelation ? (relObj || null) : undefined });
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add property</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <L label="Name"><Input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus placeholder="Amount, Status…" /></L>
          <L label="Type">
            <select value={type} onChange={(e) => setType(e.target.value as PropertyType)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {(Object.keys(PROPERTY_TYPE_META) as PropertyType[]).map((t) => <option key={t} value={t}>{PROPERTY_TYPE_META[t].label}</option>)}
            </select>
          </L>
          {needsRelation && (
            <L label="Related object">
              <select value={relObj} onChange={(e) => setRelObj(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                <option value="">Select…</option>
                {objects.map((o) => <option key={o.id} value={o.id}>{o.label_plural ?? o.label}</option>)}
              </select>
            </L>
          )}
          {needsOptions && (
            <L label="Options">
              <div className="mb-1 flex flex-wrap gap-1">
                {options.map((o, i) => (
                  <span key={i} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs" style={{ background: (o.color || "#64748b") + "22", color: o.color }}>
                    {o.label}<button onClick={() => setOptions((p) => p.filter((_, j) => j !== i))}><X className="h-3 w-3" /></button>
                  </span>
                ))}
              </div>
              <div className="flex gap-1"><Input value={optInput} onChange={(e) => setOptInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addOption())} placeholder="Add option…" className="h-8" /><Button size="sm" variant="outline" onClick={addOption}><Plus className="h-3.5 w-3.5" /></Button></div>
            </L>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={submit} disabled={!label.trim() || (needsRelation && !relObj)}>Add property</Button></div>
      </DialogContent>
    </Dialog>
  );
}

function EditPropertyDialog({ property, onClose, onSaved, onDeleted }: { property: CrmProperty; onClose: () => void; onSaved: () => void; onDeleted: () => void }) {
  const [label, setLabel] = useState(property.label);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Edit property</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <L label="Name"><Input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus /></L>
          <p className="text-[11px] text-muted-foreground">Type: {PROPERTY_TYPE_META[property.type].label}</p>
        </div>
        <div className="flex items-center justify-between pt-2">
          {!property.is_system ? (
            <Button variant="ghost" className="text-destructive" onClick={async () => { await deleteProperty(property.id); onDeleted(); }}><Trash2 className="mr-1 h-3.5 w-3.5" /> Delete</Button>
          ) : <span />}
          <div className="flex gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={async () => { await updateProperty(property.id, { label }); onSaved(); }}>Save</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RelationPicker({ property, record, object, current, onClose, onSaved }: {
  property: CrmProperty; record: CrmRecord; object: CrmObject; current: string[]; onClose: () => void; onSaved: () => void;
}) {
  const { workspaceId, projectId } = useCurrentContext();
  const [selected, setSelected] = useState<Set<string>>(new Set(current));
  const [search, setSearch] = useState("");
  const relObjId = property.relation_object_id;

  const { data: targets } = useQuery({
    queryKey: ["crm_relation_targets", relObjId],
    enabled: !!relObjId,
    queryFn: async () => {
      const [recs, props] = await Promise.all([fetchRecords(relObjId!), fetchProperties(relObjId!)]);
      const titleKey = props.find((p) => p.is_title)?.key ?? "name";
      const list = recs.map((r) => ({ id: r.id, label: String(r.data[titleKey] ?? "Untitled") }));
      list.forEach((x) => relationCache.set(x.id, x.label));
      return list;
    },
  });

  async function save() {
    if (!workspaceId || !projectId) return;
    await setRelations(workspaceId, projectId, property.id, record.id, [...selected]);
    onSaved();
  }
  const filtered = (targets ?? []).filter((t) => t.label.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Link {property.label}</DialogTitle></DialogHeader>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className="h-8" autoFocus />
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {(targets == null) ? <div className="flex h-20 items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
            : filtered.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No records.</p>
            : filtered.map((t) => (
              <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/40">
                <input type="checkbox" className="accent-primary" checked={selected.has(t.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); e.target.checked ? n.add(t.id) : n.delete(t.id); return n; })} />
                {t.label}
              </label>
            ))}
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save}>Save</Button></div>
      </DialogContent>
    </Dialog>
  );
}

const PALETTE = ["#3b82f6", "#a855f7", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#64748b"];

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>{children}</div>;
}
function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center">{children}</div>;
}
