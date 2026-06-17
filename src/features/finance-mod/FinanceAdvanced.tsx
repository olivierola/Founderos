import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Plus, Trash2, Link2, AlertTriangle, CheckCircle2, Banknote, Landmark, FileWarning,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

function money(cents: number, cur = "eur") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: cur.toUpperCase(), maximumFractionDigits: 0 }).format((cents || 0) / 100);
}
function useTbl<T>(table: string, key: string, order = "created_at") {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: [key, projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from(table).select("*").eq("project_id", projectId!).order(order, { ascending: false }).limit(1000);
      return (data ?? []) as T[];
    },
  });
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label className="text-xs font-medium text-muted-foreground">{label}</label>{children}</div>;
}

// ============================================================== ACCOUNTS PAYABLE (bills + 3-way match)
const BILL_STATUS: Record<string, string> = {
  received: "bg-zinc-500/15 text-zinc-500", matched: "bg-sky-500/15 text-sky-500", approved: "bg-violet-500/15 text-violet-500",
  paid: "bg-emerald-500/15 text-emerald-500", disputed: "bg-amber-500/15 text-amber-600", void: "bg-destructive/15 text-destructive",
};
export function FinanceBillsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: bills, isLoading } = useTbl<any>("fin_bills", "fin_bills");
  const { data: pos } = useTbl<any>("sc_purchase_orders", "sc_purchase_orders");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ number: "", vendor: "", amount: "0", due_date: "", po_id: "" });

  const poById = useMemo(() => Object.fromEntries((pos ?? []).map((p: any) => [p.id, p])), [pos]);

  async function create() {
    if (!workspaceId || !projectId || !user || !form.vendor.trim()) return;
    const amount = Math.round((Number(form.amount) || 0) * 100);
    // Auto 3-way match: matched if a linked PO exists and totals are within 1%.
    let match_status = "unmatched";
    if (form.po_id) {
      const po = poById[form.po_id];
      match_status = po && Math.abs((po.total_cents || 0) - amount) <= Math.max(100, amount * 0.01) ? "matched" : "exception";
    }
    const { error } = await supabase.from("fin_bills").insert({
      workspace_id: workspaceId, project_id: projectId, created_by: user.id,
      number: form.number.trim() || null, vendor: form.vendor.trim(), amount_cents: amount,
      due_date: form.due_date || null, po_id: form.po_id || null, match_status,
      status: match_status === "matched" ? "matched" : "received",
    });
    if (error) { alert(error.message); return; }
    setForm({ number: "", vendor: "", amount: "0", due_date: "", po_id: "" }); setOpen(false);
    queryClient.invalidateQueries({ queryKey: ["fin_bills", projectId] });
  }
  async function setStatus(id: string, status: string) {
    const patch: any = { status }; if (status === "paid") patch.paid_date = new Date().toISOString().slice(0, 10);
    await supabase.from("fin_bills").update(patch).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["fin_bills", projectId] });
  }
  async function remove(id: string) {
    if (!confirm("Delete this bill?")) return;
    await supabase.from("fin_bills").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["fin_bills", projectId] });
  }

  const totals = useMemo(() => {
    const b = bills ?? [];
    return {
      due: b.filter((x) => !["paid", "void"].includes(x.status)).reduce((s, x) => s + x.amount_cents, 0),
      exceptions: b.filter((x) => x.match_status === "exception").length,
      matched: b.filter((x) => x.match_status === "matched").length,
    };
  }, [bills]);

  return (
    <div className="space-y-5">
      <PageHeader title="Accounts payable" description="Vendor bills with 3-way match against supply purchase orders."
        actions={<Button onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" /> New bill</Button>} />
      <div className="grid grid-cols-3 gap-4">
        <MetricCard label="Outstanding" value={money(totals.due)} icon={Banknote} />
        <MetricCard label="Matched (3-way)" value={String(totals.matched)} icon={CheckCircle2} />
        <MetricCard label="Match exceptions" value={String(totals.exceptions)} icon={FileWarning} />
      </div>

      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      : (bills ?? []).length === 0 ? <EmptyState icon={Banknote} title="No bills" description="Capture your first vendor bill." />
      : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-border bg-secondary/30 text-xs uppercase tracking-wider text-muted-foreground">
              <tr><th className="px-4 py-3 text-left">Vendor</th><th className="px-4 py-3 text-left">Bill #</th><th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3 text-left">PO match</th><th className="px-4 py-3 text-left">Due</th><th className="px-4 py-3 text-left">Status</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(bills ?? []).map((b) => (
                <tr key={b.id} className="group hover:bg-secondary/30">
                  <td className="px-4 py-3 font-medium">{b.vendor}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{b.number ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(b.amount_cents, b.currency)}</td>
                  <td className="px-4 py-3">
                    {b.po_id ? (
                      <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                        b.match_status === "matched" ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-600")}>
                        <Link2 className="h-3 w-3" /> {poById[b.po_id]?.reference ?? "PO"} · {b.match_status}
                      </span>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{b.due_date ? new Date(b.due_date).toLocaleDateString() : "—"}</td>
                  <td className="px-4 py-3">
                    <select value={b.status} onChange={(e) => setStatus(b.id, e.target.value)} className={cn("rounded-full border-0 px-2 py-1 text-xs font-medium", BILL_STATUS[b.status])}>
                      {Object.keys(BILL_STATUS).map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-right"><button onClick={() => remove(b.id)} className="opacity-0 transition-opacity group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5 text-destructive" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New vendor bill</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label="Vendor"><Input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} autoFocus /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Bill #"><Input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} /></Field>
              <Field label="Amount"><Input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
            </div>
            <Field label="Match to purchase order (3-way)">
              <select value={form.po_id} onChange={(e) => setForm({ ...form, po_id: e.target.value })} className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm">
                <option value="">— none —</option>
                {(pos ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.reference} · {money(p.total_cents, p.currency)}</option>)}
              </select>
            </Field>
            <Field label="Due date"><Input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={create} disabled={!form.vendor.trim()}>Capture bill</Button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================== TREASURY (accounts + txns)
export function FinanceTreasuryPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: accounts } = useTbl<any>("fin_bank_accounts", "fin_bank_accounts");
  const [active, setActive] = useState<string | null>(null);
  const [acctOpen, setAcctOpen] = useState(false);
  const [txnOpen, setTxnOpen] = useState(false);
  const [acctForm, setAcctForm] = useState({ name: "", iban: "", balance: "0" });
  const [txnForm, setTxnForm] = useState({ amount: "0", description: "", date: new Date().toISOString().slice(0, 10) });

  const activeId = active ?? (accounts ?? [])[0]?.id ?? null;
  const { data: txns } = useQuery({
    queryKey: ["fin_bank_txns", activeId],
    enabled: !!activeId,
    queryFn: async () => {
      const { data } = await supabase.from("fin_bank_txns").select("*").eq("account_id", activeId!).order("occurred_on", { ascending: false }).limit(200);
      return (data ?? []) as any[];
    },
  });

  const totalCash = (accounts ?? []).reduce((s, a) => s + a.balance_cents, 0);

  async function createAccount() {
    if (!workspaceId || !projectId || !user || !acctForm.name.trim()) return;
    const { error } = await supabase.from("fin_bank_accounts").insert({
      workspace_id: workspaceId, project_id: projectId, created_by: user.id,
      name: acctForm.name.trim(), iban_last4: acctForm.iban.trim().slice(-4) || null,
      balance_cents: Math.round((Number(acctForm.balance) || 0) * 100),
    });
    if (error) { alert(error.message); return; }
    setAcctForm({ name: "", iban: "", balance: "0" }); setAcctOpen(false);
    queryClient.invalidateQueries({ queryKey: ["fin_bank_accounts", projectId] });
  }
  async function createTxn() {
    if (!workspaceId || !activeId) return;
    const delta = Math.round((Number(txnForm.amount) || 0) * 100);
    const { error } = await supabase.from("fin_bank_txns").insert({
      workspace_id: workspaceId, account_id: activeId, amount_cents: delta,
      description: txnForm.description.trim() || null, occurred_on: txnForm.date,
    });
    if (error) { alert(error.message); return; }
    // Keep the running balance in sync.
    const acct = (accounts ?? []).find((a) => a.id === activeId);
    if (acct) await supabase.from("fin_bank_accounts").update({ balance_cents: acct.balance_cents + delta }).eq("id", activeId);
    setTxnForm({ amount: "0", description: "", date: new Date().toISOString().slice(0, 10) }); setTxnOpen(false);
    queryClient.invalidateQueries({ queryKey: ["fin_bank_txns", activeId] });
    queryClient.invalidateQueries({ queryKey: ["fin_bank_accounts", projectId] });
  }
  async function toggleReconcile(t: any) {
    await supabase.from("fin_bank_txns").update({ reconciled: !t.reconciled }).eq("id", t.id);
    queryClient.invalidateQueries({ queryKey: ["fin_bank_txns", activeId] });
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Treasury" description="Real-time cash position across bank accounts, with reconciliation."
        actions={<Button onClick={() => setAcctOpen(true)}><Plus className="mr-1 h-4 w-4" /> Add account</Button>} />
      <div className="grid grid-cols-3 gap-4">
        <MetricCard label="Total cash" value={money(totalCash)} icon={Landmark} />
        <MetricCard label="Accounts" value={String((accounts ?? []).length)} icon={Banknote} />
        <MetricCard label="Unreconciled" value={String((txns ?? []).filter((t) => !t.reconciled).length)} icon={AlertTriangle} />
      </div>

      {(accounts ?? []).length === 0 ? <EmptyState icon={Landmark} title="No bank accounts" description="Add an account to track cash." />
      : (
        <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
          <div className="space-y-2">
            {(accounts ?? []).map((a) => (
              <button key={a.id} onClick={() => setActive(a.id)}
                className={cn("flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors", activeId === a.id ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30")}>
                <div><div className="text-sm font-medium">{a.name}</div><div className="text-[11px] text-muted-foreground">{a.iban_last4 ? `••${a.iban_last4}` : ""}</div></div>
                <div className="text-sm font-semibold tabular-nums">{money(a.balance_cents, a.currency)}</div>
              </button>
            ))}
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">Transactions</span>
              <Button size="sm" variant="outline" onClick={() => setTxnOpen(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add txn</Button>
            </div>
            {(txns ?? []).length === 0 ? <p className="rounded-lg border border-dashed border-border py-8 text-center text-xs text-muted-foreground">No transactions.</p>
            : (
              <div className="space-y-1.5">
                {(txns ?? []).map((t) => (
                  <div key={t.id} className="flex items-center gap-3 rounded-lg border border-border p-2.5">
                    <button onClick={() => toggleReconcile(t)} title="Reconcile"
                      className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded", t.reconciled ? "bg-emerald-500/15 text-emerald-500" : "border border-border text-transparent hover:text-muted-foreground")}>
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    </button>
                    <div className="min-w-0 flex-1"><div className="truncate text-sm">{t.description ?? "—"}</div><div className="text-[11px] text-muted-foreground">{new Date(t.occurred_on).toLocaleDateString()}</div></div>
                    <div className={cn("text-sm font-medium tabular-nums", t.amount_cents >= 0 ? "text-emerald-500" : "text-destructive")}>{t.amount_cents >= 0 ? "+" : ""}{money(t.amount_cents)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <Dialog open={acctOpen} onOpenChange={setAcctOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add bank account</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label="Name"><Input value={acctForm.name} onChange={(e) => setAcctForm({ ...acctForm, name: e.target.value })} autoFocus /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="IBAN (last 4)"><Input value={acctForm.iban} onChange={(e) => setAcctForm({ ...acctForm, iban: e.target.value })} /></Field>
              <Field label="Opening balance"><Input type="number" step="0.01" value={acctForm.balance} onChange={(e) => setAcctForm({ ...acctForm, balance: e.target.value })} /></Field>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setAcctOpen(false)}>Cancel</Button><Button onClick={createAccount} disabled={!acctForm.name.trim()}>Add</Button></div>
        </DialogContent>
      </Dialog>
      <Dialog open={txnOpen} onOpenChange={setTxnOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add transaction</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label="Amount (+ in / − out)"><Input type="number" step="0.01" value={txnForm.amount} onChange={(e) => setTxnForm({ ...txnForm, amount: e.target.value })} autoFocus /></Field>
            <Field label="Description"><Input value={txnForm.description} onChange={(e) => setTxnForm({ ...txnForm, description: e.target.value })} /></Field>
            <Field label="Date"><Input type="date" value={txnForm.date} onChange={(e) => setTxnForm({ ...txnForm, date: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setTxnOpen(false)}>Cancel</Button><Button onClick={createTxn}>Add</Button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
