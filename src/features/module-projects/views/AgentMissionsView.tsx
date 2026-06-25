import { useState } from "react";
import { Plus, Trash2, Target, CheckCircle, Clock, Play, Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface Mission { id: string; title: string; description?: string; status: "pending" | "running" | "completed" | "failed"; priority: "low" | "medium" | "high" | "critical"; createdAt: string; completedAt?: string }

const P_CLS = { low: "bg-zinc-500/15 text-zinc-400", medium: "bg-sky-500/15 text-sky-500", high: "bg-amber-500/15 text-amber-500", critical: "bg-destructive/15 text-destructive" };
const S_CLS = { pending: "text-muted-foreground", running: "text-amber-500", completed: "text-emerald-500", failed: "text-destructive" };
const S_ICON = { pending: Clock, running: Play, completed: CheckCircle, failed: Pause };

export function AgentMissionsView({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const missions: Mission[] = (mp.metadata as any)?.agent_missions ?? [];
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", priority: "medium" as Mission["priority"] });

  async function save(next: Mission[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, agent_missions: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function add() {
    if (!form.title.trim()) return;
    save([{ id: crypto.randomUUID(), title: form.title.trim(), description: form.description.trim() || undefined, status: "pending", priority: form.priority, createdAt: new Date().toISOString() }, ...missions]);
    setForm({ title: "", description: "", priority: "medium" });
    setAdding(false);
  }

  function cycle(id: string) {
    const order: Mission["status"][] = ["pending", "running", "completed", "failed"];
    save(missions.map((m) => {
      if (m.id !== id) return m;
      const next = order[(order.indexOf(m.status) + 1) % order.length];
      return { ...m, status: next, completedAt: next === "completed" ? new Date().toISOString() : m.completedAt };
    }));
  }

  return (
    <div className="space-y-4 py-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><Target className="h-4 w-4 text-muted-foreground" /> Missions</h3>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Assign mission</Button>
      </div>

      {adding && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Mission objective" autoFocus />
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} placeholder="Detailed instructions for the agent…"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as Mission["priority"] })}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
            <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
          </select>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={!form.title.trim()}>Assign</Button>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {missions.map((m) => {
          const Icon = S_ICON[m.status];
          return (
            <div key={m.id} className="group rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <button onClick={() => cycle(m.id)}><Icon className={cn("h-4 w-4", S_CLS[m.status])} /></button>
                <span className="flex-1 text-sm font-medium">{m.title}</span>
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", P_CLS[m.priority])}>{m.priority}</span>
                <button onClick={() => save(missions.filter((x) => x.id !== m.id))} className="hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"><Trash2 className="h-3 w-3" /></button>
              </div>
              {m.description && <p className="mt-1 ml-6 text-xs text-muted-foreground">{m.description}</p>}
              <div className="mt-1 ml-6 text-[10px] text-muted-foreground">
                Created {new Date(m.createdAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                {m.completedAt && ` · Completed ${new Date(m.completedAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`}
              </div>
            </div>
          );
        })}
      </div>
      {missions.length === 0 && !adding && <p className="py-8 text-center text-sm text-muted-foreground">No missions assigned yet.</p>}
    </div>
  );
}
