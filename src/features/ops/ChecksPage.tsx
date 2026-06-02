import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity, Plus, CheckCircle2, XCircle, AlertTriangle, Loader2,
  Trash2, Play, ShieldCheck, Smartphone, Globe,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import type { OpsCheckDefinition, OpsCheckRun, OpsCheckCategory, OpsProbeType, OpsServer } from "./types";

const CATEGORY_INFO: Record<OpsCheckCategory, { icon: any; label: string; description: string }> = {
  technical: { icon: Activity, label: "Technical", description: "HTTP, SSL, container, disk, memory." },
  product: { icon: Smartphone, label: "Product", description: "Feature endpoints, webhooks, integrations." },
  security: { icon: ShieldCheck, label: "Security", description: "Headers, ports, hardening." },
};

const PROBE_TYPES: Array<{ value: OpsProbeType; label: string; configHint: string }> = [
  { value: "http_status", label: "HTTP status", configHint: "{ url, expected_status: 200, timeout_ms: 5000 }" },
  { value: "http_contains", label: "HTTP contains text", configHint: "{ url, must_contain: 'Sign in' }" },
  { value: "http_latency", label: "HTTP latency", configHint: "{ url, max_latency_ms: 500 }" },
  { value: "ssl_valid", label: "SSL valid", configHint: "{ domain, min_days_before_expiry: 14 }" },
  { value: "dns_resolve", label: "DNS resolves", configHint: "{ domain, expected_ips: [] }" },
  { value: "tcp_port", label: "TCP port open", configHint: "{ host, port }" },
  { value: "container_running", label: "Container running", configHint: "{ name }" },
  { value: "disk_usage", label: "Disk usage", configHint: "{ max_percent: 85 }" },
  { value: "memory_usage", label: "Memory usage", configHint: "{ max_percent: 90 }" },
  { value: "custom_ssh", label: "Custom SSH command", configHint: "{ command, expected_exit: 0 }" },
];

export function OpsChecksPage() {
  const { projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [runningAll, setRunningAll] = useState(false);

  const { data: definitions } = useQuery({
    queryKey: ["ops_check_definitions", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_check_definitions")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as OpsCheckDefinition[];
    },
  });

  // Latest run per definition (for status badges).
  const { data: latestRuns } = useQuery({
    queryKey: ["ops_check_runs_latest", projectId, (definitions ?? []).length],
    enabled: !!projectId && !!definitions && definitions.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_check_runs")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(200);
      const map = new Map<string, OpsCheckRun>();
      for (const r of (data ?? []) as OpsCheckRun[]) {
        if (r.definition_id && !map.has(r.definition_id)) map.set(r.definition_id, r);
      }
      return map;
    },
    refetchInterval: 10_000,
  });

  // Overall stats (24h)
  const stats = useMemo(() => {
    const runs = Array.from((latestRuns ?? new Map()).values());
    const passed = runs.filter((r) => r.status === "passed").length;
    const failed = runs.filter((r) => r.status === "failed").length;
    const warn = runs.filter((r) => r.status === "warn").length;
    return { passed, failed, warn, total: runs.length };
  }, [latestRuns]);

  async function runAll() {
    setRunningAll(true);
    try {
      await callEdge("ops-run-checks", { project_id: projectId, scope: "all" });
      queryClient.invalidateQueries({ queryKey: ["ops_check_runs_latest", projectId] });
    } catch (e: any) {
      alert("Could not run checks: " + (e?.message ?? "edge not deployed"));
    } finally {
      setRunningAll(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Checks"
        description="Post-deploy validation + baseline comparison. HTTP, SSL, containers, security."
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={runAll} disabled={runningAll} className="gap-1.5">
              {runningAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Run all
            </Button>
            <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" /> New check
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total checks" value={definitions?.length ?? 0} />
        <StatCard label="Passing" value={stats.passed} tone="good" />
        <StatCard label="Warning" value={stats.warn} tone="warn" />
        <StatCard label="Failing" value={stats.failed} tone="bad" />
      </div>

      {!definitions || definitions.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No check yet"
          description="Create checks to monitor your servers and apps. Start with an HTTP 200 probe."
          action={
            <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" /> Create first check
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          {(Object.keys(CATEGORY_INFO) as OpsCheckCategory[]).map((cat) => {
            const info = CATEGORY_INFO[cat];
            const Icon = info.icon;
            const items = definitions.filter((d) => d.category === cat);
            if (items.length === 0) return null;
            return (
              <div key={cat}>
                <div className="mb-2 flex items-center gap-2">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">{info.label}</h3>
                  <span className="text-[11px] text-muted-foreground">— {info.description}</span>
                </div>
                <div className="space-y-2">
                  {items.map((d) => (
                    <CheckRow
                      key={d.id}
                      def={d}
                      lastRun={latestRuns?.get(d.id) ?? null}
                      onDelete={async () => {
                        if (!confirm("Delete this check?")) return;
                        await supabase.from("ops_check_definitions").delete().eq("id", d.id);
                        queryClient.invalidateQueries({ queryKey: ["ops_check_definitions", projectId] });
                      }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <CreateCheckDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: number; tone?: "good" | "warn" | "bad" }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={cn(
          "mt-1 text-2xl font-semibold",
          tone === "good" && "text-emerald-500",
          tone === "warn" && "text-amber-500",
          tone === "bad" && "text-destructive",
        )}>{value}</div>
      </CardContent>
    </Card>
  );
}

function CheckRow({
  def,
  lastRun,
  onDelete,
}: {
  def: OpsCheckDefinition;
  lastRun: OpsCheckRun | null;
  onDelete: () => void;
}) {
  const statusInfo = lastRun ? {
    passed: { icon: CheckCircle2, color: "text-emerald-500", label: "Passed" },
    failed: { icon: XCircle, color: "text-destructive", label: "Failed" },
    warn: { icon: AlertTriangle, color: "text-amber-500", label: "Warning" },
    skipped: { icon: AlertTriangle, color: "text-muted-foreground", label: "Skipped" },
  }[lastRun.status] : null;

  const StatusIcon = statusInfo?.icon ?? AlertTriangle;

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <StatusIcon className={cn("h-4 w-4 shrink-0", statusInfo?.color ?? "text-muted-foreground")} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{def.name}</div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Badge variant="outline" className="text-[10px]">{def.probe_type.replace(/_/g, " ")}</Badge>
              <span>{def.mode.replace(/_/g, " ")}</span>
              {def.config?.url && (
                <>
                  <Globe className="h-3 w-3" />
                  <span className="truncate">{def.config.url}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          {lastRun && (
            <div className="text-right text-muted-foreground">
              <div>{statusInfo?.label}</div>
              <div className="text-[10px]">{new Date(lastRun.created_at).toLocaleString()}</div>
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={onDelete}>
            <Trash2 className="h-3 w-3 text-destructive" />
          </Button>
        </div>
      </div>

      {lastRun && lastRun.status === "failed" && lastRun.message && (
        <div className="mt-2 rounded bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          {lastRun.message}
        </div>
      )}

      {lastRun && lastRun.delta && Object.keys(lastRun.delta).length > 0 && (
        <div className="mt-2 text-[10px] text-muted-foreground">
          Δ baseline: {JSON.stringify(lastRun.delta)}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Create dialog
// ============================================================================

function CreateCheckDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<OpsCheckCategory>("technical");
  const [probeType, setProbeType] = useState<OpsProbeType>("http_status");
  const [mode, setMode] = useState<"post_deploy" | "baseline_compare" | "scheduled">("scheduled");
  const [serverId, setServerId] = useState("");
  const [configText, setConfigText] = useState('{\n  "url": "https://app.example.com",\n  "expected_status": 200,\n  "timeout_ms": 5000\n}');
  const [saving, setSaving] = useState(false);

  const { data: servers } = useQuery({
    queryKey: ["ops_servers_for_check", projectId],
    enabled: !!projectId && open,
    queryFn: async () => {
      const { data } = await supabase.from("ops_servers").select("id, name").eq("project_id", projectId!);
      return (data ?? []) as Pick<OpsServer, "id" | "name">[];
    },
  });

  async function save() {
    if (!workspaceId || !projectId || !name.trim()) return;
    let config;
    try { config = JSON.parse(configText); }
    catch (e: any) { alert("Invalid JSON config: " + e.message); return; }
    setSaving(true);
    try {
      const { error } = await supabase.from("ops_check_definitions").insert({
        workspace_id: workspaceId,
        project_id: projectId,
        server_id: serverId || null,
        name: name.trim(),
        category,
        probe_type: probeType,
        config,
        mode,
        baseline: {},
        enabled: true,
      });
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ["ops_check_definitions", projectId] });
      onOpenChange(false);
      setName(""); setServerId("");
    } catch (e: any) {
      alert(e?.message ?? "Failed");
    } finally {
      setSaving(false);
    }
  }

  // Update the config hint when probe type changes.
  function pickProbe(t: OpsProbeType) {
    setProbeType(t);
    const hint = PROBE_TYPES.find((p) => p.value === t)?.configHint;
    if (hint) setConfigText(hint);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>New check</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="App login page returns 200" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Category</Label>
              <Select value={category} onChange={(v) => setCategory(v as OpsCheckCategory)} options={
                (Object.keys(CATEGORY_INFO) as OpsCheckCategory[]).map((k) => ({ value: k, label: CATEGORY_INFO[k].label }))
              } />
            </div>
            <div>
              <Label>Mode</Label>
              <Select value={mode} onChange={(v) => setMode(v as any)} options={[
                { value: "scheduled", label: "Scheduled (recurring)" },
                { value: "post_deploy", label: "Post-deploy" },
                { value: "baseline_compare", label: "Baseline compare" },
              ]} />
            </div>
            <div className="col-span-2">
              <Label>Probe</Label>
              <Select value={probeType} onChange={(v) => pickProbe(v as OpsProbeType)} options={
                PROBE_TYPES.map((p) => ({ value: p.value, label: p.label }))
              } />
            </div>
            <div className="col-span-2">
              <Label>Target server (optional)</Label>
              <Select value={serverId} onChange={setServerId} options={[
                { value: "", label: "None (HTTP check from runner)" },
                ...(servers ?? []).map((s) => ({ value: s.id, label: s.name })),
              ]} />
            </div>
            <div className="col-span-2">
              <Label>Config (JSON)</Label>
              <textarea
                value={configText}
                onChange={(e) => setConfigText(e.target.value)}
                rows={6}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[11px] focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving || !name.trim()}>
              {saving && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="mb-1 block text-xs font-medium text-muted-foreground">{children}</label>;
}

function Select<T extends string>({
  value, onChange, options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
