import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Sparkles, Loader2, Server, Layers, Code2, Wand2, ChevronRight,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
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
import { useOpsUrl } from "./hooks";
import { NewInfraDialog } from "./NewInfraDialog";
import type { OpsGeneratedFile, OpsFileType } from "./types";

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

interface InfraProjectSummary {
  id: string;
  name: string;
  brief: string | null;
  plan_status: string;
  created_at: string;
  layer_count: number;
}

export function OpsWorkflowsPage() {
  const { projectId, workspaceId } = useCurrentContext();
  const url = useOpsUrl();
  const [genOpen, setGenOpen] = useState(false);
  const [newInfraOpen, setNewInfraOpen] = useState(false);

  const { data: infraProjects } = useQuery({
    queryKey: ["ops_infra_projects", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("ops_infra_projects")
        .select("id, name, brief, plan_status, created_at")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      if (!rows || rows.length === 0) return [] as InfraProjectSummary[];
      const { data: layers } = await supabase
        .from("ops_infra_layers")
        .select("infra_project_id")
        .in("infra_project_id", rows.map((r) => r.id));
      const counts = new Map<string, number>();
      for (const l of layers ?? []) {
        counts.set(l.infra_project_id, (counts.get(l.infra_project_id) ?? 0) + 1);
      }
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        brief: r.brief,
        plan_status: r.plan_status,
        created_at: r.created_at,
        layer_count: counts.get(r.id) ?? 0,
      })) as InfraProjectSummary[];
    },
    refetchInterval: (q) => {
      const list = q.state.data as InfraProjectSummary[] | undefined;
      return list?.some((p) => p.plan_status === "generating") ? 3000 : false;
    },
  });

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

  const nothingYet = (!bundles || bundles.length === 0) && (!infraProjects || infraProjects.length === 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workflows"
        description="Describe your infra in plain English, review the agent's plan, then generate Terraform + Ansible + Docker + K8s — each as a separate, regenerable layer."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setGenOpen(true)} className="gap-1.5">
              <Sparkles className="h-4 w-4" /> Quick start
            </Button>
            <Button onClick={() => setNewInfraOpen(true)} className="gap-1.5">
              <Wand2 className="h-4 w-4" /> New infra
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : nothingYet ? (
        <EmptyState
          icon={Layers}
          title="No workflow yet"
          description="Describe what you want to build — Terraform, Ansible, Docker, Kubernetes. The agent plans the layers and generates the files."
          action={
            <Button onClick={() => setNewInfraOpen(true)} className="gap-1.5">
              <Wand2 className="h-4 w-4" /> Describe your infra
            </Button>
          }
        />
      ) : (
        <>
          {infraProjects && infraProjects.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                <Wand2 className="h-3 w-3" /> Custom infra ({infraProjects.length})
              </div>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {infraProjects.map((p) => (
                  <Link key={p.id} to={url(`/devops/infra/${p.id}`)}>
                    <Card className="cursor-pointer transition-colors hover:border-foreground/30">
                      <CardContent className="space-y-2 p-4">
                        <div className="flex items-start justify-between">
                          <div className="min-w-0">
                            <h3 className="truncate font-semibold leading-tight">{p.name}</h3>
                            <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                              {p.brief || "No brief"}
                            </p>
                          </div>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="flex items-center justify-between text-[11px]">
                          <Badge variant="outline" className={cn(
                            "text-[10px] capitalize",
                            p.plan_status === "generated" && "text-emerald-500",
                            p.plan_status === "generating" && "text-blue-500",
                            p.plan_status === "partially_failed" && "text-amber-500",
                            p.plan_status === "failed" && "text-destructive",
                          )}>
                            {p.plan_status.replace(/_/g, " ")}
                          </Badge>
                          <span className="text-muted-foreground">{p.layer_count} layer{p.layer_count !== 1 ? "s" : ""}</span>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {bundles && bundles.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                <Sparkles className="h-3 w-3" /> Single-tool bundles ({bundles.length})
              </div>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {bundles.map((b) => (
                  <Link key={b.bundle_id} to={url(`/devops/workflows/${b.bundle_id}`)}>
                    <Card className="cursor-pointer transition-colors hover:border-foreground/30">
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
                  </Link>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {workspaceId && projectId && (
        <GenerateDialog
          open={genOpen}
          onOpenChange={setGenOpen}
          workspaceId={workspaceId}
          projectId={projectId}
        />
      )}

      <NewInfraDialog open={newInfraOpen} onOpenChange={setNewInfraOpen} />
    </div>
  );
}

// ============================================================================
// Generate dialog — unchanged, still creates a single-tool bundle.
// (The new multi-tool, agent-driven flow will live alongside this one.)
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
