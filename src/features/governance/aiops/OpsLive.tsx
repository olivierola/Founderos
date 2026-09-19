import { useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background, BackgroundVariant, Controls, Handle, Position, ReactFlowProvider,
  useNodesState, useEdgesState, useReactFlow,
  type Node, type Edge, type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import {
  UsersIcon as Users,
  ClockIcon as Clock,
  WebhooksLogoIcon as Webhook,
  CloudIcon as Cloud,
  HardDrivesIcon as Server,
  DatabaseIcon as Database,
} from "@phosphor-icons/react";
import { PulseIcon } from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { Pill } from "../ui";
import { AgentAvatar } from "@/features/internal-agents/AvatarPicker";
import { DetailSheet, DetailSection, DetailRow } from "./DetailSheet";
import {
  modelById, usd,
  SERVER_STATUS_META, HOSTING_META, type PrivateServer, type Deployment,
} from "./data";
import { useServersDb, useAgentDeploymentsDb } from "./db";

// ── Custom nodes ─────────────────────────────────────────────────────────────
function SourceNode({ data }: NodeProps) {
  const Icon = data.icon === "cron" ? Clock : data.icon === "webhook" ? Webhook : Users;
  return (
    <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs shadow-sm">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <span>{data.label}</span>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !bg-muted-foreground" />
    </div>
  );
}

function AgentNode({ data }: NodeProps) {
  return (
    <div className="w-[170px] rounded-lg border border-border bg-card px-3 py-2 shadow-sm">
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !bg-muted-foreground" />
      <div className="flex items-center gap-2">
        <AgentAvatar url={data.avatarUrl} seed={data.label} className="h-7 w-7 shrink-0 overflow-hidden rounded-md" />
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">{data.label}</div>
          <div className="truncate text-[10px] text-muted-foreground">{data.sub}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !bg-[hsl(var(--accent-teal))]" />
    </div>
  );
}

function BackendNode({ data }: NodeProps) {
  const cloud = data.kind === "cloud";
  return (
    <div className={cn(
      "w-[190px] rounded-lg border bg-card px-3 py-2 shadow-sm",
      cloud ? "border-[hsl(var(--accent-teal)/0.5)]" : "border-violet-500/40",
    )}>
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !bg-muted-foreground" />
      <div className="flex items-center gap-2">
        <span className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
          cloud ? "bg-[hsl(var(--accent-teal)/0.14)] text-[hsl(var(--accent-teal))]" : "bg-violet-500/10 text-violet-500",
        )}>
          {cloud ? <Cloud className="h-4 w-4" /> : <Server className="h-4 w-4" />}
        </span>
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">{data.label}</div>
          <div className="truncate text-[10px] text-muted-foreground">{data.sub}</div>
        </div>
      </div>
      {typeof data.gpuPct === "number" && (
        <div className="mt-2">
          <div className="mb-0.5 flex justify-between text-[9px] text-muted-foreground"><span>GPU</span><span className="tabular-nums">{data.gpuPct}%</span></div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div className={cn("h-full rounded-full transition-all duration-700", data.gpuPct >= 85 ? "bg-red-500" : data.gpuPct >= 60 ? "bg-amber-500" : "bg-violet-500")} style={{ width: `${data.gpuPct}%` }} />
          </div>
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !bg-muted-foreground" />
    </div>
  );
}

function StoreNode({ data }: NodeProps) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs shadow-sm">
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !bg-muted-foreground" />
      <Database className="h-3.5 w-3.5 text-cyan-500" />
      <span>{data.label}</span>
    </div>
  );
}

const NODE_TYPES = { source: SourceNode, agent: AgentNode, backend: BackendNode, store: StoreNode };

// What the detail sheet shows when a node is clicked.
type LiveSel =
  | { kind: "server"; server: PrivateServer }
  | { kind: "agent"; name: string; deployment?: Deployment }
  | { kind: "cloud"; modelId: string };

// ── Inner canvas (needs the ReactFlow provider around it) ────────────────────
function LiveCanvas({ onSelect }: { onSelect: (s: LiveSel) => void }) {
  const { projectId } = useCurrentContext();
  const { servers } = useServersDb();
  const { deployments: dbDeployments, agents, hasAgents } = useAgentDeploymentsDb(servers);
  const roster = useMemo(() => (agents ?? []).slice(0, 5), [agents]);
  // Real agents → real deployments only.
  const deployments = useMemo(() => (hasAgents ? dbDeployments : []), [hasAgents, dbDeployments]);

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const { fitView } = useReactFlow();
  const built = useRef("");

  // Build the graph once per data signature (agents/servers/deployments).
  useEffect(() => {
    const sig = `${projectId}|${roster.map((a) => a.id).join(",")}|${servers.length}|${deployments.length}`;
    if (!projectId || deployments.length === 0 || built.current === sig) return;
    built.current = sig;

    const ns: Node[] = [];
    const es: Edge[] = [];
    const usedCloudModels = [...new Set(deployments.filter((d) => d.target === "cloud").map((d) => d.model))];

    const sources = [
      { id: "src_users", label: "Utilisateurs", icon: "users" },
      { id: "src_cron", label: "Scheduler", icon: "cron" },
      { id: "src_hooks", label: "Webhooks", icon: "webhook" },
    ];
    sources.forEach((s, i) => ns.push({ id: s.id, type: "source", position: { x: 0, y: 60 + i * 90 }, data: s }));

    roster.forEach((a, i) => {
      const d = deployments.find((x) => x.agentId === a.id);
      ns.push({
        id: `ag_${a.id}`, type: "agent", position: { x: 260, y: 10 + i * 92 },
        data: { label: a.name, avatarUrl: a.avatar_url, sub: modelById(d?.model ?? "")?.label ?? "—" },
      });
      const src = sources[i % sources.length];
      es.push({
        id: `e_${src.id}_${a.id}`, source: src.id, target: `ag_${a.id}`, animated: true,
        style: { stroke: "hsl(var(--muted-foreground) / 0.45)", strokeWidth: 1.2 },
      });
    });

    usedCloudModels.forEach((mId, i) => {
      const m = modelById(mId);
      ns.push({ id: `cl_${mId}`, type: "backend", position: { x: 560, y: 10 + i * 96 }, data: { kind: "cloud", label: m?.label ?? mId, sub: `${m?.vendor} · API`, modelId: mId } });
    });
    servers.forEach((s, i) => {
      ns.push({
        id: s.id, type: "backend", position: { x: 560, y: 10 + (usedCloudModels.length + i) * 96 },
        data: { kind: "server", label: s.name, sub: s.gpu, gpuPct: s.gpuPct, serverId: s.id },
      });
    });

    deployments.forEach((d) => {
      const targetId = d.target === "cloud" ? `cl_${d.model}` : d.target;
      const cloud = d.target === "cloud";
      es.push({
        id: `e_ag_${d.agentId}`, source: `ag_${d.agentId}`, target: targetId, animated: true,
        label: "— req/min",
        labelStyle: { fontSize: 9, fill: "hsl(var(--muted-foreground))" },
        labelBgStyle: { fill: "hsl(var(--card))", fillOpacity: 0.9 },
        style: { stroke: cloud ? "hsl(var(--accent-teal))" : "hsl(263 70% 58%)", strokeWidth: 1.4 },
      });
    });

    const stores = [
      { id: "st_pg", label: "Postgres · prod" },
      { id: "st_vec", label: "pgvector · mémoire" },
      { id: "st_logs", label: "Logs & traces" },
    ];
    stores.forEach((s, i) => ns.push({ id: s.id, type: "store", position: { x: 880, y: 70 + i * 80 }, data: s }));
    [...usedCloudModels.map((m) => `cl_${m}`), ...servers.map((s) => s.id)].forEach((b, i) => {
      es.push({
        id: `e_${b}_store`, source: b, target: stores[i % stores.length].id, animated: true,
        style: { stroke: "hsl(190 70% 45% / 0.5)", strokeWidth: 1.1, strokeDasharray: "4 3" },
      });
    });

    setNodes(ns);
    setEdges(es);
    // Fit once the store has picked the new nodes up.
    requestAnimationFrame(() => fitView({ padding: 0.15 }));
  }, [projectId, roster, servers, deployments, setNodes, setEdges, fitView]);

  // Live tick — mutate ONLY edge labels + server GPU data, positions untouched
  // (so user drags survive each pulse).
  useEffect(() => {
    const t = setInterval(() => {
      setEdges((eds) => eds.map((e) => {
        if (!e.id.startsWith("e_ag_")) return e;
        const prev = parseInt(String(e.label ?? "").replace(/\D/g, ""), 10) || 4 + Math.random() * 40;
        const rate = Math.max(1, Math.round(prev + (Math.random() - 0.5) * 8));
        return { ...e, label: `${rate} req/min` };
      }));
      setNodes((nds) => nds.map((n) => {
        if (n.type !== "backend" || n.data.kind !== "server") return n;
        const cur = typeof n.data.gpuPct === "number" ? n.data.gpuPct : 40;
        const gpuPct = Math.min(99, Math.max(5, Math.round(cur + (Math.random() - 0.5) * 9)));
        return { ...n, data: { ...n.data, gpuPct } };
      }));
    }, 1600);
    return () => clearInterval(t);
  }, [setEdges, setNodes]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={NODE_TYPES}
      onNodeClick={(_, node) => {
        if (node.type === "backend" && node.data.kind === "server") {
          const server = servers.find((s) => s.id === node.data.serverId);
          if (server) onSelect({ kind: "server", server: { ...server, gpuPct: node.data.gpuPct ?? server.gpuPct } });
        } else if (node.type === "backend" && node.data.kind === "cloud") {
          onSelect({ kind: "cloud", modelId: node.data.modelId });
        } else if (node.type === "agent") {
          const agentId = node.id.slice(3);
          onSelect({ kind: "agent", name: node.data.label, deployment: deployments.find((d) => d.agentId === agentId) });
        }
      }}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      nodesConnectable={false}
      deleteKeyCode={null}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="hsl(var(--border))" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export function GovOpsLivePage() {
  const [sel, setSel] = useState<LiveSel | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Temps réel"
        description="Topologie vivante de votre workforce : sources de trafic, agents, backends de modèles (cloud et propriétaires) et flux de données. Cliquez un nœud pour le détail."
      />

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><PulseIcon weight="duotone" className="h-4 w-4 text-[hsl(var(--accent-teal))]" /> mise à jour toutes les ~2 s</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-5 rounded bg-[hsl(var(--accent-teal))]" /> requêtes → API cloud</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-5 rounded bg-violet-500" /> requêtes → serveur privé</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-5 rounded border-b border-dashed border-cyan-500" /> flux de données</span>
      </div>

      <Card className="h-[600px] overflow-hidden p-0">
        <ReactFlowProvider>
          <LiveCanvas onSelect={setSel} />
        </ReactFlowProvider>
      </Card>

      {sel?.kind === "server" && (
        <DetailSheet onClose={() => setSel(null)} title={sel.server.name} subtitle={sel.server.region}>
          <DetailSection title="Serveur">
            <DetailRow label="Statut"><Pill meta={SERVER_STATUS_META[sel.server.status]} /></DetailRow>
            <DetailRow label="GPU">{sel.server.gpu}</DetailRow>
            <DetailRow label="Charge GPU">{sel.server.gpuPct}%</DetailRow>
            <DetailRow label="CPU / RAM">{sel.server.cpuPct}% · {sel.server.ramPct}%</DetailRow>
            <DetailRow label="Requêtes">{sel.server.reqPerMin} req/min</DetailRow>
            <DetailRow label="Uptime 30 j">{sel.server.uptimePct}%</DetailRow>
            <DetailRow label="Coût">{usd(sel.server.costPerDay)} / jour</DetailRow>
          </DetailSection>
          <DetailSection title="Modèles installés">
            <div className="flex flex-wrap gap-1">
              {sel.server.installedModels.map((id) => {
                const m = modelById(id);
                return <span key={id} className="rounded bg-violet-500/10 px-1.5 py-0.5 text-[11px] text-violet-600 dark:text-violet-400">{m?.label ?? id}</span>;
              })}
            </div>
          </DetailSection>
        </DetailSheet>
      )}

      {sel?.kind === "cloud" && (() => { const m = modelById(sel.modelId); return m ? (
        <DetailSheet onClose={() => setSel(null)} title={m.label} subtitle={`${m.vendor} · ${m.family}`}>
          <DetailSection title="Modèle">
            <DetailRow label="Hébergement"><Pill meta={HOSTING_META[m.hosting]} /></DetailRow>
            <DetailRow label="Contexte">{m.ctx}</DetailRow>
            {m.price && <DetailRow label="Prix">{m.price} / Mtok</DetailRow>}
          </DetailSection>
        </DetailSheet>
      ) : null; })()}

      {sel?.kind === "agent" && (
        <DetailSheet onClose={() => setSel(null)} title={sel.name} subtitle="Agent">
          <DetailSection title="Déploiement">
            {sel.deployment ? (
              <>
                <DetailRow label="Cible">{sel.deployment.target === "cloud" ? "API cloud" : sel.deployment.target}</DetailRow>
                <DetailRow label="Modèle">{modelById(sel.deployment.model)?.label ?? sel.deployment.model}</DetailRow>
                <DetailRow label="Environnement">{sel.deployment.env}</DetailRow>
              </>
            ) : <p className="text-xs text-muted-foreground">Aucun déploiement trouvé.</p>}
          </DetailSection>
        </DetailSheet>
      )}
    </div>
  );
}
