import { Fragment, type ReactNode } from "react";
import { AnimatedText, Typewriter } from "./LandingKit";

/* ══ The opening, for every page ═════════════════════════════════════════════
   An editorial hero rather than a product shot: one centred column of type on
   paper, with photographs scattered around it and running off both edges of the
   page. The images sit outside the reading column and are never cropped by a
   card — they are the room the sentence is spoken in, not exhibits.

   Two greys carry the headline. The line that frames the claim is set in the
   page's mid grey and the claim itself in near-black, so the eye lands on the
   claim first and reads outwards. That contrast is the whole layout: flatten it
   to one colour and the lines become a paragraph.

   Every marketing page opens through this — the landing page, the interior
   pages, the pricing page. They differ in what they scatter around the column
   and whether the last line rotates, not in how they are built.              */

/* Mid grey for the framing lines. #8A8A8A on white clears 3.5:1, so it still
   passes AA at this size — a lighter grey would sit closer to the reference and
   stop being readable text. */
export const PAPER_FRAME = "#8A8A8A";
export const PAPER_INK = "#0E0E0E";

/* The accent's paper cut (see PaperKit, which owns both). The typed line is the
   only place colour appears in a hero, and that is the point: on a page built
   from two greys, the one line that writes itself is also the one line that is
   brand-coloured, so the motion and the colour mark the same words.

   The deep cut and not the bright one: this is type on white, where #2893CC
   sits at 3.4:1 — readable as a headline, thin as a promise.

   Only the home page passes a `tail`, so only the home page ever shows it. */
export { PAPER_ACCENT } from "./PaperKit";

const BASE_DELAY = 120;
const STEP = 15;

/* ── The headline ───────────────────────────────────────────────────────────
   `frame` lines are grey, `claim` is the black one, and `tail` — when a page
   has something worth saying several ways — types itself and rotates under
   them. The glyph reveals run on one clock across all of it, so the lines land
   in reading order instead of animating as three separate blocks. */
export function PaperHeadline({
  frame,
  claim,
  tail,
  size = "page",
  align = "center",
}: {
  frame: string[];
  claim: string;
  tail?: string[];
  /** The landing page speaks a notch louder than the pages under it. */
  size?: "landing" | "page";
  align?: "center" | "left";
}) {
  /* `text-balance` evens the line lengths, which is what a centred display
     headline wants and exactly what a left-aligned one does not: it shortens
     every line to match the shortest, so a long claim ends up in a narrow
     column with the measure it was given left empty beside it. */
  const wrap = align === "left" ? "text-pretty" : "text-balance";
  let chars = 0;

  const line = (text: string, color: string) => {
    const delay = BASE_DELAY + chars * STEP;
    chars += text.length;
    return (
      <Fragment key={text}>
        <AnimatedText text={text} delay={delay} step={STEP} className={color} />
        <br />
      </Fragment>
    );
  };

  const body = [
    ...frame.map((f) => line(f, "text-[#8A8A8A]")),
    line(claim, "text-[#0E0E0E]"),
  ];

  // The typing picks up once the last glyph above has landed — 700ms is the
  // reveal's own duration, so the line starts exactly where the one above stops.
  const tailDelay = BASE_DELAY + chars * STEP + 700;

  return (
    <h1
      /* Sized to fill the measure rather than to a fixed scale. The column is
         wide on purpose (see below) and type that stops well short of it leaves
         two empty gutters where the photographs are trying to sit — so the
         headline grows with the container instead of holding a comfortable
         reading width it does not need. */
      className={
        `${wrap} font-normal leading-[1.03] tracking-[-0.035em] text-[#0E0E0E] ` +
        (size === "landing"
          ? "text-[40px] sm:text-[64px] lg:text-[82px] xl:text-[94px]"
          : "text-[36px] sm:text-[54px] lg:text-[68px] xl:text-[78px]")
      }
    >
      {body}
      {tail && (
        <Typewriter
          words={tail}
          align={align}
          startDelay={tailDelay}
          className="text-[#176995]"
          caretClassName="text-[#176995]/60"
        />
      )}
    </h1>
  );
}

/* ── The collage ────────────────────────────────────────────────────────────
   Photographs pinned to the gutters at different heights, some of them crossing
   the viewport edge. The asymmetry is the point: pairs at matching heights would
   read as a frame around the text, and a frame is furniture.

   Positioned against the section rather than laid out in a grid, so the reading
   column keeps the middle of the page to itself at every width — and the images
   simply stop existing below lg, where there is no gutter left to scatter
   anything into. */
const TILES = {
  secure: { src: "/landing/secure.jpg", cls: "left-[2%] top-[15%] h-[210px] w-[172px]", pos: "58% 42%", delay: 220 },
  adopt: { src: "/landing/adopt.jpg", cls: "-left-[5%] top-[41%] h-[236px] w-[215px]", pos: "50% 45%", delay: 340 },
  scale: { src: "/landing/scale.jpg", cls: "right-[3%] top-[12%] h-[196px] w-[186px]", pos: "50% 40%", delay: 280 },
  foundation: { src: "/landing/foundation.jpg", cls: "-right-[4%] top-[37%] h-[220px] w-[200px]", pos: "45% 50%", delay: 400 },
} as const;

export type TileKey = keyof typeof TILES;

/* The landing page gets all four. An interior page gets two — enough to carry
   the register, not enough to compete with the content it is introducing, which
   on those pages starts a screen earlier. */
export const PAIR: TileKey[] = ["secure", "foundation"];
export const ALL_TILES: TileKey[] = ["secure", "adopt", "scale", "foundation"];

function Collage({ tiles }: { tiles: TileKey[] }) {
  if (!tiles.length) return null;
  return (
    /* Measured from below the register marks rather than from the top of the
       section, so the two never collide. Percentages against the full section
       put the first tile at ~105px on a short interior hero — exactly where the
       top marks sit. */
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 top-[118px] hidden overflow-hidden lg:block"
    >
      {tiles.map((k) => {
        const t = TILES[k];
        return (
          <img
            key={t.src}
            src={t.src}
            alt=""
            className={`amp-in absolute object-cover ${t.cls}`}
            style={{ objectPosition: t.pos, animationDelay: `${t.delay}ms` }}
          />
        );
      })}
    </div>
  );
}

/* The four register marks that pin the hero to the page — dark at the head of
   the block, grey at its foot. They are the only ornament here, and they are
   doing a job: on a page this empty they are what says the white space was
   measured rather than left over. */
const MARKS = [
  "left-5 top-[92px] bg-[#0E0E0E] sm:left-9",
  "right-5 top-[92px] bg-[#0E0E0E] sm:right-9",
  "bottom-9 left-5 bg-[#C4C4C4] sm:left-9",
  "bottom-9 right-5 bg-[#C4C4C4] sm:right-9",
];

export function RegisterMarks() {
  return (
    <>
      {MARKS.map((m) => (
        <span
          key={m}
          aria-hidden
          className={`amp-in absolute h-[7px] w-[7px] ${m}`}
          style={{ animationDelay: "500ms" }}
        />
      ))}
    </>
  );
}

/* ── The hero ───────────────────────────────────────────────────────────────
   Paints nothing: on the landing and pricing pages the tone canvas is already
   the ground, and on the interior pages the page root is. A background here
   would be a seam on both. */
export function PaperHero({
  label,
  frame,
  claim,
  tail,
  lead,
  note,
  children,
  tiles = PAIR,
  size = "page",
  /** Full-height opening, for a page whose hero *is* the first screen. */
  fill = false,
  /** Left for a page that opens straight onto a working block (the plans) —
      a centred column above a left-aligned table reads as two pages stapled
      together. Centred for the pages whose hero is the whole screen. */
  align = "center",
}: {
  label?: string;
  frame: string[];
  claim: string;
  tail?: string[];
  lead?: ReactNode;
  /** The line under the buttons — a fact, not a caption. */
  note?: ReactNode;
  children?: ReactNode;
  tiles?: TileKey[];
  size?: "landing" | "page";
  fill?: boolean;
  align?: "center" | "left";
}) {
  const left = align === "left";
  return (
    <div
      className={
        "relative flex flex-col justify-center overflow-hidden text-[#0E0E0E] " +
        (fill ? "min-h-[100dvh]" : "")
      }
    >
      <Collage tiles={tiles} />
      <RegisterMarks />

      <div
        className={
          "relative mx-auto w-full max-w-[1420px] px-5 sm:px-9 " +
          (fill
            ? "pb-20 pt-[132px] sm:pb-24 sm:pt-[150px]"
            : // A left hero opens straight onto a working block, so it keeps a
              // short foot: the space under it belongs to the block, not to the
              // headline.
              left
              ? "pb-12 pt-[124px] sm:pb-14 sm:pt-[140px]"
              : "pb-20 pt-[128px] sm:pb-24 sm:pt-[146px]")
        }
      >
        {/* The column widens with the viewport instead of holding one measure.
            At 720px on a wide screen the headline left two dead gutters between
            itself and the photographs; the type has to reach towards them or the
            scatter reads as debris around an empty middle. The lead paragraph
            keeps its own narrower measure below — it is the one thing here that
            is actually read a line at a time. */}
        <div
          /* A pixel measure rather than `ch` on the left variant: `ch` is
             relative to the font size, so a display headline resolves it to a
             column narrower than the words in it and the claim breaks after two
             syllables. */
          className={
            left
              ? "flex max-w-[880px] flex-col items-start text-left xl:max-w-[1020px]"
              : "mx-auto flex max-w-[760px] flex-col items-center text-center lg:max-w-[940px] xl:max-w-[1080px]"
          }
        >
          {label && (
            <span className="amp-in mb-8 text-[13.5px] text-[#6E6E6E]" style={{ animationDelay: "60ms" }}>
              {label}
            </span>
          )}

          <PaperHeadline frame={frame} claim={claim} tail={tail} size={size} align={align} />

          {/* Set in the serif: after the tight sans above, the change of voice
              is what makes this read as the sentence underneath the claim
              rather than as more headline. */}
          {lead && (
            <p
              className="amp-in font-instrument-serif mt-8 max-w-[62ch] text-[19px] leading-[1.5] text-[#3A3A3A] sm:text-[22px]"
              style={{ animationDelay: "820ms" }}
            >
              {lead}
            </p>
          )}

          {children && (
            <div className="amp-in mt-10 w-full" style={{ animationDelay: "940ms" }}>
              {children}
            </div>
          )}

          {note && (
            <div
              className="amp-in mt-7 flex items-center gap-2 text-[13.5px] text-[#6E6E6E]"
              style={{ animationDelay: "1040ms" }}
            >
              {note}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
