import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Grid3x3, Plus, Loader2, Trash2, Pencil } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import {
  mergeEventNames,
  useCohortDefs,
  useEventDefinitions,
  useObservedEventNames,
  type CohortDef,
  type RetentionResult,
} from "./analytics";

const PERIODS = ["day", "week", "month"] as const;

export function RetentionPage() {
  const { projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const cohortsQuery = useCohortDefs();
  const cohorts = cohortsQuery.data ?? [];
  const [editing, setEditing] = useState<Partial<CohortDef> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId && cohorts.length > 0) setSelectedId(cohorts[0].id);
  }, [cohorts, selectedId]);

  const selected = cohorts.find((c) => c.id === selectedId) ?? null;

  async function remove(id: string) {
    await supabase.from("analytics_cohorts").delete().eq("id", id);
    if (selectedId === id) setSelectedId(null);
    await queryClient.invalidateQueries({ queryKey: ["analytics_cohorts", projectId] });
  }

  return (
    <div>
      <PageHeader
        title="Cohorts & Retention"
        description="Group users by the period they first did one event, then track how many came back. Reads straight from the event stream."
        actions={
          <Button size="sm" onClick={() => setEditing({ period: "week", periods: 8, acquisition_event: "", return_event: "" })}>
            <Plus className="h-4 w-4" /> New cohort
          </Button>
        }
      />

      {cohortsQuery.isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : cohorts.length === 0 ? (
        <EmptyState
          icon={Grid3x3}
          title="No retention cohorts yet"
          description="Define a cohort (e.g. acquired by 'signup', retained by 'session_start') to build a retention grid."
          action={
            <Button onClick={() => setEditing({ period: "week", periods: 8, acquisition_event: "", return_event: "" })}>
              <Plus className="h-4 w-4" /> Create cohort
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
          <div className="space-y-2">
            {cohorts.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedId(c.id)}
                className={cn(
                  "w-full rounded-lg border p-3 text-left transition-colors",
                  c.id === selectedId ? "border-[hsl(var(--primary-soft))] bg-secondary/50" : "border-border hover:bg-secondary/30",
                )}
              >
                <div className="truncate text-sm font-medium">{c.name}</div>
                <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                  {c.acquisition_event} → {c.return_event}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">by {c.period}</div>
              </button>
            ))}
          </div>

          <div>
            {selected ? (
              <RetentionGrid cohort={selected} onEdit={() => setEditing(selected)} onDelete={() => remove(selected.id)} />
            ) : (
              <Card><CardContent className="p-10"><EmptyState icon={Grid3x3} title="Select a cohort" /></CardContent></Card>
            )}
          </div>
        </div>
      )}

      {editing && (
        <CohortEditor
          value={editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            queryClient.invalidateQueries({ queryKey: ["analytics_cohorts", projectId] }).then(() => setSelectedId(id));
          }}
        />
      )}
    </div>
  );
}

// Empty cells get a muted class; non-zero cells are colored via inline style
// (alpha scales with the retention pct) on the cell itself.
function heatClass(pct: number): string {
  return pct <= 0 ? "bg-secondary/40 text-muted-foreground" : "";
}

function RetentionGrid({ cohort, onEdit, onDelete }: { cohort: CohortDef; onEdit: () => void; onDelete: () => void }) {
  const { workspaceId, projectId } = useCurrentContext();

  const { data, isLoading, error } = useQuery({
    queryKey: ["retention_result", cohort.id, cohort.acquisition_event, cohort.return_event, cohort.period, cohort.periods],
    enabled: !!workspaceId && !!projectId && !!cohort.acquisition_event && !!cohort.return_event,
    queryFn: () =>
      callEdge<RetentionResult>("analytics-query", {
        workspace_id: workspaceId,
        project_id: projectId,
        kind: "retention",
        acquisition_event: cohort.acquisition_event,
        return_event: cohort.return_event,
        period: cohort.period,
        periods: cohort.periods,
      }),
  });

  const periodLabels = useMemo(
    () => Array.from({ length: cohort.periods }, (_, i) => `${cohort.period[0].toUpperCase()}${i}`),
    [cohort.periods, cohort.period],
  );

  // Average retention curve across cohorts (weighted by size).
  const avgCurve = useMemo(() => {
    if (!data?.cohorts.length) return [];
    const sums = new Array(cohort.periods).fill(0);
    const totalSize = data.cohorts.reduce((a, c) => a + c.size, 0);
    data.cohorts.forEach((c) => c.retained.forEach((n, i) => (sums[i] += n)));
    return sums.map((n) => (totalSize ? (n / totalSize) * 100 : 0));
  }, [data, cohort.periods]);

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{cohort.name}</h2>
            <p className="font-mono text-xs text-muted-foreground">
              {cohort.acquisition_event} → {cohort.return_event} · by {cohort.period}
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            {data && (
              <ExportMenu
                rows={data.cohorts.map((c) => ({
                  cohort: c.cohort,
                  size: c.size,
                  ...Object.fromEntries(c.pct.map((p, i) => [`${cohort.period}_${i}`, p.toFixed(1)])),
                }))}
                filename={`retention-${cohort.name}`}
              />
            )}
            <Button size="sm" variant="ghost" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></Button>
            <Button size="sm" variant="ghost" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : error ? (
          <EmptyState icon={Grid3x3} title="Could not compute retention" description={error instanceof Error ? error.message : String(error)} />
        ) : !data || data.cohorts.length === 0 ? (
          <EmptyState icon={Grid3x3} title="No cohorts for these events" description="No users have performed the acquisition event in the selected window." />
        ) : (
          <>
            {/* Average curve */}
            <div className="rounded-lg border border-border bg-secondary/20 p-3">
              <div className="mb-2 text-xs font-medium text-muted-foreground">Average retention</div>
              <div className="flex items-end gap-1">
                {avgCurve.map((p, i) => (
                  <div key={i} className="flex flex-1 flex-col items-center gap-1" title={`${periodLabels[i]}: ${p.toFixed(1)}%`}>
                    <div className="text-[10px] tabular-nums text-muted-foreground">{p.toFixed(0)}%</div>
                    <div className="w-full overflow-hidden rounded-t bg-secondary" style={{ height: 56 }}>
                      <div className="w-full bg-[hsl(var(--primary-soft))]" style={{ height: `${Math.max(2, (p / 100) * 56)}px`, marginTop: `${56 - Math.max(2, (p / 100) * 56)}px` }} />
                    </div>
                    <div className="text-[10px] text-muted-foreground">{periodLabels[i]}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Heatmap grid */}
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-1 text-xs">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="px-2 py-1 text-left font-medium">Cohort</th>
                    <th className="px-2 py-1 text-right font-medium">Users</th>
                    {periodLabels.map((l) => <th key={l} className="px-2 py-1 text-center font-medium">{l}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.cohorts.map((c) => (
                    <tr key={c.cohort}>
                      <td className="whitespace-nowrap px-2 py-1 font-medium">{c.cohort}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{c.size}</td>
                      {c.pct.map((p, i) => (
                        <td
                          key={i}
                          className={cn("rounded text-center tabular-nums", heatClass(p))}
                          style={p > 0 ? { backgroundColor: `hsl(var(--primary-soft) / ${Math.min(1, 0.12 + p / 130)})`, color: p > 45 ? "hsl(var(--background))" : undefined } : undefined}
                          title={`${c.retained[i]} / ${c.size}`}
                        >
                          {p > 0 ? `${p.toFixed(0)}%` : "·"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CohortEditor({ value, onClose, onSaved }: { value: Partial<CohortDef>; onClose: () => void; onSaved: (id: string) => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const defs = useEventDefinitions().data ?? [];
  const observed = useObservedEventNames().data ?? [];
  const eventOptions = useMemo(() => mergeEventNames(defs, observed), [defs, observed]);

  const [name, setName] = useState(value.name ?? "");
  const [acq, setAcq] = useState(value.acquisition_event ?? "");
  const [ret, setRet] = useState(value.return_event ?? "");
  const [period, setPeriod] = useState<CohortDef["period"]>(value.period ?? "week");
  const [periods, setPeriods] = useState(value.periods ?? 8);
  const [saving, setSaving] = useState(false);

  const valid = name.trim() && acq.trim() && ret.trim();

  async function save() {
    if (!workspaceId || !projectId || !valid) return;
    setSaving(true);
    try {
      const payload = {
        workspace_id: workspaceId,
        project_id: projectId,
        name: name.trim(),
        acquisition_event: acq.trim(),
        return_event: ret.trim(),
        period,
        periods,
        updated_at: new Date().toISOString(),
      };
      let id = value.id;
      if (id) {
        await supabase.from("analytics_cohorts").update(payload).eq("id", id);
      } else {
        const { data } = await supabase.from("analytics_cohorts").insert(payload).select("id").single();
        id = data?.id;
      }
      if (id) onSaved(id);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{value.id ? "Edit cohort" : "New retention cohort"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Signup retention" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Acquisition event (cohort entry)</label>
              <Input value={acq} onChange={(e) => setAcq(e.target.value)} placeholder="signup" list="cohort-events" className="font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Return event (retained)</label>
              <Input value={ret} onChange={(e) => setRet(e.target.value)} placeholder="session_start" list="cohort-events" className="font-mono text-xs" />
            </div>
          </div>
          <datalist id="cohort-events">
            {eventOptions.map((n) => <option key={n} value={n} />)}
          </datalist>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Period</label>
              <select value={period} onChange={(e) => setPeriod(e.target.value as CohortDef["period"])} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground"># periods</label>
              <Input type="number" min={2} max={24} value={periods} onChange={(e) => setPeriods(Number(e.target.value) || 8)} />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving || !valid}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save cohort
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
