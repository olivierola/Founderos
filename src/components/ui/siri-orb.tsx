import { cn } from "@/lib/utils";
import type { CSSProperties } from "react";

// Pure-CSS animated "Siri" orb (no 3D / WASM). The static rules live in
// globals.css (.siri-orb + @property --siri-angle); per-instance colours and
// sizing are passed as CSS custom properties here.
export interface SiriOrbProps {
  /** Diameter in px. */
  size?: number;
  className?: string;
  colors?: { bg?: string; c1?: string; c2?: string; c3?: string };
  /** Rotation period in seconds. */
  animationDuration?: number;
}

export function SiriOrb({ size = 192, className, colors, animationDuration = 20 }: SiriOrbProps) {
  const c = {
    bg: "transparent",
    c1: "oklch(75% 0.15 350)",
    c2: "oklch(80% 0.12 200)",
    c3: "oklch(78% 0.14 280)",
    ...colors,
  };
  const blur = Math.max(size * 0.08, 8);
  const contrast = Math.max(size * 0.003, 1.8);

  return (
    <div
      className={cn("siri-orb", className)}
      style={{
        width: size,
        height: size,
        "--siri-bg": c.bg,
        "--c1": c.c1,
        "--c2": c.c2,
        "--c3": c.c3,
        "--siri-duration": `${animationDuration}s`,
        "--siri-blur": `${blur}px`,
        "--siri-contrast": contrast,
      } as CSSProperties}
    />
  );
}

export default SiriOrb;
