import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, ArrowLeft, Clock, CheckSquare, StickyNote, Zap, MessageSquare, Trash2,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { iconByName } from "./crmIcons";
import { Cell } from "./Cell";
import { RecordContent, hasContent } from "./RecordContent";
import {
  fetchObjectBySlug, fetchProperties, fetchRecord, fetchRecordRelations, fetchRelatedDisplays,
  updateRecordValue, deleteRecords,
  type CrmObject, type CrmProperty, type CrmRecord, type RelatedDisplay,
} from "./objectModel";
import { actionsForSlug } from "./objectActions";

// Full-screen Attio-style record view: left = grouped fields + clickable
// relations, center = tabs (Content / Timeline / Tasks / Notes). Route:
// crm/workspace/:objectSlug/:recordId. Relations navigate to the target record.
export function RecordViewPage() {
  const { workspaceSlug = "", projectSlug = "", objectSlug = "", recordId = "" } = useParams();
  const { projectId } = useCurrentContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const base = `/app/${workspaceSlug}/${projectSlug}/crm/workspace`;

  const objQ = useQuery({ queryKey: ["crm_obj_slug", projectId, objectSlug], enabled: !!projectId, queryFn: () => fetchObjectBySlug(projectId!, objectSlug) });
  const object = objQ.data ?? null;
  const propsQ = useQuery({ queryKey: ["crm_props", object?.id], enabled: !!object, queryFn: () => fetchProperties(object!.id) });
  const recQ = useQuery({ queryKey: ["crm_record", recordId], enabled: !!recordId, queryFn: () => fetchRecord(recordId) });
  const relQ = useQuery({ queryKey: ["crm_record_rels", object?.id, recordId], enabled: !!object, queryFn: () => fetchRecordRelations(object!.id, recordId) });
  const dispQ = useQuery({ queryKey: ["crm_rel_displays", object?.id], enabled: !!object, queryFn: () => fetchRelatedDisplays(object!.id) });
  // Map target record id → its object slug (for navigation on relation click).
  const slugQ = useQuery({
    queryKey: ["crm_relation_target_slugs", object?.id],
    enabled: !!object,
    queryFn: async () => {
      const props = await fetchProperties(object!.id);
      const map: Record<string, string> = {}; // propertyId → target object slug
      const { supabase } = await import("@/lib/supabase");
      for (const p of props.filter((x) => x.type === "relation" && x.relation_object_id)) {
        const { data } = await supabase.from("crm_objects").select("slug").eq("id", p.relation_object_id!).maybeSingle();
        if (data) map[p.id] = (data as { slug: string }).slug;
      }
      return map;
    },
  });

  const properties = propsQ.data ?? [];
  const record = recQ.data ?? null;
  const relations = relQ.data ?? {};
  const displays = dispQ.data ?? {};
  const targetSlugs = slugQ.data ?? {};

  const [tab, setTab] = useState<"content" | "timeline" | "tasks" | "notes">(hasContent(objectSlug) ? "content" : "timeline");

  const grouped = useMemo(() => {
    const fields = properties.filter((p) => p.type !== "relation");
    const rels = properties.filter((p) => p.type === "relation");
    return { fields, rels };
  }, [properties]);

  if (objQ.isLoading || recQ.isLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!object || !record) return <EmptyState icon={MessageSquare} title="Record not found" />;

  const Icon = iconByName(object.icon);
  const titleKey = properties.find((p) => p.is_title)?.key ?? "name";
  const title = String(record.data[titleKey] ?? "Untitled");

  async function setCell(key: string, v: unknown) {
    queryClient.setQueryData<CrmRecord | null>(["crm_record", recordId], (prev) => prev ? { ...prev, data: { ...prev.data, [key]: v } } : prev);
    await updateRecordValue(recordId, key, v);
  }

  const actions = actionsForSlug(objectSlug);
  const TABS = [
    ...(hasContent(objectSlug) ? [{ key: "content" as const, label: object.label, icon: Icon }] : []),
    { key: "timeline" as const, label: "Timeline", icon: Clock },
    { key: "tasks" as const, label: "Tasks", icon: CheckSquare },
    { key: "notes" as const, label: "Notes", icon: StickyNote },
  ];

  return (
    <div className="flex h-full w-full">
      {/* Left: fields + relations */}
      <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-r border-border bg-card/30">
        <div className="flex items-center gap-2 px-4 py-3">
          <button onClick={() => navigate(`${base}/${object.slug}`)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ArrowLeft className="h-4 w-4" /></button>
          <span className="text-xs text-muted-foreground">{object.label_plural ?? object.label}</span>
        </div>
        <div className="flex flex-col items-center gap-2 px-4 pb-4 text-center">
          <span className={cn("flex h-14 w-14 items-center justify-center rounded-full bg-muted text-2xl", object.color)}><Icon className="h-7 w-7" /></span>
          <div className="text-lg font-semibold">{title}</div>
        </div>

        {/* Fields */}
        <Group label="Fields">
          {grouped.fields.map((p) => (
            <Row key={p.id} label={p.label} icon={iconByName(typeMeta(p))}>
              <Cell property={p} record={record} value={record.data[p.key]} onChange={(v) => setCell(p.key, v)} />
            </Row>
          ))}
        </Group>

        {/* Relations — clickable, navigate to the related record */}
        {grouped.rels.length > 0 && (
          <Group label="Relations">
            {grouped.rels.map((p) => {
              const ids = relations[p.id] ?? [];
              const slug = targetSlugs[p.id];
              return (
                <Row key={p.id} label={p.label} icon={iconByName("GitBranch")}>
                  <div className="flex flex-wrap gap-1 py-1.5">
                    {ids.length === 0 ? <span className="text-xs text-muted-foreground/50">—</span>
                      : ids.map((id) => {
                          const d: RelatedDisplay | undefined = displays[id];
                          const RIcon = iconByName(d?.objectIcon);
                          return (
                            <button key={id} disabled={!slug}
                              onClick={() => slug && navigate(`${base}/${slug}/${id}`)}
                              className="flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-xs hover:border-primary/50">
                              <RIcon className={cn("h-3 w-3", d?.objectColor)} />
                              <span className="truncate">{d?.label ?? "…"}</span>
                            </button>
                          );
                        })}
                  </div>
                </Row>
              );
            })}
          </Group>
        )}

        {/* System */}
        <Group label="System">
          <Row label="Created" icon={Clock}><span className="px-3 text-sm text-muted-foreground">{new Date(record.created_at).toLocaleString()}</span></Row>
          <Row label="Updated" icon={Clock}><span className="px-3 text-sm text-muted-foreground">{new Date(record.updated_at).toLocaleString()}</span></Row>
        </Group>

        <div className="mt-auto p-3">
          <button onClick={async () => { if (confirm("Delete this record?")) { await deleteRecords([record.id]); navigate(`${base}/${object.slug}`); } }}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
        </div>
      </aside>

      {/* Center: tabs */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1 border-b border-border px-4">
          {TABS.map((t) => {
            const TI = t.icon;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={cn("flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm transition-colors",
                  tab === t.key ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
                <TI className="h-4 w-4" /> {t.label}
              </button>
            );
          })}
          {actions.length > 0 && (
            <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground"><Zap className="h-3 w-3" /> {actions.length} action{actions.length > 1 ? "s" : ""} in the panel</span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tab === "content" && <RecordContent object={object} record={record} />}
          {tab === "timeline" && (
            <div className="p-4">
              <div className="mb-3 text-[11px] uppercase tracking-wide text-muted-foreground">{new Date(record.created_at).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</div>
              <ul className="space-y-3 text-sm">
                <li className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted"><Clock className="h-3.5 w-3.5" /></span> Created <span className="ml-auto text-[11px] text-muted-foreground">{new Date(record.created_at).toLocaleString()}</span></li>
                {record.updated_at !== record.created_at && <li className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted"><Clock className="h-3.5 w-3.5" /></span> Updated <span className="ml-auto text-[11px] text-muted-foreground">{new Date(record.updated_at).toLocaleString()}</span></li>}
              </ul>
            </div>
          )}
          {tab === "tasks" && <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">No linked tasks.</div>}
          {tab === "notes" && <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">No notes yet.</div>}
        </div>
      </div>
    </div>
  );
}

function typeMeta(p: CrmProperty): string {
  const m: Record<string, string> = {
    text: "Type", long_text: "AlignLeft", number: "Hash", currency: "DollarSign", percent: "Percent",
    checkbox: "CheckSquare", select: "ChevronDownCircle", multi_select: "Tags", date: "Calendar",
    datetime: "Clock", email: "Mail", phone: "Phone", url: "Link", relation: "GitBranch", rating: "Star",
  };
  return m[p.type] ?? "Type";
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border px-2 py-2">
      <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}
function Row({ label, icon: Icon, children }: { label: string; icon: ReturnType<typeof iconByName>; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 hover:bg-muted/30">
      <span className="flex w-28 shrink-0 items-center gap-1.5 py-2 text-xs text-muted-foreground"><Icon className="h-3.5 w-3.5" /> {label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
