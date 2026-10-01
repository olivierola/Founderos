import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Background, BackgroundVariant, Controls, MiniMap, Panel, Handle, Position,
  ReactFlowProvider, useReactFlow, useNodesState, useEdgesState, MarkerType,
  type Node, type Edge, type NodeProps, type Connection, type OnConnectStartParams,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "dagre";
import {
  PlusIcon as Plus,
  TrashIcon as Trash2,
  DotsThreeIcon as MoreHorizontal,
  SlidersHorizontalIcon as Settings2,
  ArrowsClockwiseIcon as Reflow,
  CopyIcon as Copy,
  XIcon as X,
  ArrowsOutIcon as Fit,
  WarningCircleIcon as AlertCircle,
  CircleNotchIcon as Loader2,
  CheckIcon as Check,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  BLOCK_BY_KIND, blockSummary, isBlockEmpty, KNOWN_TOOLS,
  varsOf, normalizeVarName, paramsOf, agentIdsOf,
} from "./blocks";
import { hueOf, chipLabelOf } from "./look";
import {
  ATTACH_HANDLE, APPLIES_HANDLE, roleOf, isAttachEdge,
} from "./graph";
import {
  legsOfKind, insertBlock, newBlockId, removeBlock, connectBlocks, disconnect,
  setPositions, convertBlock, attachQualifier, patchBlock,
  type Graph,
} from "./outline";
import { BlockForm } from "./BlockForm";
import { Field, TextArea } from "./inspector-ui";
import {
  CodeEditor, OutputVarPill, ArgPills, ErrorPolicy, TestEditor,
} from "./block-fields";
import { describeCron, outputVarOf, codeToolOf, type BlockKind } from "./model";
import type { Ctx } from "./editor-ctx";

// La vue GRAPHE — le même workflow, câblé à la main.
//
// Elle ne remplace pas le document : elle répond à une autre question. Un
// document répond à « qu'est-ce que cette procédure raconte » — on le lit de
// haut en bas, les branches indentées sous la question qui les ouvre. Un graphe
// répond à « où va-t-on », et c'est la seule forme qui montre d'un coup d'œil
// deux branches qui se rejoignent, une boucle qui reboucle, ou un bloc que plus
// rien n'atteint.
//
// Les deux écrivent dans le MÊME modèle, par la même fonction `apply` : un
// bloc ajouté ici apparaît dans le document, un texte écrit là-bas s'affiche
// sur la carte. Il n'y a pas de « format graphe » — il n'y a qu'un graphe, dont
// le document est une lecture linéaire.
//
// Deux relations, comme ailleurs : le FLUX (haut → bas, l'ordre d'exécution) et
// l'ATTACHEMENT (droite → gauche, « ce cadrage vaut pour cette étape »). Les
// handles les distinguent, exactement comme dans le compilateur partagé.

const NODE_W = 272;
/** La hauteur ESTIMÉE d'une carte, pour la mise en page automatique. Approchée
 *  exprès : dagre a besoin d'un ordre de grandeur, pas d'une mesure — et
 *  mesurer obligerait à disposer deux fois, une fois pour rien. */
const nodeHeight = (rows: number) => 48 + Math.min(rows, 4) * 26 + 12;

// ── Ce qu'une carte montre ───────────────────────────────────────────────────

interface Row { label: string; value: string; tone?: "muted" | "warn" | "code" }

const s = (v: unknown) => String(v ?? "").trim();

/**
 * Les champs qu'une carte affiche sous son titre.
 *
 * Ce ne sont pas tous les réglages du bloc — le formulaire complet s'ouvre à
 * droite. Ce sont ceux qui répondent à « qu'est-ce que ce nœud fait, au juste »
 * sans avoir à l'ouvrir : l'appel exécuté, la variable produite, la condition
 * évaluée, le destinataire d'une passation. Un nœud qui n'affiche que son titre
 * oblige à ouvrir les six blocs pour relire une chaîne de six.
 */
function rowsOf(node: Node, ctx: Ctx): Row[] {
  const kind = (node.type ?? "step") as BlockKind;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const rows: Row[] = [];

  if (kind === "trigger") {
    const mode = s(d.mode) || "manual";
    rows.push({
      label: "Quand",
      value: mode === "schedule" ? "Planifié"
        : mode === "event" ? "Sur événement"
        : mode === "webhook" ? "Webhook entrant" : "Lancement manuel",
    });
    if (mode === "schedule") {
      let human = s(d.schedule) || "non défini";
      try { human = describeCron(s(d.schedule)) || human; } catch { /* l'expression brute reste lisible */ }
      rows.push({ label: "Rythme", value: human, tone: "muted" });
    }
    if (mode === "event") rows.push({ label: "Événement", value: s(d.event) || "non défini", tone: s(d.event) ? "muted" : "warn" });
    return rows;
  }

  if (kind === "tool") {
    const lang = codeToolOf(d);
    const provider = s(d.provider);
    const action = s(d.action);
    if (lang && s(d.code)) {
      rows.push({ label: "Code", value: lang.label, tone: "code" });
    } else if (provider && action) {
      rows.push({ label: "Action", value: `${provider} → ${action}` });
      const args = Object.keys((d.args ?? {}) as Record<string, unknown>).filter(Boolean);
      if (args.length) rows.push({ label: "Paramètres", value: args.join(", "), tone: "muted" });
    } else {
      const tool = s(d.tool);
      rows.push({
        label: "Outil",
        value: KNOWN_TOOLS.find((t) => t.value === tool)?.label ?? tool ?? "à choisir",
        tone: tool ? undefined : "warn",
      });
    }
    const v = outputVarOf(d);
    if (v) rows.push({ label: "Range dans", value: `{{${v}}}`, tone: "code" });
    if (d.on_error === "continue") rows.push({ label: "Si échec", value: "Continuer", tone: "muted" });
    return rows;
  }

  if (kind === "decision") {
    const tests = Array.isArray(d.tests) && (d.tests as unknown[]).length
      ? (d.tests as Array<Record<string, unknown>>)
      : [(d.test ?? {}) as Record<string, unknown>];
    const written = tests.filter((t) => s(t.left));
    if (!written.length) {
      rows.push({ label: "Condition", value: s(d.body) || "à écrire", tone: s(d.body) ? undefined : "warn" });
      return rows;
    }
    for (const t of written.slice(0, 3)) {
      rows.push({ label: "Si", value: `${s(t.left)} ${OP_LABEL[s(t.op)] ?? s(t.op)} ${s(t.right)}`.trim(), tone: "code" });
    }
    if (written.length > 1) {
      rows.push({ label: "Règle", value: d.match === "any" ? "au moins une" : "toutes", tone: "muted" });
    }
    return rows;
  }

  if (kind === "loop") {
    rows.push(s(d.mode) === "until"
      ? { label: "Jusqu'à", value: s(d.until) || "condition non définie", tone: s(d.until) ? "code" : "warn" }
      : { label: "Pour chaque", value: s(d.over) || "liste non définie", tone: s(d.over) ? "code" : "warn" });
    rows.push({ label: "Plafond", value: `${Number(d.max) || 20} itérations`, tone: "muted" });
    return rows;
  }

  if (kind === "handoff") {
    const ids = agentIdsOf(d);
    rows.push({
      label: "Confier à",
      value: ids.length ? ids.map((id) => ctx.agentName.get(id) ?? "agent supprimé").join(", ") : "personne",
      tone: ids.length ? undefined : "warn",
    });
    if (ids.length > 1) rows.push({ label: "Mode", value: s(d.mode) === "parallel" ? "en parallèle" : "l'un après l'autre", tone: "muted" });
    if (s(d.expects)) rows.push({ label: "Retour attendu", value: s(d.expects), tone: "muted" });
    return rows;
  }

  if (kind === "step") {
    const agent = s(d.agent_id);
    if (agent) rows.push({ label: "Confier à", value: ctx.agentName.get(agent) ?? "agent supprimé" });
    const v = outputVarOf(d);
    if (v) rows.push({ label: "Range dans", value: `{{${v}}}`, tone: "code" });
    if (s(d.body)) rows.push({ label: "Consigne", value: s(d.body).replace(/\{\{b:[^}]+\}\}/g, "…"), tone: "muted" });
    return rows;
  }

  if (kind === "wait") {
    const secs = Math.max(0, Math.min(60, Number(d.seconds) || 0));
    return [{ label: "Attendre", value: `${secs} seconde${secs > 1 ? "s" : ""}` }];
  }

  if (kind === "judge") {
    const q = s(d.question) || s(d.label);
    return [
      { label: "Question", value: q || "à écrire", tone: q ? undefined : "warn" },
      ...(s(d.over) ? [{ label: "Sur", value: s(d.over), tone: "code" as const }] : []),
      ...(Number(d.threshold) > 0 ? [{ label: "Seuil", value: String(d.threshold), tone: "muted" as const }] : []),
    ];
  }

  if (kind === "stop") {
    const outcome = s(d.outcome) || "succeeded";
    return [
      {
        label: "Se termine",
        value: outcome === "failed" ? "en échec" : outcome === "stopped" ? "sans suite" : "avec succès",
        tone: outcome === "failed" ? "warn" : undefined,
      },
      ...(s(d.body) ? [{ label: "Pourquoi", value: s(d.body), tone: "muted" as const }] : []),
    ];
  }

  if (kind === "note") {
    const text = s(d.body) || s(d.label);
    return text ? [{ label: "Note", value: text, tone: "muted" }] : [{ label: "Note", value: "vide", tone: "muted" }];
  }

  if (kind === "variables" || kind === "set") {
    for (const v of varsOf(d).slice(0, 4)) {
      const name = normalizeVarName(v.name);
      if (!name) continue;
      rows.push({ label: name, value: v.secret ? "••••••" : s(v.value) || "(vide)", tone: "code" });
    }
    if (!rows.length) rows.push({ label: "Variables", value: "aucune", tone: "warn" });
    return rows;
  }

  if (kind === "input") {
    const params = paramsOf(d).filter((p) => s(p.name));
    for (const p of params.slice(0, 4)) {
      rows.push({ label: s(p.name), value: p.required === false ? "facultative" : "obligatoire", tone: "muted" });
    }
    if (!rows.length) rows.push({ label: "Entrées", value: "aucune", tone: "warn" });
    return rows;
  }

  const summary = blockSummary(kind, d);
  if (summary) rows.push({ label: BLOCK_BY_KIND.get(kind)?.label ?? "", value: summary, tone: "muted" });
  return rows;
}

const OP_LABEL: Record<string, string> = {
  equals: "=", not_equals: "≠", contains: "contient", not_contains: "ne contient pas",
  gt: ">", lt: "<", exists: "existe", empty: "est vide",
};

// ── Les ports d'un bloc ──────────────────────────────────────────────────────

interface Ports {
  /** Entrée de flux, en haut. */
  flowIn: boolean;
  /** Sorties de flux, en bas — une par branche, plus la continuation. */
  outs: Array<{ handle: string | null; label: string }>;
  /** Port d'attachement à gauche : « des cadrages viennent se poser ici ». */
  attachIn: boolean;
  /** Port d'application à droite, pour un cadrage. */
  appliesOut: boolean;
}

/**
 * Quels ports porte un bloc — et donc ce qu'on a le droit d'y brancher.
 *
 * Le `tool` change de NATURE selon le workflow, et c'est pour ça que cette
 * fonction connaît la nature du workflow : dans une procédure c'est un cadrage
 * qu'on accroche à une étape, dans une automatisation l'appel EST l'étape.
 * Donner les mêmes ports aux deux laisserait câbler dans la chaîne un bloc que
 * le compilateur n'y lira jamais.
 */
function portsOf(node: Node, kind: Ctx["kind"]): Ports {
  const role = roleOf(node.type);
  const automationAction = kind === "automation" && ["tool", "decision", "handoff"].includes(node.type ?? "");

  if (node.type === "trigger") {
    return { flowIn: false, outs: [{ handle: null, label: "" }], attachIn: false, appliesOut: false };
  }
  // Une note n'a aucun port : elle flotte à côté de ce qu'elle commente. Lui en
  // donner un inviterait à la câbler dans une chaîne qu'elle ne sait pas
  // exécuter.
  if (node.type === "note") {
    return { flowIn: false, outs: [], attachIn: false, appliesOut: false };
  }
  if (role === "qualifier" && !automationAction) {
    return { flowIn: false, outs: [], attachIn: false, appliesOut: true };
  }
  const { legs, after } = legsOfKind(node.type);
  const outs = legs.length
    ? [...legs.map((l) => ({ handle: l.handle, label: l.label })),
       ...(after ? [{ handle: after, label: "APRÈS" }] : [])]
    : [{ handle: null, label: "" }];
  return {
    flowIn: true,
    outs,
    // L'attachement n'a de sens que pour une procédure : le moteur
    // d'automatisation exécute la chaîne et ne lit aucun cadrage.
    attachIn: kind === "procedure" && role === "action",
    appliesOut: false,
  };
}

// ── Les gestes, sans passer par les données du nœud ──────────────────────────
// Les fonctions restent DANS un contexte React plutôt que dans `node.data` :
// une callback rangée dans les données est recréée à chaque rendu, ce qui
// redessine tous les nœuds à chaque frappe du formulaire d'à côté.

/** Le port d'où part un fil : quel bloc, quel handle, et dans quel sens. */
interface Dragged { nodeId: string; handleId: string | null; handleType: "source" | "target" }

interface Actions {
  open: (id: string) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  addFrom: (id: string, handle: string | null) => void;
}
const ActionsCtx = createContext<Actions | null>(null);
const useActions = () => useContext(ActionsCtx)!;

// ── La carte ─────────────────────────────────────────────────────────────────

const STATUS_RING: Record<string, string> = {
  running: "ring-2 ring-sky-400 border-sky-400/60",
  succeeded: "ring-1 ring-emerald-400/60 border-emerald-400/50",
  failed: "ring-2 ring-red-500 border-red-500/60",
  skipped: "opacity-55",
};

function BlockNode({ id, data, selected }: NodeProps) {
  const def = BLOCK_BY_KIND.get(data.kind as BlockKind);
  const Icon = def?.icon;
  const hue = data.hue as string;
  const ports = data.ports as Ports;
  const rows = data.rows as Row[];
  const status = data.status as string | undefined;
  const actions = useActions();
  const [menu, setMenu] = useState(false);

  return (
    <div
      className={cn(
        "group relative rounded-2xl border bg-card shadow-sm transition-shadow",
        selected ? "border-primary/70 ring-2 ring-primary/25" : "border-border/70",
        status ? STATUS_RING[status] : "",
        data.empty && !status ? "border-dashed" : "",
      )}
      style={{ width: NODE_W }}
      onDoubleClick={() => actions.open(id)}
    >
      {ports.flowIn && (
        <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-2 !border-background !bg-muted-foreground" />
      )}
      {ports.attachIn && (
        <Handle
          type="target" id={ATTACH_HANDLE} position={Position.Left}
          className="!h-2 !w-2 !border-2 !border-background !bg-violet-400"
          title="Y accrocher un cadrage"
        />
      )}
      {ports.appliesOut && (
        <Handle
          type="source" id={APPLIES_HANDLE} position={Position.Right}
          className="!h-2 !w-2 !border-2 !border-background !bg-violet-400"
          title="Appliquer ce cadrage à une étape"
        />
      )}

      {/* Tête : l'icône du type, le nom, et ce qu'on peut en faire. */}
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{ background: `${hue}26`, color: hue }}
        >
          {Icon ? <Icon className="h-3.5 w-3.5" weight="bold" /> : null}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium leading-tight">{data.title as string}</div>
          <div className="truncate text-[9.5px] uppercase tracking-wider text-muted-foreground">
            {def?.label ?? data.kind}
          </div>
        </div>
        {status === "running" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-400" />}
        {status === "succeeded" && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />}
        {status === "failed" && <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setMenu((v) => !v); }}
          className="nodrag flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>

      {rows.length > 0 && (
        <div className="space-y-1 border-t border-border/50 px-2.5 py-2">
          {rows.slice(0, 4).map((r, i) => (
            <button
              key={i}
              type="button"
              onClick={(e) => { e.stopPropagation(); actions.open(id); }}
              className="nodrag flex w-full items-center gap-2 text-left"
            >
              <span className="w-[68px] shrink-0 truncate text-[10px] text-muted-foreground">{r.label}</span>
              <span className={cn(
                "min-w-0 flex-1 truncate rounded-md px-2 py-1 text-[11px]",
                r.tone === "code" ? "bg-muted/60 font-mono text-[10.5px]"
                  : r.tone === "warn" ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  : "bg-muted/40",
              )}>
                {r.value}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Sorties. Une branche porte son nom sous le port — sans lui, « si oui »
          et « sinon » ne se distinguent que par la position du fil. */}
      {ports.outs.map((o, i) => {
        const left = ports.outs.length === 1 ? 50 : (100 / (ports.outs.length + 1)) * (i + 1);
        return (
          <div key={o.handle ?? "next"}>
            <Handle
              type="source" id={o.handle ?? undefined} position={Position.Bottom}
              style={{ left: `${left}%` }}
              className="!h-2 !w-2 !border-2 !border-background !bg-primary"
            />
            {o.label && (
              <span
                className="pointer-events-none absolute top-full mt-1 -translate-x-1/2 rounded bg-background/90 px-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground"
                style={{ left: `${left}%` }}
              >
                {o.label}
              </span>
            )}
          </div>
        );
      })}

      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setMenu(false); }} />
          <div className="nodrag absolute right-1 top-9 z-50 w-48 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-lg">
            <MenuRow icon={Settings2} label="Réglages" onClick={() => { setMenu(false); actions.open(id); }} />
            <MenuRow icon={Plus} label="Ajouter à la suite" onClick={() => { setMenu(false); actions.addFrom(id, ports.outs[0]?.handle ?? null); }} />
            <MenuRow icon={Copy} label="Dupliquer" onClick={() => { setMenu(false); actions.duplicate(id); }} />
            {data.kind !== "trigger" && (
              <MenuRow icon={Trash2} label="Supprimer" destructive onClick={() => { setMenu(false); actions.remove(id); }} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MenuRow({ icon: Icon, label, onClick, destructive }: {
  icon: typeof Plus; label: string; onClick: () => void; destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-muted",
        destructive && "text-red-600 dark:text-red-400",
      )}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

const nodeTypes = { block: BlockNode };

// ── Mise en page automatique ─────────────────────────────────────────────────

/** Une disposition hiérarchique, de haut en bas — le sens dans lequel une
 *  procédure se lit. Les attachements sont posés à GAUCHE de ce qu'ils
 *  qualifient, en dehors du rang : les faire porter par dagre les alignerait
 *  dans la colonne des étapes, et on ne verrait plus qui exécute et qui cadre. */
export function layoutGraph(g: Graph, heights: Map<string, number>): Record<string, { x: number; y: number }> {
  const d = new dagre.graphlib.Graph();
  d.setDefaultEdgeLabel(() => ({}));
  d.setGraph({ rankdir: "TB", ranksep: 76, nodesep: 46, marginx: 40, marginy: 40 });

  const attached = new Map<string, string>();
  for (const e of g.edges) if (isAttachEdge(e)) attached.set(e.source, e.target);

  for (const n of g.nodes) {
    if (attached.has(n.id)) continue;
    d.setNode(n.id, { width: NODE_W, height: heights.get(n.id) ?? 96 });
  }
  for (const e of g.edges) {
    if (isAttachEdge(e) || e.source === e.target) continue;
    if (!d.hasNode(e.source) || !d.hasNode(e.target)) continue;
    d.setEdge(e.source, e.target);
  }
  dagre.layout(d);

  const out: Record<string, { x: number; y: number }> = {};
  for (const n of g.nodes) {
    if (attached.has(n.id)) continue;
    const p = d.node(n.id);
    if (p) out[n.id] = { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - (heights.get(n.id) ?? 96) / 2) };
  }
  // Les cadrages : empilés à gauche de leur cible, dans l'ordre d'accrochage.
  const seats = new Map<string, number>();
  for (const [qualifier, target] of attached) {
    const base = out[target];
    if (!base) continue;
    const seat = seats.get(target) ?? 0;
    seats.set(target, seat + 1);
    out[qualifier] = { x: base.x - NODE_W - 70, y: base.y + seat * 92 };
  }
  return out;
}

/** Des positions qui ne veulent rien dire : un graphe écrit dans le document
 *  empile tout sur la même colonne, et deux blocs exactement superposés ne se
 *  distinguent pas. On dispose alors une fois, à l'ouverture. */
function needsLayout(g: Graph): boolean {
  if (g.nodes.length < 2) return false;
  const seen = new Set<string>();
  for (const n of g.nodes) {
    if (!n.position) return true;
    const key = `${Math.round(n.position.x)}:${Math.round(n.position.y)}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  // La colonne unique de l'éditeur document (x = 260 partout).
  return g.nodes.every((n) => Math.round(n.position?.x ?? 0) === 260);
}

// ── L'écran ──────────────────────────────────────────────────────────────────

export interface CanvasProps {
  ctx: Ctx;
  /** L'état d'exécution par bloc, pour que la carte dise ce qui se passe
   *  pendant que ça se passe. */
  status?: Map<string, string>;
  /** Les blocs à proposer dans la palette — la même liste que le document. */
  kinds: BlockKind[];
  /** Les cadrages qu'on peut poser à côté (procédure seulement). */
  qualifierKinds: BlockKind[];
  frameKinds: BlockKind[];
}

export function WorkflowCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({ ctx, status, kinds, qualifierKinds, frameKinds }: CanvasProps) {
  const { screenToFlowPosition, fitView } = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  /** Le port qu'on vient de tirer, quand le fil est lâché dans le vide. Le
   *  SENS compte : un fil tiré depuis l'entrée d'un bloc crée son prédécesseur,
   *  pas son successeur. */
  const pending = useRef<Dragged | null>(null);
  const laidOut = useRef(false);

  const heights = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of ctx.graph.nodes) m.set(n.id, nodeHeight(rowsOf(n, ctx).length));
    return m;
  }, [ctx.graph, ctx.agentName]);

  // Disposer une fois, si les positions stockées ne disent rien. Écrit dans le
  // graphe : une disposition recalculée à chaque ouverture empêcherait
  // d'apprendre la carte, et effacerait le placement fait à la main.
  useEffect(() => {
    if (laidOut.current || !ctx.graph.nodes.length) return;
    laidOut.current = true;
    if (!needsLayout(ctx.graph)) return;
    const positions = layoutGraph(ctx.graph, heights);
    ctx.apply((g) => setPositions(g, positions));
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 60);
  }, [ctx, heights, fitView]);

  const computedNodes: Node[] = useMemo(() => ctx.graph.nodes.map((n) => {
    const kind = (n.type ?? "step") as BlockKind;
    return {
      id: n.id,
      type: "block",
      position: n.position ?? { x: 0, y: 0 },
      selected: ctx.openBlock === n.id,
      deletable: n.type !== "trigger",
      data: {
        kind,
        title: chipLabelOf(n),
        hue: hueOf(n.type),
        rows: rowsOf(n, ctx),
        ports: portsOf(n, ctx.kind),
        status: status?.get(n.id),
        empty: isBlockEmpty(kind, (n.data ?? {}) as Record<string, unknown>),
      },
    } as Node;
  }), [ctx.graph, ctx.openBlock, ctx.kind, ctx.agentName, status]);

  const computedEdges: Edge[] = useMemo(() => ctx.graph.edges.map((e) => {
    const attach = isAttachEdge(e);
    const live = status?.get(e.source) === "succeeded" && !!status?.get(e.target);
    // Pas d'étiquette sur le fil : la branche est déjà nommée sous le port d'où
    // elle sort, et le dire deux fois encombre le seul endroit où le regard
    // suit une ligne.
    return {
      ...e,
      id: e.id ?? `${e.source}-${e.sourceHandle ?? ""}-${e.target}`,
      type: "smoothstep",
      animated: attach ? false : live || status?.get(e.source) === "running",
      style: attach
        ? { stroke: hueOf(ctx.graph.nodes.find((n) => n.id === e.source)?.type), strokeWidth: 1.2, strokeDasharray: "4 3" }
        : { stroke: live ? "#34d399" : "hsl(var(--muted-foreground))", strokeWidth: live ? 1.8 : 1.3 },
      markerEnd: attach ? undefined : { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "hsl(var(--muted-foreground))" },
    } as Edge;
  }), [ctx.graph, status]);

  /**
   * L'état que React Flow manipule, dérivé du graphe.
   *
   * Il FAUT qu'il soit local : dans un flux contrôlé, une carte qu'on déplace
   * ne bouge à l'écran que si `onNodesChange` applique le changement. Sans lui,
   * on tire un nœud et rien ne suit la souris — le graphe, lui, ne serait mis à
   * jour qu'au relâché.
   *
   * Le modèle reste la vérité : dès que le graphe change (ici, dans le
   * document, ou sous la plume d'un agent), cet état est réécrit depuis lui.
   */
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(computedNodes);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(computedEdges);
  useEffect(() => { setRfNodes(computedNodes); }, [computedNodes, setRfNodes]);
  useEffect(() => { setRfEdges(computedEdges); }, [computedEdges, setRfEdges]);

  // ── Gestes ────────────────────────────────────────────────────────────────

  /** La palette, et d'où elle a été ouverte. `from` est le port dont le fil
   *  vient d'être lâché : c'est lui qui transforme « ajouter un bloc » en
   *  « relier à un nouveau bloc ». */
  const [palette, setPalette] = useState<{
    flow: { x: number; y: number };
    screen: { x: number; y: number } | null;
    from: Dragged | null;
  } | null>(null);

  const openPalette = useCallback((
    flow: { x: number; y: number },
    from: Dragged | null,
    screen?: { x: number; y: number } | null,
  ) => setPalette({ flow, from, screen: screen ?? null }), []);

  const actions: Actions = useMemo(() => ({
    open: (id) => ctx.setOpenBlock(id),
    remove: (id) => {
      ctx.apply((g) => removeBlock(g, id));
      if (ctx.openBlock === id) ctx.setOpenBlock(null);
    },
    duplicate: (id) => {
      ctx.apply((g) => {
        const src = g.nodes.find((n) => n.id === id);
        if (!src) return g;
        const kind = (src.type ?? "step") as BlockKind;
        // Posée À CÔTÉ, et insérée dans la chaîne après l'originale : une copie
        // qui se superpose à son modèle donne l'impression que rien ne s'est
        // passé, et il faut déplacer un bloc pour découvrir l'autre.
        const { graph, id: copyId } = insertBlock(g, kind, {
          afterId: id,
          position: { x: (src.position?.x ?? 0) + NODE_W + 56, y: src.position?.y ?? 0 },
        });
        return patchBlock(graph, copyId, { ...(src.data ?? {}) });
      });
    },
    addFrom: (id, handle) => {
      const src = ctx.graph.nodes.find((n) => n.id === id);
      const at = src?.position ?? { x: 0, y: 0 };
      openPalette(
        { x: at.x, y: at.y + (heights.get(id) ?? 96) + 90 },
        { nodeId: id, handleId: handle, handleType: "source" },
      );
    },
  }), [ctx, heights, openPalette]);

  const addBlock = (kind: BlockKind) => {
    const p = palette;
    if (!p) return;
    setPalette(null);
    // L'identifiant est tiré ICI : `apply` est une mise à jour fonctionnelle et
    // ne rend rien, donc sans lui on ne saurait pas quels réglages ouvrir.
    const id = newBlockId(kind);
    ctx.apply((g) => {
      // Le bloc se pose LÀ où le fil a été lâché. S'il part d'un port, il est
      // raccordé à CE port et à rien d'autre : laisser en plus le raccordement
      // automatique en fin de chaîne lui donnerait un second parent.
      const { graph } = insertBlock(g, kind, { position: p.flow, detached: !!p.from, id });
      const from = p.from;
      if (!from) return graph;
      // Un fil tiré depuis une ENTRÉE se lit à l'envers : le bloc qu'on pose
      // arrive AVANT celui dont on est parti. Le câbler dans l'autre sens
      // dessinerait une flèche qui contredit le geste.
      if (from.handleType === "target") {
        if (from.handleId === ATTACH_HANDLE) {
          // Le port d'attachement n'accepte qu'un cadrage. Un bloc d'action
          // accroché là ne serait lu par personne : on le pose, sans le relier.
          return roleOf(kind) === "qualifier"
            ? attachQualifier(graph, id, from.nodeId)
            : graph;
        }
        return connectBlocks(graph, id, null, from.nodeId);
      }
      return from.handleId === APPLIES_HANDLE
        ? attachQualifier(graph, id, from.nodeId)
        : connectBlocks(graph, from.nodeId, from.handleId, id);
    });
    // Un bloc neuf est vide par définition : ses réglages s'ouvrent tout de
    // suite, sinon le geste suivant est toujours « double-cliquer dessus ».
    ctx.setOpenBlock(id);
  };

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    // Un attachement et un flux ne se câblent pas de la même façon : l'un
    // remplace la sortie du port, l'autre s'ajoute (un même cadrage vaut pour
    // plusieurs étapes, une étape en prend plusieurs).
    if (c.sourceHandle === APPLIES_HANDLE || c.targetHandle === ATTACH_HANDLE) {
      if (c.sourceHandle !== APPLIES_HANDLE || c.targetHandle !== ATTACH_HANDLE) return;
      ctx.apply((g) => attachQualifier(g, c.source!, c.target!));
      return;
    }
    ctx.apply((g) => connectBlocks(g, c.source!, c.sourceHandle ?? null, c.target!));
  }, [ctx]);

  const isValidConnection = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return false;
    const attach = c.sourceHandle === APPLIES_HANDLE || c.targetHandle === ATTACH_HANDLE;
    return attach ? c.sourceHandle === APPLIES_HANDLE && c.targetHandle === ATTACH_HANDLE : true;
  }, []);

  const onConnectStart = useCallback((_: unknown, p: OnConnectStartParams) => {
    pending.current = p.nodeId
      ? { nodeId: p.nodeId, handleId: p.handleId ?? null, handleType: p.handleType === "target" ? "target" : "source" }
      : null;
  }, []);

  /** Un fil lâché dans le vide OUVRE la palette et crée le bloc déjà raccordé.
   *  C'est le geste qui fait la différence entre « dessiner un schéma » et
   *  « construire » : on ne repose jamais la main sur une barre d'outils. */
  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent) => {
    const from = pending.current;
    pending.current = null;
    if (!from) return;
    const target = event.target as Element | null;
    if (!target?.classList?.contains("react-flow__pane")) return;
    const point = "clientX" in event
      ? { x: event.clientX, y: event.clientY }
      : { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
    const box = wrap.current?.getBoundingClientRect();
    openPalette(
      screenToFlowPosition(point),
      from,
      box ? { x: point.x - box.left, y: point.y - box.top } : null,
    );
  }, [openPalette, screenToFlowPosition]);

  const selected = ctx.graph.nodes.find((n) => n.id === ctx.openBlock) ?? null;

  const relayout = () => {
    const positions = layoutGraph(ctx.graph, heights);
    ctx.apply((g) => setPositions(g, positions));
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 60);
  };

  // Une automatisation ne se cadre pas : ni règle, ni contexte, ni livrable —
  // le moteur n'en lit aucun. Elle a en revanche des variables et des entrées,
  // qui arrivent par `frameKinds`.
  const paletteKinds = ctx.kind === "automation"
    ? [...kinds, ...frameKinds]
    : [...kinds, ...frameKinds, ...qualifierKinds];

  return (
    <div ref={wrap} className="relative h-full w-full" onClick={() => setPalette(null)}>
      <ActionsCtx.Provider value={actions}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          onNodeDragStop={(_, node, dragged) => {
            const moved: Record<string, { x: number; y: number }> = {};
            for (const n of dragged?.length ? dragged : [node]) moved[n.id] = n.position;
            ctx.apply((g) => setPositions(g, moved));
          }}
          onNodeClick={(_, node) => ctx.setOpenBlock(node.id)}
          onPaneClick={() => { ctx.setOpenBlock(null); setPalette(null); }}
          onNodesDelete={(deleted) => {
            ctx.apply((g) => deleted.reduce((acc, n) => removeBlock(acc, n.id), g));
          }}
          onEdgesDelete={(deleted) => {
            ctx.apply((g) => deleted.reduce((acc, e) => disconnect(acc, e.id), g));
          }}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          nodesConnectable
          elevateEdgesOnSelect
          connectionRadius={28}
          minZoom={0.2}
          maxZoom={1.75}
          defaultViewport={{ x: 0, y: 0, zoom: 0.9 }}
          proOptions={{ hideAttribution: true }}
          fitView
          fitViewOptions={{ padding: 0.25 }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="opacity-50" />
          <Controls showInteractive={false} className="!bottom-4 !left-4" />
          <MiniMap
            pannable zoomable
            nodeColor={(n) => (n.data?.hue as string) ?? "#64748b"}
            maskColor="hsl(var(--background) / 0.7)"
            className="!bottom-4 !right-4 !hidden !bg-card md:!block"
          />

          <Panel position="top-left" className="!m-3">
            <div className="flex items-center gap-1.5 rounded-xl border border-border/70 bg-card/95 p-1 shadow-sm backdrop-blur">
              <Button
                size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-[12px]"
                onClick={(e) => {
                  e.stopPropagation();
                  const box = wrap.current?.getBoundingClientRect();
                  const center = box
                    ? screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 3 })
                    : { x: 0, y: 0 };
                  openPalette(center, null, box ? { x: 16, y: 48 } : null);
                }}
              >
                <Plus className="h-3.5 w-3.5" /> Ajouter un bloc
              </Button>
              <span className="h-4 w-px bg-border" />
              <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-[12px]" onClick={(e) => { e.stopPropagation(); relayout(); }}>
                <Reflow className="h-3.5 w-3.5" /> Réorganiser
              </Button>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Tout voir"
                onClick={(e) => { e.stopPropagation(); fitView({ padding: 0.2, duration: 300 }); }}>
                <Fit className="h-3.5 w-3.5" />
              </Button>
            </div>
          </Panel>
        </ReactFlow>

        {palette && (
          <div
            className="absolute z-30 w-60 overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
            style={{
              left: Math.max(8, Math.min((palette.screen?.x ?? 16), (wrap.current?.clientWidth ?? 800) - 250)),
              top: Math.max(8, Math.min((palette.screen?.y ?? 48), (wrap.current?.clientHeight ?? 600) - 320)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border/60 px-2.5 py-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">
                {palette.from ? "Relier à un nouveau bloc" : "Ajouter un bloc"}
              </span>
              <button type="button" onClick={() => setPalette(null)} className="text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {paletteKinds.map((k) => {
                const def = BLOCK_BY_KIND.get(k)!;
                const Icon = def.icon;
                return (
                  <button
                    key={k} type="button" onClick={() => addBlock(k)}
                    className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-muted"
                  >
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded"
                      style={{ background: `${hueOf(k)}26`, color: hueOf(k) }}>
                      <Icon className="h-3 w-3" weight="bold" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-medium">{def.label}</span>
                      <span className="block truncate text-[10.5px] text-muted-foreground">{def.hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {selected && (
          <Inspector ctx={ctx} node={selected} onClose={() => ctx.setOpenBlock(null)} />
        )}
      </ActionsCtx.Provider>
    </div>
  );
}

// ── Le panneau de réglages ───────────────────────────────────────────────────

/** Les bornes du panneau de réglages.
 *
 *  368 px suffisaient tant qu'il n'y avait que des champs de texte. Il porte
 *  maintenant un éditeur de code, des exemples, des paramètres d'action : à
 *  cette largeur, une ligne de Python se coupe en trois et on relit mal ce
 *  qu'on vient d'écrire. Le défaut s'adapte à l'écran, et la poignée laisse
 *  trancher ceux pour qui le canevas compte plus que le formulaire. */
const PANEL_MIN = 340;
const PANEL_MAX = 900;
const PANEL_KEY = "wf-inspector-width";

function defaultPanelWidth(): number {
  if (typeof window === "undefined") return 460;
  try {
    const saved = Number(localStorage.getItem(PANEL_KEY));
    if (Number.isFinite(saved) && saved >= PANEL_MIN) {
      // Rogné à la fenêtre COURANTE : une largeur retenue sur un grand écran ne
      // doit pas recouvrir tout le canevas sur un portable.
      return Math.min(saved, Math.max(PANEL_MIN, window.innerWidth * 0.6));
    }
  } catch { /* sans mémoire, on prend le défaut */ }
  return Math.round(Math.min(PANEL_MAX, Math.max(440, window.innerWidth * 0.34)));
}

/** La poignée de redimensionnement, sur le bord gauche. Elle écoute la fenêtre
 *  entière pendant le glissé : cantonnée à son propre élément, elle décroche
 *  dès que la souris va plus vite que le rendu. */
function usePanelWidth(): [number, (e: React.PointerEvent) => void, () => void] {
  const [width, setWidth] = useState(defaultPanelWidth);
  const drag = useRef<{ x: number; from: number } | null>(null);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current) return;
      // Le panneau est à DROITE : tirer vers la gauche l'élargit.
      const next = Math.round(drag.current.from + (drag.current.x - e.clientX));
      setWidth(Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.min(next, window.innerWidth - 120))));
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(PANEL_KEY, String(width)); } catch { /* facultatif */ }
  }, [width]);

  const start = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, from: width };
    // Pendant le glissé, le curseur et la sélection de texte appartiennent au
    // geste, pas au contenu survolé.
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  /** Revenir au défaut. Oublier la valeur retenue SANS remettre la largeur à
   *  l'écran laisserait croire que le double-clic n'a rien fait. */
  const reset = () => {
    try { localStorage.removeItem(PANEL_KEY); } catch { /* noop */ }
    setWidth(Math.round(Math.min(PANEL_MAX, Math.max(440, window.innerWidth * 0.34))));
  };

  return [width, start, reset];
}

function Inspector({ ctx, node, onClose }: { ctx: Ctx; node: Node; onClose: () => void }) {
  const def = BLOCK_BY_KIND.get((node.type ?? "step") as BlockKind);
  const Icon = def?.icon;
  const [converting, setConverting] = useState(false);
  const [panelWidth, startResize, resetWidth] = usePanelWidth();
  // Les conversions possibles : on ne propose que des blocs du même RÔLE. Une
  // étape devenue « règle » sortirait de la chaîne et laisserait un trou que
  // rien ne signale.
  const sameRole = [...BLOCK_BY_KIND.values()]
    .filter((b) => b.role === def?.role && b.kind !== node.type && b.kind !== "trigger");

  return (
    <aside
      className="absolute inset-y-0 right-0 z-20 flex flex-col border-l border-border/70 bg-background shadow-xl"
      style={{ width: panelWidth }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* La poignée déborde de 2 px sur le canevas : une zone de préhension de
          la largeur d'une bordure se rate une fois sur deux. */}
      <div
        onPointerDown={startResize}
        onDoubleClick={resetWidth}
        title="Glisser pour redimensionner · double-clic pour revenir au défaut"
        className="group absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize"
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-primary/60" />
      </div>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-md"
          style={{ background: `${hueOf(node.type)}26`, color: hueOf(node.type) }}>
          {Icon ? <Icon className="h-3.5 w-3.5" weight="bold" /> : null}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium leading-tight">{chipLabelOf(node)}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{def?.label}</div>
        </div>
        {sameRole.length > 0 && (
          <button type="button" onClick={() => setConverting((v) => !v)}
            className="rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted">
            Convertir
          </button>
        )}
        <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted">
          <X className="h-4 w-4" />
        </button>
      </header>

      {converting && (
        <div className="flex flex-wrap gap-1.5 border-b border-border/60 bg-muted/30 p-2.5">
          {sameRole.map((b) => (
            <button
              key={b.kind} type="button"
              onClick={() => { setConverting(false); ctx.apply((g) => convertBlock(g, node.id, b.kind)); }}
              className="rounded-lg border border-border/70 bg-background px-2 py-1 text-[11px] hover:border-foreground/40"
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* Le texte d'une action s'écrit SUR SA LIGNE dans le document — c'est
            là qu'on y pose des pastilles. Sur le canevas il n'y a pas de ligne :
            sans ce champ, on pouvait câbler une étape sans jamais pouvoir dire
            ce qu'elle demande. Les pastilles y apparaissent sous leur forme
            brute, et se posent dans la vue Document. */}
        {roleOf(node.type) === "action" && node.type !== "wait" && (
          <div className="mb-3">
            <Field label={node.type === "decision" ? "Ce qu'il faut trancher" : "Texte"}>
              <TextArea
                value={String((node.data as Record<string, unknown>)?.body ?? "")}
                onChange={(v) => ctx.apply((g) => patchBlock(g, node.id, { body: v }))}
                placeholder={BLOCK_BY_KIND.get((node.type ?? "step") as BlockKind)?.hint ?? ""}
                minRows={3}
              />
            </Field>
          </div>
        )}

        {/* Ce qui s'écrit AU FIL de la procédure dans la vue document — la
            condition d'une bifurcation, le code d'une action, ses paramètres,
            le nom sous lequel son résultat est rangé. Sur le canevas il n'y a
            pas de phrase où les poser : ils viennent en tête du panneau, avant
            les réglages de fond. */}
        {node.type === "decision" && (
          <div className="mb-3">
            <TestEditor node={node} ctx={ctx} />
          </div>
        )}
        {node.type === "tool" && (
          <div className="mb-3 space-y-2">
            {codeToolOf((node.data ?? {}) as Record<string, unknown>) ? (
              <CodeEditor node={node} ctx={ctx} vars={ctx.vars} />
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                <ArgPills node={node} ctx={ctx} />
              </div>
            )}
            {ctx.kind === "automation" && <ErrorPolicy node={node} ctx={ctx} />}
          </div>
        )}
        {node.type === "step" && (
          <div className="mb-3 flex justify-end"><OutputVarPill node={node} ctx={ctx} /></div>
        )}

        <BlockForm
          node={node}
          nodes={ctx.graph.nodes}
          edges={ctx.graph.edges}
          agents={ctx.agents}
          collections={ctx.collections}
          workflowId={ctx.workflowId}
          workspaceId={ctx.workspaceId}
          projectId={ctx.projectId}
          onPatch={(patch) => ctx.apply((g) => patchBlock(g, node.id, patch))}
          onAttach={(q, a) => ctx.apply((g) => attachQualifier(g, q, a))}
          onDetach={(q, a) => ctx.apply((g) => ({
            nodes: g.nodes,
            edges: g.edges.filter((e) => !(isAttachEdge(e) && e.source === q && e.target === a)),
          }))}
        />
      </div>

      {node.type !== "trigger" && (
        <footer className="shrink-0 border-t border-border/60 p-2.5">
          <Button
            size="sm" variant="ghost"
            className="h-8 w-full justify-start gap-2 text-[12px] text-red-600 hover:bg-red-500/10 dark:text-red-400"
            onClick={() => { onClose(); ctx.apply((g) => removeBlock(g, node.id)); }}
          >
            <Trash2 className="h-3.5 w-3.5" /> Supprimer ce bloc
          </Button>
        </footer>
      )}
    </aside>
  );
}
