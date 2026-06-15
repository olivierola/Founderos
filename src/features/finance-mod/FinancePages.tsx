import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Wallet, Loader2, Plus, Trash2, Receipt, FileText, PiggyBank, Check, X,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

interface Invoice {
  id: string; number: string | null; client_name: string; amount_cents: number; currency: string;
  status: "draft" | "sent" | "paid" | "overdue" | "void"; issued_date: string | null; due_date: string | null; paid_date: string | null; created_at: string;
}
interface Expense {
  id: string; vendor: string | null; category: string | null; amount_cents: number; currency: string;
  spent_on: string | null; status: "pending" | "approved" | "reimbursed" | "rejected"; created_at: string;
}
interface Budget { id: string; category: string; period: string | null; amount_cents: number; currency: string }

const INV_STATUS: Record<Invoice["status"], string> = {
  draft: "bg-muted text-muted-foreground", sent: "bg-sky-500/15 text-sky-600",
  paid: "bg-emerald-500/15 text-emerald-600", overdue: "bg-destructive/15 text-destructive", void: "bg-muted text-muted-foreground",
};
const EXP_STATUS: Record<Expense["status"], string> = {
  pending: "bg-amber-500/15 text-amber-600", approved: "bg-sky-500/15 text-sky-600",
  reimbursed: "bg-emerald-500/15 text-emerald-600", rejected: "bg-destructive/15 text-destructive",
};
function money(cents: number, cur = "eur") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: cur.toUpperCase(), maximumFractionDigits: 0 }).format(cents / 100);
}

function useInvoices() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["fin_invoices", projectId], enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("fin_invoices").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Invoice[];
    },
  });
}
function useExpenses() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["fin_expenses", projectId], enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("fin_expenses").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Expense[];
    },
  });
}

// =================================================================== OVERVIEW
export function FinanceOverviewPage() {
  const { data: invoices } = useInvoices();
  const { data: expenses } = useExpenses();
  const stats = useMemo(() => {
    const inv = invoices ?? [], exp = expenses ?? [];
    const revenue = inv.filter((i) => i.status === "paid").reduce((s, i) => s + i.amount_cents, 0);
    const outstanding = inv.filter((i) => ["sent", "overdue"].includes(i.status)).reduce((s, i) => s + i.amount_cents, 0);
    const spend = exp.filter((e) => e.status !== "rejected").reduce((s, e) => s + e.amount_cents, 0);
    // Monthly revenue vs expenses chart.
    const months: Record<string, { month: string; revenue: number; expenses: number }> = {};
    const bump = (d: string | null, key: "revenue" | "expenses", cents: number) => {
      const m = (d ?? "").slice(0, 7); if (!m) return;
      months[m] ??= { month: m, revenue: 0, expenses: 0 }; months[m][key] += cents / 100;
    };
    inv.forEach((i) => { if (i.status === "paid") bump(i.paid_date ?? i.issued_date, "revenue", i.amount_cents); });
    exp.forEach((e) => bump(e.spent_on, "expenses", e.amount_cents));
    const chart = Object.values(months).sort((a, b) => a.month.localeCompare(b.month)).slice(-8);
    return { revenue, outstanding, spend, net: revenue - spend, chart };
  }, [invoices, expenses]);

  return (
    <div className="space-y-6">
      <PageHeader title="Finance — Overview" description="Revenue, spend and cash position." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Revenue (paid)" value={money(stats.revenue)} icon={Wallet} />
        <MetricCard label="Outstanding" value={money(stats.outstanding)} icon={FileText} />
        <MetricCard label="Expenses" value={money(stats.spend)} icon={Receipt} />
        <MetricCard label="Net" value={money(stats.net)} icon={PiggyBank} />
      </div>
      {stats.chart.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Revenue vs expenses</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={stats.chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" width={48} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="revenue" fill="#15aabf" radius={[3, 3, 0, 0]} />
                <Bar dataKey="expenses" fill="#CB2957" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// =================================================================== INVOICES
export function FinanceInvoicesPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: invoices, isLoading } = useInvoices();
  const [open, setOpen] = useState(false);

  async function setStatus(id: string, status: Invoice["status"]) {
    await supabase.from("fin_invoices").update({ status, paid_date: status === "paid" ? new Date().toISOString().slice(0, 10) : null }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["fin_invoices", projectId] });
  }
  async function remove(id: string) { await supabase.from("fin_invoices").delete().eq("id", id); queryClient.invalidateQueries({ queryKey: ["fin_invoices", projectId] }); }

  return (
    <div className="space-y-5">
      <PageHeader title="Invoices" description="Bill clients and track payments." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New invoice</Button>} />
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (invoices ?? []).length === 0 ? <EmptyState icon={FileText} title="No invoices" description="Create your first invoice." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New invoice</Button>} />
        : (
          <Card><CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                <tr><th className="px-4 py-2">Client</th><th className="px-4 py-2">#</th><th className="px-4 py-2">Due</th><th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2">Status</th><th className="px-4 py-2" /></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(invoices ?? []).map((i) => (
                  <tr key={i.id} className="group">
                    <td className="px-4 py-2 font-medium">{i.client_name}</td>
                    <td className="px-4 py-2 text-muted-foreground">{i.number || "—"}</td>
                    <td className="px-4 py-2 text-muted-foreground">{i.due_date || "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(i.amount_cents, i.currency)}</td>
                    <td className="px-4 py-2">
                      <select value={i.status} onChange={(e) => setStatus(i.id, e.target.value as Invoice["status"])} className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", INV_STATUS[i.status])}>
                        {["draft", "sent", "paid", "overdue", "void"].map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-2 text-right"><button onClick={() => remove(i.id)} className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"><Trash2 className="h-4 w-4" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent></Card>
        )}

      <InvoiceDialog open={open} onOpenChange={setOpen} onCreate={async (d) => {
        if (!workspaceId || !projectId || !user) return;
        await supabase.from("fin_invoices").insert({ ...d, workspace_id: workspaceId, project_id: projectId, created_by: user.id });
        queryClient.invalidateQueries({ queryKey: ["fin_invoices", projectId] });
        setOpen(false);
      }} />
    </div>
  );
}

function InvoiceDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: Partial<Invoice>) => Promise<void> }) {
  const [d, setD] = useState<Partial<Invoice>>({ status: "draft", currency: "eur", amount_cents: 0 });
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.client_name?.trim()) return; setSaving(true); try { await onCreate(d); setD({ status: "draft", currency: "eur", amount_cents: 0 }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New invoice</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <FF label="Client" full><Input value={d.client_name ?? ""} onChange={(e) => setD((p) => ({ ...p, client_name: e.target.value }))} autoFocus /></FF>
          <FF label="Number"><Input value={d.number ?? ""} onChange={(e) => setD((p) => ({ ...p, number: e.target.value }))} placeholder="INV-001" /></FF>
          <FF label="Amount (€)"><Input type="number" value={d.amount_cents ? d.amount_cents / 100 : ""} onChange={(e) => setD((p) => ({ ...p, amount_cents: Math.round(Number(e.target.value) * 100) }))} /></FF>
          <FF label="Issued"><Input type="date" value={d.issued_date ?? ""} onChange={(e) => setD((p) => ({ ...p, issued_date: e.target.value }))} /></FF>
          <FF label="Due"><Input type="date" value={d.due_date ?? ""} onChange={(e) => setD((p) => ({ ...p, due_date: e.target.value }))} /></FF>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Create</Button></div>
      </DialogContent>
    </Dialog>
  );
}

// =================================================================== EXPENSES
export function FinanceExpensesPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: expenses, isLoading } = useExpenses();
  const [open, setOpen] = useState(false);
  async function decide(id: string, status: Expense["status"]) { await supabase.from("fin_expenses").update({ status }).eq("id", id); queryClient.invalidateQueries({ queryKey: ["fin_expenses", projectId] }); }

  return (
    <div className="space-y-5">
      <PageHeader title="Expenses" description="Track and approve spend." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New expense</Button>} />
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (expenses ?? []).length === 0 ? <EmptyState icon={Receipt} title="No expenses" description="Log an expense to start." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New expense</Button>} />
        : (
          <Card><CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                <tr><th className="px-4 py-2">Vendor</th><th className="px-4 py-2">Category</th><th className="px-4 py-2">Date</th><th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2">Status</th><th className="px-4 py-2" /></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(expenses ?? []).map((x) => (
                  <tr key={x.id}>
                    <td className="px-4 py-2 font-medium">{x.vendor || "—"}</td>
                    <td className="px-4 py-2 text-muted-foreground">{x.category || "—"}</td>
                    <td className="px-4 py-2 text-muted-foreground">{x.spent_on || "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(x.amount_cents, x.currency)}</td>
                    <td className="px-4 py-2"><span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", EXP_STATUS[x.status])}>{x.status}</span></td>
                    <td className="px-4 py-2 text-right">
                      {x.status === "pending" && (
                        <div className="flex justify-end gap-1">
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-600" onClick={() => decide(x.id, "approved")}><Check className="h-3.5 w-3.5" /></Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => decide(x.id, "rejected")}><X className="h-3.5 w-3.5" /></Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent></Card>
        )}

      <ExpenseDialog open={open} onOpenChange={setOpen} onCreate={async (d) => {
        if (!workspaceId || !projectId || !user) return;
        await supabase.from("fin_expenses").insert({ ...d, workspace_id: workspaceId, project_id: projectId, created_by: user.id });
        queryClient.invalidateQueries({ queryKey: ["fin_expenses", projectId] });
        setOpen(false);
      }} />
    </div>
  );
}

function ExpenseDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: Partial<Expense>) => Promise<void> }) {
  const [d, setD] = useState<Partial<Expense>>({ status: "pending", currency: "eur", amount_cents: 0 });
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.amount_cents) return; setSaving(true); try { await onCreate(d); setD({ status: "pending", currency: "eur", amount_cents: 0 }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New expense</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <FF label="Vendor"><Input value={d.vendor ?? ""} onChange={(e) => setD((p) => ({ ...p, vendor: e.target.value }))} autoFocus /></FF>
          <FF label="Category"><Input value={d.category ?? ""} onChange={(e) => setD((p) => ({ ...p, category: e.target.value }))} /></FF>
          <FF label="Amount (€)"><Input type="number" value={d.amount_cents ? d.amount_cents / 100 : ""} onChange={(e) => setD((p) => ({ ...p, amount_cents: Math.round(Number(e.target.value) * 100) }))} /></FF>
          <FF label="Date"><Input type="date" value={d.spent_on ?? ""} onChange={(e) => setD((p) => ({ ...p, spent_on: e.target.value }))} /></FF>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Create</Button></div>
      </DialogContent>
    </Dialog>
  );
}

// ==================================================================== BUDGETS
export function FinanceBudgetsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: budgets, isLoading } = useQuery({
    queryKey: ["fin_budgets", projectId], enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("fin_budgets").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Budget[];
    },
  });
  const { data: expenses } = useExpenses();
  const spentByCat = useMemo(() => {
    const m = new Map<string, number>();
    (expenses ?? []).forEach((e) => { if (e.category && e.status !== "rejected") m.set(e.category, (m.get(e.category) ?? 0) + e.amount_cents); });
    return m;
  }, [expenses]);

  async function remove(id: string) { await supabase.from("fin_budgets").delete().eq("id", id); queryClient.invalidateQueries({ queryKey: ["fin_budgets", projectId] }); }

  return (
    <div className="space-y-5">
      <PageHeader title="Budgets" description="Set budgets per category and track usage." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New budget</Button>} />
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (budgets ?? []).length === 0 ? <EmptyState icon={PiggyBank} title="No budgets" description="Define a budget per category." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New budget</Button>} />
        : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(budgets ?? []).map((b) => {
              const spent = spentByCat.get(b.category) ?? 0;
              const pct = b.amount_cents ? Math.min(100, Math.round((spent / b.amount_cents) * 100)) : 0;
              const over = spent > b.amount_cents;
              return (
                <Card key={b.id} className="group"><CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{b.category}</span>
                    <button onClick={() => remove(b.id)} className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"><Trash2 className="h-4 w-4" /></button>
                  </div>
                  {b.period && <Badge variant="outline" className="mt-1 text-[10px]">{b.period}</Badge>}
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                    <div className={cn("h-full rounded-full", over ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
                    <span className={cn(over && "text-destructive")}>{money(spent, b.currency)} spent</span>
                    <span>{money(b.amount_cents, b.currency)}</span>
                  </div>
                </CardContent></Card>
              );
            })}
          </div>
        )}

      <BudgetDialog open={open} onOpenChange={setOpen} onCreate={async (d) => {
        if (!workspaceId || !projectId) return;
        await supabase.from("fin_budgets").insert({ ...d, workspace_id: workspaceId, project_id: projectId });
        queryClient.invalidateQueries({ queryKey: ["fin_budgets", projectId] });
        setOpen(false);
      }} />
    </div>
  );
}

function BudgetDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: Partial<Budget>) => Promise<void> }) {
  const [d, setD] = useState<Partial<Budget>>({ currency: "eur", amount_cents: 0 });
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.category?.trim()) return; setSaving(true); try { await onCreate(d); setD({ currency: "eur", amount_cents: 0 }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New budget</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <FF label="Category"><Input value={d.category ?? ""} onChange={(e) => setD((p) => ({ ...p, category: e.target.value }))} autoFocus placeholder="e.g. Marketing" /></FF>
          <FF label="Period"><Input value={d.period ?? ""} onChange={(e) => setD((p) => ({ ...p, period: e.target.value }))} placeholder="2026-Q2" /></FF>
          <FF label="Amount (€)"><Input type="number" value={d.amount_cents ? d.amount_cents / 100 : ""} onChange={(e) => setD((p) => ({ ...p, amount_cents: Math.round(Number(e.target.value) * 100) }))} /></FF>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Create</Button></div>
      </DialogContent>
    </Dialog>
  );
}

function FF({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (<div className={full ? "col-span-2" : ""}><label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>{children}</div>);
}
