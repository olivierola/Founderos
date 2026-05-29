import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Users, Wallet, Activity, ShieldAlert, Sparkle, ScanLine } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
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
        supabase
          .from("metrics_snapshots")
          .select("metrics, snapshot_date")
          .eq("project_id", projectId!)
          .order("snapshot_date", { ascending: false })
          .limit(1)
          .maybeSingle(),
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
        metrics: snap.data?.metrics ?? null,
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

  const m = data?.metrics as
    | { mrr_cents?: number; currency?: string; customers?: number; active_subscriptions?: number }
    | null;
  const thirtyAgo = Date.now() - 30 * 86400_000;
  const costLast30 =
    (data?.costs ?? [])
      .filter((c: any) => new Date(c.created_at).getTime() >= thirtyAgo)
      .reduce((s: number, c: any) => s + (c.amount_cents ?? 0), 0) +
    (data?.llm ?? [])
      .filter((l: any) => new Date(l.created_at).getTime() >= thirtyAgo)
      .reduce((s: number, l: any) => s + (l.estimated_cost_cents ?? 0), 0);

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
          <Button size="sm" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/code/repositories`)}>
            <ScanLine className="h-4 w-4" /> Run scan
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="MRR"
          value={m?.mrr_cents != null ? formatCurrency(m.mrr_cents / 100, currency) : "—"}
          hint={m ? undefined : "Connect Stripe"}
          icon={TrendingUp}
        />
        <MetricCard
          label="Customers"
          value={m?.customers != null ? formatCompact(m.customers) : "—"}
          hint={m?.active_subscriptions != null ? `${m.active_subscriptions} active subs` : undefined}
          icon={Users}
        />
        <MetricCard
          label="Cost (30d)"
          value={costLast30 > 0 ? formatCurrency(costLast30 / 100, "EUR") : "—"}
          hint={costLast30 > 0 ? undefined : "No costs recorded"}
          icon={Wallet}
        />
        <MetricCard
          label="Code health"
          value={healthScore != null ? `${healthScore}/100` : "—"}
          hint={hasScan ? undefined : "Run a scan"}
          icon={Activity}
          trend={healthScore != null && healthScore >= 70 ? "up" : healthScore != null ? "down" : "flat"}
        />
      </div>

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
                  <Button size="sm" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/code/repositories`)}>
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
