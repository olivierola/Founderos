import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Logo } from "@/components/Logo";
import { GradientBackground } from "@/components/ui/paper-design-shader-background";
import { BRAND_FONT } from "./LandingKit";

/* Brand curtain held over the landing page until the visitor asks to go in.
   On "Accéder" the shader is frozen into a still, cut into tiles, and the tiles
   blink out in random order — so it is the animated screen itself that comes
   apart, uncovering the landing that has been sitting underneath all along. */
const TILE_PX = 120; // target edge length — the grid rounds to fit the viewport
const MAX_TILES = 260; // every tile becomes its own composited layer, so cap them
const LEAD_MS = 180; // lets the wordmark clear before the first tile goes
const TILE_FADE_MS = 420;
const STAGGER_MS = 900; // window across which the tiles are dealt out
const SCRIM = "rgba(0,0,0,0.2)"; // the dark wash carried over the resting shader

function gridFor() {
  const w = typeof window === "undefined" ? 1280 : window.innerWidth;
  const h = typeof window === "undefined" ? 800 : window.innerHeight;
  let size = TILE_PX;
  while (Math.ceil(w / size) * Math.ceil(h / size) > MAX_TILES) size += 10;
  return {
    w,
    h,
    cols: Math.max(4, Math.ceil(w / size)),
    rows: Math.max(3, Math.ceil(h / size)),
  };
}

export function BrandSplash() {
  const [phase, setPhase] = useState<"in" | "armed" | "out" | "gone">("in");
  const [entered, setEntered] = useState(false);
  const [grid, setGrid] = useState(gridFor);
  const [still, setStill] = useState<string | null>(null);
  const shaderRef = useRef<HTMLDivElement>(null);
  const stillUrl = useRef<string | null>(null);

  // The blob backing the still is held by the browser until it is revoked.
  useEffect(
    () => () => {
      if (stillUrl.current) URL.revokeObjectURL(stillUrl.current);
    },
    [],
  );

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

  /* "armed" paints the tiles opaque over the hidden shader — pixel-identical,
     so nothing appears to happen. Only once the browser has committed that
     frame can the tiles transition away from a known opacity of 1. */
  useEffect(() => {
    if (phase !== "armed") return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setPhase("out"));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== "out") return;
    const t = window.setTimeout(
      () => setPhase("gone"),
      LEAD_MS + STAGGER_MS + TILE_FADE_MS + 120,
    );
    return () => window.clearTimeout(t);
  }, [phase]);

  const { w, h, cols, rows } = grid;
  const count = cols * rows;

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

  /* One WebGL canvas cannot be in a hundred places at once, so the tiles inherit
     a still of it. It is flattened onto a 2D canvas at CSS size and handed out
     as a blob URL: a base64 data URL would be megabytes of string repeated into
     every tile's inline style, which is enough to stall the tab. A failed read
     (context lost, buffer cleared) falls back to flat black rather than
     flashing an empty curtain. */
  async function shatter() {
    if (phase !== "in") return;
    const source = shaderRef.current?.querySelector("canvas");
    let url: string | null = null;
    if (source) {
      try {
        const flat = document.createElement("canvas");
        flat.width = w;
        flat.height = h;
        const ctx = flat.getContext("2d");
        if (ctx) {
          ctx.drawImage(source, 0, 0, w, h);
          url = await new Promise<string | null>((resolve) => {
            flat.toBlob(
              (blob) => resolve(blob ? URL.createObjectURL(blob) : null),
              "image/jpeg",
              0.92,
            );
          });
        }
      } catch {
        url = null;
      }
    }
    stillUrl.current = url;
    setStill(url);
    setPhase("armed");
  }

  if (phase === "gone") return null;

  const leaving = phase !== "in";
  const tileW = w / cols;
  const tileH = h / rows;

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center overflow-hidden"
      style={{ pointerEvents: leaving ? "none" : "auto" }}
    >
      {/* Live shader — on screen while the curtain rests, then torn down once
          the tiles carry its still, so its render loop and WebGL context are
          not competing with the dissolve. */}
      {!leaving && (
        <div aria-hidden ref={shaderRef} className="absolute inset-0">
          <GradientBackground className="z-0" />
          <div className="absolute inset-0" style={{ background: SCRIM }} />
        </div>
      )}

      {/* The tiles: each one shows its own slice of the still, positioned by
          hand rather than by `background-attachment`, which a transformed
          element re-anchors to itself. */}
      {leaving && (
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {delays.map((delay, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            return (
              <div
                key={i}
                className="absolute"
                style={{
                  left: col * tileW,
                  top: row * tileH,
                  // The extra pixel overlaps neighbours so no seam shows through.
                  width: tileW + 1,
                  height: tileH + 1,
                  backgroundColor: "#000",
                  ...(still
                    ? {
                        backgroundImage: `linear-gradient(${SCRIM}, ${SCRIM}), url(${still})`,
                        backgroundSize: `auto, ${w}px ${h}px`,
                        backgroundPosition: `0 0, ${-col * tileW}px ${-row * tileH}px`,
                      }
                    : null),
                  opacity: phase === "out" ? 0 : 1,
                  transform: phase === "out" ? "scale(0.72)" : "none",
                  transition: `opacity ${TILE_FADE_MS}ms ease-out, transform ${TILE_FADE_MS}ms ease-out`,
                  transitionDelay: `${LEAD_MS + delay}ms`,
                }}
              />
            );
          })}
        </div>
      )}

      <div
        className="relative flex flex-col items-center transition-all ease-out"
        style={{
          opacity: entered && !leaving ? 1 : 0,
          transform: entered ? "none" : "translateY(10px) scale(0.96)",
          transitionDuration: leaving ? `${LEAD_MS}ms` : "700ms",
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
          onClick={shatter}
          className="mt-10 inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-[14px] font-medium text-[#0C0C0E] transition-transform duration-200 hover:scale-[1.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white/60"
        >
          Accéder
          <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
