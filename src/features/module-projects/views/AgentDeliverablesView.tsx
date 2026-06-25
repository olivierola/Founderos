import { useState } from "react";
import { Plus, Trash2, Package, FileText, Code2, Image, Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";

interface Deliverable { id: string; title: string; type: "document" | "code" | "image" | "data" | "other"; content?: string; url?: string; createdAt: string }

const TYPE_ICON = { document: FileText, code: Code2, image: Image, data: FileText, other: Package };
const TYPE_COLOR = { document: "#3b82f6", code: "#10b981", image: "#ec4899", data: "#f59e0b", other: "#6b7280" };

export function AgentDeliverablesView({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const deliverables: Deliverable[] = (mp.metadata as any)?.agent_deliverables ?? [];
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", type: "document" as Deliverable["type"], content: "", url: "" });

  async function save(next: Deliverable[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, agent_deliverables: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function add() {
    if (!form.title.trim()) return;
    save([{ id: crypto.randomUUID(), title: form.title.trim(), type: form.type, content: form.content.trim() || undefined, url: form.url.trim() || undefined, createdAt: new Date().toISOString() }, ...deliverables]);
    setForm({ title: "", type: "document", content: "", url: "" });
    setAdding(false);
  }

  return (
    <div className="space-y-4 py-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><Package className="h-4 w-4 text-muted-foreground" /> Deliverables</h3>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add deliverable</Button>
      </div>

      {adding && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Deliverable title" autoFocus />
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as Deliverable["type"] })}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
              <option value="document">Document</option><option value="code">Code</option><option value="image">Image</option><option value="data">Data</option><option value="other">Other</option>
            </select>
          </div>
          <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="URL / link (optional)" />
          <textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={4} placeholder="Content (optional)"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={!form.title.trim()}>Add</Button>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {deliverables.map((d) => {
          const Icon = TYPE_ICON[d.type];
          return (
            <div key={d.id} className="group rounded-lg border border-border">
              <button onClick={() => setExpanded(expanded === d.id ? null : d.id)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-secondary/30">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-white" style={{ backgroundColor: TYPE_COLOR[d.type] }}>
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{d.title}</div>
                  <div className="text-[10px] text-muted-foreground">{d.type} · {new Date(d.createdAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>
                </div>
                {d.url && <a href={d.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="rounded p-1 text-muted-foreground hover:text-foreground"><ExternalLink className="h-3.5 w-3.5" /></a>}
                <button onClick={(e) => { e.stopPropagation(); save(deliverables.filter((x) => x.id !== d.id)); }} className="hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"><Trash2 className="h-3 w-3" /></button>
              </button>
              {expanded === d.id && d.content && (
                <div className="border-t border-border bg-zinc-950 px-4 py-3">
                  <pre className="whitespace-pre-wrap text-xs text-zinc-300 font-mono">{d.content}</pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {deliverables.length === 0 && !adding && <p className="py-8 text-center text-sm text-muted-foreground">No deliverables yet. The agent will produce outputs here.</p>}
    </div>
  );
}
