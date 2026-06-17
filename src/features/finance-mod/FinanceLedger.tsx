import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Lock, Scale, Landmark, TrendingUp, TrendingDown, Plus } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
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

// ── General ledger: chart of accounts + double-entry journal + monthly close ──
export function FinanceLedgerPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: accounts } = useTbl<any>("fin_accounts", "fin_accounts", "code");
  const { data: entries } = useTbl<any>("fin_journal_entries", "fin_journal_entries", "entry_date");
  const { data: periods } = useTbl<any>("fin_periods", "fin_periods");
  const [acctOpen, setAcctOpen] = useState(false);
  const [jeOpen, setJeOpen] = useState(false);
  const [acctForm, setAcctForm] = useState({ code: "", name: "", type: "expense" });
  const [je, setJe] = useState({ reference: "", memo: "", debit_account: "", credit_account: "", amount: "0" });

  async function addAccount() {
    if (!workspaceId || !projectId || !user || !acctForm.code.trim() || !acctForm.name.trim()) return;
    const { error } = await supabase.from("fin_accounts").insert({ workspace_id: workspaceId, project_id: projectId, code: acctForm.code.trim(), name: acctForm.name.trim(), type: acctForm.type });
    if (error) { alert(error.message); return; }
    setAcctForm({ code: "", name: "", type: "expense" }); setAcctOpen(false);
    queryClient.invalidateQueries({ queryKey: ["fin_accounts", projectId] });
  }
  async function addEntry() {
    if (!workspaceId || !projectId || !user || !je.debit_account || !je.credit_account) return;
    const amount = Math.round((Number(je.amount) || 0) * 100);
    const { data: entry, error } = await supabase.from("fin_journal_entries").insert({
      workspace_id: workspaceId, project_id: projectId, created_by: user.id,
      reference: je.reference.trim() || null, memo: je.memo.trim() || null, status: "posted", source_kind: "manual",
    }).select("id").single();
    if (error || !entry) { alert(error?.message); return; }
    await supabase.from("fin_journal_lines").insert([
      { workspace_id: workspaceId, entry_id: entry.id, account_id: je.debit_account, debit_cents: amount, credit_cents: 0 },
      { workspace_id: workspaceId, entry_id: entry.id, account_id: je.credit_account, debit_cents: 0, credit_cents: amount },
    ]);
    await supabase.from("fin_audit_log").insert({ workspace_id: workspaceId, project_id: projectId, actor: user.id, action: "journal.posted", entity_kind: "journal_entry", entity_id: entry.id, detail: { amount } });
    setJe({ reference: "", memo: "", debit_account: "", credit_account: "", amount: "0" }); setJeOpen(false);
    queryClient.invalidateQueries({ queryKey: ["fin_journal_entries", projectId] });
  }
  async function closePeriod() {
    if (!workspaceId || !projectId || !user) return;
    const label = new Date().toISOString().slice(0, 7);
    await supabase.from("fin_periods").insert({ workspace_id: workspaceId, project_id: projectId, label, status: "closed", closed_at: new Date().toISOString(), closed_by: user.id });
    await supabase.from("fin_audit_log").insert({ workspace_id: workspaceId, project_id: projectId, actor: user.id, action: "period.closed", entity_kind: "period", detail: { label } });
    queryClient.invalidateQueries({ queryKey: ["fin_periods", projectId] });
  }

  return (
    <div className="space-y-5">
      <PageHeader title="General ledger" description="Chart of accounts, double-entry journal and monthly close (multi-entity ready)."
        actions={<div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setAcctOpen(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Account</Button><Button size="sm" onClick={() => setJeOpen(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Journal entry</Button></div>} />
      <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><BookOpen className="h-4 w-4 text-muted-foreground" /> Chart of accounts</div>
          {(accounts ?? []).length === 0 ? <p className="rounded-lg border border-dashed border-border py-6 text-center text-xs text-muted-foreground">No accounts yet.</p>
          : <div className="space-y-1">{(accounts ?? []).map((a: any) => (
              <div key={a.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
                <span className="font-mono text-muted-foreground">{a.code}</span><span className="truncate">{a.name}</span>
                <Badge variant="outline" className="ml-auto text-[9px] capitalize">{a.type}</Badge>
              </div>))}</div>}
          <div className="mt-4 flex items-center justify-between rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs">
            <span className="inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5 text-muted-foreground" /> {(periods ?? []).filter((p: any) => p.status === "closed").length} closed</span>
            <button onClick={closePeriod} className="rounded border border-border px-2 py-0.5 hover:bg-secondary">Close month</button>
          </div>
        </div>
        <div>
          <div className="mb-2 text-sm font-semibold">Journal</div>
          {(entries ?? []).length === 0 ? <EmptyState icon={BookOpen} title="No entries" description="Post your first journal entry." />
          : <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[520px] text-sm"><thead className="border-b border-border bg-secondary/30 text-xs uppercase tracking-wider text-muted-foreground"><tr><th className="px-4 py-3 text-left">Date</th><th className="px-4 py-3 text-left">Reference</th><th className="px-4 py-3 text-left">Memo</th><th className="px-4 py-3 text-left">Source</th><th className="px-4 py-3 text-left">Status</th></tr></thead>
              <tbody className="divide-y divide-border">{(entries ?? []).map((e: any) => (
                <tr key={e.id} className="hover:bg-secondary/30"><td className="px-4 py-3 text-muted-foreground">{new Date(e.entry_date).toLocaleDateString()}</td><td className="px-4 py-3 font-medium">{e.reference ?? "—"}</td><td className="px-4 py-3 text-muted-foreground">{e.memo ?? "—"}</td><td className="px-4 py-3"><Badge variant="outline" className="text-[10px] capitalize">{e.source_kind ?? "manual"}</Badge></td><td className="px-4 py-3 capitalize">{e.status}</td></tr>))}
              </tbody></table>
            </div>}
        </div>
      </div>

      <Dialog open={acctOpen} onOpenChange={setAcctOpen}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>New account</DialogTitle></DialogHeader>
        <div className="space-y-3"><div className="grid grid-cols-2 gap-3"><Field label="Code"><Input value={acctForm.code} onChange={(e) => setAcctForm({ ...acctForm, code: e.target.value })} placeholder="401" /></Field>
        <Field label="Type"><select value={acctForm.type} onChange={(e) => setAcctForm({ ...acctForm, type: e.target.value })} className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm">{["asset", "liability", "equity", "revenue", "expense"].map((t) => <option key={t} value={t}>{t}</option>)}</select></Field></div>
        <Field label="Name"><Input value={acctForm.name} onChange={(e) => setAcctForm({ ...acctForm, name: e.target.value })} /></Field></div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setAcctOpen(false)}>Cancel</Button><Button onClick={addAccount}>Add</Button></div></DialogContent></Dialog>

      <Dialog open={jeOpen} onOpenChange={setJeOpen}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>Journal entry</DialogTitle></DialogHeader>
        <div className="space-y-3"><Field label="Reference"><Input value={je.reference} onChange={(e) => setJe({ ...je, reference: e.target.value })} /></Field>
        <Field label="Debit account"><select value={je.debit_account} onChange={(e) => setJe({ ...je, debit_account: e.target.value })} className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"><option value="">{"— select —"}</option>{(accounts ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>
        <Field label="Credit account"><select value={je.credit_account} onChange={(e) => setJe({ ...je, credit_account: e.target.value })} className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm"><option value="">{"— select —"}</option>{(accounts ?? []).map((a: any) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>
        <Field label="Amount"><Input type="number" step="0.01" value={je.amount} onChange={(e) => setJe({ ...je, amount: e.target.value })} /></Field>
        <Field label="Memo"><Input value={je.memo} onChange={(e) => setJe({ ...je, memo: e.target.value })} /></Field></div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setJeOpen(false)}>Cancel</Button><Button onClick={addEntry} disabled={!je.debit_account || !je.credit_account}>Post</Button></div></DialogContent></Dialog>
    </div>
  );
}

// ── Reporting: P&L / balance sheet / cash flow (real-time from finance data) ──
export function FinanceReportingPage() {
  const { data: invoices } = useTbl<any>("fin_invoices", "fin_invoices_rep");
  const { data: bills } = useTbl<any>("fin_bills", "fin_bills_rep");
  const { data: expenses } = useTbl<any>("fin_expenses", "fin_expenses_rep");
  const { data: accts } = useTbl<any>("fin_bank_accounts", "fin_bank_accounts_rep");
  const { data: budgets } = useTbl<any>("fin_budgets", "fin_budgets_rep");

  const r = useMemo(() => {
    const revenue = (invoices ?? []).filter((i: any) => i.status === "paid").reduce((s: number, i: any) => s + i.amount_cents, 0);
    const cogs = (bills ?? []).filter((b: any) => b.status === "paid").reduce((s: number, b: any) => s + b.amount_cents, 0);
    const opex = (expenses ?? []).filter((e: any) => ["approved", "reimbursed"].includes(e.status)).reduce((s: number, e: any) => s + e.amount_cents, 0);
    const cash = (accts ?? []).reduce((s: number, a: any) => s + a.balance_cents, 0);
    const ar = (invoices ?? []).filter((i: any) => !["paid", "void"].includes(i.status)).reduce((s: number, i: any) => s + i.amount_cents, 0);
    const ap = (bills ?? []).filter((b: any) => !["paid", "void"].includes(b.status)).reduce((s: number, b: any) => s + b.amount_cents, 0);
    const grossProfit = revenue - cogs;
    const netIncome = grossProfit - opex;
    const budget = (budgets ?? []).reduce((s: number, b: any) => s + (b.amount_cents ?? b.limit_cents ?? 0), 0);
    return { revenue, cogs, opex, grossProfit, netIncome, cash, ar, ap, budget };
  }, [invoices, bills, expenses, accts, budgets]);

  const Row = ({ label, value, bold, sign }: { label: string; value: number; bold?: boolean; sign?: boolean }) => (
    <div className={cn("flex items-center justify-between py-1.5 text-sm", bold && "border-t border-border pt-2 font-semibold")}>
      <span className={bold ? "" : "text-muted-foreground"}>{label}</span>
      <span className={cn("tabular-nums", sign && value < 0 && "text-destructive", sign && value > 0 && "text-emerald-500")}>{money(value)}</span>
    </div>
  );

  return (
    <div className="space-y-5">
      <PageHeader title="Financial reporting" description="Income statement, balance sheet snapshot and cash flow — real-time from your finance data." />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Scale className="h-4 w-4 text-primary" /> Income statement</div>
          <Row label="Revenue" value={r.revenue} />
          <Row label="Cost of goods (paid bills)" value={-r.cogs} />
          <Row label="Gross profit" value={r.grossProfit} bold />
          <Row label="Operating expenses" value={-r.opex} />
          <Row label="Net income" value={r.netIncome} bold sign />
          {r.budget > 0 && <div className="mt-2 text-[11px] text-muted-foreground">Budget vs actual opex: {money(r.opex)} / {money(r.budget)} ({Math.round(r.opex / r.budget * 100)}%)</div>}
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Landmark className="h-4 w-4 text-primary" /> Balance sheet</div>
          <Row label="Cash" value={r.cash} />
          <Row label="Accounts receivable" value={r.ar} />
          <Row label="Total assets" value={r.cash + r.ar} bold />
          <Row label="Accounts payable" value={r.ap} />
          <Row label="Net position" value={r.cash + r.ar - r.ap} bold sign />
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><TrendingUp className="h-4 w-4 text-primary" /> Cash flow</div>
          <Row label="Collected (paid invoices)" value={r.revenue} />
          <Row label="Paid out (bills)" value={-r.cogs} />
          <Row label="Expenses" value={-r.opex} />
          <Row label="Net cash flow" value={r.netIncome} bold sign />
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {r.netIncome >= 0 ? <TrendingUp className="h-3 w-3 text-emerald-500" /> : <TrendingDown className="h-3 w-3 text-destructive" />}
            {r.netIncome >= 0 ? "Cash-positive period" : "Cash-negative period"}
          </div>
        </div>
      </div>
    </div>
  );
}
