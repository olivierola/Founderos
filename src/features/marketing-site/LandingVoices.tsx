import { Link } from "react-router-dom";
import { Display, Em, Pill, Reveal } from "./LandingKit";
import { ToneSection } from "./LandingTone";

/* Testimonials as full-width rows rather than as a slider. A slider shows one
   quote and hides the rest behind a gesture nobody makes; three rows let a
   reader take all three in one pass, and each row still gets a brand panel, a
   claim, a figure and the sentence a person actually said. */

const VOICES = [
  {
    brand: "Frictionless",
    brandClass: "text-[25px] font-semibold tracking-[-0.03em]",
    wash: "radial-gradient(ellipse 90% 80% at 30% 30%, rgba(255,255,255,0.34), transparent 65%), radial-gradient(ellipse 80% 90% at 75% 80%, rgba(42,156,130,0.40), transparent 62%)",
    claim: (
      <>
        The weekly report that used to take a <Em>week</Em>
      </>
    ),
    figure: "71%",
    figureLabel: "of operations tickets resolved with no human touch",
    quote:
      "The readiness scan told us to fix the data before touching AI. We did not love hearing it. Three months later the weekly report writes itself and nobody argues with the numbers in it.",
    author: "Léa Vermont",
    role: "COO, Frictionless Studio",
  },
  {
    brand: "TAN & CO",
    brandClass: "text-[16px] font-medium uppercase tracking-[0.3em]",
    wash: "radial-gradient(ellipse 90% 80% at 25% 35%, rgba(124,131,216,0.50), transparent 65%), radial-gradient(ellipse 80% 90% at 80% 75%, rgba(255,255,255,0.20), transparent 62%)",
    claim: (
      <>
        A year of stalled pilots, <Em>unblocked</Em>
      </>
    ),
    figure: "98%",
    figureLabel: "of write actions sitting behind an approval gate",
    quote:
      "Agents running inside our own tenant, behind our identity controls, every write approval-gated and logged. That is the answer our security committee had been asking for, and it is what let the work start.",
    author: "Marcus Tan",
    role: "CTO, Tan & Co",
  },
  {
    brand: "Loom",
    brandClass: "font-serif text-[28px] italic",
    wash: "radial-gradient(ellipse 90% 80% at 35% 30%, rgba(232,180,35,0.45), transparent 65%), radial-gradient(ellipse 80% 90% at 78% 82%, rgba(255,255,255,0.24), transparent 62%)",
    claim: (
      <>
        Eight percent use became <Em>seventy-nine</Em>
      </>
    ),
    figure: "79%",
    figureLabel: "weekly active use, twelve weeks after go-live",
    quote:
      "The rollout was a journey, not a training session. Champions in every team, a use case each of them actually cared about, and a number on a dashboard telling us where it was not landing.",
    author: "Aïcha Diallo",
    role: "Head of Engineering, Loom Agency",
  },
];

export function LandingVoices() {
  return (
    <ToneSection tone="slate">
      <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28">
        <Reveal>
          <Display className="max-w-[16ch]">Trusted by the people who had to sign it off</Display>
        </Reveal>

        {/* ── The stack ─────────────────────────────────────────────────────
            Each row sticks under the nav as it arrives and the next one slides
            over it, so the three end up dealt like cards rather than scrolling
            past one another. Three things this depends on:

            · the rows are direct children of the tall container — a per-row
              wrapper would cap each one's travel at its own height, and it
              would never stick to anything;
            · the card ground is opaque, or the row underneath reads through it;
            · the offsets step down by 14px so the stacked edges stay visible.  */}
        <div className="mt-12">
          {VOICES.map((v, i) => (
            <div
              key={v.author}
              className="sticky pb-5"
              style={{ top: `${88 + i * 14}px` }}
            >
              <div className="grid min-h-[520px] overflow-hidden rounded-[18px] border border-white/[0.09] bg-[#1A1A1A] shadow-[0_-18px_50px_-24px_rgba(0,0,0,0.95)] lg:min-h-[68vh] lg:grid-cols-[0.78fr_1.32fr_0.9fr]">
                {/* ── Brand panel ────────────────────────────────────────────
                    A colour field, blurred past any shape, with the wordmark
                    set over it — the closest honest stand-in for a client logo
                    we do not have the rights to print. */}
                <div className="relative min-h-[170px] overflow-hidden">
                  <div aria-hidden className="absolute inset-0 blur-[38px]" style={{ background: v.wash }} />
                  <div className="absolute inset-0 grid place-items-center px-6 text-center">
                    <span className={`text-white ${v.brandClass}`}>{v.brand}</span>
                  </div>
                </div>

                {/* ── Claim + figure ───────────────────────────────────────── */}
                <div className="flex flex-col justify-between gap-10 border-white/[0.08] p-7 sm:p-9 lg:border-x lg:p-11">
                  <h3 className="max-w-[20ch] text-balance text-[23px] font-medium leading-[1.14] tracking-[-0.022em] text-white sm:text-[28px] lg:text-[32px]">
                    {v.claim}
                  </h3>
                  <div className="flex flex-wrap items-end justify-between gap-6">
                    <div>
                      <div className="text-[34px] font-medium leading-none tracking-[-0.035em] text-white tabular-nums">
                        {v.figure}
                      </div>
                      <div className="mt-3 max-w-[28ch] text-[12.5px] leading-[1.5] text-white/45">
                        {v.figureLabel}
                      </div>
                    </div>
                    <Link to="/solutions">
                      <Pill variant="ghost" className="py-2 text-[12.5px]">
                        View case study
                      </Pill>
                    </Link>
                  </div>
                </div>

                {/* ── The quote ────────────────────────────────────────────── */}
                <figure className="flex flex-col justify-between gap-8 border-t border-white/[0.08] p-7 sm:p-9 lg:border-t-0 lg:p-11">
                  <blockquote className="text-[15px] leading-[1.7] text-white/65">{v.quote}</blockquote>
                  <figcaption>
                    <div className="text-[13.5px] font-medium text-white">{v.author}</div>
                    <div className="mt-1 text-[12.5px] text-white/40">{v.role}</div>
                  </figcaption>
                </figure>
              </div>
            </div>
          ))}

          {/* A real child, not padding on the container: a sticky element is
              constrained by its parent's CONTENT box, so padding-bottom buys it
              no extra travel and the stack would be shoved out — all three tops
              converging — the moment the last row arrives. */}
          <div aria-hidden className="h-[34vh]" />
        </div>
      </div>
    </ToneSection>
  );
}
