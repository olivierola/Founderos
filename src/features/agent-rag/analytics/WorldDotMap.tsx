import { useMemo, useState } from "react";
import { useContextGreys } from "@/features/crm/overview/vizPalette";
import { rampAt, useSequential } from "./vizRamps";
import { COUNTRY_NAMES, COUNTRY_POINTS, GRID_H, GRID_W, LAND_ROWS, LAT_BOTTOM, LAT_TOP } from "./worldGrid";

// Carte d'audience en points.
//
// Le fond est une grille de terres émergées rasterisée hors ligne (worldGrid.ts)
// : pas de topojson à charger, pas de librairie carto, et la carte fonctionne
// hors-ligne comme le reste du dashboard. La projection est équirectangulaire,
// bornée au 83e nord / 56e sud — l'Antarctique n'a pas de visiteurs.
//
// La couleur des marqueurs encode une MAGNITUDE (visiteurs par pays), donc une
// seule teinte du clair au foncé. Chaque marqueur est doublé d'une ligne
// chiffrée dans la liste voisine : sur une carte, la position ne suffit jamais
// à lire une quantité.

export interface CountryDatum {
  code: string;
  visitors: number;
  conversations: number;
}

const DOT_R = 1.15;

export function WorldDotMap({
  data, height = 300, onHover, hovered,
}: {
  data: CountryDatum[];
  height?: number;
  onHover?: (code: string | null) => void;
  hovered?: string | null;
}) {
  const greys = useContextGreys();
  const ramp = useSequential();
  const [localHover, setLocalHover] = useState<string | null>(null);
  const active = hovered ?? localHover;

  const width = (GRID_W / GRID_H) * height;

  const dots = useMemo(() => {
    const out: { x: number; y: number }[] = [];
    LAND_ROWS.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        if (row[c] === "1") out.push({ x: c + 0.5, y: r + 0.5 });
      }
    });
    return out;
  }, []);

  const markers = useMemo(() => {
    const max = Math.max(1, ...data.map((d) => d.visitors));
    return data
      .map((d) => {
        const pt = COUNTRY_POINTS[d.code];
        if (!pt) return null;
        const [lon, lat] = pt;
        // Longitude → colonne, latitude → rangée, dans le même repère que la
        // grille (une unité = une cellule), pour que marqueurs et points de
        // terre restent alignés à n'importe quelle taille.
        const x = ((lon + 180) / 360) * GRID_W;
        const y = ((LAT_TOP - lat) / (LAT_TOP - LAT_BOTTOM)) * GRID_H;
        if (y < 0 || y > GRID_H) return null;
        const t = d.visitors / max;
        return {
          ...d,
          x, y, t,
          color: rampAt(ramp, t),
          r: 2.2 + t * 3.2,
          name: COUNTRY_NAMES[d.code] ?? d.code,
        };
      })
      .filter(Boolean) as (CountryDatum & { x: number; y: number; t: number; color: string; r: number; name: string })[];
  }, [data, ramp]);

  return (
    <svg
      viewBox={`0 0 ${GRID_W} ${GRID_H}`}
      width="100%"
      height={height}
      style={{ maxWidth: width }}
      role="img"
      aria-label="Répartition des visiteurs par pays"
      onMouseLeave={() => { setLocalHover(null); onHover?.(null); }}
    >
      <g fill={greys.empty}>
        {dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={DOT_R} />)}
      </g>
      {markers.map((m) => {
        const on = active === m.code;
        return (
          <g key={m.code}
            onMouseEnter={() => { setLocalHover(m.code); onHover?.(m.code); }}
            style={{ cursor: "default" }}>
            {/* Halo : la cible de survol doit être plus grande que la marque,
                sinon un pays à 3 visiteurs devient impossible à pointer. */}
            <circle cx={m.x} cy={m.y} r={Math.max(m.r + 3, 5)} fill="transparent" />
            <circle
              cx={m.x} cy={m.y} r={m.r}
              fill={m.color}
              stroke="hsl(var(--card))"
              strokeWidth={0.8}
              opacity={active && !on ? 0.45 : 1}
              style={{ transition: "opacity 150ms" }}
            >
              <title>{`${m.name} — ${m.visitors} visiteur${m.visitors > 1 ? "s" : ""}, ${m.conversations} conversation${m.conversations > 1 ? "s" : ""}`}</title>
            </circle>
            {on && (
              <text
                x={m.x} y={m.y - m.r - 2.5}
                textAnchor="middle"
                className="fill-foreground"
                style={{ fontSize: 4, fontWeight: 600 }}
              >
                {m.name}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Encre lisible sur un fond donné. La pastille du pays de tête porte le pas
 *  le plus clair de la rampe en thème sombre : y écrire du blanc en dur rend le
 *  code pays illisible précisément sur la ligne la plus importante. */
function readableInk(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return L > 0.42 ? "#14130f" : "#ffffff";
}

/** Pastille pays : le code ISO en toutes lettres. Les emojis drapeaux ne sont
 *  pas rendus sous Windows (deux lettres brutes s'affichent à la place), donc
 *  autant assumer la pastille — elle est lisible partout, y compris en
 *  niveaux de gris. */
export function CountryChip({ code, color }: { code: string; color?: string }) {
  const bg = color ?? "#6b6a63";
  return (
    <span
      className="inline-flex h-4 w-6 shrink-0 items-center justify-center rounded-[3px] text-[9px] font-bold tracking-tight"
      style={{ background: bg, color: readableInk(bg) }}
      aria-hidden
    >
      {code}
    </span>
  );
}

export { COUNTRY_NAMES };
