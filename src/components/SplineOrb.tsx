import { Suspense, lazy, useRef } from "react";
import { cn } from "@/lib/utils";
import { orbHueRotate } from "@/lib/orbTint";

// 3D Spline orb — the agent's premium animated presence.
const Spline = lazy(() => import("@splinetool/react-spline"));

const SCENE_URL = "https://prod.spline.design/Ex6qJPimlFSI-IjK/scene.splinecode";

export function SplineOrb({
  size = 88,
  className,
  /** Tint the orb to match this hex colour (e.g. an agent's accent_color). */
  accentColor,
  /** Explicit CSS hue-rotate (degrees) when no accentColor is given. */
  hue = 210,
  /** Saturation multiplier on the recoloured orb. */
  saturate = 1.1,
}: {
  size?: number;
  className?: string;
  accentColor?: string | null;
  hue?: number;
  saturate?: number;
}) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const rotate = orbHueRotate(accentColor, hue);

  return (
    <span
      ref={hostRef}
      className={cn("relative inline-block shrink-0", className)}
      style={{
        width: size,
        height: size,
        pointerEvents: "none",
        background: "transparent",
        filter: rotate ? `hue-rotate(${rotate}deg) saturate(${saturate})` : undefined,
      }}
    >
      <Suspense fallback={null}>
        <div style={{ width: "100%", height: "100%", position: "absolute", inset: 0, isolation: "isolate" }}>
          <Spline
            scene={SCENE_URL}
            style={{ 
              width: "100%", 
              height: "100%", 
              transform: "scale(1.55)", 
              transformOrigin: "60% 62%", 
              background: "transparent",
              display: "block"
            }}
            onLoad={() => {
              if (hostRef.current) {
                // Hide all Spline branding and UI elements
                hostRef.current.querySelectorAll("*").forEach((el) => {
                  const html = (el as HTMLElement).outerHTML || "";
                  // Hide text nodes with "Spline" branding
                  if (html.includes("Spline") || html.includes("logo") || 
                      (el.tagName === "A") || 
                      ((el as HTMLElement).style?.display !== "none" && 
                       ((el as any).textContent?.includes("Built with") || (el as any).textContent?.includes("Spline")))) {
                    (el as HTMLElement).style.display = "none";
                    (el as HTMLElement).style.visibility = "hidden";
                    (el as HTMLElement).style.pointerEvents = "none";
                  }
                });
                // Extra fallback: hide canvas overlay containers
                const overlays = hostRef.current.querySelectorAll("div[style*='position'], button, a");
                overlays.forEach((el) => {
                  if ((el as HTMLElement).textContent?.toLowerCase().includes("spline") || 
                      (el as HTMLElement).textContent?.toLowerCase().includes("built")) {
                    (el as HTMLElement).style.display = "none";
                    (el as HTMLElement).style.visibility = "hidden";
                  }
                });
              }
            }}
          />
        </div>
      </Suspense>
    </span>
  );
}

export default SplineOrb;
