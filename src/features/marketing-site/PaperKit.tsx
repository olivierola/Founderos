import type { ReactNode } from "react";
import { Reveal } from "./LandingKit";
import { CheckBadge, Serif } from "./atlas/AtlasKit";

/* ══ The interior pages' vocabulary ══════════════════════════════════════════
   These names are what the interior pages were written against — a plate, a
   section title, a label, a feature line. They now draw the Atlas register
   (see atlas/): rounded soft-grey plates, a heavy sans title answered in the
   serif italic, check discs for bullets, and the violet as the one colour.

   Everything states its own ink: these land in pages whose roots set white,
   transparent or nothing at all. */

export const PAPER_INK = "#111011";
export const PAPER_FRAME = "#666666";
export const PAPER_RULE = "rgba(17,16,17,0.08)";

/* ── The accent, in its two cuts ────────────────────────────────────────────
     PAPER_ACCENT  the deep violet, #8b16c4 — anything DRAWN in the colour on
                   a light ground: body-sized type, hairlines, bullets (7.0:1
                   on white).
     PAPER_BLUE    the true violet, #d22eff — fills and large type only (3.8:1
                   on white). The name is historical; it is not blue any more. */
export const PAPER_ACCENT = "#8b16c4";
export const PAPER_BLUE = "#d22eff";
export const PAPER_ON_ACCENT = "#FFFFFF";

/** The paper register pinned squares to every box's corners. The Atlas
    register rounds the box instead, so the marks render nothing — kept so the
    pages that still mount them do not have to change. */
export function CornerMarks(_: { accent?: boolean }) {
  return null;
}

/** The small uppercase line that opens a list or a block. */
export function MonoLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`text-[11.5px] font-semibold uppercase leading-none tracking-[0.12em] text-[#969696] ${className}`}
    >
      {children}
    </div>
  );
}

/* ── Section heading ────────────────────────────────────────────────────────
   The heavy sans line, then the serif italic answering it. `flip` puts the
   claim first, for the sections that state the fact and then qualify it. */
export function SectionTitle({
  frame,
  claim,
  flip = false,
  className = "",
}: {
  frame: string;
  claim: string;
  flip?: boolean;
  className?: string;
}) {
  const first = flip ? claim : frame;
  const second = flip ? frame : claim;
  return (
    <h2
      className={`text-balance text-[32px] font-semibold leading-[1.02] tracking-[-0.045em] text-[#111011] sm:text-[40px] ${className}`}
    >
      {first}
      <br />
      <Serif>{second}</Serif>
    </h2>
  );
}

/* ── Plate ──────────────────────────────────────────────────────────────────
   The soft grey rounded box: an add-on, an offer, a "calculate your costs"
   card. `accent` rings it in the violet — the one box on a page that is being
   pointed at. */
export function Plate({
  children,
  accent = false,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  accent?: boolean;
  className?: string;
  delay?: number;
}) {
  return (
    <Reveal delay={delay} className="h-full">
      <div
        className={`relative h-full overflow-hidden rounded-[28px] bg-[#f7f7f7] transition-colors duration-300 hover:bg-[#f2f2f2] ${
          accent ? "ring-1 ring-inset ring-[#d22eff]/40" : ""
        } ${className}`}
      >
        {children}
      </div>
    </Reveal>
  );
}

/** A check disc and a term. */
export function FeatureLine({ children }: { children: ReactNode; accent?: boolean }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-[1px]">
        <CheckBadge size={20} />
      </span>
      <span className="text-[14.5px] font-medium leading-[1.45] tracking-[-0.01em] text-[#111011]">{children}</span>
    </li>
  );
}
