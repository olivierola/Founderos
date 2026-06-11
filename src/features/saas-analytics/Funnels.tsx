import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Filter,
  Plus,
  Loader2,
  Trash2,
  Pencil,
  X,
  ChevronUp,
  ChevronDown,
  TrendingDown,
  ArrowDown,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import {
  mergeEventNames,
  useEventDefinitions,
  useFunnels,
  useObservedEventNames,
  type FunnelDef,
  type FunnelResult,
  type FunnelStep,
} from "./analytics";

export function FunnelsPage() {
  const { projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const funnelsQuery = useFunnels();
  const funnels = funnelsQuery.data ?? [];
  const [editing, setEditing] = useState<Partial<FunnelDef> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId && funnels.length > 0) setSelectedId(funnels[0].id);
  }, [funnels, selectedId]);

  const selected = funnels.find((f) => f.id === selectedId) ?? null;

  async function removeFunnel(id: string) {
    await supabase.from("analytics_funnels").delete().eq("id", id);
    if (selectedId === id) setSelectedId(null);
    await queryClient.invalidateQueries({ queryKey: ["analytics_funnels", projectId] });
  }

  return (
    <div>
      <PageHeader
        title="Funnels"
        description="Measure step-by-step conversion across product events. Build a funnel once, replay it on the live event stream."
        actions={
          <Button size="sm" onClick={() => setEditing({ steps: [{ event_name: "" }, { event_name: "" }], window_days: 30 })}>
            <Plus className="h-4 w-4" /> New funnel
          </Button>
        }
      />

      {funnelsQuery.isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : funnels.length === 0 ? (
        <EmptyState
          icon={Filter}
          title="No funnels yet"
          description="Create a funnel of 2+ events (e.g. signup → activated → subscribed) to see where users drop off."
          action={
            <Button onClick={() => setEditing({ steps: [{ event_name: "" }, { event_name: "" }], window_days: 30 })}>
              <Plus className="h-4 w-4" /> Create funnel
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
          {/* Funnel list */}
          <div className="space-y-2">
            {funnels.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setSelectedId(f.id)}
                className={cn(
                  "w-full rounded-lg border p-3 text-left transition-colors",
                  f.id === selectedId ? "border-[hsl(var(--primary-soft))] bg-secondary/50" : "border-border hover:bg-secondary/30",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{f.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{f.steps.length} steps</span>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {f.steps.map((s) => s.label || s.event_name).join(" → ")}
                </div>
              </button>
            ))}
          </div>

          {/* Funnel result */}
          <div>
            {selected ? (
              <FunnelResultView
                funnel={selected}
                onEdit={() => setEditing(selected)}
                onDelete={() => removeFunnel(selected.id)}
              />
            ) : (
              <Card><CardContent className="p-10"><EmptyState icon={Filter} title="Select a funnel" /></CardContent></Card>
            )}
          </div>
        </div>
      )}

      {editing && (
        <FunnelEditor
          value={editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            queryClient.invalidateQueries({ queryKey: ["analytics_funnels", projectId] }).then(() => setSelectedId(id));
          }}
        />
      )}
    </div>
  );
}

// ── Result view (calls the engine) ──────────────────────────────────────────
function FunnelResultView({ funnel, onEdit, onDelete }: { funnel: FunnelDef; onEdit: () => void; onDelete: () => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const stepNames = funnel.steps.map((s) => s.event_name).filter(Boolean);
  const [view, setView] = useState<"funnel" | "bars">("funnel");

  const { data, isLoading, error } = useQuery({
    queryKey: ["funnel_result", funnel.id, funnel.steps, funnel.window_days],
    enabled: !!workspaceId && !!projectId && stepNames.length >= 2,
    queryFn: () =>
      callEdge<FunnelResult>("analytics-query", {
        workspace_id: workspaceId,
        project_id: projectId,
        kind: "funnel",
        steps: stepNames,
        window_days: funnel.window_days,
      }),
  });

  const labelFor = (eventName: string, i: number) => funnel.steps[i]?.label || eventName;
  const overall = useMemo(() => {
    if (!data?.steps?.length) return 0;
    const first = data.steps[0].count;
    const last = data.steps[data.steps.length - 1].count;
    return first ? (last / first) * 100 : 0;
  }, [data]);

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{funnel.name}</h2>
            {funnel.description && <p className="text-xs text-muted-foreground">{funnel.description}</p>}
            <p className="mt-1 text-xs text-muted-foreground">Conversion window: {funnel.window_days} days</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div className="mr-2 flex rounded-md border border-border p-0.5">
              {(["funnel", "bars"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={cn(
                    "rounded px-2 py-1 text-[11px] capitalize transition-colors",
                    view === v ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {v === "funnel" ? "Funnel" : "Bars"}
                </button>
              ))}
            </div>
            <Button size="sm" variant="ghost" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></Button>
            <Button size="sm" variant="ghost" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : error ? (
          <EmptyState icon={TrendingDown} title="Could not compute funnel" description={error instanceof Error ? error.message : String(error)} />
        ) : !data || data.steps.length === 0 ? (
          <EmptyState icon={Filter} title="No data for these steps" />
        ) : (
          <>
            <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 p-3">
              <div className="text-3xl font-semibold tabular-nums">{overall.toFixed(1)}%</div>
              <div className="text-xs text-muted-foreground">
                overall conversion<br />
                {data.steps[0].count.toLocaleString()} → {data.steps[data.steps.length - 1].count.toLocaleString()} users
              </div>
            </div>

            {view === "funnel" ? (
              <FunnelShape steps={data.steps} labelFor={labelFor} />
            ) : (
              <div className="space-y-1">
                {data.steps.map((step, i) => (
                  <div key={i}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-secondary text-[10px] tabular-nums">{i + 1}</span>
                        {labelFor(step.event_name, i)}
                      </span>
                      <span className="text-muted-foreground">
                        <span className="font-medium text-foreground tabular-nums">{step.count.toLocaleString()}</span>
                        {" · "}{step.pct_of_top.toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-7 overflow-hidden rounded-md bg-secondary">
                      <div
                        className="flex h-full items-center rounded-md bg-[hsl(var(--primary-soft))] px-2 text-[10px] font-medium text-background transition-all"
                        style={{ width: `${Math.max(2, step.pct_of_top)}%` }}
                      >
                        {step.pct_of_top >= 12 ? `${step.pct_of_top.toFixed(0)}%` : ""}
                      </div>
                    </div>
                    {i < data.steps.length - 1 && (
                      <div className="flex items-center gap-1.5 py-1 pl-7 text-[11px]">
                        <ArrowDown className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">
                          {data.steps[i + 1].step_conversion.toFixed(1)}% continue
                        </span>
                        {data.steps[i + 1].dropoff > 0 && (
                          <Badge variant="outline" className="border-destructive/30 text-[10px] text-destructive">
                            −{data.steps[i + 1].dropoff.toLocaleString()} dropped
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Funnel shape (the "real" funnel visual) ─────────────────────────────────
// A continuous, centered funnel: each step is a trapezoid whose top width is
// the step's share of step-1 users and whose bottom width is the next step's —
// the silhouette narrows exactly where users drop. The legend rows on the
// right are height-aligned with the bands.
function FunnelShape({
  steps,
  labelFor,
}: {
  steps: FunnelResult["steps"];
  labelFor: (eventName: string, i: number) => string;
}) {
  const BAND_H = 72; // px per step
  const MIN_W = 7; // % — keep tiny steps visible
  const widthOf = (i: number) => Math.max(MIN_W, steps[i]?.pct_of_top ?? 0);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_260px]">
      {/* The funnel silhouette */}
      <div>
        {steps.map((step, i) => {
          const top = widthOf(i);
          const bottom = i < steps.length - 1 ? widthOf(i + 1) : widthOf(i) * 0.82;
          const opacity = Math.max(0.35, 0.95 - i * 0.13);
          const clip = `polygon(${50 - top / 2}% 0, ${50 + top / 2}% 0, ${50 + bottom / 2}% 100%, ${50 - bottom / 2}% 100%)`;
          return (
            <div key={i} className="relative" style={{ height: BAND_H }}>
              <div
                className="absolute inset-0 transition-all"
                style={{
                  clipPath: clip,
                  background: `hsl(var(--primary-soft) / ${opacity})`,
                }}
                title={`${labelFor(step.event_name, i)} — ${step.count.toLocaleString()} users (${step.pct_of_top.toFixed(1)}%)`}
              />
              {/* Centered % readout, readable at any band width */}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className={cn("text-sm font-semibold tabular-nums", top >= 18 ? "text-background" : "text-foreground")}>
                  {step.pct_of_top.toFixed(0)}%
                </span>
                {top >= 26 && (
                  <span className="text-[10px] tabular-nums text-background/80">
                    {step.count.toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Step legend, aligned band by band */}
      <div>
        {steps.map((step, i) => (
          <div key={i} className="flex flex-col justify-center border-l-2 border-border pl-3" style={{ height: BAND_H }}>
            <div className="flex items-center gap-2 text-sm">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] tabular-nums">{i + 1}</span>
              <span className="truncate font-medium">{labelFor(step.event_name, i)}</span>
            </div>
            <div className="mt-0.5 pl-7 text-xs text-muted-foreground">
              <span className="font-medium tabular-nums text-foreground">{step.count.toLocaleString()}</span> users
              {" · "}{step.pct_of_top.toFixed(1)}% of top
            </div>
            {i > 0 && (
              <div className="flex items-center gap-1.5 pl-7 text-[11px]">
                <ArrowDown className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">{step.step_conversion.toFixed(1)}% from previous</span>
                {step.dropoff > 0 && (
                  <Badge variant="outline" className="border-destructive/30 text-[10px] text-destructive">
                    −{step.dropoff.toLocaleString()}
                  </Badge>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────
function FunnelEditor({ value, onClose, onSaved }: { value: Partial<FunnelDef>; onClose: () => void; onSaved: (id: string) => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const defs = useEventDefinitions().data ?? [];
  const observed = useObservedEventNames().data ?? [];
  const eventOptions = useMemo(() => mergeEventNames(defs, observed), [defs, observed]);

  const [name, setName] = useState(value.name ?? "");
  const [description, setDescription] = useState(value.description ?? "");
  const [windowDays, setWindowDays] = useState(value.window_days ?? 30);
  const [steps, setSteps] = useState<FunnelStep[]>(value.steps?.length ? value.steps : [{ event_name: "" }, { event_name: "" }]);
  const [saving, setSaving] = useState(false);

  const valid = name.trim() && steps.filter((s) => s.event_name.trim()).length >= 2;

  async function save() {
    if (!workspaceId || !projectId || !valid) return;
    setSaving(true);
    try {
      const payload = {
        workspace_id: workspaceId,
        project_id: projectId,
        name: name.trim(),
        description: description.trim() || null,
        steps: steps.filter((s) => s.event_name.trim()),
        window_days: windowDays,
        updated_at: new Date().toISOString(),
      };
      let id = value.id;
      if (id) {
        await supabase.from("analytics_funnels").update(payload).eq("id", id);
      } else {
        const { data } = await supabase.from("analytics_funnels").insert(payload).select("id").single();
        id = data?.id;
      }
      if (id) onSaved(id);
    } finally {
      setSaving(false);
    }
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{value.id ? "Edit funnel" : "New funnel"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Signup → Paid" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Window (days)</label>
              <Input type="number" min={1} max={365} value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value) || 30)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Description</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </div>

          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Steps (ordered)</label>
            {steps.map((step, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] tabular-nums">{i + 1}</span>
                <Input
                  value={step.event_name}
                  onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, event_name: e.target.value } : x)))}
                  placeholder="event_name"
                  list="funnel-events"
                  className="h-9 font-mono text-xs"
                />
                <Input
                  value={step.label ?? ""}
                  onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  placeholder="label (optional)"
                  className="h-9 text-xs"
                />
                <div className="flex flex-col">
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Move up" className="text-muted-foreground hover:text-foreground disabled:opacity-30">
                    <ChevronUp className="h-3 w-3" />
                  </button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === steps.length - 1} title="Move down" className="text-muted-foreground hover:text-foreground disabled:opacity-30">
                    <ChevronDown className="h-3 w-3" />
                  </button>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setSteps(steps.filter((_, j) => j !== i))} disabled={steps.length <= 2}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <datalist id="funnel-events">
              {eventOptions.map((n) => <option key={n} value={n} />)}
            </datalist>
            <Button size="sm" variant="outline" onClick={() => setSteps([...steps, { event_name: "" }])} disabled={steps.length >= 12}>
              <Plus className="h-3.5 w-3.5" /> Add step
            </Button>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving || !valid}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save funnel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
