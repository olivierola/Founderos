import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ArrowDownToLine, ArrowUpFromLine, Wallet, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { callEdge } from "@/lib/edge";
import { formatCurrency } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useStripeConnector } from "@/hooks/useFinance";

interface Txn {
  id: string;
  amount_cents: number;
  fee_cents: number;
  net_cents: number;
  currency: string;
  type: string;
  category: string;
  description: string;
  status: string;
  created: string;
  available_on: string;
}

// Stripe balance-transaction types grouped into the screenshot's tabs.
const TABS: { value: string; label: string; types: string[] | null }[] = [
  { value: "all", label: "All activity", types: null },
  { value: "payments", label: "Payments", types: ["charge", "payment"] },
  { value: "payouts", label: "Payouts", types: ["payout"] },
  { value: "topups", label: "Top-ups", types: ["topup"] },
  { value: "refunds", label: "Refunds", types: ["refund", "payment_refund"] },
];

function money(cents: number, currency: string) {
  return formatCurrency(cents / 100, currency);
}

function typeBadge(type: string) {
  if (type === "payout") return <Badge variant="secondary">Payout</Badge>;
  if (type === "topup") return <Badge variant="info">Top-up</Badge>;
  if (type.includes("refund")) return <Badge variant="warning">Refund</Badge>;
  if (type === "charge" || type === "payment") return <Badge variant="success">Payment</Badge>;
  return <Badge variant="outline">{type}</Badge>;
}

export function TransactionsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const connector = useStripeConnector(projectId);
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["stripe-transactions", projectId],
    enabled: !!projectId && !!workspaceId && !!connector.data,
    queryFn: async () => {
      return await callEdge<{ rows: Txn[]; balance_cents: number }>("stripe-transactions", {
        workspace_id: workspaceId,
        project_id: projectId,
        limit: 500,
      });
    },
  });

  const rows = data?.rows ?? [];
  const currency = rows[0]?.currency ?? "EUR";

  const filtered = useMemo(() => {
    const tabDef = TABS.find((t) => t.value === tab);
    let list = rows;
    if (tabDef?.types) list = list.filter((r) => tabDef.types!.includes(r.type));
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) =>
          r.description.toLowerCase().includes(q) ||
          r.id.toLowerCase().includes(q) ||
          r.type.toLowerCase().includes(q),
      );
    }
    return list;
  }, [rows, tab, search]);

  const stats = useMemo(() => {
    let grossIn = 0, fees = 0, net = 0, paidOut = 0;
    rows.forEach((r) => {
      net += r.net_cents;
      fees += r.fee_cents;
      if (r.amount_cents > 0) grossIn += r.amount_cents;
      if (r.type === "payout") paidOut += Math.abs(r.amount_cents);
    });
    return { grossIn, fees, net, paidOut };
  }, [rows]);

  if (!workspaceId || !projectId) {
    return <PageHeader title="Transactions" />;
  }

  if (!connector.isLoading && !connector.data) {
    return (
      <div>
        <PageHeader title="Transactions" description="Money flow from your Stripe balance — payments, payouts, refunds and fees." />
        <EmptyState
          icon={Wallet}
          title="Stripe not connected"
          description="Connect Stripe from Integrations → Catalog to see your balance transactions."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Transactions"
        description="Money flow from your Stripe balance — payments, payouts, refunds and fees."
        actions={
          <div className="flex gap-2">
            <ExportMenu
              rows={filtered.map((r) => ({
                id: r.id,
                date: r.created,
                type: r.type,
                amount: r.amount_cents / 100,
                fee: r.fee_cents / 100,
                net: r.net_cents / 100,
                currency: r.currency,
                description: r.description,
                status: r.status,
              }))}
              filename="transactions"
            />
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <MetricCard label="Gross in" value={money(stats.grossIn, currency)} icon={ArrowDownToLine} />
        <MetricCard label="Fees" value={money(stats.fees, currency)} />
        <MetricCard label="Paid out" value={money(stats.paidOut, currency)} icon={ArrowUpFromLine} />
        <MetricCard label="Net balance" value={money(stats.net, currency)} icon={Wallet} />
      </div>

      {/* Tabs */}
      <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === t.value
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto pb-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search description or ID…"
            className="h-9 w-56"
          />
        </div>
      </div>

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading transactions…" />
      ) : error ? (
        <EmptyState icon={Wallet} title="Could not load transactions" description={(error as Error).message} />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Wallet} title="No transactions" description="No balance activity for this filter yet." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3 text-right">Fee</th>
                    <th className="px-4 py-3 text-right">Net</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3">Balance operation</th>
                    <th className="px-4 py-3">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((r) => (
                    <tr key={r.id} className="hover:bg-secondary/40">
                      <td className={`px-4 py-3 text-right tabular-nums ${r.amount_cents < 0 ? "text-muted-foreground" : ""}`}>
                        {money(r.amount_cents, r.currency)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                        {r.fee_cents ? `-${money(r.fee_cents, r.currency)}` : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">{money(r.net_cents, r.currency)}</td>
                      <td className="px-4 py-3">{typeBadge(r.type)}</td>
                      <td className="px-4 py-3">
                        <span className="block max-w-[260px] truncate">{r.description || r.category}</span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{r.id}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(r.created).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              {filtered.length} of {rows.length} elements
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
