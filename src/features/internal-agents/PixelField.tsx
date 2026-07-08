import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h || "2f2fe4", 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Animated pixel/dot field for cards. Subtle and STATIC when idle (drawn once,
 * no rAF), and only the hovered card runs an animation loop where the dots
 * flicker and take a more pronounced accent colour. Scales to a whole grid
 * because at most one card animates at a time.
 */
export function PixelField({
  accent,
  active,
  gap = 11,
  className,
}: {
  accent: string;
  active: boolean;
  gap?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { r, g, b } = hexToRgb(accent);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const G = gap * dpr;

    const sizeTo = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    };

    const draw = (t: number) => {
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const baseAlpha = active ? 0.5 : 0.16;
      const radius = (active ? 1.9 : 1.5) * dpr;
      for (let y = G / 2; y < h; y += G) {
        for (let x = G / 2; x < w; x += G) {
          const seed = Math.sin(x * 12.9898 + y * 4.1414) * 43758.5453;
          const rnd = seed - Math.floor(seed);
          // Static: a fixed per-dot dimming. Animated: gentle flicker over time.
          const flick = active ? 0.45 + 0.55 * Math.sin(t * 2.2 + rnd * 6.2832) : 0.35 + 0.65 * rnd;
          ctx.fillStyle = `rgba(${r},${g},${b},${(baseAlpha * flick).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, 6.2832);
          ctx.fill();
        }
      }
    };

    sizeTo();
    const ro = new ResizeObserver(() => { sizeTo(); draw(0); });
    ro.observe(canvas);

    let raf = 0;
    if (active) {
      let t = 0;
      const loop = () => { t += 0.016; draw(t); raf = requestAnimationFrame(loop); };
      loop();
    } else {
      draw(0); // static field, no animation loop
    }

    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [accent, active, gap]);

  return <canvas ref={ref} aria-hidden className={cn("pointer-events-none absolute inset-0 h-full w-full", className)} />;
}
