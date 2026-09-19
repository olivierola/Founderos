import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useContextGreys } from "@/features/crm/overview/vizPalette";

// Entonnoir de performance — un Sankey à quatre étages, dessiné à la main.
//
// Pas de dépendance ajoutée : d3-sankey n'est pas dans le projet et le calcul
// se réduit ici à empiler des valeurs et à tracer des rubans, parce que la
// topologie est connue à l'avance (canal → implication → issue → satisfaction)
// et strictement acyclique.
//
// Un ruban ne DOIT jamais être déduit d'un prorata : chaque lien vient d'un
// comptage réel (tableau croisé de la RPC 0217). Un entonnoir dont les flux
// sont estimés raconte une histoire que personne n'a vécue.

export interface FunnelNode {
  key: string;
  label: string;
  value: number;
  color: string;
}
export interface FunnelLink {
  from: string;
  to: string;
  value: number;
}

const NODE_W = 9;
const NODE_GAP = 12;
/** Hauteur d'un bloc d'étiquette (titre + valeur) : en dessous, deux nœuds
 *  voisins écrivent l'un sur l'autre. Deux branches minuscules — « CX neutre »
 *  et « CX négatif » sur un agent qui marche bien — sont précisément le cas où
 *  l'entonnoir doit rester lisible. */
const LABEL_H = 26;
const PAD_TOP = 14;
const PAD_BOTTOM = 14;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function ribbon(x0: number, y0: number, x1: number, y1: number, h0: number, h1: number): string {
  const mx = (x0 + x1) / 2;
  return [
    `M${x0},${y0}`,
    `C${mx},${y0} ${mx},${y1} ${x1},${y1}`,
    `L${x1},${y1 + h1}`,
    `C${mx},${y1 + h1} ${mx},${y0 + h0} ${x0},${y0 + h0}`,
    "Z",
  ].join(" ");
}

export function Funnel({
  stages, links, height = 340, valueFormat = (v: number) => v.toLocaleString("fr-FR"),
}: {
  stages: FunnelNode[][];
  links: FunnelLink[];
  height?: number;
  valueFormat?: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const greys = useContextGreys();
  const [hover, setHover] = useState<string | null>(null);

  const layout = useMemo(() => {
    const visible = stages.map((col) => col.filter((n) => n.value > 0));
    // L'échelle est commune à toutes les colonnes : sinon un étage qui perd du
    // volume paraîtrait aussi épais que celui d'avant, et l'entonnoir cesserait
    // d'être un entonnoir.
    const maxTotal = Math.max(1, ...visible.map((col) => col.reduce((s, n) => s + n.value, 0)));
    const maxNodes = Math.max(1, ...visible.map((col) => col.length));
    const usable = Math.max(40, height - PAD_TOP - PAD_BOTTOM - (maxNodes - 1) * NODE_GAP);
    const scale = usable / maxTotal;

    const cols = visible.map((col, ci) => {
      const colHeight = col.reduce((s, n) => s + n.value * scale, 0) + (col.length - 1) * NODE_GAP;
      let y = PAD_TOP + Math.max(0, (height - PAD_TOP - PAD_BOTTOM - colHeight) / 2);
      const laid = col.map((n) => {
        const h = Math.max(3, n.value * scale);
        const node = { ...n, x: 0, y, h, stage: ci, labelY: y + 11 };
        y += h + NODE_GAP;
        return node;
      });
      // Passe de décollision : chaque étiquette descend juste assez pour ne pas
      // toucher la précédente. Le nœud, lui, ne bouge pas — c'est la géométrie
      // des flux, elle n'a pas à mentir pour arranger du texte.
      let floor = -Infinity;
      for (const n of laid) {
        n.labelY = Math.max(n.labelY, floor);
        floor = n.labelY + LABEL_H;
      }
      return laid;
    });

    // Position horizontale : les colonnes intermédiaires portent leur libellé à
    // droite du montant, la dernière à gauche — sinon le texte sort du cadre.
    const colX = (ci: number) => {
      if (cols.length <= 1) return 0;
      return (ci / (cols.length - 1)) * Math.max(0, width - NODE_W);
    };
    cols.forEach((col, ci) => col.forEach((n) => { n.x = colX(ci); }));

    const byKey = new Map(cols.flat().map((n) => [n.key, n]));
    // Curseur d'empilement par nœud : les rubans sortent (et entrent) dans
    // l'ordre de déclaration des liens, ce qui évite les croisements gratuits.
    const outCursor = new Map<string, number>();
    const inCursor = new Map<string, number>();
    const paths = links
      .filter((l) => l.value > 0 && byKey.has(l.from) && byKey.has(l.to))
      .map((l) => {
        const a = byKey.get(l.from)!;
        const b = byKey.get(l.to)!;
        // Un ruban a la même épaisseur aux deux bouts : c'est le même volume
        // de conversations qui passe, et un ruban qui s'affine mentirait.
        const h0 = l.value * scale;
        const h1 = h0;
        const y0 = a.y + (outCursor.get(a.key) ?? 0);
        const y1 = b.y + (inCursor.get(b.key) ?? 0);
        outCursor.set(a.key, (outCursor.get(a.key) ?? 0) + h0);
        inCursor.set(b.key, (inCursor.get(b.key) ?? 0) + h1);
        return {
          key: `${l.from}->${l.to}`,
          d: ribbon(a.x + NODE_W, y0, b.x, y1, Math.max(1, h0), Math.max(1, h1)),
          from: a, to: b, value: l.value,
        };
      });

    return { cols, paths, lastStage: cols.length - 1 };
  }, [stages, links, height, width]);

  const nodes = layout.cols.flat();

  return (
    <div ref={ref} className="w-full">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Entonnoir de performance">
          {/* Rubans d'abord : ils passent SOUS les barres de nœuds. Gris de
              contexte — le flux porte la quantité, pas une identité de plus. */}
          <g>
            {layout.paths.map((p) => {
              const dim = hover != null && hover !== p.from.key && hover !== p.to.key;
              return (
                <path
                  key={p.key}
                  d={p.d}
                  fill={greys.context}
                  fillOpacity={dim ? 0.08 : hover ? 0.45 : 0.28}
                  style={{ transition: "fill-opacity 150ms" }}
                  onMouseEnter={() => setHover(p.from.key)}
                  onMouseLeave={() => setHover(null)}
                >
                  <title>{`${p.from.label} → ${p.to.label} : ${valueFormat(p.value)}`}</title>
                </path>
              );
            })}
          </g>

          {nodes.map((n) => {
            const isLast = n.stage === layout.lastStage;
            const dim = hover != null && hover !== n.key;
            return (
              <g key={n.key}
                onMouseEnter={() => setHover(n.key)}
                onMouseLeave={() => setHover(null)}
                style={{ opacity: dim ? 0.45 : 1, transition: "opacity 150ms" }}>
                <rect x={n.x} y={n.y} width={NODE_W} height={n.h} rx={4} fill={n.color}>
                  <title>{`${n.label} : ${valueFormat(n.value)}`}</title>
                </rect>
                <text
                  x={isLast ? n.x - 8 : n.x + NODE_W + 8}
                  y={n.labelY}
                  textAnchor={isLast ? "end" : "start"}
                  className="fill-foreground text-[10px] font-medium uppercase tracking-wide"
                >
                  {n.label}
                </text>
                <text
                  x={isLast ? n.x - 8 : n.x + NODE_W + 8}
                  y={n.labelY + 13}
                  textAnchor={isLast ? "end" : "start"}
                  className="fill-muted-foreground text-[11px] tabular-nums"
                >
                  {valueFormat(n.value)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
