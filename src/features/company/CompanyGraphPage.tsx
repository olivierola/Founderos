// Le graphe d'entreprise — la carte, DÉRIVÉE des données réelles (vues 0214).
//
// Ce que cet écran n'est pas : un tableau blanc. L'ancien AssetMap laissait un
// humain poser des nœuds et tracer des liens à la main ; il finissait faux dès
// la semaine suivante, et il n'était plus routé nulle part. Ici rien n'est
// dessiné : chaque nœud est une ligne réelle, chaque arête est une clé
// étrangère. Créez un agent, il apparaît ; archivez-le, il disparaît.
//
// La mise en page est une hiérarchie (dagre, gauche → droite) et pas un nuage
// de forces : l'entreprise EST une hiérarchie — entreprise → services →
// agents → rooms/missions → livrables — et une disposition qui bouge à chaque
// ouverture empêche d'apprendre la carte. Les mêmes données donnent toujours
// le même dessin.
//
// Le filtre par type est ce qui rend la carte lisible : tout afficher d'un coup
// sur une entreprise réelle produit un mur. On ouvre donc sur la structure
// (objectifs, services, agents) et on déplie le travail à la demande.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactFlow, {
  Background, BackgroundVariant, Controls, MiniMap, Handle, Position, ReactFlowProvider,
  type Node, type Edge, type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "dagre";
import {
  BuildingsIcon as Building2,
  TargetIcon as Target,
  RobotIcon as Bot,
  ChatsIcon as MessagesSquare,
  ListChecksIcon as ListChecks,
  FileTextIcon as FileText,
  PlugIcon as Plug,
  BooksIcon as Library,
  CubeIcon as Boxes,
  GraphIcon as Network,
  MagnifyingGlassIcon as Search,
  type Icon as LucideIcon,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { fetchCompanyGraph, type GraphKind, type GraphNode } from "./model";

// ── Vocabulaire visuel ──────────────────────────────────────────────────────
// Une couleur par TYPE d'objet, jamais par instance : la carte doit se lire
// sans légende après deux visites. Les teintes reprennent celles déjà portées
// par ces objets ailleurs dans le produit (agents fuchsia, outils rose,
// connaissances violet) pour qu'on ne réapprenne rien.
const KIND: Record<GraphKind, { label: string; icon: LucideIcon; color: string }> = {
  company: { label: "Entreprise", icon: Building2, color: "#6366f1" },
  objective: { label: "Objectifs", icon: Target, color: "#f59e0b" },
  service: { label: "Services", icon: Boxes, color: "#0ea5e9" },
  agent: { label: "Agents", icon: Bot, color: "#d946ef" },
  room: { label: "Rooms", icon: MessagesSquare, color: "#8b5cf6" },
  mission: { label: "Missions", icon: ListChecks, color: "#3b82f6" },
  deliverable: { label: "Livrables", icon: FileText, color: "#10b981" },
  connector: { label: "Outils", icon: Plug, color: "#ec4899" },
  collection: { label: "Connaissances", icon: Library, color: "#a855f7" },
  asset: { label: "Ressources", icon: Network, color: "#64748b" },
};

/** Ce qu'on montre à l'ouverture : la STRUCTURE. Le travail produit (missions,
 *  livrables, rooms) se déplie ensuite — sinon la première impression est un
 *  mur de rectangles verts. */
const DEFAULT_KINDS: GraphKind[] = ["company", "objective", "service", "agent"];

const RELATION_LABEL: Record<string, string> = {
  objective: "objectif", sub_objective: "découle de", owned_by: "porté par",
  assigned_to: "responsable", service: "service", member: "membre",
  reports_to: "rend compte à", room: "room", participates: "participe",
  runs: "exécute", produced: "produit", connected: "connecté", reads: "lit", holds: "détient",
};

function GraphCard({ data, selected }: NodeProps) {
  const def = KIND[data.kind as GraphKind] ?? KIND.asset;
  const Icon = def.icon;
  return (
    <div
      className={cn(
        "min-w-[150px] max-w-[230px] rounded-xl border bg-card px-3 py-2 shadow-sm transition-colors",
        selected ? "border-primary ring-2 ring-primary/25" : "border-border/70",
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-muted-foreground" />
      <div className="flex items-center gap-2">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
          style={{ background: `${def.color}1f`, color: def.color }}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium leading-tight">{data.label || "Sans nom"}</div>
          <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{def.label}</div>
        </div>
      </div>
      {data.sublabel && (
        <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{data.sublabel}</div>
      )}
      {data.status && (
        <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: def.color }} />
          {data.status}
        </div>
      )}
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-primary" />
    </div>
  );
}

const nodeTypes = { graph: GraphCard };

/** Disposition hiérarchique, déterministe. Deux ouvertures de la même
 *  entreprise donnent le même dessin — c'est ce qui permet de la mémoriser. */
function layout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", ranksep: 90, nodesep: 24, marginx: 20, marginy: 20 });
  for (const n of nodes) g.setNode(n.id, { width: 230, height: 74 });
  for (const e of edges) if (e.source !== e.target) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p ? p.x - 115 : 0, y: p ? p.y - 37 : 0 } };
  });
}

function Canvas({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      fitView minZoom={0.1} maxZoom={1.6}
      nodesDraggable nodesConnectable={false} elementsSelectable
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="opacity-40" />
      <Controls showInteractive={false} />
      <MiniMap
        pannable zoomable
        nodeColor={(n) => KIND[(n.data?.kind as GraphKind) ?? "asset"]?.color ?? "#64748b"}
        className="!bg-card"
      />
    </ReactFlow>
  );
}

export function CompanyGraphPage() {
  const { projectId } = useCurrentContext();
  const [kinds, setKinds] = useState<Set<GraphKind>>(new Set(DEFAULT_KINDS));
  const [q, setQ] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["company_graph", projectId],
    enabled: !!projectId,
    queryFn: () => fetchCompanyGraph(projectId!),
    // La carte est dérivée : elle ne peut pas dériver, mais elle change dès
    // qu'un agent produit quelque chose. Une minute de fraîcheur suffit.
    staleTime: 60_000,
  });

  const counts = useMemo(() => {
    const c: Partial<Record<GraphKind, number>> = {};
    for (const n of data?.nodes ?? []) c[n.kind] = (c[n.kind] ?? 0) + 1;
    return c;
  }, [data]);

  const { nodes, edges, hiddenByFilter } = useMemo(() => {
    const all = data?.nodes ?? [];
    const needle = q.trim().toLowerCase();
    const visible = all.filter((n) =>
      kinds.has(n.kind) &&
      (!needle || `${n.label ?? ""} ${n.sublabel ?? ""}`.toLowerCase().includes(needle)));
    const ids = new Set(visible.map((n) => n.id));

    const rfNodes: Node[] = visible.map((n: GraphNode) => ({
      id: n.id, type: "graph", position: { x: 0, y: 0 },
      data: { kind: n.kind, label: n.label, sublabel: n.sublabel, status: n.status },
    }));
    const rfEdges: Edge[] = (data?.edges ?? [])
      .filter((e) => ids.has(e.source_id) && ids.has(e.target_id))
      .map((e, i) => ({
        id: `e${i}`, source: e.source_id, target: e.target_id,
        label: RELATION_LABEL[e.relation] ?? e.relation,
        labelStyle: { fontSize: 9, fill: "hsl(var(--muted-foreground))" },
        labelBgStyle: { fill: "hsl(var(--background))" },
        style: { stroke: "hsl(var(--border))", strokeWidth: 1.2 },
      }));

    return { nodes: layout(rfNodes, rfEdges), edges: rfEdges, hiddenByFilter: all.length - visible.length };
  }, [data, kinds, q]);

  const toggle = (k: GraphKind) => {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col px-6 py-6">
      <PageHeader
        title="Carte de l'entreprise"
        description="Qui fait quoi, avec quels outils, pour quels objectifs. Dérivée des données réelles — rien n'est dessiné à la main."
      />

      <Card className="mb-3 flex flex-wrap items-center gap-2 p-2.5">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Chercher un agent, un service, un outil…"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(Object.keys(KIND) as GraphKind[]).map((k) => {
            const on = kinds.has(k);
            const n = counts[k] ?? 0;
            const def = KIND[k];
            return (
              <button
                key={k}
                onClick={() => toggle(k)}
                disabled={n === 0}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                  n === 0 && "cursor-not-allowed opacity-40",
                  on ? "border-transparent text-white" : "border-border text-muted-foreground hover:bg-muted",
                )}
                style={on ? { background: def.color } : undefined}
              >
                <span className={cn("h-1.5 w-1.5 rounded-full", on && "bg-white/80")} style={on ? undefined : { background: def.color }} />
                {def.label}
                <span className="tabular-nums opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
      </Card>

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border/70 bg-muted/20">
        {isLoading ? (
          <Skeleton className="h-full w-full" />
        ) : nodes.length === 0 ? (
          <div className="p-8">
            <EmptyState
              icon={Network}
              title={hiddenByFilter > 0 ? "Rien ne correspond" : "La carte est vide"}
              description={
                hiddenByFilter > 0
                  ? `${hiddenByFilter} objets sont masqués par le filtre ou la recherche. Élargissez la sélection au-dessus.`
                  : "Créez un service et un agent : la carte se construit toute seule à partir de ce qui existe réellement."
              }
            />
          </div>
        ) : (
          <ReactFlowProvider>
            <Canvas nodes={nodes} edges={edges} />
          </ReactFlowProvider>
        )}
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        {nodes.length} objets affichés{hiddenByFilter > 0 ? ` · ${hiddenByFilter} masqués` : ""} ·
        {" "}Vos agents interrogent cette même carte avec l'outil <code className="rounded bg-muted px-1">explore_company_graph</code> — ce que vous voyez, ils le savent.
      </p>
    </div>
  );
}
