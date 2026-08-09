import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Logo } from "@/components/Logo";
import { GradientBackground } from "@/components/ui/paper-design-shader-background";
import { BRAND_FONT } from "./LandingKit";

/* Brand curtain held over the landing page until the visitor asks to go in.
   On "Accéder" it breaks into a grid of tiles that blink out in random order,
   uncovering the page that has been sitting underneath the whole time. */
const TILE_PX = 90; // target edge length — the grid rounds to fit the viewport
const SWAP_MS = 300; // shader dims into the flat black the tiles are cut from
const TILE_FADE_MS = 420;
const STAGGER_MS = 900; // window across which the tiles are dealt out

function gridFor() {
  const w = typeof window === "undefined" ? 1280 : window.innerWidth;
  const h = typeof window === "undefined" ? 800 : window.innerHeight;
  return {
    cols: Math.max(4, Math.ceil(w / TILE_PX)),
    rows: Math.max(3, Math.ceil(h / TILE_PX)),
  };
}

export function BrandSplash() {
  const [phase, setPhase] = useState<"in" | "out" | "gone">("in");
  const [entered, setEntered] = useState(false);
  const [grid, setGrid] = useState(gridFor);

  // A tick after mount so the mark animates in rather than appearing painted.
  useEffect(() => {
    const t = window.setTimeout(() => setEntered(true), 30);
    return () => window.clearTimeout(t);
  }, []);

  // Only re-tile while the curtain is at rest — resizing mid-dissolve would
  // rebuild the grid and restart every tile.
  useEffect(() => {
    if (phase !== "in") return;
    const onResize = () => setGrid(gridFor());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [phase]);

  // The page behind the curtain must not scroll while it is up.
  useEffect(() => {
    if (phase === "gone") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== "out") return;
    const t = window.setTimeout(
      () => setPhase("gone"),
      SWAP_MS + STAGGER_MS + TILE_FADE_MS + 120,
    );
    return () => window.clearTimeout(t);
  }, [phase]);

  const count = grid.cols * grid.rows;

  /* Each tile gets its own departure time: shuffle the indices, then spread the
     stagger across that shuffled order so no two neighbours leave together. */
  const delays = useMemo(() => {
    const order = Array.from({ length: count }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const out = new Array<number>(count);
    order.forEach((tile, rank) => {
      out[tile] = Math.round((rank / Math.max(1, count - 1)) * STAGGER_MS);
    });
    return out;
  }, [count]);

  if (phase === "gone") return null;

  const leaving = phase === "out";

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center overflow-hidden"
      style={{ pointerEvents: leaving ? "none" : "auto" }}
    >
      {/* Live shader — on screen while the curtain rests, handed over to the
          tiled still at the top of the dissolve. */}
      <div
        aria-hidden
        className="absolute inset-0 transition-opacity ease-out"
        style={{ opacity: leaving ? 0 : 1, transitionDuration: `${SWAP_MS}ms` }}
      >
        <GradientBackground className="z-0" />
        <div className="absolute inset-0 bg-black/20" />
      </div>

      {/* The tiles: flat black, invisible at rest, faded in as the shader dims,
          then dealt out one by one to let the landing through. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 grid transition-opacity ease-out"
        style={{
          gridTemplateColumns: `repeat(${grid.cols}, 1fr)`,
          gridTemplateRows: `repeat(${grid.rows}, 1fr)`,
          opacity: leaving ? 1 : 0,
          transitionDuration: `${SWAP_MS}ms`,
        }}
      >
        {delays.map((delay, i) => (
          <div
            key={i}
            style={{
              backgroundColor: "#000",
              opacity: leaving ? 0 : 1,
              transform: leaving ? "scale(0.72)" : "none",
              transition: `opacity ${TILE_FADE_MS}ms ease-out, transform ${TILE_FADE_MS}ms ease-out`,
              transitionDelay: `${SWAP_MS + delay}ms`,
            }}
          />
        ))}
      </div>

      <div
        className="relative flex flex-col items-center transition-all duration-700 ease-out"
        style={{
          opacity: entered && !leaving ? 1 : 0,
          transform: entered ? "none" : "translateY(10px) scale(0.96)",
          transitionDuration: leaving ? "200ms" : "700ms",
        }}
      >
        <div className="flex items-center gap-4">
          <Logo size={40} />
          <span
            className="text-[23px] leading-none text-white/90 sm:text-[27px]"
            style={{ fontFamily: BRAND_FONT }}
          >
            Anduran <span style={{ color: "#FF4D00" }}>AI</span>
          </span>
        </div>

        <button
          type="button"
          onClick={() => setPhase((p) => (p === "in" ? "out" : p))}
          className="mt-10 inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-[14px] font-medium text-[#0C0C0E] transition-transform duration-200 hover:scale-[1.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/60"
        >
          Accéder
          <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
