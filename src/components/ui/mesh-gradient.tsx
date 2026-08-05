import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

// Heavy film-grain texture SVG data URI for grainy film texture
const NOISE_SVG_DATA_URL = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.38'/%3E%3C/svg%3E`;

export interface MeshBlob {
  hex: string;
  alpha: number; // 0 to 1
  x: number; // initial percentage x (0 to 100)
  y: number; // initial percentage y (0 to 100)
  radius: number; // max radius percentage
}

export interface MeshPalette {
  name: string;
  backdrop: string;
  blobs: MeshBlob[];
}

// Electric, vibrant, yet deeply nuanced palettes featuring electric blues, cobalts & deep indigo
export const MESH_PALETTES: MeshPalette[] = [
  // 0: Electric Royal Blue & Cobalt Mesh (Default)
  {
    name: "Electric Cobalt",
    backdrop: "#0A0F24",
    blobs: [
      { hex: "#2563EB", alpha: 0.88, x: 66.94, y: 46.43, radius: 76.1 },
      { hex: "#3B82F6", alpha: 0.65, x: 34.69, y: 66.31, radius: 55.0 },
      { hex: "#1E1B4B", alpha: 0.82, x: 48.93, y: 19.32, radius: 67.0 },
      { hex: "#60A5FA", alpha: 0.70, x: 80.23, y: 87.54, radius: 45.0 },
    ],
  },
  // 1: Electric Violet & Neon Indigo
  {
    name: "Electric Violet",
    backdrop: "#0F0926",
    blobs: [
      { hex: "#7C3AED", alpha: 0.85, x: 65.0, y: 42.0, radius: 75.0 },
      { hex: "#4338CA", alpha: 0.65, x: 32.0, y: 68.0, radius: 52.0 },
      { hex: "#C084FC", alpha: 0.55, x: 50.0, y: 20.0, radius: 65.0 },
      { hex: "#38BDF8", alpha: 0.60, x: 82.0, y: 85.0, radius: 42.0 },
    ],
  },
  // 2: Electric Cyan & Deep Ocean
  {
    name: "Electric Ocean",
    backdrop: "#03192A",
    blobs: [
      { hex: "#0284C7", alpha: 0.85, x: 67.0, y: 44.0, radius: 75.0 },
      { hex: "#2563EB", alpha: 0.60, x: 33.0, y: 65.0, radius: 52.0 },
      { hex: "#06B6D4", alpha: 0.70, x: 48.0, y: 18.0, radius: 66.0 },
      { hex: "#818CF8", alpha: 0.55, x: 80.0, y: 86.0, radius: 40.0 },
    ],
  },
  // 3: Electric Cyber Pulse (Blue, Purple & Magenta Accent)
  {
    name: "Cyber Pulse",
    backdrop: "#0D0722",
    blobs: [
      { hex: "#3B82F6", alpha: 0.85, x: 64.0, y: 46.0, radius: 75.0 },
      { hex: "#D946EF", alpha: 0.50, x: 35.0, y: 66.0, radius: 50.0 },
      { hex: "#4F46E5", alpha: 0.75, x: 52.0, y: 22.0, radius: 64.0 },
      { hex: "#38BDF8", alpha: 0.65, x: 84.0, y: 84.0, radius: 42.0 },
    ],
  },
  // 4: Deep Ultramarine & Ice Blue
  {
    name: "Electric Ultramarine",
    backdrop: "#050B1E",
    blobs: [
      { hex: "#1D4ED8", alpha: 0.90, x: 66.0, y: 42.0, radius: 75.0 },
      { hex: "#6366F1", alpha: 0.60, x: 30.0, y: 68.0, radius: 50.0 },
      { hex: "#0284C7", alpha: 0.70, x: 48.0, y: 20.0, radius: 65.0 },
      { hex: "#93C5FD", alpha: 0.65, x: 82.0, y: 86.0, radius: 40.0 },
    ],
  },
];

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let clean = hex.replace("#", "");
  if (clean.length === 3) {
    clean = clean.split("").map((c) => c + c).join("");
  }
  const num = parseInt(clean, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(31, hash) + str.charCodeAt(i) | 0;
  }
  return Math.abs(hash);
}

export function getPaletteForSeed(seed?: string | number, paletteIndex?: number): MeshPalette {
  if (paletteIndex !== undefined && MESH_PALETTES[paletteIndex]) {
    return MESH_PALETTES[paletteIndex];
  }
  if (!seed) return MESH_PALETTES[0];
  const hash = typeof seed === "number" ? Math.abs(seed) : hashString(String(seed));
  return MESH_PALETTES[hash % MESH_PALETTES.length];
}

interface MeshGradientProps extends React.HTMLAttributes<HTMLDivElement> {
  seed?: string | number;
  paletteIndex?: number;
  speed?: number; // default 1.00
  motionAmount?: number; // default 0.40
  disabled?: boolean;
}

export function MeshGradientBackground({
  seed,
  paletteIndex,
  speed = 1.0,
  motionAmount = 0.40,
  disabled = false,
  className,
  children,
  style,
  ...props
}: MeshGradientProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  const palette = getPaletteForSeed(seed, paletteIndex);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const seedKey = String(seed ?? "default");
    const baseHash = hashString(seedKey);

    // Static phase per blob derived from seed
    const phases = palette.blobs.map((_, i) => {
      const p1 = ((baseHash + i * 17) % 360) * (Math.PI / 180);
      const p2 = ((baseHash + i * 31 + 99) % 360) * (Math.PI / 180);
      return { p1, p2 };
    });

    const parsedBlobs = palette.blobs.map((b) => ({
      ...b,
      rgb: hexToRgb(b.hex),
    }));

    let animationFrameId: number;
    let startTime: number | null = null;

    function render(now: number) {
      if (!el) return;
      if (startTime === null) startTime = now;
      const t = (now - startTime) / 1000;

      if (disabled) {
        const radialStops = parsedBlobs.map((b) => {
          const { r, g, b: blue } = b.rgb;
          const a0 = b.alpha;
          const a1 = (b.alpha * 0.844).toFixed(4);
          const a2 = (b.alpha * 0.5).toFixed(4);
          const a3 = (b.alpha * 0.156).toFixed(4);
          const r0 = (b.radius * 0.25).toFixed(2);
          const r1 = (b.radius * 0.5).toFixed(2);
          const r2 = (b.radius * 0.75).toFixed(2);
          const r3 = b.radius.toFixed(2);
          return `radial-gradient(circle at ${b.x}% ${b.y}%, rgba(${r}, ${g}, ${blue}, ${a0}) 0%, rgba(${r}, ${g}, ${blue}, ${a1}) ${r0}%, rgba(${r}, ${g}, ${blue}, ${a2}) ${r1}%, rgba(${r}, ${g}, ${blue}, ${a3}) ${r2}%, rgba(${r}, ${g}, ${blue}, 0) ${r3}%)`;
        });

        el.style.backgroundColor = palette.backdrop;
        el.style.backgroundImage = `url("${NOISE_SVG_DATA_URL}"), ${radialStops.join(", ")}`;
        el.style.backgroundSize = `200px 200px, ${parsedBlobs.map(() => "auto").join(", ")}`;
        el.style.backgroundBlendMode = `overlay, ${parsedBlobs.map(() => "normal").join(", ")}`;
        return;
      }

      const ph = t * speed;
      const amt = motionAmount;

      const radialStops = parsedBlobs.map((b, i) => {
        const { p1, p2 } = phases[i];
        const dx = (Math.sin(ph * 0.55 + p1) - Math.sin(p1)) * 14 * amt;
        const dy = (Math.sin(ph * 0.43 + p2) - Math.sin(p2)) * 14 * amt;

        const x = b.x + dx;
        const y = b.y + dy;

        const { r, g, b: blue } = b.rgb;
        const a0 = b.alpha;
        const a1 = (b.alpha * 0.844).toFixed(4);
        const a2 = (b.alpha * 0.5).toFixed(4);
        const a3 = (b.alpha * 0.156).toFixed(4);
        const r0 = (b.radius * 0.25).toFixed(2);
        const r1 = (b.radius * 0.5).toFixed(2);
        const r2 = (b.radius * 0.75).toFixed(2);
        const r3 = b.radius.toFixed(2);

        return `radial-gradient(circle at ${x}% ${y}%, rgba(${r}, ${g}, ${blue}, ${a0}) 0%, rgba(${r}, ${g}, ${blue}, ${a1}) ${r0}%, rgba(${r}, ${g}, ${blue}, ${a2}) ${r1}%, rgba(${r}, ${g}, ${blue}, ${a3}) ${r2}%, rgba(${r}, ${g}, ${blue}, 0) ${r3}%)`;
      });

      el.style.backgroundColor = palette.backdrop;
      el.style.backgroundImage = `url("${NOISE_SVG_DATA_URL}"), ${radialStops.join(", ")}`;
      el.style.backgroundSize = `200px 200px, ${parsedBlobs.map(() => "auto").join(", ")}`;
      el.style.backgroundBlendMode = `overlay, ${parsedBlobs.map(() => "normal").join(", ")}`;

      animationFrameId = requestAnimationFrame(render);
    }

    animationFrameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [palette, seed, speed, motionAmount, disabled]);

  return (
    <div
      ref={containerRef}
      className={cn("relative overflow-hidden transition-all duration-300", className)}
      style={{
        backgroundColor: palette.backdrop,
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}
