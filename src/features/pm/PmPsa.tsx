import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Plus, Trash2, Clock, Users, TrendingUp, Gauge, CheckCircle2,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

function money(cents: number, cur = "eur") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: cur.toUpperCase(), maximumFractionDigits: 0 }).format((cents || 0) / 100);
}
function useTbl<T>(table: string, key: string, order = "created_at") {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: [key, projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from(table).select("*").eq("project_id", projectId!).order(order, { ascending: false }).limit(2000);
      return (data ?? []) as T[];
    },
  });
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label className="text-xs font-medium text-muted-foreground">{label}</label>{children}</div>;
}
function mondayOf(d: Date): string {
  const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x.toISOString().slice(0, 10);
}

// ============================================================== TIMESHEETS
const TS_STATUS: Record<string, string> = {
  draft: "bg-zinc-500/15 text-zinc-500", submitted: "bg-sky-500/15 text-sky-500",
  approved: "bg-emerald-500/15 text-emerald-500", rejected: "bg-destructive/15 text-destructive", billed: "bg-violet-500/15 text-violet-500",
};
export function PmTimesheetsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: rows, isLoading } = useTbl<any>("psa_timesheets", "psa_timesheets", "work_date");
  const { data: boards } = useTbl<any>("pm_projects", "pm_projects_psa");
  const { data: resources } = useTbl<any>("psa_resources", "psa_resources");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ resource_id: "", pm_project_id: "", hours: "8", billable: true, work_date: new Date().toISOString().slice(0, 10), note: "" });

  const resById = useMemo(() => Object.fromEntries((resources ?? []).map((r: any) => [r.id, r])), [resources]);
  const boardById = useMemo(() => Object.fromEntries((boards ?? []).map((b: any) => [b.id, b])), [boards]);

  async function create() {
    if (!workspaceId || !projectId || !user) return;
    const { error } = await supabase.from("psa_timesheets").insert({
      workspace_id: workspaceId, project_id: projectId, created_by: user.id,
      resource_id: form.resource_id || null, pm_project_id: form.pm_project_id || null,
      hours: Number(form.hours) || 0, billable: form.billable, work_date: form.work_date, note: form.note.trim() || null,
    });
    if (error) { alert(error.message); return; }
    setForm({ ...form, hours: "8", note: "" }); setOpen(false);
    queryClient.invalidateQueries({ queryKey: ["psa_timesheets", projectId] });
  }
  async function setStatus(id: string, status: string) {
    await supabase.from("psa_timesheets").update({ status }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["psa_timesheets", projectId] });
  }
  async function remove(id: string) {
    await supabase.from("psa_timesheets").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["psa_timesheets", projectId] });
  }

  const totals = useMemo(() => {
    const r = rows ?? [];
    return { hours: r.reduce((s, x) => s + Number(x.hours), 0), billable: r.filter((x) => x.billable).reduce((s, x) => s + Number(x.hours), 0), approved: r.filter((x) => x.status === "approved").length };
  }, [rows]);

  return (
    <div className="space-y-5">
      <PageHeader title="Timesheets" description="Log time against projects — the basis for billing and profitability."
        actions={<Button onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" /> Log time</Button>} />
      <div className="grid grid-cols-3 gap-4">
        <MetricCard label="Hours logged" value={`${totals.hours}h`} icon={Clock} />
        <MetricCard label="Billable" value={`${totals.billable}h`} icon={TrendingUp} hint={totals.hours ? `${Math.round(totals.billable / totals.hours * 100)}% billable` : ""} />
        <MetricCard label="Approved entries" value={String(totals.approved)} icon={CheckCircle2} />
      </div>

      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      : (rows ?? []).length === 0 ? <EmptyState icon={Clock} title="No time logged" description="Log your first entry." />
      : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-border bg-secondary/30 text-xs uppercase tracking-wider text-muted-foreground">
              <tr><th className="px-4 py-3 text-left">Date</th><th className="px-4 py-3 text-left">Resource</th><th className="px-4 py-3 text-left">Project</th><th className="px-4 py-3 text-right">Hours</th><th className="px-4 py-3 text-left">Billable</th><th className="px-4 py-3 text-left">Status</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(rows ?? []).map((t) => (
                <tr key={t.id} className="group hover:bg-secondary/30">
                  <td className="px-4 py-3 text-muted-foreground">{new Date(t.work_date).toLocaleDateString()}</td>
                  <td className="px-4 py-3 font-medium">{resById[t.resource_id]?.name ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{boardById[t.pm_project_id]?.name ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.hours}h</td>
                  <td className="px-4 py-3">{t.billable ? <span className="text-emerald-500">●</span> : <span className="text-muted-foreground">○</span>}</td>
                  <td className="px-4 py-3"><select value={t.status} onChange={(e) => setStatus(t.id, e.target.value)} className={cn("rounded-full border-0 px-2 py-1 text-xs font-medium", TS_STATUS[t.status])}>{Object.keys(TS_STATUS).map((s) => <option key={s} value={s}>{s}</option>)}</select></td>
                  <td className="px-4 py-3 text-right"><button onClick={() => remove(t.id)} className="opacity-0 transition-opacity group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5 text-destructive" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Log time</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label="Resource"><select value={form.resource_id} onChange={(e) => setForm({ ...form, resource_id: e.target.value })} className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"><option value="">— select —</option>{(resources ?? []).map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
            <Field label="Project"><select value={form.pm_project_id} onChange={(e) => setForm({ ...form, pm_project_id: e.target.value })} className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"><option value="">— select —</option>{(boards ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Hours"><Input type="number" step="0.5" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} /></Field>
              <Field label="Date"><Input type="date" value={form.work_date} onChange={(e) => setForm({ ...form, work_date: e.target.value })} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.billable} onChange={(e) => setForm({ ...form, billable: e.target.checked })} className="h-4 w-4 accent-primary" /> Billable</label>
          </div>
          <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={create}>Log</Button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================== RESOURCING (heatmap)
export function PmResourcingPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: resources, isLoading } = useTbl<any>("psa_resources", "psa_resources");
  const { data: allocations } = useTbl<any>("psa_allocations", "psa_allocations");
  const [resOpen, setResOpen] = useState(false);
  const [resForm, setResForm] = useState({ name: "", role: "", bill_rate: "0", cost_rate: "0", capacity: "35" });

  // Next 8 weeks.
  const weeks = useMemo(() => {
    const out: string[] = []; const base = new Date();
    for (let i = 0; i < 8; i++) { const d = new Date(base); d.setDate(d.getDate() + i * 7); out.push(mondayOf(d)); }
    return out;
  }, []);
  const allocByResWeek = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of (allocations ?? [])) m[`${a.resource_id}|${a.week_start}`] = (m[`${a.resource_id}|${a.week_start}`] ?? 0) + Number(a.hours);
    return m;
  }, [allocations]);

  async function createRes() {
    if (!workspaceId || !projectId || !user || !resForm.name.trim()) return;
    const { error } = await supabase.from("psa_resources").insert({
      workspace_id: workspaceId, project_id: projectId, created_by: user.id,
      name: resForm.name.trim(), role: resForm.role.trim() || null,
      bill_rate_cents: Math.round((Number(resForm.bill_rate) || 0) * 100),
      cost_rate_cents: Math.round((Number(resForm.cost_rate) || 0) * 100),
      capacity_hours_week: Number(resForm.capacity) || 35,
    });
    if (error) { alert(error.message); return; }
    setResForm({ name: "", role: "", bill_rate: "0", cost_rate: "0", capacity: "35" }); setResOpen(false);
    queryClient.invalidateQueries({ queryKey: ["psa_resources", projectId] });
  }
  async function setAlloc(resourceId: string, week: string, hours: number) {
    if (!workspaceId || !projectId) return;
    const existing = (allocations ?? []).find((a) => a.resource_id === resourceId && a.week_start === week);
    if (existing) await supabase.from("psa_allocations").update({ hours }).eq("id", existing.id);
    else await supabase.from("psa_allocations").insert({ workspace_id: workspaceId, project_id: projectId, resource_id: resourceId, week_start: week, hours, kind: "firm" });
    queryClient.invalidateQueries({ queryKey: ["psa_allocations", projectId] });
  }

  // Heat color by utilization: green (low) → amber → red (overallocated).
  function heat(util: number): string {
    if (util <= 0) return "bg-secondary/40 text-muted-foreground";
    if (util < 0.7) return "bg-emerald-500/20 text-emerald-600";
    if (util <= 1) return "bg-amber-500/25 text-amber-700";
    return "bg-destructive/25 text-destructive";
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Resourcing" description="Capacity vs demand heatmap by person and week — spot over-allocation early."
        actions={<Button onClick={() => setResOpen(true)}><Plus className="mr-1 h-4 w-4" /> Add resource</Button>} />
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      : (resources ?? []).length === 0 ? <EmptyState icon={Users} title="No resources" description="Add team members to plan capacity." />
      : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-border bg-secondary/30 text-xs uppercase tracking-wider text-muted-foreground">
              <tr><th className="px-3 py-2 text-left">Resource</th>{weeks.map((w) => <th key={w} className="px-2 py-2 text-center font-normal">{new Date(w).toLocaleDateString(undefined, { day: "2-digit", month: "short" })}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(resources ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2"><div className="text-sm font-medium">{r.name}</div><div className="text-[10px] text-muted-foreground">{r.role ?? ""} · {r.capacity_hours_week}h/wk</div></td>
                  {weeks.map((w) => {
                    const h = allocByResWeek[`${r.id}|${w}`] ?? 0;
                    const util = h / Math.max(1, r.capacity_hours_week);
                    return (
                      <td key={w} className="px-1.5 py-1.5 text-center">
                        <input
                          type="number" value={h || ""} placeholder="0"
                          onChange={(e) => setAlloc(r.id, w, Number(e.target.value) || 0)}
                          className={cn("h-9 w-12 rounded-md border-0 text-center text-xs font-medium tabular-nums focus:outline-none focus:ring-1 focus:ring-ring", heat(util))}
                          title={`${h}h / ${r.capacity_hours_week}h (${Math.round(util * 100)}%)`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">Cells are weekly allocated hours. Green = spare capacity · Amber = near full · Red = over-allocated.</p>

      <Dialog open={resOpen} onOpenChange={setResOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add resource</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label="Name"><Input value={resForm.name} onChange={(e) => setResForm({ ...resForm, name: e.target.value })} autoFocus /></Field>
            <Field label="Role"><Input value={resForm.role} onChange={(e) => setResForm({ ...resForm, role: e.target.value })} /></Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Bill/day"><Input type="number" value={resForm.bill_rate} onChange={(e) => setResForm({ ...resForm, bill_rate: e.target.value })} /></Field>
              <Field label="Cost/day"><Input type="number" value={resForm.cost_rate} onChange={(e) => setResForm({ ...resForm, cost_rate: e.target.value })} /></Field>
              <Field label="Cap h/wk"><Input type="number" value={resForm.capacity} onChange={(e) => setResForm({ ...resForm, capacity: e.target.value })} /></Field>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setResOpen(false)}>Cancel</Button><Button onClick={createRes} disabled={!resForm.name.trim()}>Add</Button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================== PROFITABILITY
export function PmProfitabilityPage() {
  const { data: boards } = useTbl<any>("pm_projects", "pm_projects_prof");
  const { data: timesheets } = useTbl<any>("psa_timesheets", "psa_timesheets_prof", "work_date");
  const { data: resources } = useTbl<any>("psa_resources", "psa_resources_prof");

  const resById = useMemo(() => Object.fromEntries((resources ?? []).map((r: any) => [r.id, r])), [resources]);

  const rows = useMemo(() => {
    return (boards ?? []).map((b: any) => {
      const ts = (timesheets ?? []).filter((t) => t.pm_project_id === b.id);
      const hours = ts.reduce((s, t) => s + Number(t.hours), 0);
      const billableH = ts.filter((t) => t.billable).reduce((s, t) => s + Number(t.hours), 0);
      // €/h derived from per-day rates (÷8). Cost from resource cost rate; billed from bill rate.
      const cost = ts.reduce((s, t) => s + Number(t.hours) * ((resById[t.resource_id]?.cost_rate_cents ?? 0) / 8), 0);
      const billed = ts.filter((t) => t.billable).reduce((s, t) => s + Number(t.hours) * ((resById[t.resource_id]?.bill_rate_cents ?? b.day_rate_cents ?? 0) / 8), 0);
      const margin = billed - cost;
      const marginPct = billed > 0 ? Math.round((margin / billed) * 100) : 0;
      const util = hours > 0 ? Math.round((billableH / hours) * 100) : 0;
      return { id: b.id, name: b.name, hours, cost, billed, margin, marginPct, util };
    });
  }, [boards, timesheets, resById]);

  const totals = useMemo(() => ({
    billed: rows.reduce((s, r) => s + r.billed, 0),
    cost: rows.reduce((s, r) => s + r.cost, 0),
    margin: rows.reduce((s, r) => s + r.margin, 0),
  }), [rows]);

  return (
    <div className="space-y-5">
      <PageHeader title="Project profitability" description="Billed vs cost, margin and utilization per project (Projects × Finance)." />
      <div className="grid grid-cols-3 gap-4">
        <MetricCard label="Billed" value={money(totals.billed)} icon={TrendingUp} />
        <MetricCard label="Cost" value={money(totals.cost)} icon={Clock} />
        <MetricCard label="Margin" value={money(totals.margin)} icon={Gauge} hint={totals.billed ? `${Math.round(totals.margin / totals.billed * 100)}%` : ""} />
      </div>

      {rows.length === 0 ? <EmptyState icon={Gauge} title="No project data" description="Create projects (Boards) and log time to see profitability." />
      : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="border-b border-border bg-secondary/30 text-xs uppercase tracking-wider text-muted-foreground">
              <tr><th className="px-4 py-3 text-left">Project</th><th className="px-4 py-3 text-right">Hours</th><th className="px-4 py-3 text-right">Cost</th><th className="px-4 py-3 text-right">Billed</th><th className="px-4 py-3 text-right">Margin</th><th className="px-4 py-3 text-right">Util.</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-secondary/30">
                  <td className="px-4 py-3 font-medium">{r.name}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{r.hours}h</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{money(r.cost)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(r.billed)}</td>
                  <td className={cn("px-4 py-3 text-right tabular-nums font-medium", r.margin >= 0 ? "text-emerald-500" : "text-destructive")}>{money(r.margin)} <span className="text-[10px]">({r.marginPct}%)</span></td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{r.util}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
