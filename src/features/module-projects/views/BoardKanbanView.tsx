import { useState } from "react";
import { Plus, Trash2, GripVertical, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface Card { id: string; title: string; description?: string }
interface Column { id: string; title: string; color: string; cards: Card[] }

const DEFAULT_COLORS = ["#3b82f6", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#ec4899"];

export function BoardKanbanView({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const columns: Column[] = (mp.metadata as any)?.board_columns ?? [];
  const [addingCol, setAddingCol] = useState(false);
  const [colName, setColName] = useState("");
  const [addingCard, setAddingCard] = useState<string | null>(null);
  const [cardTitle, setCardTitle] = useState("");

  async function save(next: Column[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, board_columns: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function addColumn() {
    if (!colName.trim()) return;
    save([...columns, { id: crypto.randomUUID(), title: colName.trim(), color: DEFAULT_COLORS[columns.length % DEFAULT_COLORS.length], cards: [] }]);
    setColName("");
    setAddingCol(false);
  }

  function removeColumn(colId: string) {
    save(columns.filter((c) => c.id !== colId));
  }

  function addCard(colId: string) {
    if (!cardTitle.trim()) return;
    save(columns.map((c) => c.id === colId ? { ...c, cards: [...c.cards, { id: crypto.randomUUID(), title: cardTitle.trim() }] } : c));
    setCardTitle("");
    setAddingCard(null);
  }

  function removeCard(colId: string, cardId: string) {
    save(columns.map((c) => c.id === colId ? { ...c, cards: c.cards.filter((k) => k.id !== cardId) } : c));
  }

  function moveCard(fromCol: string, cardId: string, toCol: string) {
    const card = columns.find((c) => c.id === fromCol)?.cards.find((k) => k.id === cardId);
    if (!card) return;
    save(columns.map((c) => {
      if (c.id === fromCol) return { ...c, cards: c.cards.filter((k) => k.id !== cardId) };
      if (c.id === toCol) return { ...c, cards: [...c.cards, card] };
      return c;
    }));
  }

  return (
    <div className="flex h-full gap-3 overflow-x-auto p-4">
      {columns.map((col) => (
        <div key={col.id} className="flex w-72 shrink-0 flex-col rounded-xl border border-border bg-secondary/30">
          {/* Column header */}
          <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: col.color }} />
            <span className="flex-1 text-sm font-semibold">{col.title}</span>
            <span className="text-[10px] text-muted-foreground">{col.cards.length}</span>
            <button onClick={() => removeColumn(col.id)} className="rounded p-0.5 text-muted-foreground hover:text-destructive"><Trash2 className="h-3 w-3" /></button>
          </div>

          {/* Cards */}
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            {col.cards.map((card) => (
              <div key={card.id} className="group rounded-lg border border-border bg-card p-2.5 shadow-sm">
                <div className="flex items-start gap-1.5">
                  <span className="flex-1 text-sm">{card.title}</span>
                  <div className="hidden items-center gap-0.5 group-hover:flex">
                    {columns.filter((c) => c.id !== col.id).length > 0 && (
                      <select onChange={(e) => { if (e.target.value) moveCard(col.id, card.id, e.target.value); e.target.value = ""; }}
                        className="h-5 w-5 cursor-pointer appearance-none rounded bg-secondary text-[0px]" title="Move to…">
                        <option value="">→</option>
                        {columns.filter((c) => c.id !== col.id).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                      </select>
                    )}
                    <button onClick={() => removeCard(col.id, card.id)} className="rounded p-0.5 text-muted-foreground hover:text-destructive"><Trash2 className="h-3 w-3" /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Add card */}
          {addingCard === col.id ? (
            <div className="border-t border-border p-2 space-y-1.5">
              <Input value={cardTitle} onChange={(e) => setCardTitle(e.target.value)} placeholder="Card title…" autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") addCard(col.id); if (e.key === "Escape") setAddingCard(null); }} />
              <div className="flex gap-1.5">
                <Button size="sm" className="flex-1 h-7 text-xs" onClick={() => addCard(col.id)} disabled={!cardTitle.trim()}>Add</Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAddingCard(null)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <button onClick={() => { setAddingCard(col.id); setCardTitle(""); }}
              className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
              <Plus className="h-3 w-3" /> Add card
            </button>
          )}
        </div>
      ))}

      {/* Add column */}
      {addingCol ? (
        <div className="w-72 shrink-0 rounded-xl border border-dashed border-border p-3 space-y-2">
          <Input value={colName} onChange={(e) => setColName(e.target.value)} placeholder="Column name…" autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") addColumn(); if (e.key === "Escape") setAddingCol(false); }} />
          <div className="flex gap-1.5">
            <Button size="sm" className="flex-1 h-7 text-xs" onClick={addColumn} disabled={!colName.trim()}>Add</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAddingCol(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAddingCol(true)}
          className="flex w-72 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-8 text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground">
          <Plus className="h-4 w-4" /> Add column
        </button>
      )}
    </div>
  );
}
