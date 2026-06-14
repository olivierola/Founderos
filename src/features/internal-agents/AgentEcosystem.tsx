import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import ReactFlow, {
  Background, BackgroundVariant, Controls, MiniMap, Handle, Position,
  type Node, type Edge, type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "dagre";
import {
  Loader2, Network, MessagesSquare, Brain, ArrowRight, Pin, Bot,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import {
  type InternalAgent, type A2AMessage, type A2AThread, type TeamMemory,
  MEMORY_KIND_META,
} from "./shared";
import { relativeDate } from "./shared";

export function AgentEcosystemPage() {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { projectId } = useCurrentContext();

  const { data: agents, isLoading } = useQuery({
    queryKey: ["eco_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents")
        .select("id, name, avatar_emoji, accent_color, role, skills, collaboration_enabled, description")
        .eq("project_id", projectId!)
        .eq("is_archived", false)
        .order("created_at", { ascending: true });
      return (data ?? []) as Pick<InternalAgent, "id" | "name" | "avatar_emoji" | "accent_color" | "role" | "skills" | "collaboration_enabled" | "description">[];
    },
  });

  const { data: threads } = useQuery({
    queryKey: ["eco_threads", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_a2a_threads")
        .select("id, agent_a, agent_b, topic, updated_at")
        .eq("project_id", projectId!);
      return (data ?? []) as A2AThread[];
    },
    refetchInterval: 5000,
  });

  const { data: feed } = useQuery({
    queryKey: ["eco_feed", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_a2a_messages")
        .select("id, thread_id, from_agent, to_agent, content, status, reply_to, created_at")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(40);
      return (data ?? []) as A2AMessage[];
    },
    refetchInterval: 4000,
  });

  const { data: teamMem } = useQuery({
    queryKey: ["eco_team_memory", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_team_memories")
        .select("id, kind, content, author_agent, source, importance, is_pinned, created_at")
        .eq("project_id", projectId!)
        .order("is_pinned", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(30);
      return (data ?? []) as TeamMemory[];
    },
    refetchInterval: 8000,
  });

  const agentById = useMemo(() => {
    const m: Record<string, (typeof agents extends (infer T)[] ? T : never)> = {} as any;
    (agents ?? []).forEach((a) => { (m as any)[a.id] = a; });
    return m as Record<string, NonNullable<typeof agents>[number]>;
  }, [agents]);

  const name = (id: string) => agentById[id]?.name ?? id.slice(0, 6);

  if (isLoading) {
    return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  const collaborating = (agents ?? []).filter((a) => a.collaboration_enabled);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Agent ecosystem"
        description="Your autonomous agents as a collaborating team — who talks to whom, what they exchange, and the shared knowledge they build."
      />

      {collaborating.length === 0 ? (
        <EmptyState
          icon={Network}
          title="No collaborating agents yet"
          description="Create autonomous agents and enable collaboration on them — they'll be able to message, delegate and share knowledge here."
        />
      ) : (
        <div className="space-y-5">
          {/* Infinite collaboration canvas — full width */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm"><Network className="h-4 w-4" /> Collaboration canvas</CardTitle>
            </CardHeader>
            <CardContent className="p-2">
              <NetworkGraph
                agents={collaborating}
                threads={threads ?? []}
                onOpen={(id) => navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal/${id}/chat`)}
              />
            </CardContent>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
          {/* Team memory */}
          <Card className="flex max-h-[520px] flex-col">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm"><Brain className="h-4 w-4" /> Team memory</CardTitle>
            </CardHeader>
            <CardContent className="min-h-0 flex-1 overflow-y-auto">
              {(teamMem ?? []).length === 0 ? (
                <p className="py-8 text-center text-xs text-muted-foreground">No shared knowledge yet. Agents add facts and decisions here as they collaborate.</p>
              ) : (
                <div className="space-y-2">
                  {(teamMem ?? []).map((m) => {
                    const meta = MEMORY_KIND_META[m.kind as keyof typeof MEMORY_KIND_META] ?? { label: m.kind, emoji: "📝", cls: "bg-muted text-muted-foreground" };
                    return (
                      <div key={m.id} className="rounded-md border border-border p-2.5">
                        <div className="mb-1 flex items-center gap-1.5">
                          <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", meta.cls)}>{meta.emoji} {meta.label}</span>
                          {m.is_pinned && <Pin className="h-3 w-3 text-amber-500" />}
                          {m.author_agent && <span className="text-[10px] text-muted-foreground">by {name(m.author_agent)}</span>}
                          <span className="ml-auto text-[10px] text-muted-foreground">{relativeDate(m.created_at)}</span>
                        </div>
                        <p className="text-xs leading-relaxed">{m.content}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* A2A live feed — full width */}
          <Card className="lg:col-span-2 lg:col-start-1">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm"><MessagesSquare className="h-4 w-4" /> Agent-to-agent feed</CardTitle>
            </CardHeader>
            <CardContent>
              {(feed ?? []).length === 0 ? (
                <p className="py-8 text-center text-xs text-muted-foreground">No agent messages yet. When an agent messages or delegates to a teammate, it appears here live.</p>
              ) : (
                <div className="space-y-1.5">
                  {(feed ?? []).map((m) => (
                    <div key={m.id} className="flex items-start gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
                      <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="font-medium">{name(m.from_agent)}</span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          <span className="font-medium">{name(m.to_agent)}</span>
                          <StatusDot status={m.status} />
                          <span className="ml-auto text-[10px] text-muted-foreground">{relativeDate(m.created_at)}</span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{m.content}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: A2AMessage["status"] }) {
  const map = {
    pending: { cls: "bg-amber-400", label: "pending" },
    processing: { cls: "bg-sky-400 animate-pulse", label: "reacting" },
    answered: { cls: "bg-emerald-500", label: "answered" },
    ignored: { cls: "bg-muted-foreground/40", label: "ignored" },
  }[status];
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
      <span className={cn("h-1.5 w-1.5 rounded-full", map.cls)} /> {map.label}
    </span>
  );
}

// ── Infinite dotted canvas (React Flow): agents as nodes, A2A threads as edges.
type EcoAgent = { id: string; name: string; avatar_emoji: string | null; accent_color: string | null; role: string | null; skills: string[] };

// Custom node renderer for an agent.
function AgentNode({ data }: NodeProps<{ agent: EcoAgent; onOpen: (id: string) => void }>) {
  const a = data.agent;
  const color = a.accent_color ?? "#2F2FE4";
  return (
    <button
      onClick={() => data.onOpen(a.id)}
      className="group flex w-44 flex-col items-center rounded-xl border bg-card px-3 py-3 shadow-sm transition-colors hover:border-foreground/40"
      style={{ borderColor: color + "55" }}
    >
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !border-0" style={{ background: color }} />
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !border-0" style={{ background: color }} />
      <div
        className="flex h-11 w-11 items-center justify-center rounded-full text-xl"
        style={{ backgroundColor: color + "22", border: `1.5px solid ${color}` }}
      >
        {a.avatar_emoji ?? "🤖"}
      </div>
      <div className="mt-2 max-w-full truncate text-sm font-medium">{a.name}</div>
      {a.role && <div className="max-w-full truncate text-[10px] text-muted-foreground">{a.role}</div>}
      {a.skills?.length > 0 && (
        <div className="mt-1.5 flex flex-wrap justify-center gap-1">
          {a.skills.slice(0, 3).map((s) => (
            <span key={s} className="rounded-full bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">{s}</span>
          ))}
        </div>
      )}
    </button>
  );
}

const NODE_TYPES = { agent: AgentNode };

function NetworkGraph({
  agents, threads, onOpen,
}: { agents: EcoAgent[]; threads: A2AThread[]; onOpen: (id: string) => void }) {
  // Lay the agents out with dagre so connected agents sit near each other; falls
  // back to a grid when there are no edges.
  const { nodes, edges } = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "TB", nodesep: 70, ranksep: 90, marginx: 40, marginy: 40 });
    g.setDefaultEdgeLabel(() => ({}));
    const W = 176, H = 110;
    agents.forEach((a) => g.setNode(a.id, { width: W, height: H }));
    threads.forEach((t) => { if (t.agent_a && t.agent_b) g.setEdge(t.agent_a, t.agent_b); });
    dagre.layout(g);

    const nodes: Node[] = agents.map((a, i) => {
      const gn = g.node(a.id);
      const x = gn ? gn.x - W / 2 : (i % 4) * (W + 60) + 40;
      const y = gn ? gn.y - H / 2 : Math.floor(i / 4) * (H + 60) + 40;
      return { id: a.id, type: "agent", position: { x, y }, data: { agent: a, onOpen } };
    });
    const edges: Edge[] = threads
      .filter((t) => t.agent_a && t.agent_b)
      .map((t) => ({
        id: t.id, source: t.agent_a, target: t.agent_b,
        animated: true, style: { stroke: "hsl(var(--primary))", strokeWidth: 1.5 },
        label: t.topic ?? undefined,
        labelStyle: { fontSize: 10, fill: "hsl(var(--muted-foreground))" },
        labelBgStyle: { fill: "hsl(var(--background))" },
      }));
    return { nodes, edges };
  }, [agents, threads, onOpen]);

  return (
    <div className="h-[560px] w-full overflow-hidden rounded-lg border border-border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        maxZoom={1.75}
        nodesDraggable
        panOnScroll
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} color="hsl(var(--border))" />
        <Controls showInteractive={false} className="!border-border" />
        <MiniMap pannable zoomable nodeColor={(n) => ((n.data as any)?.agent?.accent_color ?? "#2F2FE4")} className="!bg-card" />
      </ReactFlow>
    </div>
  );
}
