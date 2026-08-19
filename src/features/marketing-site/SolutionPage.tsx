import { useEffect } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, Check, Minus, Plus } from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { ClosingCta, HeroField, frameFromSeed, tintFromKey, useLandingSkin } from "./PageHero";
import { CtaGhost, CtaPill, CtaPrimary, Reveal } from "./LandingKit";
import { HERO_BG } from "./LandingHero";
import { SOLUTIONS, getSolution } from "./solutions";

/* ===================== One solution =====================
   The six detail pages share this template on purpose. That is not the
   repetition the index had to be rescued from: those were six identical rows
   stacked in one scroll, where the eye sees the pattern and stops reading.
   These are siblings a reader compares one against another and never sees two
   of at once, so a stable shape is what makes them comparable.

   The variation lives in the data: an offer renders a proof figure only if it
   has one worth showing, and the diagram plate is re-tinted per solution so six
   pages never open on the same picture in the same colour. */

export function SolutionPage() {
  useLandingSkin();
  const { slug } = useParams();
  const solution = getSolution(slug);

  // Router keeps scroll position across routes, so moving between two solutions
  // would otherwise drop you halfway down a page you have not read.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [slug]);

  if (!solution) return <Navigate to="/solutions" replace />;

  const tint = tintFromKey(solution.key);
  const Visual = solution.visual;
  const others = SOLUTIONS.filter((s) => s.slug !== solution.slug);

  return (
    <div className="amplify amp-light min-h-screen overflow-x-hidden bg-white">
      <LandingNav />

      {/* ══ Hero: the offer, its numbers and its diagram, all above the fold ══
          Two columns rather than PageHero's centred variant, because a detail
          page has to carry the meta chips and the picture at the same time. */}
      <header className="relative overflow-hidden pt-[104px]" style={{ background: HERO_BG }}>
        <HeroField hue={tint} frame={frameFromSeed(solution.slug)} />

        <div className="relative mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="grid items-center gap-12 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:py-20">
            <div>
              <Link
                to="/solutions"
                className="inline-flex items-center gap-2 text-[14px] text-black/50 transition-colors hover:text-black"
              >
                <ArrowLeft className="h-4 w-4" />
                All solutions
              </Link>

              <div className="mt-8 flex items-center gap-4">
                <span
                  className="text-[13px] font-medium tabular-nums"
                  style={{ color: solution.key }}
                >
                  {solution.num}
                </span>
                <span className="h-px w-10 bg-black/15" />
                <span className="text-[12px] uppercase tracking-[0.14em] text-black/40">
                  {solution.nav}
                </span>
              </div>

              <h1 className="mt-6 text-balance text-[36px] font-semibold leading-[1.06] tracking-[-0.03em] text-[#000007] sm:text-[50px]">
                {solution.title}
              </h1>
              <p className="mt-6 max-w-xl text-[17.5px] leading-[1.6] text-black/60">
                {solution.lead}
              </p>

              <div className="mt-9 flex flex-wrap gap-x-10 gap-y-4">
                {solution.meta.map((m) => (
                  <div key={m.label}>
                    <div className="text-[11px] uppercase tracking-[0.1em] text-black/40">
                      {m.label}
                    </div>
                    <div className="mt-1 text-[15px] font-medium text-[#000007]">{m.value}</div>
                  </div>
                ))}
              </div>

              <div className="mt-10">
                <Link to="/contact">
                  <CtaPill>Book a Consultation</CtaPill>
                </Link>
              </div>
            </div>

            <div className={`amp-viz ${solution.viz} overflow-hidden rounded-[24px] bg-[#08080a] p-7`}>
              <Visual />
            </div>
          </div>
        </div>
      </header>

      {/* ══ The problem, in the client's words before ours ═══════════════════ */}
      <section className="amp-light relative" style={{ background: "#f7f7f7" }}>
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative grid gap-12 py-20 sm:py-24 lg:grid-cols-[0.85fr_1.15fr] lg:gap-20">
            <Reveal>
              <div className="text-[13px] font-medium uppercase tracking-[0.14em] text-black/35">
                The problem
              </div>
              <h2 className="mt-6 text-balance text-[30px] font-semibold leading-[1.1] tracking-[-0.025em] sm:text-[36px]">
                {solution.problem.title}
              </h2>
            </Reveal>

            <Reveal delay={110}>
              <p className="text-[17px] leading-[1.7] text-[var(--amp-muted)]">
                {solution.problem.body}
              </p>
              <ul className="mt-9 space-y-4 border-t border-black/[0.08] pt-8">
                {solution.problem.points.map((p) => (
                  <li key={p} className="flex gap-4">
                    {/* A minus, not a check: these are the things that are wrong. */}
                    <Minus className="mt-[5px] h-4 w-4 shrink-0 text-black/25" />
                    <span className="text-[16px] leading-[1.6] text-black/70">{p}</span>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ══ The approach, as a numbered sequence ════════════════════════════ */}
      <section className="relative bg-[#000007]">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative py-24 sm:py-28">
            <Reveal className="max-w-2xl">
              <div
                className="text-[13px] font-medium uppercase tracking-[0.14em]"
                style={{ color: tint.shader[2] }}
              >
                How we do it
              </div>
              <h2 className="mt-6 text-balance text-[32px] font-semibold leading-[1.06] tracking-[-0.028em] sm:text-[42px]">
                {solution.approach.title}
              </h2>
              <p className="mt-6 text-[16.5px] leading-[1.65] text-[var(--amp-muted)]">
                {solution.approach.body}
              </p>
            </Reveal>

            <div className="mt-14 border-t border-white/[0.08]">
              {solution.approach.steps.map((s, i) => (
                <Reveal key={s.t} delay={i * 90}>
                  <div className="grid gap-3 border-b border-white/[0.08] py-8 sm:grid-cols-[64px_260px_1fr] sm:gap-8">
                    <span className="text-[13px] font-medium tabular-nums text-white/70">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <h3 className="text-[20px] font-semibold tracking-[-0.015em]">{s.t}</h3>
                    <p className="max-w-2xl text-[15.5px] leading-[1.65] text-[var(--amp-muted)]">
                      {s.b}
                    </p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ══ Deliverables, with the proof figure alongside when there is one ══ */}
      <section className="amp-light relative bg-white">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          {/* Governance and the retainer carry no headline figure — that is the
              data's decision, not an omission — so the band splits into two
              columns of deliverables rather than leaving the stat column empty. */}
          <div
            className={`amp-rails relative grid gap-12 py-20 sm:py-24 lg:gap-20 ${
              solution.proof ? "lg:grid-cols-[1.15fr_0.85fr]" : ""
            }`}
          >
            <Reveal>
              <div className="text-[13px] font-medium uppercase tracking-[0.14em] text-black/35">
                What you get
              </div>
              <h2 className="mt-6 max-w-lg text-balance text-[30px] font-semibold leading-[1.1] tracking-[-0.025em] sm:text-[36px]">
                Everything below is a deliverable, not an activity
              </h2>
              <ul
                className={`mt-9 grid gap-y-4 ${
                  solution.proof ? "" : "lg:grid-cols-2 lg:gap-x-14"
                }`}
              >
                {solution.deliverables.map((d) => (
                  <li key={d} className="flex items-start gap-3.5">
                    <span
                      className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                      style={{ background: solution.key }}
                    >
                      <Check className="h-3 w-3 text-white" />
                    </span>
                    <span className="text-[16px] leading-[1.55] text-[#0d0d0d]">{d}</span>
                  </li>
                ))}
              </ul>
            </Reveal>

            {solution.proof && (
              <Reveal delay={120}>
                <div className="rounded-[24px] bg-[#f7f7f7] px-9 py-10">
                  <div className="text-[64px] font-medium leading-[0.9] tracking-[-0.04em] tabular-nums text-[#0d0d0d] sm:text-[76px]">
                    {solution.proof.figure}
                    <span style={{ color: solution.key }}>{solution.proof.unit}</span>
                  </div>
                  <p className="mt-6 text-[15.5px] leading-[1.55] text-[var(--amp-muted)]">
                    {solution.proof.label}
                  </p>
                </div>
              </Reveal>
            )}
          </div>
        </div>
      </section>

      {/* ══ The objections this specific offer raises ════════════════════════ */}
      <section className="amp-light relative" style={{ background: "#f7f7f7" }}>
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative py-20 sm:py-24">
            <div className="mx-auto max-w-3xl">
              <h2 className="text-[24px] font-semibold tracking-[-0.02em] text-[#000007]">
                Questions people ask about this one
              </h2>
              <div className="mt-8 border-t border-black/[0.08]">
                {solution.faq.map((f) => (
                  <details key={f.q} className="group border-b border-black/[0.08] py-6">
                    <summary className="flex cursor-pointer list-none items-start justify-between gap-6 text-[17px] font-medium leading-snug tracking-[-0.01em] text-[#000007]">
                      {f.q}
                      <span className="mt-0.5 shrink-0 text-black/30 transition-colors group-hover:text-black/60">
                        <Plus className="h-[18px] w-[18px] group-open:hidden" />
                        <Minus className="hidden h-[18px] w-[18px] group-open:block" />
                      </span>
                    </summary>
                    <p className="mt-4 text-[15.5px] leading-[1.7] text-[var(--amp-muted)]">
                      {f.a}
                    </p>
                  </details>
                ))}
              </div>
              <Link
                to="/faq"
                className="mt-8 inline-flex items-center gap-2 text-[15px] font-medium text-[#000007] underline-offset-4 hover:underline"
              >
                All questions, across every solution
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ══ The other five, as a list rather than as five more cards ═════════ */}
      <section className="amp-light relative bg-white">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative py-20">
            <h2 className="text-[13px] font-medium uppercase tracking-[0.14em] text-black/35">
              The other five
            </h2>
            <div className="mt-8 border-t border-black/[0.08]">
              {others.map((o) => (
                <Link
                  key={o.slug}
                  to={`/solutions/${o.slug}`}
                  className="group grid items-baseline gap-x-6 gap-y-1 border-b border-black/[0.08] py-6 sm:grid-cols-[52px_1fr_auto]"
                >
                  <span className="text-[13px] font-medium tabular-nums text-black/30">
                    {o.num}
                  </span>
                  <span className="flex flex-wrap items-baseline gap-x-3">
                    <span
                      aria-hidden
                      className="h-[7px] w-[7px] shrink-0 translate-y-[-1px] rounded-full"
                      style={{ background: o.key }}
                    />
                    <span className="text-[19px] font-medium tracking-[-0.015em] text-[#000007]">
                      {o.title}
                    </span>
                  </span>
                  <ArrowUpRight className="h-4 w-4 text-black/25 transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-black" />
                </Link>
              ))}
            </div>
          </div>
        </div>
      </section>

      <ClosingCta
        hue={tint}
        title={`Talk to us about ${solution.nav.toLowerCase()}`}
        lead="Thirty minutes is usually enough to know whether this is the block you need first, and we will tell you if it is not."
        actions={
          <>
            <Link to="/contact">
              <CtaPrimary>Book a Consultation</CtaPrimary>
            </Link>
            <Link to="/pricing">
              <CtaGhost>See pricing</CtaGhost>
            </Link>
          </>
        }
      />

      <LandingFooter />
    </div>
  );
}
