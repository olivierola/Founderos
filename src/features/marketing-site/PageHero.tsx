import { useEffect, type ReactNode } from "react";
import { PaperHero, type TileKey } from "./PaperHero";

/* ── Shared chrome for every interior marketing page ────────────────────────
   Solutions, Blog, FAQ, Pricing and every article are the same object seen from
   several angles, so they share one opening, one closing slab and one skin
   instead of each inventing a header. */

/** Mounts the landing skin on <html> so overscroll never flashes the app's own
    background, and returns the page wrapper class the landing uses. */
export function useLandingSkin() {
  useEffect(() => {
    document.documentElement.classList.add("mkt-no-scrollbar", "amp-root", "hn-root");
    return () => document.documentElement.classList.remove("mkt-no-scrollbar", "amp-root", "hn-root");
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
  /* The brand red-orange, and the default: it is the one hue on the site that
     means something, so the closing slab carries it unless a page has a reason
     of its own. */
  orange: { shader: ["#FFFFFF", "#2893CC", "#9CD3EE", "#FFFFFF"], glow: "rgba(40,147,204,0.26)" },
  teal: { shader: ["#FFFFFF", "#2A9C82", "#5FD3B6", "#FFFFFF"], glow: "rgba(42,156,130,0.28)" },
  indigo: { shader: ["#FFFFFF", "#7C83D8", "#A9AEEC", "#FFFFFF"], glow: "rgba(124,131,216,0.26)" },
  amber: { shader: ["#FFFFFF", "#8E8577", "#C4BCAF", "#FFFFFF"], glow: "rgba(142,133,119,0.24)" },
} satisfies Record<string, HueSpec>;

export type HeroHue = keyof typeof HERO_HUES;

function resolveHue(hue: HeroHue | HueSpec): HueSpec {
  return typeof hue === "string" ? HERO_HUES[hue] : hue;
}

/* ── Interior hero ──────────────────────────────────────────────────────────
   The interior pages open exactly the way the landing page does — see
   PaperHero, which owns the whole construction. This is only the section that
   holds it, kept here because Solutions, Blog and FAQ import their opening from
   this file and nothing is gained by making all three learn a new address.

   The animated shader field that used to sit behind this is gone. A coloured
   field per page was the old generation's way of telling four pages apart; the
   paper hero does it with the words, and the two devices cancel each other — a
   hue behind a two-grey headline just makes the grey look like a mistake.
   `hue` survives only for the closing slab below.

   No typed line here either, and no way to ask for one: the writing effect is
   the home page's alone. It is what makes that hero the loudest thing on the
   site, and a device used on every page is not an accent, it is a template. */
export function PageHero({
  label,
  frame,
  claim,
  lead,
  children,
  tiles,
}: {
  /** The small grey line above the headline. */
  label?: string;
  /** The grey lines that frame the claim. */
  frame: string[];
  /** The one near-black line. */
  claim: string;
  lead?: ReactNode;
  children?: ReactNode;
  tiles?: TileKey[];
}) {
  return (
    <PaperHero label={label} frame={frame} claim={claim} lead={lead} tiles={tiles}>
      {children}
    </PaperHero>
  );
}

/* ── Closing CTA ────────────────────────────────────────────────────────────
   Every page now ends on the footer's own call to action (hn/HnFooter: the
   white card on the sky band), so this renders nothing. Kept, with its old
   signature, so the pages that mount it do not have to change. `ctaWash` is
   kept for the same reason. */
export function ctaWash(hue: HeroHue | HueSpec) {
  return `radial-gradient(ellipse 50% 120% at 8% 50%, ${resolveHue(hue).glow}, transparent 62%)`;
}

export function ClosingCta(_: {
  eyebrow?: string;
  title: string;
  lead: string;
  actions: ReactNode;
  hue?: HeroHue | HueSpec;
}) {
  return null;
}
