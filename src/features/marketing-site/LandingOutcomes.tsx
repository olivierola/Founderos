import { Link } from "react-router-dom";
import { ArrowUpRightIcon as ArrowUpRight } from "@phosphor-icons/react";
import { Display, Reveal } from "./LandingKit";
import { ToneSection } from "./LandingTone";

/* Six outcomes, one per card. The card is mostly empty on purpose: a wordmark,
   a figure, and the sentence the figure is an answer to. Anything else and the
   grid stops being scannable, which is the only reason to lay results out as a
   grid rather than as a paragraph.

   The wash is what keeps six near-identical cards from reading as wallpaper —
   each one carries its own hue, bled in from the top-left corner. */

const OUTCOMES = [
  {
    brand: "Frictionless",
    brandClass: "text-[19px] font-semibold tracking-[-0.03em]",
    figure: "71%",
    label: "Of operations tickets resolved without a human touching them",
    hue: "rgba(255,255,255,0.10)",
  },
  {
    brand: "TAN & CO",
    brandClass: "text-[13px] font-medium uppercase tracking-[0.3em]",
    figure: "400",
    label: "Hours of manual reconciliation removed every month",
    hue: "rgba(124,131,216,0.20)",
  },
  {
    brand: "Loom",
    brandClass: "font-serif text-[21px] italic",
    figure: "42%",
    label: "Lower average handling time on inbound requests",
    hue: "rgba(42,156,130,0.20)",
  },
  {
    brand: "Halden Health",
    brandClass: "text-[17px] font-medium tracking-[-0.01em]",
    figure: "€2.7M",
    label: "Estimated annual saving, audited by their own finance team",
    hue: "rgba(232,180,35,0.18)",
  },
  {
    brand: "northbound",
    brandClass: "text-[19px] font-light lowercase tracking-[0.02em]",
    figure: "90%",
    label: "Of agent write actions approved in under an hour",
    hue: "rgba(255,255,255,0.07)",
  },
  {
    brand: "VERRIER",
    brandClass: "text-[15px] font-bold uppercase tracking-[0.14em]",
    figure: "60K",
    label: "Documents processed with nothing leaving their tenant",
    hue: "rgba(161,161,170,0.20)",
  },
];

export function LandingOutcomes() {
  return (
    <ToneSection tone="ink">
      <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28">
        <Reveal>
          <Display className="max-w-[22ch]">Measured outcomes across 40+ organisations</Display>
        </Reveal>

        <div className="mt-12 grid gap-3.5 md:grid-cols-2 lg:grid-cols-3">
          {OUTCOMES.map((o, i) => (
            <Reveal key={o.brand} delay={(i % 3) * 90}>
              <Link
                to="/solutions"
                className="group relative flex h-full min-h-[178px] flex-col justify-between overflow-hidden rounded-[18px] border border-white/[0.08] bg-white/[0.025] p-6 transition-colors duration-500 hover:border-white/20"
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 opacity-70 transition-opacity duration-500 group-hover:opacity-100"
                  style={{ background: `radial-gradient(ellipse 80% 120% at 0% 0%, ${o.hue}, transparent 62%)` }}
                />

                <div className="relative flex items-start justify-between gap-4">
                  <span className={`text-white/90 ${o.brandClass}`}>{o.brand}</span>
                  <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/[0.12] bg-white/[0.06] px-3 py-1 text-[11.5px] text-white/70 transition-colors group-hover:text-white">
                    Case study
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </span>
                </div>

                <div className="relative mt-10">
                  <div className="text-[32px] font-medium leading-none tracking-[-0.035em] text-white tabular-nums">
                    {o.figure}
                  </div>
                  <p className="mt-3.5 max-w-[34ch] text-[13.5px] leading-[1.5] text-white/50">{o.label}</p>
                </div>
              </Link>
            </Reveal>
          ))}
        </div>
      </div>
    </ToneSection>
  );
}
