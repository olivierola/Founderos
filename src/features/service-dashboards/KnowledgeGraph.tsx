import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  forceSimulation, forceLink, forceManyBody, forceCollide, forceCenter, forceX, forceY,
  type SimulationNodeDatum, type SimulationLinkDatum, type Simulation,
} from "d3-force";
import {
  MagnifyingGlassIcon as Search,
  XIcon as X,
  CircleNotchIcon as Loader2,
  TrashIcon as Trash,
  PlusIcon as Plus,
  MinusIcon as Minus,
  CornersOutIcon as CornersOut,
  ArrowsClockwiseIcon as Import,
  GraphIcon,
  RobotIcon as Bot,
  UserIcon as UserI,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ToastProvider";

/**
 * Le graphe de connaissances de l'espace (0289) : ce que TOUS les agents
 * savent, rangé par entités nommées (personnes, clients, produits, systèmes…),
 * leurs faits et leurs relations. Les agents l'alimentent (knowledge_save, et
 * le curateur en fin de run, derrière un modèle de décision) ; ici, on le lit,
 * on le cherche et on le corrige.
 */

interface Entity {
  id: string; name: string; kind: string; summary: string | null; aliases: string[];
  tags?: string[]; importance: number; mentions: number; updated_at: string;
}
/** `kind` absent = relation saisie (knowledge_relations) ; sinon lien déduit. */
interface Relation { id: string; from_entity: string; to_entity: string; relation: string; kind?: "owns" | "knows" | "mention" | "topic" }
interface Fact {
  id: string; statement: string; kind: string; importance: number; source_kind: string;
  source_agent_id: string | null; created_at: string; superseded_by: string | null;
}

export const KIND_META: Record<string, { label: string; color: string }> = {
  person: { label: "Personnes", color: "#14b8a6" },
  organization: { label: "Organisations", color: "#6366f1" },
  customer: { label: "Clients", color: "#f59e0b" },
  product: { label: "Produits", color: "#ec4899" },
  project: { label: "Projets", color: "#8b5cf6" },
  system: { label: "Systèmes", color: "#06b6d4" },
  document: { label: "Documents", color: "#64748b" },
  process: { label: "Procédures", color: "#10b981" },
  decision: { label: "Décisions", color: "#ef4444" },
  place: { label: "Lieux", color: "#84cc16" },
  event: { label: "Événements", color: "#f97316" },
  concept: { label: "Concepts", color: "#3b82f6" },
};
/** Les couches de la mémoire brute des agents, posées dans le même graphe. */
export const MEMORY_META: Record<string, { label: string; color: string }> = {
  agent: { label: "Agents", color: "#a78bfa" },
  memory: { label: "Souvenirs", color: "#94a3b8" },
  artifact: { label: "Livrables", color: "#eab308" },
  asset: { label: "Éléments", color: "#22c55e" },
  topic: { label: "Sujets", color: "#d946ef" },
};
const colorOf = (k: string) => KIND_META[k]?.color ?? MEMORY_META[k]?.color ?? "#64748b";

/** Un souvenir, un livrable ou un élément du service, tel que l'écran Mémoire le reçoit. */
export interface MemoryNodeRow { id: string; agent_id: string | null; kind: string; content: string; created_at: string }
const ASSET_KINDS = new Set(["repo", "link", "file", "person", "tool", "note", "doc", "url", "dataset"]);
const layerOf = (k: string) => (k === "artifact" ? "artifact" : ASSET_KINDS.has(k) ? "asset" : "memory");
const isPseudo = (id: string) => id.startsWith("mem:") || id.startsWith("ag:") || id.startsWith("tk:");

/** Minuscules sans accents, pour chercher un nom dans un texte. */
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const WORD = /[\p{L}\p{N}]/u;
/** `term` apparaît dans `text` comme mot entier (pas « api » dans « rapide »). */
function cites(text: string, term: string): boolean {
  if (term.length < 3) return false;
  for (let i = text.indexOf(term); i !== -1; i = text.indexOf(term, i + 1)) {
    const before = text[i - 1], after = text[i + term.length];
    if ((!before || !WORD.test(before)) && (!after || !WORD.test(after))) return true;
  }
  return false;
}
/** Clés de ticket ou de mission (ORBIT-14, BBJK-10) : ce qui relie des livrables entre eux. */
const TOPIC_RE = /\b[A-Z][A-Z0-9]{1,11}-\d{1,6}\b/g;

/** `hub` : nœud central (agent, carrefour, entité importante), le seul nommé par défaut. */
interface Node extends SimulationNodeDatum { id: string; e: Entity; r: number; hub?: boolean }
interface Link extends SimulationLinkDatum<Node> { id: string; relation: string; kind?: Relation["kind"] }

export function KnowledgeGraph({ workspaceId, agents, memories = [] }: {
  workspaceId: string;
  agents: Array<{ id: string; name: string }>;
  /** La mémoire brute des agents (souvenirs, livrables, éléments) : rangée dans
   *  le même graphe, reliée à l'agent qui la porte. Une seule mémoire à lire. */
  memories?: MemoryNodeRow[];
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [kind, setKind] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // Sans requête : les entités les plus utiles de l'espace. Avec : la même
  // recherche que celle des agents (knowledge_search), pour que ce qu'on voit
  // ici soit ce qu'ils trouvent.
  const { data: entities = [], isLoading } = useQuery({
    queryKey: ["kg_entities", workspaceId, debounced, kind],
    queryFn: async () => {
      if (debounced) {
        const { data, error } = await supabase.rpc("knowledge_search", {
          p_workspace: workspaceId, p_query: debounced, p_kind: kind, p_limit: 50,
        });
        if (error) throw error;
        return (data ?? []) as Entity[];
      }
      if (kind && MEMORY_META[kind]) return [] as Entity[];
      let q = supabase.from("knowledge_entities")
        .select("id, name, kind, summary, aliases, tags, importance, mentions, updated_at")
        .eq("workspace_id", workspaceId)
        .order("importance", { ascending: false }).order("mentions", { ascending: false }).limit(300);
      if (kind) q = q.eq("kind", kind);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Entity[];
    },
  });

  const { data: relations = [] } = useQuery({
    queryKey: ["kg_relations", workspaceId],
    queryFn: async () => {
      const { data } = await supabase.from("knowledge_relations")
        .select("id, from_entity, to_entity, relation").eq("workspace_id", workspaceId).limit(2000);
      return (data ?? []) as Relation[];
    },
  });

  // Qui sait quoi : les agents derrière les faits (et les entités qu'ils ont
  // créées). C'est ce qui rattache une entité aux agents et à leurs souvenirs.
  const { data: provenance = [] } = useQuery({
    queryKey: ["kg_provenance", workspaceId],
    queryFn: async () => {
      const [facts, created] = await Promise.all([
        supabase.from("knowledge_facts").select("entity_id, source_agent_id")
          .eq("workspace_id", workspaceId).is("superseded_by", null).not("source_agent_id", "is", null).limit(5000),
        supabase.from("knowledge_entities").select("id, created_by_agent")
          .eq("workspace_id", workspaceId).not("created_by_agent", "is", null).limit(2000),
      ]);
      const pairs = new Set<string>();
      for (const f of (facts.data ?? []) as Array<{ entity_id: string; source_agent_id: string }>) pairs.add(`${f.source_agent_id}|${f.entity_id}`);
      for (const e of (created.data ?? []) as Array<{ id: string; created_by_agent: string }>) pairs.add(`${e.created_by_agent}|${e.id}`);
      return [...pairs].map((p) => { const [agent, entity] = p.split("|"); return { agent, entity }; });
    },
  });

  const { data: counts } = useQuery({
    queryKey: ["kg_counts", workspaceId],
    queryFn: async () => {
      const [{ count: e }, { count: f }] = await Promise.all([
        supabase.from("knowledge_entities").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId),
        supabase.from("knowledge_facts").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).is("superseded_by", null),
      ]);
      return { entities: e ?? 0, facts: f ?? 0 };
    },
  });

  const refresh = () => {
    for (const k of ["kg_entities", "kg_relations", "kg_provenance", "kg_counts", "kg_entity"]) queryClient.invalidateQueries({ queryKey: [k] });
  };

  async function importMemory() {
    setImporting("Démarrage…");
    try {
      let total = 0;
      for (let i = 0; i < 40; i++) {
        const r = await callEdge<{ ok: boolean; processed: number; remaining: number; saved: number; error?: string }>(
          "internal-agent-run", { mode: "knowledge_backfill", workspace_id: workspaceId },
        );
        if (!r.ok) throw new Error(r.error ?? "échec");
        total += r.saved ?? 0;
        setImporting(`${total} fait(s) gardé(s) · ${r.remaining} souvenir(s) restant(s)`);
        refresh();
        if (!r.processed || !r.remaining) break;
      }
      toast.success("Mémoire importée", `${total} fait(s) retenu(s) par le modèle de décision.`);
    } catch (e) {
      toast.error("Import interrompu", e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(null);
    }
  }

  // La mémoire brute rejoint le graphe : chaque souvenir, livrable ou élément
  // est un nœud, relié à l'agent qui le porte. Les relations saisies ne
  // suffisent pas à tout relier ; on ajoute les liens que les données portent
  // déjà : l'agent qui a appris un fait sur une entité, le souvenir qui cite
  // une entité, et les éléments qui partagent une clé de ticket (ORBIT-14).
  const { allEntities, allRelations } = useMemo(() => {
    const showLayer = (l: string) => !kind || kind === l;
    const q = debounced.toLowerCase();
    const extra: Entity[] = [];
    const links: Relation[] = [];
    const agentsUsed = new Set<string>();
    const memNodes: Array<{ id: string; text: string; raw: string }> = [];
    if (!kind || MEMORY_META[kind]) {
      for (const m of memories) {
        const layer = layerOf(m.kind);
        if (!showLayer(layer)) continue;
        if (q && !m.content.toLowerCase().includes(q)) continue;
        const id = `mem:${m.id}`;
        extra.push({ id, name: m.content.replace(/\s+/g, " ").slice(0, 60), kind: layer, summary: m.content, aliases: [], importance: 1, mentions: 0, updated_at: m.created_at });
        memNodes.push({ id, text: norm(m.content), raw: m.content });
        if (m.agent_id) {
          agentsUsed.add(m.agent_id);
          links.push({ id: `l:${id}`, from_entity: `ag:${m.agent_id}`, to_entity: id, relation: layer === "artifact" ? "a produit" : "retient", kind: "owns" });
        }
      }
    }

    // Agent → entité : il a appris (ou créé) quelque chose dessus.
    if (!kind) {
      const shown = new Set(entities.map((e) => e.id));
      const known = new Set(agents.map((a) => a.id));
      for (const p of provenance) {
        if (!shown.has(p.entity) || !known.has(p.agent)) continue;
        agentsUsed.add(p.agent);
        links.push({ id: `k:${p.agent}:${p.entity}`, from_entity: `ag:${p.agent}`, to_entity: p.entity, relation: "sait", kind: "knows" });
      }
    }
    if (!kind || MEMORY_META[kind]) {
      for (const a of agents) {
        if (!agentsUsed.has(a.id) && kind !== "agent") continue;
        extra.push({ id: `ag:${a.id}`, name: a.name, kind: "agent", summary: null, aliases: [], importance: 4, mentions: 10, updated_at: "" });
      }
    }

    // Souvenir ou livrable → entité qu'il cite par son nom ou un alias ;
    // entité → entité citée dans son résumé.
    const terms = entities.map((e) => ({ id: e.id, terms: [e.name, ...(e.aliases ?? [])].map(norm).filter((t) => t.length >= 3) }));
    for (const m of memNodes) {
      for (const e of terms) {
        if (e.terms.some((t) => cites(m.text, t))) links.push({ id: `m:${m.id}:${e.id}`, from_entity: m.id, to_entity: e.id, relation: "cite", kind: "mention" });
      }
    }
    const explicit = new Set(relations.map((r) => [r.from_entity, r.to_entity].sort().join("|")));
    for (const a of entities) {
      if (!a.summary) continue;
      const text = norm(a.summary);
      for (const b of terms) {
        if (b.id === a.id || explicit.has([a.id, b.id].sort().join("|"))) continue;
        if (b.terms.some((t) => cites(text, t))) links.push({ id: `s:${a.id}:${b.id}`, from_entity: a.id, to_entity: b.id, relation: "cite", kind: "mention" });
      }
    }

    // Clé de ticket partagée par au moins deux éléments : un nœud « sujet ».
    const byKey = new Map<string, string[]>();
    for (const m of memNodes) {
      for (const key of new Set(m.raw.match(TOPIC_RE) ?? [])) byKey.set(key, [...(byKey.get(key) ?? []), m.id]);
    }
    const entityByName = new Map(entities.map((e) => [norm(e.name), e.id]));
    for (const [key, ids] of byKey) {
      if (ids.length < 2) continue;
      let hub = entityByName.get(norm(key));
      if (!hub) {
        hub = `tk:${key}`;
        extra.push({ id: hub, name: key, kind: "topic", summary: `${key} : cité par ${ids.length} élément(s).`, aliases: [], importance: 2, mentions: ids.length, updated_at: "" });
      }
      for (const id of ids) links.push({ id: `t:${key}:${id}`, from_entity: id, to_entity: hub, relation: "concerne", kind: "topic" });
    }

    // Un seul trait par paire, la relation saisie d'abord.
    const seen = new Set<string>();
    const allRelations = [...relations, ...links].filter((r) => {
      const pair = [r.from_entity, r.to_entity].sort().join("|");
      if (r.from_entity === r.to_entity || seen.has(pair)) return false;
      seen.add(pair);
      return true;
    });
    return { allEntities: [...entities, ...extra], allRelations };
  }, [entities, relations, provenance, memories, agents, kind, debounced]);

  const kindsPresent = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of allEntities) m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
    for (const r of memories) { const l = layerOf(r.kind); if (!m.has(l)) m.set(l, 0); }
    return m;
  }, [allEntities, memories]);

  return (
    <div className="flex h-full min-h-0">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <div className="relative w-72 max-w-full">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Chercher une personne, un client, un système…"
              className="h-8 w-full rounded-lg border border-border bg-background pl-8 pr-7 text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {Object.entries({ ...KIND_META, ...MEMORY_META }).filter(([k]) => k !== "topic" && (kindsPresent.has(k) || kind === k)).map(([k, m]) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(kind === k ? null : k)}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                  kind === k ? "border-foreground/30 bg-secondary text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: m.color }} />
                {m.label}{kindsPresent.get(k) ? ` ${kindsPresent.get(k)}` : ""}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            {counts && <span>{counts.entities} entité(s) · {counts.facts} fait(s)</span>}
            <Button size="sm" variant="outline" disabled={!!importing} onClick={() => void importMemory()}
              title="Fait passer les souvenirs existants des agents par le modèle de décision, qui range dans le graphe ce qui le mérite.">
              {importing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Import className="mr-1 h-3.5 w-3.5" />}
              {importing ?? "Importer la mémoire des agents"}
            </Button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          {isLoading ? (
            <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : allEntities.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <GraphIcon className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm font-medium">{debounced ? "Rien ne correspond." : "Le graphe de connaissances est vide."}</p>
              <p className="max-w-md text-xs text-muted-foreground">
                {debounced
                  ? "Les agents n'ont encore rien appris sous ce nom."
                  : "Les agents l'alimentent en travaillant : chaque information importante passe par un modèle de décision qui la nomme et la range. Importez aussi leur mémoire existante."}
              </p>
            </div>
          ) : (
            <ForceView entities={allEntities} relations={allRelations} selected={selected} onSelect={setSelected} />
          )}
        </div>
      </div>

      {selected && isPseudo(selected) && (
        <MemoryNodePanel
          key={selected}
          entity={allEntities.find((e) => e.id === selected) ?? null}
          agentName={(() => {
            const rel = allRelations.find((r) => r.to_entity === selected);
            const id = rel?.from_entity.replace(/^ag:/, "");
            return agents.find((a) => a.id === id)?.name ?? null;
          })()}
          onClose={() => setSelected(null)}
        />
      )}
      {selected && !isPseudo(selected) && (
        <EntityPanel
          key={selected}
          entityId={selected}
          agents={agents}
          onClose={() => setSelected(null)}
          onSelect={setSelected}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

/** Un souvenir, un livrable ou un agent : ce qu'il dit, qui le porte. */
function MemoryNodePanel({ entity, agentName, onClose }: { entity: Entity | null; agentName: string | null; onClose: () => void }) {
  if (!entity) return null;
  const meta = MEMORY_META[entity.kind];
  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-border/60 bg-background">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <span className="h-2 w-2 rounded-full" style={{ background: meta?.color }} />
        <span className="text-[12px] text-muted-foreground">{meta?.label ?? entity.kind}</span>
        <button type="button" onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[13px] leading-relaxed">
        <p className="whitespace-pre-wrap">{entity.summary ?? entity.name}</p>
        {agentName && <p className="mt-3 text-[12px] text-muted-foreground">{entity.kind === "artifact" ? "Produit par" : "Retenu par"} {agentName}</p>}
        {entity.updated_at && <p className="mt-1 text-[12px] text-muted-foreground">{new Date(entity.updated_at).toLocaleDateString("fr-FR")}</p>}
      </div>
    </aside>
  );
}

// ── The canvas ──────────────────────────────────────────────────────────────

function ForceView({ entities, relations, selected, onSelect }: {
  entities: Entity[]; relations: Relation[]; selected: string | null; onSelect: (id: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<Simulation<Node, Link> | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const [, setTick] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [panning, setPanning] = useState(false);
  const userMoved = useRef(false);
  const drag = useRef<{ mode: "pan" | "node"; node?: Node; startX: number; startY: number; vx: number; vy: number; moved: boolean } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { nodes, links } = useMemo(() => {
    const ids = new Set(entities.map((e) => e.id));
    const nodes: Node[] = entities.map((e) => ({ id: e.id, e, r: 6 + Math.min(e.importance, 5) * 1.6 + Math.min(e.mentions, 20) * 0.3 }));
    const links: Link[] = relations
      .filter((r) => ids.has(r.from_entity) && ids.has(r.to_entity))
      .map((r) => ({ id: r.id, source: r.from_entity, target: r.to_entity, relation: r.relation, kind: r.kind }));
    // Un nœud relié à beaucoup d'autres grossit un peu : les carrefours se voient.
    const degree = new Map<string, number>();
    for (const l of links) for (const id of [l.source, l.target] as string[]) degree.set(id, (degree.get(id) ?? 0) + 1);
    for (const n of nodes) n.r += Math.min(Math.sqrt(degree.get(n.id) ?? 0), 6) * 0.9;
    // Les plus reliés (top 8 %, au moins 4 liens), les agents, les entités
    // importantes et reliées. Souvenirs et livrables ne sont jamais centraux.
    const sorted = [...degree.values()].sort((a, b) => b - a);
    const cut = Math.max(4, sorted[Math.floor(sorted.length * 0.08)] ?? 4);
    for (const n of nodes) {
      const d = degree.get(n.id) ?? 0;
      const leaf = n.e.kind === "memory" || n.e.kind === "artifact" || n.e.kind === "asset";
      n.hub = n.e.kind === "agent" || (!leaf && (d >= cut || (n.e.importance >= 4 && d >= 2)));
    }
    return { nodes, links };
  }, [entities, relations]);

  /** Frame every node, labels included, inside the canvas. */
  const fit = (list: Node[] = nodes) => {
    const placed = list.filter((n) => n.x != null && n.y != null);
    if (!placed.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of placed) {
      x0 = Math.min(x0, n.x! - n.r - 70); x1 = Math.max(x1, n.x! + n.r + 70);
      y0 = Math.min(y0, n.y! - n.r - 6); y1 = Math.max(y1, n.y! + n.r + 18);
    }
    const { w, h } = sizeRef.current;
    const k = Math.min(Math.max(Math.min(w / (x1 - x0), h / (y1 - y0)) * 0.92, 0.08), 1.6);
    setView({ x: -((x0 + x1) / 2) * k, y: -((y0 + y1) / 2) * k, k });
  };

  useEffect(() => {
    userMoved.current = false;
    const count = new Map<string, number>();
    const key = (x: string | number | Node) => (typeof x === "object" ? x.id : String(x));
    for (const l of links) for (const end of [l.source, l.target]) count.set(key(end), (count.get(key(end)) ?? 0) + 1);
    const deg = (x: string | number | Node) => count.get(key(x)) ?? 1;
    // Distance et raideur selon ce que dit le lien : une relation saisie tient
    // fort, un lien déduit (citation, sujet) rapproche sans écraser. Comme d3,
    // on divise par le degré du plus petit bout pour que les carrefours ne
    // tirent pas tout le graphe.
    const LINK = {
      explicit: { d: 120, s: 0.9 }, owns: { d: 65, s: 0.8 }, knows: { d: 140, s: 0.3 },
      mention: { d: 110, s: 0.4 }, topic: { d: 70, s: 0.7 },
    } as const;
    const spec = (l: Link) => LINK[l.kind ?? "explicit"];
    const sim = forceSimulation(nodes)
      .force("link", forceLink<Node, Link>(links).id((n) => n.id)
        .distance((l) => spec(l).d)
        .strength((l) => spec(l).s / Math.min(deg(l.source), deg(l.target))))
      .force("charge", forceManyBody<Node>().strength((n) => (n.hub ? -260 : -90) - n.r * 8).distanceMax(700))
      .force("collide", forceCollide<Node>().radius((n) => n.r + (n.hub ? 22 : 10)))
      // Les îlots restent près du centre au lieu de dériver au loin.
      .force("x", forceX<Node>(0).strength(0.035))
      .force("y", forceY<Node>(0).strength(0.035))
      .force("center", forceCenter(0, 0))
      .stop();
    // Settle most of the layout up front so the first frame is already framed.
    sim.tick(220);
    fit(nodes);
    sim.on("tick", () => setTick((t) => t + 1))
      .on("end", () => { if (!userMoved.current) fit(nodes); })
      .restart();
    simRef.current = sim;
    return () => { sim.stop(); simRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, links]);

  // Wheel zoom around the cursor (native listener, the React wheel handler is passive).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userMoved.current = true;
      const r = svg.getBoundingClientRect();
      const sx = e.clientX - r.left - r.width / 2, sy = e.clientY - r.top - r.height / 2;
      setView((v) => {
        const k = Math.min(Math.max(v.k * Math.exp(-e.deltaY * 0.0015), 0.08), 4);
        return { k, x: sx - ((sx - v.x) * k) / v.k, y: sy - ((sy - v.y) * k) / v.k };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const toGraph = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - r.width / 2 - v.x) / v.k, y: (clientY - r.top - r.height / 2 - v.y) / v.k };
  };

  const startDrag = (e: React.PointerEvent, node?: Node) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    drag.current = { mode: node ? "node" : "pan", node, startX: e.clientX, startY: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y, moved: false };
    if (!node) setPanning(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    userMoved.current = true;
    if (d.mode === "pan") {
      setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
    } else if (d.node) {
      const p = toGraph(e.clientX, e.clientY);
      d.node.fx = p.x; d.node.fy = p.y;
      simRef.current?.alphaTarget(0.25).restart();
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setPanning(false);
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.mode === "node" && d.node) {
      if (!d.moved) onSelect(d.node.id);
      d.node.fx = null; d.node.fy = null;
      simRef.current?.alphaTarget(0);
    }
  };

  const zoomBy = (f: number) => {
    userMoved.current = true;
    setView((v) => {
      const k = Math.min(Math.max(v.k * f, 0.08), 4);
      return { k, x: (v.x * k) / v.k, y: (v.y * k) / v.k };
    });
  };

  const neighbours = useMemo(() => {
    const focus = hover ?? selected;
    if (!focus) return null;
    const s = new Set([focus]);
    for (const l of links) {
      const a = (l.source as Node).id ?? l.source, b = (l.target as Node).id ?? l.target;
      if (a === focus) s.add(b as string);
      if (b === focus) s.add(a as string);
    }
    return s;
  }, [hover, selected, links]);

  return (
    <div ref={wrap} className="absolute inset-0 overflow-hidden">
      <svg ref={svgRef} width={size.w} height={size.h} viewBox={`${-size.w / 2} ${-size.h / 2} ${size.w} ${size.h}`}
        className={cn("touch-none select-none", panning ? "cursor-grabbing" : "cursor-grab")}
        onPointerDown={(e) => startDrag(e)} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {links.map((l) => {
            const a = l.source as Node, b = l.target as Node;
            if (a.x == null || b.x == null) return null;
            const lit = neighbours ? neighbours.has(a.id) && neighbours.has(b.id) : false;
            const inferred = l.kind === "mention" || l.kind === "knows";
            return (
              <g key={l.id}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor"
                  className={lit ? "text-foreground/60" : !l.kind ? "text-foreground/30" : inferred ? "text-foreground/[0.12]" : "text-foreground/20"}
                  strokeDasharray={inferred ? `${3 / view.k} ${3 / view.k}` : undefined}
                  strokeWidth={(lit ? 1.4 : !l.kind ? 1.2 : 1) / view.k} />
                {lit && (
                  <text x={(a.x + b.x!) / 2} y={(a.y! + b.y!) / 2 - 3} textAnchor="middle" className="pointer-events-none fill-muted-foreground text-[9px]">
                    {l.relation.replace(/_/g, " ")}
                  </text>
                )}
              </g>
            );
          })}
          {nodes.map((n) => {
            if (n.x == null) return null;
            const dim = neighbours && !neighbours.has(n.id);
            // Dézoomé, seuls les carrefours gardent leur nom ; les autres
            // réapparaissent au zoom ou autour du nœud survolé.
            const label = selected === n.id || hover === n.id || view.k >= 2.2
              || (n.hub && (view.k >= 0.45 || n.r * view.k >= 8))
              || (hover != null && (neighbours?.has(n.id) ?? false) && view.k >= 0.9);
            return (
              <g key={n.id} transform={`translate(${n.x},${n.y})`} className="cursor-pointer" opacity={dim ? 0.25 : 1}
                onPointerDown={(e) => startDrag(e, n)}
                onMouseEnter={() => { if (!drag.current) setHover(n.id); }} onMouseLeave={() => { if (!drag.current) setHover(null); }}>
                <circle r={n.r} fill={colorOf(n.e.kind)} stroke={selected === n.id ? "hsl(var(--foreground))" : "hsl(var(--background))"} strokeWidth={selected === n.id ? 2.5 : 1.5} />
                {label && (
                  <text y={n.r + 11 / Math.min(view.k, 1)} textAnchor="middle" className="pointer-events-none fill-foreground"
                    style={{ fontSize: 10.5 / Math.min(view.k, 1) }}>
                    {n.e.name.length > 28 ? `${n.e.name.slice(0, 27)}…` : n.e.name}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-md border border-border bg-background">
        <button type="button" title="Zoomer" onClick={() => zoomBy(1.25)} className="p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Plus className="h-3.5 w-3.5" /></button>
        <button type="button" title="Dézoomer" onClick={() => zoomBy(0.8)} className="border-t border-border p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Minus className="h-3.5 w-3.5" /></button>
        <button type="button" title="Tout afficher" onClick={() => fit()} className="border-t border-border p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><CornersOut className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  );
}

// ── An entity, its facts and its links ──────────────────────────────────────

function EntityPanel({ entityId, agents, onClose, onSelect, onChanged }: {
  entityId: string; agents: Array<{ id: string; name: string }>;
  onClose: () => void; onSelect: (id: string) => void; onChanged: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ name: string; summary: string; aliases: string } | null>(null);
  const agentName = (id: string | null) => agents.find((a) => a.id === id)?.name ?? null;

  const { data, refetch } = useQuery({
    queryKey: ["kg_entity", entityId],
    queryFn: async () => {
      const [{ data: e }, { data: facts }, { data: out }, { data: inc }] = await Promise.all([
        supabase.from("knowledge_entities").select("id, workspace_id, name, kind, summary, aliases, importance, mentions, updated_at, created_by_agent").eq("id", entityId).maybeSingle(),
        supabase.from("knowledge_facts").select("id, statement, kind, importance, source_kind, source_agent_id, created_at, superseded_by")
          .eq("entity_id", entityId).order("superseded_by", { ascending: true, nullsFirst: true }).order("importance", { ascending: false }).order("created_at", { ascending: false }),
        supabase.from("knowledge_relations").select("id, relation, other:knowledge_entities!knowledge_relations_to_entity_fkey(id, name, kind)").eq("from_entity", entityId),
        supabase.from("knowledge_relations").select("id, relation, other:knowledge_entities!knowledge_relations_from_entity_fkey(id, name, kind)").eq("to_entity", entityId),
      ]);
      type Rel = { id: string; relation: string; other: { id: string; name: string; kind: string } | null };
      return {
        entity: e as (Entity & { workspace_id: string; created_by_agent: string | null }) | null,
        facts: (facts ?? []) as Fact[],
        out: (out ?? []) as unknown as Rel[],
        inc: (inc ?? []) as unknown as Rel[],
      };
    },
  });
  const e = data?.entity;
  const live = (data?.facts ?? []).filter((f) => !f.superseded_by);
  const old = (data?.facts ?? []).filter((f) => f.superseded_by);

  async function run(p: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await p;
    if (error) { toast.error("Modification impossible", error.message); return false; }
    await refetch();
    onChanged();
    return true;
  }

  async function addFact() {
    const statement = draft.trim();
    if (!statement || !e) return;
    const { data: u } = await supabase.auth.getUser();
    if (await run(supabase.from("knowledge_facts").insert({
      workspace_id: e.workspace_id, entity_id: e.id, key: statement.toLowerCase(), statement, source_kind: "user",
      source_ref: u.user?.id ?? null,
    }))) setDraft("");
  }

  async function saveEdit() {
    if (!editing || !e) return;
    const ok = await run(supabase.from("knowledge_entities").update({
      name: editing.name.trim() || e.name,
      summary: editing.summary.trim() || null,
      aliases: editing.aliases.split(",").map((a) => a.trim()).filter(Boolean),
    }).eq("id", e.id));
    if (ok) setEditing(null);
  }

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-border/60 bg-background">
      <div className="flex items-start justify-between gap-2 border-b border-border/60 px-4 py-3">
        {e ? (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ background: colorOf(e.kind) }} />
              {KIND_META[e.kind]?.label ?? e.kind} · cité {e.mentions} fois
            </div>
            {editing ? (
              <input value={editing.name} onChange={(ev) => setEditing({ ...editing, name: ev.target.value })}
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-base font-semibold" />
            ) : (
              <h3 className="mt-0.5 truncate text-base font-semibold">{e.name}</h3>
            )}
          </div>
        ) : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
      </div>

      {e && (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-sm">
          {editing ? (
            <div className="space-y-2">
              <textarea value={editing.summary} onChange={(ev) => setEditing({ ...editing, summary: ev.target.value })} rows={3}
                placeholder="Ce que c'est, en une phrase" className="w-full rounded border border-border bg-background px-2 py-1 text-xs" />
              <input value={editing.aliases} onChange={(ev) => setEditing({ ...editing, aliases: ev.target.value })}
                placeholder="Alias, séparés par des virgules" className="w-full rounded border border-border bg-background px-2 py-1 text-xs" />
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Annuler</Button>
                <Button size="sm" onClick={() => void saveEdit()}>Enregistrer</Button>
              </div>
            </div>
          ) : (
            <div>
              {e.summary && <p className="text-xs text-muted-foreground">{e.summary}</p>}
              {e.aliases.length > 0 && <p className="mt-1 text-[11px] text-muted-foreground">Aussi : {e.aliases.join(", ")}</p>}
              <button type="button" className="mt-1 text-[11px] text-primary hover:underline"
                onClick={() => setEditing({ name: e.name, summary: e.summary ?? "", aliases: e.aliases.join(", ") })}>
                Renommer ou compléter
              </button>
            </div>
          )}

          <section>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Ce qu'on sait ({live.length})</h4>
            <ul className="space-y-1.5">
              {live.map((f) => (
                <li key={f.id} className="group rounded-lg border border-border/70 px-2.5 py-1.5">
                  <p className="text-xs leading-relaxed">{f.statement}</p>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    {f.source_kind === "user" ? <UserI className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
                    <span>{f.source_kind === "user" ? "Ajouté à la main" : agentName(f.source_agent_id) ?? (f.source_kind === "backfill" ? "Mémoire importée" : "Agent")}</span>
                    <span>· {f.kind}</span>
                    <span>· {new Date(f.created_at).toLocaleDateString("fr-FR")}</span>
                    <button type="button" title="Supprimer ce fait"
                      onClick={() => void run(supabase.from("knowledge_facts").delete().eq("id", f.id))}
                      className="ml-auto opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100">
                      <Trash className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              ))}
              {!live.length && <li className="text-xs text-muted-foreground">Aucun fait pour l'instant.</li>}
            </ul>
            <div className="mt-2 flex gap-1.5">
              <input value={draft} onChange={(ev) => setDraft(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter") void addFact(); }}
                placeholder="Ajouter un fait…" className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-xs" />
              <Button size="sm" variant="outline" disabled={!draft.trim()} onClick={() => void addFact()}><Plus className="h-3.5 w-3.5" /></Button>
            </div>
            {old.length > 0 && (
              <details className="mt-2 text-[11px] text-muted-foreground">
                <summary className="cursor-pointer">{old.length} fait(s) remplacé(s)</summary>
                <ul className="mt-1 space-y-1">{old.map((f) => <li key={f.id} className="line-through">{f.statement}</li>)}</ul>
              </details>
            )}
          </section>

          <section>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Relations</h4>
            <ul className="space-y-1 text-xs">
              {[...(data?.out ?? []).map((r) => ({ ...r, dir: "out" })), ...(data?.inc ?? []).map((r) => ({ ...r, dir: "in" }))].map((r) => r.other && (
                <li key={r.id} className="flex items-center gap-1.5">
                  {r.dir === "out"
                    ? <span className="text-muted-foreground">{r.relation.replace(/_/g, " ")} →</span>
                    : <span className="text-muted-foreground">← {r.relation.replace(/_/g, " ")} de</span>}
                  <button type="button" onClick={() => onSelect(r.other!.id)} className="flex items-center gap-1 truncate hover:underline">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: colorOf(r.other.kind) }} />{r.other.name}
                  </button>
                </li>
              ))}
              {!(data?.out.length || data?.inc.length) && <li className="text-muted-foreground">Aucune relation.</li>}
            </ul>
          </section>
        </div>
      )}
    </aside>
  );
}
