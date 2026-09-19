import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRightIcon as ArrowRight } from "@phosphor-icons/react";
import { Display, Em, Pill, Reveal } from "./LandingKit";
import { ToneSection } from "./LandingTone";
import { SOLUTIONS } from "./solutions";

/* ── The six offers, one at a time ──────────────────────────────────────────
   They used to be a grid of six cards, which asks the reader to compare six
   paragraphs at once and gets them to read none. A selector shows one, keeps
   the other five one click away, and gives each offer the room to carry a
   photograph and a figure.

   The list itself comes from solutions.ts — the labels, the order and the
   destinations are the same set the nav and the footer read. Only the
   home-page extras (a photograph, one agent line, one number) live here. */

type Extra = {
  img: string;
  position: string;
  /* What the agent is saying in the card floating on the photograph. */
  line: string;
  stat: { brand: string; figure: string; label: string; second: string };
};

const EXTRAS: Record<string, Extra> = {
  readiness: {
    img: "/landing/foundation.jpg",
    position: "55% 45%",
    line: "Order-to-cash scores L2: the approval rules live in three inboxes. Fix that first and it clears L4.",
    stat: {
      brand: "Frictionless",
      figure: "2–3 wks",
      label: "From kick-off to a scored roadmap",
      second: "104 processes rated L1–L5",
    },
  },
  agents: {
    img: "/landing/secure.jpg",
    position: "58% 45%",
    line: "I can raise the credit note, but it is a write action on the ledger — it waits for your approval.",
    stat: {
      brand: "TAN & CO",
      figure: "98%",
      label: "Of write actions behind an approval gate",
      second: "0 credentials ever in the browser",
    },
  },
  foundation: {
    img: "/landing/scale.jpg",
    position: "65% 45%",
    line: "Three systems call this field 'client'. I have mapped them to one and flagged the 41 rows that disagree.",
    stat: {
      brand: "northbound",
      figure: "57",
      label: "Systems connected, without a migration",
      second: "One definition per business term",
    },
  },
  adoption: {
    img: "/landing/adopt.jpg",
    position: "45% 35%",
    line: "Nine of your twelve champions used an agent this week. The finance team has not — worth a look.",
    stat: {
      brand: "Loom",
      figure: "79%",
      label: "Weekly active use twelve weeks in",
      second: "Up from a median of 8%",
    },
  },
  governance: {
    img: "/landing/foundation.jpg",
    position: "40% 55%",
    line: "This agent is about to touch personnel data. That is outside its declared scope, so I have stopped.",
    stat: {
      brand: "Halden Health",
      figure: "100%",
      label: "Of agent actions in an exportable audit log",
      second: "Every build reviewed before it ships",
    },
  },
  managed: {
    img: "/landing/scale.jpg",
    position: "35% 50%",
    line: "The model provider shipped a breaking change on Tuesday. Your four agents were migrated Wednesday.",
    stat: {
      brand: "VERRIER",
      figure: "3 people",
      label: "Who already know your environment",
      second: "Roadmap reviewed every quarter",
    },
  },
};

export function LandingIndustries() {
  const [active, setActive] = useState(0);
  const solution = SOLUTIONS[active];
  const extra = EXTRAS[solution.slug];

  return (
    <ToneSection tone="raised">
      <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28">
        <Reveal>
          <Display className="max-w-[17ch]">
            Purpose-built for the part of adoption you are <Em>actually</Em> stuck on
          </Display>
        </Reveal>

        <Reveal delay={100}>
          <div className="mt-12 grid gap-3.5 lg:grid-cols-[250px_minmax(0,1fr)_280px]">
            {/* ── The rail ─────────────────────────────────────────────────
                Buttons, not links: choosing one changes what is shown beside
                it. The way through to the page is the panel's own link. */}
            <div className="flex gap-2.5 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
              {SOLUTIONS.map((s, i) => {
                const on = i === active;
                return (
                  <button
                    key={s.slug}
                    type="button"
                    onClick={() => setActive(i)}
                    aria-pressed={on}
                    className={`shrink-0 whitespace-nowrap rounded-full px-5 py-3 text-left text-[14px] transition-colors duration-300 lg:w-full lg:whitespace-normal ${
                      on
                        ? "bg-[#F5F5F5] font-medium text-[#0E0E0E]"
                        : "border border-white/[0.10] text-white/65 hover:border-white/25 hover:text-white"
                    }`}
                  >
                    {s.menu.label}
                  </button>
                );
              })}
            </div>

            {/* ── The photograph ─────────────────────────────────────────── */}
            <div className="relative min-h-[290px] overflow-hidden rounded-[18px] bg-black/50 sm:min-h-[370px]">
              {/* All six stay mounted and crossfade — swapping the src would
                  flash an unloaded frame on every change. */}
              {SOLUTIONS.map((s, i) => (
                <img
                  key={s.slug}
                  src={EXTRAS[s.slug].img}
                  alt=""
                  aria-hidden
                  className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${
                    i === active ? "opacity-100" : "opacity-0"
                  }`}
                  style={{ objectPosition: EXTRAS[s.slug].position }}
                />
              ))}
              <div
                aria-hidden
                className="absolute inset-0"
                style={{ background: "linear-gradient(to top, rgba(8,8,8,0.72) 5%, rgba(8,8,8,0.15) 55%)" }}
              />

              <div className="relative flex h-full min-h-[290px] flex-col justify-between p-5 sm:min-h-[370px] sm:p-7">
                {/* Keyed on the slug so the line replays its entrance when the
                    selection changes. */}
                <div
                  key={solution.slug}
                  className="amp-in max-w-[390px] rounded-[16px] border border-white/[0.12] bg-[#171717]/85 p-4 backdrop-blur-2xl"
                >
                  <div className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-white/40">
                    {solution.nav} agent
                  </div>
                  <p className="mt-2 text-[14px] leading-[1.5] text-white/90">{extra.line}</p>
                </div>

                <Link to={`/solutions/${solution.slug}`} className="self-start">
                  <Pill variant="light" className="py-2.5">
                    {solution.menu.label}
                    <ArrowRight className="h-4 w-4" />
                  </Pill>
                </Link>
              </div>
            </div>

            {/* ── The figure ─────────────────────────────────────────────── */}
            <div className="flex flex-col justify-between rounded-[18px] border border-white/[0.08] bg-white/[0.03] p-7">
              <div>
                <div className="text-[14px] font-medium text-white/85">{extra.stat.brand}</div>
                <div className="mt-9 text-[34px] font-medium leading-none tracking-[-0.035em] text-white">
                  {extra.stat.figure}
                </div>
                <div className="mt-3.5 text-[11px] font-medium uppercase leading-[1.5] tracking-[0.12em] text-white/45">
                  {extra.stat.label}
                </div>

                <div className="my-7 h-px bg-white/[0.09]" />

                <div className="text-[13.5px] leading-[1.5] text-white/60">{extra.stat.second}</div>
              </div>

              <Link
                to={`/solutions/${solution.slug}`}
                className="group mt-9 inline-flex items-center gap-2 text-[13.5px] text-white transition-colors hover:text-white/60"
              >
                View case study
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </Link>
            </div>
          </div>
        </Reveal>
      </div>
    </ToneSection>
  );
}
