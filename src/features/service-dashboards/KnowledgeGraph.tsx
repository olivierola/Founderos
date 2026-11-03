import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  forceSimulation, forceLink, forceManyBody, forceCollide, forceCenter,
  type SimulationNodeDatum, type SimulationLinkDatum,
} from "d3-force";
import {
  MagnifyingGlassIcon as Search,
  XIcon as X,
  CircleNotchIcon as Loader2,
  TrashIcon as Trash,
  PlusIcon as Plus,
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
interface Relation { id: string; from_entity: string; to_entity: string; relation: string }
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
const colorOf = (k: string) => KIND_META[k]?.color ?? "#64748b";

interface Node extends SimulationNodeDatum { id: string; e: Entity; r: number }
interface Link extends SimulationLinkDatum<Node> { id: string; relation: string }

export function KnowledgeGraph({ workspaceId, agents }: {
  workspaceId: string;
  agents: Array<{ id: string; name: string }>;
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
    for (const k of ["kg_entities", "kg_relations", "kg_counts", "kg_entity"]) queryClient.invalidateQueries({ queryKey: [k] });
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

  const kindsPresent = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entities) m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
    return m;
  }, [entities]);

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
            {Object.entries(KIND_META).filter(([k]) => kindsPresent.has(k) || kind === k).map(([k, m]) => (
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
          ) : entities.length === 0 ? (
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
            <ForceView entities={entities} relations={relations} selected={selected} onSelect={setSelected} />
          )}
        </div>
      </div>

      {selected && (
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

// ── The canvas ──────────────────────────────────────────────────────────────

function ForceView({ entities, relations, selected, onSelect }: {
  entities: Entity[]; relations: Relation[]; selected: string | null; onSelect: (id: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [tick, setTick] = useState(0);
  const [hover, setHover] = useState<string | null>(null);

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
      .map((r) => ({ id: r.id, source: r.from_entity, target: r.to_entity, relation: r.relation }));
    return { nodes, links };
  }, [entities, relations]);

  useEffect(() => {
    const sim = forceSimulation(nodes)
      .force("link", forceLink<Node, Link>(links).id((n) => n.id).distance(90).strength(0.5))
      .force("charge", forceManyBody().strength(-160))
      .force("collide", forceCollide<Node>().radius((n) => n.r + 18))
      .force("center", forceCenter(0, 0))
      .on("tick", () => setTick((t) => t + 1));
    return () => { sim.stop(); };
  }, [nodes, links]);

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
  }, [hover, selected, links, tick]);

  return (
    <div ref={wrap} className="absolute inset-0 overflow-hidden">
      <svg width={size.w} height={size.h} viewBox={`${-size.w / 2} ${-size.h / 2} ${size.w} ${size.h}`} className="select-none">
        {links.map((l) => {
          const a = l.source as Node, b = l.target as Node;
          if (a.x == null || b.x == null) return null;
          const lit = neighbours ? neighbours.has(a.id) && neighbours.has(b.id) : false;
          return (
            <g key={l.id}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" className={lit ? "text-foreground/50" : "text-border"} strokeWidth={lit ? 1.4 : 1} />
              {lit && (
                <text x={(a.x + b.x!) / 2} y={(a.y! + b.y!) / 2 - 3} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                  {l.relation.replace(/_/g, " ")}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          if (n.x == null) return null;
          const dim = neighbours && !neighbours.has(n.id);
          return (
            <g key={n.id} transform={`translate(${n.x},${n.y})`} className="cursor-pointer" opacity={dim ? 0.25 : 1}
              onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onClick={() => onSelect(n.id)}>
              <circle r={n.r} fill={colorOf(n.e.kind)} stroke={selected === n.id ? "hsl(var(--foreground))" : "hsl(var(--background))"} strokeWidth={selected === n.id ? 2.5 : 1.5} />
              <text y={n.r + 11} textAnchor="middle" className="fill-foreground text-[10.5px]">
                {n.e.name.length > 28 ? `${n.e.name.slice(0, 27)}…` : n.e.name}
              </text>
            </g>
          );
        })}
      </svg>
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
