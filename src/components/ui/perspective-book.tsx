import React from "react";
import { cn } from "@/lib/utils";

const sizeMap = {
  sm: { width: "150px", w: 150, depth: 24 },
  default: { width: "196px", w: 196, depth: 32 },
  lg: { width: "300px", w: 300, depth: 48 },
};

// Compact procedural noise (replaces the original ~50KB inline base64 texture).
const NOISE_DATA_URI =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

// Cream paper, with thin striations standing in for stacked page edges.
const PAGES_BG =
  "repeating-linear-gradient(to right, #efe9d9 0, #efe9d9 1.5px, #d8d0bb 1.5px, #d8d0bb 3px)";

interface PerspectiveBookProps {
  size?: "sm" | "default" | "lg";
  className?: string;
  children: React.ReactNode;
  textured?: boolean;
  /** Inline style applied to the front cover (merged with transform/radius). */
  coverStyle?: React.CSSProperties;
  /** Cloth colour for the spine + back cover. Defaults to a near-black. */
  spineColor?: string;
  /** Overlay rendered on the front plane but outside the cover clip — e.g. a
   *  bookmark ribbon that can stick out above the top edge. */
  banner?: React.ReactNode;
  onClick?: () => void;
}

export function PerspectiveBook({
  size = "default",
  className = "",
  children,
  textured = false,
  coverStyle,
  spineColor = "#222220",
  banner,
  onClick,
}: PerspectiveBookProps) {
  const { width, w, depth } = sizeMap[size];
  const radius = "6px 4px 4px 6px";

  // Side faces are centred (left:50% / margin-left:-depth/2, full height) and
  // pushed out to each edge — the standard cuboid recipe.
  const sideBase: React.CSSProperties = {
    position: "absolute",
    top: "1.5%",
    height: "97%",
    left: "50%",
    width: `${depth}px`,
    marginLeft: `${-depth / 2}px`,
  };

  return (
    <div className="z-10 group [perspective:1300px] w-min h-min" onClick={onClick}>
      <div
        style={{ width, borderRadius: radius }}
        className="relative aspect-[49/60] [transform-style:preserve-3d] [transform:rotateY(0deg)] transition-transform duration-300 ease-out group-hover:[transform:rotateY(-18deg)_scale(1.05)]"
      >
        {/* Back cover */}
        <div
          className="absolute inset-0"
          style={{ transform: `translateZ(${-depth / 2}px)`, background: spineColor, borderRadius: radius }}
        />

        {/* Spine (left edge) */}
        <div
          style={{
            ...sideBase,
            transform: `rotateY(-90deg) translateZ(${w / 2}px)`,
            background: `linear-gradient(to right, rgba(255,255,255,.14), rgba(0,0,0,.35)), ${spineColor}`,
          }}
        />

        {/* Fore-edge pages (right edge) — the visible thickness */}
        <div
          style={{
            ...sideBase,
            transform: `rotateY(90deg) translateZ(${w / 2}px)`,
            backgroundColor: "#efe9d9",
            backgroundImage: PAGES_BG,
            boxShadow: "inset 0 0 6px rgba(0,0,0,.25)",
          }}
        />

        {/* Front cover */}
        <div
          className={cn(
            "absolute inset-0 overflow-hidden flex flex-col p-[12%] after:content-[''] after:absolute after:inset-0 after:pointer-events-none after:rounded-[inherit] after:border after:border-solid after:border-[#00000022] after:shadow-[0_1.8px_3.6px_#0000000d,_0_10.8px_21.6px_#00000022,_inset_0_-.9px_#00000026,_inset_0_1.8px_1.8px_#ffffff1a]",
            className,
          )}
          style={{ transform: `translateZ(${depth / 2}px)`, borderRadius: radius, ...coverStyle }}
        >
          {/* Rainure — the hardcover hinge groove, near the spine (far left) */}
          <div
            className="absolute top-[7%] bottom-[7%] left-[8%] w-px pointer-events-none"
            style={{ background: "rgba(0,0,0,.45)", boxShadow: "1px 0 0 rgba(255,255,255,.1)" }}
          />
          <div className="relative z-[1] pl-[8%] h-full">{children}</div>
          {textured && (
            <div
              className="absolute inset-0 mix-blend-soft-light opacity-[0.18] bg-repeat pointer-events-none"
              style={{ borderRadius: radius, backgroundImage: NOISE_DATA_URI }}
            />
          )}
        </div>

        {/* Banner overlay — sits on the front plane but outside the cover's clip
            so it can stick out above the top edge (e.g. a bookmark ribbon). */}
        {banner && (
          <div
            className="absolute inset-0 z-[3] pointer-events-none"
            style={{ transform: `translateZ(${depth / 2 + 0.5}px)` }}
          >
            {banner}
          </div>
        )}
      </div>
    </div>
  );
}
