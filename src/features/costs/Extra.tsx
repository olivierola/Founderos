import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Target, Receipt, Plus, Loader2, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { formatCurrency } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useLatestMetrics } from "@/hooks/useFinance";

// --- Cost per User ---------------------------------------------------------
export function CostPerUserPage() {
  const { projectId } = useCurrentContext();
  const latest = useLatestMetrics(projectId);

  const { data: costs } = useQuery({
    queryKey: ["all_costs", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("cost_records").select("amount_cents").eq("project_id", projectId!);
      return data ?? [];
    },
  });

  const { data: llm } = useQuery({
    queryKey: ["all_llm", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("llm_usage").select("estimated_cost_cents").eq("project_id", projectId!);
      return data ?? [];
    },
  });

  const totalCents =
    (costs ?? []).reduce((s, c: any) => s + c.amount_cents, 0) +
    (llm ?? []).reduce((s, l: any) => s + l.estimated_cost_cents, 0);

  const users = latest.data?.metrics.customers ?? 0;
  const cpu = users > 0 ? totalCents / users : 0;
  const arpu = latest.data?.metrics.arpu_cents ?? 0;
  const marginCents = arpu - cpu;

  return (
    <div>
      <PageHeader
        title="Cost per User"
        description="Naive split of total recorded cost (manual + LLM) over current customer count."
      />
      {users === 0 ? (
        <EmptyState
          icon={Users}
          title="No customer data"
          description="Sync Stripe to populate customer count, then this page becomes useful."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Customers" value={String(users)} icon={Users} />
          <MetricCard label="Total cost (all time)" value={formatCurrency(totalCents / 100, "EUR")} />
          <MetricCard label="Cost / user" value={formatCurrency(cpu / 100, "EUR")} icon={Target} />
          <MetricCard
            label="ARPU − cost (per month proxy)"
            value={formatCurrency(marginCents / 100, "EUR")}
            trend={marginCents > 0 ? "up" : "down"}
          />
        </div>
      )}
    </div>
  );
}

// --- Budgets ---------------------------------------------------------------
export function BudgetsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState("");
  const [limitEur, setLimitEur] = useState("");
  const [threshold, setThreshold] = useState("80");
  const [saving, setSaving] = useState(false);

  const { data: budgets } = useQuery({
    queryKey: ["budgets", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("budgets")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  const { data: monthCosts } = useQuery({
    queryKey: ["month_costs", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const start = new Date();
      start.setDate(1);
      const iso = start.toISOString();
      const { data } = await supabase
        .from("cost_records")
        .select("provider, amount_cents")
        .eq("project_id", projectId!)
        .gte("created_at", iso);
      const map: Record<string, number> = {};
      (data ?? []).forEach((c: any) => {
        map[c.provider] = (map[c.provider] ?? 0) + c.amount_cents;
      });
      return map;
    },
  });

  async function handleAdd() {
    if (!workspaceId || !projectId) return;
    setSaving(true);
    try {
      const cents = Math.round(parseFloat(limitEur) * 100);
      await supabase.from("budgets").upsert(
        {
          workspace_id: workspaceId,
          project_id: projectId,
          provider: provider || null,
          monthly_limit_cents: cents,
          currency: "eur",
          alert_threshold_pct: parseInt(threshold, 10),
        },
        { onConflict: "project_id,provider" },
      );
      setProvider("");
      setLimitEur("");
      await queryClient.invalidateQueries({ queryKey: ["budgets", projectId] });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    await supabase.from("budgets").delete().eq("id", id);
    await queryClient.invalidateQueries({ queryKey: ["budgets", projectId] });
  }

  return (
    <div>
      <PageHeader title="Budgets" description="Monthly spend caps per provider with alert thresholds." />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" /> Add / edit a budget
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Input placeholder="Provider (e.g. vercel)" value={provider} onChange={(e) => setProvider(e.target.value)} />
          <Input type="number" placeholder="Monthly limit (€)" value={limitEur} onChange={(e) => setLimitEur(e.target.value)} />
          <Input type="number" placeholder="Alert at %" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
          <Button onClick={handleAdd} disabled={saving || !provider || !limitEur}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </Button>
        </CardContent>
      </Card>

      {!budgets || budgets.length === 0 ? (
        <EmptyState icon={Target} title="No budgets set" />
      ) : (
        <div className="space-y-3">
          {budgets.map((b: any) => {
            const spent = monthCosts?.[b.provider] ?? 0;
            const pct = b.monthly_limit_cents > 0 ? (spent / b.monthly_limit_cents) * 100 : 0;
            const over = pct >= 100;
            const alert = pct >= b.alert_threshold_pct;
            return (
              <Card key={b.id}>
                <CardContent className="p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{b.provider}</span>
                      <Badge variant={over ? "destructive" : alert ? "warning" : "secondary"}>
                        {pct.toFixed(0)}%
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-muted-foreground">
                        {formatCurrency(spent / 100, "EUR")} /{" "}
                        {formatCurrency(b.monthly_limit_cents / 100, "EUR")}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setProvider(b.provider ?? "");
                          setLimitEur(String((b.monthly_limit_cents ?? 0) / 100));
                          setThreshold(String(b.alert_threshold_pct ?? 80));
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        }}
                      >
                        Edit
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => handleDelete(b.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-secondary">
                    <div
                      className={`h-full rounded-full transition-all ${
                        over ? "bg-destructive" : alert ? "bg-amber-500" : "bg-primary"
                      }`}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- Invoices --------------------------------------------------------------
export function InvoicesPage() {
  const { projectId } = useCurrentContext();
  const { data, isLoading } = useQuery({
    queryKey: ["invoices_full", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("invoices")
        .select("*")
        .eq("project_id", projectId!)
        .order("paid_at", { ascending: false, nullsFirst: false })
        .limit(200);
      return data ?? [];
    },
  });

  return (
    <div>
      <PageHeader
        title="Invoices"
        description="Stripe invoices synced for this project."
        actions={
          <ExportMenu
            rows={(data ?? []).map((i: any) => ({
              external_id: i.external_id,
              customer: i.customer_external_id,
              status: i.status,
              amount_paid_eur: (i.amount_paid_cents ?? 0) / 100,
              currency: i.currency,
              paid_at: i.paid_at,
            }))}
            filename="invoices"
          />
        }
      />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Receipt} title="No invoices" description="Sync Stripe to import invoices." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Invoice</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Amount paid</th>
                  <th className="px-4 py-3">Paid</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.map((i: any) => (
                  <tr key={i.id}>
                    <td className="px-4 py-3 font-mono text-xs">{i.external_id}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{i.customer_external_id}</td>
                    <td className="px-4 py-3">
                      <Badge variant={i.status === "paid" ? "success" : i.status === "open" ? "warning" : "secondary"}>
                        {i.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right font-medium">
                      {formatCurrency((i.amount_paid_cents ?? 0) / 100, (i.currency ?? "eur").toUpperCase())}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {i.paid_at ? new Date(i.paid_at).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
