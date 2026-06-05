import { useMemo } from "react";
import {
  TrendingUp,
  Users,
  Zap,
  Sparkles,
  Loader2,
  ArrowUpRight,
  ArrowDownRight,
  Star,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
} from "recharts";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { useGrowth, useEventDefinitions } from "./analytics";

function pct(n: number, digits = 0): string {
  return `${n.toFixed(digits)}%`;
}

export function GrowthPage() {
  const growth = useGrowth();
  const defs = useEventDefinitions();
  const g = growth.data;

  const keyEvents = useMemo(
    () => (defs.data ?? []).filter((d) => d.is_key_action).map((d) => d.event_name),
    [defs.data],
  );

  const wauLatestGrowth = g?.wau_series.length ? g.wau_series[g.wau_series.length - 1]!.growth_pct : 0;

  return (
    <div>
      <PageHeader
        title="Growth"
        description="The metrics that actually move the needle: stickiness, activation, power users and week-over-week growth — derived live from your event stream."
      />

      {growth.isLoading ? (
        <EmptyState icon={Loader2} title="Computing growth metrics…" />
      ) : !g ? (
        <EmptyState icon={TrendingUp} title="No data yet" description="Start tracking events to populate growth metrics." />
      ) : (
        <>
          {/* ── Headline KPIs ── */}
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Stickiness (DAU/MAU)"
              value={pct(g.stickiness_dau_mau)}
              hint="Share of monthly users active daily"
              icon={Zap}
              trend={g.stickiness_dau_mau >= 20 ? "up" : g.stickiness_dau_mau >= 10 ? "flat" : "down"}
            />
            <MetricCard
              label="WAU growth (WoW)"
              value={`${wauLatestGrowth >= 0 ? "+" : ""}${wauLatestGrowth.toFixed(1)}%`}
              hint="Weekly active users vs last week"
              icon={TrendingUp}
              trend={wauLatestGrowth > 0 ? "up" : wauLatestGrowth < 0 ? "down" : "flat"}
            />
            <MetricCard
              label="Activation rate"
              value={keyEvents.length ? pct(g.activation.rate) : "—"}
              hint={
                keyEvents.length
                  ? `${g.activation.activated}/${g.activation.cohort} new users activated`
                  : "Mark a key event to enable"
              }
              icon={Sparkles}
              trend={g.activation.rate >= 40 ? "up" : g.activation.rate >= 20 ? "flat" : "down"}
            />
            <MetricCard
              label="Power users"
              value={pct(g.power_user_rate)}
              hint={`${g.power_users} users · ${g.power_threshold}+ active days / 28d`}
              icon={Star}
              trend={g.power_user_rate >= 20 ? "up" : "flat"}
            />
          </div>

          {/* ── Active users row ── */}
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <MetricCard label="DAU" value={g.dau.toLocaleString()} hint="Active in last 24h" icon={Users} />
            <MetricCard label="WAU" value={g.wau.toLocaleString()} hint="Active in last 7 days" icon={Users} />
            <MetricCard
              label="MAU"
              value={g.mau.toLocaleString()}
              hint={`WAU/MAU ${pct(g.stickiness_wau_mau)}`}
              icon={Users}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* ── WAU growth chart ── */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Weekly active users</CardTitle>
              </CardHeader>
              <CardContent>
                {g.wau_series.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">Not enough history yet.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart data={g.wau_series}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="bucket" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--popover))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        formatter={((v: unknown, _n: unknown, p: any) => {
                          const n = Number(v) || 0;
                          const gp = p?.payload?.growth_pct as number | undefined;
                          return [
                            `${n.toLocaleString()} users${gp ? ` (${gp >= 0 ? "+" : ""}${gp.toFixed(1)}%)` : ""}`,
                            "WAU",
                          ];
                        }) as never}
                      />
                      <Bar dataKey="users" radius={[4, 4, 0, 0]}>
                        {g.wau_series.map((s, i) => (
                          <Cell key={i} fill={s.growth_pct >= 0 ? "#34d399" : "#f87171"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* ── New vs returning + power users ── */}
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>New vs returning (this week)</CardTitle>
                </CardHeader>
                <CardContent>
                  <NewReturning newUsers={g.new_users} returningUsers={g.returning_users} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-amber-400" /> Activation
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {keyEvents.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Mark at least one event as a <strong>key action</strong> in the Events catalog to measure activation.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-baseline justify-between">
                        <span className="text-2xl font-semibold">{pct(g.activation.rate)}</span>
                        <span className="text-xs text-muted-foreground">
                          {g.activation.activated}/{g.activation.cohort} activated
                        </span>
                      </div>
                      <div className="h-2.5 overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full bg-amber-400 transition-all"
                          style={{ width: `${Math.min(100, g.activation.rate)}%` }}
                        />
                      </div>
                      <div className="flex flex-wrap gap-1 pt-1">
                        {keyEvents.slice(0, 6).map((e) => (
                          <Badge key={e} variant="outline" className="text-[10px]">{e}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function NewReturning({ newUsers, returningUsers }: { newUsers: number; returningUsers: number }) {
  const total = newUsers + returningUsers;
  const newPct = total ? (newUsers / total) * 100 : 0;
  return (
    <div className="space-y-3">
      <div className="flex h-3 overflow-hidden rounded-full bg-secondary">
        <div className="h-full bg-sky-400" style={{ width: `${newPct}%` }} />
        <div className="h-full bg-violet-400" style={{ width: `${100 - newPct}%` }} />
      </div>
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-sky-400" />
          <ArrowUpRight className="h-3.5 w-3.5 text-sky-400" />
          <span className="font-medium">{newUsers.toLocaleString()}</span>
          <span className="text-muted-foreground">new</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-violet-400" />
          <ArrowDownRight className="h-3.5 w-3.5 text-violet-400" />
          <span className="font-medium">{returningUsers.toLocaleString()}</span>
          <span className="text-muted-foreground">returning</span>
        </div>
      </div>
      {total === 0 && <p className="text-xs text-muted-foreground">No active users this week yet.</p>}
    </div>
  );
}
