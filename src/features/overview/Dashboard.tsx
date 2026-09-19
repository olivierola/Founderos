import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  TrendUpIcon as TrendingUp,
  UsersIcon as Users,
  WalletIcon as Wallet,
  PulseIcon as Activity,
  ShieldWarningIcon as ShieldAlert,
  SparkleIcon as Sparkle,
  ScanIcon as ScanLine,
  ArrowUpRightIcon as ArrowUpRight,
  ArrowDownRightIcon as ArrowDownRight,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { StatisticsCard7 } from "@/components/ui/statistics-card-7";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { formatCompact, formatCurrency } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface AiRisk {
  severity: string;
  category: string;
  message: string;
}
interface AiRec {
  title: string;
  category: string;
  explanation: string;
}

function sevVariant(s: string): "destructive" | "warning" | "secondary" | "info" {
  if (s === "critical" || s === "high") return "destructive";
  if (s === "medium" || s === "warning") return "warning";
  if (s === "info") return "info";
  return "secondary";
}

export function OverviewDashboard() {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { projectId, loading } = useCurrentContext();

  const { data, isLoading } = useQuery({
    queryKey: ["overview-dashboard", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const [snap, costs, llm, latestScan, alerts] = await Promise.all([
        // Two snapshots, not one: the KPI row shows a variation, and a
        // variation needs the period before it.
        supabase
          .from("metrics_snapshots")
          .select("metrics, snapshot_date")
          .eq("project_id", projectId!)
          .order("snapshot_date", { ascending: false })
          .limit(2),
        supabase.from("cost_records").select("amount_cents, created_at").eq("project_id", projectId!),
        supabase.from("llm_usage").select("estimated_cost_cents, created_at").eq("project_id", projectId!),
        supabase
          .from("scan_results")
          .select("ai_analysis, security_findings, created_at, repositories(full_name)")
          .eq("project_id", projectId!)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("alerts")
          .select("severity, title, status, created_at")
          .eq("project_id", projectId!)
          .order("created_at", { ascending: false })
          .limit(6),
      ]);
      return {
        metrics: snap.data?.[0]?.metrics ?? null,
        prevMetrics: snap.data?.[1]?.metrics ?? null,
        costs: costs.data ?? [],
        llm: llm.data ?? [],
        latestScan: latestScan.data ?? null,
        alerts: alerts.data ?? [],
      };
    },
  });

  if (loading || isLoading) {
    return (
      <div>
        <PageHeader title="Dashboard" />
        <EmptyState icon={Activity} title="Loading…" />
      </div>
    );
  }

  type Snapshot = { mrr_cents?: number; currency?: string; customers?: number; active_subscriptions?: number };
  const m = data?.metrics as Snapshot | null;
  const prev = data?.prevMetrics as Snapshot | null;

  const thirtyAgo = Date.now() - 30 * 86400_000;
  const sixtyAgo = Date.now() - 60 * 86400_000;
  /** Cost between two instants, both ledgers folded together. */
  const costBetween = (from: number, to: number) =>
    (data?.costs ?? [])
      .filter((c: any) => {
        const t = new Date(c.created_at).getTime();
        return t >= from && t < to;
      })
      .reduce((s: number, c: any) => s + (c.amount_cents ?? 0), 0) +
    (data?.llm ?? [])
      .filter((l: any) => {
        const t = new Date(l.created_at).getTime();
        return t >= from && t < to;
      })
      .reduce((s: number, l: any) => s + (l.estimated_cost_cents ?? 0), 0);

  const costLast30 = costBetween(thirtyAgo, Infinity);
  const costPrev30 = costBetween(sixtyAgo, thirtyAgo);

  /** Percentage variation, null when there is nothing to compare against. */
  const pctDelta = (now?: number | null, before?: number | null) =>
    now == null || before == null || before === 0 ? null : Math.round(((now - before) / before) * 1000) / 10;
  const fmtDelta = (d: number) => `${d > 0 ? "+" : ""}${d}%`;

  const mrrDelta = pctDelta(m?.mrr_cents, prev?.mrr_cents);
  const customersDelta = pctDelta(m?.customers, prev?.customers);
  const costDelta = pctDelta(costLast30, costPrev30 || null);

  const ai = (data?.latestScan as any)?.ai_analysis ?? {};
  const healthScore = typeof ai.code_health_score === "number" ? ai.code_health_score : null;
  const recs: AiRec[] = ai.recommendations ?? [];
  const risks: AiRisk[] = ai.key_risks ?? [];
  const currency = (m?.currency ?? "eur").toUpperCase();
  const hasScan = !!data?.latestScan;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Aggregated health, revenue, costs and alerts for this project."
        actions={
          <Button size="sm" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/repos/list`)}>
            <ScanLine className="h-4 w-4" /> Run scan
          </Button>
        }
      />

      <StatisticsCard7
        cards={[
          {
            key: "mrr",
            title: "MRR",
            subtitle: "Monthly recurring revenue",
            value: m?.mrr_cents != null ? formatCurrency(m.mrr_cents / 100, currency) : "—",
            icon: TrendingUp,
            badge: mrrDelta != null
              ? { text: fmtDelta(mrrDelta), icon: mrrDelta >= 0 ? ArrowUpRight : ArrowDownRight, tone: mrrDelta >= 0 ? "positive" : "negative" }
              : undefined,
            subtext: (
              <span className="text-muted-foreground">
                {m ? (mrrDelta != null ? "vs previous snapshot" : "no earlier snapshot to compare") : "Connect Stripe"}
              </span>
            ),
          },
          {
            key: "customers",
            title: "Customers",
            subtitle: "Accounts on record",
            value: m?.customers != null ? formatCompact(m.customers) : "—",
            icon: Users,
            badge: customersDelta != null
              ? { text: fmtDelta(customersDelta), icon: customersDelta >= 0 ? ArrowUpRight : ArrowDownRight, tone: customersDelta >= 0 ? "positive" : "negative" }
              : undefined,
            subtext: (
              <span className="text-muted-foreground">
                {m?.active_subscriptions != null ? `${m.active_subscriptions} active subs` : "—"}
              </span>
            ),
          },
          {
            key: "cost",
            title: "Cost",
            subtitle: "Last 30 days",
            value: costLast30 > 0 ? formatCurrency(costLast30 / 100, "EUR") : "—",
            icon: Wallet,
            // Spending more is not good news: the tone is inverted on purpose.
            badge: costDelta != null
              ? { text: fmtDelta(costDelta), icon: costDelta >= 0 ? ArrowUpRight : ArrowDownRight, tone: costDelta > 0 ? "negative" : "positive" }
              : undefined,
            subtext: (
              <span className="text-muted-foreground">
                {costLast30 > 0
                  ? costPrev30 > 0 ? `${formatCurrency(costPrev30 / 100, "EUR")} previous 30 days` : "first recorded period"
                  : "No costs recorded"}
              </span>
            ),
          },
          {
            key: "health",
            title: "Code health",
            subtitle: hasScan ? "Latest scan" : "Never scanned",
            value: healthScore != null ? `${healthScore}/100` : "—",
            valueClassName: healthScore == null ? undefined
              : healthScore >= 70 ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
            icon: Activity,
            badge: healthScore != null
              ? { text: healthScore >= 70 ? "healthy" : "at risk", tone: healthScore >= 70 ? "positive" : "negative" }
              : undefined,
            subtext: <span className="text-muted-foreground">{hasScan ? "from the last repository scan" : "Run a scan"}</span>,
          },
        ]}
      />

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkle className="h-4 w-4 text-primary" /> AI recommendations
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!hasScan ? (
              <EmptyState
                icon={Sparkle}
                title="No analysis yet"
                description="Run a code scan to get AI recommendations for this project."
                action={
                  <Button size="sm" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/repos/list`)}>
                    <ScanLine className="h-4 w-4" /> Run scan
                  </Button>
                }
              />
            ) : recs.length === 0 && risks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recommendations from the latest scan.</p>
            ) : (
              <div className="space-y-3">
                {recs.slice(0, 3).map((r, i) => (
                  <div key={`rec-${i}`} className="flex items-start gap-3 rounded-md border border-border p-3">
                    <Badge variant="info">{r.category}</Badge>
                    <div className="flex-1">
                      <div className="text-sm font-medium">{r.title}</div>
                      <div className="text-xs text-muted-foreground">{r.explanation}</div>
                    </div>
                  </div>
                ))}
                {risks.slice(0, 3).map((r, i) => (
                  <div key={`risk-${i}`} className="flex items-start gap-3 rounded-md border border-border p-3">
                    <Badge variant={sevVariant(r.severity)}>{r.severity}</Badge>
                    <div className="flex-1">
                      <div className="text-sm font-medium">{r.message}</div>
                      <div className="text-xs text-muted-foreground">{r.category}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-400" /> Recent alerts
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(data?.alerts ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No alerts. All clear.</p>
            ) : (
              <div className="space-y-3 text-sm">
                {data!.alerts.map((a: any, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-2">
                    <span className="truncate">{a.title}</span>
                    <Badge variant={sevVariant(a.severity)}>{a.severity}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
