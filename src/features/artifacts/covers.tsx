/**
 * Cover art for a document's header.
 *
 * Everything here is drawn — CSS gradients and inline SVG, no image files and
 * no network. A cover has to work on a page that may be opened offline, and a
 * stock photo would date the document faster than its content does. Drawing it
 * also means every cover scales to any header height without cropping.
 *
 * All covers are dark enough for white text at every point; that is the one
 * constraint a cover cannot break, since the title sits on top of it.
 */
import { type ReactNode } from "react";

export interface Cover {
  key: string;
  label: string;
  /** The base wash — a Tailwind gradient or an inline background. */
  className?: string;
  style?: React.CSSProperties;
  /** Anything drawn over the wash: texture, strokes, contour lines. */
  art?: ReactNode;
}

/* --------------------------------------------------------------- textures */

/**
 * Ink diffusing into paper.
 *
 * `feTurbulence` fed through `feDisplacementMap` pushes soft blobs out of shape,
 * which is what gives a wash its torn, bleeding edge — a plain blurred ellipse
 * reads as a smudge, not as ink.
 */
function InkWash({ seed, hue }: { seed: number; hue: string }) {
  const id = `ink${seed}`;
  return (
    <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid slice" viewBox="0 0 400 200" aria-hidden>
      <defs>
        <filter id={`${id}-f`} x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.022" numOctaves="4" seed={seed} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="46" xChannelSelector="R" yChannelSelector="G" />
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
      </defs>
      <g filter={`url(#${id}-f)`} fill={hue}>
        <ellipse cx="96" cy="128" rx="86" ry="52" opacity="0.55" />
        <ellipse cx="248" cy="72" rx="104" ry="46" opacity="0.4" />
        <ellipse cx="330" cy="150" rx="70" ry="38" opacity="0.3" />
      </g>
    </svg>
  );
}

/** Dry brush strokes, sumi-e style: tapered, translucent, slightly ragged. */
function BrushStrokes() {
  return (
    <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid slice" viewBox="0 0 400 200" aria-hidden>
      <defs>
        <filter id="sumi-f" x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="6" />
        </filter>
      </defs>
      <g filter="url(#sumi-f)" fill="none" stroke="#f8fafc" strokeLinecap="round">
        <path d="M-10 158 C 90 120, 150 176, 250 128 S 380 96, 420 118" strokeWidth="20" opacity="0.10" />
        <path d="M-10 92 C 70 58, 170 112, 260 66 S 372 40, 420 58" strokeWidth="9" opacity="0.16" />
        <path d="M40 186 C 120 168, 190 196, 300 172" strokeWidth="4" opacity="0.22" />
      </g>
    </svg>
  );
}

/** Contour lines, as on a topographic map. */
function Contours() {
  return (
    <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid slice" viewBox="0 0 400 200" aria-hidden>
      <g fill="none" stroke="#ffffff" strokeWidth="1">
        {Array.from({ length: 11 }, (_, i) => (
          <ellipse key={i} cx="300" cy="46" rx={26 + i * 27} ry={16 + i * 17} opacity={0.16 - i * 0.011} />
        ))}
        {Array.from({ length: 8 }, (_, i) => (
          <ellipse key={`b${i}`} cx="60" cy="180" rx={20 + i * 24} ry={12 + i * 15} opacity={0.13 - i * 0.012} />
        ))}
      </g>
    </svg>
  );
}

/** Fine film grain — enough to kill the banding a wide gradient shows. */
function Grain({ opacity = 0.22 }: { opacity?: number }) {
  return (
    <svg className="absolute inset-0 h-full w-full mix-blend-overlay" preserveAspectRatio="none" aria-hidden style={{ opacity }}>
      <filter id="grain-f">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
      </filter>
      <rect width="100%" height="100%" filter="url(#grain-f)" />
    </svg>
  );
}

/* ----------------------------------------------------------- the catalogue */

export const COVERS: Cover[] = [
  {
    key: "indigo",
    label: "Indigo",
    className: "bg-gradient-to-br from-indigo-600 via-indigo-700 to-indigo-900",
    art: <Grain opacity={0.16} />,
  },
  {
    key: "aurore",
    label: "Aurore",
    // A mesh gradient: several radial washes over a base, which reads far softer
    // than a linear ramp between the same two colours.
    style: {
      backgroundColor: "#3b1e54",
      backgroundImage: [
        "radial-gradient(at 12% 18%, #f97362 0px, transparent 55%)",
        "radial-gradient(at 82% 8%, #f5b642 0px, transparent 50%)",
        "radial-gradient(at 68% 92%, #7c3aed 0px, transparent 55%)",
        "radial-gradient(at 30% 88%, #db2777 0px, transparent 45%)",
      ].join(","),
    },
    art: <Grain opacity={0.2} />,
  },
  {
    key: "ocean",
    label: "Océan",
    style: {
      backgroundColor: "#04283c",
      backgroundImage: [
        "radial-gradient(at 8% 82%, #0e7490 0px, transparent 55%)",
        "radial-gradient(at 78% 22%, #0891b2 0px, transparent 50%)",
        "radial-gradient(at 48% 100%, #065f46 0px, transparent 50%)",
      ].join(","),
    },
    art: <Contours />,
  },
  {
    key: "encre",
    label: "Encre",
    style: { backgroundColor: "#14243d" },
    art: <><InkWash seed={3} hue="#5b8dd6" /><Grain opacity={0.24} /></>,
  },
  {
    key: "sumi",
    label: "Sumi-e",
    style: {
      backgroundColor: "#0f0f10",
      backgroundImage: "radial-gradient(at 30% 20%, #2c2c30 0px, transparent 60%)",
    },
    art: <><BrushStrokes /><Grain opacity={0.28} /></>,
  },
  {
    key: "cinabre",
    label: "Cinabre",
    style: { backgroundColor: "#3b0d0d" },
    art: <><InkWash seed={11} hue="#d64545" /><Grain opacity={0.22} /></>,
  },
  {
    key: "emeraude",
    label: "Émeraude",
    className: "bg-gradient-to-br from-emerald-600 via-teal-700 to-slate-900",
    art: <Contours />,
  },
  {
    key: "agrumes",
    label: "Agrumes",
    style: {
      backgroundColor: "#7c2d12",
      backgroundImage: [
        "radial-gradient(at 18% 24%, #f59e0b 0px, transparent 52%)",
        "radial-gradient(at 88% 72%, #dc2626 0px, transparent 48%)",
        "radial-gradient(at 52% 4%, #fbbf24 0px, transparent 42%)",
      ].join(","),
    },
    art: <Grain opacity={0.2} />,
  },
  {
    key: "vitrail",
    label: "Vitrail",
    style: {
      backgroundColor: "#1e1b4b",
      backgroundImage: "conic-gradient(from 210deg at 68% 34%, #4338ca, #0ea5e9, #7c3aed, #be185d, #4338ca)",
    },
    art: <Grain opacity={0.3} />,
  },
  {
    key: "graphite",
    label: "Graphite",
    style: {
      backgroundColor: "#18181b",
      backgroundImage: [
        "linear-gradient(115deg, #27272a 0%, #18181b 46%, #0a0a0b 100%)",
        "radial-gradient(at 84% 12%, #3f3f46 0px, transparent 46%)",
      ].join(","),
    },
    art: <Grain opacity={0.26} />,
  },
  {
    key: "sable",
    label: "Sable",
    style: { backgroundColor: "#332616" },
    art: <><InkWash seed={19} hue="#b98a3f" /><Grain opacity={0.24} /></>,
  },
  {
    key: "nocturne",
    label: "Nocturne",
    style: {
      backgroundColor: "#020617",
      backgroundImage: [
        "radial-gradient(at 76% 18%, #1e3a8a 0px, transparent 50%)",
        "radial-gradient(at 22% 76%, #312e81 0px, transparent 46%)",
      ].join(","),
    },
    art: <Contours />,
  },
];

const BY_KEY = new Map(COVERS.map((c) => [c.key, c]));

/**
 * The cover for a document.
 *
 * With no explicit choice, one is derived from the artifact's id rather than
 * defaulting everything to indigo: a gallery where every document looks the same
 * makes the covers useless as a way of telling them apart, and the id keeps the
 * pick stable across reloads.
 */
export function resolveCover(key: string | undefined, seed: string): Cover {
  const chosen = key ? BY_KEY.get(key) : undefined;
  if (chosen) return chosen;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COVERS[h % COVERS.length];
}
