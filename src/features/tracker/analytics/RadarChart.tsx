import { useMemo } from "react";
import { useCategorical, useContextGreys } from "@/features/crm/overview/vizPalette";

/**
 * Le radar « Project Insights ».
 *
 * Il sert à une chose : voir d'un coup si un service est ÉQUILIBRÉ. Sept axes
 * (work items, cycles, modules, intake, membres, pages, vues), et c'est la
 * FORME qui informe — un polygone qui pointe vers un seul axe dit un service
 * qui empile des tickets sans jamais les organiser en itérations ; un polygone
 * régulier dit un usage complet de l'outil.
 *
 * Le radar est un mauvais choix pour comparer des valeurs précises — l'aire
 * croît au carré du rayon et exagère les écarts, et l'ordre des axes change la
 * silhouette. Il est en revanche le bon choix ici, parce que la question n'est
 * pas « combien » (le tableau à côté le dit) mais « la répartition est-elle
 * régulière ». Les deux sont côte à côte pour cette raison.
 *
 * Chaque axe est normalisé sur SON propre maximum : sans cela, les work items
 * (des dizaines) écraseraient les cycles (quelques-uns) et la forme ne dirait
 * plus rien.
 */

export interface RadarAxis {
  label: string;
  value: number;
  /** Le maximum de cet axe, pour la normalisation. */
  max: number;
}

export function RadarChart({ axes, size = 300 }: { axes: RadarAxis[]; size?: number }) {
  const palette = useCategorical();
  const greys = useContextGreys();

  const geometry = useMemo(() => {
    const n = axes.length;
    if (n < 3) return null;

    const cx = size / 2;
    const cy = size / 2;
    // On garde une marge pour les étiquettes, qui sortent du polygone.
    const radius = size / 2 - 46;

    const angle = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
    const at = (i: number, r: number) => ({
      x: cx + Math.cos(angle(i)) * r,
      y: cy + Math.sin(angle(i)) * r,
    });

    // Quatre anneaux de repère : assez pour donner l'échelle, assez peu pour ne
    // pas transformer le fond en toile d'araignée.
    const rings = [0.25, 0.5, 0.75, 1].map((f) =>
      axes.map((_, i) => {
        const p = at(i, radius * f);
        return `${p.x},${p.y}`;
      }).join(" "));

    const spokes = axes.map((_, i) => {
      const p = at(i, radius);
      return { x1: cx, y1: cy, x2: p.x, y2: p.y };
    });

    const points = axes.map((a, i) => {
      const ratio = a.max > 0 ? Math.min(1, a.value / a.max) : 0;
      // Un plancher de 2 % : un axe à zéro replié sur le centre rendrait le
      // polygone dégénéré et illisible, alors que « rien » est une information.
      return at(i, radius * Math.max(0.02, ratio));
    });

    const labels = axes.map((a, i) => {
      const p = at(i, radius + 22);
      return {
        ...p, label: a.label, value: a.value,
        anchor: Math.abs(p.x - cx) < 12 ? "middle" : p.x > cx ? "start" : "end",
      };
    });

    return {
      rings, spokes, labels,
      polygon: points.map((p) => `${p.x},${p.y}`).join(" "),
      dots: points,
    };
  }, [axes, size]);

  if (!geometry) return null;

  return (
    <svg
      width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Répartition : ${axes.map((a) => `${a.label} ${a.value}`).join(", ")}`}
      className="max-w-full"
    >
      {geometry.rings.map((r, i) => (
        <polygon
          key={i} points={r} fill="none"
          stroke={greys.context} strokeWidth="1" opacity={i === 3 ? 0.5 : 0.25}
        />
      ))}
      {geometry.spokes.map((s, i) => (
        <line key={i} {...s} stroke={greys.context} strokeWidth="1" opacity="0.25" />
      ))}

      <polygon points={geometry.polygon} fill={palette[0]} opacity="0.35" />
      <polygon points={geometry.polygon} fill="none" stroke={palette[0]} strokeWidth="1.5" />
      {geometry.dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r="3" fill={palette[0]} />
      ))}

      {geometry.labels.map((l) => (
        <text
          key={l.label}
          x={l.x} y={l.y}
          textAnchor={l.anchor as "start" | "middle" | "end"}
          dominantBaseline="middle"
          className="fill-muted-foreground text-11"
          style={{ fontSize: 11 }}
        >
          {l.label}
        </text>
      ))}
    </svg>
  );
}
