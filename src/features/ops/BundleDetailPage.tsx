import { useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, FileText, Loader2, Network, RefreshCw,
  Play, ShieldAlert, Download,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { ArchitectureView, type Topology } from "./ArchitectureView";
import { useOpsUrl } from "./hooks";
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

export function OpsBundleDetailPage() {
  const { bundleId } = useParams();
  const { projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const url = useOpsUrl();

  const [view, setView] = useState<"architecture" | "files">("architecture");
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [serverId, setServerId] = useState<string>("");
  const [applying, setApplying] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const { data: files, isLoading } = useQuery({
    queryKey: ["ops_bundle_files", bundleId],
    enabled: !!bundleId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_generated_files")
        .select("*")
        .eq("bundle_id", bundleId!)
        .order("file_path", { ascending: true });
      return (data ?? []) as OpsGeneratedFile[];
    },
  });

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

  const { data: topologyRow } = useQuery({
    queryKey: ["ops_topology", bundleId],
    enabled: !!bundleId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_topologies")
        .select("id, summary, topology, created_at, source")
        .eq("bundle_id", bundleId!)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data as { id: string; summary: string | null; topology: Topology; created_at: string; source: string } | null;
    },
    refetchInterval: regenerating ? 2000 : false,
  });

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!files || files.length === 0) {
    return (
      <div className="space-y-4">
        <Link to={url("/devops/workflows")} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Back to workflows
        </Link>
        <EmptyState title="Bundle not found" description="It may have been deleted." />
      </div>
    );
  }

  const label = files[0].bundle_label ?? "Bundle";
  const createdAt = files[0].created_at;
  const applied = files.some((f) => f.status === "applied");
  const file = selectedFileId
    ? files.find((f) => f.id === selectedFileId) ?? files[0]
    : files[0];

  async function regenerateTopology() {
    if (!bundleId) return;
    setRegenerating(true);
    try {
      await callEdge("ops-generate-topology", { bundle_id: bundleId });
      queryClient.invalidateQueries({ queryKey: ["ops_topology", bundleId] });
    } catch (e: any) {
      alert("Could not regenerate: " + (e?.message ?? "edge not deployed"));
    } finally {
      setRegenerating(false);
    }
  }

  async function apply() {
    if (!serverId || !bundleId) return;
    setApplying(true);
    try {
      // Map bundle to a job_type from the dominant file types.
      const hasCompose = files!.some((f) => f.file_type === "docker_compose");
      const hasAnsible = files!.some((f) => f.file_type === "ansible_playbook");
      const hasTf = files!.some((f) => f.file_type === "terraform");
      const hasK8s = files!.some((f) => f.file_type === "kubernetes_manifest");
      let jobType = "ssh_exec";
      if (hasK8s) jobType = "k8s_apply";
      else if (hasTf) jobType = "terraform_apply";
      else if (hasAnsible) jobType = "ansible_apply";
      else if (hasCompose) jobType = "docker_compose_up";

      await callEdge("ops-create-job", {
        server_id: serverId,
        bundle_id: bundleId,
        job_type: jobType,
        risk_level: "high",
        autonomy_mode: "assisted",
        requires_approval: true,
        input: { bundle_id: bundleId },
      });
      alert("Job created and awaiting approval. Review it in Jobs & Audit.");
      navigate(url("/devops/jobs"));
    } catch (e: any) {
      alert("Could not enqueue: " + (e?.message ?? "edge not deployed"));
    } finally {
      setApplying(false);
    }
  }

  // Floating actions that live INSIDE the architecture canvas (when it's the
  // active view). Keeps the user-facing controls but lets the canvas be fullbleed.
  const archHeaderActions = (
    <div className="flex items-center gap-2">
      <Link
        to={url("/devops/workflows")}
        className="inline-flex items-center gap-1 rounded-lg border border-border bg-card/90 px-2 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" /> Workflows
      </Link>
      <Button
        size="sm" variant="outline"
        onClick={regenerateTopology}
        disabled={regenerating}
        className="gap-1.5 bg-card/90 backdrop-blur"
      >
        {regenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        {topologyRow ? "Regenerate" : "Generate"}
      </Button>
      <div className="rounded-lg bg-card/90 backdrop-blur">
        <ViewSwitcher view={view} onChange={setView} />
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {/* In Files mode we keep a normal page header. In Architecture mode the
          canvas is fullbleed — header floats inside it. */}
      {view === "files" && (
        <div className="space-y-3 border-b border-border pb-3">
          <Link to={url("/devops/workflows")} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> Back to workflows
          </Link>
          <PageHeader
            title={label}
            description={`${files.length} files · created ${new Date(createdAt).toLocaleString()}${applied ? " · applied" : ""}`}
            actions={<ViewSwitcher view={view} onChange={setView} />}
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {view === "files" && (
          <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr]">
            <div className="overflow-y-auto border-r border-border p-2">
              {files.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setSelectedFileId(f.id)}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/40",
                    file.id === f.id && "bg-foreground/10 text-foreground",
                  )}
                >
                  <FileText className="h-3 w-3 text-muted-foreground" />
                  <span className="truncate">{f.file_path}</span>
                </button>
              ))}
            </div>

            <div className="flex min-h-0 flex-col">
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
            </div>
          </div>
        )}

        {view === "architecture" && (
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
              {topologyRow?.topology
                ? (
                  <ArchitectureView
                    topology={topologyRow.topology}
                    summary={topologyRow.summary}
                    title={label}
                    serverId={serverId || null}
                    onServerChange={setServerId}
                    servers={servers}
                    onApply={apply}
                    applying={applying}
                    canApply={files.length > 0}
                    headerActions={archHeaderActions}
                    onAiMessage={async (msg) => {
                      // Placeholder: the AI-driven topology edit endpoint isn't
                      // shipped yet. We surface the planned behaviour so the user
                      // can validate the UX; future PR will route this through
                      // ops-generate-topology with an edit prompt.
                      return `(coming soon) The AI will modify the infra based on: "${msg}"`;
                    }}
                    onTopologyChange={async (next) => {
                      if (!topologyRow?.id || !bundleId) return;
                      const { error } = await supabase
                        .from("ops_topologies")
                        .update({ topology: next })
                        .eq("id", topologyRow.id);
                      if (error) {
                        alert("Could not save topology change: " + error.message);
                        return;
                      }
                      try {
                        const { patchBundle } = await import("./filePatchers");
                        const fileRows = (files ?? []).map((f) => ({
                          id: f.id, file_path: f.file_path, file_type: f.file_type, content: f.content,
                        }));
                        const { patched } = patchBundle(fileRows, next);
                        await Promise.all(
                          Array.from(patched.entries()).map(([id, content]) =>
                            supabase.from("ops_generated_files").update({ content }).eq("id", id),
                          ),
                        );
                        if (patched.size > 0) {
                          queryClient.invalidateQueries({ queryKey: ["ops_bundle_files", bundleId] });
                        }
                      } catch (e) {
                        console.error("File sync failed:", e);
                      }
                      queryClient.invalidateQueries({ queryKey: ["ops_topology", bundleId] });
                    }}
                  />
                )
                : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 bg-background p-8 text-center">
                    <Network className="h-10 w-10 text-muted-foreground" />
                    <p className="text-sm text-foreground">No architecture diagram for this bundle yet.</p>
                    <p className="text-xs text-muted-foreground">Click "Generate" to ask the AI to extract the topology from the files.</p>
                    <div className="mt-2">{archHeaderActions}</div>
                  </div>
                )}
            </div>
          </div>
        )}
      </div>

      {view === "files" && (
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
      )}
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
