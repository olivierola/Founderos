import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  ArrowRightIcon as ArrowRight,
  ArrowUpRightIcon as ArrowUpRight,
  CheckIcon as Check,
} from "@phosphor-icons/react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { LandingClose } from "./LandingClose";
import { CountUp, Pill, Reveal } from "./LandingKit";
import { PaperHero } from "./PaperHero";
import { CornerMarks, MonoLabel, PAPER_ACCENT, SectionTitle } from "./PaperKit";
import { ToneCanvas, ToneSection } from "./LandingTone";
import { SOLUTIONS, type Solution } from "./solutions";

/* ═══ Solutions ══════════════════════════════════════════════════════════════
   Rebuilt onto the home/pricing system: one tone canvas, the paper hero, the
   paper kit's marks and hairlines, and the one blue.

   The previous cut gave each of the six offers its own bespoke layout — a dark
   band here, a pair of cards there, a single giant number, a control list — on
   the theory that six identical blocks read as one block printed six times.
   That was a real risk and the wrong fix: six different layouts do not read as
   six offers, they read as six pages that happen to share a nav.

   The fix is one row template with variation inside it rather than around it.
   Every offer states the same four things in the same order — what it is, what
   it costs you in time, what lands, and the picture — and what changes between
   them is which side the picture sits on and which one is marked in the accent.
   That is how the pricing columns work, and it is why they are comparable.   */

const INK = "#111111";
const GREY = "#777777";
const RULE = "rgba(17,17,17,0.12)";

/* The maturity ladder, drawn rather than described. It belongs to the first
   offer only — it IS the assessment's deliverable, so it earns its place there
   and nowhere else. */
const LADDER = [
  { level: "L1", label: "Ad hoc", note: "Nobody wrote it down.", ready: false },
  { level: "L2", label: "Repeatable", note: "One person knows how.", ready: false },
  { level: "L3", label: "Defined", note: "It exists on paper.", ready: false },
  { level: "L4", label: "Measured", note: "You have numbers on it.", ready: true },
  { level: "L5", label: "Ready", note: "An agent can run it today.", ready: true },
];

const METHOD = [
  { step: "01", title: "Assess", body: "Two to three weeks on processes, data and exposure. A scored roadmap before anyone writes code." },
  { step: "02", title: "Build", body: "Foundation first, then the first agents, inside your tenant and against scoped grants." },
  { step: "03", title: "Govern", body: "Registry, policies and audit trail switched on with agent one, never retrofitted." },
  { step: "04", title: "Run", body: "Adoption measured per team, and a retainer that keeps the platform current." },
];

const OUTCOMES = [
  { to: 8, prefix: "4–", unit: "wks", label: "to the first secured milestone" },
  { to: 98, unit: "%", label: "of writes behind an approval gate" },
  { to: 57, unit: "", label: "systems connected, zero migrations" },
  { to: 100, unit: "%", label: "of the resulting IP stays yours" },
];

/* ── Anchor rail ────────────────────────────────────────────────────────────
   Sticky under the nav, tracking the section in view rather than the URL hash,
   so scrolling by hand keeps it honest. */
function AnchorRail() {
  const [active, setActive] = useState(SOLUTIONS[0].slug);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        // The topmost intersecting block wins. With tall blocks two can be in
        // view at once, and the last callback would otherwise decide.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: "-25% 0px -60% 0px" },
    );
    SOLUTIONS.forEach((s) => {
      const el = document.getElementById(s.slug);
      if (el) io.observe(el);
    });
    return () => io.disconnect();
  }, []);

  return (
    /* Transparent and click-through so it never covers the bands it floats
       over; only the rail itself takes pointer events. */
    <div className="pointer-events-none sticky top-[62px] z-30 hidden justify-center py-3 lg:flex">
      <nav
        className="pointer-events-auto flex items-center border bg-white/95 p-1.5 backdrop-blur-xl"
        style={{ borderColor: RULE }}
      >
        {SOLUTIONS.map((s) => (
          <a
            key={s.slug}
            href={`#${s.slug}`}
            className="px-4 py-2 text-[13.5px] transition-colors"
            style={active === s.slug ? { background: INK, color: "#FFFFFF" } : { color: GREY }}
          >
            {s.nav}
          </a>
        ))}
      </nav>
    </div>
  );
}

/* ── The readiness ladder ───────────────────────────────────────────────── */
function Ladder() {
  return (
    <div className="relative bg-white p-7" style={{ boxShadow: `inset 0 0 0 1px ${RULE}` }}>
      <CornerMarks />
      <MonoLabel>Maturity, per process</MonoLabel>
      <div className="mt-7 space-y-4">
        {LADDER.map((r, i) => (
          <div key={r.level} className="flex items-center gap-4">
            <span className="w-6 shrink-0 font-mono text-[11.5px] tabular-nums" style={{ color: GREY }}>
              {r.level}
            </span>
            <span className="w-[84px] shrink-0 text-[13px]" style={{ color: r.ready ? INK : GREY }}>
              {r.label}
            </span>
            {/* The bar carries the level on its own; the label sits outside it
                so a short bar never clips its own text. */}
            <span className="h-2 flex-1 overflow-hidden" style={{ background: "rgba(17,17,17,0.07)" }}>
              <span
                className="block h-full"
                style={{
                  width: `${28 + i * 18}%`,
                  background: r.ready ? PAPER_ACCENT : "rgba(17,17,17,0.20)",
                }}
              />
            </span>
            <span className="hidden w-[150px] shrink-0 text-[12.5px] leading-snug lg:block" style={{ color: GREY }}>
              {r.note}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── One offer ──────────────────────────────────────────────────────────────
   The same four statements every time, in the same order. `flip` moves the
   picture to the other side so six rows do not read as a striped wall, and
   `marked` gives the first one the accent — it is the way in, and the only one
   being pointed at. */
function OfferRow({
  solution,
  flip,
  marked,
  extra,
}: {
  solution: Solution;
  flip: boolean;
  marked: boolean;
  extra?: ReactNode;
}) {
  const Visual = solution.visual;

  return (
    <div
      id={solution.slug}
      className="scroll-mt-[132px] border-t py-20 sm:py-24"
      style={{ borderColor: RULE }}
    >
      <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
        {/* ── The words ─────────────────────────────────────────────────── */}
        <Reveal className={flip ? "lg:order-2" : undefined}>
          <div className="flex items-center gap-3">
            <span
              className="flex h-[34px] w-[34px] items-center justify-center text-[12.5px] font-medium tabular-nums"
              style={
                marked
                  ? { background: PAPER_ACCENT, color: "#FFFFFF" }
                  : { color: GREY, boxShadow: `inset 0 0 0 1px ${RULE}` }
              }
            >
              {solution.num}
            </span>
            <MonoLabel>{solution.nav}</MonoLabel>
          </div>

          <h2
            className="mt-7 max-w-[19ch] text-balance text-[30px] font-normal leading-[1.08] tracking-[-0.035em] sm:text-[40px]"
            style={{ color: INK }}
          >
            {solution.menu.label}
          </h2>
          <p className="mt-5 max-w-xl text-[15.5px] leading-[1.65]" style={{ color: GREY }}>
            {solution.lead}
          </p>

          {/* What it costs you, in time and commitment. */}
          <dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4 border-t pt-6" style={{ borderColor: RULE }}>
            {solution.meta.map((m) => (
              <div key={m.label}>
                <dt className="font-mono text-[10.5px] uppercase tracking-[0.1em]" style={{ color: GREY }}>
                  {m.label}
                </dt>
                <dd className="mt-1.5 text-[15px]" style={{ color: INK }}>
                  {m.value}
                </dd>
              </div>
            ))}
          </dl>

          {/* What actually lands. Three of them: the page is an index, and the
              detail page is one click away for the rest. */}
          <ul className="mt-7 space-y-2.5">
            {solution.deliverables.slice(0, 3).map((d) => (
              <li key={d} className="flex gap-2.5">
                <Check
                  className="mt-[3px] h-3.5 w-3.5 shrink-0" weight="bold"
                  style={{ color: marked ? PAPER_ACCENT : "#B4B4B4" }} />
                <span className="text-[14px] leading-[1.5]" style={{ color: INK }}>
                  {d}
                </span>
              </li>
            ))}
          </ul>

          <Link
            to={`/solutions/${solution.slug}`}
            className="group mt-9 inline-flex items-center gap-2 text-[15px]"
            style={{ color: PAPER_ACCENT }}
          >
            <span className="underline decoration-transparent underline-offset-4 transition-colors group-hover:decoration-current">
              Read the detail
            </span>
            <ArrowUpRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </Link>
        </Reveal>

        {/* ── The picture ───────────────────────────────────────────────── */}
        <Reveal delay={110} className={flip ? "lg:order-1" : undefined}>
          <div className="space-y-5">
            {extra}
            {/* The diagrams are drawn for a dark ground, so they keep one. A
                dark plate on paper is the same device the home page uses for
                its product shots. */}
            <div className={`amp-viz ${solution.viz} overflow-hidden bg-[#08080a] p-6 sm:p-7`}>
              <Visual />
            </div>
          </div>
        </Reveal>
      </div>
    </div>
  );
}

export function SolutionsPage() {
  useEffect(() => {
    document.documentElement.classList.add("mkt-no-scrollbar", "amp-root");
    return () => document.documentElement.classList.remove("mkt-no-scrollbar", "amp-root");
  }, []);

  const { hash } = useLocation();

  /* A browser only honours the fragment on a real document load, and arriving
     from the nav dropdown is a client-side navigation, so the jump is ours to
     make. Re-running on hash change is what makes the dropdown work when you
     are already on this page. */
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash]);

  return (
    <div className="amplify min-h-screen text-white" style={{ backgroundColor: "transparent" }}>
      <LandingNav />

      <ToneCanvas initial="paper">
        <ToneSection tone="paper">
          <PaperHero
            label="Our solutions"
            frame={["Six building blocks for"]}
            claim="adopting AI safely"
            lead="In the order they actually need to happen. Most companies need three of them, and almost nobody needs all six at once."
          >
            <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to="/contact">
                <Pill variant="solid" className="px-7 py-3.5 text-[14.5px]">
                  Book a consultation
                </Pill>
              </Link>
              <a
                href="#readiness"
                className="text-[15px] underline underline-offset-4 decoration-transparent transition-colors hover:decoration-current"
                style={{ color: PAPER_ACCENT }}
              >
                Start with the assessment
              </a>
            </div>
          </PaperHero>
        </ToneSection>

        <AnchorRail />

        {/* ══ The six, one template ═══════════════════════════════════════ */}
        <ToneSection tone="paper">
          <div className="mx-auto max-w-[1420px] px-5 sm:px-9" style={{ color: INK }}>
            {SOLUTIONS.map((s, i) => (
              <OfferRow
                key={s.slug}
                solution={s}
                flip={i % 2 === 1}
                marked={i === 0}
                extra={i === 0 ? <Ladder /> : undefined}
              />
            ))}
          </div>
        </ToneSection>

        {/* ══ Method and outcomes ═════════════════════════════════════════
            A timeline, not four boxes: the whole claim is that the phases
            happen in this order, and four boxes say nothing about order. */}
        <ToneSection tone="bone">
          <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28" style={{ color: INK }}>
            <Reveal>
              <SectionTitle frame="Four phases," claim="and the order is the point" />
              <p className="mt-6 max-w-xl text-[15.5px] leading-[1.6]" style={{ color: GREY }}>
                Skipping one is what turns an AI programme into a pilot that never leaves the lab.
              </p>
            </Reveal>

            <div className="relative mt-16">
              {/* The line that makes it a sequence. It fades out rather than
                  stopping at a computed offset, which would need the column
                  width and the gap to stay in sync with the grid forever. */}
              <div
                aria-hidden
                className="absolute inset-x-0 top-[7px] hidden h-px lg:block"
                style={{
                  background:
                    "linear-gradient(90deg, rgba(17,17,17,0.22), rgba(17,17,17,0.12) 60%, transparent)",
                }}
              />
              <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
                {METHOD.map((m, i) => (
                  <Reveal key={m.step} delay={i * 100}>
                    <div className="relative">
                      <span
                        className="block h-[15px] w-[15px] border-[3px]"
                        style={{
                          borderColor: "#F5F5F5",
                          background: i === 0 ? PAPER_ACCENT : "rgba(17,17,17,0.26)",
                        }}
                      />
                      <div className="mt-6 font-mono text-[11px] tabular-nums" style={{ color: GREY }}>
                        {m.step}
                      </div>
                      <h3
                        className="mt-2 text-[21px] font-normal tracking-[-0.025em]"
                        style={{ color: INK }}
                      >
                        {m.title}
                      </h3>
                      <p className="mt-3 max-w-[15rem] text-[14.5px] leading-[1.6]" style={{ color: GREY }}>
                        {m.body}
                      </p>
                    </div>
                  </Reveal>
                ))}
              </div>
            </div>

            {/* The figures as a strip on hairlines, the same construction the
                pricing table uses — not four more cards. */}
            <Reveal delay={120}>
              <div
                className="mt-20 grid border-t sm:grid-cols-2 lg:grid-cols-4"
                style={{ borderColor: RULE }}
              >
                {OUTCOMES.map((o, i) => (
                  <div
                    key={o.label}
                    className="border-b py-8 lg:border-b-0 lg:border-l lg:px-8 lg:first:border-l-0 lg:first:pl-0"
                    style={{ borderColor: RULE }}
                  >
                    <div
                      className="text-[38px] font-normal leading-none tracking-[-0.03em] tabular-nums"
                      style={{ color: INK }}
                    >
                      <CountUp to={o.to} prefix={o.prefix} />
                      <span style={{ color: i === 0 ? PAPER_ACCENT : GREY }}>{o.unit}</span>
                    </div>
                    <div className="mt-4 max-w-[20ch] text-[14px] leading-[1.5]" style={{ color: GREY }}>
                      {o.label}
                    </div>
                  </div>
                ))}
              </div>
            </Reveal>

            <Reveal delay={160}>
              <Link
                to="/faq"
                className="group mt-12 inline-flex items-center gap-2 text-[15px]"
                style={{ color: PAPER_ACCENT }}
              >
                <span className="underline decoration-transparent underline-offset-4 transition-colors group-hover:decoration-current">
                  Read the common questions
                </span>
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </Reveal>
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
