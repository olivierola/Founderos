import { useEffect, useRef } from "react";
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY, type Simulation } from "d3-force";
import { select } from "d3-selection";
import { zoom as d3zoom } from "d3-zoom";
import { drag as d3drag } from "d3-drag";
import { cn } from "@/lib/utils";

export interface GraphPersona {
  id: string; name: string; role: string | null; avatar_emoji: string | null;
  population: number; sentiment_score: number; cluster: string | null;
}
export interface GraphRelation { source_id: string; target_id: string; kind: string; label: string | null; strength: number }

interface SimNode extends GraphPersona { x?: number; y?: number; fx?: number | null; fy?: number | null }
interface SimLink { source: any; target: any; kind: string; label: string | null; strength: number }

// Sentiment color: red (negative) → grey (neutral) → green (positive).
function sentimentColor(s: number): string {
  if (s > 0.15) return "#22c55e";
  if (s < -0.15) return "#ef4444";
  return "#94a3b8";
}

// MiroFish-style force-directed persona graph: nodes = archetypes (radius ∝
// population), curved links = relations (width ∝ strength, label = kind). Pan,
// zoom and drag; click a node to inspect / chat.
export function SimulationGraph({
  personas, relations, onSelect, height, showLabels = true, fill = false,
}: {
  personas: GraphPersona[];
  relations: GraphRelation[];
  onSelect?: (p: GraphPersona) => void;
  height?: number;
  showLabels?: boolean;
  fill?: boolean; // fill the parent container's height
}) {
  const ref = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<SimNode, undefined> | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const width = el.clientWidth || 800;
    const h = el.clientHeight || height || 460;
    el.innerHTML = "";

    const big = personas.length > 120; // dense graph → simplify for performance
    const maxPop = Math.max(1, ...personas.map((p) => p.population || 1));
    // Dot nodes (MiroFish-style). Keep them comfortably visible even when dense.
    const radius = (p: GraphPersona) => (big ? 6 : 5 + 7 * Math.sqrt((p.population || 1) / maxPop));

    const nodes: SimNode[] = personas.map((p) => ({ ...p }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: SimLink[] = relations
      .filter((r) => byId.has(r.source_id) && byId.has(r.target_id) && r.source_id !== r.target_id)
      .map((r) => ({ source: r.source_id, target: r.target_id, kind: r.kind, label: r.label, strength: r.strength }));

    const svg = select(el).append("svg").attr("width", "100%").attr("height", h).attr("viewBox", `0 0 ${width} ${h}`);
    const g = svg.append("g");
    // defs: arrowhead for directed influence (sized for small dot nodes).
    svg.append("defs").append("marker")
      .attr("id", "sim-arrow").attr("viewBox", "0 -5 10 10").attr("refX", 14).attr("refY", 0)
      .attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto")
      .append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", "#9aa3b2").attr("opacity", 0.7);

    svg.call(d3zoom<SVGSVGElement, unknown>().scaleExtent([0.2, 4]).on("zoom", (e) => g.attr("transform", e.transform)) as any);

    // Links — clearly visible grey lines, width ∝ strength. Straight + lighter
    // when the graph is dense (perf).
    const link = g.append("g").selectAll("path").data(links).enter().append("path")
      .attr("fill", "none")
      .attr("stroke", "#8b93a1")
      .attr("stroke-opacity", big ? 0.4 : 0.55)
      .attr("stroke-width", (d) => (big ? 0.9 : 1 + 2 * (d.strength || 0.5)))
      .attr("marker-end", big ? null : "url(#sim-arrow)");

    const linkLabel = g.append("g").selectAll("text").data(big ? [] : links).enter().append("text")
      .text((d) => d.label || d.kind)
      .attr("font-size", 8).attr("fill", "hsl(var(--muted-foreground))").attr("text-anchor", "middle").attr("pointer-events", "none")
      .style("display", showLabels && !big ? "block" : "none");

    const node = g.append("g").selectAll("g").data(nodes).enter().append("g").style("cursor", "pointer")
      .on("click", (_e, d) => onSelect?.(d));

    // Solid dot, colored by sentiment, with a subtle ring.
    node.append("circle")
      .attr("r", (d) => radius(d))
      .attr("fill", (d) => sentimentColor(d.sentiment_score))
      .attr("stroke", "hsl(var(--background))")
      .attr("stroke-width", 1.5);

    if (!big) {
      node.append("text").text((d) => d.name)
        .attr("text-anchor", "middle").attr("dy", (d) => radius(d) + 11)
        .attr("font-size", 10).attr("fill", "hsl(var(--foreground))").attr("pointer-events", "none");
    }

    node.append("title").text((d) => `${d.name}\n${d.role ?? ""}\npopulation: ${d.population}\nsentiment: ${d.sentiment_score.toFixed(2)}`);

    const sim = forceSimulation<SimNode>(nodes)
      .force("link", forceLink<SimNode, SimLink>(links).id((d: any) => d.id).distance(90).strength((d) => 0.15 + 0.5 * (d.strength || 0.5)))
      .force("charge", forceManyBody().strength(-220))
      .force("center", forceCenter(width / 2, h / 2))
      .force("collide", forceCollide<SimNode>().radius((d) => radius(d) + (big ? 6 : 24)))
      .force("x", forceX(width / 2).strength(0.04))
      .force("y", forceY(h / 2).strength(0.04));
    simRef.current = sim;

    function curve(d: SimLink): string {
      const sx = d.source.x ?? 0, sy = d.source.y ?? 0, tx = d.target.x ?? 0, ty = d.target.y ?? 0;
      if (big) return `M${sx},${sy} L${tx},${ty}`; // straight lines when dense
      const dx = tx - sx, dy = ty - sy, dist = Math.hypot(dx, dy) || 1;
      const off = Math.max(20, dist * 0.16);
      const cx = (sx + tx) / 2 - dy / dist * off, cy = (sy + ty) / 2 + dx / dist * off;
      return `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`;
    }

    sim.on("tick", () => {
      link.attr("d", curve);
      linkLabel.attr("x", (d) => (((d.source.x ?? 0) + (d.target.x ?? 0)) / 2)).attr("y", (d) => (((d.source.y ?? 0) + (d.target.y ?? 0)) / 2) - 4);
      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    node.call(
      d3drag<any, SimNode>()
        .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
        .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }) as any,
    );

    return () => { sim.stop(); el.innerHTML = ""; };
  }, [personas, relations, height, onSelect, showLabels]);

  return (
    <div
      ref={ref}
      className={cn(
        "overflow-hidden bg-[radial-gradient(circle,hsl(var(--border))_1px,transparent_1px)] [background-size:22px_22px]",
        fill ? "h-full w-full" : "w-full rounded-xl border border-border",
      )}
      style={fill ? undefined : { height: height ?? 460 }}
    />
  );
}
