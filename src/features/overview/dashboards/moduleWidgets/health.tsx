import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, GitMerge, AlertOctagon, Gauge } from "lucide-react";
import { MetricCard } from "@/components/MetricCard";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { WidgetLoading, WidgetEmpty, WidgetSection, type ModuleWidgetProps } from "./shared";

/* ---------------- Status summary cards (from HealthStatusPage) ---------------- */

function useStatusData(projectId: string, refreshKey?: number) {
  const connectors = useQuery({
    queryKey: ["health_connectors", projectId, refreshKey ?? 0],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("connectors").select("provider, status").eq("project_id", projectId!);
      return data ?? [];
    },
  });
  const recentJobs = useQuery({
    queryKey: ["health_recent_jobs", projectId, refreshKey ?? 0],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_jobs")
        .select("status, created_at")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(20);
      return data ?? [];
    },
  });
  const openIncidents = useQuery({
    queryKey: ["open_incidents", projectId, refreshKey ?? 0],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("incidents")
        .select("id, severity")
        .eq("project_id", projectId!)
        .neq("status", "resolved");
      return data ?? [];
    },
  });
  return useMemo(() => {
    const connOk = (connectors.data ?? []).filter((c: any) => c.status === "connected").length;
    const connTotal = (connectors.data ?? []).length;
    const failed = (recentJobs.data ?? []).filter((j: any) => j.status === "failed").length;
    const incCount = openIncidents.data?.length ?? 0;
    const overall = incCount > 0 ? "incident" : failed > 0 ? "degraded" : connOk === connTotal ? "operational" : "warning";
    const loading = connectors.isLoading || recentJobs.isLoading || openIncidents.isLoading;
    return { connOk, connTotal, failed, incCount, overall, loading };
  }, [connectors.data, recentJobs.data, openIncidents.data, connectors.isLoading, recentJobs.isLoading, openIncidents.isLoading]);
}

export function HealthOverallCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const s = useStatusData(projectId, refreshKey);
  if (s.loading) return <WidgetLoading />;
  return <MetricCard label="Overall" value={s.overall} icon={Activity} trend={s.overall === "operational" ? "up" : "down"} />;
}

export function HealthConnectorsCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const s = useStatusData(projectId, refreshKey);
  if (s.loading) return <WidgetLoading />;
  return <MetricCard label="Connectors OK" value={`${s.connOk}/${s.connTotal}`} icon={GitMerge} />;
}

export function HealthFailedScansCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const s = useStatusData(projectId, refreshKey);
  if (s.loading) return <WidgetLoading />;
  return <MetricCard label="Failed scans (recent)" value={String(s.failed)} icon={AlertOctagon} trend={s.failed > 0 ? "down" : "flat"} />;
}

export function HealthOpenIncidentsCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const s = useStatusData(projectId, refreshKey);
  if (s.loading) return <WidgetLoading />;
  return <MetricCard label="Open incidents" value={String(s.incCount)} icon={AlertOctagon} trend={s.incCount > 0 ? "down" : "flat"} />;
}

/* ---------------- Performance cards (from PerformancePage) ---------------- */

function usePerf(projectId: string, refreshKey?: number) {
  const { data, isLoading } = useQuery({
    queryKey: ["scan_perf", projectId, refreshKey ?? 0],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_jobs")
        .select("status, started_at, finished_at")
        .eq("project_id", projectId!)
        .eq("status", "succeeded")
        .not("finished_at", "is", null)
        .order("created_at", { ascending: false })
        .limit(50);
      return data ?? [];
    },
  });
  const stats = useMemo(() => {
    const durations = (data ?? [])
      .map((j: any) => new Date(j.finished_at).getTime() - new Date(j.started_at).getTime())
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    if (durations.length === 0) return null;
    const p50 = durations[Math.floor(durations.length * 0.5)]!;
    const p95 = durations[Math.floor(durations.length * 0.95)] ?? p50;
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    return { p50, p95, avg, count: durations.length };
  }, [data]);
  return { stats, isLoading };
}

export function HealthP50LatencyCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const { stats, isLoading } = usePerf(projectId, refreshKey);
  if (isLoading) return <WidgetLoading />;
  if (!stats) return <WidgetEmpty message="Not enough data." />;
  return <MetricCard label="p50 scan latency" value={`${(stats.p50 / 1000).toFixed(1)}s`} icon={Gauge} />;
}

export function HealthP95LatencyCard({ projectId, refreshKey }: ModuleWidgetProps) {
  const { stats, isLoading } = usePerf(projectId, refreshKey);
  if (isLoading) return <WidgetLoading />;
  if (!stats) return <WidgetEmpty message="Not enough data." />;
  return <MetricCard label="p95 scan latency" value={`${(stats.p95 / 1000).toFixed(1)}s`} icon={Gauge} />;
}

/* ---------------- Errors list (from ErrorsPage) ---------------- */

export function HealthRecentErrorsList({ projectId, refreshKey }: ModuleWidgetProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["error_events", projectId, refreshKey ?? 0],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("error_events")
        .select("*")
        .eq("project_id", projectId!)
        .order("last_seen_at", { ascending: false })
        .limit(50);
      return data ?? [];
    },
  });
  if (isLoading) return <WidgetLoading />;
  if (!data || data.length === 0) return <WidgetEmpty message="No errors recorded." />;
  return (
    <WidgetSection title="Errors">
      <div className="space-y-2 overflow-auto">
        {data.map((e: any) => (
          <div key={e.id} className="rounded-md border border-border p-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge variant={e.level === "fatal" ? "destructive" : e.level === "warn" ? "warning" : "secondary"}>
                    {e.level}
                  </Badge>
                  <span className="truncate text-sm font-medium">{e.message}</span>
                </div>
                {e.url && <div className="mt-1 truncate text-xs text-muted-foreground">{e.url}</div>}
              </div>
              <div className="shrink-0 text-right text-xs text-muted-foreground">
                <div>{e.occurrences}×</div>
                <div>{new Date(e.last_seen_at).toLocaleDateString()}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </WidgetSection>
  );
}
