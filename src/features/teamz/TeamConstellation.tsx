import { useEffect, useMemo, useRef, useState } from "react";
import { AgentIdentity } from "@/components/AgentIdentity";
import { cn } from "@/lib/utils";
import "./teamz.css";

// La constellation d'une équipe : l'animateur au centre, les membres autour,
// et le FLUX entre eux — une passation coule (tirets qui avancent + une
// particule de travail), une consultation pointille, une relecture revient.
// Ce n'est pas un décor : les liens sont ceux que les agents ont dans leur
// prompt, et un échange réel des 7 derniers jours épaissit le sien.

export interface ConstellationNode {
  id: string;
  name: string;
  accent?: string | null;
  lead?: boolean;
  live?: boolean;
  avatarUrl?: string | null;
}

export interface ConstellationEdge { from: string; to: string; kind: string; count?: number }

const KIND_LABEL: Record<string, string> = {
  handoff: "passe la main", consult: "consulte", review: "fait relire",
};

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function TeamConstellation({
  nodes, edges, height = 220, accent = "#8b7cf6", drawIn = false, visible, pulse, className, showLabels = true,
}: {
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
  height?: number;
  accent?: string;
  /** Les liens se dessinent à l'apparition (assemblage). */
  drawIn?: boolean;
  /** Les nœuds déjà « nés » (assemblage progressif) ; absent = tous. */
  visible?: Set<string>;
  /** Le lien à faire pulser : le dernier échange réel. */
  pulse?: { from: string; to: string } | null;
  className?: string;
  showLabels?: boolean;
}) {
  const { ref, w } = useWidth<HTMLDivElement>();
  const motion = !reducedMotion();

  const pos = useMemo(() => {
    const out = new Map<string, { x: number; y: number }>();
    if (!w) return out;
    const cx = w / 2, cy = height / 2;
    const lead = nodes.find((n) => n.lead);
    const ring = lead && nodes.length >= 3 ? nodes.filter((n) => n !== lead) : nodes;
    if (lead && nodes.length >= 3) out.set(lead.id, { x: cx, y: cy });
    const rx = Math.min(w * 0.38, 210), ry = height * 0.36;
    if (ring.length === 2 && !(lead && nodes.length >= 3)) {
      out.set(ring[0].id, { x: cx - rx * 0.7, y: cy });
      out.set(ring[1].id, { x: cx + rx * 0.7, y: cy });
      return out;
    }
    ring.forEach((n, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(ring.length, 1);
      out.set(n.id, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
    });
    return out;
  }, [nodes, w, height]);

  const paths = useMemo(() => edges.map((e, i) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) return null;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const trim = 26;
    const sx = a.x + ux * trim, sy = a.y + uy * trim;
    const ex = b.x - ux * trim, ey = b.y - uy * trim;
    // A→B et B→A ne se superposent pas : la courbure dépend du sens.
    const bend = (e.from < e.to ? 1 : -1) * Math.min(26, len * 0.14);
    const mx = (sx + ex) / 2 - uy * bend, my = (sy + ey) / 2 + ux * bend;
    return { key: `${e.from}>${e.to}:${e.kind}:${i}`, d: `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`, e, mid: { x: mx, y: my } };
  }).filter((p): p is NonNullable<typeof p> => !!p), [edges, pos]);

  const isVisible = (id: string) => !visible || visible.has(id);

  return (
    <div ref={ref} className={cn("relative w-full select-none", className)} style={{ height, ["--tz-accent" as string]: accent }}>
      {w > 0 && (
        <svg width={w} height={height} className="absolute inset-0 overflow-visible" aria-hidden>
          <defs>
            <marker id={`tz-arrow-${accent.slice(1)}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={accent} opacity="0.85" />
            </marker>
          </defs>
          {paths.map(({ key, d, e }, i) => {
            if (!isVisible(e.from) || !isVisible(e.to)) return null;
            const hot = pulse && pulse.from === e.from && pulse.to === e.to;
            const weight = 1.2 + Math.min(e.count ?? 0, 6) * 0.3 + (hot ? 0.9 : 0);
            return (
              <g key={key}>
                <path
                  d={d}
                  stroke={accent}
                  strokeOpacity={e.kind === "handoff" ? 0.85 : 0.55}
                  strokeWidth={weight}
                  className={cn("tz-link", drawIn ? "tz-link-draw" : `tz-link-${e.kind}`)}
                  style={drawIn ? { animationDelay: `${i * 120}ms` } : undefined}
                  markerEnd={e.kind === "consult" ? undefined : `url(#tz-arrow-${accent.slice(1)})`}
                >
                  <title>{`${nodes.find((n) => n.id === e.from)?.name ?? ""} ${KIND_LABEL[e.kind] ?? e.kind} ${nodes.find((n) => n.id === e.to)?.name ?? ""}${e.count ? ` · ${e.count} échange(s) sur 7 jours` : ""}`}</title>
                </path>
                {motion && !drawIn && e.kind === "handoff" && (
                  <circle r={hot ? 3 : 2.2} fill={accent}>
                    <animateMotion dur={`${2.2 + (i % 3) * 0.5}s`} repeatCount="indefinite" path={d} begin={`${(i % 4) * 0.45}s`} />
                  </circle>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {w > 0 && nodes.map((n, i) => {
        const p = pos.get(n.id);
        if (!p || !isVisible(n.id)) return null;
        const size = n.lead && nodes.length >= 3 ? 50 : 38;
        return (
          <div
            key={n.id}
            className={cn("absolute flex flex-col items-center", drawIn && "tz-materialize")}
            style={{ left: p.x, top: p.y, transform: "translate(-50%, -50%)", animationDelay: drawIn ? `${i * 90}ms` : undefined, ["--tz-accent" as string]: n.accent || accent }}
            title={n.name}
          >
            <span className="relative grid place-items-center rounded-full border border-border bg-card" style={{ width: size + 6, height: size + 6 }}>
              {n.live && <span className="tz-live-ring" />}
              <AgentIdentity url={n.avatarUrl ?? null} seed={n.name} size={size} interactive={false} state={n.live ? "working" : "default"} />
            </span>
            {showLabels && (
              <span className={cn("mt-1 max-w-[92px] truncate rounded-full px-1.5 text-[10.5px] font-medium", n.lead ? "text-foreground" : "text-muted-foreground")}>
                {n.lead ? "★ " : ""}{n.name.split(" · ")[0]}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
