import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { GlobePulse } from "@/components/ui/cobe-globe-pulse";
import { Display, Em, Pill, Reveal } from "./LandingKit";
import { ToneSection } from "./LandingTone";

/* The scale block: a globe you can spin, and one figure that keeps moving
   while you read it. The globe is cropped by the panel on purpose — that
   overlap is what stops it reading as an illustration parked above a card. */

/* Where the work actually happens. Kept short: a marker per city is a claim,
   and five honest ones beat a constellation. */
const MARKERS = [
  { id: "paris", location: [48.86, 2.35] as [number, number], delay: 0 },
  { id: "london", location: [51.51, -0.13] as [number, number], delay: 0.4 },
  { id: "frankfurt", location: [50.11, 8.68] as [number, number], delay: 0.8 },
  { id: "lisbon", location: [38.72, -9.14] as [number, number], delay: 1.2 },
  { id: "montreal", location: [45.5, -73.57] as [number, number], delay: 1.6 },
];

/* ── The live figure ────────────────────────────────────────────────────────
   Seeded from the clock rather than from a constant, so the number a visitor
   sees is not the number the last visitor saw, and it keeps moving while they
   read. It is a demonstration figure, and the label says what it counts.      */
const EPOCH = Date.UTC(2026, 0, 1);
const PER_SECOND = 0.021;

function useLiveCount() {
  const [n, setN] = useState(() => Math.round(128_400 + ((Date.now() - EPOCH) / 1000) * PER_SECOND));

  useEffect(() => {
    const t = setInterval(() => setN((v) => v + 1 + Math.floor(Math.random() * 3)), 2600);
    return () => clearInterval(t);
  }, []);

  return n.toLocaleString("en-US");
}

export function LandingGlobe() {
  const count = useLiveCount();
  // The globe rebuilds itself whenever these identities change, so they are
  // held still rather than re-created on every render.
  const markers = useMemo(() => MARKERS, []);

  return (
    <ToneSection tone="ink" className="overflow-hidden">
      <div className="mx-auto max-w-[1420px] px-5 pb-24 pt-20 sm:px-9 sm:pb-28 sm:pt-24">
        <div className="relative">
          <div className="pointer-events-auto absolute inset-x-0 -top-24 mx-auto w-full max-w-[780px] sm:-top-32">
            <GlobePulse markers={markers} speed={0.0024} />
          </div>

          {/* Reserves the part of the globe that stays above the panel. */}
          <div className="h-[300px] sm:h-[420px]" />

          <Reveal>
            <div className="relative overflow-hidden rounded-[20px] border border-white/[0.09] bg-[#101010]/85 p-8 backdrop-blur-2xl sm:p-12">
              <div className="relative grid items-center gap-10 lg:grid-cols-2">
                <div>
                  <Display className="text-[28px] sm:text-[36px] lg:text-[40px]">
                    Real results.
                    <br />
                    For real <Em>businesses</Em>
                  </Display>
                  <Link to="/solutions" className="mt-8 inline-block">
                    <Pill variant="light" className="px-6 py-3">
                      Learn more
                    </Pill>
                  </Link>
                </div>

                <div className="lg:pl-10">
                  <span className="inline-flex items-center gap-2.5 text-[11px] font-medium uppercase tracking-[0.14em] text-white/50">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70 opacity-70 motion-reduce:animate-none" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-white/70" />
                    </span>
                    Live · right now across Anduran
                  </span>
                  {/* Tabular figures, or the number jitters horizontally on
                      every tick as glyph widths change. */}
                  <div className="mt-4 text-[32px] font-medium leading-none tracking-[-0.04em] text-white tabular-nums sm:text-[44px]">
                    {count}
                  </div>
                  <div className="mt-3.5 text-[14px] text-white/55">
                    Agent actions executed under an approval policy
                  </div>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </ToneSection>
  );
}
