import { useState, useMemo } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Loader2, RefreshCw, Network, FileText, Layers,
  CheckCircle2, XCircle, Clock, AlertTriangle, Play, ShieldAlert, Download,
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
import type { OpsGeneratedFile, OpsServer } from "./types";
import type { Plan } from "./NewInfraDialog";

interface InfraProject {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  brief: string | null;
  plan: Plan;
  plan_status: "draft" | "generating" | "generated" | "partially_failed" | "failed";
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface InfraLayer {
  id: string;
  infra_project_id: string;
  layer_key: string;
  label: string;
  tool: string;
  purpose: string | null;
  bundle_id: string | null;
  status: "pending" | "generating" | "ready" | "failed" | "superseded";
  error_message: string | null;
  position: number;
}

const TOOL_COLOR: Record<string, string> = {
  terraform:      "bg-violet-500/15 text-violet-500",
  ansible:        "bg-rose-500/15 text-rose-500",
  docker_compose: "bg-blue-500/15 text-blue-500",
  kubernetes:     "bg-cyan-500/15 text-cyan-500",
  helm:           "bg-indigo-500/15 text-indigo-500",
  script:         "bg-amber-500/15 text-amber-500",
  other:          "bg-slate-500/15 text-slate-500",
};

export function OpsInfraProjectDetailPage() {
  const { infraId } = useParams();
  const { projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const url = useOpsUrl();

  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [view, setView] = useState<"architecture" | "files">("architecture");
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [regeneratingLayerId, setRegeneratingLayerId] = useState<string | null>(null);
  const [serverId, setServerId] = useState("");
  const [applying, setApplying] = useState(false);

  // Poll while any layer is generating.
  const { data: infra, isLoading } = useQuery({
    queryKey: ["ops_infra_project", infraId],
    enabled: !!infraId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_infra_projects")
        .select("*")
        .eq("id", infraId!)
        .maybeSingle();
      return data as InfraProject | null;
    },
    refetchInterval: (q) => {
      const i = q.state.data as InfraProject | null | undefined;
      return i?.plan_status === "generating" ? 2500 : false;
    },
  });

  const { data: layers } = useQuery({
    queryKey: ["ops_infra_layers", infraId],
    enabled: !!infraId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_infra_layers")
        .select("*")
        .eq("infra_project_id", infraId!)
        .order("position", { ascending: true });
      return (data ?? []) as InfraLayer[];
    },
    refetchInterval: (q) => {
      const list = q.state.data as InfraLayer[] | undefined;
      return list?.some((l) => l.status === "generating" || l.status === "pending") ? 2500 : false;
    },
  });

  // Auto-select the first ready layer once they load.
  const effectiveLayerId = activeLayerId
    ?? layers?.find((l) => l.status === "ready")?.id
    ?? layers?.[0]?.id
    ?? null;
  const activeLayer = layers?.find((l) => l.id === effectiveLayerId) ?? null;

  const { data: files } = useQuery({
    queryKey: ["ops_layer_files", activeLayer?.bundle_id],
    enabled: !!activeLayer?.bundle_id,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_generated_files")
        .select("*")
        .eq("bundle_id", activeLayer!.bundle_id!)
        .order("file_path", { ascending: true });
      return (data ?? []) as OpsGeneratedFile[];
    },
  });

  const { data: topologyRow } = useQuery({
    queryKey: ["ops_layer_topology", activeLayer?.bundle_id],
    enabled: !!activeLayer?.bundle_id,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_topologies")
        .select("id, summary, topology, created_at, source")
        .eq("bundle_id", activeLayer!.bundle_id!)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data as { id: string; summary: string | null; topology: Topology; created_at: string; source: string } | null;
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

  const file = useMemo(() => {
    if (!files || files.length === 0) return null;
    if (selectedFileId) return files.find((f) => f.id === selectedFileId) ?? files[0];
    return files[0];
  }, [files, selectedFileId]);

  async function regenerateLayer(layerKey: string) {
    if (!infraId) return;
    setRegeneratingLayerId(layerKey);
    try {
      await callEdge("ops-generate-infra", {
        infra_id: infraId,
        regenerate_layer_id: layerKey,
      });
      queryClient.invalidateQueries({ queryKey: ["ops_infra_layers", infraId] });
      queryClient.invalidateQueries({ queryKey: ["ops_infra_project", infraId] });
    } catch (e: any) {
      alert("Could not regenerate: " + (e?.message ?? "edge not deployed"));
    } finally {
      setRegeneratingLayerId(null);
    }
  }

  async function applyLayer() {
    if (!serverId || !activeLayer?.bundle_id) return;
    setApplying(true);
    try {
      const jobType = ({
        terraform: "terraform_apply",
        ansible: "ansible_apply",
        docker_compose: "docker_compose_up",
        kubernetes: "k8s_apply",
        helm: "k8s_apply",
        script: "ssh_exec",
        other: "ssh_exec",
      } as Record<string, string>)[activeLayer.tool] ?? "ssh_exec";

      await callEdge("ops-create-job", {
        server_id: serverId,
        bundle_id: activeLayer.bundle_id,
        job_type: jobType,
        risk_level: "high",
        autonomy_mode: "assisted",
        requires_approval: true,
        input: { bundle_id: activeLayer.bundle_id, layer: activeLayer.layer_key },
      });
      alert("Job created and awaiting approval. Review it in Jobs & Audit.");
      navigate(url("/ops/jobs"));
    } catch (e: any) {
      alert("Could not enqueue: " + (e?.message ?? "edge not deployed"));
    } finally {
      setApplying(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!infra) {
    return (
      <div className="space-y-4">
        <Link to={url("/ops/workflows")} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Back to workflows
        </Link>
        <EmptyState title="Infra project not found" description="It may have been deleted." />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col">
      <div className="space-y-3 border-b border-border pb-3">
        <Link to={url("/ops/workflows")} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3 w-3" /> Back to workflows
        </Link>
        <PageHeader
          title={infra.name}
          description={infra.brief ? infra.brief.slice(0, 140) + (infra.brief.length > 140 ? "…" : "") : undefined}
          actions={<StatusBadge status={infra.plan_status} />}
        />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
        {/* Left: layer list */}
        <div className="overflow-y-auto border-r border-border p-3">
          <div className="mb-2 flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Layers className="h-3 w-3" /> Layers ({layers?.length ?? 0})
          </div>
          {!layers || layers.length === 0 ? (
            <p className="rounded border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
              No layers yet.
            </p>
          ) : (
            <div className="space-y-1.5">
              {layers.map((l) => {
                const active = effectiveLayerId === l.id;
                return (
                  <button
                    key={l.id}
                    onClick={() => { setActiveLayerId(l.id); setSelectedFileId(null); }}
                    className={cn(
                      "block w-full rounded-md border p-2 text-left transition-colors",
                      active ? "border-foreground bg-foreground/5" : "border-border hover:border-foreground/30",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <LayerStatusIcon status={l.status} />
                      <span className={cn(
                        "rounded px-1.5 py-0.5 text-[9px] font-medium uppercase",
                        TOOL_COLOR[l.tool] ?? TOOL_COLOR.other,
                      )}>
                        {l.tool.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-sm font-medium">{l.label}</div>
                    {l.purpose && (
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{l.purpose}</div>
                    )}
                    {l.error_message && (
                      <div className="mt-1 truncate text-[10px] text-destructive">{l.error_message}</div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right: active layer detail */}
        <div className="flex min-h-0 flex-col">
          {!activeLayer ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a layer to inspect it.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-border bg-muted/20 px-4 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
                      TOOL_COLOR[activeLayer.tool] ?? TOOL_COLOR.other)}>
                      {activeLayer.tool.replace(/_/g, " ")}
                    </span>
                    <span className="text-sm font-semibold">{activeLayer.label}</span>
                    <LayerStatusBadge status={activeLayer.status} />
                  </div>
                  {activeLayer.purpose && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{activeLayer.purpose}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <ViewSwitcher view={view} onChange={setView} />
                  <Button
                    size="sm" variant="outline"
                    onClick={() => regenerateLayer(activeLayer.layer_key)}
                    disabled={regeneratingLayerId === activeLayer.layer_key || activeLayer.status === "generating"}
                    className="gap-1.5"
                  >
                    {regeneratingLayerId === activeLayer.layer_key
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <RefreshCw className="h-3 w-3" />}
                    Regenerate
                  </Button>
                </div>
              </div>

              <div className="min-h-0 flex-1">
                {activeLayer.status === "failed" && (
                  <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                    <div className="flex items-center gap-1 font-medium"><AlertTriangle className="h-3.5 w-3.5" /> Generation failed</div>
                    {activeLayer.error_message && <p className="mt-1">{activeLayer.error_message}</p>}
                  </div>
                )}

                {(activeLayer.status === "pending" || activeLayer.status === "generating") && (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    Generating this layer…
                  </div>
                )}

                {activeLayer.status === "ready" && activeLayer.bundle_id && view === "files" && (
                  <div className="grid h-full grid-cols-[240px_1fr]">
                    <div className="overflow-y-auto border-r border-border p-2">
                      {(files ?? []).map((f) => (
                        <button
                          key={f.id}
                          onClick={() => setSelectedFileId(f.id)}
                          className={cn(
                            "flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/40",
                            file?.id === f.id && "bg-foreground/10 text-foreground",
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
                          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                            <span className="text-xs text-muted-foreground">{file.file_path}</span>
                            <Button size="sm" variant="ghost" onClick={() => {
                              const blob = new Blob([file.content], { type: "text/plain" });
                              const a = document.createElement("a");
                              a.href = URL.createObjectURL(blob);
                              a.download = file.file_path.split("/").pop()!;
                              a.click();
                            }}>
                              <Download className="h-3 w-3" />
                            </Button>
                          </div>
                          <pre className="flex-1 overflow-auto bg-muted/30 p-3 font-mono text-[11px]">{file.content}</pre>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {activeLayer.status === "ready" && activeLayer.bundle_id && view === "architecture" && (
                  <>
                    {topologyRow?.topology
                      ? <ArchitectureView topology={topologyRow.topology} summary={topologyRow.summary} />
                      : (
                        <div className="flex h-full flex-col items-center justify-center gap-3 bg-slate-950 p-8 text-center">
                          <Network className="h-10 w-10 text-slate-600" />
                          <p className="text-sm text-slate-300">No architecture diagram for this layer yet.</p>
                          <p className="text-xs text-slate-500">
                            The topology is generated on the first bundle creation. Use Regenerate to recompute it.
                          </p>
                        </div>
                      )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="h-4 w-4 text-amber-500" />
          {activeLayer
            ? <>Apply the active layer ({activeLayer.label}) to a server. Requires approval.</>
            : <>Pick a ready layer to apply it.</>}
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
          <Button
            onClick={applyLayer}
            disabled={!serverId || applying || activeLayer?.status !== "ready"}
            className="gap-1.5"
          >
            {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Plan & apply layer
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: InfraProject["plan_status"] }) {
  const cfg = {
    draft: { color: "text-muted-foreground", label: "Draft" },
    generating: { color: "text-blue-500", label: "Generating…" },
    generated: { color: "text-emerald-500", label: "Generated" },
    partially_failed: { color: "text-amber-500", label: "Partial failure" },
    failed: { color: "text-destructive", label: "Failed" },
  }[status];
  return <Badge variant="outline" className={cn("text-[10px]", cfg.color)}>{cfg.label}</Badge>;
}

function LayerStatusIcon({ status }: { status: InfraLayer["status"] }) {
  const Icon = {
    pending: Clock,
    generating: Loader2,
    ready: CheckCircle2,
    failed: XCircle,
    superseded: AlertTriangle,
  }[status];
  const color = {
    pending: "text-muted-foreground",
    generating: "text-blue-500",
    ready: "text-emerald-500",
    failed: "text-destructive",
    superseded: "text-amber-500",
  }[status];
  return <Icon className={cn("h-3 w-3", color, status === "generating" && "animate-spin")} />;
}

function LayerStatusBadge({ status }: { status: InfraLayer["status"] }) {
  return <Badge variant="outline" className="text-[10px] capitalize">{status}</Badge>;
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
