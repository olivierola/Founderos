import { useMemo } from "react";
import ReactFlow, { Background, BackgroundVariant, Handle, Position, type Node, type Edge, type NodeProps } from "reactflow";
import "reactflow/dist/style.css";
import dagre from "dagre";
import { AgentIdentity } from "@/components/AgentIdentity";
import { cn } from "@/lib/utils";

type GraphAgent = { id: string; name: string; is_orchestrator?: boolean; accent_color?: string | null; avatar_url?: string | null };

// "Pending input" pill under an agent node — the only status this graph
// currently distinguishes (sourced from internal_agent_approvals, status =
// 'pending'). Idle agents show nothing, matching the reference screenshot.
function StatusPill({ pending }: { pending: boolean }) {
  if (!pending) return null;
  return (
    <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Pending input
    </span>
  );
}

function YouNode() {
  return (
    <div className="flex w-32 flex-col items-center">
      <Handle type="source" position={Position.Bottom} className="!h-1 !w-1 !border-0 !bg-transparent" />
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-500/15 text-xs font-semibold text-violet-600">Vous</span>
      <div className="mt-1 max-w-full truncate text-sm font-medium">Vous</div>
    </div>
  );
}

function RoomAgentNode({ data }: NodeProps<{ agent: GraphAgent; pending: boolean }>) {
  const a = data.agent;
  return (
    <div className="flex w-36 flex-col items-center">
      <Handle type="target" position={Position.Top} className="!h-1 !w-1 !border-0 !bg-transparent" />
      <AgentIdentity url={a.avatar_url} seed={a.name} size={40} rounded="rounded-full" />
      <div className={cn("mt-1 max-w-full truncate text-sm font-medium", a.is_orchestrator && "text-indigo-500")}>{a.name}</div>
      <StatusPill pending={data.pending} />
    </div>
  );
}

const NODE_TYPES = { you: YouNode, agent: RoomAgentNode };

/**
 * "General" tab of a Room's right panel — a small, self-contained graph: a
 * fixed "You" node connected to each participant agent, with a "Pending
 * input" pill when the agent has an open approval request. No data-fetching
 * here; the parent (RoomPanel) supplies participants + pending agent ids.
 */
export function RoomGraph({ participants, pendingAgentIds }: { participants: GraphAgent[]; pendingAgentIds: string[] }) {
  const { nodes, edges } = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "TB", nodesep: 50, ranksep: 80, marginx: 30, marginy: 30 });
    g.setDefaultEdgeLabel(() => ({}));
    const W = 144, H = 90;
    g.setNode("you", { width: 128, height: 80 });
    participants.forEach((a) => g.setNode(a.id, { width: W, height: H }));
    participants.forEach((a) => g.setEdge("you", a.id));
    dagre.layout(g);

    const youNode = g.node("you");
    const nodes: Node[] = [
      { id: "you", type: "you", position: { x: youNode.x - 64, y: youNode.y - 40 }, data: {} },
      ...participants.map((a) => {
        const gn = g.node(a.id);
        return {
          id: a.id, type: "agent",
          position: { x: gn.x - W / 2, y: gn.y - H / 2 },
          data: { agent: a, pending: pendingAgentIds.includes(a.id) },
        };
      }),
    ];
    const edges: Edge[] = participants.map((a) => ({
      id: `you-${a.id}`, source: "you", target: a.id,
      style: { stroke: "hsl(var(--border))", strokeWidth: 1.5 },
    }));
    return { nodes, edges };
  }, [participants, pendingAgentIds]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.5}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnScroll
        zoomOnScroll={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} className="opacity-40" />
      </ReactFlow>
    </div>
  );
}
