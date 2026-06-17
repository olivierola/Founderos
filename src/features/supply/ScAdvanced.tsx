import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Truck, Loader2, Plus, Trash2, AlertTriangle, PackageX, ClipboardList, Boxes,
  Gauge, Leaf, RotateCcw, ShoppingCart, CheckCircle2, Clock, RefreshCw,
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
  return new Intl.NumberFormat(undefined, { style: "currency", currency: cur.toUpperCase(), maximumFractionDigits: 0 }).format(cents / 100);
}
function useTbl<T>(table: string, key: string) {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: [key, projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from(table).select("*").eq("project_id", projectId!).order("created_at", { ascending: false }).limit(1000);
      return (data ?? []) as T[];
    },
  });
}

// ============================================================== CONTROL TOWER
export function ScControlTowerPage() {
  const { projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const { data: items } = useTbl<any>("sc_inventory_items", "sc_inventory_items");
  const { data: pos } = useTbl<any>("sc_purchase_orders", "sc_purchase_orders");
  const { data: orders } = useTbl<any>("sc_sales_orders", "sc_sales_orders");
  const { data: shipments } = useTbl<any>("sc_shipments", "sc_shipments");
  const { data: batches } = useTbl<any>("sc_batches", "sc_batches");
  const { data: exceptions } = useQuery({
    queryKey: ["sc_exceptions", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("sc_exceptions").select("*").eq("project_id", projectId!).eq("resolved", false).order("created_at", { ascending: false }).limit(100);
      return (data ?? []) as any[];
    },
    refetchInterval: 8000,
  });

  const k = useMemo(() => {
    const it = items ?? [];
    const low = it.filter((x) => x.quantity <= Math.max(x.reorder_point, x.safety_stock ?? 0));
    const stockValue = it.reduce((s, x) => s + x.quantity * x.unit_cost_cents, 0);
    const so = orders ?? [];
    const delivered = so.filter((o) => o.status === "delivered");
    const otif = delivered.length
      ? Math.round(delivered.filter((o) => o.promised_at && o.delivered_at && new Date(o.delivered_at) <= new Date(o.promised_at + "T23:59:59")).length / delivered.length * 100)
      : null;
    const fill = so.length ? Math.round(so.filter((o) => ["shipped", "delivered"].includes(o.status)).length / so.length * 100) : null;
    const openPo = (pos ?? []).filter((p) => !["received", "cancelled"].includes(p.status));
    const inTransit = (shipments ?? []).filter((s) => s.status === "in_transit" || s.status === "delayed");
    const carbon = (shipments ?? []).reduce((s, x) => s + (Number(x.carbon_kg) || 0), 0);
    const turnover = stockValue > 0 ? Math.round((so.length / Math.max(1, it.length)) * 10) / 10 : 0;
    return { low, stockValue, otif, fill, openPo: openPo.length, inTransit: inTransit.length, carbon, turnover };
  }, [items, pos, orders, shipments]);

  // Recompute exceptions client-side from current data (managed-by-exception).
  async function recompute() {
    if (!projectId) return;
    const it = items ?? [];
    const ws = it[0]?.workspace_id;
    if (!ws) return;
    await supabase.from("sc_exceptions").delete().eq("project_id", projectId).eq("resolved", false);
    const rows: any[] = [];
    for (const x of it) {
      if (x.quantity <= 0) rows.push({ workspace_id: ws, project_id: projectId, kind: "stockout", severity: "high", title: `Stockout: ${x.name}`, detail: `${x.sku} is out of stock.`, entity_kind: "item", entity_id: x.id });
      else if (x.quantity <= Math.max(x.reorder_point, x.safety_stock ?? 0)) rows.push({ workspace_id: ws, project_id: projectId, kind: "stockout", severity: "medium", title: `Low stock: ${x.name}`, detail: `${x.quantity} ≤ reorder ${x.reorder_point}.`, entity_kind: "item", entity_id: x.id });
    }
    for (const p of (pos ?? [])) {
      if (!["received", "cancelled"].includes(p.status) && p.expected_at && new Date(p.expected_at) < new Date())
        rows.push({ workspace_id: ws, project_id: projectId, kind: "overdue_po", severity: "high", title: `Overdue PO: ${p.reference}`, detail: `Expected ${new Date(p.expected_at).toLocaleDateString()}, still ${p.status}.`, entity_kind: "purchase_order", entity_id: p.id });
    }
    for (const s of (shipments ?? [])) {
      if (s.status === "delayed" || s.delay_risk === "high")
        rows.push({ workspace_id: ws, project_id: projectId, kind: "shipment_delay", severity: "high", title: `Shipment risk: ${s.reference}`, detail: `${s.carrier ?? "carrier"} · ${s.status}.`, entity_kind: "shipment", entity_id: s.id });
    }
    for (const b of (batches ?? [])) {
      if (b.expiry_date && new Date(b.expiry_date) < new Date(Date.now() + 30 * 864e5))
        rows.push({ workspace_id: ws, project_id: projectId, kind: "expiry", severity: "medium", title: `Expiring lot ${b.lot_code}`, detail: `Expires ${new Date(b.expiry_date).toLocaleDateString()}.`, entity_kind: "item", entity_id: b.item_id });
    }
    for (const o of (orders ?? [])) {
      if (o.status === "backordered") rows.push({ workspace_id: ws, project_id: projectId, kind: "backorder", severity: "medium", title: `Backorder: ${o.reference}`, detail: `Customer ${o.customer ?? "?"} waiting.`, entity_kind: "sales_order", entity_id: o.id });
    }
    if (rows.length) await supabase.from("sc_exceptions").insert(rows);
    queryClient.invalidateQueries({ queryKey: ["sc_exceptions", projectId] });
  }
  async function resolveExc(id: string) {
    await supabase.from("sc_exceptions").update({ resolved: true }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["sc_exceptions", projectId] });
  }

  const sevCls: Record<string, string> = { high: "border-destructive/40 bg-destructive/5", medium: "border-amber-500/40 bg-amber-500/5", low: "border-border bg-card" };

  return (
    <div className="space-y-6">
      <PageHeader title="Control tower" description="Unified visibility across stock, orders, shipments and suppliers — managed by exception."
        actions={<Button size="sm" variant="outline" onClick={recompute}><RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Scan exceptions</Button>} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="OTIF" value={k.otif == null ? "—" : `${k.otif}%`} icon={Gauge} hint="on-time in-full" />
        <MetricCard label="Fill rate" value={k.fill == null ? "—" : `${k.fill}%`} icon={CheckCircle2} />
        <MetricCard label="Stock value" value={money(k.stockValue)} icon={Boxes} hint={`${k.low.length} low`} />
        <MetricCard label="CO₂ shipped" value={`${Math.round(k.carbon)} kg`} icon={Leaf} hint="Scope 3 (est.)" />
        <MetricCard label="Open POs" value={String(k.openPo)} icon={ClipboardList} />
        <MetricCard label="In transit" value={String(k.inTransit)} icon={Truck} />
        <MetricCard label="Stock turnover" value={`${k.turnover}×`} icon={RotateCcw} />
        <MetricCard label="Open exceptions" value={String((exceptions ?? []).length)} icon={AlertTriangle} />
      </div>

      <div>
        <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-amber-500" /> Exceptions — what needs attention</div>
        {(exceptions ?? []).length === 0 ? (
          <p className="rounded-lg border border-dashed border-border py-8 text-center text-xs text-muted-foreground">
            Nothing dripping. Click <strong>Scan exceptions</strong> to surface stockouts, overdue POs, shipment risks and expiring lots.
          </p>
        ) : (
          <div className="space-y-2">
            {(exceptions ?? []).map((e) => (
              <div key={e.id} className={cn("group flex items-start gap-3 rounded-lg border p-3", sevCls[e.severity] ?? sevCls.low)}>
                <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md", e.severity === "high" ? "bg-destructive/15 text-destructive" : "bg-amber-500/15 text-amber-600")}>
                  {e.kind === "stockout" ? <PackageX className="h-4 w-4" /> : e.kind === "shipment_delay" ? <Truck className="h-4 w-4" /> : e.kind === "overdue_po" ? <ClipboardList className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">{e.title}<Badge variant="outline" className="text-[10px] capitalize">{e.kind.replace("_", " ")}</Badge></div>
                  {e.detail && <div className="text-xs text-muted-foreground">{e.detail}</div>}
                </div>
                <button onClick={() => resolveExc(e.id)} className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100">Resolve</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================== SALES ORDERS (OMS)
const SO_STATUS: Record<string, string> = {
  pending: "bg-zinc-500/15 text-zinc-500", allocated: "bg-sky-500/15 text-sky-500", backordered: "bg-amber-500/15 text-amber-600",
  picking: "bg-violet-500/15 text-violet-500", shipped: "bg-indigo-500/15 text-indigo-500", delivered: "bg-emerald-500/15 text-emerald-500", cancelled: "bg-destructive/15 text-destructive",
};
export function ScSalesOrdersPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: orders, isLoading } = useTbl<any>("sc_sales_orders", "sc_sales_orders");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ reference: "", customer: "", total: "0", promised_at: "" });

  async function create() {
    if (!workspaceId || !projectId || !user) return;
    const ref = form.reference.trim() || `SO-${Date.now().toString().slice(-6)}`;
    const { error } = await supabase.from("sc_sales_orders").insert({
      workspace_id: workspaceId, project_id: projectId, created_by: user.id,
      reference: ref, customer: form.customer.trim() || null,
      total_cents: Math.round((Number(form.total) || 0) * 100), promised_at: form.promised_at || null,
    });
    if (error) { alert(error.message); return; }
    setForm({ reference: "", customer: "", total: "0", promised_at: "" }); setOpen(false);
    queryClient.invalidateQueries({ queryKey: ["sc_sales_orders", projectId] });
  }
  async function setStatus(id: string, status: string) {
    const patch: any = { status, updated_at: new Date().toISOString() };
    if (status === "shipped") patch.shipped_at = new Date().toISOString();
    if (status === "delivered") patch.delivered_at = new Date().toISOString();
    await supabase.from("sc_sales_orders").update(patch).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["sc_sales_orders", projectId] });
  }
  async function remove(id: string) {
    if (!confirm("Delete this order?")) return;
    await supabase.from("sc_sales_orders").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["sc_sales_orders", projectId] });
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Sales orders" description="Order management — allocation, backorders, fulfilment status."
        actions={<Button onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" /> New order</Button>} />
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      : (orders ?? []).length === 0 ? <EmptyState icon={ShoppingCart} title="No sales orders" description="Create your first customer order." />
      : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[680px] text-sm">
            <thead className="border-b border-border bg-secondary/30 text-xs uppercase tracking-wider text-muted-foreground">
              <tr><th className="px-4 py-3 text-left">Reference</th><th className="px-4 py-3 text-left">Customer</th><th className="px-4 py-3 text-right">Total</th><th className="px-4 py-3 text-left">Promised</th><th className="px-4 py-3 text-left">Status</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(orders ?? []).map((o) => (
                <tr key={o.id} className="group hover:bg-secondary/30">
                  <td className="px-4 py-3 font-medium">{o.reference}</td>
                  <td className="px-4 py-3 text-muted-foreground">{o.customer ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{money(o.total_cents, o.currency)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{o.promised_at ? new Date(o.promised_at).toLocaleDateString() : "—"}</td>
                  <td className="px-4 py-3">
                    <select value={o.status} onChange={(e) => setStatus(o.id, e.target.value)} className={cn("rounded-full border-0 px-2 py-1 text-xs font-medium", SO_STATUS[o.status])}>
                      {Object.keys(SO_STATUS).map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-right"><button onClick={() => remove(o.id)} className="opacity-0 transition-opacity group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5 text-destructive" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New sales order</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label="Reference (optional)"><Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="SO-000123" /></Field>
            <Field label="Customer"><Input value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Total"><Input type="number" step="0.01" value={form.total} onChange={(e) => setForm({ ...form, total: e.target.value })} /></Field>
              <Field label="Promised date"><Input type="date" value={form.promised_at} onChange={(e) => setForm({ ...form, promised_at: e.target.value })} /></Field>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={create}>Create order</Button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================== RETURNS (RMA)
const RMA_STATUS: Record<string, string> = {
  requested: "bg-zinc-500/15 text-zinc-500", approved: "bg-sky-500/15 text-sky-500", received: "bg-violet-500/15 text-violet-500", refunded: "bg-emerald-500/15 text-emerald-500", rejected: "bg-destructive/15 text-destructive",
};
export function ScReturnsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: returns, isLoading } = useTbl<any>("sc_returns", "sc_returns");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ reference: "", quantity: "1", reason: "" });

  async function create() {
    if (!workspaceId || !projectId || !user) return;
    const ref = form.reference.trim() || `RMA-${Date.now().toString().slice(-6)}`;
    const { error } = await supabase.from("sc_returns").insert({
      workspace_id: workspaceId, project_id: projectId, created_by: user.id,
      reference: ref, quantity: Number(form.quantity) || 1, reason: form.reason.trim() || null,
    });
    if (error) { alert(error.message); return; }
    setForm({ reference: "", quantity: "1", reason: "" }); setOpen(false);
    queryClient.invalidateQueries({ queryKey: ["sc_returns", projectId] });
  }
  async function setStatus(id: string, status: string) {
    await supabase.from("sc_returns").update({ status }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["sc_returns", projectId] });
  }
  async function remove(id: string) {
    if (!confirm("Delete this return?")) return;
    await supabase.from("sc_returns").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["sc_returns", projectId] });
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Returns (RMA)" description="Customer returns — request, approve, receive, refund."
        actions={<Button onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" /> New return</Button>} />
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      : (returns ?? []).length === 0 ? <EmptyState icon={RotateCcw} title="No returns" description="Log your first RMA." />
      : (
        <div className="space-y-2">
          {(returns ?? []).map((r) => (
            <div key={r.id} className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-secondary"><RotateCcw className="h-4 w-4 text-muted-foreground" /></span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{r.reference} <span className="text-xs text-muted-foreground">· qty {r.quantity}</span></div>
                {r.reason && <div className="truncate text-xs text-muted-foreground">{r.reason}</div>}
              </div>
              <select value={r.status} onChange={(e) => setStatus(r.id, e.target.value)} className={cn("rounded-full border-0 px-2 py-1 text-xs font-medium", RMA_STATUS[r.status])}>
                {Object.keys(RMA_STATUS).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button onClick={() => remove(r.id)} className="opacity-0 transition-opacity group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5 text-destructive" /></button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New return (RMA)</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label="Reference (optional)"><Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="RMA-000123" /></Field>
            <Field label="Quantity"><Input type="number" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} /></Field>
            <Field label="Reason"><Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="Defective, wrong item…" /></Field>
          </div>
          <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={create}>Log return</Button></div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><label className="text-xs font-medium text-muted-foreground">{label}</label>{children}</div>;
}
