import type { ReactNode } from "react";
import { Reveal } from "./LandingKit";

/* ══ The paper register's vocabulary ═════════════════════════════════════════
   Four devices, used everywhere, so that a plan column, an add-on card and a
   section heading are visibly the same system rather than three designs that
   happen to share a font.

   All of it is written for a light ground and states its own ink — these are
   dropped into pages whose roots set white, dark or nothing at all, and a
   component that inherits its colour is a component that eventually renders
   black on black. */

export const PAPER_INK = "#0E0E0E";
export const PAPER_FRAME = "#8A8A8A";
export const PAPER_RULE = "rgba(0,0,0,0.10)";

/* ── The accent, in its two cuts ────────────────────────────────────────────
   The palette is black, white and greys; #2893CC is the one colour in it, and
   it earns its place by being the only one. Which cut a component takes is
   decided by the ground it sits on, never by what the component is:

     PAPER_ACCENT   the deepened blue, #176995. Anything DRAWN in the colour on
                    a light ground: body-sized type, hairlines, corner marks,
                    bullets. 6.0:1 on white, 5.6:1 on the #F7F7F7 band.
     PAPER_BLUE     the true #2893CC. Fills, large type, and marks on the dark
                    canvas (5.8:1). On white it is 3.4:1 — fine for a 40px
                    heading, not for a 14px label.

   White ink sits on PAPER_ACCENT at 6.0:1, which is why the filled buttons use
   the deep cut rather than the bright one.
   They share a hue, so a page using both reads as one colour used two ways. */
export const PAPER_ACCENT = "#176995";
export const PAPER_BLUE = "#2893CC";
export const PAPER_ON_ACCENT = "#FFFFFF";

/* ── Register marks ─────────────────────────────────────────────────────────
   Four small squares pinned to a box's corners. They are the site's one piece
   of ornament and they earn it twice: they say where a surface begins and ends
   on a page with almost no borders, and they are the only place the accent
   appears at rest, which is what stops the palette reading as pure greyscale.

   `accent` is for the one box on a page that is being pointed at. Everything
   else takes the grey — if every card marks itself in colour, none of them is
   marked. */
export function CornerMarks({ accent = false }: { accent?: boolean }) {
  const color = accent ? PAPER_ACCENT : "#C4C4C4";
  return (
    <>
      {["left-1.5 top-1.5", "right-1.5 top-1.5", "bottom-1.5 left-1.5", "bottom-1.5 right-1.5"].map((p) => (
        <span
          key={p}
          aria-hidden
          className={`pointer-events-none absolute h-[5px] w-[5px] ${p}`}
          style={{ background: color }}
        />
      ))}
    </>
  );
}

/* ── Monospace label ────────────────────────────────────────────────────────
   The small uppercase line that opens a list or a block. Set in the mono stack
   rather than in the page's sans: at this size the two are hard to tell apart
   by weight alone, and the machine face is what marks the difference between
   "this is a label" and "this is a very short sentence". */
export function MonoLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`font-mono text-[11px] uppercase leading-none tracking-[0.11em] text-[#6E6E6E] ${className}`}
    >
      {children}
    </div>
  );
}

/* ── Two-tone section heading ───────────────────────────────────────────────
   The hero's own device, brought down to section scale: a grey line that sets
   up the claim and a near-black line that makes it. Left-aligned, because a
   section heading introduces the block underneath it and a centred one floats
   free of what it is supposed to be labelling.

   `flip` puts the black line first, for the sections that state the fact and
   then qualify it. */
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
  const firstInk = flip ? PAPER_INK : PAPER_FRAME;
  const secondInk = flip ? PAPER_FRAME : PAPER_INK;

  return (
    <h2
      className={`text-balance text-[32px] font-normal leading-[1.05] tracking-[-0.035em] sm:text-[44px] lg:text-[52px] ${className}`}
    >
      <span style={{ color: firstInk }}>{first}</span>
      <br />
      <span style={{ color: secondInk }}>{second}</span>
    </h2>
  );
}

/* ── Plate ──────────────────────────────────────────────────────────────────
   The light grey box with register marks at its corners: an add-on, an offer
   banner, a "calculate your costs" card. Square, not rounded — the corner marks
   are what finish it, and a radius competes with them for the same job. */
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
        className={`relative h-full bg-[#F2F2F0] transition-colors duration-300 hover:bg-[#EDEDEA] ${className}`}
      >
        <CornerMarks accent={accent} />
        {children}
      </div>
    </Reveal>
  );
}

/* ── Feature line ───────────────────────────────────────────────────────────
   A small square bullet and an underlined term. The underline is not decoration
   — in the reference every one of these is a link into the docs, and setting
   them as plain text would be the page promising depth it does not have. Ours
   are honest about it: underlined only where `to` is given. */
export function FeatureLine({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  return (
    <li className="flex gap-2.5">
      <span
        aria-hidden
        className="mt-[7px] h-[5px] w-[5px] shrink-0"
        style={{ background: accent ? PAPER_ACCENT : "#B4B4B4" }}
      />
      <span className="text-[14px] leading-[1.5] text-[#2A2A2A] decoration-black/20 underline-offset-[3px] hover:decoration-black/45">
        {children}
      </span>
    </li>
  );
}
