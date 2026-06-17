import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Users,
  UserPlus,
  UserMinus,
  AlertTriangle,
  ShieldAlert,
  CreditCard,
  CheckCircle2,
  Mail,
  ClipboardCheck,
  BarChart3,
  Megaphone,
  Loader2,
  ArrowUpRight,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { formatCurrency, formatCompact, cn } from "@/lib/utils";

interface Snapshot {
  id: string;
  snapshot_date: string;
  mrr_cents: number;
  arr_cents: number;
  mrr_growth_pct: number | null;
  net_new_mrr_cents: number;
  total_users: number;
  active_users_30d: number;
  new_signups_7d: number;
  churn_rate_30d: number | null;
  churn_users_30d: number;
  paying_users: number;
  activation_rate: number | null;
  top_features: Array<{ feature: string; usage_count: number }>;
  open_alerts: number;
  open_incidents: number;
  failed_payments_7d: number;
  pending_approvals: number;
  created_at: string;
}

export function SaasAnalyticsPage() {
  const { workspaceId, projectId, workspace, project } = useCurrentContext();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const { data: snapshot, isLoading } = useQuery({
    queryKey: ["saas_analytics_snapshot", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("saas_analytics_snapshots")
        .select("*")
        .eq("project_id", projectId!)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data as Snapshot | null;
    },
  });

  async function refresh() {
    if (!workspaceId || !projectId) return;
    setRefreshing(true);
    try {
      await callEdge("generate-saas-analytics-snapshot", {
        workspace_id: workspaceId,
        project_id: projectId,
      });
      await queryClient.invalidateQueries({ queryKey: ["saas_analytics_snapshot", projectId] });
    } finally {
      setRefreshing(false);
    }
  }

  const base = `/app/${workspace?.slug ?? ""}/${project?.slug ?? ""}`;

  return (
    <div>
      <PageHeader
        title="SaaS Analytics"
        description="Actionable view of your SaaS KPIs — every metric is one click away from the right operational lever."
        actions={
          <Button size="sm" onClick={refresh} disabled={refreshing || !workspaceId}>
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh snapshot
          </Button>
        }
      />

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !snapshot ? (
        <EmptyState
          icon={BarChart3}
          title="No snapshot yet"
          description="Click Refresh snapshot to compute today's KPIs from your latest data."
          action={
            <Button onClick={refresh} disabled={refreshing}>
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Compute now
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          <div className="text-xs text-muted-foreground">
            Snapshot from {new Date(snapshot.created_at).toLocaleString()}
          </div>

          {/* ===== Revenue band ===== */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            <KpiTile
              label="MRR"
              value={formatCurrency(snapshot.mrr_cents / 100)}
              trend={snapshot.mrr_growth_pct}
              icon={TrendingUp}
              actionLabel="Open Revenue"
              actionTo={`${base}/saas-analytics/revenue`}
            />
            <KpiTile
              label="ARR"
              value={formatCurrency(snapshot.arr_cents / 100)}
              icon={TrendingUp}
              actionLabel="Investor metrics"
              actionTo={`${base}/saas-analytics/investor-metrics`}
            />
            <KpiTile
              label="Net new MRR (30d)"
              value={formatCurrency(snapshot.net_new_mrr_cents / 100)}
              icon={UserPlus}
              actionLabel="Subscriptions"
              actionTo={`${base}/saas-analytics/subscriptions`}
            />
            <KpiTile
              label="Paying users"
              value={formatCompact(snapshot.paying_users)}
              icon={CreditCard}
              actionLabel="Customers"
              actionTo={`${base}/saas-analytics/customers`}
            />
          </div>

          {/* ===== Users / retention band ===== */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
            <KpiTile
              label="Total users"
              value={formatCompact(snapshot.total_users)}
              icon={Users}
              actionLabel="All users"
              actionTo={`${base}/saas-analytics/users-all`}
            />
            <KpiTile
              label="Active 30d"
              value={formatCompact(snapshot.active_users_30d)}
              icon={Users}
              actionLabel="Engagement"
              actionTo={`${base}/saas-analytics/users-engagement`}
            />
            <KpiTile
              label="Signups 7d"
              value={formatCompact(snapshot.new_signups_7d)}
              icon={UserPlus}
              actionLabel="Funnels"
              actionTo={`${base}/saas-analytics/users-funnels`}
            />
            <KpiTile
              label="Churn rate 30d"
              value={
                snapshot.churn_rate_30d != null
                  ? `${(snapshot.churn_rate_30d * 100).toFixed(1)}%`
                  : "—"
              }
              tone={(snapshot.churn_rate_30d ?? 0) > 0.05 ? "warn" : "default"}
              icon={UserMinus}
              actionLabel="Churn risk"
              actionTo={`${base}/saas-analytics/users-churn`}
            />
          </div>

          {/* ===== Activation + top features ===== */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <Card>
              <CardContent className="space-y-3 p-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Activation rate</span>
                  <Badge variant="outline">30d active / total</Badge>
                </div>
                <div className="text-3xl font-semibold">
                  {snapshot.activation_rate != null
                    ? `${(snapshot.activation_rate * 100).toFixed(1)}%`
                    : "—"}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-[hsl(var(--accent-2))]"
                    style={{
                      width: `${Math.min(100, (snapshot.activation_rate ?? 0) * 100)}%`,
                    }}
                  />
                </div>
                <Link
                  to={`${base}/saas-analytics/users-funnels`}
                  className="inline-flex items-center gap-1 text-xs text-[hsl(var(--primary-soft))] hover:underline"
                >
                  Inspect activation funnel <ArrowUpRight className="h-3 w-3" />
                </Link>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2">
              <CardContent className="space-y-3 p-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Top features (30d)</span>
                  <Link
                    to={`${base}/saas-analytics/users-engagement`}
                    className="text-xs text-[hsl(var(--primary-soft))] hover:underline"
                  >
                    See all engagement →
                  </Link>
                </div>
                {snapshot.top_features.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No feature usage events tracked yet.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {snapshot.top_features.map((f) => (
                      <li key={f.feature} className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.feature}</span>
                        <div className="h-1.5 w-32 overflow-hidden rounded-full bg-secondary">
                          <div
                            className="h-full rounded-full bg-[hsl(var(--primary-soft))]"
                            style={{
                              width: `${
                                (f.usage_count / snapshot.top_features[0].usage_count) * 100
                              }%`,
                            }}
                          />
                        </div>
                        <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
                          {formatCompact(f.usage_count)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ===== Operational actions band ===== */}
          <div>
            <h2 className="mb-3 text-base font-semibold">Needs an action</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
              <ActionTile
                label="Open alerts"
                value={snapshot.open_alerts}
                icon={AlertTriangle}
                tone={snapshot.open_alerts > 0 ? "warn" : "calm"}
                actionLabel="Review alerts"
                actionTo={`${base}/actions/alerts`}
              />
              <ActionTile
                label="Open incidents"
                value={snapshot.open_incidents}
                icon={ShieldAlert}
                tone={snapshot.open_incidents > 0 ? "danger" : "calm"}
                actionLabel="Open incidents"
                actionTo={`${base}/saas-analytics/health-incidents`}
              />
              <ActionTile
                label="Failed payments 7d"
                value={snapshot.failed_payments_7d}
                icon={CreditCard}
                tone={snapshot.failed_payments_7d > 0 ? "warn" : "calm"}
                actionLabel="Billing operations"
                actionTo={`${base}/actions/stripe-operations`}
              />
              <ActionTile
                label="Pending approvals"
                value={snapshot.pending_approvals}
                icon={ClipboardCheck}
                tone={snapshot.pending_approvals > 0 ? "warn" : "calm"}
                actionLabel="Actions Center"
                actionTo={`${base}/actions/quick-actions`}
              />
            </div>
          </div>

          {/* ===== Suggested next actions ===== */}
          <Card>
            <CardContent className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-medium">Suggested next actions</span>
                <Badge variant="outline">heuristics</Badge>
              </div>
              <div className="space-y-2">
                {suggestActions(snapshot, base).map((s) => {
                  const Icon = s.icon;
                  return (
                    <Link
                      key={s.label}
                      to={s.to}
                      className="flex items-start justify-between gap-3 rounded-md border border-border p-3 transition-colors hover:bg-secondary/40"
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <div
                          className={cn(
                            "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                            s.tone === "warn"
                              ? "bg-amber-500/15 text-amber-400"
                              : s.tone === "danger"
                                ? "bg-destructive/15 text-destructive"
                                : "bg-[hsl(var(--accent-2)/0.15)] text-[hsl(var(--accent-2))]",
                          )}
                        >
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{s.label}</div>
                          <div className="text-xs text-muted-foreground">{s.detail}</div>
                        </div>
                      </div>
                      <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </Link>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

interface KpiTileProps {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  trend?: number | null;
  tone?: "default" | "warn";
  actionLabel?: string;
  actionTo?: string;
}

function KpiTile({ label, value, icon: Icon, trend, tone = "default", actionLabel, actionTo }: KpiTileProps) {
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className={cn("h-4 w-4", tone === "warn" ? "text-amber-400" : "text-muted-foreground")} />
        </div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {trend != null && (
          <div
            className={cn(
              "inline-flex items-center gap-1 text-xs",
              trend >= 0 ? "text-[hsl(var(--accent-2))]" : "text-destructive",
            )}
          >
            {trend >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {trend >= 0 ? "+" : ""}
            {trend.toFixed(1)}%
            <span className="text-muted-foreground">vs prev</span>
          </div>
        )}
        {actionLabel && actionTo && (
          <Link
            to={actionTo}
            className="inline-flex items-center gap-1 text-xs text-[hsl(var(--primary-soft))] hover:underline"
          >
            {actionLabel} <ArrowUpRight className="h-3 w-3" />
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

interface ActionTileProps {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  tone: "calm" | "warn" | "danger";
  actionLabel: string;
  actionTo: string;
}

function ActionTile({ label, value, icon: Icon, tone, actionLabel, actionTo }: ActionTileProps) {
  const toneClass =
    tone === "danger"
      ? "border-destructive/30 bg-destructive/5"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/5"
        : "";
  const iconClass =
    tone === "danger"
      ? "bg-destructive/15 text-destructive"
      : tone === "warn"
        ? "bg-amber-500/15 text-amber-400"
        : "bg-[hsl(var(--accent-2)/0.15)] text-[hsl(var(--accent-2))]";

  return (
    <Card className={toneClass}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <div className={cn("flex h-8 w-8 items-center justify-center rounded-md", iconClass)}>
            <Icon className="h-4 w-4" />
          </div>
          <span className="text-2xl font-semibold tabular-nums">{value}</span>
        </div>
        <div>
          <div className="text-sm font-medium">{label}</div>
          {value === 0 && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3 w-3 text-[hsl(var(--accent-2))]" /> All clear
            </div>
          )}
        </div>
        <Link
          to={actionTo}
          className="inline-flex items-center gap-1 text-xs text-[hsl(var(--primary-soft))] hover:underline"
        >
          {actionLabel} <ArrowUpRight className="h-3 w-3" />
        </Link>
      </CardContent>
    </Card>
  );
}

/* Heuristic action suggestions based on the snapshot. */
function suggestActions(s: Snapshot, base: string) {
  const out: Array<{
    label: string;
    detail: string;
    to: string;
    icon: React.ComponentType<{ className?: string }>;
    tone: "info" | "warn" | "danger";
  }> = [];

  if ((s.churn_rate_30d ?? 0) > 0.05) {
    out.push({
      label: "Churn rate above 5%",
      detail: "Send a win-back email to recently churned users.",
      to: `${base}/actions/email-sender`,
      icon: Mail,
      tone: "warn",
    });
  }
  if (s.failed_payments_7d > 0) {
    out.push({
      label: `${s.failed_payments_7d} failed payment${s.failed_payments_7d > 1 ? "s" : ""}`,
      detail: "Retry collection or contact the customer from Billing Operations.",
      to: `${base}/actions/stripe-operations`,
      icon: CreditCard,
      tone: "warn",
    });
  }
  if (s.pending_approvals > 0) {
    out.push({
      label: `${s.pending_approvals} pending approval${s.pending_approvals > 1 ? "s" : ""}`,
      detail: "Review and approve admin actions awaiting validation.",
      to: `${base}/actions/quick-actions`,
      icon: ClipboardCheck,
      tone: "info",
    });
  }
  if (s.open_incidents > 0) {
    out.push({
      label: `${s.open_incidents} open incident${s.open_incidents > 1 ? "s" : ""}`,
      detail: "Communicate status to users and resolve incidents.",
      to: `${base}/saas-analytics/health-incidents`,
      icon: ShieldAlert,
      tone: "danger",
    });
  }
  if (s.new_signups_7d > 0 && (s.activation_rate ?? 0) < 0.3) {
    out.push({
      label: "Low activation on recent signups",
      detail: "Draft an onboarding email for the last cohort.",
      to: `${base}/office/gen-copy`,
      icon: Megaphone,
      tone: "info",
    });
  }
  if (out.length === 0) {
    out.push({
      label: "Nothing urgent — keep shipping",
      detail: "No alerts, no failed payments, healthy churn. Review the dashboard for context.",
      to: `${base}/actions/dashboard`,
      icon: CheckCircle2,
      tone: "info",
    });
  }
  return out;
}
