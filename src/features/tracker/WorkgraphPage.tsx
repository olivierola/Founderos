import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactFlow, {
  Background, BackgroundVariant, Controls, Handle, Position, ReactFlowProvider,
  useEdgesState, useNodesState,
  type Edge, type Node, type NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import dagre from "dagre";
import {
  ArrowsClockwiseIcon, CheckIcon, FileTextIcon, FunnelIcon, GraphIcon, KanbanIcon,
  LightbulbIcon, NotePencilIcon, RobotIcon, SquaresFourIcon, StackIcon,
  SuitcaseSimpleIcon, TableIcon, UserIcon, XIcon, CrosshairIcon,
  MagnifyingGlassIcon, InfoIcon,
} from "@phosphor-icons/react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { MemberAvatar, memberName } from "./pickers";
import { EmptyState, Tabs, TextField } from "./ui";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { GraphIllustration } from "./illustrations";
import { HEALTH, fetchMembers, fetchWorkgraph, type GraphKind, type GraphNode } from "./model";

/**
 * Le Workgraph : la carte de ce que porte le service, en canvas.
 *
 * Trois niveaux — initiative → projet → epic — reliés par des arêtes, et une
 * lecture de gauche à droite qui va du POURQUOI au COMMENT.
 *
 * L'intérêt n'est pas décoratif : c'est de voir d'un coup quelle initiative
 * dépend d'un projet en difficulté. Aucune des listes ne le montre, puisqu'elles
 * présentent chaque niveau isolément — c'est précisément le lien qui porte
 * l'information, donc il doit être dessiné.
 *
 * Le placement est calculé par dagre plutôt que laissé à une simulation de
 * forces : une carte qu'on relit doit se retrouver au même endroit d'une
 * session à l'autre, et un moteur physique la redessine différemment à chaque
 * chargement.
 */

/**
 * Les huit familles de la carte, dans l'ordre où elles se contiennent.
 *
 * L'ordre n'est pas décoratif : c'est celui du filtre, et il apprend la
 * structure du produit à qui ne la connaît pas encore — une initiative porte
 * des projets, qui portent des cycles, des modules, des epics et des pages, qui
 * portent des work items. Les notes ferment la liste parce qu'elles ne
 * dépendent de rien.
 */
// `one` est l'étiquette de la CARTE, `label` celle du filtre. Une carte de
// projet portant « Projets » se lit comme une catégorie et non comme l'objet
// qu'on regarde ; un filtre au singulier laisse croire qu'on n'en verra qu'un.
//
// `meter` dit si le pourcentage a un sens : il n'en a un que pour ce qui
// AGRÈGE d'autres objets. Une page ou une note n'ont pas d'avancement, et un
// work item n'a que fait ou pas fait — une jauge à 0 % sur les trois donnerait
// à croire que rien n'avance.
const KIND = {
  initiative: { one: "Initiative", label: "Initiatives", icon: LightbulbIcon, color: "#6366f1", meter: true },
  project: { one: "Projet", label: "Projets", icon: SuitcaseSimpleIcon, color: "#0ea5e9", meter: true },
  cycle: { one: "Cycle", label: "Cycles", icon: ArrowsClockwiseIcon, color: "#14b8a6", meter: true },
  module: { one: "Module", label: "Modules", icon: StackIcon, color: "#f59e0b", meter: true },
  epic: { one: "Epic", label: "Epics", icon: SquaresFourIcon, color: "#8b5cf6", meter: true },
  page: { one: "Page", label: "Pages", icon: FileTextIcon, color: "#64748b", meter: false },
  issue: { one: "Work item", label: "Work items", icon: KanbanIcon, color: "#22c55e", meter: false },
  sticky: { one: "Note", label: "Notes", icon: NotePencilIcon, color: "#e879a6", meter: false },
  // Les deux familles qui TRAVAILLENT, à la fin : elles ne contiennent rien,
  // elles sont reliées à ce qu'elles portent. C'est aussi pour ça qu'elles
  // ferment la liste du filtre — on les ajoute à une carte déjà dressée pour
  // voir qui s'occupe de quoi, pas l'inverse.
  agent: { one: "Agent", label: "Agents", icon: RobotIcon, color: "#a855f7", meter: false },
  member: { one: "Membre", label: "Membres", icon: UserIcon, color: "#0ea5e9", meter: false },
} as const satisfies Record<
  GraphKind,
  { one: string; label: string; icon: unknown; color: string; meter: boolean }
>;

const KINDS = Object.keys(KIND) as GraphKind[];

/**
 * Ce qu'on montre à la première ouverture : TOUT.
 *
 * Le premier réglage n'en montrait que la charpente, pour éviter le nuage
 * illisible d'un espace à mille work items. C'était se tromper de problème :
 * une carte qui cache la moitié de ce qu'elle est censée cartographier n'a pas
 * l'air filtrée, elle a l'air vide — et la première réaction, légitime, est de
 * croire que rien n'a été chargé.
 *
 * La borne existe déjà ailleurs, et au bon endroit : le serveur ne renvoie que
 * les 300 work items les plus récemment touchés. Le filtre reste pour RESTREINDRE
 * volontairement, pas pour amputer par défaut.
 */
const DEFAULT_KINDS: GraphKind[] = KINDS;

type Member = { user_id: string; full_name: string | null; email: string | null };

interface CardData {
  node: GraphNode;
  lead: Member | undefined;
  onOpen?: () => void;
  /** Éteint par la recherche : présent, mais pas ce qu'on cherche. */
  dimmed?: boolean;
  /** Isole ce nœud et son voisinage. */
  onFocus?: () => void;
  focused?: boolean;
}

const NODE_W = 260;
const NODE_H = 92;

function layout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  // `LR` : la hiérarchie se lit horizontalement, comme dans Plane. `ranksep`
  // large pour que les courbes aient la place de se séparer visuellement.
  g.setGraph({ rankdir: "LR", ranksep: 120, nodesep: 28, marginx: 24, marginy: 24 });
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) if (e.source !== e.target) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p ? p.x - NODE_W / 2 : 0, y: p ? p.y - NODE_H / 2 : 0 } };
  });
}

export function WorkgraphPage({
  dashboardId, workspaceId, onOpenProject, onOpenAgent, onOpenNotes,
}: {
  dashboardId: string;
  workspaceId: string | null;
  onOpenProject: (id: string) => void;
  /** Ouvre la fiche d'un agent dans le tableau de service. */
  onOpenAgent?: (id: string) => void;
  /** Ouvre le mur de notes. */
  onOpenNotes?: () => void;
}) {
  const [mode, setMode] = useState<"graph" | "table">("graph");
  const [kinds, setKinds] = useState<GraphKind[]>(DEFAULT_KINDS);
  /**
   * Le nœud sur lequel on s'est focalisé : la carte ne montre plus que lui et
   * ce qu'il porte. C'est la réponse à « sur quoi travaille cette personne »,
   * qu'aucune liste ne donne d'un coup.
   */
  const [focus, setFocus] = useState<string | null>(null);
  /**
   * La recherche ATTÉNUE, elle ne filtre pas.
   *
   * Retirer les nœuds qui ne correspondent pas détruirait la structure — les
   * arêtes disparaîtraient avec eux, et on perdrait justement ce qu'on est venu
   * voir : où se trouve la chose cherchée dans l'ensemble. On la fait ressortir
   * en éteignant le reste.
   */
  const [query, setQuery] = useState("");

  const { data: graph, isLoading } = useQuery({
    // Les familles font partie de la clé : deux sélections différentes sont
    // deux jeux de données, pas deux filtrages du même.
    queryKey: ["pj_workgraph", dashboardId, kinds],
    queryFn: () => fetchWorkgraph(dashboardId, { kinds }),
  });
  const { data: members } = useQuery({
    queryKey: ["pj_members", workspaceId],
    enabled: !!workspaceId,
    queryFn: () => fetchMembers(workspaceId!),
  });

  const all = graph ?? [];

  /** Les nœuds qui répondent à la recherche. Vide = pas de recherche en cours. */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(
      all.filter((n) =>
        n.label.toLowerCase().includes(q) || n.sub_label.toLowerCase().includes(q),
      ).map((n) => n.node_id),
    );
  }, [all, query]);

  /**
   * Où mène un nœud.
   *
   * Rien de ce que porte le graphe n'a d'écran à soi, sauf les projets et les
   * agents : un cycle, un module, une page ou un work item se consultent DANS
   * leur projet. On remonte donc la chaîne des parents jusqu'au projet — c'est
   * l'information dont on dispose déjà, et elle évite d'ajouter une colonne à
   * la fonction pour redire ce que les arêtes savent.
   *
   * Une PERSONNE n'a pas de destination. Cliquer dessus restreint la carte à ce
   * qu'elle porte, ce qui est la seule chose qu'on veuille faire en la voyant.
   */
  const open = useCallback((node: GraphNode) => {
    if (node.node_kind === "project") { onOpenProject(node.node_id); return; }
    if (node.node_kind === "agent") { onOpenAgent?.(node.node_id); return; }
    if (node.node_kind === "sticky") { onOpenNotes?.(); return; }
    if (node.node_kind === "member") { setFocus(node.node_id); return; }

    // La remontée est BORNÉE : un parentage circulaire, qu'une saisie
    // malheureuse peut produire, ferait une boucle infinie sur un clic.
    const byId = new Map(all.map((n) => [n.node_id, n]));
    let cur: GraphNode | undefined = node;
    for (let hops = 0; cur && hops < 8; hops++) {
      if (cur.node_kind === "project") { onOpenProject(cur.node_id); return; }
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
  }, [all, onOpenProject, onOpenAgent, onOpenNotes]);

  /**
   * Les positions déplacées à la main.
   *
   * Elles vivent dans le navigateur, par dashboard et par personne : un
   * réagencement est une préférence de lecture, pas une donnée d'équipe. Le
   * pousser en base imposerait à tout le monde la disposition du dernier qui a
   * bougé une carte.
   *
   * Elles ne couvrent que les nœuds déplacés ; les autres restent placés par
   * dagre, ce qui laisse un nouveau projet apparaître à sa place logique au
   * lieu de se superposer à l'origine.
   */
  const storageKey = `pj-workgraph-${dashboardId}`;

  // Les positions retenues vivent dans une REF, pas dans l'état.
  //
  // C'est ce qui rend le glisser fluide. Dans l'état, chaque dépôt relançait le
  // `useMemo` qui reconstruit les nœuds — donc dagre sur tout le graphe — et
  // React Flow recevait un tableau de nœuds neuf. Le nœud qu'on venait de
  // lâcher repartait alors de la position calculée avant de sauter à la sienne,
  // ce qui se voit comme un à-coup à chaque déplacement.
  const movedRef = useRef<Record<string, { x: number; y: number }>>({});
  const [hasMoved, setHasMoved] = useState(false);
  // `version` ne sert qu'à forcer un recalcul quand on remet tout en place :
  // sans lui, effacer la ref ne préviendrait personne.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    try {
      movedRef.current = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    } catch {
      // Navigation privée ou contenu illisible : on repart d'un placement
      // calculé, ce qui est toujours valide.
      movedRef.current = {};
    }
    setHasMoved(Object.keys(movedRef.current).length > 0);
    setVersion((v) => v + 1);
  }, [storageKey]);

  const remember = useCallback((id: string, position: { x: number; y: number }) => {
    // Écriture SANS rendu : React Flow porte déjà la position à l'écran, et
    // remonter l'information au parent ne ferait que redessiner ce qui est
    // correct. Seul le drapeau du bouton « Replacer » change d'état, et une
    // seule fois.
    movedRef.current = { ...movedRef.current, [id]: position };
    try {
      localStorage.setItem(storageKey, JSON.stringify(movedRef.current));
    } catch { /* quota, navigation privée */ }
    setHasMoved(true);
  }, [storageKey]);

  const resetPositions = () => {
    movedRef.current = {};
    try { localStorage.removeItem(storageKey); } catch { /* idem */ }
    setHasMoved(false);
    setVersion((v) => v + 1);
  };

  const computed = useMemo(() => {
    // Le tri par famille est fait par le serveur ; il reste à couper les arêtes
    // qui pendraient dans le vide. Une flèche vers un nœud absent est un trait
    // qui ne mène nulle part, et dagre la traiterait comme une contrainte de
    // placement bien réelle.
    // Focalisé : le nœud, et TOUT son voisinage — ce qu'il contient, ce qu'il
    // porte, et ce qui le mentionne. Se limiter à ses propres liaisons
    // laisserait un agent seul au milieu du vide dès lors que c'est le work
    // item qui le désigne et non l'inverse.
    //
    // Garder le reste en grisé donnerait une carte plus chargée qu'avant le
    // clic, ce qui est l'inverse du geste demandé.
    const kept = focus
      ? (() => {
        const keep = new Set<string>([focus]);
        const self = all.find((n) => n.node_id === focus);
        for (const id of self?.link_ids ?? []) keep.add(id);
        if (self?.parent_id) keep.add(self.parent_id);
        for (const n of all) {
          if (n.parent_id === focus) keep.add(n.node_id);
          if ((n.link_ids ?? []).includes(focus)) keep.add(n.node_id);
        }
        return keep;
      })()
      : null;
    const visible = kept ? all.filter((n) => kept.has(n.node_id)) : all;
    const ids = new Set(visible.map((n) => n.node_id));

    const rfNodes: Node<CardData>[] = visible.map((n) => ({
      id: n.node_id,
      type: "workgraph",
      position: { x: 0, y: 0 },
      data: {
        node: n,
        lead: (members ?? []).find((m) => m.user_id === n.lead_id),
        // `null` = aucune recherche ; `false` = éteint par la recherche.
        dimmed: matches ? !matches.has(n.node_id) : false,
        onFocus: () => setFocus((cur) => (cur === n.node_id ? null : n.node_id)),
        focused: focus === n.node_id,
        // TOUT nœud mène quelque part. Une carte dont neuf familles sur dix ne
        // réagissent pas au clic se lit comme une image : on la regarde, on ne
        // s'en sert pas. Ce qui appartient à un projet y renvoie, un agent
        // renvoie à sa fiche, une note au mur de notes.
        onOpen: () => open(n),
      },
    }));

    const rfEdges: Edge[] = visible
      .filter((n) => n.parent_id && ids.has(n.parent_id))
      .map((n) => ({
        id: `${n.parent_id}-${n.node_id}`,
        source: n.parent_id!,
        target: n.node_id,
        // Bézier : les courbes se distinguent les unes des autres quand un nœud
        // en porte cinq, là où des traits droits se superposent en éventail.
        type: "default",
        animated: false,
        style: { stroke: "hsl(var(--border))", strokeWidth: 1.5 },
      }));

    // Les liaisons secondaires, tracées AUTREMENT : en pointillé et plus pâle.
    //
    // La distinction porte du sens. Un trait plein dit « appartient à » — c'est
    // la structure, elle ne bouge pas. Un pointillé dit « travaille sur »,
    // « est dans ce cycle » : un rattachement qui se défait sans rien casser.
    // Les tracer pareil donnerait une pelote où l'on ne saurait plus ce qui
    // tient l'édifice.
    for (const n of visible) {
      for (const target of n.link_ids ?? []) {
        if (!ids.has(target) || target === n.node_id) continue;
        const id = `link-${n.node_id}-${target}`;
        if (rfEdges.some((e) => e.id === id)) continue;
        rfEdges.push({
          id,
          source: n.node_id,
          target,
          type: "default",
          animated: false,
          style: {
            stroke: KIND[n.node_kind].color,
            strokeWidth: 1.2,
            strokeDasharray: "4 4",
            opacity: 0.55,
          },
        });
      }
    }

    // Dagre place tout, puis les positions retenues écrasent les siennes pour
    // les seuls nœuds que quelqu'un a déplacés.
    const saved = movedRef.current;
    const placed = layout(rfNodes, rfEdges).map((n) =>
      (saved[n.id] ? { ...n, position: saved[n.id] } : n));

    return { nodes: placed, edges: rfEdges };
    // `movedRef` est volontairement absent des dépendances : une ref ne
    // déclenche pas de rendu, et c'est `version` qui dit quand la relire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, members, open, focus, matches, version]);

  // React Flow tient les nœuds pendant l'interaction : c'est lui qui applique
  // les deltas de déplacement image par image. On ne lui repasse un tableau
  // complet que lorsque la FORME du graphe change — des données rechargées, un
  // filtre, une remise à plat.
  const [nodes, setNodes, onNodesChange] = useNodesState<CardData>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);

  useEffect(() => {
    setNodes(computed.nodes);
    setEdges(computed.edges);
  }, [computed, setNodes, setEdges]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
        <GraphIcon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-14 font-medium">Workgraph</h2>

        {/* Huit familles ne tiennent pas en onglets : ce serait une barre plus
            large que le canvas, et surtout on veut en cocher PLUSIEURS — la
            carte sert à voir des rattachements, donc au moins deux niveaux. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="ml-3 flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-12 text-secondary hover:bg-muted hover:text-foreground">
              <FunnelIcon className="h-3.5 w-3.5" />
              {kinds.length === KINDS.length
                ? "Tout"
                : kinds.length === 1
                  ? KIND[kinds[0]].label
                  : `${kinds.length} familles`}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            {KINDS.map((k) => {
              const on = kinds.includes(k);
              const Icon = KIND[k].icon;
              return (
                <DropdownMenuItem
                  key={k}
                  // On garde le menu ouvert : cocher trois familles doit être
                  // trois clics, pas trois ouvertures du même menu.
                  onSelect={(e) => {
                    e.preventDefault();
                    setKinds((prev) => {
                      const next = on ? prev.filter((x) => x !== k) : [...prev, k];
                      // Jamais rien : un canvas vide n'est pas un filtre, c'est
                      // une panne apparente.
                      return next.length ? next : prev;
                    });
                  }}
                >
                  {on ? <CheckIcon className="h-3.5 w-3.5" /> : <span className="w-3.5" />}
                  <Icon className="h-3.5 w-3.5" style={{ color: KIND[k].color }} />
                  {KIND[k].label}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setKinds(KINDS); }}>
              <span className="w-3.5" /> Tout afficher
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setKinds(DEFAULT_KINDS); }}>
              <span className="w-3.5" /> La charpente seule
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* La recherche est PERMANENTE, pas repliée derrière une loupe : sur une
            carte de deux cents nœuds, retrouver un nom est l'usage principal,
            pas un usage secondaire. */}
        <div className="relative ml-3 w-52">
          <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-tertiary" />
          <TextField
            size="xs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Chercher dans la carte…"
            className="pl-8"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-tertiary hover:text-foreground"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Le compteur porte sur ce qui est AFFICHÉ, filtres et focus compris :
            annoncer le total pendant qu'on regarde un sous-ensemble ferait
            douter du filtre. */}
        <span className="shrink-0 whitespace-nowrap text-11 tabular-nums text-tertiary">
          {nodes.length} nœud{nodes.length > 1 ? "s" : ""}
          {matches ? ` · ${matches.size} trouvé${matches.size > 1 ? "s" : ""}` : ""}
        </span>

        <div className="flex-1" />

        {/* Dix familles, dix couleurs : sans légende, elles ne veulent rien
            dire. Repliée, parce qu'on la consulte une fois puis on la retient. */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              title="Légende"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-tertiary hover:bg-muted hover:text-foreground"
            >
              <InfoIcon className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-3">
            <p className="pb-2 text-11 font-semibold uppercase tracking-wide text-tertiary">
              Familles
            </p>
            <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {KINDS.map((k) => (
                <li key={k} className="flex items-center gap-1.5 text-12">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: KIND[k].color }}
                  />
                  <span className="min-w-0 truncate">{KIND[k].label}</span>
                </li>
              ))}
            </ul>

            <p className="pb-2 pt-3 text-11 font-semibold uppercase tracking-wide text-tertiary">
              Traits
            </p>
            <ul className="space-y-1.5 text-11 leading-snug text-secondary">
              <li className="flex items-center gap-2">
                <svg width="26" height="6" className="shrink-0" aria-hidden>
                  <line x1="0" y1="3" x2="26" y2="3" stroke="hsl(var(--border))" strokeWidth="1.5" />
                </svg>
                Appartient à — la structure.
              </li>
              <li className="flex items-center gap-2">
                <svg width="26" height="6" className="shrink-0" aria-hidden>
                  <line
                    x1="0" y1="3" x2="26" y2="3"
                    stroke="hsl(var(--muted-foreground))" strokeWidth="1.5" strokeDasharray="4 4"
                  />
                </svg>
                Travaille sur — ça se défait.
              </li>
            </ul>
          </PopoverContent>
        </Popover>

        {/* Visible seulement s'il y a quelque chose à réinitialiser : un bouton
            qui ne fait rien neuf fois sur dix apprend à être ignoré. */}
        {focus && (
          <button
            type="button"
            onClick={() => setFocus(null)}
            className="flex items-center gap-1.5 rounded-md bg-primary/10 px-2.5 py-1 text-12 font-medium text-primary hover:bg-primary/20"
          >
            {all.find((n) => n.node_id === focus)?.label ?? "Focus"}
            <XIcon className="h-3.5 w-3.5" />
          </button>
        )}

        {mode === "graph" && hasMoved && (
          <button
            type="button"
            onClick={resetPositions}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-12 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ArrowsClockwiseIcon className="h-3.5 w-3.5" /> Replacer
          </button>
        )}

        <Tabs
          value={mode} onChange={setMode}
          options={[
            { key: "graph" as const, label: "Graph" },
            { key: "table" as const, label: "Table" },
          ]}
        />
      </header>

      <div className="min-h-0 flex-1">
        {isLoading ? (
          // Un canevas vide pendant le chargement se lit comme « il n'y a
          // rien » : le même écran que l'état vide, pour un sens opposé.
          <div className="flex h-full items-center justify-center gap-2 text-13 text-tertiary">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-border border-t-primary" />
            Construction de la carte…
          </div>
        ) : !all.length ? (
          <EmptyState
            illustration={<GraphIllustration className="w-full" />}
            title="Rien à cartographier"
            hint="La carte se dessine dès qu'il existe un lien à montrer : une initiative qui porte des projets, un projet qui porte des epics. Sans rattachement, il n'y a que des points isolés."
          />
        ) : mode === "table" ? (
          <div className="h-full overflow-auto p-4">
            <GraphTable nodes={all} members={members ?? []} onOpen={open} />
          </div>
        ) : (
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              nodeTypes={NODE_TYPES}
              fitView
              minZoom={0.2}
              maxZoom={1.6}
              proOptions={{ hideAttribution: true }}
              nodesDraggable
              // Déplacer un nœud réagence la LECTURE ; en relier deux
              // changerait les données. Le graphe reflète les rattachements
              // réels (initiative → projet → epic), qui se modifient dans les
              // écrans concernés, pas en tirant un trait ici.
              nodesConnectable={false}
              onNodeDragStop={(_, node) => remember(node.id, node.position)}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="opacity-40" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </ReactFlowProvider>
        )}
      </div>
    </div>
  );
}

/**
 * La carte d'un nœud. Les `Handle` sont invisibles mais indispensables : sans
 * eux React Flow n'a pas de point d'ancrage et les arêtes partent du coin
 * supérieur gauche.
 */
function WorkgraphCard({ data }: NodeProps<CardData>) {
  const { node, lead, onOpen, dimmed, onFocus, focused } = data;
  const meta = KIND[node.node_kind];
  const Icon = meta.icon;
  const health = HEALTH.find((h) => h.key === node.health);

  return (
    <div
      style={{ width: NODE_W }}
      // Le curseur et le liseré au survol disent que la carte MÈNE quelque
      // part. Sans eux, on la prend pour une étiquette et on ne clique jamais.
      className={cn(
        "group/node cursor-pointer rounded-lg border bg-background p-2.5 shadow-sm transition-all",
        focused ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-foreground/25",
        // Éteint, pas masqué : on doit continuer à voir OÙ se trouve ce qu'on
        // cherche dans l'ensemble, donc la structure reste dessinée.
        dimmed && "opacity-25",
      )}
      onDoubleClick={onOpen}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />

      <div className="flex items-center gap-1.5 pb-1.5">
        <span
          className="inline-flex h-5 shrink-0 items-center rounded-md px-2 text-11 font-medium leading-none"
          style={{ background: `${meta.color}22`, color: meta.color }}
        >
          {meta.one}
        </span>
        {node.sub_label && (
          <span className="truncate font-mono text-10 text-muted-foreground">{node.sub_label}</span>
        )}
        <div className="flex-1" />
        {/* Isoler : le geste central d'un graphe dense. Il répond à « que tient
            cet objet » sans quitter la carte, là où ouvrir la fiche fait
            changer d'écran et perdre le contexte qu'on venait lire. */}
        <button
          type="button"
          title={focused ? "Tout réafficher" : "Isoler ce nœud et ses liens"}
          onClick={(e) => { e.stopPropagation(); onFocus?.(); }}
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded transition-opacity",
            focused
              ? "bg-primary/15 text-primary"
              : "text-tertiary opacity-0 hover:bg-muted hover:text-foreground group-hover/node:opacity-100",
          )}
        >
          <CrosshairIcon className="h-3.5 w-3.5" />
        </button>

        {/* Le pourcentage est écrit ET tracé : un arc de dix pixels ne se lit
            pas au chiffre près. */}
        {meta.meter && (
          <span className="flex shrink-0 items-center gap-1 text-10 tabular-nums text-muted-foreground">
            <span className="h-1.5 w-7 rounded-full bg-muted">
              <span
                className="block h-full rounded-full"
                style={{ width: `${node.percent}%`, background: meta.color }}
              />
            </span>
            {node.percent}%
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <Icon className="h-4 w-4 shrink-0" style={{ color: meta.color }} />
        <span className="min-w-0 flex-1 truncate text-13 hover:underline">{node.label}</span>
      </button>

      <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
        {health && (
          <span
            className="flex items-center gap-1 inline-flex h-5 items-center rounded-full px-2 text-11 font-medium leading-none"
            style={{ background: `${health.color}1f`, color: health.color }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: health.color }} />
            {health.label}
          </span>
        )}
        {node.status && (
          <span className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-11 font-medium leading-none text-muted-foreground">
            {node.status}
          </span>
        )}
        {lead && (
          <span className="flex items-center gap-1 text-10 text-muted-foreground">
            <MemberAvatar member={lead} size={14} /> {memberName(lead)}
          </span>
        )}
      </div>
    </div>
  );
}

const NODE_TYPES = { workgraph: WorkgraphCard };

/**
 * La carte en TABLE.
 *
 * Ce n'est pas un repli pour petits écrans : c'est l'autre façon de lire le
 * même contenu. Le graphe répond à « qu'est-ce qui tient à quoi », la table à
 * « qu'est-ce qu'il y a, et combien » — on y trie, on y compte, on y cherche
 * une ligne précise. Les deux vues portent donc les MÊMES données, jamais un
 * sous-ensemble.
 *
 * Les colonnes s'adaptent au contenu : « Santé » et « Avancement » n'ont aucun
 * sens pour une note ou une personne, et une colonne vide sur huit lignes sur
 * dix se lit comme une donnée manquante plutôt que comme une donnée qui
 * n'existe pas.
 */
function GraphTable({
  nodes, members, onOpen,
}: {
  nodes: GraphNode[];
  members: Member[];
  onOpen: (node: GraphNode) => void;
}) {
  const [sort, setSort] = useState<"kind" | "name" | "percent">("kind");

  const rows = useMemo(() => {
    const order = KINDS.reduce<Record<string, number>>((acc, k, i) => ({ ...acc, [k]: i }), {});
    return [...nodes].sort((a, b) => {
      if (sort === "name") return a.label.localeCompare(b.label);
      if (sort === "percent") return b.percent - a.percent;
      return (order[a.node_kind] - order[b.node_kind]) || a.label.localeCompare(b.label);
    });
  }, [nodes, sort]);

  // On ne montre une colonne que si au moins une ligne la remplit.
  const hasHealth = rows.some((n) => n.health);
  const hasLead = rows.some((n) => n.lead_id);
  const hasMeter = rows.some((n) => KIND[n.node_kind].meter);

  const Th = ({ onClick, align, children }: {
    onClick?: () => void; align?: "right"; children: React.ReactNode;
  }) => (
    <th className={cn("py-2 font-medium", align === "right" && "text-right")}>
      {onClick
        ? <button type="button" onClick={onClick} className="hover:text-foreground">{children}</button>
        : children}
    </th>
  );

  return (
    <table className="w-full text-14">
      <thead>
        <tr className="border-b border-border text-left text-12 text-tertiary">
          <Th onClick={() => setSort("name")}>Nom</Th>
          <Th onClick={() => setSort("kind")}>Type</Th>
          <Th>Référence</Th>
          {hasHealth && <Th>Santé</Th>}
          {hasLead && <Th>Responsable</Th>}
          {hasMeter && <Th onClick={() => setSort("percent")} align="right">Avancement</Th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((n) => {
          const meta = KIND[n.node_kind];
          const health = HEALTH.find((h) => h.key === n.health);
          const lead = members.find((m) => m.user_id === n.lead_id);
          return (
            <tr
              key={`${n.node_kind}-${n.node_id}`}
              className="border-b border-border/40 hover:bg-muted/30"
            >
              <td className="py-2">
                {/* TOUTE ligne est cliquable, comme dans le graphe : n'en
                    rendre qu'une famille active obligeait à repasser en mode
                    carte pour ouvrir le reste. */}
                <button
                  type="button"
                  onClick={() => onOpen(n)}
                  className="flex items-center gap-2 text-left hover:underline"
                >
                  <meta.icon className="h-4 w-4 shrink-0" style={{ color: meta.color }} />
                  {n.label}
                </button>
              </td>
              <td className="py-2 text-12 text-tertiary">{meta.one}</td>
              <td className="py-2 font-mono text-11 text-placeholder">{n.sub_label || "—"}</td>
              {hasHealth && (
                <td className="py-2 text-12" style={{ color: health?.color }}>
                  {health?.label ?? "—"}
                </td>
              )}
              {hasLead && (
                <td className="py-2 text-12 text-tertiary">{lead ? memberName(lead) : "—"}</td>
              )}
              {hasMeter && (
                <td className="py-2 text-right tabular-nums">
                  {meta.meter ? `${n.percent}%` : "—"}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
