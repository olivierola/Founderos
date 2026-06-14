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
  Loader2, Network, MessagesSquare, Brain, ArrowRight, Pin, Bot, ChevronDown,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import {
  type InternalAgent, type A2AMessage, type A2AThread, type TeamMemory,
  MEMORY_KIND_META,
} from "./shared";
import { relativeDate } from "./shared";
import { Robot3D } from "./Robot3D";

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

  // Full-screen canvas with floating overlays for header + memory/feed panels.
  return (
    <div className="relative h-[calc(100vh-3.5rem)] w-full">
      {collaborating.length === 0 ? (
        <div className="flex h-full items-center justify-center">
          <EmptyState
            icon={Network}
            title="No collaborating agents yet"
            description="Create autonomous agents and enable collaboration on them — they'll be able to message, delegate and share knowledge here."
          />
        </div>
      ) : (
        <>
          {/* The canvas fills the whole area. */}
          <NetworkGraph
            agents={collaborating}
            threads={threads ?? []}
            onOpen={(id) => navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal/${id}/chat`)}
          />

          {/* Floating title (top-left). */}
          <div className="pointer-events-none absolute left-4 top-4 z-10 flex items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-1.5 shadow-sm backdrop-blur">
            <Network className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">Agent ecosystem</span>
            <span className="text-xs text-muted-foreground">· {collaborating.length} agents</span>
          </div>

          {/* Floating dropdown panels (top-right). */}
          <div className="absolute right-4 top-4 z-10 flex gap-2">
            <FloatingPanel
              icon={<Brain className="h-4 w-4" />}
              label="Team memory"
              count={(teamMem ?? []).length}
            >
              {(teamMem ?? []).length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">No shared knowledge yet.</p>
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
            </FloatingPanel>

            <FloatingPanel
              icon={<MessagesSquare className="h-4 w-4" />}
              label="A2A feed"
              count={(feed ?? []).length}
            >
              {(feed ?? []).length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">No agent messages yet.</p>
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
            </FloatingPanel>
          </div>
        </>
      )}
    </div>
  );
}

// A floating dropdown: a pill button that toggles a scrollable panel below it.
function FloatingPanel({
  icon, label, count, children,
}: { icon: React.ReactNode; label: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm shadow-sm backdrop-blur transition-colors",
          open ? "border-primary/50 bg-background text-foreground" : "border-border bg-background/80 text-muted-foreground hover:text-foreground",
        )}
      >
        {icon}
        <span className="font-medium">{label}</span>
        <span className="rounded-full bg-secondary px-1.5 text-[10px] tabular-nums">{count}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+0.5rem)] max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-border bg-background/95 p-2 shadow-xl backdrop-blur">
          {children}
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
  // No card/border — just the floating 3D robot + name. A div (not a button)
  // so React Flow dragging is unobstructed. Double-click (or the hover "Open
  // chat" button) opens the agent.
  return (
    <div
      onDoubleClick={() => data.onOpen(a.id)}
      className="group flex w-40 cursor-grab flex-col items-center active:cursor-grabbing"
    >
      <Handle type="target" position={Position.Top} className="!h-1 !w-1 !border-0 !bg-transparent" />
      <Handle type="source" position={Position.Bottom} className="!h-1 !w-1 !border-0 !bg-transparent" />
      <Robot3D color={color} size={64} />
      <div className="mt-1 max-w-full truncate text-sm font-medium drop-shadow-sm">{a.name}</div>
      {a.role && <div className="max-w-full truncate text-[10px] text-muted-foreground">{a.role}</div>}
      {/* Open affordance — appears on hover only, doesn't conflict with drag. */}
      <button
        onClick={(e) => { e.stopPropagation(); data.onOpen(a.id); }}
        className="nodrag mt-1.5 rounded-full border border-border bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground group-hover:opacity-100"
      >
        Open chat
      </button>
    </div>
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
    <div className="h-full w-full">
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
