import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Server, Plus, Loader2, ChevronRight, ShieldCheck, Globe, Cpu, HardDrive,
  CheckCircle2, AlertTriangle,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { useOpsUrl } from "./hooks";
import type { OpsServer, OpsServerEnv, OpsServerProvider } from "./types";

const PROVIDERS: { value: OpsServerProvider; label: string }[] = [
  { value: "vps", label: "Generic VPS" },
  { value: "hetzner", label: "Hetzner Cloud" },
  { value: "digitalocean", label: "DigitalOcean" },
  { value: "aws", label: "AWS" },
  { value: "gcp", label: "GCP" },
  { value: "azure", label: "Azure" },
  { value: "scaleway", label: "Scaleway" },
  { value: "ovh", label: "OVHcloud" },
  { value: "other", label: "Other" },
];

const ENVS: { value: OpsServerEnv; label: string; color: string }[] = [
  { value: "production", label: "prod", color: "bg-rose-500/15 text-rose-600" },
  { value: "staging", label: "staging", color: "bg-amber-500/15 text-amber-600" },
  { value: "development", label: "dev", color: "bg-blue-500/15 text-blue-600" },
  { value: "sandbox", label: "sandbox", color: "bg-slate-500/15 text-slate-600" },
];

export function OpsServersPage() {
  const { projectId } = useCurrentContext();
  const url = useOpsUrl();
  const [addOpen, setAddOpen] = useState(false);

  const { data: servers, isLoading } = useQuery({
    queryKey: ["ops_servers", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_servers")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as OpsServer[];
    },
    refetchInterval: 15_000,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Servers"
        description="Connect VPS or cloud servers to FounderOS. SSH keys are stored encrypted (project-scoped)."
        actions={
          <Button onClick={() => setAddOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" /> Add server
          </Button>
        }
      />

      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : !servers || servers.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No server yet"
          description="Add a VPS or cloud server to start generating infra files and deploying."
          action={
            <Button onClick={() => setAddOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" /> Add your first server
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {servers.map((s) => (
            <Link key={s.id} to={url(`/ops/servers/${s.id}`)}>
              <ServerCard server={s} />
            </Link>
          ))}
        </div>
      )}

      <AddServerDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function ServerCard({ server }: { server: OpsServer }) {
  const env = ENVS.find((e) => e.value === server.environment);
  const statusDot = {
    online: "bg-emerald-500",
    offline: "bg-muted-foreground",
    degraded: "bg-amber-500",
    provisioning: "bg-blue-500 animate-pulse",
    error: "bg-destructive",
    unknown: "bg-muted-foreground/50",
  }[server.status];

  return (
    <Card className="cursor-pointer transition-colors hover:border-foreground/30">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <span className={cn("h-2 w-2 rounded-full", statusDot)} />
            <h3 className="font-semibold leading-tight">{server.name}</h3>
            {env && (
              <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", env.color)}>
                {env.label}
              </span>
            )}
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </div>

        <div className="space-y-1 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Globe className="h-3 w-3" /> {server.ip_address}{server.ssh_port !== 22 ? `:${server.ssh_port}` : ""}
          </div>
          {server.domain && (
            <div className="flex items-center gap-1.5">
              <Globe className="h-3 w-3" /> {server.domain}
            </div>
          )}
          {server.os_name && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase">{server.os_name}</span>
              {server.os_version && <span>{server.os_version}</span>}
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          {server.cpu_count && (
            <span className="inline-flex items-center gap-1"><Cpu className="h-3 w-3" /> {server.cpu_count}c</span>
          )}
          {server.ram_mb && (
            <span>{(server.ram_mb / 1024).toFixed(1)} GB</span>
          )}
          {server.disk_gb && (
            <span className="inline-flex items-center gap-1"><HardDrive className="h-3 w-3" /> {server.disk_gb} GB</span>
          )}
        </div>

        {server.security_score != null && (
          <div className="flex items-center gap-2 border-t border-border pt-2 text-xs">
            <ShieldCheck className={cn("h-3.5 w-3.5", server.security_score >= 85 ? "text-emerald-500" : server.security_score >= 70 ? "text-amber-500" : "text-destructive")} />
            <span className="font-medium">{server.security_score}/100</span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {server.last_checked_at ? new Date(server.last_checked_at).toLocaleString() : "never checked"}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AddServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { user } = useAuth();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");
  const [sshUser, setSshUser] = useState("root");
  const [sshPort, setSshPort] = useState(22);
  const [provider, setProvider] = useState<OpsServerProvider>("vps");
  const [environment, setEnvironment] = useState<OpsServerEnv>("production");
  const [domain, setDomain] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [step, setStep] = useState<"form" | "testing" | "result">("form");
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; details?: any } | null>(null);
  const [saving, setSaving] = useState(false);

  function reset() {
    setName(""); setIp(""); setSshUser("root"); setSshPort(22);
    setProvider("vps"); setEnvironment("production"); setDomain("");
    setPrivateKey(""); setStep("form"); setTestResult(null);
  }

  async function testAndSave() {
    if (!user || !workspaceId || !projectId) return;
    if (!name.trim() || !ip.trim() || !sshUser.trim() || !privateKey.trim()) return;
    setSaving(true);
    setStep("testing");
    try {
      // Edge function ops-server-test: stores SSH key as ops_secret, opens an SSH
      // probe job, returns ok/error. If runner is not yet configured, the function
      // still creates the server in 'unknown' status so user can proceed.
      const result = await callEdge<{ ok: boolean; server_id?: string; message: string; details?: any }>("ops-server-test", {
        workspace_id: workspaceId,
        project_id: projectId,
        name: name.trim(),
        description: null,
        provider,
        ip_address: ip.trim(),
        ssh_port: sshPort,
        ssh_user: sshUser.trim(),
        environment,
        domain: domain.trim() || null,
        ssh_private_key: privateKey,
      });
      setTestResult({ ok: result.ok, message: result.message, details: result.details });
      setStep("result");
      queryClient.invalidateQueries({ queryKey: ["ops_servers", projectId] });
    } catch (e: any) {
      // Soft fallback: create the row directly so the UI keeps working before the
      // edge function is deployed. SSH key is not stored in this branch (it's
      // discarded) — the user will be prompted to re-enter it after deployment.
      const { data } = await supabase
        .from("ops_servers")
        .insert({
          workspace_id: workspaceId,
          project_id: projectId,
          name: name.trim(),
          provider,
          ip_address: ip.trim(),
          ssh_port: sshPort,
          ssh_user: sshUser.trim(),
          environment,
          domain: domain.trim() || null,
          status: "unknown",
          created_by: user.id,
        })
        .select("id")
        .single();
      setTestResult({
        ok: false,
        message: "Server registered, but the test runner is unreachable. The SSH key was discarded. Deploy the Ops Runner and try again from the server page.",
        details: { server_id: data?.id, fallback: true, error: e?.message },
      });
      setStep("result");
      queryClient.invalidateQueries({ queryKey: ["ops_servers", projectId] });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add server</DialogTitle>
        </DialogHeader>

        {step === "form" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-01" autoFocus />
              </div>
              <div>
                <Label>Provider</Label>
                <Select value={provider} onChange={(v) => setProvider(v as OpsServerProvider)} options={PROVIDERS} />
              </div>
              <div>
                <Label>IP address</Label>
                <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="1.2.3.4" />
              </div>
              <div>
                <Label>SSH port</Label>
                <Input type="number" value={sshPort} onChange={(e) => setSshPort(Number(e.target.value) || 22)} />
              </div>
              <div>
                <Label>SSH user</Label>
                <Input value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="root" />
              </div>
              <div>
                <Label>Environment</Label>
                <Select value={environment} onChange={(v) => setEnvironment(v as OpsServerEnv)} options={ENVS.map((e) => ({ value: e.value, label: e.label }))} />
              </div>
              <div className="col-span-2">
                <Label>Domain (optional)</Label>
                <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="app.example.com" />
              </div>
              <div className="col-span-2">
                <Label>SSH private key</Label>
                <textarea
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  rows={6}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[11px] focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder={`-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----`}
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Stored encrypted with project-scoped key. Never displayed back. Service role only.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={testAndSave} disabled={!name || !ip || !sshUser || !privateKey || saving}>
                Test & save
              </Button>
            </div>
          </div>
        )}

        {step === "testing" && (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Connecting to {ip}…</p>
            <p className="text-[11px] text-muted-foreground">Probing OS, Docker, firewall, fail2ban…</p>
          </div>
        )}

        {step === "result" && testResult && (
          <div className="space-y-3">
            <div className={cn(
              "rounded-md border p-3",
              testResult.ok ? "border-emerald-500/40 bg-emerald-500/10" : "border-amber-500/40 bg-amber-500/10",
            )}>
              <div className="flex items-center gap-2">
                {testResult.ok ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                )}
                <span className="text-sm font-medium">
                  {testResult.ok ? "Server connected" : "Stored with warnings"}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{testResult.message}</p>
            </div>
            {testResult.details && (
              <pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 font-mono text-[10px]">
                {JSON.stringify(testResult.details, null, 2)}
              </pre>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button onClick={() => { reset(); onOpenChange(false); }}>Done</Button>
            </div>
          </div>
        )}
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
