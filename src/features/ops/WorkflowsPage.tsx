import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Sparkles, FileText, Loader2, Server, Layers, Code2,
  Play, ShieldAlert, Download, X, Network, RefreshCw,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { ArchitectureView, type Topology } from "./ArchitectureView";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import type { OpsGeneratedFile, OpsServer, OpsFileType } from "./types";

const FILE_TYPE_LABEL: Record<OpsFileType, string> = {
  dockerfile: "Dockerfile",
  docker_compose: "docker-compose",
  nginx_conf: "nginx.conf",
  ansible_playbook: "Ansible playbook",
  ansible_inventory: "Ansible inventory",
  terraform: "Terraform",
  kubernetes_manifest: "Kubernetes",
  helm_chart: "Helm chart",
  env_example: ".env.example",
  script: "Shell script",
  readme: "README",
  other: "Other",
};

const TARGETS = [
  { value: "docker_compose", label: "Docker Compose", description: "VPS + nginx + certbot + compose. Best for MVP." },
  { value: "ansible", label: "Ansible playbook", description: "Idempotent server provisioning." },
  { value: "terraform", label: "Terraform", description: "Infrastructure as code for cloud providers." },
  { value: "kubernetes", label: "Kubernetes", description: "Helm + manifests for K8s clusters." },
] as const;

type TargetKind = typeof TARGETS[number]["value"];

interface Bundle {
  bundle_id: string;
  bundle_label: string | null;
  created_at: string;
  files: OpsGeneratedFile[];
  applied: boolean;
}

export function OpsWorkflowsPage() {
  const { projectId, workspaceId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [genOpen, setGenOpen] = useState(false);

  // Fetch all files, group them by bundle_id.
  const { data: bundles, isLoading } = useQuery({
    queryKey: ["ops_bundles", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_generated_files")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      const files = (data ?? []) as OpsGeneratedFile[];
      const map = new Map<string, Bundle>();
      for (const f of files) {
        const b = map.get(f.bundle_id);
        if (!b) {
          map.set(f.bundle_id, {
            bundle_id: f.bundle_id,
            bundle_label: f.bundle_label,
            created_at: f.created_at,
            files: [f],
            applied: f.status === "applied",
          });
        } else {
          b.files.push(f);
          if (f.status === "applied") b.applied = true;
        }
      }
      return Array.from(map.values()).sort((a, b) =>
        b.created_at.localeCompare(a.created_at)
      );
    },
  });

  const openBundle = bundles?.find((b) => b.bundle_id === openId) ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workflows"
        description="Generate infra files (Dockerfile, docker-compose, Ansible, Terraform, K8s) from your project, review, and apply."
        actions={
          <Button onClick={() => setGenOpen(true)} className="gap-1.5">
            <Sparkles className="h-4 w-4" /> Generate infra
          </Button>
        }
      />

      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : !bundles || bundles.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No workflow yet"
          description="Generate your first infra bundle from your project's code scan."
          action={
            <Button onClick={() => setGenOpen(true)} className="gap-1.5">
              <Sparkles className="h-4 w-4" /> Generate infra
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {bundles.map((b) => (
            <Card
              key={b.bundle_id}
              onClick={() => setOpenId(b.bundle_id)}
              className="cursor-pointer transition-colors hover:border-foreground/30"
            >
              <CardContent className="space-y-2 p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold leading-tight">{b.bundle_label || "Unnamed bundle"}</h3>
                    <p className="text-[11px] text-muted-foreground">{new Date(b.created_at).toLocaleString()}</p>
                  </div>
                  {b.applied && <Badge variant="outline" className="text-[10px] text-emerald-500">applied</Badge>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {b.files.slice(0, 6).map((f) => (
                    <Badge key={f.id} variant="outline" className="text-[10px]">{FILE_TYPE_LABEL[f.file_type]}</Badge>
                  ))}
                  {b.files.length > 6 && (
                    <Badge variant="outline" className="text-[10px]">+{b.files.length - 6}</Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {openBundle && (
        <BundleDrawer
          bundle={openBundle}
          onClose={() => setOpenId(null)}
          onChanged={() => queryClient.invalidateQueries({ queryKey: ["ops_bundles", projectId] })}
        />
      )}

      {workspaceId && projectId && (
        <GenerateDialog
          open={genOpen}
          onOpenChange={setGenOpen}
          workspaceId={workspaceId}
          projectId={projectId}
        />
      )}
    </div>
  );
}

// ============================================================================
// Bundle detail drawer
// ============================================================================

function BundleDrawer({
  bundle,
  onClose,
  onChanged,
}: {
  bundle: Bundle;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"files" | "architecture">("architecture");
  const [selectedFileId, setSelectedFileId] = useState<string>(bundle.files[0]?.id);
  const [serverId, setServerId] = useState<string>("");
  const [applying, setApplying] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const { data: servers } = useQuery({
    queryKey: ["ops_servers_list", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_servers")
        .select("id, name, environment, status")
        .eq("project_id", projectId!)
        .order("name");
      return (data ?? []) as Pick<OpsServer, "id" | "name" | "environment" | "status">[];
    },
  });

  // Load the latest topology for this bundle. Auto-refresh while we regenerate.
  const { data: topologyRow } = useQuery({
    queryKey: ["ops_topology", bundle.bundle_id],
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_topologies")
        .select("id, summary, topology, created_at, source")
        .eq("bundle_id", bundle.bundle_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data as { id: string; summary: string | null; topology: Topology; created_at: string; source: string } | null;
    },
    refetchInterval: regenerating ? 2000 : false,
  });

  async function regenerateTopology() {
    setRegenerating(true);
    try {
      await callEdge("ops-generate-topology", { bundle_id: bundle.bundle_id });
      queryClient.invalidateQueries({ queryKey: ["ops_topology", bundle.bundle_id] });
    } catch (e: any) {
      alert("Could not regenerate: " + (e?.message ?? "edge not deployed"));
    } finally {
      setRegenerating(false);
    }
  }

  const file = bundle.files.find((f) => f.id === selectedFileId) ?? bundle.files[0];

  async function apply() {
    if (!serverId) {
      alert("Pick a target server first.");
      return;
    }
    setApplying(true);
    try {
      // Map bundle to a job_type. Compose -> docker_compose_up; ansible -> ansible_apply;
      // terraform -> terraform_apply; k8s -> k8s_apply.
      const hasCompose = bundle.files.some((f) => f.file_type === "docker_compose");
      const hasAnsible = bundle.files.some((f) => f.file_type === "ansible_playbook");
      const hasTf = bundle.files.some((f) => f.file_type === "terraform");
      const hasK8s = bundle.files.some((f) => f.file_type === "kubernetes_manifest");
      let jobType = "ssh_exec";
      if (hasK8s) jobType = "k8s_apply";
      else if (hasTf) jobType = "terraform_apply";
      else if (hasAnsible) jobType = "ansible_apply";
      else if (hasCompose) jobType = "docker_compose_up";

      await callEdge("ops-create-job", {
        server_id: serverId,
        bundle_id: bundle.bundle_id,
        job_type: jobType,
        risk_level: "high",
        autonomy_mode: "assisted",
        requires_approval: true,
        input: { bundle_id: bundle.bundle_id },
      });
      onChanged();
      alert("Job created and awaiting approval. Review it in Jobs & Audit.");
    } catch (e: any) {
      alert("Could not enqueue: " + (e?.message ?? "edge not deployed"));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch">
      <div className="flex-1 bg-foreground/30 backdrop-blur-sm" onClick={onClose} />
      <div className="flex w-full max-w-5xl flex-col bg-background shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{bundle.bundle_label || "Bundle"}</h3>
            <p className="text-[11px] text-muted-foreground">
              {bundle.files.length} files · {new Date(bundle.created_at).toLocaleString()}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ViewSwitcher view={view} onChange={setView} />
            <Button size="sm" variant="ghost" onClick={onClose}><X className="h-4 w-4" /></Button>
          </div>
        </div>

        {view === "files" && (
          <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr]">
            <div className="overflow-y-auto border-r border-border p-2">
              {bundle.files.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setSelectedFileId(f.id)}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/40",
                    selectedFileId === f.id && "bg-foreground/10 text-foreground",
                  )}
                >
                  <FileText className="h-3 w-3 text-muted-foreground" />
                  <span className="truncate">{f.file_path}</span>
                </button>
              ))}
            </div>

            <div className="flex min-h-0 flex-col">
              {file && (
                <>
                  <div className="flex items-center justify-between border-b border-border px-4 py-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">{FILE_TYPE_LABEL[file.file_type]}</Badge>
                      <span className="text-xs text-muted-foreground">{file.file_path}</span>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => {
                      const blob = new Blob([file.content], { type: "text/plain" });
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(blob);
                      a.download = file.file_path.split("/").pop()!;
                      a.click();
                    }}>
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <pre className="flex-1 overflow-auto bg-muted/30 p-3 font-mono text-[11px]">
                    {file.content}
                  </pre>
                </>
              )}
            </div>
          </div>
        )}

        {view === "architecture" && (
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-border bg-muted/20 px-4 py-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Network className="h-3.5 w-3.5" />
                {topologyRow
                  ? <>Architecture · last computed {new Date(topologyRow.created_at).toLocaleString()} · {topologyRow.source}</>
                  : <>No architecture computed yet for this bundle.</>}
              </div>
              <Button size="sm" variant="outline" onClick={regenerateTopology} disabled={regenerating} className="gap-1.5">
                {regenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                {topologyRow ? "Regenerate" : "Generate"}
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              {topologyRow?.topology
                ? <ArchitectureView topology={topologyRow.topology} summary={topologyRow.summary} />
                : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 bg-slate-950 p-8 text-center">
                    <Network className="h-10 w-10 text-slate-600" />
                    <p className="text-sm text-slate-300">No architecture diagram for this bundle yet.</p>
                    <p className="text-xs text-slate-500">Click "Generate" to ask the AI to extract the topology from the files.</p>
                  </div>
                )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-500" />
            <span className="text-xs text-muted-foreground">High-risk action. Requires approval after queueing.</span>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Target server…</option>
              {servers?.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.environment})</option>
              ))}
            </select>
            <Button onClick={apply} disabled={!serverId || applying} className="gap-1.5">
              {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Plan & apply
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ViewSwitcher({ view, onChange }: { view: "files" | "architecture"; onChange: (v: "files" | "architecture") => void }) {
  return (
    <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
      {(["architecture", "files"] as const).map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cn(
            "inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors",
            view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {v === "architecture" ? <Network className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
          {v === "architecture" ? "Architecture" : "Files"}
        </button>
      ))}
    </div>
  );
}

// ============================================================================
// Generate dialog — kicks off the AI generation via edge function
// ============================================================================

function GenerateDialog({
  open,
  onOpenChange,
  workspaceId,
  projectId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  projectId: string;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<TargetKind>("docker_compose");
  const [label, setLabel] = useState("");
  const [domain, setDomain] = useState("");
  const [envHints, setEnvHints] = useState("");
  const [generating, setGenerating] = useState(false);

  async function generate() {
    if (!user) return;
    setGenerating(true);
    try {
      await callEdge("ops-generate-blueprint", {
        workspace_id: workspaceId,
        project_id: projectId,
        target,
        label: label.trim() || `${TARGETS.find((t) => t.value === target)?.label} bundle`,
        domain: domain.trim() || null,
        env_hints: envHints.split("\n").map((s) => s.trim()).filter(Boolean),
      });
      queryClient.invalidateQueries({ queryKey: ["ops_bundles", projectId] });
      onOpenChange(false);
      setLabel(""); setDomain(""); setEnvHints("");
    } catch (e: any) {
      alert("Could not generate: " + (e?.message ?? "edge not deployed"));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Generate infra bundle</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs text-muted-foreground">Target</p>
            <div className="grid grid-cols-2 gap-2">
              {TARGETS.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setTarget(t.value)}
                  className={cn(
                    "rounded-md border p-3 text-left transition-colors",
                    target === t.value ? "border-foreground bg-foreground/5" : "border-border hover:border-foreground/30",
                  )}
                >
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {t.value === "docker_compose" ? <Code2 className="h-3.5 w-3.5" />
                      : t.value === "ansible" ? <Server className="h-3.5 w-3.5" />
                      : t.value === "terraform" ? <Layers className="h-3.5 w-3.5" />
                      : <Server className="h-3.5 w-3.5" />}
                    {t.label}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{t.description}</p>
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label>Label (optional)</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="prod-01 Docker compose" />
          </div>

          <div>
            <Label>Public domain (optional)</Label>
            <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="app.example.com" />
          </div>

          <div>
            <Label>Required env vars (one per line, optional)</Label>
            <textarea
              value={envHints}
              onChange={(e) => setEnvHints(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[11px] focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="STRIPE_SECRET_KEY&#10;SUPABASE_URL&#10;SUPABASE_SERVICE_ROLE_KEY"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={generate} disabled={generating} className="gap-1.5">
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              Generate
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
