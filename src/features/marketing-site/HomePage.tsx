import { useEffect } from "react";
import { Link } from "react-router-dom";
import { MinusIcon as Minus, PlusIcon as Plus } from "@phosphor-icons/react";
import { LandingNav } from "./LandingNav";
import { LandingHero } from "./LandingHero";
import { LandingProof } from "./LandingProof";
import { LandingGlobe } from "./LandingGlobe";
import { LandingOutcomes } from "./LandingOutcomes";
import { LandingIndustries } from "./LandingIndustries";
import { LandingPlatform } from "./LandingPlatform";
import { LandingMethod } from "./LandingMethod";
import { LandingStack } from "./LandingStack";
import { LandingVoices } from "./LandingVoices";
import { LandingTrust } from "./LandingTrust";
import { LandingClose } from "./LandingClose";
import { LandingFooter } from "./LandingFooter";
import { Display, Pill, Reveal } from "./LandingKit";
import { ToneCanvas, ToneSection } from "./LandingTone";

/* ══ The landing page ════════════════════════════════════════════════════════
   One canvas from the nav to the footer. Nothing here paints its own
   background: the tone plane behind the whole page eases between inks as each
   section takes the middle of the viewport (see LandingTone), which is what
   turns a stack of bands into a single room you walk through.

   It opens on paper and drops into the dark at the first section. The hero is
   a sheet you read; everything under it is the room the work happens in, and
   that first transition is the page introducing itself.

   The order is an argument: what it is (hero) → that it works (proof, scale,
   outcomes) → what you get (offers, platform) → how it runs (method, stack —
   the page's one light interlude) → who says so (voices, trust) →
   what you still want to ask (FAQ) → the way in.                             */

const FAQ = [
  {
    q: "What does Anduran actually do?",
    a: "We help companies adopt AI safely. In practice, three things: we assess where your processes and data stand today, we build the secured foundation so AI has something solid to work on, and we guide adoption across the organisation with governance and change enablement.",
  },
  {
    q: "We are not sure we are ready for AI. Where do we start?",
    a: "With the readiness assessment. It rates every process from L1 to L5 and tells you which work is ready for an agent today, which needs a foundation first, and which should wait. Most teams find two or three quick wins and one structural gap they did not know about.",
  },
  {
    q: "How do you handle data security when deploying AI?",
    a: "Credentials are encrypted at rest with AES-GCM and never returned in plaintext to the browser. Every agent runs against scoped tool grants, write actions are approval-gated, and every call is recorded in an exportable audit log. We connect to your systems. We do not copy your data.",
  },
  {
    q: "Do agents run on our own infrastructure?",
    a: "They can. Agents run inside your tenant with your identity controls and data residency, and you can route inference to a model you host yourself. Your prompts, your data and the resulting IP stay yours.",
  },
  {
    q: "What industries and company sizes do you work with?",
    a: "From twenty-person teams to enterprises with several thousand seats, with the deepest experience in services, logistics, finance and software. The framework is the same; the depth of governance scales with your regulatory surface.",
  },
];

function LandingFaq() {
  return (
    <ToneSection tone="slate" id="faq">
      <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28">
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
          <Reveal>
            <Display className="max-w-[12ch]">Questions we get asked first</Display>
            <p className="mt-6 max-w-sm text-[15.5px] leading-[1.6] text-white/55">
              The five that come up in nearly every first conversation. The rest are on their own page.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link to="/contact">
                <Pill variant="light">Talk to us</Pill>
              </Link>
              <Link
                to="/faq"
                className="text-[13.5px] text-white/55 underline-offset-4 transition-colors hover:text-white hover:underline"
              >
                Read all the questions
              </Link>
            </div>
          </Reveal>

          <Reveal delay={100} className="border-t border-white/[0.10]">
            {FAQ.map((f, i) => (
              <details key={f.q} open={i === 0} className="group border-b border-white/[0.10]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-6 text-[16.5px] leading-snug tracking-[-0.015em] text-white sm:text-[17.5px]">
                  {f.q}
                  <Plus className="h-5 w-5 shrink-0 text-white/35 group-open:hidden" />
                  <Minus className="hidden h-5 w-5 shrink-0 text-white/50 group-open:block" />
                </summary>
                <p className="max-w-[62ch] pb-7 pr-8 text-[14.5px] leading-[1.65] text-white/55">{f.a}</p>
              </details>
            ))}
          </Reveal>
        </div>
      </div>
    </ToneSection>
  );
}

export function HomePage() {
  useEffect(() => {
    document.documentElement.classList.add("mkt-no-scrollbar", "amp-root");
    return () => document.documentElement.classList.remove("mkt-no-scrollbar", "amp-root");
  }, []);

  return (
    <div
      className="amplify min-h-screen text-white"
      /* No `overflow-x-hidden` here: it would make the root a scroll
         container that never scrolls, and every sticky descendant (the
         testimonial stack) would stop sticking. Sections that bleed a wash
         clip themselves instead.

         `.amplify` paints its own ink, and a block-level background is painted
         after the negative-z layer behind it — so left alone it would hide the
         tone canvas completely. The page's ground is the canvas now. */
      style={{ backgroundColor: "transparent" }}
    >
      <LandingNav />

      {/* The page opens on paper now: the hero is a paper section, so the canvas
          has to start there. Left on slate it would paint dark for one frame
          and ease to light under a headline that never moved. */}
      <ToneCanvas initial="paper">
        {/* ══ What it is ═════════════════════════════════════════════════ */}
        <LandingHero />

        {/* ══ That it works ══════════════════════════════════════════════ */}
        <LandingProof />
        <LandingGlobe />
        <LandingOutcomes />

        {/* ══ What you get ═══════════════════════════════════════════════ */}
        <LandingIndustries />
        <LandingPlatform />

        {/* ══ How it runs — the page opens a window here ══════════════════
            Two sections on paper, in the middle of a dark page. The change of
            ground is the point: everything above is the argument, these two
            are the plan and the plumbing, and a reader should feel the room
            change when the register does. */}
        <LandingMethod />
        <LandingStack />

        {/* ══ Who says so ════════════════════════════════════════════════ */}
        <LandingVoices />
        <LandingTrust />

        {/* ══ What is left to ask, and the way in ════════════════════════ */}
        <LandingFaq />
        <LandingClose />

        {/* The footer paints the same ink this last section lands on, so the
            seam between the canvas and the footer never shows. */}
        <ToneSection tone="ink">
          {/* Transparent band: the tone canvas is already the ground the slab
              floats on, and any painted band would show as a seam. */}
          <LandingFooter band="transparent" />
        </ToneSection>
      </ToneCanvas>
    </div>
  );
}
