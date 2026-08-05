import { Fragment } from "react";
import { Link } from "react-router-dom";
import { AnimatedText, CtaPill, Typewriter } from "./LandingKit";

/* The hero canvas — a light grey, so the page opens light and the dark bands
   further down read as punctuation rather than as the default. */
export const HERO_BG = "#f0f0f0";

/* ── Headline ───────────────────────────────────────────────────────────────
   The line is a sequence of segments: type, or a circular image dropped inline
   between two words. Three inks carry the meaning — near-black for the claim,
   grey for the connective tissue, orange for the promise. */
type Seg =
  | { text: string; tone?: keyof typeof TONE }
  | { img: string; alt: string; position?: string };

const TONE = {
  ink: "text-[#0d0d0d]",
  muted: "text-black/35",
  accent: "text-[var(--amp-orange)]",
};

/* object-position is tuned per photo so the subject survives the crop to a
   circle roughly one cap-height wide. */
const HEADLINE: Seg[] = [
  { text: "AI Is Coming." },
  { img: "/landing/secure.jpg", alt: "", position: "60% 50%" },
  { text: "We Help You", tone: "muted" },
  { img: "/landing/adopt.jpg", alt: "", position: "45% 35%" },
  { text: "Adopt It", tone: "accent" },
  { img: "/landing/foundation.jpg", alt: "", position: "55% 45%" },
];

/* The typed tail. It sits last on purpose: nothing follows it, so a phrase of a
   different length reflows only itself. Lengths are kept close so the headline
   does not gain or lose a line mid-cycle. */
const TAIL = ["The Right Way.", "Without The Chaos.", "On Your Own Stack.", "With Guardrails On."];

const BASE_DELAY = 160;
const STEP = 16;

/* Initials rather than stock faces — these are the three voices quoted further
   down the page, so the row stays honest. */
const TRUSTED = [
  { initials: "LV", bg: "#ff4d00" },
  { initials: "MT", bg: "#8a8a92" },
  { initials: "AD", bg: "#1e1e22" },
];

function Headline() {
  // One running clock across the whole line, so glyphs and chips reveal in
  // reading order instead of each segment restarting from zero.
  let chars = 0;

  const body = HEADLINE.map((seg, i) => {
    const delay = BASE_DELAY + chars * STEP;

    if ("img" in seg) {
      chars += 3; // a chip is worth about a syllable of the rhythm
      return (
        <Fragment key={i}>
          <img
            src={seg.img}
            alt={seg.alt}
            loading="eager"
            className="amp-in mx-[0.04em] inline-block h-[0.84em] w-[0.84em] shrink-0 rounded-full object-cover align-[-0.1em] shadow-[0_2px_10px_rgba(0,0,7,0.18)]"
            style={{ objectPosition: seg.position, animationDelay: `${delay}ms` }}
          />{" "}
        </Fragment>
      );
    }

    chars += seg.text.length;
    return (
      <Fragment key={i}>
        <AnimatedText text={seg.text} delay={delay} step={STEP} className={TONE[seg.tone ?? "ink"]} />{" "}
      </Fragment>
    );
  });

  // The tail starts once the last glyph has landed — 700ms is the reveal's own
  // duration, so it picks up exactly where the line stops moving.
  const tailDelay = BASE_DELAY + chars * STEP + 700;

  return (
    <h1 className="mt-8 max-w-5xl text-balance text-[42px] font-semibold leading-[1.06] tracking-[-0.035em] text-[#0d0d0d] sm:text-[66px] lg:text-[84px]">
      {body}
      <Typewriter words={TAIL} startDelay={tailDelay} caretClassName="text-[var(--amp-orange)]" />
    </h1>
  );
}

export function LandingHero() {
  return (
    <section className="amp-light relative overflow-hidden pt-[104px]" style={{ background: HERO_BG }}>
      <div className="relative mx-auto max-w-[1280px] px-4 sm:px-8">
        {/* The copy stops well short of a full screen so the top of the video
            card is already in view above the fold. */}
        <div className="amp-rails relative flex min-h-[calc(58dvh-104px)] flex-col items-center justify-center py-14 text-center">
          {/* Social proof: overlapping avatars + one flat sentence. */}
          <div className="amp-in flex items-center gap-3" style={{ animationDelay: "60ms" }}>
            <div className="flex -space-x-2.5">
              {TRUSTED.map((a) => (
                <span
                  key={a.initials}
                  // Ring painted in the canvas colour so the discs read as cut
                  // out of the page rather than outlined.
                  className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold tracking-[0.02em] text-white ring-2 ring-[#f0f0f0]"
                  style={{ background: a.bg }}
                >
                  {a.initials}
                </span>
              ))}
            </div>
            <span className="text-[15px] text-black/50">Trusted by founders and CTOs.</span>
          </div>

          <Headline />

          {/* Same two-ink treatment, one notch quieter: the promise stays dark,
              the qualifiers drop back to grey. */}
          <p className="mt-7 max-w-xl text-[15px] leading-[1.65] text-black/40">
            <span className="text-black/70">We make it easy to put agents to work</span> — secured, governed, and
            running inside your own stack. <span className="text-black/70">No exposed data, no lost control,</span> no
            intelligence bolted onto broken processes.
          </p>

          <div className="amp-in mt-10" style={{ animationDelay: "980ms" }}>
            <Link to="/contact">
              <CtaPill>Book a Consultation</CtaPill>
            </Link>
          </div>
        </div>
      </div>

      {/* The video floats on the hero canvas: full screen width, one screen
          tall, minus a thin margin all round — a card resting on the page
          rather than a band welded to it. */}
      <div className="px-2.5 pb-2.5 sm:px-5 sm:pb-5">
        <div className="relative h-[calc(100dvh-20px)] overflow-hidden rounded-[26px] bg-black shadow-[0_50px_110px_-40px_rgba(0,0,7,0.55)] sm:h-[calc(100dvh-40px)] sm:rounded-[32px]">
          <video
            className="absolute inset-0 h-full w-full object-cover"
            src="/landing/hero.mp4"
            poster="/landing/secure.jpg"
            autoPlay
            loop
            muted
            playsInline
          />
          {/* Knocked back so the footage reads as a backdrop, not as the loudest
              thing on the page — flat scrim plus a touch of vignette. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "linear-gradient(rgba(0,0,7,0.30), rgba(0,0,7,0.38)), radial-gradient(ellipse 75% 65% at 50% 45%, transparent 40%, rgba(0,0,7,0.35) 100%)",
            }}
          />
        </div>
      </div>
    </section>
  );
}
