import { useState } from "react";
import { Plus, Trash2, GitPullRequest, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";

interface FunnelItem { id: string; name: string; value?: string }
interface FunnelStage { id: string; label: string; color: string; items: FunnelItem[] }

const STAGE_COLORS = ["#3b82f6", "#8b5cf6", "#f59e0b", "#10b981", "#ef4444", "#ec4899"];

export function PipelineFunnelView({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const stages: FunnelStage[] = (mp.metadata as any)?.pipeline_stages ?? [];
  const [addingStage, setAddingStage] = useState(false);
  const [stageName, setStageName] = useState("");
  const [addingItem, setAddingItem] = useState<string | null>(null);
  const [itemName, setItemName] = useState("");

  async function save(next: FunnelStage[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, pipeline_stages: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function addStage() {
    if (!stageName.trim()) return;
    save([...stages, { id: crypto.randomUUID(), label: stageName.trim(), color: STAGE_COLORS[stages.length % STAGE_COLORS.length], items: [] }]);
    setStageName("");
    setAddingStage(false);
  }

  function removeStage(id: string) { save(stages.filter((s) => s.id !== id)); }

  function addItem(stageId: string) {
    if (!itemName.trim()) return;
    save(stages.map((s) => s.id === stageId ? { ...s, items: [...s.items, { id: crypto.randomUUID(), name: itemName.trim() }] } : s));
    setItemName("");
    setAddingItem(null);
  }

  function removeItem(stageId: string, itemId: string) {
    save(stages.map((s) => s.id === stageId ? { ...s, items: s.items.filter((i) => i.id !== itemId) } : s));
  }

  function moveItem(fromStage: string, itemId: string, toStage: string) {
    const item = stages.find((s) => s.id === fromStage)?.items.find((i) => i.id === itemId);
    if (!item) return;
    save(stages.map((s) => {
      if (s.id === fromStage) return { ...s, items: s.items.filter((i) => i.id !== itemId) };
      if (s.id === toStage) return { ...s, items: [...s.items, item] };
      return s;
    }));
  }

  const totalItems = stages.reduce((s, st) => s + st.items.length, 0);

  return (
    <div className="space-y-6 py-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><GitPullRequest className="h-4 w-4 text-muted-foreground" /> Pipeline</h3>
        <Button size="sm" variant="outline" onClick={() => setAddingStage(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add stage</Button>
      </div>

      {/* Funnel bars */}
      {stages.length > 0 && (
        <div className="space-y-1">
          {stages.map((st, i) => {
            const pct = totalItems > 0 ? Math.max(8, (st.items.length / totalItems) * 100) : 100 / stages.length;
            return (
              <div key={st.id} className="flex items-center gap-2">
                <span className="w-24 truncate text-xs font-medium">{st.label}</span>
                <div className="relative h-8 flex-1 rounded-md overflow-hidden" style={{ backgroundColor: st.color + "20" }}>
                  <div className="h-full rounded-md flex items-center px-2" style={{ width: `${pct}%`, backgroundColor: st.color + "40" }}>
                    <span className="text-xs font-bold" style={{ color: st.color }}>{st.items.length}</span>
                  </div>
                </div>
                <button onClick={() => removeStage(st.id)} className="rounded p-0.5 text-muted-foreground hover:text-destructive"><Trash2 className="h-3 w-3" /></button>
              </div>
            );
          })}
        </div>
      )}

      {/* Stage details */}
      {stages.map((st) => (
        <div key={st.id} className="rounded-lg border border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2" style={{ borderLeftWidth: 3, borderLeftColor: st.color }}>
            <span className="text-sm font-semibold">{st.label}</span>
            <span className="text-[10px] text-muted-foreground">{st.items.length} items</span>
            <button onClick={() => { setAddingItem(st.id); setItemName(""); }} className="ml-auto text-xs text-muted-foreground hover:text-foreground">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="p-2 space-y-1">
            {st.items.map((item) => (
              <div key={item.id} className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-secondary/40">
                <span className="flex-1 text-sm">{item.name}</span>
                {stages.length > 1 && (
                  <select onChange={(e) => { if (e.target.value) moveItem(st.id, item.id, e.target.value); e.target.value = ""; }}
                    className="hidden h-5 cursor-pointer rounded bg-secondary px-1 text-[10px] group-hover:block" title="Move">
                    <option value="">Move →</option>
                    {stages.filter((s) => s.id !== st.id).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                )}
                <button onClick={() => removeItem(st.id, item.id)} className="hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
            {addingItem === st.id && (
              <div className="flex items-center gap-1.5 px-2 pt-1">
                <Input value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="Item name…" className="h-7 text-xs flex-1" autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") addItem(st.id); if (e.key === "Escape") setAddingItem(null); }} />
                <Button size="sm" className="h-7 text-xs px-2" onClick={() => addItem(st.id)} disabled={!itemName.trim()}>Add</Button>
              </div>
            )}
            {st.items.length === 0 && addingItem !== st.id && <p className="px-2 py-2 text-xs text-muted-foreground">Empty stage</p>}
          </div>
        </div>
      ))}

      {addingStage && (
        <div className="flex items-center gap-2">
          <Input value={stageName} onChange={(e) => setStageName(e.target.value)} placeholder="Stage name…" className="h-8 text-xs" autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") addStage(); if (e.key === "Escape") setAddingStage(false); }} />
          <Button size="sm" className="h-8 text-xs" onClick={addStage} disabled={!stageName.trim()}>Add</Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setAddingStage(false)}>Cancel</Button>
        </div>
      )}

      {stages.length === 0 && !addingStage && <p className="py-8 text-center text-sm text-muted-foreground">Add stages to build your pipeline.</p>}
    </div>
  );
}
