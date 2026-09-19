import type React from "react";
import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import {
  forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY,
  type Simulation, type SimulationNodeDatum, type SimulationLinkDatum,
} from "d3-force";
import {
  XIcon as X,
  MagnifyingGlassIcon as Search,
  StarIcon as Star,
  PlusIcon as Plus,
  MinusIcon as Minus,
  ArrowsOutSimpleIcon as Maximize2,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

// Workspace memory as a LIVE force-directed graph (d3-force): memory dots are
// pulled toward per-group hubs (spring links) with charge repulsion + collision,
// so the layout self-organises. Nodes are draggable with elasticity — a dragged
// node stretches its spring links and, on release, everything wobbles back into
// place. Clicking a node opens a details card anchored to it with a connector.

export interface MemoryRow {
  id: string; agent_id: string | null; kind: string; content: string;
  source: string; importance: number; is_pinned: boolean; created_at: string;
}
export interface GraphAgent { id: string; name: string; accentColor?: string | null; }

type GroupBy = "kind" | "agent" | "source";

const KIND_COLOR: Record<string, string> = {
  // Memory kinds
  fact: "#3b82f6", preference: "#8b5cf6", learning: "#10b981", context: "#f59e0b",
  // Artifacts + assets (so the graph holds everything about the service)
  artifact: "#ec4899", repo: "#06b6d4", link: "#0ea5e9", file: "#64748b",
  note: "#eab308", person: "#14b8a6", connector: "#a855f7", key: "#f43f5e",
};
const KIND_LABEL: Record<string, string> = {
  fact: "Faits", preference: "Préférences", learning: "Appris", context: "Contexte",
  artifact: "Artifacts", repo: "Dépôts", link: "Liens", file: "Fichiers",
  note: "Notes", person: "Personnes", connector: "Outils", key: "Clés",
};
const kindColorOf = (k: string) => KIND_COLOR[k] ?? "#64748b";
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function hashHue(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; }

interface SimNode extends SimulationNodeDatum {
  id: string; isHub: boolean; label: string; color: string; size: number;
  count?: number; kind?: string; pinned?: boolean; tx: number; ty: number;
}
interface SimLink extends SimulationLinkDatum<SimNode> { kind: "hub" | "sim"; color: string; }

function buildSim(
  mems: MemoryRow[],
  groupFn: (m: MemoryRow) => { key: string; label: string; color: string },
): { nodes: SimNode[]; links: SimLink[] } {
  const groups = new Map<string, { label: string; color: string; items: MemoryRow[] }>();
  mems.forEach((m) => {
    const g = groupFn(m);
    const e = groups.get(g.key) ?? { label: g.label, color: g.color, items: [] };
    e.items.push(m); groups.set(g.key, e);
  });
  const keys = [...groups.keys()];
  const R = 260;
  const nodes: SimNode[] = [];
  const links: SimLink[] = [];

  keys.forEach((k, i) => {
    const g = groups.get(k)!;
    const ang = (i / Math.max(keys.length, 1)) * 2 * Math.PI - Math.PI / 2;
    const hx = Math.cos(ang) * R, hy = Math.sin(ang) * R;
    nodes.push({ id: `hub-${k}`, isHub: true, label: g.label, color: g.color, size: 0, count: g.items.length, tx: hx, ty: hy, x: hx, y: hy });
    const rr = 90 + Math.min(g.items.length, 24) * 5;
    g.items.forEach((m, j) => {
      const a = (j / Math.max(g.items.length, 1)) * 2 * Math.PI;
      nodes.push({
        id: m.id, isHub: false, label: m.content, color: g.color, kind: m.kind, pinned: m.is_pinned,
        size: 12 + Math.min(m.importance ?? 0, 5) * 3, tx: hx, ty: hy,
        x: hx + Math.cos(a) * rr, y: hy + Math.sin(a) * rr,
      });
      links.push({ source: `hub-${k}`, target: m.id, kind: "hub", color: g.color });
    });
  });

  // Similarity springs: memories sharing ≥2 significant words (capped for perf).
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-zà-ÿ0-9]{5,}/g) ?? []);
  const wmap = mems.map((m) => ({ id: m.id, w: words(m.content) }));
  let sim = 0;
  for (let i = 0; i < wmap.length && sim < 60; i++) {
    for (let j = i + 1; j < wmap.length && sim < 60; j++) {
      let shared = 0;
      for (const w of wmap[i].w) if (wmap[j].w.has(w)) { shared++; if (shared >= 2) break; }
      if (shared >= 2) { links.push({ source: wmap[i].id, target: wmap[j].id, kind: "sim", color: "" }); sim++; }
    }
  }
  return { nodes, links };
}

export function MemoryGraph({ mems, agents }: { mems: MemoryRow[]; agents: GraphAgent[] }) {
  const [groupBy, setGroupBy] = useState<GroupBy>("kind");
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<"all" | "user" | "agent">("all");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [, setFrame] = useState(0);
  const [view, setView] = useState({ k: 0.85, x: 0, y: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const viewRef = useRef(view); viewRef.current = view;
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null);
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const didFit = useRef(false);
  const fitRef = useRef<() => void>(() => {});

  const nameOf = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const agentColor = useCallback((id: string | null) => {
    if (!id) return "#64748b";
    const a = agents.find((x) => x.id === id);
    if (a?.accentColor && /^#([0-9a-f]{6})$/i.test(a.accentColor)) return a.accentColor;
    return `hsl(${hashHue(id)} 62% 55%)`;
  }, [agents]);

  const kinds = useMemo(() => [...new Set(mems.map((m) => m.kind))], [mems]);
  const memById = useMemo(() => new Map(mems.map((m) => [m.id, m])), [mems]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return mems.filter((m) =>
      (!q || m.content.toLowerCase().includes(q)) &&
      (kindFilter.size === 0 || kindFilter.has(m.kind)) &&
      (sourceFilter === "all" || m.source === sourceFilter) &&
      (!pinnedOnly || m.is_pinned));
  }, [mems, search, kindFilter, sourceFilter, pinnedOnly]);

  const groupFn = useCallback((m: MemoryRow) => {
    if (groupBy === "agent") { const id = m.agent_id ?? "__ws"; return { key: id, label: id === "__ws" ? "Workspace" : (nameOf.get(id) ?? "Agent"), color: agentColor(m.agent_id) }; }
    if (groupBy === "source") return { key: m.source, label: m.source === "user" ? "Vous" : "Agents", color: m.source === "user" ? "#3b82f6" : "#10b981" };
    return { key: m.kind, label: KIND_LABEL[m.kind] ?? m.kind, color: kindColorOf(m.kind) };
  }, [groupBy, nameOf, agentColor]);

  // (Re)build the simulation whenever the filtered set or grouping changes.
  useEffect(() => {
    const { nodes, links } = buildSim(filtered, groupFn);
    nodesRef.current = nodes; linksRef.current = links;
    const sim = forceSimulation<SimNode>(nodes)
      .force("link", forceLink<SimNode, SimLink>(links).id((d) => d.id)
        .distance((l) => (l.kind === "hub" ? 74 : 150))
        .strength((l) => (l.kind === "hub" ? 0.55 : 0.05)))
      .force("charge", forceManyBody<SimNode>().strength((d) => (d.isHub ? -420 : -150)))
      .force("collide", forceCollide<SimNode>().radius((d) => (d.isHub ? 46 : d.size / 2 + 6)))
      .force("x", forceX<SimNode>((d) => d.tx).strength((d) => (d.isHub ? 0.08 : 0.012)))
      .force("y", forceY<SimNode>((d) => d.ty).strength((d) => (d.isHub ? 0.08 : 0.012)))
      .velocityDecay(0.28) // lower damping → springier, more elastic settling
      .on("tick", () => setFrame((f) => (f + 1) & 0xffff));
    simRef.current = sim;

    // Rough centre immediately (avoids a first-frame flash at the origin), then
    // auto-fit once after the layout has settled so every cluster is in frame.
    if (containerRef.current) {
      const { clientWidth: w, clientHeight: h } = containerRef.current;
      if (w && h) setView({ k: 0.8, x: w / 2, y: h / 2 + 20 });
    }
    const t = setTimeout(() => { didFit.current = true; fitRef.current(); }, 1100);
    return () => { clearTimeout(t); sim.stop(); };
  }, [filtered, groupFn]);

  // Screen ⇄ graph coordinate helpers (account for pan/zoom transform).
  const toGraph = (clientX: number, clientY: number) => {
    const r = containerRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { gx: (clientX - r.left - v.x) / v.k, gy: (clientY - r.top - v.y) / v.k };
  };

  // ── Node drag (elastic): fix the node to the pointer, reheat the sim so the
  //    spring links stretch and the neighbourhood follows; release → wobble back.
  const onDragMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    const n = nodesRef.current.find((x) => x.id === d.id); if (!n) return;
    const { gx, gy } = toGraph(e.clientX, e.clientY);
    n.fx = gx; n.fy = gy;
    if (!d.moved) d.moved = true;
  }, []);
  const onDragEnd = useCallback(() => {
    const d = dragRef.current;
    if (d) {
      const n = nodesRef.current.find((x) => x.id === d.id);
      if (n) { n.fx = null; n.fy = null; } // release → elastic snap-back
      if (!d.moved && !n?.isHub) setSelectedId(d.id); // click (no drag) selects
      else if (!d.moved) setSelectedId(null);
    }
    simRef.current?.alphaTarget(0);
    dragRef.current = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
  }, [onDragMove]);
  const startDrag = useCallback((e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const n = nodesRef.current.find((x) => x.id === id); if (!n) return;
    dragRef.current = { id, moved: false };
    n.fx = n.x; n.fy = n.y;
    simRef.current?.alphaTarget(0.35).restart();
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
  }, [onDragMove, onDragEnd]);

  // ── Pan (drag empty space) + wheel zoom.
  const onPanMove = useCallback((e: PointerEvent) => {
    const p = panRef.current; if (!p) return;
    setView((v) => ({ ...v, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) }));
  }, []);
  const onPanEnd = useCallback(() => {
    panRef.current = null; setGrabbing(false);
    window.removeEventListener("pointermove", onPanMove);
    window.removeEventListener("pointerup", onPanEnd);
  }, [onPanMove]);
  const startPan = useCallback((e: React.PointerEvent) => {
    const v = viewRef.current;
    panRef.current = { sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y };
    setGrabbing(true); setSelectedId(null);
    window.addEventListener("pointermove", onPanMove);
    window.addEventListener("pointerup", onPanEnd);
  }, [onPanMove, onPanEnd]);
  const onWheel = useCallback((e: React.WheelEvent) => {
    const r = containerRef.current!.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => { const k = clamp(v.k * factor, 0.2, 2.6); const f = k / v.k; return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f }; });
  }, []);
  const zoomBy = (factor: number) => setView((v) => {
    const r = containerRef.current!.getBoundingClientRect();
    const cx = r.width / 2, cy = r.height / 2;
    const k = clamp(v.k * factor, 0.2, 2.6); const f = k / v.k;
    return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
  });
  const fit = () => {
    const ns = nodesRef.current; const r = containerRef.current?.getBoundingClientRect();
    if (!ns.length || !r) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ns.forEach((n) => { minX = Math.min(minX, n.x!); minY = Math.min(minY, n.y!); maxX = Math.max(maxX, n.x!); maxY = Math.max(maxY, n.y!); });
    const w = maxX - minX || 1, h = maxY - minY || 1;
    const k = clamp(Math.min(r.width / (w + 160), r.height / (h + 160)), 0.2, 1.6);
    setView({ k, x: r.width / 2 - ((minX + maxX) / 2) * k, y: r.height / 2 + 24 - ((minY + maxY) / 2) * k });
  };
  fitRef.current = fit;

  const toggleKind = (k: string) => setKindFilter((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const activeFilters = (kindFilter.size > 0 ? 1 : 0) + (sourceFilter !== "all" ? 1 : 0) + (pinnedOnly ? 1 : 0);
  const GROUPS: { v: GroupBy; label: string }[] = [{ v: "kind", label: "Type" }, { v: "agent", label: "Agent" }, { v: "source", label: "Source" }];

  const nodes = nodesRef.current;
  const links = linksRef.current;
  const selected = selectedId ? memById.get(selectedId) ?? null : null;
  const selNode = selectedId ? nodes.find((n) => n.id === selectedId) : null;

  // Details card anchored to the selected node (screen coords, flips to stay in view).
  let card: { left: number; top: number; ax: number; ay: number; sx: number; sy: number } | null = null;
  if (selected && selNode && containerRef.current) {
    const r = containerRef.current.getBoundingClientRect();
    const sx = selNode.x! * view.k + view.x, sy = selNode.y! * view.k + view.y;
    const flip = sx > r.width - 320;
    const cardW = 288;
    const left = clamp(flip ? sx - 22 - cardW : sx + 22, 8, r.width - cardW - 8);
    const top = clamp(sy - 30, 8, r.height - 200);
    card = { left, top, ax: flip ? left + cardW : left, ay: clamp(sy, top + 12, top + 180), sx, sy };
  }

  return (
    <div className="relative h-full w-full">
      {/* Controls: group-by + search + filters */}
      <div className="pointer-events-none absolute inset-x-0 top-4 z-30 flex justify-center px-4">
        <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-2xl border border-border bg-card/90 px-2.5 py-1.5 shadow-sm backdrop-blur">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher un sujet…" className="h-8 w-44 rounded-lg bg-muted/60 pl-8 pr-2 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring/30" />
          </div>
          <div className="h-5 w-px bg-border" />
          <span className="pl-0.5 text-[11px] font-medium text-muted-foreground">Grouper</span>
          <div className="flex items-center gap-0.5 rounded-full bg-muted/60 p-0.5">
            {GROUPS.map((g) => (
              <button key={g.v} onClick={() => setGroupBy(g.v)} className={cn("rounded-full px-2.5 py-1 text-xs font-medium transition-colors", groupBy === g.v ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>{g.label}</button>
            ))}
          </div>
          <div className="h-5 w-px bg-border" />
          <div className="flex items-center gap-1">
            {kinds.map((k) => {
              const on = kindFilter.has(k);
              return (
                <button key={k} onClick={() => toggleKind(k)} className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors", on ? "text-white" : "text-muted-foreground hover:text-foreground")} style={on ? { backgroundColor: kindColorOf(k), borderColor: kindColorOf(k) } : { borderColor: "hsl(var(--border))" }}>{KIND_LABEL[k] ?? k}</button>
              );
            })}
          </div>
          <div className="h-5 w-px bg-border" />
          <div className="flex items-center gap-0.5 rounded-full bg-muted/60 p-0.5">
            {(["all", "user", "agent"] as const).map((s) => (
              <button key={s} onClick={() => setSourceFilter(s)} className={cn("rounded-full px-2 py-1 text-[11px] font-medium transition-colors", sourceFilter === s ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>{s === "all" ? "Tous" : s === "user" ? "Vous" : "Agents"}</button>
            ))}
          </div>
          <button onClick={() => setPinnedOnly((v) => !v)} title="Épinglés" className={cn("flex h-7 items-center gap-1 rounded-full px-2 text-[11px] font-medium transition-colors", pinnedOnly ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "text-muted-foreground hover:text-foreground")}>
            <Star weight={pinnedOnly ? "fill" : "regular"} className="h-3.5 w-3.5" />
          </button>
          {(activeFilters > 0 || search) && (
            <button onClick={() => { setSearch(""); setKindFilter(new Set()); setSourceFilter("all"); setPinnedOnly(false); }} className="rounded-full px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">Réinitialiser</button>
          )}
          <span className="pr-1 text-[11px] tabular-nums text-muted-foreground/70">{filtered.length}/{mems.length}</span>
        </div>
      </div>

      {/* Force graph */}
      <div ref={containerRef} className="h-full w-full overflow-hidden" onWheel={onWheel} onPointerDown={startPan} style={{ cursor: grabbing ? "grabbing" : "grab" }}>
        <svg className="h-full w-full select-none" style={{ touchAction: "none" }}>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {/* Edges */}
            {links.map((l, i) => {
              const s = l.source as SimNode, t = l.target as SimNode;
              if (typeof s !== "object" || typeof t !== "object") return null;
              const sim = l.kind === "sim";
              return (
                <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y}
                  stroke={sim ? "hsl(var(--muted-foreground) / 0.22)" : l.color + "55"}
                  strokeWidth={sim ? 1 : 1.2} strokeDasharray={sim ? "3 3" : undefined} />
              );
            })}
            {/* Nodes */}
            {nodes.map((n) => {
              if (n.isHub) {
                const w = Math.max(56, n.label.length * 7 + 40);
                return (
                  <g key={n.id} transform={`translate(${n.x} ${n.y})`} onPointerDown={(e) => startDrag(e, n.id)} style={{ cursor: "grab" }}>
                    <rect x={-w / 2} y={-14} width={w} height={28} rx={14} fill={n.color + "1a"} stroke={n.color + "66"} />
                    <text textAnchor="middle" dy={4} fontSize={12} fontWeight={600} fill={n.color}>{n.label} · {n.count}</text>
                  </g>
                );
              }
              const isSel = n.id === selectedId;
              return (
                <g key={n.id} transform={`translate(${n.x} ${n.y})`} onPointerDown={(e) => startDrag(e, n.id)} style={{ cursor: "pointer" }}>
                  {isSel && <circle r={n.size / 2 + 6} fill="none" stroke={n.color} strokeWidth={2} opacity={0.6} />}
                  <circle r={n.size / 2} fill={n.color} stroke="hsl(var(--background))" strokeWidth={2} style={{ filter: `drop-shadow(0 0 6px ${n.color}66)` }} />
                  {n.pinned && <text x={n.size / 2 - 1} y={-n.size / 2 + 2} fontSize={9} fill="#f59e0b">★</text>}
                  <title>{n.label}</title>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {/* Zoom controls */}
      <div className="absolute bottom-4 left-4 z-20 flex flex-col gap-1 rounded-xl border border-border bg-card/90 p-1 shadow-sm backdrop-blur">
        <button onClick={() => zoomBy(1.2)} title="Zoom avant" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Plus className="h-4 w-4" /></button>
        <button onClick={() => zoomBy(1 / 1.2)} title="Zoom arrière" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Minus className="h-4 w-4" /></button>
        <button onClick={fit} title="Ajuster" className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Maximize2 className="h-4 w-4" /></button>
      </div>

      {filtered.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-full border border-border bg-card px-4 py-2 text-sm text-muted-foreground shadow-sm">Aucune mémoire pour ces filtres.</p>
        </div>
      )}

      {/* Connector from node to the anchored details card */}
      {selected && card && (
        <svg className="pointer-events-none absolute inset-0 z-20 h-full w-full">
          <line x1={card.sx} y1={card.sy} x2={card.ax} y2={card.ay} stroke={kindColorOf(selected.kind)} strokeWidth={1.5} strokeDasharray="4 3" opacity={0.7} />
          <circle cx={card.sx} cy={card.sy} r={3.5} fill={kindColorOf(selected.kind)} />
          <circle cx={card.ax} cy={card.ay} r={2.5} fill={kindColorOf(selected.kind)} />
        </svg>
      )}

      {/* Details card, anchored to the node */}
      {selected && card && (
        <div className="absolute z-20 w-72 rounded-2xl border border-border bg-card p-4 shadow-xl" style={{ left: card.left, top: card.top }}>
          <div className="mb-2 flex items-center justify-between">
            <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ backgroundColor: kindColorOf(selected.kind) + "22", color: kindColorOf(selected.kind) }}>
              {KIND_LABEL[selected.kind] ?? selected.kind}
            </span>
            <button onClick={() => setSelectedId(null)} className="rounded p-1 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
          </div>
          <p className="text-sm leading-relaxed text-foreground">{selected.content}</p>
          <div className="mt-3 space-y-1 text-[11px] text-muted-foreground">
            {selected.is_pinned && <div className="text-amber-500">★ épinglé</div>}
            <div>{selected.agent_id && nameOf.get(selected.agent_id) ? nameOf.get(selected.agent_id) : "Workspace"}</div>
            <div>{selected.source === "user" ? "ajouté par vous" : "appris par l'agent"}</div>
            <div>Importance {selected.importance ?? 0}/5</div>
            <div>{new Date(selected.created_at).toLocaleString("fr-FR")}</div>
          </div>
        </div>
      )}
    </div>
  );
}
