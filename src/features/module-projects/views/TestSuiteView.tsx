import { useState } from "react";
import { Plus, Trash2, TestTube2, CheckCircle, XCircle, Clock, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface TestCase { id: string; title: string; description?: string; status: "pass" | "fail" | "skip" | "pending"; lastRun?: string }

const S_ICON = { pass: CheckCircle, fail: XCircle, skip: Clock, pending: Clock };
const S_CLS = { pass: "text-emerald-500", fail: "text-destructive", skip: "text-muted-foreground", pending: "text-amber-500" };

export function TestSuiteView({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const tests: TestCase[] = (mp.metadata as any)?.test_cases ?? [];
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: "", description: "" });

  async function save(next: TestCase[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, test_cases: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function add() {
    if (!form.title.trim()) return;
    save([...tests, { id: crypto.randomUUID(), title: form.title.trim(), description: form.description.trim() || undefined, status: "pending" }]);
    setForm({ title: "", description: "" });
    setAdding(false);
  }

  function setStatus(id: string, status: TestCase["status"]) {
    save(tests.map((t) => t.id === id ? { ...t, status, lastRun: new Date().toISOString() } : t));
  }

  const pass = tests.filter((t) => t.status === "pass").length;
  const fail = tests.filter((t) => t.status === "fail").length;
  const total = tests.length;
  const pct = total > 0 ? Math.round((pass / total) * 100) : 0;

  return (
    <div className="space-y-4 py-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><TestTube2 className="h-4 w-4 text-muted-foreground" /> Test Suite</h3>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add test</Button>
      </div>

      {total > 0 && (
        <div className="flex items-center gap-4">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs font-mono">{pass}/{total} pass ({pct}%)</span>
          {fail > 0 && <span className="text-xs text-destructive">{fail} fail</span>}
        </div>
      )}

      {adding && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Test case title" autoFocus />
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder="Steps / expected result (optional)"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={!form.title.trim()}>Add</Button>
          </div>
        </div>
      )}

      <div className="space-y-1">
        {tests.map((t) => {
          const Icon = S_ICON[t.status];
          return (
            <div key={t.id} className="group flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5">
              <Icon className={cn("h-4 w-4 shrink-0", S_CLS[t.status])} />
              <div className="min-w-0 flex-1">
                <div className="text-sm">{t.title}</div>
                {t.description && <div className="text-[10px] text-muted-foreground line-clamp-1">{t.description}</div>}
              </div>
              <div className="hidden items-center gap-1 group-hover:flex">
                <button onClick={() => setStatus(t.id, "pass")} className="rounded p-1 text-emerald-500 hover:bg-emerald-500/10" title="Pass"><CheckCircle className="h-3.5 w-3.5" /></button>
                <button onClick={() => setStatus(t.id, "fail")} className="rounded p-1 text-destructive hover:bg-destructive/10" title="Fail"><XCircle className="h-3.5 w-3.5" /></button>
                <button onClick={() => setStatus(t.id, "skip")} className="rounded p-1 text-muted-foreground hover:bg-secondary" title="Skip"><Clock className="h-3.5 w-3.5" /></button>
                <button onClick={() => save(tests.filter((x) => x.id !== t.id))} className="rounded p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          );
        })}
      </div>
      {tests.length === 0 && !adding && <p className="py-8 text-center text-sm text-muted-foreground">No test cases yet.</p>}
    </div>
  );
}
