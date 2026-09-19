"use client";

import { GrainGradient } from "@paper-design/shaders-react";
import { cn } from "@/lib/utils";

/* Animated grain-gradient field (paper-design shader): warm blooms pushed out of
   the corners, over the ground colour given to it. Fills its nearest positioned
   ancestor.

   `colorBack` defaults to black — that is what the marketing splash is drawn
   against and it must not move. Surfaces that live INSIDE the app pass the
   active theme's own `--background` instead, so the field sits on the same
   ground as everything around it instead of punching a black hole through a
   light skin. */
export function GradientBackground({ className, colorBack = "hsl(0, 0%, 0%)" }: {
  className?: string;
  colorBack?: string;
}) {
  return (
    <div className={cn("absolute inset-0 -z-10", className)}>
      <GrainGradient
        style={{ height: "100%", width: "100%" }}
        // Keeps the drawing buffer readable so callers can snapshot the canvas
        // after the frame is presented (the splash shatters that snapshot).
        webGlContextAttributes={{ preserveDrawingBuffer: true }}
        colorBack={colorBack}
        softness={0.76}
        intensity={0.45}
        noise={0}
        shape="corners"
        offsetX={0}
        offsetY={0}
        scale={1}
        rotation={0}
        speed={1}
        colors={["hsl(0, 0%, 88%)", "hsl(0, 0%, 56%)", "hsl(0, 0%, 26%)"]}
      />
    </div>
  );
}
