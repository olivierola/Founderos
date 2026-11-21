import { useMemo } from "react";
import type { Fixture, Layout, Zone } from "./layout";
import type { AgentState, SceneAgent } from "./LiveScene";

// Le PLAN 2D du Live Space : les mêmes locaux, vus de dessus, en SVG.
//
// Il prend le relais quand la 3D ne peut pas tourner (WebGL coupé, bloqué
// après une erreur graphique, pertes de contexte à répétition) — et l'on peut
// aussi le choisir. Il lit le MÊME plan que la scène : rien ne diverge. Les
// agents y sont à leur poste, à la couleur de leur état, et se cliquent.

const STATE_RING: Record<AgentState, string> = {
  working: "#34d399", waiting: "#fbbf24", error: "#ef4444", idle: "#a1a1aa",
};

const ZONE_FILL: Partial<Record<Zone["kind"], string>> = {
  meeting: "#c9d2e3", memory: "#dfe2e8", creative: "#f1dfb3", huddle: "#d5dceb",
  cafe: "#efe2cf", lounge: "#e9dcc8", focus: "#d6e2ee",
};

/** L'emprise dessinée d'un meuble : [largeur, profondeur, couleur, rond ?]. */
function shapeOf(f: Fixture): [number, number, string, boolean] | null {
  const s = f.s ?? 1;
  switch (f.kind) {
    case "workstation": return [1.5, 0.8, "#c79b6d", false];
    case "benchTable": return [f.len ?? 3, 0.95, "#d8b98f", false];
    case "meetingTable": return [f.len ?? 3.4, 1.3, "#6e4f3a", false];
    case "roundTable": return [1.4, 1.4, "#c79b6d", true];
    case "table_medium": return [1.4, 1.4, "#b07a52", false];
    case "table_medium_long": return [2.1, 1.4, "#b07a52", false];
    case "couch": case "couch_pillows": return [2.1, 1.12, "#e8c368", false];
    case "armchair": case "armchair_pillows": return [1.26, 1.12, "#e8c368", false];
    case "booth": return [1.7, 1.6, f.color ?? "#7aa6d8", false];
    case "pingpong": return [1.5, 2.6, "#2f6f9f", false];
    case "kitchenBar": case "kitchenCabinet": case "kitchenSink": case "kitchenFridge": case "kitchenFridgeSmall":
      return [0.88, 0.6, "#cfc6b8", false];
    case "bookcaseOpen": case "bookcaseOpenLow": return [0.82, 0.5, "#a77b52", false];
    case "bookcaseClosedWide": return [1.63, 0.5, "#a77b52", false];
    case "serverRack": return [0.7, 0.6, "#2b2e38", false];
    case "pottedPlant": return [0.5 * s, 0.5 * s, "#5aa957", true];
    case "planterBox": case "planterBig": return [f.len ?? 1.6, f.depth ?? 0.5, "#6fbf5f", false];
    case "pouf": return [0.5, 0.5, f.color ?? "#e39b3b", true];
    case "rug": return [f.len ?? 2, f.depth ?? 2, f.color ?? "#c98b6b", false];
    case "rugDisc": return [f.len ?? 2, f.len ?? 2, f.color ?? "#c98b6b", true];
    default: return null;
  }
}

export function LivePlan({ layout, agents, selectedId, hoveredId, onSelect, onHover, colorOf }: {
  layout: Layout;
  agents: SceneAgent[];
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  colorOf: (a: SceneAgent) => string;
}) {
  const b = layout.building;
  const pad = 1.2;
  const vb = `${b.minX - pad} ${b.minZ - pad} ${b.maxX - b.minX + pad * 2} ${b.maxZ - b.minZ + pad * 2}`;
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const fixtureShapes = (fs: Fixture[]) => fs.map((f, i) => {
    const sh = shapeOf(f);
    if (!sh || (f.y ?? 0) > 0) return null;
    const [w, d, c, round] = sh;
    const rug = f.kind === "rug" || f.kind === "rugDisc";
    const deg = (-f.rot * 180) / Math.PI;
    return round
      ? <circle key={i} cx={f.x} cy={f.z} r={w / 2} fill={c} opacity={rug ? 0.45 : 0.9} />
      : <rect key={i} x={-w / 2} y={-d / 2} width={w} height={d} rx={0.06} fill={c} opacity={rug ? 0.45 : 0.9}
          transform={`translate(${f.x} ${f.z}) rotate(${deg})`} />;
  });

  return (
    <svg viewBox={vb} className="h-full w-full" onClick={() => onSelect(null)} role="img" aria-label="Plan des locaux">
      <rect x={b.minX - 0.2} y={b.minZ - 0.2} width={b.maxX - b.minX + 0.4} height={b.maxZ - b.minZ + 0.4} rx={0.3} fill="#2a2522" />
      <rect x={layout.hall.x0} y={layout.hall.z0} width={layout.hall.x1 - layout.hall.x0} height={layout.hall.z1 - layout.hall.z0} fill="#d9b48c" />
      <rect x={layout.hall.x0 + 1.3} y={-layout.hall.half * 0.45} width={layout.hall.x1 - layout.hall.x0 - 2.6} height={layout.hall.half * 0.9} fill="#c49a76" opacity={0.6} />
      {layout.zones.map((z) => (
        <g key={z.key}>
          {(z.side !== "open" || z.floor !== "none") && (
            <rect x={z.x} y={z.z} width={z.w} height={z.d}
              fill={z.color ? z.color : ZONE_FILL[z.kind] ?? "#e6d6c0"} opacity={z.color ? 0.28 : 1} />
          )}
          {fixtureShapes(z.fixtures)}
          {z.walls.map((w, i) => (
            <line key={i} x1={w.x1} y1={w.z1} x2={w.x2} y2={w.z2}
              stroke={w.kind === "feature" ? (w.color ?? "#999") : w.kind === "glass" ? "#9cc3e6" : w.kind === "planter" ? "#6fbf5f" : "#f3ece2"}
              strokeWidth={w.kind === "feature" ? 0.28 : 0.16} strokeLinecap="square" />
          ))}
          {z.kind !== "nook" && (
            <text x={z.x + z.w / 2} y={z.side === "open" ? z.z + 0.75 : z.z + z.d / 2} textAnchor="middle"
              fontSize={0.62} fontWeight={700} fill={z.color ? "#2a2522" : "#4a4038"} style={{ pointerEvents: "none" }}>
              {z.label}
            </text>
          )}
        </g>
      ))}
      {fixtureShapes(layout.hall.fixtures)}
      {layout.shell.map((w, i) => (
        <line key={i} x1={w.x1} y1={w.z1} x2={w.x2} y2={w.z2} stroke="#f3ece2" strokeWidth={0.18} />
      ))}
      {[...layout.seatOf.entries()].map(([id, { seat }]) => {
        const a = byId.get(id);
        if (!a) return null;
        const focus = id === selectedId || id === hoveredId;
        return (
          <g key={id} transform={`translate(${seat.x} ${seat.z})`} style={{ cursor: "pointer" }}
            onClick={(e) => { e.stopPropagation(); onSelect(id); }}
            onMouseEnter={() => onHover(id)} onMouseLeave={() => onHover(null)}>
            <circle r={focus ? 0.5 : 0.42} fill={colorOf(a)} stroke={STATE_RING[a.state]} strokeWidth={0.12} />
            <text y={1.0} textAnchor="middle" fontSize={0.42} fontWeight={600} fill="#fff8ee"
              stroke="#2a2522" strokeWidth={0.12} paintOrder="stroke" style={{ pointerEvents: "none" }}>
              {a.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
