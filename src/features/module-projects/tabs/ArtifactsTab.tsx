import { useState } from "react";
import {
  Plus, Trash2, FileText, Code2, Image, FlaskConical, TestTube2, BarChart3,
  Shield, Package, ExternalLink, ChevronDown, Search, Bot, BrainCircuit,
  Loader2, Check, AlertTriangle, Activity,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { AgentPlanning, type PlanStep } from "@/components/ui/ai-planning";
import { cn } from "@/lib/utils";

export interface Artifact {
  id: string;
  type: "report" | "document" | "simulation" | "test_result" | "code" | "analysis" | "image" | "security_scan" | "other";
  title: string;
  description?: string;
  content?: string;
  url?: string;
  created_by: string;
  created_by_type: "human" | "agent";
  created_at: string;
  status: "draft" | "ready" | "approved" | "archived";
}

const ARTIFACT_TYPES = [
  { key: "report", label: "Report", icon: BarChart3, color: "#3b82f6" },
  { key: "document", label: "Document", icon: FileText, color: "#10b981" },
  { key: "simulation", label: "Simulation", icon: FlaskConical, color: "#8b5cf6" },
  { key: "test_result", label: "Test Result", icon: TestTube2, color: "#f59e0b" },
  { key: "code", label: "Code", icon: Code2, color: "#6366f1" },
  { key: "analysis", label: "Analysis", icon: BarChart3, color: "#ec4899" },
  { key: "image", label: "Image / Media", icon: Image, color: "#f97316" },
  { key: "security_scan", label: "Security Scan", icon: Shield, color: "#ef4444" },
  { key: "other", label: "Other", icon: Package, color: "#6b7280" },
] as const;

const STATUS_CLS: Record<string, string> = {
  draft: "bg-zinc-500/15 text-zinc-400", ready: "bg-sky-500/15 text-sky-500",
  approved: "bg-emerald-500/15 text-emerald-500", archived: "bg-zinc-500/15 text-zinc-400",
};

function getArtifactDef(type: string) {
  return ARTIFACT_TYPES.find((t) => t.key === type) ?? ARTIFACT_TYPES[ARTIFACT_TYPES.length - 1];
}

export function ArtifactsTab({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const { projectId } = useCurrentContext();
  const artifacts: Artifact[] = (mp.metadata as any)?.artifacts ?? [];
  const assignedAgentIds: string[] = (mp.metadata as any)?.assigned_agents ?? [];
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ type: "report" as Artifact["type"], title: "", description: "", content: "", url: "" });

  // Fetch recent runs from assigned agents
  const { data: agentRuns } = useQuery({
    queryKey: ["artifact_agent_runs", projectId, assignedAgentIds.join(",")],
    enabled: assignedAgentIds.length > 0 && !!projectId,
    queryFn: async () => {
      const { data: agents } = await supabase.from("internal_agents")
        .select("id, name, avatar_emoji, accent_color")
        .in("id", assignedAgentIds);
      const { data: runs } = await supabase.from("internal_agent_runs")
        .select("id, mission_id, status, created_at, finished_at")
        .in("agent_id", assignedAgentIds)
        .order("created_at", { ascending: false }).limit(10);
      const { data: events } = runs?.length
        ? await supabase.from("internal_agent_run_events")
            .select("id, run_id, kind, summary, created_at")
            .in("run_id", (runs ?? []).map((r: any) => r.id))
            .order("created_at", { ascending: true }).limit(50)
            .then((r) => r)
        : { data: [] };
      return { agents: agents ?? [], runs: runs ?? [], events: events ?? [] };
    },
    refetchInterval: 5000,
  });

  const runSteps = (agentRuns?.runs ?? []).slice(0, 3).map((run: any): { agentName: string; agentEmoji: string; steps: PlanStep[] } => {
    const agent = (agentRuns?.agents ?? []).find((a: any) => a.id === run.agent_id) as any;
    const runEvents = (agentRuns?.events ?? []).filter((e: any) => e.run_id === run.id);
    const steps: PlanStep[] = runEvents.map((ev: any, i: number): PlanStep => ({
      id: ev.id,
      title: ev.summary || ev.kind,
      status: i === runEvents.length - 1 && run.status === "running" ? "active" : ev.kind === "error" ? "error" : "success",
      icon: ev.kind === "tool_call" ? <Activity className="w-3.5 h-3.5" /> :
            ev.kind === "llm_call" ? <BrainCircuit className="w-3.5 h-3.5" /> :
            ev.kind === "error" ? <AlertTriangle className="w-3.5 h-3.5" /> :
            <Check className="w-3.5 h-3.5" />,
      duration: ev.created_at ? new Date(ev.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : undefined,
    }));
    if (run.status === "running" && steps.length === 0) {
      steps.push({ id: "init", title: "Initializing…", status: "active", icon: <Loader2 className="w-3.5 h-3.5" /> });
    }
    return { agentName: agent?.name ?? "Agent", agentEmoji: agent?.avatar_emoji ?? "🤖", steps };
  });

  async function save(next: Artifact[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, artifacts: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function add() {
    if (!form.title.trim()) return;
    const artifact: Artifact = {
      id: crypto.randomUUID(), type: form.type, title: form.title.trim(),
      description: form.description.trim() || undefined,
      content: form.content.trim() || undefined,
      url: form.url.trim() || undefined,
      created_by: "user", created_by_type: "human",
      created_at: new Date().toISOString(), status: "draft",
    };
    save([artifact, ...artifacts]);
    setForm({ type: "report", title: "", description: "", content: "", url: "" });
    setAdding(false);
  }

  function remove(id: string) { save(artifacts.filter((a) => a.id !== id)); }

  function cycleStatus(id: string) {
    const order: Artifact["status"][] = ["draft", "ready", "approved", "archived"];
    save(artifacts.map((a) => {
      if (a.id !== id) return a;
      return { ...a, status: order[(order.indexOf(a.status) + 1) % order.length] };
    }));
  }

  const filtered = search
    ? artifacts.filter((a) => a.title.toLowerCase().includes(search.toLowerCase()) || a.type.includes(search.toLowerCase()))
    : artifacts;

  return (
    <div className="space-y-4 py-6">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><Package className="h-4 w-4 text-muted-foreground" /> Artifacts ({artifacts.length})</h3>
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className="ml-auto h-7 w-40 text-xs" />
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="mr-1 h-3.5 w-3.5" /> New artifact</Button>
      </div>

      {/* ── Agent runs (live activity) ── */}
      {runSteps.length > 0 && (
        <div className="space-y-3">
          {runSteps.map((rs, i) => (
            <AgentPlanning
              key={i}
              title={`${rs.agentEmoji} ${rs.agentName} is working`}
              steps={rs.steps}
            />
          ))}
        </div>
      )}

      {/* ── Add form ── */}
      {adding && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Artifact title" autoFocus />
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as Artifact["type"] })}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
              {ARTIFACT_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </div>
          <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="URL / link (optional)" />
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder="Description"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          <textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={5} placeholder="Content (markdown, code, data…)"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={!form.title.trim()}>Create</Button>
          </div>
        </div>
      )}

      {/* ── Artifact list ── */}
      {filtered.length === 0 && !adding && (
        <div className="rounded-xl border border-dashed border-border py-10 text-center">
          <Package className="mx-auto h-8 w-8 text-muted-foreground/30" />
          <p className="mt-2 text-sm text-muted-foreground">No artifacts yet. Agents and humans produce artifacts here — reports, documents, scans, simulations…</p>
        </div>
      )}

      <div className="space-y-1.5">
        {filtered.map((a) => {
          const def = getArtifactDef(a.type);
          const Icon = def.icon;
          const isExpanded = expanded === a.id;
          return (
            <div key={a.id} className="group rounded-xl border border-border bg-card">
              <button onClick={() => setExpanded(isExpanded ? null : a.id)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-secondary/20">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white" style={{ backgroundColor: def.color }}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{a.title}</span>
                    <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase", STATUS_CLS[a.status])}>{a.status}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>{def.label}</span>
                    <span>·</span>
                    <span>{a.created_by_type === "agent" ? "🤖" : "👤"} {a.created_by}</span>
                    <span>·</span>
                    <span>{new Date(a.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                </div>
                {a.url && <a href={a.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="rounded p-1 text-muted-foreground hover:text-foreground"><ExternalLink className="h-3.5 w-3.5" /></a>}
                <button onClick={(e) => { e.stopPropagation(); cycleStatus(a.id); }} className="rounded px-1.5 py-0.5 text-[9px] text-muted-foreground hover:text-foreground border border-border" title="Cycle status">↻</button>
                <button onClick={(e) => { e.stopPropagation(); remove(a.id); }} className="hidden rounded p-1 text-muted-foreground hover:text-destructive group-hover:block"><Trash2 className="h-3.5 w-3.5" /></button>
                <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", isExpanded && "rotate-180")} />
              </button>
              {isExpanded && (
                <div className="border-t border-border">
                  {a.description && <p className="px-4 py-2 text-xs text-muted-foreground">{a.description}</p>}
                  {a.content && (
                    <div className="bg-zinc-950 px-4 py-3">
                      <pre className="whitespace-pre-wrap text-xs text-zinc-300 font-mono max-h-64 overflow-y-auto">{a.content}</pre>
                    </div>
                  )}
                  {!a.description && !a.content && <p className="px-4 py-3 text-xs text-muted-foreground">No content.</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
