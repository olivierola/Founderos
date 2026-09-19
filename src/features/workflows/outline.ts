import type { Node, Edge } from "reactflow";
import { BLOCK_BY_KIND } from "./blocks";
import {
  ATTACH_HANDLE, APPLIES_HANDLE, roleOf, flowEdges, isAttachEdge, isAttached,
} from "./graph";
import type { BlockKind } from "./model";

/** La nature du workflow dont on lit le plan. Elle change ce qui compte comme
 *  une étape — voir `inProcedure`. */
export type OutlineKind = "procedure" | "automation";

// Le PLAN : la même procédure, lue comme un document.
//
// L'éditeur était un canevas. Un canevas dit très bien « ceci puis cela », et
// très mal ce qu'une procédure est réellement : un texte, numéroté, où les
// branches sont indentées sous la question qui les ouvre. On finissait par
// écrire la procédure dans un panneau latéral et par la RELIRE dans l'onglet
// Document — deux surfaces pour une seule chose, et le canevas ne servait plus
// qu'à tracer des flèches entre des cartes qu'on ne lisait pas.
//
// Ce module ne remplace pas le modèle : il le TRADUIT. Le graphe reste la
// vérité — c'est lui que le compilateur partagé lit, c'est lui que l'assistant
// écrit quand on lui demande un workflow. Ce fichier en dérive un plan
// arborescent pour l'affichage, et applique les modifications directement sur
// le graphe, une opération à la fois.
//
// Pourquoi des opérations chirurgicales plutôt qu'une reconstruction du graphe
// depuis l'arbre : une reconstruction efface tout ce que le plan ne sait pas
// représenter — une branche qui reboucle, un bloc qu'un agent vient d'ajouter
// et que l'écran n'a pas encore lu. Une insertion qui ne touche que deux arêtes
// ne peut pas faire ça.

// ── Le plan ──────────────────────────────────────────────────────────────────

export interface OutlineLeg {
  /** Le handle de sortie du bloc : "true"/"false" pour une décision, "body"
   *  pour une boucle. C'est lui qui identifie la branche dans le graphe. */
  handle: string;
  label: string;
  items: OutlineItem[];
}

export type OutlineItem =
  | { kind: "block"; node: Node; legs: OutlineLeg[] }
  /** La branche rejoint une suite déjà écrite ailleurs. Un document est linéaire,
   *  une procédure ne l'est pas toujours : plutôt que de recopier la même suite
   *  d'étapes sous deux branches, on renvoie vers elle. */
  | { kind: "jump"; target: Node };

export interface Outline {
  trigger: Node | null;
  /** Le cadre : entrées, objectif, exemples. Des sections, pas des étapes. */
  frames: Node[];
  /** Les qualifieurs laissés libres — ils deviennent leur propre section. */
  globals: Node[];
  /** La procédure elle-même, numérotée et indentée. */
  procedure: OutlineItem[];
  /** Ce que la marche n'a pas atteint : un bloc détaché de la chaîne. Il compile
   *  quand même (readingOrder les ramasse), donc l'écran doit le montrer plutôt
   *  que de le laisser exister sans être vu. */
  orphans: Node[];
}

/** Les branches d'un bloc, et le handle par lequel la suite continue APRÈS lui.
 *
 *  Une boucle a une branche (« à répéter ») et sa suite sort par `done` : c'est
 *  ainsi qu'on la lit, le corps indenté sous elle et la suite en dessous. Une
 *  décision a ses deux branches et sa suite sort du handle par défaut. */
export function legsOfKind(kind: string | undefined): { legs: Array<{ handle: string; label: string }>; after: string | null } {
  if (kind === "decision") {
    return { legs: [{ handle: "true", label: "SI" }, { handle: "false", label: "SINON" }], after: null };
  }
  if (kind === "loop") return { legs: [{ handle: "body", label: "RÉPÉTER" }], after: "done" };
  return { legs: [], after: null };
}

/**
 * Les blocs qui s'écrivent DANS la procédure, par opposition au cadre.
 *
 * Un contexte de portée locale en fait partie : il dit ce qu'il faut savoir à
 * cet endroit précis, et le compilateur l'imprime là.
 *
 * ⚠️ Le bloc `tool` change de NATURE selon le workflow, et c'est pour ça que
 * cette fonction connaît le `kind`. Dans une procédure, un outil est un
 * cadrage — « sers-toi de ça » — posé dans la phrase d'une étape. Dans une
 * AUTOMATISATION, il n'y a pas de phrase et personne pour la lire : l'appel
 * d'outil EST l'étape. Sans cette distinction, un outil ajouté à une
 * automatisation était bien câblé dans la chaîne, bien exécuté par le moteur,
 * et **invisible dans l'éditeur** — le seul écran qui aurait pu le montrer
 * (la bande de cadrage) ne s'affiche que pour les procédures. Autrement dit :
 * on ne pouvait pas ajouter d'étape à une automatisation.
 */
function inProcedure(n: Node, edges: Edge[], kind: OutlineKind): boolean {
  if (roleOf(n.type) === "action") return true;
  if (kind === "automation") return n.type === "tool" && !isAttached(edges, n.id);
  return n.type === "context"
    && String(n.data?.scope ?? "") === "local"
    && !isAttached(edges, n.id);
}

const flowOut = (edges: Edge[], id: string, handle: string | null): Edge[] =>
  flowEdges(edges).filter((e) => e.source === id && (e.sourceHandle ?? null) === handle);

/** Le plan complet. Déterministe : deux lectures du même graphe donnent le même
 *  document, sinon les numéros d'étape danseraient à chaque rendu. */
export function buildOutline(nodes: Node[], edges: Edge[], kind: OutlineKind = "procedure"): Outline {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const trigger = nodes.find((n) => n.type === "trigger") ?? null;
  const seen = new Set<string>();

  const walk = (startId: string | null, depth: number): OutlineItem[] => {
    const items: OutlineItem[] = [];
    let cursor: string | null = startId;
    // Garde-fou de profondeur ET de longueur : un graphe qui reboucle sur
    // lui-même ne doit pas faire tourner le rendu à l'infini.
    let guard = 0;
    while (cursor && guard++ < 400) {
      const node: Node | undefined = byId.get(cursor);
      if (!node) break;
      if (seen.has(cursor)) { items.push({ kind: "jump", target: node }); break; }
      seen.add(cursor);

      const { legs, after } = legsOfKind(node.type);
      if (inProcedure(node, edges, kind)) {
        items.push({
          kind: "block",
          node,
          legs: depth > 4 ? [] : legs.map((l) => ({
            ...l,
            items: walk(flowOut(edges, node.id, l.handle)[0]?.target ?? null, depth + 1),
          })),
        });
      }
      const nextEdges = after ? flowOut(edges, node.id, after) : [];
      const nextEdge: Edge | undefined = nextEdges[0] ?? flowOut(edges, node.id, null)[0];
      cursor = nextEdge ? nextEdge.target : null;
    }
    return items;
  };

  const procedure = walk(trigger?.id ?? null, 0);
  // Un graphe sans déclencheur (ou dont la chaîne part d'ailleurs) doit quand
  // même s'ouvrir : on repart de chaque racine restante.
  for (const n of nodes) {
    if (seen.has(n.id) || !inProcedure(n, edges, kind)) continue;
    const hasParent = flowEdges(edges).some((e) => e.target === n.id);
    if (!hasParent) procedure.push(...walk(n.id, 0));
  }

  const frames = nodes.filter((n) => roleOf(n.type) === "frame");
  // Ce qui est DANS la chaîne n'est pas du cadrage : sinon un outil
  // d'automatisation compterait deux fois.
  const globals = nodes.filter((n) =>
    roleOf(n.type) === "qualifier" && !isAttached(edges, n.id) && !inProcedure(n, edges, kind));
  const orphans = nodes.filter((n) => inProcedure(n, edges, kind) && !seen.has(n.id));
  return { trigger, frames, globals, procedure, orphans };
}

/** Les qualifieurs accrochés à une action, dans l'ordre où ils l'ont été. */
export function attachedTo(nodes: Node[], edges: Edge[], actionId: string): Node[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return edges
    .filter((e) => isAttachEdge(e) && e.target === actionId)
    .map((e) => byId.get(e.source))
    .filter(Boolean) as Node[];
}

// ── Écrire dans le graphe ────────────────────────────────────────────────────

export interface Graph { nodes: Node[]; edges: Edge[] }

const newId = (kind: string) => `${kind}-${Math.random().toString(36).slice(2, 9)}`;

const attachEdgeBetween = (q: string, a: string): Edge => ({
  id: `a-${q}-${a}`, source: q, target: a,
  sourceHandle: APPLIES_HANDLE, targetHandle: ATTACH_HANDLE,
} as Edge);

const flowEdgeBetween = (from: string, to: string, handle: string | null = null): Edge => ({
  id: `e-${from}-${handle ?? ""}-${to}`, source: from, target: to,
  sourceHandle: handle, targetHandle: null,
} as Edge);

/** Le dernier maillon de la chaîne principale — là où « ajouter à la fin »
 *  atterrit. On suit les continuations, jamais les branches : la fin d'un
 *  document n'est pas la fin de sa dernière branche. */
function chainEnd(nodes: Node[], edges: Edge[]): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let cursor: string | null = nodes.find((n) => n.type === "trigger")?.id ?? null;
  if (!cursor) return null;
  const seen = new Set<string>();
  for (let i = 0; i < 400 && cursor; i++) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    const { after } = legsOfKind(node.type);
    const next: Edge | undefined = (after ? flowOut(edges, cursor, after)[0] : undefined) ?? flowOut(edges, cursor, null)[0];
    if (!next) return cursor;
    cursor = next.target;
  }
  return cursor;
}

/**
 * Insérer un bloc, et le RACCORDER.
 *
 * Le raccordement est tout l'intérêt : un bloc posé sans arête existe dans le
 * graphe, compile en fin de document et n'apparaît nulle part où on l'attendait.
 * Trois points d'insertion, un par geste réel de l'utilisateur :
 *
 *   after   — sous une étape : il prend sa suite, l'étape pointe sur lui.
 *   leg     — en tête d'une branche vide, ou à la fin d'une branche.
 *   (rien)  — à la fin de la procédure.
 */
export function insertBlock(
  g: Graph,
  kind: BlockKind,
  at: { afterId?: string | null; legOf?: string | null; legHandle?: string | null } = {},
): { graph: Graph; id: string } {
  const def = BLOCK_BY_KIND.get(kind);
  const id = newId(kind);
  // La position n'a plus de sens dans un document, mais le graphe la stocke et
  // un bloc sans position casse tout consommateur qui la lit sans garde.
  const lowest = g.nodes.reduce((m, n) => Math.max(m, n.position?.y ?? 0), 60);
  const node = { id, type: kind, position: { x: 260, y: lowest + 120 }, data: { ...(def?.defaults ?? {}) } } as Node;

  const nodes = [...g.nodes, node];
  let edges = [...g.edges];

  if (at.legOf && at.legHandle) {
    const existing = flowOut(edges, at.legOf, at.legHandle)[0];
    edges = edges.filter((e) => e !== existing);
    edges.push(flowEdgeBetween(at.legOf, id, at.legHandle));
    if (existing) edges.push(flowEdgeBetween(id, existing.target));
    return { graph: { nodes, edges }, id };
  }

  const anchorId = at.afterId ?? chainEnd(g.nodes, g.edges);
  if (anchorId) {
    const anchor = g.nodes.find((n) => n.id === anchorId);
    // On se branche sur la CONTINUATION du bloc d appui, jamais sur une de ses
    // branches : insérer sous une boucle veut dire « après la boucle ». Le même
    // handle sert à CHERCHER la suite et à la REBRANCHER — en chercher un et
    // repartir sur un autre laisse une arête morte et un bloc en double.
    const handle = legsOfKind(anchor?.type).after ?? null;
    const existing = flowOut(edges, anchorId, handle)[0];
    edges = edges.filter((e) => e !== existing);
    edges.push(flowEdgeBetween(anchorId, id, handle));
    if (existing) edges.push(flowEdgeBetween(id, existing.target));
  }
  return { graph: { nodes, edges }, id };
}

/**
 * Retirer un bloc en REFERMANT la chaîne.
 *
 * Supprimer une étape au milieu d'une procédure et laisser un trou est la façon
 * la plus efficace de casser un workflow sans que rien ne le signale : tout ce
 * qui suivait devient orphelin et migre en fin de document. Donc le prédécesseur
 * est recousu sur le successeur, en gardant le handle par lequel il arrivait.
 */
export function removeBlock(g: Graph, id: string): Graph {
  const flow = flowEdges(g.edges);
  const incoming = flow.filter((e) => e.target === id);
  const node = g.nodes.find((n) => n.id === id);
  const { after } = legsOfKind(node?.type);
  const outgoing = (after ? flow.filter((e) => e.source === id && (e.sourceHandle ?? null) === after) : [])
    .concat(flow.filter((e) => e.source === id && (e.sourceHandle ?? null) === null));

  const edges = g.edges.filter((e) => e.source !== id && e.target !== id);
  for (const inc of incoming) {
    for (const out of outgoing) {
      if (inc.source === out.target) continue;
      if (edges.some((e) => e.source === inc.source && e.target === out.target && (e.sourceHandle ?? null) === (inc.sourceHandle ?? null))) continue;
      edges.push(flowEdgeBetween(inc.source, out.target, inc.sourceHandle ?? null));
    }
  }
  return { nodes: g.nodes.filter((n) => n.id !== id), edges };
}

/** Déplacer un bloc d'un cran dans sa liste. Implémenté comme un retrait suivi
 *  d'une insertion : une permutation d'arêtes « à la main » oublie toujours un
 *  cas (le premier, le dernier, celui qui ouvre une branche). */
export function moveBlock(g: Graph, id: string, dir: -1 | 1, kind: OutlineKind = "procedure"): Graph {
  const siblings = siblingChain(g, id, kind);
  const i = siblings.indexOf(id);
  if (i < 0) return g;
  const j = i + dir;
  if (j < 0 || j >= siblings.length) return g;

  const node = g.nodes.find((n) => n.id === id);
  if (!node) return g;
  const parentLeg = legEntryOf(g, id);
  const removed = removeBlock(g, id);
  const withNode: Graph = { nodes: [...removed.nodes, node], edges: removed.edges };

  if (dir === 1) {
    return insertBlock2(withNode, id, { afterId: siblings[j] });
  }
  // Vers le haut : on se replace AVANT le voisin, donc après son propre
  // prédécesseur — ou en tête de branche s'il n'y en a pas.
  const before = siblings[j - 1];
  if (before) return insertBlock2(withNode, id, { afterId: before });
  if (parentLeg) return insertBlock2(withNode, id, { legOf: parentLeg.parentId, legHandle: parentLeg.handle });
  return insertBlock2(withNode, id, { afterId: null });
}

/** `insertBlock` pour un nœud qui EXISTE déjà (les deux moitiés d'un
 *  déplacement). Même câblage, sans création. */
function insertBlock2(
  g: Graph, id: string,
  at: { afterId?: string | null; legOf?: string | null; legHandle?: string | null },
): Graph {
  let edges = [...g.edges];
  if (at.legOf && at.legHandle) {
    const existing = flowOut(edges, at.legOf, at.legHandle)[0];
    edges = edges.filter((e) => e !== existing);
    edges.push(flowEdgeBetween(at.legOf, id, at.legHandle));
    if (existing) edges.push(flowEdgeBetween(id, existing.target));
    return { nodes: g.nodes, edges };
  }
  const anchorId = at.afterId ?? chainEnd(g.nodes, edges);
  if (!anchorId || anchorId === id) return { nodes: g.nodes, edges };
  const anchor = g.nodes.find((n) => n.id === anchorId);
  const handle = legsOfKind(anchor?.type).after ?? null;
  const existing = flowOut(edges, anchorId, handle)[0];
  edges = edges.filter((e) => e !== existing);
  edges.push(flowEdgeBetween(anchorId, id, handle));
  if (existing) edges.push(flowEdgeBetween(id, existing.target));
  return { nodes: g.nodes, edges };
}

/** La branche qui contient ce bloc, s'il en ouvre une. */
function legEntryOf(g: Graph, id: string): { parentId: string; handle: string } | null {
  for (const e of flowEdges(g.edges)) {
    if (e.target !== id) continue;
    const h = e.sourceHandle ?? null;
    if (h && h !== "done") return { parentId: e.source, handle: h };
  }
  return null;
}

/** Les frères et sœurs de ce bloc, dans l'ordre, y compris lui. */
function siblingChain(g: Graph, id: string, kind: OutlineKind): string[] {
  const outline = buildOutline(g.nodes, g.edges, kind);
  const find = (items: OutlineItem[]): string[] | null => {
    const ids = items.filter((i) => i.kind === "block").map((i) => (i as { node: Node }).node.id);
    if (ids.includes(id)) return ids;
    for (const it of items) {
      if (it.kind !== "block") continue;
      for (const leg of it.legs) {
        const hit = find(leg.items);
        if (hit) return hit;
      }
    }
    return null;
  };
  return find(outline.procedure) ?? [];
}

export function attachQualifier(g: Graph, qualifierId: string, actionId: string): Graph {
  if (g.edges.some((e) => isAttachEdge(e) && e.source === qualifierId && e.target === actionId)) return g;
  return { nodes: g.nodes, edges: [...g.edges, attachEdgeBetween(qualifierId, actionId)] };
}

export function detachQualifier(g: Graph, qualifierId: string, actionId: string): Graph {
  return {
    nodes: g.nodes,
    edges: g.edges.filter((e) => !(isAttachEdge(e) && e.source === qualifierId && e.target === actionId)),
  };
}

/**
 * Changer un bloc de type sans le perdre.
 *
 * C'est le geste d'un éditeur de document : on écrit une ligne, on se rend
 * compte que c'est une condition, on la convertit. Le titre et le texte
 * survivent — ce sont eux qu'on vient d'écrire ; les champs propres au nouveau
 * type arrivent avec leurs valeurs par défaut. Les arêtes ne bougent pas : la
 * ligne reste à sa place dans la procédure.
 */
export function convertBlock(g: Graph, id: string, kind: BlockKind): Graph {
  const def = BLOCK_BY_KIND.get(kind);
  return {
    nodes: g.nodes.map((n) => {
      if (n.id !== id) return n;
      const d = (n.data ?? {}) as Record<string, unknown>;
      return { ...n, type: kind, data: { ...(def?.defaults ?? {}), label: d.label ?? "", body: d.body ?? "" } };
    }),
    edges: g.edges,
  };
}

/** Renvoyer une branche vers un bloc déjà écrit — le « aller à » d'un document.
 *  Une seule sortie par branche : la nouvelle destination remplace l'ancienne,
 *  sinon la branche partirait dans deux directions à la fois. */
export function setLegTarget(g: Graph, fromId: string, handle: string, targetId: string): Graph {
  const edges = g.edges.filter((e) => !(e.source === fromId && (e.sourceHandle ?? null) === handle && !isAttachEdge(e)));
  edges.push(flowEdgeBetween(fromId, targetId, handle));
  return { nodes: g.nodes, edges };
}

export function patchBlock(g: Graph, id: string, patch: Record<string, unknown>): Graph {
  return {
    nodes: g.nodes.map((n) => (n.id === id ? { ...n, data: { ...(n.data ?? {}), ...patch } } : n)),
    edges: g.edges,
  };
}

/**
 * Créer un qualifieur DÉJÀ attaché à une action — le geste que fait la pastille
 * insérée dans une phrase. Un bloc de cadrage créé libre puis attaché en deux
 * temps passe par un état où il vaut pour toute la procédure, ce qui est
 * exactement ce qu'on ne voulait pas dire.
 */
export function insertAttached(g: Graph, kind: BlockKind, actionId: string, data: Record<string, unknown> = {}): { graph: Graph; id: string } {
  const def = BLOCK_BY_KIND.get(kind);
  const id = newId(kind);
  const node = { id, type: kind, position: { x: 60, y: 60 }, data: { ...(def?.defaults ?? {}), ...data } } as Node;
  return {
    graph: { nodes: [...g.nodes, node], edges: [...g.edges, attachEdgeBetween(id, actionId)] },
    id,
  };
}
