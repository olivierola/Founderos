import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  GitMerge,
  Bug,
  Gauge,
  AlertOctagon,
  Plus,
  ExternalLink,
  Loader2,
  RefreshCw,
  CheckCircle2,
  Trash2,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { MetricCard } from "@/components/MetricCard";
import { SparkChart } from "@/components/SparkChart";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

const STORAGE_KEY = "founderos:uptime-monitors";

interface Monitor {
  id: string;
  url: string;
  lastStatus?: number;
  lastChecked?: string;
  lastLatencyMs?: number;
}

function loadMonitors(): Monitor[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function saveMonitors(list: Monitor[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

// --- Status ---------------------------------------------------------------
export function HealthStatusPage() {
  const { projectId } = useCurrentContext();
  const { data: connectors } = useQuery({
    queryKey: ["health_connectors", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("connectors").select("provider, status").eq("project_id", projectId!);
      return data ?? [];
    },
  });
  const { data: recentJobs } = useQuery({
    queryKey: ["health_recent_jobs", projectId],
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
  const { data: openIncidents } = useQuery({
    queryKey: ["open_incidents", projectId],
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

  const connOk = (connectors ?? []).filter((c: any) => c.status === "connected").length;
  const connTotal = (connectors ?? []).length;
  const failed = (recentJobs ?? []).filter((j: any) => j.status === "failed").length;
  const incCount = openIncidents?.length ?? 0;
  const overall = incCount > 0 ? "incident" : failed > 0 ? "degraded" : connOk === connTotal ? "operational" : "warning";

  return (
    <div>
      <PageHeader title="Status" description="Live health summary across the project." />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <MetricCard label="Overall" value={overall} icon={Activity} trend={overall === "operational" ? "up" : "down"} />
        <MetricCard label="Connectors OK" value={`${connOk}/${connTotal}`} icon={GitMerge} />
        <MetricCard label="Failed scans (recent)" value={String(failed)} icon={AlertOctagon} trend={failed > 0 ? "down" : "flat"} />
        <MetricCard label="Open incidents" value={String(incCount)} icon={AlertOctagon} trend={incCount > 0 ? "down" : "flat"} />
      </div>
    </div>
  );
}

// --- Uptime --------------------------------------------------------------
export function UptimePage() {
  const [monitors, setMonitors] = useState<Monitor[]>(() => loadMonitors());
  const [url, setUrl] = useState("");
  const [checking, setChecking] = useState<string | null>(null);

  function add() {
    if (!url.trim()) return;
    const next = [...monitors, { id: crypto.randomUUID(), url: url.trim() }];
    setMonitors(next);
    saveMonitors(next);
    setUrl("");
  }
  function remove(id: string) {
    const next = monitors.filter((m) => m.id !== id);
    setMonitors(next);
    saveMonitors(next);
  }
  async function check(m: Monitor) {
    setChecking(m.id);
    const start = Date.now();
    try {
      const res = await fetch(m.url, { method: "HEAD", mode: "no-cors" });
      const lat = Date.now() - start;
      const next = monitors.map((x) =>
        x.id === m.id ? { ...x, lastStatus: res.status || 200, lastChecked: new Date().toISOString(), lastLatencyMs: lat } : x,
      );
      setMonitors(next);
      saveMonitors(next);
    } catch {
      const lat = Date.now() - start;
      const next = monitors.map((x) =>
        x.id === m.id ? { ...x, lastStatus: -1, lastChecked: new Date().toISOString(), lastLatencyMs: lat } : x,
      );
      setMonitors(next);
      saveMonitors(next);
    } finally {
      setChecking(null);
    }
  }

  useEffect(() => {
    const id = setInterval(() => monitors.forEach(check), 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitors.length]);

  return (
    <div>
      <PageHeader title="Uptime" description="Browser-side URL pings, auto-checked every 60s." />
      <Card className="mb-6">
        <CardContent className="flex gap-2 p-4">
          <Input placeholder="https://your-saas.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button onClick={add}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </CardContent>
      </Card>
      {monitors.length === 0 ? (
        <EmptyState icon={Activity} title="No monitors yet" />
      ) : (
        <div className="space-y-2">
          {monitors.map((m) => (
            <Card key={m.id}>
              <CardContent className="flex items-center justify-between gap-3 p-4">
                <div className="flex items-center gap-2 truncate">
                  <ExternalLink className="h-4 w-4 text-muted-foreground" />
                  <a href={m.url} target="_blank" rel="noreferrer" className="truncate text-sm hover:underline">
                    {m.url}
                  </a>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  {typeof m.lastStatus === "number" && (
                    <Badge variant={m.lastStatus === -1 ? "destructive" : "success"}>
                      {m.lastStatus === -1 ? "unreachable" : `HTTP ${m.lastStatus || "OK"}`}
                    </Badge>
                  )}
                  {typeof m.lastLatencyMs === "number" && <span>{m.lastLatencyMs}ms</span>}
                  {m.lastChecked && (
                    <span className="text-muted-foreground">{new Date(m.lastChecked).toLocaleTimeString()}</span>
                  )}
                  <Button size="sm" variant="outline" onClick={() => check(m)} disabled={checking === m.id}>
                    {checking === m.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Check"}
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => remove(m.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Errors -------------------------------------------------------------
export function ErrorsPage() {
  const { projectId } = useCurrentContext();
  const { data, isLoading } = useQuery({
    queryKey: ["error_events", projectId],
    enabled: !!projectId,
    refetchInterval: 10_000,
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

  return (
    <div>
      <PageHeader
        title="Errors"
        description="Browser and server errors reported through the report-error Edge Function. Auto-deduped by fingerprint."
        actions={
          <ExportMenu
            rows={(data ?? []).map((e: any) => ({
              level: e.level,
              message: e.message,
              url: e.url,
              occurrences: e.occurrences,
              last_seen: e.last_seen_at,
            }))}
            filename="errors"
          />
        }
      />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={Bug}
          title="No errors recorded"
          description="When your app calls report-error, deduped issues land here."
        />
      ) : (
        <div className="space-y-2">
          {data.map((e: any) => (
            <Card key={e.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <Badge variant={e.level === "fatal" ? "destructive" : e.level === "warn" ? "warning" : "secondary"}>
                        {e.level}
                      </Badge>
                      <span className="text-sm font-medium">{e.message}</span>
                    </div>
                    {e.url && <div className="mt-1 text-xs text-muted-foreground">{e.url}</div>}
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>{e.occurrences}×</div>
                    <div>{new Date(e.last_seen_at).toLocaleString()}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Performance ------------------------------------------------------
export function PerformancePage() {
  const { projectId } = useCurrentContext();
  const { data } = useQuery({
    queryKey: ["scan_perf", projectId],
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

  return (
    <div>
      <PageHeader
        title="Performance"
        description="End-to-end scan latency from FounderOS itself. Connect Sentry / Vercel for app-side performance (V2)."
      />
      {!stats ? (
        <EmptyState icon={Gauge} title="Not enough data" />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <MetricCard label="p50 scan latency" value={`${(stats.p50 / 1000).toFixed(1)}s`} icon={Gauge} />
          <MetricCard label="p95 scan latency" value={`${(stats.p95 / 1000).toFixed(1)}s`} />
          <MetricCard label="avg" value={`${(stats.avg / 1000).toFixed(1)}s`} />
          <MetricCard label="samples" value={String(stats.count)} />
        </div>
      )}
    </div>
  );
}

// --- Deployments -----------------------------------------------------
export function DeploymentsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["deployments", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("deployments")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at_provider", { ascending: false, nullsFirst: false })
        .limit(200);
      return data ?? [];
    },
  });

  // Aggregate hourly counts over the last 12 hours for the SparkChart.
  const seriesAll = useMemo(() => bucketByHour(data ?? [], 12), [data]);
  const seriesByProvider = useMemo(() => {
    const groups = new Map<string, any[]>();
    (data ?? []).forEach((d: any) => {
      const k = d.provider ?? "unknown";
      const arr = groups.get(k) ?? [];
      arr.push(d);
      groups.set(k, arr);
    });
    return Array.from(groups.entries()).map(([provider, rows]) => ({
      provider,
      total: rows.length,
      series: bucketByHour(rows, 12),
    }));
  }, [data]);

  async function sync() {
    if (!workspaceId || !projectId) return;
    setSyncing(true);
    try {
      await callEdge("sync-deployments", { workspace_id: workspaceId, project_id: projectId });
      queryClient.invalidateQueries({ queryKey: ["deployments", projectId] });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Deployments"
        description="Real deployments synced from Vercel, GitHub Actions, Netlify, Render and Cloudflare Pages."
        actions={
          <div className="flex gap-2">
            <ExportMenu
              rows={(data ?? []).map((d: any) => ({
                when: d.created_at_provider,
                provider: d.provider,
                env: d.environment,
                ref: d.ref,
                sha: d.sha,
                state: d.state,
                url: d.url,
              }))}
              filename="deployments"
            />
            <Button onClick={sync} disabled={syncing} size="sm">
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync deployments
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={GitMerge}
          title="No deployments yet"
          description="Connect Vercel, GitHub, Netlify, Render or Cloudflare and click Sync to import deployments."
          action={
            <Button onClick={sync} disabled={syncing}>
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync now
            </Button>
          }
        />
      ) : (
        <>
          {/* Sparkline summary — total deploys & per-provider trends (last 12h). */}
          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <SparkChart
              title="Deployments"
              subtitle="Total (12h)"
              total={seriesAll.reduce((s, p) => s + (p.y as number), 0)}
              data={seriesAll}
              xLabels={{ start: "12h ago", end: "Just now" }}
              height={150}
            />
            {seriesByProvider.slice(0, 5).map((g) => (
              <SparkChart
                key={g.provider}
                title={providerLabel(g.provider)}
                subtitle="Deployments (12h)"
                total={g.series.reduce((s, p) => s + (p.y as number), 0)}
                data={g.series}
                xLabels={{ start: "12h ago", end: "Just now" }}
                height={150}
                color={providerColor(g.provider)}
              />
            ))}
          </div>

          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">When</th>
                    <th className="px-4 py-3">Provider</th>
                    <th className="px-4 py-3">Env</th>
                    <th className="px-4 py-3">Ref</th>
                    <th className="px-4 py-3">SHA</th>
                    <th className="px-4 py-3">State</th>
                    <th className="px-4 py-3">URL</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.map((d: any) => (
                    <tr key={d.id}>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {d.created_at_provider ? new Date(d.created_at_provider).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-[10px]">{providerLabel(d.provider)}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline">{d.environment}</Badge>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{d.ref ?? "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{d.sha?.slice(0, 8) ?? "—"}</td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            d.state === "ready" || d.state === "success" || d.state === "live"
                              ? "success"
                              : d.state === "failure" || d.state === "error" || d.state === "failed"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {d.state ?? "unknown"}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        {d.url ? (
                          <a
                            href={d.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-[hsl(var(--primary-soft))] hover:underline"
                          >
                            open ↗
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/* Bucket deployments by hour over the last N hours, oldest → newest. */
function bucketByHour(rows: Array<{ created_at_provider: string | null }>, hours: number) {
  const now = Date.now();
  const buckets = new Array(hours).fill(0);
  rows.forEach((r) => {
    if (!r.created_at_provider) return;
    const t = new Date(r.created_at_provider).getTime();
    const diffH = Math.floor((now - t) / 3600000);
    if (diffH < 0 || diffH >= hours) return;
    buckets[hours - 1 - diffH] += 1;
  });
  return buckets.map((y, i) => {
    const time = new Date(now - (hours - 1 - i) * 3600000);
    return { x: time, y };
  });
}

function providerLabel(p?: string) {
  switch (p) {
    case "vercel": return "Vercel";
    case "github": return "GitHub Actions";
    case "netlify": return "Netlify";
    case "render": return "Render";
    case "cloudflare": return "Cloudflare Pages";
    default: return p ?? "Unknown";
  }
}

function providerColor(p?: string) {
  switch (p) {
    case "vercel": return "hsl(var(--primary-soft))";
    case "github": return "hsl(var(--accent-2))";
    case "netlify": return "#00ad9f";
    case "render": return "#46e3b7";
    case "cloudflare": return "#f6821f";
    default: return "hsl(var(--primary-soft))";
  }
}

// --- Incidents -----------------------------------------------------
export function IncidentsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<"minor" | "major" | "critical">("minor");

  const { data } = useQuery({
    queryKey: ["incidents_list", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("incidents")
        .select("*")
        .eq("project_id", projectId!)
        .order("started_at", { ascending: false })
        .limit(50);
      return data ?? [];
    },
  });

  async function create() {
    if (!workspaceId || !projectId || !title) return;
    await supabase.from("incidents").insert({
      workspace_id: workspaceId,
      project_id: projectId,
      title,
      severity,
      status: "open",
    });
    setTitle("");
    queryClient.invalidateQueries({ queryKey: ["incidents_list", projectId] });
  }

  async function setStatus(id: string, status: string) {
    await supabase
      .from("incidents")
      .update({ status, resolved_at: status === "resolved" ? new Date().toISOString() : null })
      .eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["incidents_list", projectId] });
  }

  return (
    <div>
      <PageHeader title="Incidents" description="Track operational incidents with status and resolution." />
      <Card className="mb-6">
        <CardContent className="flex gap-2 p-4">
          <Input placeholder="Incident title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as any)}
            className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="minor">minor</option>
            <option value="major">major</option>
            <option value="critical">critical</option>
          </select>
          <Button onClick={create} disabled={!title}>
            <Plus className="h-4 w-4" /> Create
          </Button>
        </CardContent>
      </Card>
      {!data || data.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="No incidents" />
      ) : (
        <div className="space-y-2">
          {data.map((i: any) => (
            <Card key={i.id}>
              <CardContent className="flex items-center justify-between gap-3 p-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Badge variant={i.severity === "critical" ? "destructive" : i.severity === "major" ? "warning" : "secondary"}>
                      {i.severity}
                    </Badge>
                    <span className="font-medium">{i.title}</span>
                    <Badge variant={i.status === "resolved" ? "success" : "warning"}>{i.status}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Started {new Date(i.started_at).toLocaleString()}
                    {i.resolved_at && ` · resolved ${new Date(i.resolved_at).toLocaleString()}`}
                  </div>
                </div>
                <div className="flex gap-1">
                  {["identified", "monitoring", "resolved"].map((s) => (
                    <Button key={s} size="sm" variant="outline" onClick={() => setStatus(i.id, s)} disabled={i.status === s}>
                      {s}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Database (re-exported from dedicated module) ---------------------
export { DatabasePage } from "./Database";
