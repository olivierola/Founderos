import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Plus,
  Loader2,
  Trash2,
  Pencil,
  X,
  Star,
  Send,
  Tag,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { ExportMenu } from "@/components/ExportMenu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import {
  CATEGORY_META,
  useEventDefinitions,
  type BreakdownResult,
  type EventCategory,
  type EventDefinition,
  type PropertySpec,
  type SummaryResult,
} from "./analytics";

interface RawEvent {
  id: string;
  event_name: string;
  user_email: string | null;
  customer_external_id: string | null;
  properties: Record<string, unknown>;
  occurred_at: string;
}

const CATEGORIES = Object.keys(CATEGORY_META) as EventCategory[];

const BLANK: Omit<EventDefinition, "id" | "workspace_id" | "project_id" | "created_at" | "updated_at"> = {
  event_name: "",
  display_name: "",
  description: "",
  category: "product",
  is_key_action: false,
  property_schema: [],
};

export function EventsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const defsQuery = useEventDefinitions();
  const defs = defsQuery.data ?? [];

  const [editing, setEditing] = useState<Partial<EventDefinition> | null>(null);
  const [saving, setSaving] = useState(false);

  // Headline KPIs + per-event volume from the engine.
  const summary = useQuery({
    queryKey: ["analytics_summary", projectId],
    enabled: !!workspaceId && !!projectId,
    queryFn: () =>
      callEdge<SummaryResult>("analytics-query", {
        workspace_id: workspaceId,
        project_id: projectId,
        kind: "summary",
      }),
  });

  const breakdown = useQuery({
    queryKey: ["analytics_breakdown", projectId],
    enabled: !!workspaceId && !!projectId,
    queryFn: () =>
      callEdge<BreakdownResult>("analytics-query", {
        workspace_id: workspaceId,
        project_id: projectId,
        kind: "breakdown",
        limit: 100,
      }),
  });

  // Live tail of recent raw events.
  const recent = useQuery({
    queryKey: ["recent_product_events", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("product_events")
        .select("*")
        .eq("project_id", projectId!)
        .order("occurred_at", { ascending: false })
        .limit(50);
      return (data ?? []) as RawEvent[];
    },
  });

  const volumeByName = useMemo(() => {
    const m = new Map<string, { events: number; users: number; last_seen: string }>();
    (breakdown.data?.events ?? []).forEach((e) =>
      m.set(e.event_name, { events: e.events, users: e.users, last_seen: e.last_seen }),
    );
    return m;
  }, [breakdown.data]);

  // Definitions joined with observed volume; also surface "undeclared" events
  // (seen in the stream but never catalogued) so they can be promoted.
  const catalog = useMemo(() => {
    const declared = new Set(defs.map((d) => d.event_name));
    const undeclared = (breakdown.data?.events ?? [])
      .filter((e) => !declared.has(e.event_name))
      .map((e) => ({ event_name: e.event_name, undeclared: true as const }));
    return { declared: defs, undeclared };
  }, [defs, breakdown.data]);

  async function save() {
    if (!editing || !workspaceId || !projectId || !editing.event_name?.trim()) return;
    setSaving(true);
    try {
      const payload = {
        workspace_id: workspaceId,
        project_id: projectId,
        event_name: editing.event_name.trim(),
        display_name: editing.display_name?.trim() || null,
        description: editing.description?.trim() || null,
        category: editing.category ?? "product",
        is_key_action: !!editing.is_key_action,
        property_schema: editing.property_schema ?? [],
        updated_at: new Date().toISOString(),
      };
      if (editing.id) {
        await supabase.from("event_definitions").update(payload).eq("id", editing.id);
      } else {
        await supabase.from("event_definitions").upsert(payload, { onConflict: "project_id,event_name" });
      }
      await queryClient.invalidateQueries({ queryKey: ["event_definitions", projectId] });
      setEditing(null);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    await supabase.from("event_definitions").delete().eq("id", id);
    await queryClient.invalidateQueries({ queryKey: ["event_definitions", projectId] });
  }

  const s = summary.data;

  return (
    <div>
      <PageHeader
        title="Events"
        description="Define your event taxonomy, track custom events and watch them flow in live. The catalog drives funnels, cohorts and activation metrics."
        actions={
          <div className="flex items-center gap-2">
            <ExportMenu
              rows={(breakdown.data?.events ?? []).map((e) => ({ event: e.event_name, events: e.events, users: e.users }))}
              filename="events"
            />
            <Button size="sm" onClick={() => setEditing({ ...BLANK })}>
              <Plus className="h-4 w-4" /> New event
            </Button>
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Events tracked" value={s ? s.total_events.toLocaleString() : "—"} icon={Activity} />
        <MetricCard label="Distinct events" value={s ? String(s.distinct_events) : "—"} icon={Tag} />
        <MetricCard label="Active users (7d)" value={s ? s.active_7d.toLocaleString() : "—"} hint={s ? `${s.active_30d} in 30d` : ""} />
        <MetricCard label="Active today" value={s ? s.active_1d.toLocaleString() : "—"} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* ── Catalog ── */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Event catalog</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {defsQuery.isLoading ? (
              <div className="p-6"><EmptyState icon={Loader2} title="Loading…" /></div>
            ) : catalog.declared.length === 0 && catalog.undeclared.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={Tag}
                  title="No events yet"
                  description="Define your first event, or emit a test event below to populate the stream."
                  action={<Button onClick={() => setEditing({ ...BLANK })}><Plus className="h-4 w-4" /> New event</Button>}
                />
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Event</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3 text-right">Events</th>
                    <th className="px-4 py-3 text-right">Users</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {catalog.declared.map((d) => {
                    const vol = volumeByName.get(d.event_name);
                    const meta = CATEGORY_META[d.category];
                    return (
                      <tr key={d.id} className="group">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {d.is_key_action && <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />}
                            <span className="font-mono text-xs">{d.event_name}</span>
                          </div>
                          {d.display_name && <div className="text-xs text-muted-foreground">{d.display_name}</div>}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className={cn("text-[10px]", meta.tone)}>{meta.label}</Badge>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{vol ? vol.events.toLocaleString() : "0"}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{vol ? vol.users.toLocaleString() : "0"}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                            <Button size="sm" variant="ghost" onClick={() => setEditing(d)} title="Edit">
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => remove(d.id)} title="Delete">
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {catalog.undeclared.map((u) => {
                    const vol = volumeByName.get(u.event_name);
                    return (
                      <tr key={u.event_name} className="group bg-secondary/20">
                        <td className="px-4 py-3">
                          <span className="font-mono text-xs">{u.event_name}</span>
                          <div className="text-xs text-muted-foreground">Seen in stream · not catalogued</div>
                        </td>
                        <td className="px-4 py-3"><Badge variant="outline" className="text-[10px] text-muted-foreground">undeclared</Badge></td>
                        <td className="px-4 py-3 text-right tabular-nums">{vol ? vol.events.toLocaleString() : "0"}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{vol ? vol.users.toLocaleString() : "0"}</td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="opacity-0 transition-opacity group-hover:opacity-100"
                            onClick={() => setEditing({ ...BLANK, event_name: u.event_name })}
                            title="Add to catalog"
                          >
                            <Plus className="h-3.5 w-3.5" /> Define
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {/* ── Test emitter + live tail ── */}
        <div className="space-y-4">
          <TestEmitter
            workspaceId={workspaceId}
            projectId={projectId}
            knownEvents={defs.map((d) => d.event_name)}
            onEmitted={() => {
              queryClient.invalidateQueries({ queryKey: ["recent_product_events", projectId] });
              queryClient.invalidateQueries({ queryKey: ["analytics_breakdown", projectId] });
              queryClient.invalidateQueries({ queryKey: ["analytics_summary", projectId] });
            }}
          />
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-4 w-4" /> Live event stream
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {(recent.data ?? []).length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">No events yet.</p>
              ) : (
                <ul className="max-h-80 divide-y divide-border overflow-y-auto">
                  {(recent.data ?? []).map((e) => (
                    <li key={e.id} className="px-4 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-xs">{e.event_name}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {new Date(e.occurred_at).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {e.user_email ?? e.customer_external_id ?? "anonymous"}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {editing && (
        <EventEditor
          value={editing}
          onChange={setEditing}
          onClose={() => setEditing(null)}
          onSave={save}
          saving={saving}
        />
      )}
    </div>
  );
}

// ── Test event emitter ──────────────────────────────────────────────────────
function TestEmitter({
  workspaceId,
  projectId,
  knownEvents,
  onEmitted,
}: {
  workspaceId: string | null;
  projectId: string | null;
  knownEvents: string[];
  onEmitted: () => void;
}) {
  const [eventName, setEventName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [emitting, setEmitting] = useState(false);

  async function emit() {
    if (!workspaceId || !projectId || !eventName.trim()) return;
    setEmitting(true);
    try {
      await callEdge("track-event", {
        workspace_id: workspaceId,
        project_id: projectId,
        event_name: eventName.trim(),
        user_email: userEmail.trim() || undefined,
        properties: { source: "dashboard_test" },
      });
      setEventName("");
      onEmitted();
    } finally {
      setEmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Send className="h-4 w-4" /> Emit a test event</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Input
          placeholder="event_name (e.g. signup)"
          value={eventName}
          onChange={(e) => setEventName(e.target.value)}
          list="known-events"
        />
        <datalist id="known-events">
          {knownEvents.map((n) => <option key={n} value={n} />)}
        </datalist>
        <Input placeholder="user_email (optional)" value={userEmail} onChange={(e) => setUserEmail(e.target.value)} />
        <Button className="w-full" onClick={emit} disabled={emitting || !eventName.trim()}>
          {emitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Emit event
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Definition editor dialog ────────────────────────────────────────────────
function EventEditor({
  value,
  onChange,
  onClose,
  onSave,
  saving,
}: {
  value: Partial<EventDefinition>;
  onChange: (v: Partial<EventDefinition>) => void;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const props = value.property_schema ?? [];
  function setProps(next: PropertySpec[]) {
    onChange({ ...value, property_schema: next });
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{value.id ? "Edit event" : "New event"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Event name (the raw key)</label>
            <Input
              value={value.event_name ?? ""}
              onChange={(e) => onChange({ ...value, event_name: e.target.value })}
              placeholder="feature_used"
              className="font-mono"
              disabled={!!value.id}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Display name</label>
              <Input
                value={value.display_name ?? ""}
                onChange={(e) => onChange({ ...value, display_name: e.target.value })}
                placeholder="Feature used"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Category</label>
              <select
                value={value.category ?? "product"}
                onChange={(e) => onChange({ ...value, category: e.target.value as EventCategory })}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{CATEGORY_META[c].label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Description</label>
            <Input
              value={value.description ?? ""}
              onChange={(e) => onChange({ ...value, description: e.target.value })}
              placeholder="What this event means and when it fires"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!value.is_key_action}
              onChange={(e) => onChange({ ...value, is_key_action: e.target.checked })}
              className="h-4 w-4"
            />
            <Star className="h-3.5 w-3.5 text-amber-400" />
            Key activation action (used as default in funnels & activation rate)
          </label>

          {/* Property schema */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-muted-foreground">Expected properties</label>
              <Button size="sm" variant="outline" onClick={() => setProps([...props, { key: "", type: "string" }])}>
                <Plus className="h-3.5 w-3.5" /> Property
              </Button>
            </div>
            {props.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-2.5 text-center text-xs text-muted-foreground">
                No declared properties.
              </p>
            ) : (
              props.map((p, i) => (
                <div key={i} className="grid grid-cols-[1fr_110px_70px_32px] gap-1.5">
                  <Input
                    value={p.key}
                    onChange={(e) => setProps(props.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                    placeholder="property_key"
                    className="h-9 font-mono text-xs"
                  />
                  <select
                    value={p.type}
                    onChange={(e) => setProps(props.map((x, j) => (j === i ? { ...x, type: e.target.value as PropertySpec["type"] } : x)))}
                    className="h-9 rounded-md border border-input bg-background px-1.5 text-xs"
                  >
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                  </select>
                  <label className="flex h-9 items-center gap-1 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={!!p.required}
                      onChange={(e) => setProps(props.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))}
                    />
                    req.
                  </label>
                  <Button size="sm" variant="ghost" onClick={() => setProps(props.filter((_, j) => j !== i))}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={onSave} disabled={saving || !value.event_name?.trim()}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save event
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
