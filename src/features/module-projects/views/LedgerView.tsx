import { useState } from "react";
import { Plus, Trash2, Landmark, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";

interface LedgerEntry { id: string; date: string; label: string; debit: number; credit: number; category?: string }

export function LedgerView({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const entries: LedgerEntry[] = (mp.metadata as any)?.ledger_entries ?? [];
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ date: new Date().toISOString().slice(0, 10), label: "", debit: "", credit: "", category: "" });

  async function save(next: LedgerEntry[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, ledger_entries: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function add() {
    if (!form.label.trim()) return;
    save([...entries, { id: crypto.randomUUID(), date: form.date, label: form.label.trim(), debit: Number(form.debit) || 0, credit: Number(form.credit) || 0, category: form.category.trim() || undefined }]);
    setForm({ date: new Date().toISOString().slice(0, 10), label: "", debit: "", credit: "", category: "" });
    setAdding(false);
  }

  const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
  const totalCredit = entries.reduce((s, e) => s + e.credit, 0);
  const balance = totalDebit - totalCredit;
  const fmt = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="space-y-4 py-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><Landmark className="h-4 w-4 text-muted-foreground" /> Ledger</h3>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add entry</Button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><ArrowDownRight className="h-3.5 w-3.5 text-emerald-500" /> Debit</div>
          <div className="mt-1 text-lg font-bold">{fmt(totalDebit)} €</div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><ArrowUpRight className="h-3.5 w-3.5 text-destructive" /> Credit</div>
          <div className="mt-1 text-lg font-bold">{fmt(totalCredit)} €</div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">Balance</div>
          <div className={`mt-1 text-lg font-bold ${balance >= 0 ? "text-emerald-500" : "text-destructive"}`}>{balance >= 0 ? "+" : ""}{fmt(balance)} €</div>
        </div>
      </div>

      {adding && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Description" autoFocus />
            <Input type="number" value={form.debit} onChange={(e) => setForm({ ...form, debit: e.target.value })} placeholder="Debit (€)" />
            <Input type="number" value={form.credit} onChange={(e) => setForm({ ...form, credit: e.target.value })} placeholder="Credit (€)" />
          </div>
          <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Category (optional)" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={!form.label.trim()}>Add</Button>
          </div>
        </div>
      )}

      {/* Entries table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/40 text-xs text-muted-foreground">
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-left">Description</th>
              <th className="px-3 py-2 text-left">Category</th>
              <th className="px-3 py-2 text-right">Debit</th>
              <th className="px-3 py-2 text-right">Credit</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="group border-b border-border last:border-0 hover:bg-secondary/20">
                <td className="px-3 py-2 text-xs text-muted-foreground">{e.date}</td>
                <td className="px-3 py-2 text-xs">{e.label}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{e.category ?? "—"}</td>
                <td className="px-3 py-2 text-xs text-right font-mono">{e.debit > 0 ? fmt(e.debit) : "—"}</td>
                <td className="px-3 py-2 text-xs text-right font-mono">{e.credit > 0 ? fmt(e.credit) : "—"}</td>
                <td className="px-2"><button onClick={() => save(entries.filter((x) => x.id !== e.id))} className="hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"><Trash2 className="h-3 w-3" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && !adding && <p className="py-6 text-center text-xs text-muted-foreground">No entries yet.</p>}
      </div>
    </div>
  );
}
