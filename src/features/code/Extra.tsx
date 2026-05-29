import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Network, Package, Plug, Database, ListTodo, Loader2, Search, RefreshCw, ArrowUpCircle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { ServiceBadge } from "@/components/ServiceBadge";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

export interface DepHealth {
  name: string;
  current: string;
  latest: string | null;
  deprecated: boolean;
  status: "ok" | "patch" | "minor" | "major" | "deprecated" | "unknown";
  lagMajor: number;
}

function statusBadge(s: DepHealth["status"]) {
  if (s === "deprecated") return <Badge variant="destructive">deprecated</Badge>;
  if (s === "major") return <Badge variant="destructive">major behind</Badge>;
  if (s === "minor") return <Badge variant="warning">minor behind</Badge>;
  if (s === "patch") return <Badge variant="secondary">patch</Badge>;
  if (s === "ok") return <Badge variant="success">up to date</Badge>;
  return <Badge variant="outline">—</Badge>;
}

interface ScanResult {
  id: string;
  created_at: string;
  summary: any;
  dependencies: { name: string; version: string; category: string }[];
  env_vars: { key: string; detected_service: string | null; sensitivity: string }[];
  services: { service: string; category: string }[];
  architecture: any;
  ai_analysis: { stack_summary?: string } | null;
  repositories: { full_name: string } | null;
}

function useLatestScan() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["latest_scan_extra", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_results")
        .select("*, repositories(full_name)")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data as ScanResult | null;
    },
  });
}

// --- Code Overview ------------------------------------------------------
interface OverviewScan {
  id: string;
  created_at: string;
  summary: { backend_framework?: string | null; detected_frontend?: { framework?: string | null } } | null;
  dependencies: { name: string }[] | null;
  services: { service: string; category: string }[] | null;
  env_vars: { sensitivity: string }[] | null;
  ai_analysis: { code_health_score?: number } | null;
  repositories: { full_name: string } | null;
}

export function CodeOverviewPage() {
  const { workspaceSlug, projectSlug } = useParams();
  const { projectId } = useCurrentContext();

  const { data: scans, isLoading } = useQuery({
    queryKey: ["code_overview_scans", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_results")
        .select("id, created_at, summary, dependencies, services, env_vars, ai_analysis, repositories(full_name)")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(50);
      return (data ?? []) as unknown as OverviewScan[];
    },
  });

  // Keep only the most recent scan per repository.
  const latestPerRepo = useMemo(() => {
    const seen = new Set<string>();
    const out: OverviewScan[] = [];
    (scans ?? []).forEach((s) => {
      const key = s.repositories?.full_name ?? s.id;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(s);
    });
    return out;
  }, [scans]);

  const agg = useMemo(() => {
    const deps = new Set<string>();
    const services = new Set<string>();
    let secrets = 0;
    const scores: number[] = [];
    latestPerRepo.forEach((s) => {
      (s.dependencies ?? []).forEach((d) => deps.add(d.name));
      (s.services ?? []).forEach((sv) => services.add(sv.service));
      secrets += (s.env_vars ?? []).filter((e) => e.sensitivity === "secret").length;
      const sc = s.ai_analysis?.code_health_score;
      if (typeof sc === "number") scores.push(sc);
    });
    const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    return { deps: deps.size, services: services.size, secrets, avgScore, repos: latestPerRepo.length };
  }, [latestPerRepo]);

  const allServices = useMemo(() => {
    const m = new Map<string, string>();
    latestPerRepo.forEach((s) => (s.services ?? []).forEach((sv) => m.set(sv.service, sv.category)));
    return [...m.entries()];
  }, [latestPerRepo]);

  const base = `/app/${workspaceSlug}/${projectSlug}/code`;

  return (
    <div>
      <PageHeader title="Code Overview" description="Aggregated stack, dependencies and health across your scanned repositories." />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : latestPerRepo.length === 0 ? (
        <EmptyState icon={Network} title="No scans yet" description="Connect GitHub and run a scan from Code → Repositories." />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Repositories" value={String(agg.repos)} />
            <Stat label="Unique deps" value={String(agg.deps)} />
            <Stat label="Services" value={String(agg.services)} />
            <Stat label="Secret vars" value={String(agg.secrets)} />
            <Stat label="Health score" value={agg.avgScore != null ? `${agg.avgScore}/100` : "—"} />
          </div>

          {allServices.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Detected services</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {allServices.map(([service, category]) => (
                    <ServiceBadge key={service} service={service} category={category} />
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Latest scan per repository</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Repository</th>
                    <th className="px-4 py-3">Stack</th>
                    <th className="px-4 py-3 text-right">Deps</th>
                    <th className="px-4 py-3 text-right">Health</th>
                    <th className="px-4 py-3">Scanned</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {latestPerRepo.map((s) => (
                    <tr key={s.id}>
                      <td className="px-4 py-3 font-medium">{s.repositories?.full_name ?? "—"}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {[s.summary?.detected_frontend?.framework, s.summary?.backend_framework].filter(Boolean).join(" · ") || "—"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{(s.dependencies ?? []).length}</td>
                      <td className="px-4 py-3 text-right">
                        {typeof s.ai_analysis?.code_health_score === "number" ? (
                          <Badge variant={s.ai_analysis.code_health_score >= 70 ? "success" : s.ai_analysis.code_health_score >= 40 ? "warning" : "destructive"}>
                            {s.ai_analysis.code_health_score}
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(s.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <div className="flex flex-wrap gap-2">
            <Link to={`${base}/scan-results`}><Button variant="outline" size="sm">View scan results</Button></Link>
            <Link to={`${base}/dependencies`}><Button variant="outline" size="sm">Dependencies</Button></Link>
            <Link to={`${base}/tech-debt`}><Button variant="outline" size="sm">Tech debt</Button></Link>
            <Link to={`${base}/repositories`}><Button variant="outline" size="sm">Repositories</Button></Link>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Scan Comparison ----------------------------------------------------
interface CompareScan {
  id: string;
  created_at: string;
  dependencies: { name: string; version: string }[] | null;
  services: { service: string }[] | null;
  ai_analysis: { code_health_score?: number } | null;
  repository_id: string;
  repositories: { full_name: string } | null;
}

export function ScanComparePage() {
  const { projectId } = useCurrentContext();
  const [repoId, setRepoId] = useState<string>("");
  const [aId, setAId] = useState<string>("");
  const [bId, setBId] = useState<string>("");

  const { data: scans, isLoading } = useQuery({
    queryKey: ["compare_scans", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_results")
        .select("id, created_at, dependencies, services, ai_analysis, repository_id, repositories(full_name)")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(100);
      return (data ?? []) as unknown as CompareScan[];
    },
  });

  const repos = useMemo(() => {
    const m = new Map<string, string>();
    (scans ?? []).forEach((s) => {
      if (s.repository_id && !m.has(s.repository_id)) m.set(s.repository_id, s.repositories?.full_name ?? s.repository_id);
    });
    return [...m.entries()];
  }, [scans]);

  // Auto-select first repo with >=2 scans + its two latest.
  const repoScans = useMemo(
    () => (scans ?? []).filter((s) => s.repository_id === (repoId || repos[0]?.[0])),
    [scans, repoId, repos],
  );

  const effRepo = repoId || repos[0]?.[0] || "";
  const newer = (scans ?? []).find((s) => s.id === aId) ?? repoScans[0];
  const older = (scans ?? []).find((s) => s.id === bId) ?? repoScans[1];

  const diff = useMemo(() => {
    if (!newer || !older) return null;
    const nDeps = new Map((newer.dependencies ?? []).map((d) => [d.name, d.version]));
    const oDeps = new Map((older.dependencies ?? []).map((d) => [d.name, d.version]));
    const added: string[] = [];
    const removed: string[] = [];
    const changed: { name: string; from: string; to: string }[] = [];
    nDeps.forEach((v, name) => {
      if (!oDeps.has(name)) added.push(name);
      else if (oDeps.get(name) !== v) changed.push({ name, from: oDeps.get(name)!, to: v });
    });
    oDeps.forEach((_, name) => {
      if (!nDeps.has(name)) removed.push(name);
    });
    const nSvc = new Set((newer.services ?? []).map((s) => s.service));
    const oSvc = new Set((older.services ?? []).map((s) => s.service));
    const svcAdded = [...nSvc].filter((s) => !oSvc.has(s));
    const svcRemoved = [...oSvc].filter((s) => !nSvc.has(s));
    const nScore = newer.ai_analysis?.code_health_score;
    const oScore = older.ai_analysis?.code_health_score;
    const scoreDelta = typeof nScore === "number" && typeof oScore === "number" ? nScore - oScore : null;
    return { added, removed, changed, svcAdded, svcRemoved, scoreDelta, nScore, oScore };
  }, [newer, older]);

  return (
    <div>
      <PageHeader title="Compare Scans" description="Diff two scans of the same repository — dependencies, services and health." />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : repos.length === 0 ? (
        <EmptyState icon={Network} title="No scans yet" description="Run scans from Code → Repositories." />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Repository</label>
              <select
                value={effRepo}
                onChange={(e) => { setRepoId(e.target.value); setAId(""); setBId(""); }}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {repos.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Newer scan</label>
              <select
                value={newer?.id ?? ""}
                onChange={(e) => setAId(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {repoScans.map((s) => <option key={s.id} value={s.id}>{new Date(s.created_at).toLocaleString()}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Older scan</label>
              <select
                value={older?.id ?? ""}
                onChange={(e) => setBId(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {repoScans.map((s) => <option key={s.id} value={s.id}>{new Date(s.created_at).toLocaleString()}</option>)}
              </select>
            </div>
          </div>

          {!diff || repoScans.length < 2 ? (
            <EmptyState icon={ListTodo} title="Need two scans" description="This repository needs at least two scans to compare." />
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Added deps" value={String(diff.added.length)} />
                <Stat label="Removed deps" value={String(diff.removed.length)} />
                <Stat label="Updated deps" value={String(diff.changed.length)} />
                <Stat
                  label="Health delta"
                  value={diff.scoreDelta != null ? `${diff.scoreDelta >= 0 ? "+" : ""}${diff.scoreDelta}` : "—"}
                />
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <DiffCard title="Added dependencies" variant="success" items={diff.added} />
                <DiffCard title="Removed dependencies" variant="destructive" items={diff.removed} />
              </div>

              {diff.changed.length > 0 && (
                <Card>
                  <CardHeader><CardTitle>Version changes</CardTitle></CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
                      {diff.changed.map((c) => (
                        <div key={c.name} className="flex items-center justify-between rounded-md border border-border px-2 py-1.5">
                          <span className="truncate">{c.name}</span>
                          <span className="shrink-0 text-muted-foreground">{c.from} <span className="text-primary">→ {c.to}</span></span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {(diff.svcAdded.length > 0 || diff.svcRemoved.length > 0) && (
                <Card>
                  <CardHeader><CardTitle>Service changes</CardTitle></CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    {diff.svcAdded.map((s) => <Badge key={s} variant="success">+ {s}</Badge>)}
                    {diff.svcRemoved.map((s) => <Badge key={s} variant="destructive">− {s}</Badge>)}
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DiffCard({ title, items, variant }: { title: string; items: string[]; variant: "success" | "destructive" }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>{title}</span>
          <Badge variant="outline">{items.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {items.map((i) => <Badge key={i} variant={variant}>{i}</Badge>)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Architecture Map ---------------------------------------------------
export function ArchitectureMapPage() {
  const { data, isLoading } = useLatestScan();
  return (
    <div>
      <PageHeader title="Architecture Map" description="High-level stack derived from your latest scan." />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !data ? (
        <EmptyState icon={Network} title="No scan yet" description="Run a scan from Code → Repositories." />
      ) : (
        <div className="space-y-4">
          {data.ai_analysis?.stack_summary && (
            <Card>
              <CardContent className="p-5">
                <p className="text-sm text-foreground/90">{data.ai_analysis.stack_summary}</p>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Detected layers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {(() => {
                const fe = (data.architecture?.frontend ?? {}) as {
                  framework?: string | null;
                  language?: string | null;
                  ui?: string[];
                };
                const be = data.architecture?.backend as string | null | undefined;
                return (
                  <>
                    <div>
                      <div className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Frontend</div>
                      <div className="flex flex-wrap gap-2">
                        {fe.framework ? (
                          <Badge variant="info">{fe.framework}</Badge>
                        ) : (
                          <span className="text-sm text-muted-foreground">Not detected</span>
                        )}
                        {fe.language && <Badge variant="secondary">{fe.language}</Badge>}
                        {(fe.ui ?? []).map((u) => (
                          <Badge key={u} variant="outline">
                            {u}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Backend</div>
                      {be ? (
                        <Badge variant="info">{be}</Badge>
                      ) : (
                        <span className="text-sm text-muted-foreground">Not detected</span>
                      )}
                    </div>
                  </>
                );
              })()}
              <div>
                <div className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">Services</div>
                {(data.services ?? []).length === 0 ? (
                  <span className="text-sm text-muted-foreground">No third-party services detected</span>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {(data.services ?? []).map((s) => (
                      <ServiceBadge key={s.service} service={s.service} category={s.category} />
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// --- Dependencies ------------------------------------------------------
export function DependenciesPage() {
  const { data, isLoading } = useLatestScan();
  type Dep = ScanResult["dependencies"][number];

  const [search, setSearch] = useState("");
  const [onlyOutdated, setOnlyOutdated] = useState(false);
  const [health, setHealth] = useState<Record<string, DepHealth>>({});
  const [checking, setChecking] = useState(false);

  async function checkUpdates() {
    if (!data) return;
    setChecking(true);
    try {
      const res = await callEdge<{ results: DepHealth[] }>("dep-health", {
        deps: data.dependencies.map((d) => ({ name: d.name, version: d.version })),
      });
      const map: Record<string, DepHealth> = {};
      (res.results ?? []).forEach((r) => (map[r.name] = r));
      setHealth(map);
    } finally {
      setChecking(false);
    }
  }

  const filtered = useMemo(() => {
    if (!data) return [] as Dep[];
    const q = search.trim().toLowerCase();
    return data.dependencies.filter((d) => {
      if (q && !d.name.toLowerCase().includes(q)) return false;
      if (onlyOutdated) {
        const h = health[d.name];
        if (!h || !["major", "minor", "patch", "deprecated"].includes(h.status)) return false;
      }
      return true;
    });
  }, [data, search, onlyOutdated, health]);

  const grouped = useMemo(() => {
    const map = new Map<string, Dep[]>();
    filtered.forEach((d) => {
      const k = d.category || "other";
      const arr = map.get(k) ?? [];
      arr.push(d);
      map.set(k, arr);
    });
    return map;
  }, [filtered]);

  const outdatedCount = useMemo(
    () => Object.values(health).filter((h) => ["major", "minor", "patch", "deprecated"].includes(h.status)).length,
    [health],
  );
  const hasHealth = Object.keys(health).length > 0;

  return (
    <div>
      <PageHeader
        title="Dependencies"
        description="Dependencies detected in the latest scan. Check updates against the npm registry."
        actions={
          data ? (
            <div className="flex gap-2">
              <ExportMenu
                rows={data.dependencies.map((d) => ({
                  name: d.name,
                  version: d.version,
                  category: d.category,
                  latest: health[d.name]?.latest ?? "",
                  status: health[d.name]?.status ?? "",
                }))}
                filename="dependencies"
              />
              <Button size="sm" variant="outline" onClick={checkUpdates} disabled={checking}>
                {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Check updates
              </Button>
            </div>
          ) : undefined
        }
      />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !data ? (
        <EmptyState icon={Package} title="No scan yet" description="Run a scan from Code → Repositories." />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search package…"
                className="h-9 w-56 pl-8"
              />
            </div>
            {hasHealth && (
              <button
                onClick={() => setOnlyOutdated((v) => !v)}
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  onlyOutdated ? "border-primary/40 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:bg-secondary"
                }`}
              >
                <ArrowUpCircle className="h-3.5 w-3.5" /> Outdated only ({outdatedCount})
              </button>
            )}
            <span className="text-xs text-muted-foreground">{filtered.length} packages</span>
          </div>

          <div className="space-y-4">
            {[...grouped.entries()].map(([cat, deps]) => (
              <Card key={cat}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span className="capitalize">{cat}</span>
                    <Badge variant="outline">{deps.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                    {deps.map((d) => {
                      const h = health[d.name];
                      return (
                        <div
                          key={d.name}
                          className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5"
                        >
                          <span className="truncate" title={d.name}>{d.name}</span>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <span className="text-muted-foreground">{d.version}</span>
                            {h?.latest && h.status !== "ok" && (
                              <span className="text-primary">→ {h.latest}</span>
                            )}
                            {h && statusBadge(h.status)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// --- API Usage ---------------------------------------------------------
export function ApiUsagePage() {
  const { data, isLoading } = useLatestScan();

  // We derive "API usage" from detected services in the env vars + deps
  const apiServices = useMemo(() => {
    if (!data) return [];
    const fromEnv = (data.env_vars ?? []).filter((e) => e.detected_service);
    const byService = new Map<string, { service: string; vars: string[] }>();
    fromEnv.forEach((e) => {
      const k = e.detected_service!;
      const cur = byService.get(k) ?? { service: k, vars: [] };
      cur.vars.push(e.key);
      byService.set(k, cur);
    });
    return [...byService.values()];
  }, [data]);

  return (
    <div>
      <PageHeader
        title="API Usage"
        description="External APIs detected via env vars in your repository. Live request volume requires connector sync (V2)."
      />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : apiServices.length === 0 ? (
        <EmptyState icon={Plug} title="No external APIs detected" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Service</th>
                  <th className="px-4 py-3">Env variables referenced</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {apiServices.map((s) => (
                  <tr key={s.service}>
                    <td className="px-4 py-3 font-medium">
                      <ServiceBadge service={s.service} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {s.vars.map((v) => (
                          <Badge key={v} variant="outline">{v}</Badge>
                        ))}
                      </div>
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

// --- Database Schema --------------------------------------------------
export function DatabaseSchemaPage() {
  const { data, isLoading } = useLatestScan();
  // Heuristic: if Supabase/Prisma/Drizzle in manifests, list them.
  const manifests: string[] = (data?.summary?.manifests_found ?? []).filter((m: string) =>
    /prisma|drizzle|supabase|migrations/i.test(m),
  );

  return (
    <div>
      <PageHeader
        title="Database Schema"
        description="Schema files detected in your repository. Direct introspection comes in V2."
      />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : manifests.length === 0 ? (
        <EmptyState icon={Database} title="No schema files detected" description="prisma/schema.prisma, drizzle.config.ts and supabase/migrations are scanned." />
      ) : (
        <Card>
          <CardContent className="space-y-2 p-5">
            {manifests.map((m) => (
              <div key={m} className="flex items-center gap-2 text-sm">
                <Database className="h-4 w-4 text-muted-foreground" />
                <code>{m}</code>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// --- Tech Debt -------------------------------------------------------
interface DebtItem {
  kind: string;
  severity: "low" | "medium" | "high";
  message: string;
  weight: number;
}

export function TechDebtPage() {
  const { data, isLoading } = useLatestScan();
  const [health, setHealth] = useState<Record<string, DepHealth>>({});
  const [checking, setChecking] = useState(false);

  async function checkUpdates() {
    if (!data) return;
    setChecking(true);
    try {
      const res = await callEdge<{ results: DepHealth[] }>("dep-health", {
        deps: data.dependencies.map((d) => ({ name: d.name, version: d.version })),
      });
      const map: Record<string, DepHealth> = {};
      (res.results ?? []).forEach((r) => (map[r.name] = r));
      setHealth(map);
    } finally {
      setChecking(false);
    }
  }

  const debt = useMemo<DebtItem[]>(() => {
    if (!data) return [];
    const out: DebtItem[] = [];
    (data.dependencies ?? []).forEach((d) => {
      if (/^[\^~]?0\./.test(d.version)) {
        out.push({ kind: "unstable_version", severity: "low", message: `${d.name}@${d.version} is pre-1.0`, weight: 1 });
      }
      const h = health[d.name];
      if (h?.deprecated) {
        out.push({ kind: "deprecated", severity: "high", message: `${d.name} is deprecated on npm`, weight: 6 });
      } else if (h?.status === "major") {
        out.push({ kind: "major_outdated", severity: "medium", message: `${d.name} is ${h.lagMajor} major version(s) behind (${d.version} → ${h.latest})`, weight: 3 });
      }
    });
    (data.env_vars ?? []).forEach((e) => {
      if (/^VITE_.*(SECRET|PRIVATE|SERVICE_ROLE|TOKEN|KEY)/i.test(e.key)) {
        out.push({ kind: "exposed_secret", severity: "high", message: `${e.key} is a VITE_ var that looks secret — exposed to the browser`, weight: 8 });
      }
    });
    (data.ai_analysis as any)?.key_risks?.forEach((r: any) => {
      const sev = r.severity === "critical" || r.severity === "high" ? "high" : r.severity === "medium" ? "medium" : "low";
      out.push({ kind: r.category ?? "risk", severity: sev, message: r.message, weight: sev === "high" ? 5 : sev === "medium" ? 3 : 1 });
    });
    return out.sort((a, b) => b.weight - a.weight);
  }, [data, health]);

  // Debt score: 100 minus weighted penalties, floored at 0.
  const score = useMemo(() => {
    const penalty = debt.reduce((s, d) => s + d.weight, 0);
    return Math.max(0, 100 - penalty * 2);
  }, [debt]);

  const scoreColor = score >= 75 ? "text-emerald-400" : score >= 50 ? "text-amber-400" : "text-red-400";

  return (
    <div>
      <PageHeader
        title="Tech Debt"
        description="Weighted tech-debt signals from your latest scan. Run 'Check updates' to include npm freshness."
        actions={
          data ? (
            <Button size="sm" variant="outline" onClick={checkUpdates} disabled={checking}>
              {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Check updates
            </Button>
          ) : undefined
        }
      />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !data ? (
        <EmptyState icon={ListTodo} title="No scan yet" description="Run a scan from Code → Repositories." />
      ) : (
        <>
          <Card className="mb-6">
            <CardContent className="flex items-center justify-between p-5">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Debt score</div>
                <div className={`mt-1 text-3xl font-semibold ${scoreColor}`}>{score}<span className="text-base text-muted-foreground">/100</span></div>
              </div>
              <div className="text-right text-sm text-muted-foreground">
                {debt.length} signal{debt.length === 1 ? "" : "s"}
                {Object.keys(health).length === 0 && (
                  <div className="text-xs">Run "Check updates" for npm freshness</div>
                )}
              </div>
            </CardContent>
          </Card>

          {debt.length === 0 ? (
            <EmptyState icon={ListTodo} title="No obvious tech debt" />
          ) : (
            <div className="space-y-2">
              {debt.map((d, i) => (
                <Card key={i}>
                  <CardContent className="flex items-center gap-3 p-3 text-sm">
                    <Badge variant={d.severity === "high" ? "destructive" : d.severity === "medium" ? "warning" : "secondary"}>
                      {d.kind}
                    </Badge>
                    <span className="flex-1">{d.message}</span>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}
