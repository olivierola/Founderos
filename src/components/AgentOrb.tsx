import { cn } from "@/lib/utils";
import { SiriOrb } from "@/components/ui/siri-orb";
import { Orb } from "@/components/ui/orb";

// Agent identity orb. Prominent spots (≥28px) use the WebGL Orb (each owns a GL
// context — browsers cap ~16, so tiny/list avatars fall back to the cheap CSS
// SiriOrb). Both are tinted toward the agent's accent colour.
function hexToHsl(hex?: string | null): [number, number, number] | null {
  const m = hex && /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  const r = ((int >> 16) & 255) / 255, g = ((int >> 8) & 255) / 255, b = (int & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

// Below this size, use the CSS orb (no WebGL context).
const OGL_MIN = 28;

export function AgentOrb({ size = 32, className, glow = true, accentColor }: {
  size?: number;
  className?: string;
  /** Soft outer glow (turn off when placed on a busy/tinted surface). */
  glow?: boolean;
  /** Tint the orb to this agent's accent colour; defaults to the base orb. */
  accentColor?: string | null;
}) {
  const hsl = hexToHsl(accentColor);
  const glowShadow = glow
    ? `0 0 10px 0 ${accentColor && /^#([0-9a-f]{6})$/i.test(accentColor) ? accentColor + "40" : "rgba(120,90,255,0.28)"}`
    : undefined;

  const inner = size >= OGL_MIN
    // WebGL orb — hue rotates the base violet (~270°) toward the accent hue.
    ? <Orb hue={hsl ? (((hsl[0] - 270) % 360) + 360) % 360 : 0} hoverIntensity={0.3} rotateOnHover forceHoverState={false} />
    : <SiriOrb
        size={size}
        animationDuration={16}
        colors={hsl ? {
          c1: `hsl(${hsl[0]} ${Math.min(Math.max(hsl[1], 62), 95)}% ${Math.min(Math.max(hsl[2], 58), 72)}%)`,
          c2: `hsl(${(hsl[0] + 34) % 360} ${Math.min(Math.max(hsl[1], 55), 90)}% 70%)`,
          c3: `hsl(${(hsl[0] + 330) % 360} ${Math.min(Math.max(hsl[1], 55), 90)}% 66%)`,
        } : undefined}
      />;

  return (
    <span
      aria-hidden
      className={cn("relative inline-block shrink-0 overflow-hidden rounded-full", className)}
      style={{ width: size, height: size, boxShadow: glowShadow }}
    >
      {inner}
    </span>
  );
}
