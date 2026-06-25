import { useState } from "react";
import { Plus, Trash2, Table2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface GridCol { key: string; label: string }
interface GridRow { id: string; data: Record<string, string> }

export function TableGridView({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const cols: GridCol[] = (mp.metadata as any)?.grid_columns ?? [{ key: "name", label: "Name" }, { key: "status", label: "Status" }, { key: "value", label: "Value" }];
  const rows: GridRow[] = (mp.metadata as any)?.grid_rows ?? [];
  const [addingRow, setAddingRow] = useState(false);
  const [addingCol, setAddingCol] = useState(false);
  const [newRow, setNewRow] = useState<Record<string, string>>({});
  const [newColLabel, setNewColLabel] = useState("");
  const [editCell, setEditCell] = useState<{ rowId: string; key: string } | null>(null);
  const [editVal, setEditVal] = useState("");
  const [search, setSearch] = useState("");

  async function save(nextCols: GridCol[], nextRows: GridRow[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, grid_columns: nextCols, grid_rows: nextRows } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function addRow() {
    const row: GridRow = { id: crypto.randomUUID(), data: { ...newRow } };
    save(cols, [...rows, row]);
    setNewRow({});
    setAddingRow(false);
  }

  function removeRow(id: string) { save(cols, rows.filter((r) => r.id !== id)); }

  function addCol() {
    if (!newColLabel.trim()) return;
    const key = newColLabel.trim().toLowerCase().replace(/\s+/g, "_");
    save([...cols, { key, label: newColLabel.trim() }], rows);
    setNewColLabel("");
    setAddingCol(false);
  }

  function removeCol(key: string) {
    save(cols.filter((c) => c.key !== key), rows.map((r) => ({ ...r, data: Object.fromEntries(Object.entries(r.data).filter(([k]) => k !== key)) })));
  }

  function saveCell() {
    if (!editCell) return;
    save(cols, rows.map((r) => r.id === editCell.rowId ? { ...r, data: { ...r.data, [editCell.key]: editVal } } : r));
    setEditCell(null);
  }

  const filtered = search ? rows.filter((r) => Object.values(r.data).some((v) => v.toLowerCase().includes(search.toLowerCase()))) : rows;

  return (
    <div className="space-y-3 py-4">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold"><Table2 className="h-4 w-4 text-muted-foreground" /> Table</div>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className="ml-auto h-7 w-48 text-xs" />
        <Button size="sm" variant="outline" onClick={() => setAddingCol(true)}><Plus className="mr-1 h-3 w-3" /> Column</Button>
        <Button size="sm" onClick={() => { setAddingRow(true); setNewRow({}); }}><Plus className="mr-1 h-3 w-3" /> Row</Button>
      </div>

      {addingCol && (
        <div className="flex items-center gap-2">
          <Input value={newColLabel} onChange={(e) => setNewColLabel(e.target.value)} placeholder="Column name" className="h-7 w-48 text-xs" autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") addCol(); if (e.key === "Escape") setAddingCol(false); }} />
          <Button size="sm" className="h-7 text-xs" onClick={addCol} disabled={!newColLabel.trim()}>Add</Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setAddingCol(false)}>Cancel</Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/40">
              {cols.map((c) => (
                <th key={c.key} className="group px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    {c.label}
                    <button onClick={() => removeCol(c.key)} className="hidden rounded p-0.5 hover:text-destructive group-hover:inline"><Trash2 className="h-2.5 w-2.5" /></button>
                  </span>
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="group border-b border-border last:border-0 hover:bg-secondary/20">
                {cols.map((c) => (
                  <td key={c.key} className="px-3 py-2 cursor-pointer" onClick={() => { setEditCell({ rowId: r.id, key: c.key }); setEditVal(r.data[c.key] ?? ""); }}>
                    {editCell?.rowId === r.id && editCell.key === c.key ? (
                      <Input value={editVal} onChange={(e) => setEditVal(e.target.value)} className="h-6 text-xs" autoFocus
                        onBlur={saveCell} onKeyDown={(e) => { if (e.key === "Enter") saveCell(); if (e.key === "Escape") setEditCell(null); }} />
                    ) : (
                      <span className="text-xs">{r.data[c.key] ?? <span className="text-muted-foreground">—</span>}</span>
                    )}
                  </td>
                ))}
                <td className="px-2">
                  <button onClick={() => removeRow(r.id)} className="hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:inline"><Trash2 className="h-3 w-3" /></button>
                </td>
              </tr>
            ))}
            {addingRow && (
              <tr className="border-b border-border bg-primary/5">
                {cols.map((c) => (
                  <td key={c.key} className="px-3 py-1.5">
                    <Input value={newRow[c.key] ?? ""} onChange={(e) => setNewRow({ ...newRow, [c.key]: e.target.value })}
                      placeholder={c.label} className="h-6 text-xs" />
                  </td>
                ))}
                <td className="px-2">
                  <div className="flex gap-1">
                    <Button size="sm" className="h-6 text-[10px] px-2" onClick={addRow}>Add</Button>
                    <Button size="sm" variant="ghost" className="h-6 text-[10px] px-1" onClick={() => setAddingRow(false)}>✕</Button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {rows.length === 0 && !addingRow && <p className="py-6 text-center text-xs text-muted-foreground">No rows yet.</p>}
      </div>
    </div>
  );
}
