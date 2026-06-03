import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { MetricCard } from "@/components/MetricCard";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { WidgetLoading, WidgetEmpty, WidgetSection, type ModuleWidgetProps } from "./shared";

interface EventRow {
  id: string;
  event_name: string;
  customer_external_id: string | null;
  user_email: string | null;
  occurred_at: string;
}

function useEvents(projectId: string, refreshKey?: number) {
  return useQuery({
    queryKey: ["product_events", projectId, refreshKey ?? 0],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("product_events")
        .select("*")
        .eq("project_id", projectId!)
        .order("occurred_at", { ascending: false })
        .limit(200);
      return (data ?? []) as EventRow[];
    },
  });
}

function useStats(events: EventRow[] | undefined) {
  return useMemo(() => {
    const list = events ?? [];
    const last7 = Date.now() - 7 * 86400_000;
    const byName = new Map<string, number>();
    const dau = new Set<string>();
    list.forEach((e) => {
      if (new Date(e.occurred_at).getTime() >= last7 && e.user_email) dau.add(e.user_email.toLowerCase());
      byName.set(e.event_name, (byName.get(e.event_name) ?? 0) + 1);
    });
    return {
      total: list.length,
      uniqueUsers7d: dau.size,
      top: [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    };
  }, [events]);
}

export function EngagementEventsTrackedCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const { data, isLoading } = useEvents(projectId, refreshKey);
  const stats = useStats(data);
  if (isLoading) return <WidgetLoading />;
  return <MetricCard label="Events tracked" value={String(stats.total)} icon={Activity} />;
}

export function EngagementActiveUsersCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const { data, isLoading } = useEvents(projectId, refreshKey);
  const stats = useStats(data);
  if (isLoading) return <WidgetLoading />;
  return <MetricCard label="Active users (7d)" value={String(stats.uniqueUsers7d)} />;
}

export function EngagementTopEventCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const { data, isLoading } = useEvents(projectId, refreshKey);
  const stats = useStats(data);
  if (isLoading) return <WidgetLoading />;
  return (
    <MetricCard
      label="Top event"
      value={stats.top[0]?.[0] ?? "—"}
      hint={stats.top[0] ? `${stats.top[0][1]} events` : ""}
    />
  );
}

export function EngagementEventsPerDayChart({ projectId, refreshKey }: ModuleWidgetProps) {
  const { data: events, isLoading } = useEvents(projectId, refreshKey);
  const series = useMemo(() => {
    const days = 14;
    const buckets: Record<string, number> = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      buckets[d] = 0;
    }
    (events ?? []).forEach((e) => {
      const d = e.occurred_at.slice(0, 10);
      if (d in buckets) buckets[d]++;
    });
    return Object.entries(buckets).sort((a, b) => a[0].localeCompare(b[0]));
  }, [events]);
  if (isLoading) return <WidgetLoading />;
  if (series.every(([, v]) => v === 0)) return <WidgetEmpty message="No events yet." />;
  const max = Math.max(1, ...series.map(([, v]) => v));
  return (
    <WidgetSection title="Events / day (14d)">
      <div className="flex h-full items-end gap-1">
        {series.map(([d, v]) => (
          <div key={d} className="flex-1" title={`${d}: ${v}`}>
            <div className="rounded-t bg-primary/60" style={{ height: `${Math.max(4, (v / max) * 100)}%` }} />
          </div>
        ))}
      </div>
    </WidgetSection>
  );
}

export function EngagementTopEventsList({ projectId, refreshKey }: ModuleWidgetProps) {
  const { data, isLoading } = useEvents(projectId, refreshKey);
  const stats = useStats(data);
  if (isLoading) return <WidgetLoading />;
  if (stats.top.length === 0) return <WidgetEmpty message="No data." />;
  return (
    <WidgetSection title="Top events">
      <ul className="space-y-2 text-sm">
        {stats.top.map(([name, count]) => (
          <li key={name} className="flex items-center justify-between">
            <span className="truncate">{name}</span>
            <Badge variant="secondary">{count}</Badge>
          </li>
        ))}
      </ul>
    </WidgetSection>
  );
}

export function EngagementRecentEventsTable({ projectId, refreshKey }: ModuleWidgetProps) {
  const { data: events, isLoading } = useEvents(projectId, refreshKey);
  if (isLoading) return <WidgetLoading />;
  if (!events || events.length === 0) return <WidgetEmpty message="No events yet." />;
  return (
    <WidgetSection title="Recent events">
      <div className="h-full overflow-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-2 py-2">When</th>
              <th className="px-2 py-2">Event</th>
              <th className="px-2 py-2">User</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {events.slice(0, 25).map((e) => (
              <tr key={e.id}>
                <td className="px-2 py-2 text-xs text-muted-foreground">{new Date(e.occurred_at).toLocaleString()}</td>
                <td className="px-2 py-2 font-medium">{e.event_name}</td>
                <td className="px-2 py-2 text-xs text-muted-foreground">
                  {e.user_email ?? e.customer_external_id ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </WidgetSection>
  );
}
