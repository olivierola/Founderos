import { Link } from "react-router-dom";
import { ArrowUpRightIcon as ArrowUpRight } from "@phosphor-icons/react";
import { CountUp, Display, Em, Pill, Reveal } from "./LandingKit";
import { ToneSection } from "./LandingTone";
import { ToolMarquee } from "./tools";

/* ── The light interlude, part two ──────────────────────────────────────────
   The question this answers is the one every technical reader asks before any
   other: does it touch what we already run.

   It used to answer it with four columns of grey names. That is the correct
   information and the wrong picture — a list set in one ink looks like a
   platform asking you to move into it, which is the opposite of the claim. The
   names carry their own marks now (see tools.tsx) and the logos do the arguing.
   They sit grey at rest and take their brand colour under the pointer, which is
   how the thing is actually used: you are hunting for yours, and yours is the
   one that answers. A reader finds it in about a second, which is the entire
   job of this section.

   Each tool is a card, and the cards drift vertically in columns that travel
   against each other (see ToolMarquee). The category headers are gone: with the
   marks at this size you scan for a shape rather than read a taxonomy, and four
   labelled boxes only put walls between you and the logo you came for.

   The ground is white. It used to be the "sand" tone, one step deeper than the
   section above so two light bands would not run together — but the cards are
   white plates, and a white plate on a grey ground reads as a cut-out. On paper
   the hairline does the separating and the cards sit ON the page rather than in
   a tray. The step down from the bone above is small enough that the tone canvas
   eases between them without a seam.

   Every ink is written out, nothing inherits.                                 */

const INK = "#141414";
const ACCENT = "#176995";

export function LandingStack() {
  return (
    <ToneSection tone="paper">
      <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28" style={{ color: INK }}>
        <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
          <Reveal>
            <span
              className="inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em]"
              style={{ color: ACCENT }}
            >
              {/* The accent as a mark rather than as a whole line of coloured
                  type, which would compete with the logos on the right. */}
              <span aria-hidden className="h-[6px] w-[6px] rounded-full" style={{ background: ACCENT }} />
              Your stack, not ours
            </span>
            <Display className="mt-6 max-w-[16ch] text-[#141414]">
              It runs on what you <Em>already</Em> have
            </Display>
            <p className="mt-7 max-w-md text-[15.5px] leading-[1.65] text-black/60">
              Agents sit on top of your systems and speak to them through the same permissions your people
              have. No platform migration, no rip-and-replace, no second source of truth to keep in sync.
            </p>

            {/* The two figures, the live one ruled in the accent — the zero is
                the quieter half of the pair on purpose. */}
            <div className="mt-10 flex items-stretch gap-8 sm:gap-12">
              <div className="border-l-2 pl-5" style={{ borderColor: ACCENT }}>
                <CountUp
                  to={57}
                  className="block text-[44px] font-medium leading-none tracking-[-0.035em] tabular-nums"
                />
                <div className="mt-3 max-w-[18ch] text-[11.5px] font-medium uppercase leading-[1.5] tracking-[0.12em] text-black/45">
                  Connectors in production
                </div>
              </div>
              <div className="border-l-2 border-black/10 pl-5">
                <CountUp
                  to={0}
                  className="block text-[44px] font-medium leading-none tracking-[-0.035em] tabular-nums"
                />
                <div className="mt-3 max-w-[18ch] text-[11.5px] font-medium uppercase leading-[1.5] tracking-[0.12em] text-black/45">
                  Migrations required
                </div>
              </div>
            </div>

            <Link to="/integrations" className="group mt-10 inline-block">
              <Pill className="gap-2.5 px-6 py-3">
                See every integration
                <ArrowUpRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </Pill>
            </Link>
          </Reveal>

          {/* `min-w-0` is load-bearing: a grid item defaults to min-width:auto,
              so any wide child sizes the whole column to its own content rather
              than to the track. */}
          <Reveal delay={120} className="min-w-0">
            {/* Fixed-height rails: the columns scroll, the section does not
                grow with the catalogue. Adding a connector lengthens a track,
                never the page. */}
            <ToolMarquee />
            <p className="mt-10 text-[13px] text-black/45">
              Anything with an API can be added; anything without one, we say so before you sign.
            </p>
          </Reveal>
        </div>
      </div>
    </ToneSection>
  );
}
