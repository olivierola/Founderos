import { useState } from "react";
import { Plus, Activity, CheckCircle, XCircle, Clock, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface RunEntry { id: string; title: string; status: "success" | "failure" | "running" | "pending"; duration?: string; output?: string; timestamp: string }

const STATUS_ICON = { success: CheckCircle, failure: XCircle, running: Loader2, pending: Clock };
const STATUS_CLS = { success: "text-emerald-500", failure: "text-destructive", running: "text-amber-500 animate-spin", pending: "text-muted-foreground" };

export function RunLogView({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const runs: RunEntry[] = (mp.metadata as any)?.run_log ?? [];
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: "", status: "success" as RunEntry["status"], duration: "", output: "" });
  const [expanded, setExpanded] = useState<string | null>(null);

  async function save(next: RunEntry[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, run_log: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function add() {
    if (!form.title.trim()) return;
    const entry: RunEntry = { id: crypto.randomUUID(), title: form.title.trim(), status: form.status, duration: form.duration.trim() || undefined, output: form.output.trim() || undefined, timestamp: new Date().toISOString() };
    save([entry, ...runs]);
    setForm({ title: "", status: "success", duration: "", output: "" });
    setAdding(false);
  }

  function remove(id: string) { save(runs.filter((r) => r.id !== id)); }

  return (
    <div className="space-y-4 py-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><Activity className="h-4 w-4 text-muted-foreground" /> Execution Log</h3>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Log entry</Button>
      </div>

      {adding && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Run title / description" autoFocus />
          <div className="grid grid-cols-3 gap-2">
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as RunEntry["status"] })}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
              <option value="success">Success</option>
              <option value="failure">Failure</option>
              <option value="running">Running</option>
              <option value="pending">Pending</option>
            </select>
            <Input value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} placeholder="Duration (e.g. 2m 30s)" />
          </div>
          <textarea value={form.output} onChange={(e) => setForm({ ...form, output: e.target.value })} rows={3} placeholder="Output / logs (optional)"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={!form.title.trim()}>Add</Button>
          </div>
        </div>
      )}

      {runs.length === 0 && !adding && <p className="py-8 text-center text-sm text-muted-foreground">No executions logged yet.</p>}

      <div className="space-y-1.5">
        {runs.map((r) => {
          const Icon = STATUS_ICON[r.status];
          return (
            <div key={r.id} className="group rounded-lg border border-border">
              <button onClick={() => setExpanded(expanded === r.id ? null : r.id)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-secondary/30">
                <Icon className={cn("h-4 w-4 shrink-0", STATUS_CLS[r.status])} />
                <span className="flex-1 truncate text-sm">{r.title}</span>
                {r.duration && <span className="text-xs text-muted-foreground">{r.duration}</span>}
                <span className="text-[10px] text-muted-foreground">{new Date(r.timestamp).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                <button onClick={(e) => { e.stopPropagation(); remove(r.id); }} className="hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"><Trash2 className="h-3 w-3" /></button>
              </button>
              {expanded === r.id && r.output && (
                <div className="border-t border-border bg-zinc-950 px-4 py-3">
                  <pre className="whitespace-pre-wrap text-xs text-zinc-300 font-mono">{r.output}</pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
