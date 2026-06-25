import { useState } from "react";
import { Plus, Trash2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface Risk { id: string; title: string; description?: string; likelihood: 1|2|3|4|5; impact: 1|2|3|4|5; mitigation?: string; status: "open" | "mitigated" | "accepted" }

const SEVERITY_CLS: Record<string, string> = { low: "bg-emerald-500/15 text-emerald-500", medium: "bg-amber-500/15 text-amber-500", high: "bg-orange-500/15 text-orange-500", critical: "bg-destructive/15 text-destructive" };

function severity(r: Risk): string {
  const score = r.likelihood * r.impact;
  if (score >= 16) return "critical";
  if (score >= 9) return "high";
  if (score >= 4) return "medium";
  return "low";
}

export function RiskRegisterView({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const risks: Risk[] = (mp.metadata as any)?.risks ?? [];
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", likelihood: "3", impact: "3", mitigation: "" });

  async function save(next: Risk[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, risks: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function add() {
    if (!form.title.trim()) return;
    save([...risks, { id: crypto.randomUUID(), title: form.title.trim(), description: form.description.trim() || undefined, likelihood: Number(form.likelihood) as any, impact: Number(form.impact) as any, mitigation: form.mitigation.trim() || undefined, status: "open" }]);
    setForm({ title: "", description: "", likelihood: "3", impact: "3", mitigation: "" });
    setAdding(false);
  }

  function toggleStatus(id: string) {
    save(risks.map((r) => r.id === id ? { ...r, status: r.status === "open" ? "mitigated" : r.status === "mitigated" ? "accepted" : "open" } : r));
  }

  return (
    <div className="space-y-4 py-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-muted-foreground" /> Risk Register</h3>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add risk</Button>
      </div>

      {adding && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Risk title" autoFocus />
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder="Description (optional)"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground">Likelihood (1-5)</label>
              <select value={form.likelihood} onChange={(e) => setForm({ ...form, likelihood: e.target.value })} className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm">
                {[1,2,3,4,5].map((n) => <option key={n} value={n}>{n} — {["Very low","Low","Medium","High","Very high"][n-1]}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground">Impact (1-5)</label>
              <select value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })} className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm">
                {[1,2,3,4,5].map((n) => <option key={n} value={n}>{n} — {["Negligible","Minor","Moderate","Major","Severe"][n-1]}</option>)}
              </select>
            </div>
          </div>
          <Input value={form.mitigation} onChange={(e) => setForm({ ...form, mitigation: e.target.value })} placeholder="Mitigation plan (optional)" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={!form.title.trim()}>Add</Button>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {risks.map((r) => {
          const sev = severity(r);
          return (
            <div key={r.id} className="group rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase", SEVERITY_CLS[sev])}>{sev}</span>
                <span className="flex-1 text-sm font-medium">{r.title}</span>
                <button onClick={() => toggleStatus(r.id)} className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium",
                  r.status === "open" ? "bg-amber-500/15 text-amber-500" : r.status === "mitigated" ? "bg-emerald-500/15 text-emerald-500" : "bg-zinc-500/15 text-zinc-400")}>{r.status}</button>
                <button onClick={() => save(risks.filter((x) => x.id !== r.id))} className="hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"><Trash2 className="h-3 w-3" /></button>
              </div>
              {r.description && <p className="mt-1 text-xs text-muted-foreground">{r.description}</p>}
              <div className="mt-1.5 flex gap-3 text-[10px] text-muted-foreground">
                <span>L={r.likelihood}</span><span>I={r.impact}</span><span>Score={r.likelihood * r.impact}</span>
              </div>
              {r.mitigation && <p className="mt-1 text-xs text-emerald-500/80">Mitigation: {r.mitigation}</p>}
            </div>
          );
        })}
      </div>
      {risks.length === 0 && !adding && <p className="py-8 text-center text-sm text-muted-foreground">No risks identified yet.</p>}
    </div>
  );
}
