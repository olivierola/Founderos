import { useEffect } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowUpRightIcon as ArrowUpRight,
  CheckIcon as Check,
  MinusIcon as Minus,
  PlusIcon as Plus,
} from "@phosphor-icons/react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { LandingClose } from "./LandingClose";
import { Pill, Reveal } from "./LandingKit";
import { RegisterMarks } from "./PaperHero";
import { CornerMarks, MonoLabel, PAPER_ACCENT, SectionTitle } from "./PaperKit";
import { ToneCanvas, ToneSection } from "./LandingTone";
import { SOLUTIONS, getSolution } from "./solutions";

/* ═══ One solution ═══════════════════════════════════════════════════════════
   Six sibling pages on the home/pricing system. The template is stable on
   purpose: these are pages a reader compares one against another and never sees
   two of at once, so a fixed shape is what makes them comparable. The variation
   lives in the data — the diagram is re-tinted per solution, and a proof figure
   only renders when there is one worth showing.

   The page is on paper from the nav to the closing slab, and the only colour is
   the one blue, exactly as on pricing. The per-solution key colour survives as
   a single mark next to the number: keying a whole page to it made six pages
   look like six different products.                                          */

const INK = "#111111";
const GREY = "#777777";
const RULE = "rgba(17,17,17,0.12)";

export function SolutionPage() {
  useEffect(() => {
    document.documentElement.classList.add("mkt-no-scrollbar", "amp-root");
    return () => document.documentElement.classList.remove("mkt-no-scrollbar", "amp-root");
  }, []);

  const { slug } = useParams();
  const solution = getSolution(slug);

  // Router keeps scroll position across routes, so moving between two solutions
  // would otherwise drop you halfway down a page you have not read.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [slug]);

  if (!solution) return <Navigate to="/solutions" replace />;

  const Visual = solution.visual;
  const others = SOLUTIONS.filter((s) => s.slug !== solution.slug);

  return (
    <div className="amplify min-h-screen text-white" style={{ backgroundColor: "transparent" }}>
      <LandingNav />

      <ToneCanvas initial="paper">
        {/* ══ The offer, its numbers and its diagram ══════════════════════
            Two columns rather than the centred paper hero: a detail page has to
            carry the meta and the picture at the same time. */}
        <ToneSection tone="paper">
          <header className="relative overflow-hidden">
            <RegisterMarks />
            <div className="relative mx-auto max-w-[1420px] px-5 pb-16 pt-[124px] sm:px-9 sm:pt-[142px]">
              <Link
                to="/solutions"
                className="inline-flex items-center gap-2 text-[14px] transition-colors hover:text-[#111111]"
                style={{ color: GREY }}
              >
                <ArrowLeft className="h-4 w-4" />
                All solutions
              </Link>

              <div className="mt-10 grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
                <div>
                  <div className="flex items-center gap-3">
                    <span
                      className="flex h-[34px] w-[34px] items-center justify-center text-[12.5px] font-medium tabular-nums text-white"
                      style={{ background: PAPER_ACCENT }}
                    >
                      {solution.num}
                    </span>
                    {/* The solution's own key, kept to one mark. */}
                    <span aria-hidden className="h-[7px] w-[7px]" style={{ background: solution.key }} />
                    <MonoLabel>{solution.nav}</MonoLabel>
                  </div>

                  <h1
                    className="mt-7 text-pretty text-[36px] font-normal leading-[1.05] tracking-[-0.035em] sm:text-[50px]"
                    style={{ color: INK }}
                  >
                    {solution.title}
                  </h1>
                  <p
                    className="mt-6 max-w-xl font-instrument-serif text-[19px] leading-[1.5] sm:text-[22px]"
                    style={{ color: "#3A3A3A" }}
                  >
                    {solution.lead}
                  </p>

                  <dl
                    className="mt-9 flex flex-wrap gap-x-10 gap-y-4 border-t pt-7"
                    style={{ borderColor: RULE }}
                  >
                    {solution.meta.map((m) => (
                      <div key={m.label}>
                        <dt
                          className="font-mono text-[10.5px] uppercase tracking-[0.1em]"
                          style={{ color: GREY }}
                        >
                          {m.label}
                        </dt>
                        <dd className="mt-1.5 text-[15px]" style={{ color: INK }}>
                          {m.value}
                        </dd>
                      </div>
                    ))}
                  </dl>

                  <div className="mt-10">
                    <Link to="/contact">
                      <Pill variant="solid" className="px-7 py-3.5 text-[14.5px]">
                        Book a consultation
                      </Pill>
                    </Link>
                  </div>
                </div>

                <div className={`amp-viz ${solution.viz} overflow-hidden bg-[#08080a] p-7`}>
                  <Visual />
                </div>
              </div>
            </div>
          </header>
        </ToneSection>

        {/* ══ The problem, in the client's words before ours ══════════════ */}
        <ToneSection tone="bone">
          <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28" style={{ color: INK }}>
            <div className="grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:gap-20">
              <Reveal>
                <MonoLabel>The problem</MonoLabel>
                <h2
                  className="mt-6 text-balance text-[28px] font-normal leading-[1.12] tracking-[-0.03em] sm:text-[36px]"
                  style={{ color: INK }}
                >
                  {solution.problem.title}
                </h2>
              </Reveal>

              <Reveal delay={110}>
                <p className="text-[16.5px] leading-[1.7]" style={{ color: GREY }}>
                  {solution.problem.body}
                </p>
                <ul className="mt-9 space-y-4 border-t pt-8" style={{ borderColor: RULE }}>
                  {solution.problem.points.map((p) => (
                    <li key={p} className="flex gap-4">
                      {/* A minus, not a check: these are the things that are wrong. */}
                      <Minus className="mt-[5px] h-4 w-4 shrink-0" style={{ color: "#B4B4B4" }} />
                      <span className="text-[16px] leading-[1.6]" style={{ color: INK }}>
                        {p}
                      </span>
                    </li>
                  ))}
                </ul>
              </Reveal>
            </div>
          </div>
        </ToneSection>

        {/* ══ The approach, as a numbered sequence ════════════════════════ */}
        <ToneSection tone="paper">
          <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28" style={{ color: INK }}>
            <Reveal className="max-w-2xl">
              <MonoLabel>How we do it</MonoLabel>
              <h2
                className="mt-6 text-balance text-[30px] font-normal leading-[1.08] tracking-[-0.035em] sm:text-[42px]"
                style={{ color: INK }}
              >
                {solution.approach.title}
              </h2>
              <p className="mt-6 text-[16px] leading-[1.65]" style={{ color: GREY }}>
                {solution.approach.body}
              </p>
            </Reveal>

            <div className="mt-14 border-t" style={{ borderColor: RULE }}>
              {solution.approach.steps.map((s, i) => (
                <Reveal key={s.t} delay={i * 90}>
                  <div
                    className="grid gap-3 border-b py-8 sm:grid-cols-[64px_260px_1fr] sm:gap-8"
                    style={{ borderColor: RULE }}
                  >
                    <span
                      className="font-mono text-[11.5px] tabular-nums"
                      style={{ color: i === 0 ? PAPER_ACCENT : GREY }}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <h3 className="text-[20px] font-normal tracking-[-0.022em]" style={{ color: INK }}>
                      {s.t}
                    </h3>
                    <p className="max-w-2xl text-[15px] leading-[1.65]" style={{ color: GREY }}>
                      {s.b}
                    </p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </ToneSection>

        {/* ══ What you get ═══════════════════════════════════════════════ */}
        <ToneSection tone="paper">
          <div className="mx-auto max-w-[1420px] px-5 pb-24 sm:px-9 sm:pb-28" style={{ color: INK }}>
            <div className="grid gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
              <Reveal>
                <MonoLabel>What lands</MonoLabel>
                <h2
                  className="mt-6 max-w-lg text-balance text-[28px] font-normal leading-[1.12] tracking-[-0.03em] sm:text-[36px]"
                  style={{ color: INK }}
                >
                  Everything on this list is yours to keep
                </h2>
                <ul className="mt-9 space-y-3.5">
                  {solution.deliverables.map((d) => (
                    <li key={d} className="flex gap-3">
                      <Check
                        className="mt-[3px] h-4 w-4 shrink-0" weight="bold"
                        style={{ color: PAPER_ACCENT }} />
                      <span className="text-[15.5px] leading-[1.55]" style={{ color: INK }}>
                        {d}
                      </span>
                    </li>
                  ))}
                </ul>
              </Reveal>

              {solution.proof && (
                <Reveal delay={110}>
                  <div className="relative bg-[#F7F7F7] p-9">
                    <CornerMarks accent />
                    <div
                      className="text-[64px] font-normal leading-none tracking-[-0.04em] tabular-nums"
                      style={{ color: INK }}
                    >
                      {solution.proof.figure}
                      <span style={{ color: PAPER_ACCENT }}>{solution.proof.unit}</span>
                    </div>
                    <div
                      className="mt-6 max-w-[26ch] border-t pt-6 text-[15px] leading-[1.55]"
                      style={{ borderColor: RULE, color: GREY }}
                    >
                      {solution.proof.label}
                    </div>
                  </div>
                </Reveal>
              )}
            </div>
          </div>
        </ToneSection>

        {/* ══ The objections, answered ═══════════════════════════════════ */}
        <ToneSection tone="bone">
          <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28" style={{ color: INK }}>
            <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
              <Reveal>
                <SectionTitle frame="What people ask" claim={`about ${solution.nav.toLowerCase()}`} />
              </Reveal>

              <Reveal delay={100}>
                <div className="border-t" style={{ borderColor: RULE }}>
                  {solution.faq.map((f, i) => (
                    <details
                      key={f.q}
                      open={i === 0}
                      className="group border-b"
                      style={{ borderColor: RULE }}
                    >
                      <summary
                        className="flex cursor-pointer list-none items-center justify-between gap-6 py-6 text-[16.5px] leading-snug tracking-[-0.015em] sm:text-[17.5px]"
                        style={{ color: INK }}
                      >
                        {f.q}
                        <Plus className="h-5 w-5 shrink-0 group-open:hidden" style={{ color: GREY }} />
                        <Minus className="hidden h-5 w-5 shrink-0 group-open:block" style={{ color: GREY }} />
                      </summary>
                      <p className="max-w-[62ch] pb-7 pr-8 text-[14.5px] leading-[1.65]" style={{ color: GREY }}>
                        {f.a}
                      </p>
                    </details>
                  ))}
                </div>
              </Reveal>
            </div>
          </div>
        </ToneSection>

        {/* ══ The other five ═════════════════════════════════════════════ */}
        <ToneSection tone="paper">
          <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28" style={{ color: INK }}>
            <Reveal>
              <MonoLabel>The other blocks</MonoLabel>
            </Reveal>
            <div className="mt-8 grid gap-px sm:grid-cols-2 lg:grid-cols-5" style={{ background: RULE }}>
              {others.map((o, i) => (
                <Reveal key={o.slug} delay={i * 70} className="h-full">
                  <Link
                    to={`/solutions/${o.slug}`}
                    className="group flex h-full flex-col bg-white p-6 transition-colors duration-300 hover:bg-[#FAFAFA]"
                  >
                    <span className="flex items-center gap-2.5">
                      <span aria-hidden className="h-[7px] w-[7px] shrink-0" style={{ background: o.key }} />
                      <span className="font-mono text-[11px] tabular-nums" style={{ color: GREY }}>
                        {o.num}
                      </span>
                    </span>
                    <span
                      className="mt-4 flex-1 text-[16px] font-normal leading-[1.25] tracking-[-0.02em]"
                      style={{ color: INK }}
                    >
                      {o.nav}
                    </span>
                    <span className="mt-2 text-[13px] leading-[1.5]" style={{ color: GREY }}>
                      {o.menu.blurb}
                    </span>
                    <ArrowUpRight
                      className="mt-5 h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                      style={{ color: PAPER_ACCENT }}
                    />
                  </Link>
                </Reveal>
              ))}
            </div>
          </div>
        </ToneSection>

        <LandingClose />

        <ToneSection tone="ink">
          <LandingFooter band="transparent" />
        </ToneSection>
      </ToneCanvas>
    </div>
  );
}
