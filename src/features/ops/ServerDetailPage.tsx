import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, ArrowLeft, ShieldCheck, HardDrive, Cpu, Globe, KeyRound,
  Activity, FileText, AlertTriangle, CheckCircle2,
  RefreshCw, Trash2, Play, Plus,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import { useOpsUrl } from "./hooks";
import type { OpsServer, OpsJob } from "./types";

type ServerTab = "health" | "security" | "backups" | "env" | "actions" | "logs";

const TABS: { id: ServerTab; label: string; icon: any }[] = [
  { id: "health", label: "Health", icon: Activity },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "backups", label: "Backups", icon: HardDrive },
  { id: "env", label: "Env vars", icon: KeyRound },
  { id: "actions", label: "Actions", icon: Play },
  { id: "logs", label: "Logs", icon: FileText },
];

export function OpsServerDetailPage() {
  const { serverId } = useParams();
  const url = useOpsUrl();
  const [tab, setTab] = useState<ServerTab>("health");

  const { data: server, isLoading } = useQuery({
    queryKey: ["ops_server", serverId],
    enabled: !!serverId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_servers")
        .select("*")
        .eq("id", serverId!)
        .maybeSingle();
      return data as OpsServer | null;
    },
    refetchInterval: 10_000,
  });

  if (isLoading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!server) return <EmptyState icon={ShieldCheck} title="Server not found" />;

  return (
    <div className="space-y-4">
      <Link to={url("/devops/servers")} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3" /> Back to servers
      </Link>

      <PageHeader
        title={server.name}
        description={`${server.ip_address}:${server.ssh_port} · ${server.ssh_user}@${server.provider}`}
        actions={<ServerActions server={server} />}
      />

      <ServerStatusBanner server={server} />

      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "relative inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" /> {t.label}
              {active && <span className="absolute -bottom-px left-2 right-2 h-0.5 rounded-t bg-[hsl(var(--primary-soft))]" />}
            </button>
          );
        })}
      </div>

      <div>
        {tab === "health" && <HealthTab server={server} />}
        {tab === "security" && <SecurityTab server={server} />}
        {tab === "backups" && <BackupsTab server={server} />}
        {tab === "env" && <EnvTab server={server} />}
        {tab === "actions" && <ActionsTab server={server} />}
        {tab === "logs" && <LogsTab server={server} />}
      </div>
    </div>
  );
}

function ServerActions({ server }: { server: OpsServer }) {
  const queryClient = useQueryClient();
  const [probing, setProbing] = useState(false);

  async function probe() {
    setProbing(true);
    try {
      await callEdge("ops-create-job", {
        server_id: server.id,
        job_type: "server_health",
        input: {},
        risk_level: "low",
        requires_approval: false,
      });
      queryClient.invalidateQueries({ queryKey: ["ops_jobs", server.project_id] });
    } catch {
      // swallow — edge not deployed; surface via banner instead
    } finally {
      setProbing(false);
    }
  }

  async function remove() {
    if (!confirm(`Disconnect ${server.name}? Encrypted credentials will be wiped. This is irreversible.`)) return;
    await supabase.from("ops_servers").delete().eq("id", server.id);
    queryClient.invalidateQueries({ queryKey: ["ops_servers", server.project_id] });
    window.history.back();
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={probe} disabled={probing} className="gap-1.5">
        {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        Probe
      </Button>
      <Button size="sm" variant="ghost" onClick={remove} className="text-destructive">
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function ServerStatusBanner({ server }: { server: OpsServer }) {
  if (server.status === "online") return null;
  const map = {
    unknown: { tone: "warn", text: "Status unknown. Run a probe to fetch fresh metrics." },
    offline: { tone: "error", text: "Server is unreachable over SSH." },
    degraded: { tone: "warn", text: "Server is up but some checks are failing." },
    provisioning: { tone: "info", text: "Provisioning is in progress." },
    error: { tone: "error", text: server.last_check_result?.error ?? "An error occurred during the last check." },
  }[server.status];
  if (!map) return null;
  return (
    <div className={cn(
      "flex items-center gap-2 rounded-md border px-3 py-2 text-xs",
      map.tone === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
      map.tone === "warn" && "border-amber-500/40 bg-amber-500/10 text-amber-600",
      map.tone === "info" && "border-blue-500/40 bg-blue-500/10 text-blue-600",
    )}>
      <AlertTriangle className="h-3.5 w-3.5" />
      <span>{map.text}</span>
    </div>
  );
}

// ============================================================================
// Tabs
// ============================================================================

function HealthTab({ server }: { server: OpsServer }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">System</CardTitle></CardHeader>
        <CardContent>
          <Kv k="OS" v={server.os_name ? `${server.os_name} ${server.os_version ?? ""}` : "—"} />
          <Kv k="Architecture" v={server.architecture ?? "—"} />
          <Kv k="CPU" v={server.cpu_count != null ? `${server.cpu_count} cores` : "—"} icon={Cpu} />
          <Kv k="RAM" v={server.ram_mb != null ? `${(server.ram_mb / 1024).toFixed(1)} GB` : "—"} />
          <Kv k="Disk" v={server.disk_gb != null ? `${server.disk_gb} GB` : "—"} icon={HardDrive} />
          <Kv k="Last probe" v={server.last_checked_at ? new Date(server.last_checked_at).toLocaleString() : "Never"} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Software</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <Toggle label="Docker installed" value={server.docker_installed} />
          <Toggle label="Nginx installed" value={server.nginx_installed} />
          <Toggle label="UFW firewall" value={server.ufw_enabled} />
          <Toggle label="fail2ban" value={server.fail2ban_enabled} />
        </CardContent>
      </Card>

      {server.domain && (
        <Card className="md:col-span-2">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Networking</CardTitle></CardHeader>
          <CardContent>
            <Kv k="Domain" v={server.domain} icon={Globe} />
            <Kv k="IP" v={`${server.ip_address}:${server.ssh_port}`} />
            <Kv k="Environment" v={server.environment} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SecurityTab({ server }: { server: OpsServer }) {
  const score = server.security_score ?? 0;
  const tone = score >= 85 ? "good" : score >= 70 ? "warn" : "bad";

  // Synthesise a checklist from last_check_result.
  const checks: Array<{ label: string; ok: boolean | null; weight: number }> = [
    { label: "SSH password authentication disabled", ok: server.last_check_result?.ssh_password_disabled ?? null, weight: 25 },
    { label: "Root login over SSH disabled", ok: server.last_check_result?.ssh_root_disabled ?? null, weight: 15 },
    { label: "UFW firewall active", ok: server.ufw_enabled, weight: 15 },
    { label: "fail2ban running", ok: server.fail2ban_enabled, weight: 15 },
    { label: "Unattended upgrades enabled", ok: server.last_check_result?.unattended_upgrades ?? null, weight: 10 },
    { label: "Open ports only 22/80/443", ok: server.last_check_result?.minimal_ports ?? null, weight: 10 },
    { label: "Docker daemon not publicly exposed", ok: server.last_check_result?.docker_not_exposed ?? null, weight: 10 },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">Security score</div>
              <div className={cn(
                "mt-1 text-3xl font-bold",
                tone === "good" && "text-emerald-500",
                tone === "warn" && "text-amber-500",
                tone === "bad" && "text-destructive",
              )}>{score}/100</div>
            </div>
            <ShieldCheck className={cn(
              "h-12 w-12",
              tone === "good" && "text-emerald-500",
              tone === "warn" && "text-amber-500",
              tone === "bad" && "text-destructive",
            )} />
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded bg-muted">
            <div
              className={cn(
                "h-full transition-all",
                tone === "good" && "bg-emerald-500",
                tone === "warn" && "bg-amber-500",
                tone === "bad" && "bg-destructive",
              )}
              style={{ width: `${score}%` }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Hardening checklist</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {checks.map((c) => (
              <div key={c.label} className="flex items-center justify-between rounded border border-border px-3 py-2">
                <div className="flex items-center gap-2 text-sm">
                  {c.ok === true ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    : c.ok === false ? <AlertTriangle className="h-4 w-4 text-amber-500" />
                    : <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />}
                  {c.label}
                </div>
                <Badge variant="outline" className="text-[10px]">+{c.weight}</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function BackupsTab({ server: _server }: { server: OpsServer }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Backups</CardTitle>
      </CardHeader>
      <CardContent>
        <EmptyState
          icon={HardDrive}
          title="No backup policy yet"
          description="Generate a backup plan from the Workflows tab to schedule daily snapshots."
        />
      </CardContent>
    </Card>
  );
}

function EnvTab({ server }: { server: OpsServer }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Environment variables</CardTitle>
          <Link to={`/app/${server.workspace_id}/integrations/vault`}>
            <Button size="sm" variant="outline" className="gap-1.5">
              <KeyRound className="h-3.5 w-3.5" /> Open Vault
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          Project env vars are managed in the shared <strong>Vault</strong> (Integrations module). They are pushed to this server when running an <code>app_deploy</code> job.
        </p>
      </CardContent>
    </Card>
  );
}

function ActionsTab({ server }: { server: OpsServer }) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState<string | null>(null);

  const ACTIONS = [
    { type: "docker_install", label: "Install Docker", risk: "medium", description: "Install Docker + Docker Compose plugin." },
    { type: "nginx_setup", label: "Setup Nginx", risk: "medium", description: "Install Nginx and configure as reverse proxy." },
    { type: "ssl_setup", label: "Issue SSL certificate", risk: "low", description: "Run certbot for the configured domain." },
    { type: "firewall_setup", label: "Setup UFW firewall", risk: "high", description: "Enable UFW. Opens 22/80/443 only." },
    { type: "backup_setup", label: "Setup backups", risk: "low", description: "Install a daily backup cron." },
    { type: "security_audit", label: "Run security audit", risk: "low", description: "Recompute the security score." },
    { type: "app_restart", label: "Restart app", risk: "medium", description: "Restart all docker compose services." },
  ];

  async function createJob(jobType: string, risk: string) {
    setCreating(jobType);
    try {
      await callEdge("ops-create-job", {
        server_id: server.id,
        job_type: jobType,
        risk_level: risk,
        autonomy_mode: "assisted",
        requires_approval: risk === "high" || risk === "critical",
        input: {},
      });
      queryClient.invalidateQueries({ queryKey: ["ops_jobs", server.project_id] });
    } catch (e: any) {
      alert("Could not enqueue job: " + (e?.message ?? "edge function not deployed"));
    } finally {
      setCreating(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">Provisioning actions</CardTitle></CardHeader>
      <CardContent>
        <div className="grid gap-2 md:grid-cols-2">
          {ACTIONS.map((a) => (
            <div key={a.type} className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">{a.label}</div>
                  <div className="text-[11px] text-muted-foreground">{a.description}</div>
                </div>
                <Badge variant="outline" className={cn(
                  "text-[10px]",
                  a.risk === "low" && "text-emerald-500",
                  a.risk === "medium" && "text-amber-500",
                  a.risk === "high" && "text-orange-500",
                )}>{a.risk}</Badge>
              </div>
              <Button
                size="sm"
                className="mt-2 w-full gap-1"
                onClick={() => createJob(a.type, a.risk)}
                disabled={creating === a.type}
              >
                {creating === a.type ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                Queue
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function LogsTab({ server }: { server: OpsServer }) {
  const { data: jobs } = useQuery({
    queryKey: ["ops_jobs_server", server.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_jobs")
        .select("id, job_type, status, risk_level, created_at, finished_at, started_at, error_message")
        .eq("server_id", server.id)
        .order("created_at", { ascending: false })
        .limit(50);
      return (data ?? []) as Array<Pick<OpsJob, "id" | "job_type" | "status" | "risk_level" | "created_at" | "finished_at" | "started_at" | "error_message">>;
    },
    refetchInterval: 5000,
  });

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm">Recent jobs on this server</CardTitle></CardHeader>
      <CardContent>
        {!jobs || jobs.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No jobs yet.</p>
        ) : (
          <div className="space-y-1">
            {jobs.map((j) => (
              <div key={j.id} className="flex items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-muted/40">
                <div className="flex min-w-0 items-center gap-2">
                  <StatusDot status={j.status} />
                  <span className="truncate font-medium">{j.job_type.replace(/_/g, " ")}</span>
                </div>
                <div className="ml-3 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Badge variant="outline" className="text-[10px] capitalize">{j.status.replace(/_/g, " ")}</Badge>
                  <span>{new Date(j.created_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Tiny presentation helpers --------------------------------------------

function Kv({ k, v, icon: Icon }: { k: string; v: string; icon?: any }) {
  return (
    <div className="flex items-center justify-between border-b border-border/40 py-1.5 text-sm last:border-0">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {k}
      </span>
      <span className="font-medium">{v}</span>
    </div>
  );
}

function Toggle({ label, value }: { label: string; value: boolean | null }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span>{label}</span>
      {value === true ? (
        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600">on</span>
      ) : value === false ? (
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">off</span>
      ) : (
        <span className="text-[10px] text-muted-foreground">unknown</span>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: OpsJob["status"] }) {
  const c = {
    succeeded: "bg-emerald-500",
    failed: "bg-destructive",
    running: "bg-blue-500 animate-pulse",
    queued: "bg-blue-500",
    awaiting_approval: "bg-amber-500",
    approved: "bg-blue-500",
    draft: "bg-muted-foreground",
    cancelled: "bg-muted-foreground",
    rolled_back: "bg-orange-500",
  }[status];
  return <span className={cn("h-2 w-2 rounded-full", c)} />;
}
