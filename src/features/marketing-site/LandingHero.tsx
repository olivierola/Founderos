import { Link } from "react-router-dom";
import { CheckIcon as Check } from "@phosphor-icons/react";
import { Pill } from "./LandingKit";
import { ALL_TILES, PaperHero } from "./PaperHero";
import { ToneSection } from "./LandingTone";

/* The interior pages (solutions, blog, the page heroes) read this. The landing
   hero paints nothing of its own any more — it opens on the tone canvas' paper
   — but the constant stays here because that is where the rest of the site
   imports it from. */
export const HERO_BG = "#f0f0f0";

/* The page's opening. Everything about how it is built lives in PaperHero,
   which every other page opens through too; what is left here is what this
   page in particular says. It gets the full four-photograph collage and the
   rotating last line — the two things that make it the loudest hero on the
   site — and the pages under it deliberately get neither. */

/* The last line is the one worth saying four ways: the framing holds, only the
   promise changes. They are full clauses rather than single words — a one-word
   line under two long ones leaves the headline collapsing to a point, and the
   whole reason the column is this wide is to stop the type stranding itself in
   the middle of the page. */
const TAIL = [
  "that stay auditable.",
  "that never leave home.",
  "you can prove after.",
  "inside your own tenant.",
];

export function LandingHero() {
  return (
    <ToneSection tone="paper">
      <PaperHero
        fill
        size="landing"
        tiles={ALL_TILES}
        label="Agents that never leave your perimeter"
        frame={["A complete system for"]}
        claim="human and AI operations"
        tail={TAIL}
        lead={
          <>
            Anduran is the AI workforce that runs inside your own tenant, meaning every agent works on
            your systems, behind{" "}
            <Link
              to="/solutions"
              className="underline decoration-[#3A3A3A]/35 underline-offset-[5px] transition-colors hover:decoration-[#3A3A3A]"
            >
              your identity controls
            </Link>
            , with every write action approved and every call in the audit log.
          </>
        }
        note={
          <>
            <Check className="h-3.5 w-3.5 text-[#0E0E0E]" weight="bold" />
            No migration. European by design. Your data stays yours.
          </>
        }
      >
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link to="/contact">
            <Pill variant="solid" className="px-7 py-3.5 text-[14.5px]">
              Book a consultation
            </Pill>
          </Link>
          <Link to="/solutions">
            {/* Not the ghost variant — that is a hairline drawn for the dark
                canvas and it disappears on paper. */}
            <Pill
              variant="light"
              className="border border-[#0E0E0E]/15 bg-white px-7 py-3.5 text-[14.5px] hover:bg-[#FAFAFA]"
            >
              See how it works
            </Pill>
          </Link>
        </div>
      </PaperHero>
    </ToneSection>
  );
}
