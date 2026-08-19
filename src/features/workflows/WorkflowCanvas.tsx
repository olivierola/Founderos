import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactFlow, {
  Background, BackgroundVariant, Controls, MiniMap, Panel, ReactFlowProvider,
  applyNodeChanges, applyEdgeChanges, addEdge, MarkerType,
  type Node, type Edge, type Connection, type NodeChange, type EdgeChange,
} from "reactflow";
import "reactflow/dist/style.css";
import {
  ArrowLeft, Loader2, Check, Save, Plus, Trash2, X, Play, Square,
  FileText, LayoutGrid, Maximize2, PenLine, Library,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { useResizableWidth } from "@/hooks/useResizableWidth";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { BLOCKS, BLOCK_BY_KIND, BLOCK_NODE_TYPES, isBlockEmpty, blockColorClass } from "./nodes";
import { paramsOf, agentIdsOf, type InputParam } from "./context";
import { EventTriggers } from "./EventTriggers";
import { compileWorkflow, parseWorkflow } from "./compile";
import {
  fetchWorkflow, saveWorkflowContent, updateWorkflow, startRun, cancelRun,
  fetchLatestRun, syncSchedule,
  WORKFLOW_STATUS_META, contextSourceOf, contextBodyOf,
  type BlockKind, type ContextRef, type WorkflowGraph, type WorkflowStatus, type WorkflowRun,
} from "./model";

// The workflow editor. Two views on ONE procedure:
//   • Blocs   — the canvas, where order and branches are drawn
//   • Document — the compiled workflow.md, editable by hand
// Both write back into the same pair of columns, and every block is anchored in
// the markdown so an edit on either side maps onto the other without rebuilding
// the graph and losing its layout.

/** Display-only fields the canvas injects for rendering. They must never reach
 *  the database, or the graph would grow a copy of state it does not own. */
const STRIP = ["__empty", "__agentName"] as const;
function cleanGraph(nodes: Node[], edges: Edge[]): WorkflowGraph {
  return {
    nodes: nodes.map((n) => {
      const data = { ...(n.data ?? {}) } as Record<string, unknown>;
      for (const k of STRIP) delete data[k];
      return { id: n.id, type: n.type, position: n.position, data } as Node;
    }),
    edges: edges.map((e) => ({
      id: e.id, source: e.source, target: e.target,
      sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null,
    } as Edge)),
  };
}

/**
 * Drop blocks whose kind no longer exists.
 *
 * The first version of this canvas had a different vocabulary — Agent, Action,
 * Condition — and graphs saved then still carry those nodes. React Flow has no
 * renderer for them, so it falls back to its default node: a bare white box
 * that sits on the canvas looking like a block while compiling to nothing. The
 * only honest thing to do with a block the editor cannot open and the document
 * cannot express is to remove it, along with the edges that reached it.
 */
function dropUnknownBlocks(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[]; removed: number } {
  const kept = nodes.filter((n) => BLOCK_BY_KIND.has((n.type ?? "") as BlockKind));
  if (kept.length === nodes.length) return { nodes, edges, removed: 0 };
  const ids = new Set(kept.map((n) => n.id));
  return {
    nodes: kept,
    edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    removed: nodes.length - kept.length,
  };
}

export function WorkflowCanvas({ workflowId, onBack }: { workflowId: string; onBack: () => void }) {
  return (
    <ReactFlowProvider>
      <CanvasInner workflowId={workflowId} onBack={onBack} />
    </ReactFlowProvider>
  );
}

type View = "blocks" | "document";

function CanvasInner({ workflowId, onBack }: { workflowId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [doc, setDoc] = useState("");
  const [view, setView] = useState<View>("blocks");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const dirty = useRef(false);
  const loaded = useRef(false);
  /** True while the DOCUMENT is the side being edited — stops the compile
   *  effect from overwriting what is being typed. */
  const editingDoc = useRef(false);

  const { data: workflow, isLoading } = useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: () => fetchWorkflow(workflowId),
  });

  // Agents of the service, so a step can name its delegate; collections, so it
  // can name the knowledge to hand over with it.
  const { data: agents } = useQuery({
    queryKey: ["wf_agents", workflow?.service_dashboard_id],
    enabled: !!workflow?.service_dashboard_id,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents")
        .select("id, name")
        .eq("service_dashboard_id", workflow!.service_dashboard_id!)
        .eq("is_archived", false).eq("is_orchestrator", false);
      return (data ?? []) as Array<{ id: string; name: string }>;
    },
  });
  const agentName = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a.name])), [agents]);

  const { data: collections } = useQuery({
    queryKey: ["wf_collections", workflow?.project_id],
    enabled: !!workflow?.project_id,
    queryFn: async () => {
      const { data } = await supabase.from("rag_collections")
        .select("id, name").eq("project_id", workflow!.project_id).order("name");
      return (data ?? []) as Array<{ id: string; name: string }>;
    },
  });

  const { data: run } = useQuery({
    queryKey: ["workflow_run", workflowId],
    queryFn: () => fetchLatestRun(workflowId),
    refetchInterval: (q) => ((q.state.data as WorkflowRun | null | undefined)?.status === "running" ? 3000 : false),
  });

  // Hydrate once. Re-running on every refetch would stomp on edits in flight.
  useEffect(() => {
    if (!workflow || loaded.current) return;
    loaded.current = true;
    const hasBody = workflow.blocks.nodes.some((n) => n.type !== "trigger");
    // A workflow written by the assistant arrives as a DOCUMENT with only its
    // trigger in blocks — the round-trip parser lives here, not in the agent
    // runtime. Rebuilding the graph on first open is what makes an
    // assistant-authored procedure editable on the canvas like any other.
    if (!hasBody && workflow.document.trim()) {
      const parsed = parseWorkflow(workflow.document, workflow.blocks);
      setNodes(parsed.nodes);
      setEdges(parsed.edges);
      setDoc(workflow.document);
      dirty.current = true; // persist the derived graph
      return;
    }
    const clean = dropUnknownBlocks(workflow.blocks.nodes, workflow.blocks.edges);
    setNodes(clean.nodes);
    setEdges(clean.edges);
    setDoc(workflow.document || compileWorkflow(workflow, clean, agentName));
    // The purge has to be written back, or the ghosts return on every open.
    if (clean.removed) dirty.current = true;
  }, [workflow]);

  // Blocks changed → recompile the document. Skipped while the document itself
  // is the side being typed into, which is what keeps the round-trip stable.
  useEffect(() => {
    if (!loaded.current || !workflow || editingDoc.current) return;
    setDoc(compileWorkflow(workflow, cleanGraph(nodes, edges), agentName));
  }, [nodes, edges, workflow, agentName]);

  // Debounced persistence: one write per pause, not one per pointer move.
  useEffect(() => {
    if (!loaded.current || !dirty.current) return;
    const t = setTimeout(async () => {
      setSaving(true);
      try {
        await saveWorkflowContent(workflowId, cleanGraph(nodes, edges), doc);
        dirty.current = false;
        setSavedAt(Date.now());
      } finally { setSaving(false); }
    }, 800);
    return () => clearTimeout(t);
  }, [nodes, edges, doc, workflowId]);

  const markDirty = () => { dirty.current = true; };

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((n) => applyNodeChanges(changes, n));
    // A pure selection change is not an edit — marking it dirty would rewrite
    // the row every time someone clicks a block.
    if (changes.some((c) => c.type !== "select")) markDirty();
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((e) => applyEdgeChanges(changes, e));
    if (changes.some((c) => c.type !== "select")) markDirty();
  }, []);

  const onConnect = useCallback((c: Connection) => {
    setEdges((e) => addEdge({ ...c, markerEnd: { type: MarkerType.ArrowClosed } }, e));
    markDirty();
  }, []);

  function addBlock(kind: BlockKind) {
    const def = BLOCK_BY_KIND.get(kind)!;
    const lowest = nodes.reduce((max, n) => Math.max(max, n.position.y), 60);
    const id = `${kind}-${Math.random().toString(36).slice(2, 8)}`;
    // Chain it to the last block so a new one joins the procedure instead of
    // floating unlinked — an unlinked block lands at the end of the document,
    // which is almost never what was meant.
    const last = nodes.reduce<Node | null>((acc, n) => (!acc || n.position.y > acc.position.y ? n : acc), null);
    setNodes((n) => [...n, { id, type: kind, position: { x: 260, y: lowest + 150 }, data: { ...def.defaults } }]);
    if (last) setEdges((e) => addEdge({ source: last.id, target: id, sourceHandle: null, targetHandle: null }, e));
    setSelectedId(id);
    setPaletteOpen(false);
    markDirty();
  }

  function patchBlock(id: string, patch: Record<string, unknown>) {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    markDirty();
  }

  function removeBlock(id: string) {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setSelectedId(null);
    markDirty();
  }

  /** Markdown edited by hand → back into blocks. */
  function commitDocument(next: string) {
    setDoc(next);
    markDirty();
    const parsed = parseWorkflow(next, cleanGraph(nodes, edges));
    setNodes(parsed.nodes);
    setEdges(parsed.edges);
  }

  const displayNodes = useMemo(() => nodes.map((n) => {
    const d = (n.data ?? {}) as Record<string, unknown>;
    return {
      ...n,
      data: {
        ...d,
        __empty: isBlockEmpty((n.type ?? "step") as BlockKind, d),
        __agentName: d.agent_id ? agentName.get(String(d.agent_id)) : undefined,
      },
    };
  }), [nodes, agentName]);

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  if (isLoading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (!workflow) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Workflow introuvable.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CanvasHeader
        workflow={workflow}
        view={view} onView={setView}
        saving={saving} savedAt={savedAt}
        run={run ?? null}
        canRun={nodes.filter((n) => n.type !== "trigger").length > 0}
        onBack={onBack}
        onChanged={() => {
          qc.invalidateQueries({ queryKey: ["workflow", workflowId] });
          qc.invalidateQueries({ queryKey: ["workflow_run", workflowId] });
        }}
      />

      {view === "document" ? (
        <DocumentView
          value={doc}
          onChange={(v) => { editingDoc.current = true; commitDocument(v); }}
          onBlur={() => { editingDoc.current = false; }}
        />
      ) : (
        // Canvas and inspector are SIBLINGS, not stacked: a floating panel hid
        // the very blocks you edit against, and forced a fixed width on a form
        // whose main field is a procedure.
        <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <ReactFlow
            nodes={displayNodes}
            edges={edges}
            nodeTypes={BLOCK_NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => { setSelectedId(null); setPaletteOpen(false); }}
            fitView
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={["Backspace", "Delete"]}
            defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed } }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} className="!bg-background" />
            <Controls className="!bg-card !border-border" showInteractive={false} />
            <MiniMap className="!bg-card" pannable zoomable nodeColor={() => "hsl(var(--muted-foreground))"} />

            <Panel position="top-left" className="m-3">
              <div className="relative">
                <Button size="sm" onClick={() => setPaletteOpen((v) => !v)}>
                  <Plus className="mr-1.5 h-4 w-4" /> Ajouter un bloc
                </Button>
                {paletteOpen && (
                  <div className="absolute left-0 top-full mt-2 w-72 overflow-hidden rounded-xl border border-border bg-card shadow-xl">
                    {BLOCKS.filter((b) => b.kind !== "trigger").map((b) => (
                      <button
                        key={b.kind} type="button" onClick={() => addBlock(b.kind)}
                        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
                      >
                        <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border", blockColorClass(b.color))}>
                          <b.icon className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-1.5">
                            <span className="text-xs font-medium">{b.label}</span>
                            <span className="truncate font-mono text-[9px] text-muted-foreground">{b.compiles}</span>
                          </span>
                          <span className="block text-[11px] leading-snug text-muted-foreground">{b.hint}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Panel>

          </ReactFlow>
        </div>

        {selected && (
          <BlockInspector
            node={selected}
            agents={agents ?? []}
            collections={collections ?? []}
            workflowId={workflowId}
            workspaceId={workflow.workspace_id}
            projectId={workflow.project_id}
            onPatch={(p) => patchBlock(selected.id, p)}
            onRemove={() => removeBlock(selected.id)}
            onClose={() => setSelectedId(null)}
          />
        )}
        </div>
      )}
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

const RUN_META: Record<string, { label: string; tone: string }> = {
  running: { label: "Exécution en cours", tone: "text-sky-500" },
  succeeded: { label: "Dernier run réussi", tone: "text-emerald-500" },
  failed: { label: "Dernier run en échec", tone: "text-red-500" },
  cancelled: { label: "Dernier run annulé", tone: "text-muted-foreground" },
};

function CanvasHeader({ workflow, view, onView, saving, savedAt, run, canRun, onBack, onChanged }: {
  workflow: { id: string; name: string; status: WorkflowStatus };
  view: View; onView: (v: View) => void;
  saving: boolean; savedAt: number | null;
  run: WorkflowRun | null; canRun: boolean;
  onBack: () => void; onChanged: () => void;
}) {
  const [name, setName] = useState(workflow.name);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const meta = WORKFLOW_STATUS_META[workflow.status];
  const live = run?.status === "running";
  const runMeta = run ? RUN_META[run.status] : null;

  async function commitName() {
    setEditing(false);
    if (name.trim() && name.trim() !== workflow.name) {
      await updateWorkflow(workflow.id, { name: name.trim() });
      onChanged();
    } else setName(workflow.name);
  }

  async function toggleActive() {
    setBusy(true);
    try {
      await updateWorkflow(workflow.id, { status: workflow.status === "active" ? "paused" : "active" });
      // Activating arms the cron; pausing disarms it.
      await syncSchedule(workflow.id).catch(() => {});
      onChanged();
    } finally { setBusy(false); }
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 px-4">
      <button onClick={onBack} className="rounded-md p-1 text-muted-foreground hover:text-foreground" title="Retour">
        <ArrowLeft className="h-4 w-4" />
      </button>
      {editing ? (
        <Input
          value={name} autoFocus
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => { if (e.key === "Enter") void commitName(); if (e.key === "Escape") { setName(workflow.name); setEditing(false); } }}
          className="h-8 max-w-xs"
        />
      ) : (
        <button onClick={() => setEditing(true)} className="min-w-0 truncate text-sm font-semibold hover:underline" title="Renommer">
          {workflow.name}
        </button>
      )}
      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium", meta.tone)}>{meta.label}</span>

      <div className="ml-3 flex items-center rounded-lg bg-muted/60 p-0.5">
        <ViewTab active={view === "blocks"} onClick={() => onView("blocks")} icon={LayoutGrid} label="Blocs" />
        <ViewTab active={view === "document"} onClick={() => onView("document")} icon={FileText} label="Document" />
      </div>

      {runMeta && (
        <span className={cn("flex shrink-0 items-center gap-1 text-[11px]", runMeta.tone)}>
          {live && <Loader2 className="h-3 w-3 animate-spin" />} {runMeta.label}
        </span>
      )}

      <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {saving ? <><Loader2 className="h-3 w-3 animate-spin" /> Enregistrement…</>
          : savedAt && Date.now() - savedAt < 3000 ? <><Check className="h-3 w-3 text-emerald-500" /> Enregistré</>
          : <><Save className="h-3 w-3" /> Sauvegarde auto</>}
      </span>

      {live && run ? (
        <Button size="sm" variant="outline" disabled={busy}
          onClick={async () => { setBusy(true); try { await cancelRun(run.id); onChanged(); } finally { setBusy(false); } }}>
          <Square className="mr-1.5 h-3.5 w-3.5" /> Arrêter
        </Button>
      ) : (
        <Button size="sm" variant="outline" disabled={busy || !canRun}
          title={canRun ? "Exécuter la procédure maintenant" : "Ajoutez au moins un bloc"}
          onClick={async () => {
            setBusy(true);
            try { await startRun(workflow.id); onChanged(); }
            catch (e) { alert(e instanceof Error ? e.message : "Lancement impossible"); }
            finally { setBusy(false); }
          }}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />} Lancer
        </Button>
      )}
      <Button size="sm" variant={workflow.status === "active" ? "ghost" : "default"} disabled={busy} onClick={toggleActive}>
        {workflow.status === "active" ? "Mettre en pause" : "Activer"}
      </Button>
    </header>
  );
}

function ViewTab({ active, onClick, icon: Icon, label }: {
  active: boolean; onClick: () => void; icon: typeof FileText; label: string;
}) {
  return (
    <button
      type="button" onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

// ── Document view ────────────────────────────────────────────────────────────

/** The playbook, in the same editor as skills and procedures — with one extra:
 *  the anchor hint, because those comments are what makes the round-trip work
 *  and deleting them silently costs you the canvas layout. */
function DocumentView({ value, onChange, onBlur }: {
  value: string; onChange: (v: string) => void; onBlur: () => void;
}) {
  const blocks = (value.match(/<!--\s*b:/g) ?? []).length;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" onBlur={onBlur}>
      <div className="mx-auto flex h-full max-w-3xl flex-col px-8 py-6">
        <MarkdownEditor
          value={value}
          onChange={onChange}
          minHeight="70vh"
          className="flex-1"
          toolbar={
            <>
              <FileText className="h-3.5 w-3.5" />
              <span>workflow.md — ce que l'assistant reçoit et exécute</span>
              <span className="ml-auto tabular-nums">{blocks} bloc{blocks > 1 ? "s" : ""}</span>
            </>
          }
          footer={
            <span>
              Écrivez ici : les modifications repartent dans les blocs. Gardez les commentaires{" "}
              <code className="rounded bg-muted px-1">&lt;!-- b:… --&gt;</code> — ils ancrent chaque bloc et
              conservent la mise en page du canvas.
            </span>
          }
        />
      </div>
    </div>
  );
}

// ── Inspector ────────────────────────────────────────────────────────────────

/** Config for the selected block. Every field maps to one key of `data`, which
 *  is what the compiler reads — so what you see here IS what lands in the
 *  playbook. */
function BlockInspector({ node, agents, collections, workflowId, workspaceId, projectId, onPatch, onRemove, onClose }: {
  node: Node;
  agents: Array<{ id: string; name: string }>;
  collections: Array<{ id: string; name: string }>;
  workflowId: string;
  workspaceId: string | null;
  projectId: string | null;
  onPatch: (patch: Record<string, unknown>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { width, startResize } = useResizableWidth("workflow_inspector_width", 380, 300, 900);
  const kind = (node.type || "step") as BlockKind;
  const def = BLOCK_BY_KIND.get(kind)!;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => String(v ?? "");

  // `rich` = the field is a piece of writing, not a one-liner: it gets the
  // markdown surface (tab indents, monospace, room to breathe) instead of a
  // three-line box that makes writing a procedure feel like filling a slot.
  const BODY_HINT: Partial<Record<BlockKind, { label: string; placeholder: string; rows: number; rich?: boolean }>> = {
    goal: {
      label: "Ce qui est visé", rows: 6, rich: true,
      placeholder: "Produire chaque lundi une synthèse des irritants clients de la semaine, exploitable par l'équipe produit.\n\nC'est fait quand : la synthèse existe, chaque irritant est chiffré et cite des verbatims réels.",
    },
    rule: {
      label: "La règle", rows: 4,
      placeholder: "Ne jamais conclure sur un irritant étayé par moins de 3 tickets.",
    },
    resource: {
      label: "Où la trouver / comment l'utiliser", rows: 4,
      placeholder: "Base Zendesk, via le connecteur. Filtrer sur les tickets de la semaine écoulée.",
    },
    step: {
      label: "Consigne détaillée", rows: 10, rich: true,
      placeholder: "Récupère les tickets fermés depuis lundi.\n\nRegroupe-les par thème avant de conclure. Ignore ceux clos en moins de 5 minutes : ce sont des doublons.\n\nVérifie que chaque thème contient au moins 3 tickets avant de le retenir.",
    },
    decision: {
      label: "Ce qu'il faut trancher", rows: 4,
      placeholder: "Y a-t-il au moins un irritant classé critique ?",
    },
    approval: {
      label: "Ce qu'on demande à l'humain", rows: 4,
      placeholder: "Valider l'envoi de la synthèse à l'équipe produit avant publication.",
    },
    deliverable: {
      label: "Ce qui doit être produit", rows: 4,
      placeholder: "Une synthèse en 3 sections : irritants, volumes, recommandations.",
    },
    example: {
      label: "Le cas, traité de bout en bout", rows: 10, rich: true,
      placeholder: "Semaine du 3 mars : 142 tickets, 3 thèmes retenus…",
    },
    input: {
      label: "Précisions sur les entrées", rows: 3,
      placeholder: "Les paramètres viennent du formulaire de lancement, ou du mail déclencheur.",
    },
    tool: {
      label: "Pourquoi cet outil, et comment s'en servir", rows: 4,
      placeholder: "Chercher les tarifs publiés, pas les estimations de mémoire. Deux requêtes maximum par fournisseur.",
    },
    handoff: {
      label: "Le brief remis au destinataire", rows: 8, rich: true,
      placeholder: "Analyse le marché des moteurs 2D open source.\n\nCompare licences, communauté et maturité. Ne conclus pas sur un moteur sans avoir vu son dépôt.",
    },
    memory: {
      label: "Ce qu'il faut retenir", rows: 4,
      placeholder: "Le fournisseur retenu et son prix négocié, pour ne pas relancer la comparaison au prochain run.",
    },
  };
  const bodyCfg = BODY_HINT[kind];

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-border bg-card"
      style={{ width }}
    >
      {/* Drag the left edge. A block's main field is a procedure — a fixed
          340 px made writing one feel like typing into a slot. */}
      <div
        onMouseDown={startResize}
        className="absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/40"
        title="Glisser pour redimensionner"
      />
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className={cn("flex h-7 w-7 items-center justify-center rounded-md border", blockColorClass(def.color))}>
          <def.icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium leading-tight">{def.label}</span>
          <span className="block font-mono text-[10px] text-muted-foreground">{def.compiles}</span>
        </span>
        <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {kind === "trigger" ? (
          <>
            <Field label="Déclenchement">
              <Select value={str(d.mode) || "manual"} onChange={(v) => onPatch({ mode: v })} options={[
                { value: "manual", label: "Manuel" },
                { value: "schedule", label: "Planifié (cron)" },
                { value: "event", label: "Sur événement" },
                { value: "webhook", label: "Webhook entrant" },
              ]} />
            </Field>
            {d.mode === "schedule" && (
              <Field label="Expression cron" hint="ex. 0 9 * * 1 = tous les lundis à 9 h (UTC)">
                <Input value={str(d.schedule)} onChange={(e) => onPatch({ schedule: e.target.value })} className="h-8 font-mono text-sm" placeholder="0 9 * * 1" />
              </Field>
            )}
            {d.mode === "event" && (
              <Field label="Événement">
                <Input value={str(d.event)} onChange={(e) => onPatch({ event: e.target.value })} className="h-8 text-sm" placeholder="deal.won" />
              </Field>
            )}
            <p className="rounded-lg border border-border/60 bg-muted/30 p-2.5 text-[11px] leading-snug text-muted-foreground">
              Au déclenchement, l'assistant du service lit toute la procédure et décide qui fait quoi —
              il exécute lui-même ou délègue à l'agent le mieux placé.
            </p>

            {/* Tool events are ADDITIVE to the mode above: a workflow can be
                manual and still wake up on an incoming mail. */}
            {workspaceId && projectId && (
              <div className="border-t border-border/60 pt-3">
                <EventTriggers workflowId={workflowId} workspaceId={workspaceId} projectId={projectId} />
              </div>
            )}
          </>
        ) : (
          <>
            <Field label="Titre" hint="Devient le titre de la section dans le document.">
              <Input value={str(d.label)} onChange={(e) => onPatch({ label: e.target.value })} className="h-8 text-sm" placeholder={def.label} />
            </Field>
            {bodyCfg && (
              <Field label={bodyCfg.label}>
                {bodyCfg.rich ? (
                  <MarkdownEditor
                    value={str(d.body)} onChange={(v) => onPatch({ body: v })}
                    minHeight={bodyCfg.rows * 22} placeholder={bodyCfg.placeholder}
                    footer={<span>Markdown — repris tel quel dans le document.</span>}
                  />
                ) : (
                  <Textarea
                    value={str(d.body)} onChange={(v) => onPatch({ body: v })}
                    rows={bodyCfg.rows} placeholder={bodyCfg.placeholder}
                  />
                )}
              </Field>
            )}
            {/* Delegation + scoped knowledge. This is what a workflow is FOR:
                instead of one monolithic instruction file on every run, each
                part carries exactly the context it needs, handed to exactly
                the agent that needs it. */}
            {(kind === "step" || kind === "loop") && (
              <Field
                label="Confier à"
                hint="Laisser vide = l'assistant s'en charge lui-même ou choisit."
              >
                <Select
                  value={str(d.agent_id)}
                  onChange={(v) => onPatch({ agent_id: v || null })}
                  options={[{ value: "", label: "— l'assistant décide —" }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
                />
              </Field>
            )}

            {(kind === "step" || kind === "loop") && (
              <ContextPicker
                refs={Array.isArray(d.refs) ? (d.refs as ContextRef[]) : []}
                collections={collections}
                onChange={(refs) => onPatch({ refs })}
              />
            )}

            {kind === "context" && (
              <>
                <ContextSource
                  source={contextSourceOf(d)}
                  body={str(d.body)}
                  refs={Array.isArray(d.refs) ? (d.refs as ContextRef[]) : []}
                  collections={collections}
                  onPatch={onPatch}
                />
                <Field label="Portée" hint="Locale : ne vaut que pour la branche où le bloc se trouve.">
                  <Select value={str(d.scope) || "global"} onChange={(v) => onPatch({ scope: v })} options={[
                    { value: "global", label: "Tout le workflow" },
                    { value: "local", label: "Cette branche uniquement" },
                  ]} />
                </Field>
              </>
            )}

            {kind === "loop" && (
              <>
                <Field label="Type de boucle">
                  <Select value={str(d.mode) || "foreach"} onChange={(v) => onPatch({ mode: v })} options={[
                    { value: "foreach", label: "Pour chaque élément" },
                    { value: "until", label: "Jusqu'à une condition" },
                  ]} />
                </Field>
                {d.mode === "until" ? (
                  <Field label="Condition de sortie">
                    <Textarea value={str(d.until)} onChange={(v) => onPatch({ until: v })} rows={3}
                      placeholder="tous les tickets de la file ont été qualifiés" />
                  </Field>
                ) : (
                  <Field label="Sur quoi itérer" hint="Au-delà d'une dizaine d'éléments, l'assistant parallélisera.">
                    <Textarea value={str(d.over)} onChange={(v) => onPatch({ over: v })} rows={3}
                      placeholder="chaque compte client signalé à l'étape précédente" />
                  </Field>
                )}
                <Field label="Plafond d'itérations" hint="Sans plafond, une boucle mal fermée brûle le budget du run.">
                  <Input type="number" min={1} max={200} value={str(d.max) || "20"}
                    onChange={(e) => onPatch({ max: Number(e.target.value) || 20 })} className="h-8 text-sm" />
                </Field>
              </>
            )}

            {kind === "input" && (
              <ParamList
                params={paramsOf(d)}
                onChange={(params) => onPatch({ params })}
              />
            )}

            {kind === "tool" && (
              <>
                <Field label="Outil imposé" hint="L'agent a déjà sa boîte à outils — ce bloc dit lequel s'impose ici.">
                  <Select
                    value={KNOWN_TOOLS.some((t) => t.value === str(d.tool)) ? str(d.tool) : "__custom"}
                    onChange={(v) => onPatch({ tool: v === "__custom" ? "" : v })}
                    options={[...KNOWN_TOOLS, { value: "__custom", label: "Autre (saisir le nom)…" }]}
                  />
                </Field>
                {!KNOWN_TOOLS.some((t) => t.value === str(d.tool)) && (
                  <Field label="Nom de l'outil" hint="Tel qu'il apparaît dans l'onglet Accès de l'agent.">
                    <Input value={str(d.tool)} onChange={(e) => onPatch({ tool: e.target.value })}
                      className="h-8 font-mono text-sm" placeholder="gmail_send_email" />
                  </Field>
                )}
                <Field label="Exigence">
                  <Select value={d.required === false ? "optional" : "required"}
                    onChange={(v) => onPatch({ required: v === "required" })} options={[
                      { value: "required", label: "Obligatoire — passer par cet outil" },
                      { value: "optional", label: "Si besoin — laissé au jugement" },
                    ]} />
                </Field>
              </>
            )}

            {kind === "handoff" && (
              <>
                <Field label="Destinataires" hint="Plusieurs = la procédure éclate en travail d'équipe.">
                  <AgentMultiSelect
                    agents={agents}
                    selected={agentIdsOf(d)}
                    onChange={(agent_ids) => onPatch({ agent_ids })}
                  />
                </Field>
                {agentIdsOf(d).length > 1 && (
                  <Field label="Ordre" hint="Parallèle suppose des tâches vraiment indépendantes.">
                    <Select value={str(d.mode) || "sequential"} onChange={(v) => onPatch({ mode: v })} options={[
                      { value: "sequential", label: "L'un après l'autre" },
                      { value: "parallel", label: "En parallèle" },
                    ]} />
                  </Field>
                )}
                <Field
                  label="Ce qui doit revenir"
                  hint="Sans contrat de retour, on récupère trois paragraphes là où on attendait un chiffre."
                >
                  <Textarea value={str(d.expects)} onChange={(v) => onPatch({ expects: v })} rows={3}
                    placeholder="Un tableau comparatif : moteur, licence, dernière release, taille de la communauté." />
                </Field>
                <ContextPicker
                  refs={Array.isArray(d.refs) ? (d.refs as ContextRef[]) : []}
                  collections={collections}
                  onChange={(refs) => onPatch({ refs })}
                />
              </>
            )}

            {kind === "memory" && (
              <Field label="Portée" hint="Ce qui est retenu ici sera relu par les runs suivants.">
                <Select value={str(d.scope) || "team"} onChange={(v) => onPatch({ scope: v })} options={[
                  { value: "team", label: "L'équipe du service" },
                  { value: "workspace", label: "Tout l'espace de travail" },
                  { value: "personal", label: "Cet agent seulement" },
                ]} />
              </Field>
            )}

            {kind === "deliverable" && (
              <>
                <Field label="Format">
                  <Select value={str(d.format) || "report"} onChange={(v) => onPatch({ format: v })} options={[
                    { value: "report", label: "Rapport" },
                    { value: "markdown", label: "Document" },
                    { value: "csv", label: "Tableau CSV" },
                    { value: "json", label: "JSON structuré" },
                    { value: "notification", label: "Notification" },
                  ]} />
                </Field>
                {str(d.format) === "json" && (
                  <Field
                    label="Schéma attendu"
                    hint="Un livrable JSON est lu par un programme : la forme fait partie du livrable."
                  >
                    <MarkdownEditor
                      value={str(d.schema)} onChange={(v) => onPatch({ schema: v })}
                      minHeight={160}
                      placeholder={'{\n  "decision": "approve | reject",\n  "confidence": 0.0,\n  "reason": "…"\n}'}
                    />
                  </Field>
                )}
              </>
            )}
            {kind === "decision" && (
              <p className="rounded-lg border border-border/60 bg-muted/30 p-2.5 text-[11px] leading-snug text-muted-foreground">
                Reliez les deux sorties <strong>si oui</strong> et <strong>sinon</strong> aux blocs
                correspondants : le document nommera chaque branche automatiquement.
              </p>
            )}
            {kind === "approval" && (
              <p className="rounded-lg border border-border/60 bg-muted/30 p-2.5 text-[11px] leading-snug text-muted-foreground">
                Point d'arrêt réel : l'assistant posera la question et attendra la réponse avant de continuer.
              </p>
            )}
          </>
        )}
      </div>

      {kind !== "trigger" && (
        <footer className="shrink-0 border-t border-border/60 p-3">
          <Button variant="ghost" size="sm" onClick={onRemove} className="w-full text-destructive hover:text-destructive">
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Supprimer le bloc
          </Button>
        </footer>
      )}
    </aside>
  );
}

/** Tools worth naming by hand. Not the full toolbox — these are the capabilities
 *  a procedure actually pins down; anything else is typed in by name. */
const KNOWN_TOOLS = [
  { value: "web_search", label: "Recherche web" },
  { value: "deep_research", label: "Recherche approfondie" },
  { value: "read_url", label: "Lire une page" },
  { value: "rag_search", label: "Base de connaissances (RAG)" },
  { value: "query_table", label: "Interroger les données du projet" },
  { value: "python_exec", label: "Exécuter du Python" },
  { value: "shell_exec", label: "Exécuter une commande shell" },
  { value: "sandbox_browser", label: "Navigateur du sandbox" },
  { value: "http_request", label: "Appel HTTP" },
  { value: "send_email", label: "Envoyer un e-mail" },
  { value: "create_deliverable", label: "Produire un livrable" },
];

/** The parameters a run needs before it starts. A list rather than a free-text
 *  field because the assistant has to be able to tell WHICH one is missing when
 *  it asks for it. */
function ParamList({ params, onChange }: {
  params: InputParam[];
  onChange: (p: InputParam[]) => void;
}) {
  const patch = (i: number, p: Partial<InputParam>) =>
    onChange(params.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <Field label="Paramètres attendus">
      <div className="space-y-1.5">
        {params.map((p, i) => (
          <div key={i} className="space-y-1 rounded-lg border border-border/60 bg-background p-2">
            <div className="flex items-center gap-1.5">
              <Input
                value={p.name ?? ""} onChange={(e) => patch(i, { name: e.target.value })}
                placeholder="nom_du_parametre" className="h-7 flex-1 font-mono text-xs"
              />
              <button
                type="button" onClick={() => patch(i, { required: p.required === false })}
                title={p.required === false ? "Rendre obligatoire" : "Rendre facultatif"}
                className={cn(
                  "shrink-0 rounded px-1.5 py-1 text-[10px] font-medium",
                  p.required === false ? "bg-muted text-muted-foreground" : "bg-rose-400/15 text-rose-400",
                )}
              >{p.required === false ? "facultatif" : "requis"}</button>
              <button
                type="button" onClick={() => onChange(params.filter((_, j) => j !== i))}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
              ><X className="h-3 w-3" /></button>
            </div>
            <Input
              value={p.description ?? ""} onChange={(e) => patch(i, { description: e.target.value })}
              placeholder="À quoi il sert, et à quoi ressemble une valeur valide"
              className="h-7 text-xs"
            />
          </div>
        ))}
        <button
          type="button" onClick={() => onChange([...params, { name: "", description: "", required: true }])}
          className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border/70 py-1.5 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
        ><Plus className="h-3 w-3" /> Ajouter un paramètre</button>
      </div>
    </Field>
  );
}

/** Pick several agents. A handoff to one agent is a delegation; to several, it
 *  is the fan-out the runtime already supports with spawn_parallel_agents. */
function AgentMultiSelect({ agents, selected, onChange }: {
  agents: Array<{ id: string; name: string }>;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  if (agents.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border/70 p-2.5 text-[11px] leading-snug text-muted-foreground">
        Aucun agent dans ce service. L'assistant désignera lui-même un destinataire, ou en créera un.
      </p>
    );
  }
  return (
    <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-border/60 p-1">
      {agents.map((a) => {
        const on = selected.includes(a.id);
        return (
          <button
            key={a.id} type="button"
            onClick={() => onChange(on ? selected.filter((x) => x !== a.id) : [...selected, a.id])}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
              on ? "bg-primary/10 text-foreground" : "hover:bg-muted/60",
            )}
          >
            <span className={cn(
              "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
              on ? "border-primary bg-primary text-primary-foreground" : "border-border",
            )}>
              {on && <Check className="h-2.5 w-2.5" />}
            </span>
            <span className="min-w-0 flex-1 truncate">{a.name}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The context block's editor: ONE source, chosen explicitly.
 *
 * Either you write the knowledge here — and then it is the block, in full, in
 * the same markdown surface as a skill or a procedure — or you point at
 * collections the agent will search. Mixing the two was the previous design and
 * it produced blocks where the written half and the retrieved half disagreed,
 * with nothing in the document saying which one won.
 *
 * Switching sides never deletes anything: the compiler reads the active source
 * only, so the other side sits dormant and comes back intact if you switch
 * again. What is dormant is stated, because invisible content that stops
 * reaching the agent is exactly the kind of thing nobody notices.
 */
function ContextSource({ source, body, refs, collections, onPatch }: {
  source: "write" | "collections";
  body: string;
  refs: ContextRef[];
  collections: Array<{ id: string; name: string }>;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const picked = refs.filter((r) => r.kind === "collection");
  const legacyText = refs.filter((r) => r.kind === "text" && r.body?.trim());
  const written = body.trim() ? body : contextBodyOf({ body, refs });

  const toggle = (c: { id: string; name: string }) => {
    const on = picked.some((r) => r.id === c.id);
    onPatch({
      refs: on
        ? refs.filter((r) => !(r.kind === "collection" && r.id === c.id))
        : [...refs, { kind: "collection", id: c.id, label: c.name } as ContextRef],
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-muted/30 p-0.5">
        {([
          { v: "write", label: "Rédiger", icon: PenLine },
          { v: "collections", label: "Collections", icon: Library },
        ] as const).map((o) => (
          <button
            key={o.v} type="button" onClick={() => onPatch({ source: o.v })}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium transition-colors",
              source === o.v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <o.icon className="h-3 w-3" /> {o.label}
          </button>
        ))}
      </div>

      {source === "write" ? (
        <>
          <MarkdownEditor
            value={written}
            // The first edit folds any legacy free-text ref into `body`, so the
            // block ends up with one place its text lives instead of two.
            onChange={(v) => onPatch(legacyText.length
              ? { body: v, refs: refs.filter((r) => r.kind !== "text") }
              : { body: v })}
            minHeight={280}
            placeholder={"## Ce qu'il faut savoir\n\nLes remises au-delà de 15 % passent par la direction commerciale.\n\n## Vocabulaire\n\n« Compte stratégique » = plus de 50 k€ de CA annuel."}
            footer={<span>Transmis intégralement à l'agent — pas de recherche, pas de troncature.</span>}
          />
          {picked.length > 0 && (
            <DormantSide
              text={`${picked.length} collection${picked.length > 1 ? "s" : ""} rattachée${picked.length > 1 ? "s" : ""} — ignorée${picked.length > 1 ? "s" : ""} tant que le bloc est en mode Rédiger.`}
              onClear={() => onPatch({ refs: refs.filter((r) => r.kind !== "collection") })}
            />
          )}
        </>
      ) : (
        <>
          {collections.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/70 p-3 text-[11px] leading-snug text-muted-foreground">
              Aucune collection dans ce projet. Créez-en une dans <strong>Ressources → Mémoire</strong>,
              ou repassez en <strong>Rédiger</strong> pour écrire la connaissance ici.
            </p>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-1">
              {collections.map((c) => {
                const on = picked.some((r) => r.id === c.id);
                return (
                  <button
                    key={c.id} type="button" onClick={() => toggle(c)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                      on ? "bg-primary/10 text-foreground" : "hover:bg-muted/60",
                    )}
                  >
                    <span className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      on ? "border-primary bg-primary text-primary-foreground" : "border-border",
                    )}>
                      {on && <Check className="h-2.5 w-2.5" />}
                    </span>
                    <Library className="h-3 w-3 shrink-0 text-violet-400" />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-[10px] leading-snug text-muted-foreground/80">
            L'agent y cherchera ce dont il a besoin avec <code className="rounded bg-muted px-1">rag_search</code> —
            le contenu n'est pas chargé d'avance.
          </p>
          {written.trim() && (
            <DormantSide
              text="Un texte rédigé est conservé dans ce bloc — ignoré tant que le bloc pointe vers des collections."
              onClear={() => onPatch({ body: "", refs: refs.filter((r) => r.kind !== "text") })}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Content the active source does not compile. Saying so beats letting someone
 *  wonder why the text they wrote never reached the agent. */
function DormantSide({ text, onClear }: { text: string; onClear: () => void }) {
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[10px] leading-snug text-muted-foreground">
      <span className="min-w-0 flex-1">{text}</span>
      <button type="button" onClick={onClear} className="shrink-0 underline hover:text-destructive">Supprimer</button>
    </p>
  );
}

/** Attach knowledge to a step or a loop: existing collections, plus notes
 *  written on the spot. Both at once is fine here — unlike a context block, a
 *  step often needs the reference material AND a remark that applies to it
 *  alone. Files are deliberately absent: a collection already is where a file
 *  belongs. */
function ContextPicker({ refs, collections, onChange }: {
  refs: ContextRef[];
  collections: Array<{ id: string; name: string }>;
  onChange: (refs: ContextRef[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const used = new Set(refs.filter((r) => r.kind === "collection").map((r) => r.id));
  const free = collections.filter((c) => !used.has(c.id));

  return (
    <Field
      label="Connaissances à fournir"
      hint="Transmises à l'agent avec CETTE étape uniquement — c'est ainsi qu'on évite de recharger tout le contexte à chaque fois."
    >
      <div className="space-y-1.5">
        {refs.map((r, i) => {
          const patch = (p: Partial<ContextRef>) => onChange(refs.map((x, j) => (j === i ? { ...x, ...p } : x)));
          const open = expanded === i;
          return (
            <div key={i} className={cn(
              "overflow-hidden rounded-lg border bg-background",
              open ? "border-primary/40" : "border-border/60",
            )}>
              <div className="flex items-start gap-1.5 px-2 py-1.5">
                <span className={cn(
                  "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase",
                  r.kind === "collection" ? "bg-violet-400/15 text-violet-400" : "bg-sky-400/15 text-sky-400",
                )}>
                  {r.kind === "collection" ? "collection" : "procédure"}
                </span>
                {r.kind === "text" ? (
                  <input
                    value={r.label}
                    onChange={(e) => patch({ label: e.target.value })}
                    placeholder="Titre de la procédure"
                    className="min-w-0 flex-1 bg-transparent text-xs font-medium outline-none placeholder:text-muted-foreground/50"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{r.label}</span>
                )}
                {r.kind === "text" && (
                  <button
                    type="button" onClick={() => setExpanded(open ? null : i)}
                    title={open ? "Replier" : "Écrire la procédure"}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  ><Maximize2 className="h-3 w-3" /></button>
                )}
                <button
                  type="button" onClick={() => { onChange(refs.filter((_, j) => j !== i)); setExpanded(null); }}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                ><X className="h-3 w-3" /></button>
              </div>

              {r.kind === "text" && (
                <MarkdownEditor
                  variant="flush"
                  value={r.body ?? ""}
                  onChange={(v) => patch({ body: v })}
                  minHeight={open ? 320 : 96}
                  className="border-t border-border/50"
                  placeholder={"## Règles de rapprochement\n\n1. Écart accepté : 0,50 € par ligne.\n2. Au-delà, escalader au contrôleur de gestion.\n\nTransmis tel quel à l'agent."}
                  footer={open ? <span>Markdown — transmis intégralement à l'agent avec cette étape.</span> : undefined}
                />
              )}
              {r.kind === "collection" && (
                <p className="border-t border-border/50 px-2 py-1.5 text-[10px] text-muted-foreground">
                  L'agent la consultera avec <code className="rounded bg-muted px-1">rag_search</code>.
                </p>
              )}
            </div>
          );
        })}

        {adding ? (
          /* Two named choices rather than a dropdown sitting above a button:
             picking a collection and writing a note are different acts, and the
             mixed panel made the second one look like a fallback. */
          <div className="space-y-1.5 rounded-md border border-primary/40 bg-background p-2">
            {free.length > 0 ? (
              <>
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Choisir une collection</p>
                <div className="max-h-40 space-y-0.5 overflow-y-auto">
                  {free.map((c) => (
                    <button
                      key={c.id} type="button"
                      onClick={() => { onChange([...refs, { kind: "collection", id: c.id, label: c.name }]); setAdding(false); }}
                      className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] hover:bg-muted"
                    >
                      <Library className="h-3 w-3 shrink-0 text-violet-400" />
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-[10px] text-muted-foreground">
                {collections.length === 0
                  ? "Aucune collection dans ce projet — ajoutez-en dans Ressources → Mémoire."
                  : "Toutes les collections du projet sont déjà rattachées."}
              </p>
            )}
            <div className="flex gap-1.5 border-t border-border/50 pt-1.5">
              <button
                type="button"
                onClick={() => { onChange([...refs, { kind: "text", label: "", body: "" }]); setExpanded(refs.length); setAdding(false); }}
                className="flex flex-1 items-center justify-center gap-1 rounded border border-border/60 px-2 py-1 text-[11px] hover:bg-muted"
              ><PenLine className="h-3 w-3" /> Rédiger une note</button>
              <button type="button" onClick={() => setAdding(false)} className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">Annuler</button>
            </div>
          </div>
        ) : (
          <button
            type="button" onClick={() => setAdding(true)}
            className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border/70 py-1.5 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
          >
            <Plus className="h-3 w-3" /> Ajouter du contexte
          </button>
        )}
      </div>
    </Field>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[10px] leading-snug text-muted-foreground/80">{hint}</p>}
    </div>
  );
}

function Select({ value, onChange, options }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value} onChange={(e) => onChange(e.target.value)}
      className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-primary/60"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Textarea({ value, onChange, rows, placeholder }: {
  value: string; onChange: (v: string) => void; rows: number; placeholder?: string;
}) {
  return (
    <textarea
      value={value} rows={rows} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm leading-relaxed outline-none focus:border-primary/60"
    />
  );
}

