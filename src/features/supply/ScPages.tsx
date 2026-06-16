import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Truck, Loader2, Plus, Trash2, Search, PackageX, Boxes, Factory, ClipboardList,
  AlertTriangle, CheckCircle2, Clock,
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

// ── Types ────────────────────────────────────────────────────────────────────
interface Supplier {
  id: string; name: string; contact_name: string | null; email: string | null; phone: string | null;
  country: string | null; lead_time_days: number; reliability: number;
  status: "active" | "paused" | "blocked"; notes: string | null; created_at: string;
}
interface Item {
  id: string; sku: string; name: string; category: string | null; unit: string;
  quantity: number; reorder_point: number; unit_cost_cents: number; currency: string;
  location: string | null; supplier_id: string | null; created_at: string;
}
interface PurchaseOrder {
  id: string; reference: string; supplier_id: string | null;
  status: "draft" | "sent" | "confirmed" | "received" | "cancelled";
  currency: string; total_cents: number; expected_at: string | null; notes: string | null; created_at: string;
}
interface Shipment {
  id: string; reference: string; direction: "inbound" | "outbound"; carrier: string | null;
  tracking_number: string | null; po_id: string | null;
  status: "pending" | "in_transit" | "delivered" | "delayed" | "cancelled"; eta: string | null; created_at: string;
}

function money(cents: number, cur = "eur") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: cur.toUpperCase(), maximumFractionDigits: 0 }).format(cents / 100);
}

// ── Data hooks ───────────────────────────────────────────────────────────────
function useTable<T>(table: string, key: string) {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: [key, projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from(table).select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as T[];
    },
  });
}
const useSuppliers = () => useTable<Supplier>("sc_suppliers", "sc_suppliers");
const useItems = () => useTable<Item>("sc_inventory_items", "sc_inventory_items");
const usePurchaseOrders = () => useTable<PurchaseOrder>("sc_purchase_orders", "sc_purchase_orders");
const useShipments = () => useTable<Shipment>("sc_shipments", "sc_shipments");

// ============================================================== OVERVIEW
export function ScOverviewPage() {
  const { data: items } = useItems();
  const { data: suppliers } = useSuppliers();
  const { data: pos } = usePurchaseOrders();
  const { data: shipments } = useShipments();

  const stats = useMemo(() => {
    const it = items ?? [];
    const stockValue = it.reduce((s, x) => s + x.quantity * x.unit_cost_cents, 0);
    const lowStock = it.filter((x) => x.quantity <= x.reorder_point);
    const openPo = (pos ?? []).filter((p) => !["received", "cancelled"].includes(p.status));
    const inTransit = (shipments ?? []).filter((s) => s.status === "in_transit" || s.status === "delayed");
    const avgLead = (suppliers ?? []).length ? Math.round((suppliers ?? []).reduce((s, x) => s + x.lead_time_days, 0) / (suppliers ?? []).length) : 0;
    return { stockValue, lowStock, openPo: openPo.length, inTransit: inTransit.length, suppliers: (suppliers ?? []).length, avgLead };
  }, [items, suppliers, pos, shipments]);

  return (
    <div className="space-y-6">
      <PageHeader title="Supply Chain — Overview" description="Inventory, suppliers, orders and shipments at a glance." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Stock value" value={money(stats.stockValue)} icon={Boxes} />
        <MetricCard label="Low stock" value={String(stats.lowStock.length)} icon={PackageX} hint="at / below reorder point" />
        <MetricCard label="Open POs" value={String(stats.openPo)} icon={ClipboardList} />
        <MetricCard label="In transit" value={String(stats.inTransit)} icon={Truck} hint={`avg lead ${stats.avgLead}d`} />
      </div>

      {stats.lowStock.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" /> Restock needed ({stats.lowStock.length})
          </div>
          <div className="flex flex-wrap gap-2">
            {stats.lowStock.slice(0, 12).map((x) => (
              <span key={x.id} className="inline-flex items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-xs">
                <span className="font-medium">{x.name}</span>
                <span className="text-muted-foreground">{x.quantity}/{x.reorder_point} {x.unit}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================== INVENTORY
export function ScInventoryPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: items, isLoading } = useItems();
  const { data: suppliers } = useSuppliers();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ sku: "", name: "", category: "", unit: "unit", quantity: "0", reorder_point: "0", unit_cost: "0", location: "", supplier_id: "" });

  const supplierName = (id: string | null) => (suppliers ?? []).find((s) => s.id === id)?.name ?? "—";
  const visible = (items ?? []).filter((x) =>
    !q || x.name.toLowerCase().includes(q.toLowerCase()) || x.sku.toLowerCase().includes(q.toLowerCase()));

  async function create() {
    if (!workspaceId || !projectId || !user || !form.name.trim()) return;
    const { error } = await supabase.from("sc_inventory_items").insert({
      workspace_id: workspaceId, project_id: projectId, created_by: user.id,
      sku: form.sku.trim() || form.name.trim().toUpperCase().replace(/\s+/g, "-").slice(0, 16),
      name: form.name.trim(), category: form.category.trim() || null, unit: form.unit.trim() || "unit",
      quantity: Number(form.quantity) || 0, reorder_point: Number(form.reorder_point) || 0,
      unit_cost_cents: Math.round((Number(form.unit_cost) || 0) * 100),
      location: form.location.trim() || null, supplier_id: form.supplier_id || null,
    });
    if (error) { alert(error.message); return; }
    setForm({ sku: "", name: "", category: "", unit: "unit", quantity: "0", reorder_point: "0", unit_cost: "0", location: "", supplier_id: "" });
    setOpen(false);
    queryClient.invalidateQueries({ queryKey: ["sc_inventory_items", projectId] });
  }
  async function remove(id: string) {
    if (!confirm("Delete this item?")) return;
    await supabase.from("sc_inventory_items").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["sc_inventory_items", projectId] });
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Inventory" description="Track stock, reorder points and costs."
        actions={<Button onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" /> Add item</Button>} />
      <div className="relative max-w-xs">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items…" className="pl-8" />
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : visible.length === 0 ? (
        <EmptyState icon={Boxes} title="No items" description="Add your first inventory item." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-border bg-secondary/30 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left">Item</th><th className="px-4 py-3 text-left">SKU</th>
                <th className="px-4 py-3 text-right">Qty</th><th className="px-4 py-3 text-right">Reorder</th>
                <th className="px-4 py-3 text-right">Unit cost</th><th className="px-4 py-3 text-left">Supplier</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((x) => {
                const low = x.quantity <= x.reorder_point;
                return (
                  <tr key={x.id} className="group hover:bg-secondary/30">
                    <td className="px-4 py-3 font-medium">{x.name}{x.category && <span className="ml-2 text-xs text-muted-foreground">{x.category}</span>}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{x.sku}</td>
                    <td className={cn("px-4 py-3 text-right tabular-nums", low && "text-amber-600 dark:text-amber-400")}>
                      {low && <AlertTriangle className="mr-1 inline h-3 w-3" />}{x.quantity} {x.unit}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{x.reorder_point}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(x.unit_cost_cents, x.currency)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{supplierName(x.supplier_id)}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => remove(x.id)} className="opacity-0 transition-opacity group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5 text-destructive" /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Add inventory item</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
            <Field label="SKU (optional)"><Input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} /></Field>
            <Field label="Category"><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
            <Field label="Unit"><Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></Field>
            <Field label="Quantity"><Input type="number" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} /></Field>
            <Field label="Reorder point"><Input type="number" value={form.reorder_point} onChange={(e) => setForm({ ...form, reorder_point: e.target.value })} /></Field>
            <Field label="Unit cost"><Input type="number" step="0.01" value={form.unit_cost} onChange={(e) => setForm({ ...form, unit_cost: e.target.value })} /></Field>
            <Field label="Location"><Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></Field>
            <Field label="Supplier" full>
              <select value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })} className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm">
                <option value="">— none —</option>
                {(suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={!form.name.trim()}>Add item</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================== SUPPLIERS
export function ScSuppliersPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: suppliers, isLoading } = useSuppliers();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", contact_name: "", email: "", phone: "", country: "", lead_time_days: "7", reliability: "90" });

  async function create() {
    if (!workspaceId || !projectId || !user || !form.name.trim()) return;
    const { error } = await supabase.from("sc_suppliers").insert({
      workspace_id: workspaceId, project_id: projectId, created_by: user.id,
      name: form.name.trim(), contact_name: form.contact_name.trim() || null, email: form.email.trim() || null,
      phone: form.phone.trim() || null, country: form.country.trim() || null,
      lead_time_days: Number(form.lead_time_days) || 7, reliability: Math.min(100, Math.max(0, Number(form.reliability) || 90)),
    });
    if (error) { alert(error.message); return; }
    setForm({ name: "", contact_name: "", email: "", phone: "", country: "", lead_time_days: "7", reliability: "90" });
    setOpen(false);
    queryClient.invalidateQueries({ queryKey: ["sc_suppliers", projectId] });
  }
  async function remove(id: string) {
    if (!confirm("Delete this supplier?")) return;
    await supabase.from("sc_suppliers").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["sc_suppliers", projectId] });
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Suppliers" description="Vendors, lead times and reliability."
        actions={<Button onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" /> Add supplier</Button>} />
      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (suppliers ?? []).length === 0 ? (
        <EmptyState icon={Factory} title="No suppliers" description="Add your first supplier." />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(suppliers ?? []).map((s) => (
            <div key={s.id} className="group rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <span className="flex h-9 w-9 items-center justify-center rounded-md bg-secondary"><Factory className="h-4 w-4 text-muted-foreground" /></span>
                  <div>
                    <div className="text-sm font-semibold">{s.name}</div>
                    <div className="text-xs text-muted-foreground">{s.country || "—"}</div>
                  </div>
                </div>
                <button onClick={() => remove(s.id)} className="opacity-0 transition-opacity group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5 text-destructive" /></button>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md bg-secondary/40 px-2 py-1.5"><div className="text-muted-foreground">Lead time</div><div className="font-medium">{s.lead_time_days} days</div></div>
                <div className="rounded-md bg-secondary/40 px-2 py-1.5"><div className="text-muted-foreground">Reliability</div><div className="font-medium">{s.reliability}%</div></div>
              </div>
              {(s.contact_name || s.email) && (
                <div className="mt-2 text-xs text-muted-foreground">{s.contact_name}{s.contact_name && s.email && " · "}{s.email}</div>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Add supplier</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" full><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
            <Field label="Contact"><Input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} /></Field>
            <Field label="Country"><Input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} /></Field>
            <Field label="Email"><Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Lead time (days)"><Input type="number" value={form.lead_time_days} onChange={(e) => setForm({ ...form, lead_time_days: e.target.value })} /></Field>
            <Field label="Reliability (%)"><Input type="number" value={form.reliability} onChange={(e) => setForm({ ...form, reliability: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={!form.name.trim()}>Add supplier</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================== PURCHASE ORDERS
const PO_COLUMNS: { key: PurchaseOrder["status"]; label: string; accent: string }[] = [
  { key: "draft", label: "Draft", accent: "bg-zinc-400" },
  { key: "sent", label: "Sent", accent: "bg-sky-500" },
  { key: "confirmed", label: "Confirmed", accent: "bg-violet-500" },
  { key: "received", label: "Received", accent: "bg-emerald-500" },
  { key: "cancelled", label: "Cancelled", accent: "bg-destructive" },
];

export function ScPurchaseOrdersPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: pos, isLoading } = usePurchaseOrders();
  const { data: suppliers } = useSuppliers();
  const [open, setOpen] = useState(false);
  const [dragCol, setDragCol] = useState<PurchaseOrder["status"] | null>(null);
  const [form, setForm] = useState({ reference: "", supplier_id: "", total: "0", expected_at: "" });

  const supplierName = (id: string | null) => (suppliers ?? []).find((s) => s.id === id)?.name ?? "—";

  async function create() {
    if (!workspaceId || !projectId || !user) return;
    const ref = form.reference.trim() || `PO-${Date.now().toString().slice(-6)}`;
    const { error } = await supabase.from("sc_purchase_orders").insert({
      workspace_id: workspaceId, project_id: projectId, created_by: user.id,
      reference: ref, supplier_id: form.supplier_id || null,
      total_cents: Math.round((Number(form.total) || 0) * 100), expected_at: form.expected_at || null,
    });
    if (error) { alert(error.message); return; }
    setForm({ reference: "", supplier_id: "", total: "0", expected_at: "" });
    setOpen(false);
    queryClient.invalidateQueries({ queryKey: ["sc_purchase_orders", projectId] });
  }
  async function move(id: string, status: PurchaseOrder["status"]) {
    queryClient.setQueryData(["sc_purchase_orders", projectId], (old: PurchaseOrder[] | undefined) =>
      (old ?? []).map((p) => (p.id === id ? { ...p, status } : p)));
    await supabase.from("sc_purchase_orders").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["sc_purchase_orders", projectId] });
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Purchase orders" description="Drag orders across statuses as they progress."
        actions={<Button onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" /> New PO</Button>} />
      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (pos ?? []).length === 0 ? (
        <EmptyState icon={ClipboardList} title="No purchase orders" description="Create your first PO." />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {PO_COLUMNS.map((col) => {
            const cards = (pos ?? []).filter((p) => p.status === col.key);
            return (
              <div key={col.key}
                onDragOver={(e) => { e.preventDefault(); setDragCol(col.key); }}
                onDragLeave={() => setDragCol((c) => (c === col.key ? null : c))}
                onDrop={(e) => { e.preventDefault(); setDragCol(null); const id = e.dataTransfer.getData("text/po"); if (id) move(id, col.key); }}
                className={cn("flex min-h-[260px] flex-col rounded-lg border bg-muted/20 transition-colors", dragCol === col.key ? "border-primary/60 bg-primary/5" : "border-border")}>
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <span className={cn("h-2 w-2 rounded-full", col.accent)} />
                  <span className="text-xs font-semibold">{col.label}</span>
                  <span className="ml-auto rounded-full bg-foreground/10 px-1.5 text-[10px] text-muted-foreground">{cards.length}</span>
                </div>
                <div className="flex-1 space-y-2 px-2 pb-2">
                  {cards.map((p) => (
                    <div key={p.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/po", p.id)}
                      className="cursor-grab rounded-md border border-border bg-background p-2.5 shadow-sm active:cursor-grabbing">
                      <div className="text-xs font-semibold">{p.reference}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{supplierName(p.supplier_id)}</div>
                      <div className="mt-1.5 flex items-center justify-between text-[11px]">
                        <span className="font-medium tabular-nums">{money(p.total_cents, p.currency)}</span>
                        {p.expected_at && <span className="inline-flex items-center gap-0.5 text-muted-foreground"><Clock className="h-2.5 w-2.5" />{new Date(p.expected_at).toLocaleDateString()}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New purchase order</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label="Reference (optional)"><Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="PO-000123" /></Field>
            <Field label="Supplier">
              <select value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })} className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm">
                <option value="">— none —</option>
                {(suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Total"><Input type="number" step="0.01" value={form.total} onChange={(e) => setForm({ ...form, total: e.target.value })} /></Field>
              <Field label="Expected date"><Input type="date" value={form.expected_at} onChange={(e) => setForm({ ...form, expected_at: e.target.value })} /></Field>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create}>Create PO</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================== SHIPMENTS
const SHIP_STATUS: Record<Shipment["status"], { label: string; cls: string; icon: typeof Truck }> = {
  pending: { label: "Pending", cls: "bg-zinc-500/15 text-zinc-600", icon: Clock },
  in_transit: { label: "In transit", cls: "bg-sky-500/15 text-sky-600", icon: Truck },
  delivered: { label: "Delivered", cls: "bg-emerald-500/15 text-emerald-600", icon: CheckCircle2 },
  delayed: { label: "Delayed", cls: "bg-amber-500/15 text-amber-600", icon: AlertTriangle },
  cancelled: { label: "Cancelled", cls: "bg-destructive/15 text-destructive", icon: PackageX },
};

export function ScShipmentsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: shipments, isLoading } = useShipments();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ reference: "", direction: "inbound" as Shipment["direction"], carrier: "", tracking_number: "", eta: "" });

  async function create() {
    if (!workspaceId || !projectId || !user) return;
    const ref = form.reference.trim() || `SHP-${Date.now().toString().slice(-6)}`;
    const { error } = await supabase.from("sc_shipments").insert({
      workspace_id: workspaceId, project_id: projectId, created_by: user.id,
      reference: ref, direction: form.direction, carrier: form.carrier.trim() || null,
      tracking_number: form.tracking_number.trim() || null, eta: form.eta || null,
    });
    if (error) { alert(error.message); return; }
    setForm({ reference: "", direction: "inbound", carrier: "", tracking_number: "", eta: "" });
    setOpen(false);
    queryClient.invalidateQueries({ queryKey: ["sc_shipments", projectId] });
  }
  async function setStatus(id: string, status: Shipment["status"]) {
    await supabase.from("sc_shipments").update({ status, delivered_at: status === "delivered" ? new Date().toISOString() : null }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["sc_shipments", projectId] });
  }
  async function remove(id: string) {
    if (!confirm("Delete this shipment?")) return;
    await supabase.from("sc_shipments").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["sc_shipments", projectId] });
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Shipments" description="Inbound and outbound shipments with tracking."
        actions={<Button onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" /> Add shipment</Button>} />
      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (shipments ?? []).length === 0 ? (
        <EmptyState icon={Truck} title="No shipments" description="Track your first shipment." />
      ) : (
        <div className="space-y-2">
          {(shipments ?? []).map((s) => {
            const st = SHIP_STATUS[s.status];
            return (
              <div key={s.id} className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3">
                <span className={cn("flex h-9 w-9 items-center justify-center rounded-md", s.direction === "inbound" ? "bg-sky-500/15 text-sky-600" : "bg-violet-500/15 text-violet-600")}>
                  <Truck className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {s.reference}
                    <Badge variant="outline" className="text-[10px] capitalize">{s.direction}</Badge>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {s.carrier || "—"}{s.tracking_number && ` · ${s.tracking_number}`}{s.eta && ` · ETA ${new Date(s.eta).toLocaleDateString()}`}
                  </div>
                </div>
                <select value={s.status} onChange={(e) => setStatus(s.id, e.target.value as Shipment["status"])}
                  className={cn("rounded-full border-0 px-2 py-1 text-xs font-medium", st.cls)}>
                  {Object.entries(SHIP_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <button onClick={() => remove(s.id)} className="opacity-0 transition-opacity group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5 text-destructive" /></button>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add shipment</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Field label="Reference (optional)"><Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="SHP-000123" /></Field>
            <Field label="Direction">
              <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as Shipment["direction"] })} className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm">
                <option value="inbound">Inbound</option><option value="outbound">Outbound</option>
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Carrier"><Input value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })} /></Field>
              <Field label="ETA"><Input type="date" value={form.eta} onChange={(e) => setForm({ ...form, eta: e.target.value })} /></Field>
            </div>
            <Field label="Tracking number"><Input value={form.tracking_number} onChange={(e) => setForm({ ...form, tracking_number: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create}>Add shipment</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children, full }: { label: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div className={cn("space-y-1", full && "col-span-2")}>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
