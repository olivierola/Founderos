import { useState } from "react";
import { Plus, Trash2, Eye, CheckCircle, AlertTriangle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface Metric { id: string; name: string; value: string; threshold?: string; status: "ok" | "warn" | "critical"; checkedAt: string }

const S_ICON = { ok: CheckCircle, warn: AlertTriangle, critical: XCircle };
const S_CLS = { ok: "text-emerald-500", warn: "text-amber-500", critical: "text-destructive" };

export function EvalObsView({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const metrics: Metric[] = (mp.metadata as any)?.eval_metrics ?? [];
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", value: "", threshold: "", status: "ok" as Metric["status"] });

  async function save(next: Metric[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, eval_metrics: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function add() {
    if (!form.name.trim()) return;
    save([...metrics, { id: crypto.randomUUID(), name: form.name.trim(), value: form.value.trim(), threshold: form.threshold.trim() || undefined, status: form.status, checkedAt: new Date().toISOString() }]);
    setForm({ name: "", value: "", threshold: "", status: "ok" });
    setAdding(false);
  }

  const okCount = metrics.filter((m) => m.status === "ok").length;
  const warnCount = metrics.filter((m) => m.status === "warn").length;
  const critCount = metrics.filter((m) => m.status === "critical").length;

  return (
    <div className="space-y-4 py-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><Eye className="h-4 w-4 text-muted-foreground" /> Eval / Observability</h3>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add metric</Button>
      </div>

      {metrics.length > 0 && (
        <div className="flex gap-4 text-xs">
          <span className="flex items-center gap-1"><CheckCircle className="h-3.5 w-3.5 text-emerald-500" /> {okCount} OK</span>
          <span className="flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> {warnCount} Warn</span>
          <span className="flex items-center gap-1"><XCircle className="h-3.5 w-3.5 text-destructive" /> {critCount} Critical</span>
        </div>
      )}

      {adding && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Metric name" autoFocus />
            <Input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder="Current value" />
            <Input value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} placeholder="Threshold (optional)" />
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Metric["status"] })}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
              <option value="ok">OK</option><option value="warn">Warning</option><option value="critical">Critical</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={!form.name.trim()}>Add</Button>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {metrics.map((m) => {
          const Icon = S_ICON[m.status];
          return (
            <div key={m.id} className="group flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
              <Icon className={cn("h-4 w-4 shrink-0", S_CLS[m.status])} />
              <span className="flex-1 text-sm font-medium">{m.name}</span>
              <span className="text-sm font-mono">{m.value}</span>
              {m.threshold && <span className="text-xs text-muted-foreground">/ {m.threshold}</span>}
              <button onClick={() => save(metrics.filter((x) => x.id !== m.id))} className="hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"><Trash2 className="h-3 w-3" /></button>
            </div>
          );
        })}
      </div>
      {metrics.length === 0 && !adding && <p className="py-8 text-center text-sm text-muted-foreground">Add metrics to monitor this project.</p>}
    </div>
  );
}
