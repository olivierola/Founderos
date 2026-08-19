import { useEffect, type ReactNode } from "react";
import { GrainGradient } from "@paper-design/shaders-react";
import { Eyebrow } from "./LandingKit";
import { HERO_BG } from "./LandingHero";

/* ── Shared chrome for every interior marketing page ────────────────────────
   Solutions, Blog, FAQ, Pricing and every article are the same object seen from
   several angles, so they share one shell, one animated field and one closing
   slab instead of each inventing a header. */

/** Mounts the landing skin on <html> so overscroll never flashes the app's own
    background, and returns the page wrapper class the landing uses. */
export function useLandingSkin() {
  useEffect(() => {
    document.documentElement.classList.add("mkt-no-scrollbar", "amp-root");
    return () => document.documentElement.classList.remove("mkt-no-scrollbar", "amp-root");
  }, []);
}

/* ── Colour maths ───────────────────────────────────────────────────────────
   One rule governs every hue that reaches the hero: the nav writes in BLACK,
   the shader pools its colour in the top corners, and those corners sit
   directly behind the links. Re-lighting this field for a white ground was the
   whole point, so a dark stop would undo it.

   Concretely, every leading stop has to land near the brand orange's relative
   luminance (0.266). Named hues below are hand-picked to it. Post keys cannot
   be: they are chosen for cover art on a DARK card, where #12574a (0.07) is
   correct and would put black links on a near-black corner up here. So keys are
   lifted programmatically instead, and a new post inherits the rule rather than
   depending on whoever adds it to remember the arithmetic. */

const NAV_SAFE = 0.24; // floor for the leading stop
/* The second stop is a floor AND a relative step, because a key that already
   clears the floor on its own (the amber sits at 0.50) would otherwise resolve
   to the same colour twice and flatten the field to a single tone. */
const COMPANION = 0.46;
const COMPANION_STEP = 0.16;

function toLinear(c: number) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: RGB) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHex([r, g, b]: RGB) {
  return "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

/* Mixing toward white rather than raising HSL lightness: it keeps the hue
   recognisable, and luminance is monotonic in the mix factor, so a fixed
   bisection lands on the target without a convergence check. */
function towardWhite([r, g, b]: RGB, t: number): RGB {
  return [r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t];
}

/** Lift a colour until it clears `target`. Already-light colours pass through. */
function lift(hex: string, target: number) {
  const rgb = hexToRgb(hex);
  if (luminance(rgb) >= target) return hex;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (luminance(towardWhite(rgb, mid)) < target) lo = mid;
    else hi = mid;
  }
  return rgbToHex(towardWhite(rgb, hi));
}

export type HueSpec = { shader: string[]; glow: string };

/** Build a nav-safe hero hue from any single key, used by the article pages. */
export function tintFromKey(hex: string): HueSpec {
  const base = lift(hex, NAV_SAFE);
  const soft = lift(base, Math.max(COMPANION, luminance(hexToRgb(base)) + COMPANION_STEP));
  const [r, g, b] = hexToRgb(base).map(Math.round);
  return { shader: ["#FFFFFF", base, soft, "#FFFFFF"], glow: `rgba(${r},${g},${b},0.26)` };
}

/* ── Named hues ─────────────────────────────────────────────────────────────
   The four figures on the home page each carry a rail colour (see
   LandingProof), and those same four key the interior pages, so the site runs
   on one set of four rather than on orange plus improvisation.

   Both white stops stay in every entry: they are what hold the field light
   enough for the nav. Only the two middle stops move, and the leading one is
   matched to the orange's luminance rather than to its saturation, which is why
   the teal is a lifted #2A9C82 and not the rail's own #12574a. */
export const HERO_HUES = {
  /* Brand orange. Pricing keeps it, and not only out of deference: the plan
     cards ride 230px up into the hero and are themselves #ff4d00, so any other
     hue would meet them halfway up the card. */
  orange: { shader: ["#FFFFFF", "#FF4D00", "#FC7819", "#FFFFFF"], glow: "rgba(255,77,0,0.26)" },
  teal: { shader: ["#FFFFFF", "#2A9C82", "#5FD3B6", "#FFFFFF"], glow: "rgba(42,156,130,0.28)" },
  indigo: { shader: ["#FFFFFF", "#7C83D8", "#A9AEEC", "#FFFFFF"], glow: "rgba(124,131,216,0.26)" },
  amber: { shader: ["#FFFFFF", "#E8B423", "#F6D678", "#FFFFFF"], glow: "rgba(232,180,35,0.24)" },
} satisfies Record<string, HueSpec>;

export type HeroHue = keyof typeof HERO_HUES;

function resolveHue(hue: HeroHue | HueSpec): HueSpec {
  return typeof hue === "string" ? HERO_HUES[hue] : hue;
}

/** A stable per-seed shader frame, so two articles never compose alike. */
export function frameFromSeed(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return 400 + (h % 4000);
}

/* ── The animated field ─────────────────────────────────────────────────────
   The login page's shader, re-lit for a light canvas. Split out from PageHero
   so the article pages can carry the same field behind their own left-aligned
   header instead of being forced into the centred layout below.

   `frame` is the seed: each page and each article passes its own, so the field
   composes differently everywhere on top of carrying a different hue. */
export function HeroField({
  hue = "orange",
  frame = 2854.5,
}: {
  hue?: HeroHue | HueSpec;
  frame?: number;
}) {
  return (
    <>
      <GrainGradient
        speed={1}
        scale={1}
        rotation={0}
        offsetX={0}
        offsetY={0}
        softness={0.5}
        intensity={0.5}
        noise={0.25}
        shape="corners"
        frame={frame}
        colors={resolveHue(hue).shader}
        /* HERO_BG rather than pure white: it is the ink the nav uses for its
           notch shoulders, so the two meet without a seam. */
        colorBack={HERO_BG}
        className="absolute inset-0"
      />
      {/* Fade into the white the page continues on. Without it the shader's own
          edge cuts off flat, right where the content starts. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-64 bg-gradient-to-b from-transparent to-white" />
    </>
  );
}

/* ── Interior hero ──────────────────────────────────────────────────────────
   The centred variant: eyebrow, title, lead, and whatever the page wants under
   them. Used by Solutions, Blog, FAQ and Pricing. */
export function PageHero({
  eyebrow,
  title,
  lead,
  children,
  hue = "orange",
  frame = 2854.5,
  /* Pages whose first block rides up onto the hero (the pricing cards) pass a
     deliberately excessive value: that padding IS the space they climb into. */
  padBottom = 130,
}: {
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  hue?: HeroHue | HueSpec;
  frame?: number;
  padBottom?: number;
}) {
  return (
    <section className="relative overflow-hidden pt-[104px]" style={{ paddingBottom: padBottom }}>
      <HeroField hue={hue} frame={frame} />

      <div className="relative mx-auto max-w-3xl px-4 pt-10 text-center sm:px-6">
        {eyebrow && (
          <div className="amp-in mb-7 flex justify-center" style={{ animationDelay: "60ms" }}>
            <Eyebrow>{eyebrow}</Eyebrow>
          </div>
        )}
        <h1 className="text-balance text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-[#000007] sm:text-[56px] lg:text-[64px]">
          {title}
        </h1>
        {lead && (
          <p className="mx-auto mt-6 max-w-xl text-[17px] leading-[1.6] text-black/65">{lead}</p>
        )}
        {children}
      </div>
    </section>
  );
}

/* ── Closing CTA ────────────────────────────────────────────────────────────
   The home page's floating dark slab, extracted so every page ends the same
   way. Left orb takes the page's hue, right orb is always graphite. The wash is
   reused verbatim as the mask for the vertical bands, so the bands fade out
   exactly where the colour does, never over bare black. */
export function ctaWash(hue: HeroHue | HueSpec) {
  return `radial-gradient(ellipse 50% 120% at 8% 50%, ${resolveHue(hue).glow}, transparent 62%),
                  radial-gradient(ellipse 55% 120% at 92% 50%, rgba(161,161,170,0.30), transparent 62%)`;
}

export function ClosingCta({
  eyebrow = "Get Started",
  title,
  lead,
  actions,
  hue = "orange",
}: {
  eyebrow?: string;
  title: string;
  lead: string;
  actions: ReactNode;
  hue?: HeroHue | HueSpec;
}) {
  const CTA_WASH = ctaWash(hue);

  return (
    /* Shares the footer's grey canvas and gutter, so the page ends on one light
       field carrying two floating slabs. */
    <div className="relative px-3 py-3 sm:px-5 sm:py-5" style={{ background: "#e4e4e4" }}>
      <section className="relative overflow-hidden rounded-[28px] bg-[#08080a] sm:rounded-[36px]">
        <div
          aria-hidden
          className="amp-grain amp-wash-drift pointer-events-none absolute inset-0"
          style={{ background: CTA_WASH }}
        />
        <div
          aria-hidden
          className="amp-bands pointer-events-none absolute inset-0"
          style={{ WebkitMaskImage: CTA_WASH, maskImage: CTA_WASH }}
        />
        <div className="relative mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative flex flex-col items-center py-28 text-center">
            <Eyebrow>{eyebrow}</Eyebrow>
            <h2 className="mt-7 max-w-3xl text-balance text-[34px] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-[48px]">
              {title}
            </h2>
            <p className="mt-6 max-w-2xl text-[16.5px] leading-[1.6] text-[var(--amp-muted)]">{lead}</p>
            <div className="mt-10 flex flex-col items-center gap-3.5 sm:flex-row">{actions}</div>
          </div>
        </div>
      </section>
    </div>
  );
}
