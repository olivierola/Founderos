import type { ReactNode } from "react";
import { CheckCircleIcon as CheckCircle } from "@phosphor-icons/react";
import { Reveal } from "./LandingKit";

/* ══ The interior pages' vocabulary ══════════════════════════════════════════
   These names are what the interior pages were written against — a plate, a
   section title, a label, a feature line. They now draw the Hunar register
   (see hn/): 8px cards on the off-white ground, a single medium-weight title,
   blue check marks, and the blue as the one colour.

   Everything states its own ink: these land in pages whose roots set white,
   transparent or nothing at all. */

export const PAPER_INK = "#0f1728";
export const PAPER_FRAME = "#4b5567";
export const PAPER_RULE = "rgba(18,18,18,0.08)";

/* ── The accent ─────────────────────────────────────────────────────────────
     PAPER_ACCENT  the blue #006EDD — 4.9:1 on white, so it holds as body text.
     PAPER_BLUE    the lighter #5aa8ff, for marks on the dark bands. */
export const PAPER_ACCENT = "#006edd";
export const PAPER_BLUE = "#5aa8ff";
export const PAPER_ON_ACCENT = "#FFFFFF";

/** Register marks belonged to an earlier register; rendered as nothing so
    the pages that still mount them do not have to change. */
export function CornerMarks(_: { accent?: boolean }) {
  return null;
}

/** The small line that opens a list or a block. */
export function MonoLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`text-[14px] leading-none text-[#4b5567] ${className}`}>{children}</div>;
}

/* ── Section heading ────────────────────────────────────────────────────────
   One medium-weight title, set tight. `frame` and `claim` keep their old
   meaning (setup, then claim); `flip` puts the claim first. */
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
      className={`text-balance text-[30px] font-medium leading-[1.15] tracking-[-0.04em] text-[#0f1728] sm:text-[36px] lg:text-[40px] ${className}`}
    >
      {first}
      <br />
      {second}
    </h2>
  );
}

/* ── Plate ──────────────────────────────────────────────────────────────────
   The off-white card: an add-on, an offer, a "calculate your costs" card.
   `accent` rings it in the blue — the one box on a page being pointed at. */
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
        className={`relative h-full overflow-hidden rounded-[24px] border bg-[#f7f8fb] transition-colors duration-300 hover:bg-[#f5f5f4] ${
          accent ? "border-[#006edd]/40" : "border-[#e6e9ef]"
        } ${className}`}
      >
        {children}
      </div>
    </Reveal>
  );
}

/** A blue check and a term. */
export function FeatureLine({ children }: { children: ReactNode; accent?: boolean }) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckCircle weight="fill" className="mt-[2px] h-[18px] w-[18px] shrink-0 text-[#006edd]" />
      <span className="text-[16px] leading-[1.4] tracking-[-0.01em] text-[#0f1728]">{children}</span>
    </li>
  );
}
