"use client";

import { GrainGradient } from "@paper-design/shaders-react";
import { cn } from "@/lib/utils";

/* Animated grain-gradient field (paper-design shader): warm blooms pushed out of
   the corners over black. Fills its nearest positioned ancestor. */
export function GradientBackground({ className }: { className?: string }) {
  return (
    <div className={cn("absolute inset-0 -z-10", className)}>
      <GrainGradient
        style={{ height: "100%", width: "100%" }}
        // Keeps the drawing buffer readable so callers can snapshot the canvas
        // after the frame is presented (the splash shatters that snapshot).
        webGlContextAttributes={{ preserveDrawingBuffer: true }}
        colorBack="hsl(0, 0%, 0%)"
        softness={0.76}
        intensity={0.45}
        noise={0}
        shape="corners"
        offsetX={0}
        offsetY={0}
        scale={1}
        rotation={0}
        speed={1}
        colors={["hsl(14, 100%, 57%)", "hsl(45, 100%, 51%)", "hsl(340, 82%, 52%)"]}
      />
    </div>
  );
}
