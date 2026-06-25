import { useState } from "react";
import { Plus, Trash2, TrendingUp, TrendingDown, Minus, BarChart3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";

interface KpiCard { id: string; label: string; value: string; prev?: string; unit?: string }

export function DashboardView({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const kpis: KpiCard[] = (mp.metadata as any)?.dashboard_kpis ?? [];
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ label: "", value: "", prev: "", unit: "" });

  async function save(next: KpiCard[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, dashboard_kpis: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function add() {
    if (!form.label.trim()) return;
    save([...kpis, { id: crypto.randomUUID(), label: form.label.trim(), value: form.value.trim(), prev: form.prev.trim() || undefined, unit: form.unit.trim() || undefined }]);
    setForm({ label: "", value: "", prev: "", unit: "" });
    setAdding(false);
  }

  function remove(id: string) { save(kpis.filter((k) => k.id !== id)); }

  function trend(k: KpiCard) {
    if (!k.prev) return null;
    const cur = parseFloat(k.value), prev = parseFloat(k.prev);
    if (isNaN(cur) || isNaN(prev) || cur === prev) return <Minus className="h-4 w-4 text-muted-foreground" />;
    return cur > prev
      ? <TrendingUp className="h-4 w-4 text-emerald-500" />
      : <TrendingDown className="h-4 w-4 text-destructive" />;
  }

  return (
    <div className="space-y-6 py-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><BarChart3 className="h-4 w-4 text-muted-foreground" /> Dashboard</h3>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add KPI</Button>
      </div>

      {kpis.length === 0 && !adding && <p className="py-8 text-center text-sm text-muted-foreground">Add KPIs to track this project's key metrics.</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.id} className="group relative rounded-xl border border-border bg-card p-4">
            <button onClick={() => remove(k.id)} className="absolute right-2 top-2 hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"><Trash2 className="h-3 w-3" /></button>
            <div className="text-xs text-muted-foreground">{k.label}</div>
            <div className="mt-1 flex items-end gap-2">
              <span className="text-2xl font-bold">{k.value}{k.unit ? <span className="ml-0.5 text-sm font-normal text-muted-foreground">{k.unit}</span> : null}</span>
              {trend(k)}
            </div>
            {k.prev && <div className="mt-1 text-[11px] text-muted-foreground">vs {k.prev}{k.unit ?? ""}</div>}
          </div>
        ))}
      </div>

      {adding && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="KPI label" autoFocus />
            <Input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder="Current value" />
            <Input value={form.prev} onChange={(e) => setForm({ ...form, prev: e.target.value })} placeholder="Previous (optional)" />
            <Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="Unit (%, €, …)" />
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={!form.label.trim()}>Add</Button>
          </div>
        </div>
      )}
    </div>
  );
}
