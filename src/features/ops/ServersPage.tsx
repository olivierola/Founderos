import { useState, useEffect } from "react";
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
            <Link key={s.id} to={url(`/devops/servers/${s.id}`)}>
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
  const queryClient = useQueryClient();
  const env = ENVS.find((e) => e.value === server.environment);
  const isManaged = server.target_kind === "managed";
  const statusDot = {
    online: "bg-emerald-500",
    offline: "bg-muted-foreground",
    degraded: "bg-amber-500",
    provisioning: "bg-blue-500 animate-pulse",
    error: "bg-destructive",
    unknown: "bg-muted-foreground/50",
  }[server.status];

  const [deploying, setDeploying] = useState(false);
  async function quickDeploy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!isManaged) return;
    if (!confirm(`Trigger a deploy on ${server.managed_provider}?`)) return;
    setDeploying(true);
    try {
      const result = await callEdge<{ ok: boolean; message?: string; url?: string }>(
        "ops-managed-deploy",
        { server_id: server.id, action: "deploy" },
      );
      if (!result.ok) throw new Error(result.message ?? "Deploy failed");
      queryClient.invalidateQueries({ queryKey: ["ops_servers", server.project_id] });
      alert(`Deploy queued${result.url ? ` → ${result.url}` : ""}`);
    } catch (err: any) {
      alert("Deploy failed: " + (err?.message ?? "unknown"));
    } finally {
      setDeploying(false);
    }
  }

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
            {isManaged && (
              <span className="rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-500">
                managed
              </span>
            )}
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </div>

        <div className="space-y-1 text-xs text-muted-foreground">
          {isManaged ? (
            <div className="flex items-center gap-1.5">
              <Globe className="h-3 w-3" /> via {server.managed_provider}
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <Globe className="h-3 w-3" /> {server.ip_address}{server.ssh_port !== 22 ? `:${server.ssh_port}` : ""}
            </div>
          )}
          {server.domain && (
            <div className="flex items-center gap-1.5">
              <Globe className="h-3 w-3" /> {server.domain}
            </div>
          )}
          {!isManaged && server.os_name && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase">{server.os_name}</span>
              {server.os_version && <span>{server.os_version}</span>}
            </div>
          )}
        </div>

        {isManaged && (
          <div className="border-t border-border pt-2">
            <Button size="sm" onClick={quickDeploy} disabled={deploying} className="w-full gap-1.5">
              {deploying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Globe className="h-3 w-3" />}
              Deploy now
            </Button>
          </div>
        )}

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

// Managed PaaS connector candidates — anything in this list will appear in
// the "Managed target" picker if a Connector with that provider exists.
const MANAGED_PROVIDERS: Array<{ value: string; label: string; needs: string }> = [
  { value: "vercel",  label: "Vercel",  needs: "vercel_project_id (or _name) in connector metadata" },
  { value: "netlify", label: "Netlify", needs: "netlify_site_id" },
  { value: "render",  label: "Render",  needs: "render_service_id" },
  { value: "fly",     label: "Fly.io",  needs: "fly_app (coming soon)" },
  { value: "railway", label: "Railway", needs: "(coming soon)" },
];

function AddServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { user } = useAuth();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();

  // Step 0 lets the user pick the target type.
  const [kind, setKind] = useState<"choose" | "server" | "managed">("choose");

  // Shared server-SSH state (unchanged from before).
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

  // Managed-target state.
  const [managedProvider, setManagedProvider] = useState<string>("vercel");
  const [managedMeta, setManagedMeta] = useState<string>('{\n  "vercel_project_id": ""\n}');
  const [savingManaged, setSavingManaged] = useState(false);
  const [managedError, setManagedError] = useState<string | null>(null);

  // Look up connectors so we know which managed providers are usable.
  const { data: connectors } = useQuery({
    queryKey: ["ops_target_connectors", projectId, kind],
    enabled: !!projectId && (kind === "managed" || kind === "choose"),
    queryFn: async () => {
      const { data } = await supabase
        .from("connectors")
        .select("id, provider, status, metadata")
        .eq("project_id", projectId!);
      return (data ?? []) as Array<{ id: string; provider: string; status: string; metadata: Record<string, any> }>;
    },
  });
  const availableConnectors = (connectors ?? []).filter((c) =>
    MANAGED_PROVIDERS.some((p) => p.value === c.provider),
  );
  // Pick the first managed-capable connector as a default.
  useEffect(() => {
    if (kind !== "managed") return;
    const first = availableConnectors[0];
    if (first && !availableConnectors.some((c) => c.provider === managedProvider)) {
      setManagedProvider(first.provider);
    }
  }, [kind, availableConnectors, managedProvider]);
  const selectedConnector = availableConnectors.find((c) => c.provider === managedProvider);

  function reset() {
    setKind("choose");
    setName(""); setIp(""); setSshUser("root"); setSshPort(22);
    setProvider("vps"); setEnvironment("production"); setDomain("");
    setPrivateKey(""); setStep("form"); setTestResult(null);
    setManagedProvider("vercel");
    setManagedMeta('{\n  "vercel_project_id": ""\n}');
    setManagedError(null);
  }

  async function saveManagedTarget() {
    if (!user || !workspaceId || !projectId || !selectedConnector) return;
    setSavingManaged(true);
    setManagedError(null);
    let parsedMeta: Record<string, unknown>;
    try { parsedMeta = JSON.parse(managedMeta); }
    catch (e: any) { setManagedError("Invalid JSON: " + e.message); setSavingManaged(false); return; }

    try {
      const { error } = await supabase.from("ops_servers").insert({
        workspace_id: workspaceId,
        project_id: projectId,
        name: name.trim() || `${managedProvider} target`,
        target_kind: "managed",
        managed_provider: managedProvider,
        connector_id: selectedConnector.id,
        // Reuse provider/ip_address columns as placeholders. ip_address is
        // NOT NULL but is irrelevant for managed; we store the provider URL
        // hint or just "managed".
        provider: "other",
        ip_address: "managed",
        ssh_user: "n/a",
        environment,
        domain: domain.trim() || null,
        status: "online",                     // managed providers are assumed online
        created_by: user.id,
        metadata: parsedMeta,
      });
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ["ops_servers", projectId] });
      reset();
      onOpenChange(false);
    } catch (e: any) {
      setManagedError(e?.message ?? "Failed to register target");
    } finally {
      setSavingManaged(false);
    }
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
          <DialogTitle>
            {kind === "choose" ? "Add target"
              : kind === "server" ? "Add server (SSH)"
              : "Add managed target"}
          </DialogTitle>
        </DialogHeader>

        {kind === "choose" && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Targets in Ops can be a VPS you manage yourself, or a managed PaaS where
              FounderOS drives the deploy via API using one of your configured connectors.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                onClick={() => setKind("server")}
                className="rounded-md border border-border p-3 text-left transition-colors hover:border-foreground/30"
              >
                <div className="text-sm font-semibold">Server (SSH)</div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  VPS or bare-metal you provision and harden with Ansible. Full control.
                </p>
              </button>
              <button
                onClick={() => setKind("managed")}
                disabled={availableConnectors.length === 0}
                className={cn(
                  "rounded-md border border-border p-3 text-left transition-colors hover:border-foreground/30",
                  availableConnectors.length === 0 && "cursor-not-allowed opacity-50",
                )}
              >
                <div className="text-sm font-semibold">Managed PaaS</div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Vercel / Netlify / Render / Fly. Zero-config — deploys via connector.
                </p>
                {availableConnectors.length === 0 && (
                  <p className="mt-1 text-[10px] text-amber-500">
                    No managed connector configured. Connect Vercel/Netlify/… first.
                  </p>
                )}
              </button>
            </div>
          </div>
        )}

        {kind === "managed" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="prod" autoFocus />
              </div>
              <div>
                <Label>Provider (from connectors)</Label>
                <Select
                  value={managedProvider}
                  onChange={(v) => setManagedProvider(v)}
                  options={availableConnectors.map((c) => ({
                    value: c.provider,
                    label: MANAGED_PROVIDERS.find((p) => p.value === c.provider)?.label ?? c.provider,
                  }))}
                />
              </div>
              <div>
                <Label>Environment</Label>
                <Select value={environment} onChange={(v) => setEnvironment(v as OpsServerEnv)} options={ENVS.map((e) => ({ value: e.value, label: e.label }))} />
              </div>
              <div>
                <Label>Domain (optional)</Label>
                <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="app.example.com" />
              </div>
              <div className="col-span-2">
                <Label>Target metadata (JSON)</Label>
                <textarea
                  value={managedMeta}
                  onChange={(e) => setManagedMeta(e.target.value)}
                  rows={6}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[11px] focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {MANAGED_PROVIDERS.find((p) => p.value === managedProvider)?.needs ?? ""}
                </p>
              </div>
            </div>
            {managedError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {managedError}
              </div>
            )}
            <div className="flex justify-between gap-2 pt-2">
              <Button variant="ghost" onClick={() => setKind("choose")}>← Back</Button>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button
                  onClick={saveManagedTarget}
                  disabled={savingManaged || !selectedConnector || !name.trim()}
                  className="gap-1.5"
                >
                  {savingManaged && <Loader2 className="h-3 w-3 animate-spin" />}
                  Save
                </Button>
              </div>
            </div>
          </div>
        )}

        {kind === "server" && step === "form" && (
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

            <div className="flex justify-between gap-2 pt-2">
              <Button variant="ghost" onClick={() => setKind("choose")}>← Back</Button>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button onClick={testAndSave} disabled={!name || !ip || !sshUser || !privateKey || saving}>
                  Test & save
                </Button>
              </div>
            </div>
          </div>
        )}

        {kind === "server" && step === "testing" && (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Connecting to {ip}…</p>
            <p className="text-[11px] text-muted-foreground">Probing OS, Docker, firewall, fail2ban…</p>
          </div>
        )}

        {kind === "server" && step === "result" && testResult && (
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
