import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowRight, ArrowUpRight, Check } from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { ClosingCta, PageHero, useLandingSkin } from "./PageHero";
import { CtaGhost, CtaPill, CtaPrimary, Eyebrow, Reveal } from "./LandingKit";
import {
  AdoptionGrid,
  FoundationFlow,
  GovernanceCloud,
  ManagedRun,
  ReadinessScan,
  SecuredAgents,
} from "./LandingVisuals";
import { SOLUTIONS } from "./solutions";

/* ===================== Solutions =====================
   Six offers, six DIFFERENT shapes. An earlier cut ran them through one
   template, alternating the diagram left and right, and six identical rows read
   as one row printed six times: by the third the eye stops reading and starts
   scrolling.

   So each block is sized to its own weight instead. The assessment is the way
   in, so it gets a full dark band. Agents and foundation are a natural pair, so
   they share one row as two compact cards. Adoption's whole argument is a
   single number, so it is a number. Governance is a list of controls, so it is
   a list. The retainer is three people, so it is three columns of a panel.
   Nothing here is a card grid, and no two blocks repeat a layout. */

/* Only the rail needs the set as data, and it takes it from solutions.ts so the
   rail cannot fall out of step with the blocks' own numbering. Every section
   below is still written out, on purpose: the moment they share a renderer they
   start looking alike again. */
const SECTIONS = SOLUTIONS.map((s) => ({ id: s.slug, nav: s.nav }));

/* The maturity ladder, drawn rather than described. The bar is the level, and
   the last two rungs are the only ones an agent can stand on. */
const LADDER = [
  { level: "L1", label: "Ad hoc", note: "Nobody wrote it down.", ready: false },
  { level: "L2", label: "Repeatable", note: "One person knows how.", ready: false },
  { level: "L3", label: "Defined", note: "It exists on paper.", ready: false },
  { level: "L4", label: "Measured", note: "You have numbers on it.", ready: true },
  { level: "L5", label: "Ready", note: "An agent can run it today.", ready: true },
];

const GOVERNANCE_CONTROLS = [
  "A live registry of every agent, its owner and its data scope",
  "Risk class per system, with the reasoning recorded beside it",
  "Approval gates wired to real runs, not to a policy document",
  "Incident handling with a named owner and a response clock",
  "Audit exports aligned with what the EU AI Act asks a deployer for",
  "Environments separated so an experiment cannot reach production data",
];

const RETAINER = [
  {
    role: "Architect",
    body: "Owns the shape of the platform, the integration surface and the security posture as both move.",
  },
  {
    role: "Functional consultant",
    body: "Keeps the agents pointed at work that matters, and translates between the teams and the runtime.",
  },
  {
    role: "Developer",
    body: "Ships the changes, tunes the models and costs, and fixes the thing that broke on Thursday.",
  },
];

const METHOD = [
  { step: "01", title: "Assess", body: "Two to three weeks on processes, data and exposure. A scored roadmap before anyone writes code." },
  { step: "02", title: "Build", body: "Foundation first, then the first agents, inside your tenant and against scoped grants." },
  { step: "03", title: "Govern", body: "Registry, policies and audit trail switched on with agent one, never retrofitted." },
  { step: "04", title: "Run", body: "Adoption measured per team, and a retainer that keeps the platform current." },
];

const OUTCOMES = [
  { figure: "4–8", unit: "wks", label: "to the first secured milestone" },
  { figure: "98", unit: "%", label: "of writes behind an approval gate" },
  { figure: "57", unit: "", label: "systems connected, zero migrations" },
  { figure: "100", unit: "%", label: "of the resulting IP stays yours" },
];

/* ── Anchor rail ────────────────────────────────────────────────────────────
   Sticky under the nav, tracking the section in view rather than the URL hash,
   so scrolling by hand keeps it honest. */
function AnchorRail() {
  const [active, setActive] = useState(SECTIONS[0].id);

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
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    });
    return () => io.disconnect();
  }, []);

  return (
    /* Transparent and click-through so it never covers the bands it floats
       over; only the pill itself takes pointer events. */
    <div className="pointer-events-none sticky top-[86px] z-30 hidden justify-center py-4 lg:flex">
      <nav className="pointer-events-auto flex items-center gap-1 rounded-full border border-black/[0.07] bg-white/85 p-1.5 shadow-[0_14px_34px_-18px_rgba(0,0,7,0.35)] backdrop-blur-xl">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className={
              "rounded-full px-4 py-2 text-[13.5px] transition-colors " +
              (active === s.id
                ? "bg-[#2b2b2b] text-white"
                : "text-black/60 hover:bg-black/[0.05] hover:text-black")
            }
          >
            {s.nav}
          </a>
        ))}
      </nav>
    </div>
  );
}

/* Every block here is a tease; the page behind it carries the problem, the
   method, the deliverables and the objections. This link is the whole reason
   the blocks below can stay short. */
function ReadMore({ to, label, onDark = false }: { to: string; label: string; onDark?: boolean }) {
  return (
    <Link
      to={to}
      className={`group mt-8 inline-flex items-center gap-2 text-[15px] font-medium underline-offset-4 hover:underline ${
        onDark ? "text-white" : "text-[#000007]"
      }`}
    >
      {label}
      <ArrowUpRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
    </Link>
  );
}

/** The one thing every block does share: a number and a label, small, up top. */
function Kicker({ num, label, onDark = false }: { num: string; label: string; onDark?: boolean }) {
  return (
    <div className="flex items-center gap-4">
      <span className="text-[13px] font-medium tabular-nums text-[var(--amp-orange)]">{num}</span>
      <span className={`h-px w-10 ${onDark ? "bg-white/20" : "bg-black/15"}`} />
      <span
        className={`text-[12px] uppercase tracking-[0.14em] ${onDark ? "text-white/45" : "text-black/40"}`}
      >
        {label}
      </span>
    </div>
  );
}

export function SolutionsPage() {
  useLandingSkin();
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
    /* No overflow clamp on the root, unlike the home page: `overflow-x: hidden`
       turns this div into a scroll container, and a scroll container that never
       scrolls kills every sticky descendant under it, the anchor rail included.
       Every section that bleeds a wash already clips itself. */
    <div className="amplify amp-light min-h-screen bg-white">
      <LandingNav />

      <PageHero
        eyebrow="Our Solutions"
        title="How we help you adopt AI, safely"
        lead="Six building blocks, in the order they actually need to happen. Most companies need three of them, and almost nobody needs all six at once."
        hue="teal"
        frame={1420}
        padBottom={70}
      >
        <div
          className="amp-in mt-10 flex flex-col items-center justify-center gap-3.5 sm:flex-row"
          style={{ animationDelay: "260ms" }}
        >
          <Link to="/contact">
            <CtaPill>Book a Consultation</CtaPill>
          </Link>
          <a
            href="#readiness"
            className="text-[15px] text-black/55 underline-offset-4 transition-colors hover:text-black hover:underline"
          >
            Start with the assessment
          </a>
        </div>
      </PageHero>

      <AnchorRail />

      {/* ══ 01 — the way in, so it gets the whole band ═══════════════════════ */}
      <section id="readiness" className="relative scroll-mt-[150px] bg-[#000007]">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative py-24 sm:py-28">
            <div className="grid gap-14 lg:grid-cols-[0.95fr_1.05fr] lg:gap-20">
              <Reveal>
                <Kicker num="01" label="Readiness" onDark />
                <h2 className="mt-7 max-w-md text-balance text-[34px] font-semibold leading-[1.06] tracking-[-0.028em] sm:text-[46px]">
                  Before we build anything, we look at where you are
                </h2>
                <p className="mt-6 max-w-lg text-[16.5px] leading-[1.65] text-[var(--amp-muted)]">
                  We rate every process from L1 to L5 and tell you which work is ready for an agent
                  today, which needs a foundation first, and which should wait. You leave with a
                  prioritised roadmap tied to your own processes, not a generic AI strategy deck.
                  Most teams find two or three quick wins and one structural gap they did not know
                  about.
                </p>
                <div className="mt-9 flex flex-wrap gap-x-10 gap-y-4 text-[14.5px]">
                  <span className="text-[var(--amp-muted)]">
                    Duration <span className="ml-2 font-medium text-white">2 to 3 weeks</span>
                  </span>
                  <span className="text-[var(--amp-muted)]">
                    Output <span className="ml-2 font-medium text-white">A scored roadmap</span>
                  </span>
                </div>
                <ReadMore to="/solutions/readiness" label="How the assessment runs" onDark />
              </Reveal>

              <Reveal delay={120}>
                {/* The ladder is the deliverable, so it is drawn rather than
                    described. The bar width is the level; the last two rungs are
                    the only ones an agent can stand on. */}
                <div className="amp-panel rounded-2xl p-7 sm:p-9">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-white/35">
                    Maturity, per process
                  </div>
                  <div className="mt-7 space-y-5">
                    {LADDER.map((r, i) => (
                      <div key={r.level} className="flex items-center gap-4">
                        <span className="w-6 shrink-0 text-[12px] font-medium tabular-nums text-white/45">
                          {r.level}
                        </span>
                        <span
                          className={`w-[86px] shrink-0 text-[13px] ${
                            r.ready ? "font-medium text-white" : "text-white/55"
                          }`}
                        >
                          {r.label}
                        </span>
                        {/* The bar carries the level on its own; the label sits
                            outside it so a short bar never clips its own text. */}
                        <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                          <span
                            className="block h-full rounded-full"
                            style={{
                              width: `${28 + i * 18}%`,
                              background: r.ready ? "#2A9C82" : "rgba(255,255,255,0.22)",
                            }}
                          />
                        </span>
                        <span className="hidden w-[152px] shrink-0 text-[12.5px] leading-snug text-white/40 lg:block">
                          {r.note}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="amp-viz amp-viz-grey mt-8 border-t border-white/[0.08] pt-8">
                    <ReadinessScan />
                  </div>
                </div>
              </Reveal>
            </div>
          </div>
        </div>
      </section>

      {/* ══ 02 + 03 — a natural pair, so one row of two compact cards ════════ */}
      <section className="amp-light relative bg-white">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative grid gap-6 py-24 sm:py-28 lg:grid-cols-2">
            <Reveal>
              <article
                id="agents"
                className="amp-lift flex h-full scroll-mt-[150px] flex-col rounded-[24px] bg-[#f7f7f7] p-8 sm:p-10"
              >
                <Kicker num="02" label="Secured Agents" />
                <h2 className="mt-6 text-balance text-[27px] font-semibold leading-[1.12] tracking-[-0.022em] sm:text-[31px]">
                  Your teams want agents. Your CISO wants to know where the data goes.
                </h2>
                <p className="mt-5 flex-1 text-[15.5px] leading-[1.65] text-[var(--amp-muted)]">
                  Both are right. We build agents that run inside your tenant, behind your identity
                  controls, on your data residency, so the answer to the security question is
                  documented rather than hoped for. Credentials are encrypted at rest, tool grants
                  are scoped per agent, every write is approval-gated, and every call lands in an
                  exportable audit log.
                </p>
                <ReadMore to="/solutions/agents" label="Encrypt, scope, gate, log" />
                <div className="amp-viz mt-9 overflow-hidden rounded-2xl bg-[#08080a] p-5">
                  <SecuredAgents />
                </div>
              </article>
            </Reveal>

            <Reveal delay={110}>
              <article
                id="foundation"
                className="amp-lift flex h-full scroll-mt-[150px] flex-col rounded-[24px] bg-[#f7f7f7] p-8 sm:p-10"
              >
                <Kicker num="03" label="Foundation" />
                <h2 className="mt-6 text-balance text-[27px] font-semibold leading-[1.12] tracking-[-0.022em] sm:text-[31px]">
                  An assistant on top of a broken process gives you faster chaos.
                </h2>
                <p className="mt-5 flex-1 text-[15.5px] leading-[1.65] text-[var(--amp-muted)]">
                  Before intelligence can amplify anything, the work underneath has to be
                  structured: approvals that follow rules, documents that live in one place, data
                  that means the same thing in every system. We rebuild that layer across the
                  systems you already run, 57 integrations deep, with no platform migration.
                </p>
                <ReadMore to="/solutions/foundation" label="What we rebuild underneath" />
                <div className="amp-viz amp-viz-ember mt-9 overflow-hidden rounded-2xl bg-[#08080a] p-5">
                  <FoundationFlow />
                </div>
              </article>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ══ A line on its own, to break the rhythm before block four ═════════ */}
      <section className="amp-light relative bg-white">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative border-y border-black/[0.07] py-20 sm:py-24">
            <Reveal>
              <p className="mx-auto max-w-3xl text-balance text-center text-[26px] font-medium leading-[1.35] tracking-[-0.02em] text-[#0d0d0d] sm:text-[34px]">
                “Every programme we rescued had the same thing in common. The technology worked. The
                organisation around it had not changed at all.”
              </p>
              <p className="mt-7 text-center text-[13.5px] text-black/40">
                Léa Verrier, Adoption Lead
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ══ 04 — the argument is one number, so it is one number ═════════════ */}
      <section
        id="adoption"
        className="amp-light relative scroll-mt-[150px]"
        style={{ background: "#f7f7f7" }}
      >
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative py-24 sm:py-28">
            <div className="grid items-center gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
              <Reveal>
                <Kicker num="04" label="Adoption" />
                <div className="mt-8 text-[104px] font-medium leading-[0.85] tracking-[-0.05em] tabular-nums text-[#0d0d0d] sm:text-[140px]">
                  8<span className="text-[var(--amp-orange)]">%</span>
                </div>
                {/* The bar is the point: eight percent looks small only when you
                    can see the ninety-two you paid for. */}
                <div className="mt-8 h-2.5 w-full max-w-xs overflow-hidden rounded-full bg-black/[0.08]">
                  <div className="h-full w-[8%] rounded-full bg-[var(--amp-orange)]" />
                </div>
                <p className="mt-5 max-w-xs text-[14.5px] leading-[1.55] text-black/50">
                  The median assistant usage rate we measure, across licensed seats.
                </p>
              </Reveal>

              <Reveal delay={120}>
                <h2 className="max-w-lg text-balance text-[32px] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-[42px]">
                  A licence paid for twelve months and used for one
                </h2>
                <p className="mt-6 max-w-lg text-[16.5px] leading-[1.65] text-[var(--amp-muted)]">
                  The technology was never the hard part. Changing how a few hundred people work is,
                  and that does not happen in a training session. We design adoption as a journey:
                  champions inside each team, use cases people actually recognise, and measurement
                  that tells you whether the investment is landing.
                </p>
                <ReadMore to="/solutions/adoption" label="How we move the number" />
                <div className="amp-viz amp-viz-deep mt-10 overflow-hidden rounded-2xl bg-white p-6">
                  <AdoptionGrid />
                </div>
              </Reveal>
            </div>
          </div>
        </div>
      </section>

      {/* ══ 05 — a set of controls, so it reads as a set of controls ═════════ */}
      <section id="governance" className="relative scroll-mt-[150px] bg-[#000007]">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative py-24 sm:py-28">
            <div className="grid gap-14 lg:grid-cols-[1.15fr_0.85fr] lg:gap-20">
              <Reveal>
                <Kicker num="05" label="Governance" onDark />
                <h2 className="mt-7 max-w-lg text-balance text-[34px] font-semibold leading-[1.06] tracking-[-0.028em] sm:text-[44px]">
                  Somebody is building an AI flow you do not know about
                </h2>
                <p className="mt-6 max-w-lg text-[16.5px] leading-[1.65] text-[var(--amp-muted)]">
                  Governance is not about stopping them. It is about knowing who builds, what data
                  they touch and where it runs, so innovation happens inside guardrails instead of
                  arriving as a surprise during an audit.
                </p>

                <div className="mt-10 grid gap-x-8 gap-y-4 sm:grid-cols-2">
                  {GOVERNANCE_CONTROLS.map((c) => (
                    <div key={c} className="flex gap-3">
                      <Check className="mt-[3px] h-4 w-4 shrink-0 text-[var(--amp-orange)]" />
                      <span className="text-[14.5px] leading-[1.5] text-white/75">{c}</span>
                    </div>
                  ))}
                </div>
                <ReadMore to="/solutions/governance" label="The controls in detail" onDark />
              </Reveal>

              <Reveal delay={120}>
                <div className="amp-viz amp-panel overflow-hidden rounded-2xl p-6">
                  <GovernanceCloud />
                </div>
              </Reveal>
            </div>
          </div>
        </div>
      </section>

      {/* ══ 06 — three people, so three columns of one panel ═════════════════ */}
      <section id="managed" className="amp-light relative scroll-mt-[150px] bg-white">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative py-24 sm:py-28">
            <Reveal className="max-w-2xl">
              <Kicker num="06" label="Managed Run" />
              <h2 className="mt-7 text-balance text-[32px] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-[42px]">
                The go-live is not the finish line. It is the starting gun.
              </h2>
              <p className="mt-6 text-[16.5px] leading-[1.65] text-[var(--amp-muted)]">
                Models update, agents drift, regulations tighten and new capabilities ship every
                month. The retainer is three named people who already know your environment, so you
                are not rebuilding context every quarter.
              </p>
              <ReadMore to="/solutions/managed" label="What the retainer covers" />
            </Reveal>

            <Reveal delay={110}>
              {/* Divided panel rather than three cards: they are one team, and
                  three separate cards would say they are three services. */}
              <div className="mt-12 overflow-hidden rounded-[24px] bg-[#f7f7f7]">
                <div className="grid divide-y divide-black/[0.07] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                  {RETAINER.map((r) => (
                    <div key={r.role} className="p-8 sm:p-9">
                      <div className="text-[17px] font-semibold text-[#000007]">{r.role}</div>
                      <p className="mt-3 text-[14.5px] leading-[1.6] text-[var(--amp-muted)]">
                        {r.body}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-t border-black/[0.07] bg-white px-8 py-6 text-[13.5px] text-black/50 sm:px-9">
                  <span>Monthly retainer</span>
                  <span className="hidden h-1 w-1 rounded-full bg-black/20 sm:block" />
                  <span>Quarterly roadmap review</span>
                  <span className="hidden h-1 w-1 rounded-full bg-black/20 sm:block" />
                  <span>Priority SLA</span>
                  <span className="hidden h-1 w-1 rounded-full bg-black/20 sm:block" />
                  <span>Drift monitoring on every agent in production</span>
                </div>
              </div>
            </Reveal>

            <Reveal delay={160}>
              <div className="amp-viz amp-viz-grey mt-6 overflow-hidden rounded-[24px] bg-[#08080a] p-8">
                <ManagedRun />
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ══ Method and outcomes, one band ════════════════════════════════════
          A timeline, not four boxes: the whole claim is that the phases happen
          in this order, and four boxes say nothing about order. */}
      <section className="relative bg-[#000007]">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative py-24 sm:py-28">
            <Reveal className="max-w-2xl">
              <Eyebrow>How We Work</Eyebrow>
              <h2 className="mt-7 text-balance text-[32px] font-semibold leading-[1.06] tracking-[-0.028em] sm:text-[44px]">
                Four phases, and the order is the point
              </h2>
              <p className="mt-6 text-[16.5px] leading-[1.6] text-[var(--amp-muted)]">
                Skipping one is what turns an AI programme into a pilot that never leaves the lab.
              </p>
            </Reveal>

            <div className="relative mt-16">
              {/* The line that makes it a sequence. It fades out rather than
                  stopping at a computed offset, which would need the column
                  width and the gap to stay in sync with the grid forever. */}
              <div
                aria-hidden
                className="absolute inset-x-0 top-[7px] hidden h-px bg-gradient-to-r from-white/20 via-white/15 to-transparent lg:block"
              />
              <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
                {METHOD.map((m, i) => (
                  <Reveal key={m.step} delay={i * 100}>
                    <div className="relative">
                      <span
                        className="block h-[15px] w-[15px] rounded-full border-[3px] border-[#000007]"
                        style={{ background: i === 0 ? "#2A9C82" : "rgba(255,255,255,0.28)" }}
                      />
                      <div className="mt-6 text-[12px] font-medium tabular-nums text-white/35">
                        {m.step}
                      </div>
                      <h3 className="mt-2 text-[21px] font-semibold tracking-[-0.015em]">
                        {m.title}
                      </h3>
                      <p className="mt-3 max-w-[15rem] text-[14.5px] leading-[1.6] text-[var(--amp-muted)]">
                        {m.body}
                      </p>
                    </div>
                  </Reveal>
                ))}
              </div>
            </div>

            {/* The figures as a strip, not as cards: the home page already has
                four stat cards, and repeating them here would echo it. */}
            <Reveal delay={120}>
              <div className="mt-20 grid divide-y divide-white/[0.08] border-t border-white/[0.08] sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
                {OUTCOMES.map((o) => (
                  <div key={o.label} className="px-0 py-8 lg:px-8 lg:first:pl-0">
                    <div className="text-[38px] font-medium leading-none tracking-[-0.025em] tabular-nums">
                      {o.figure}
                      <span className="text-[var(--amp-orange)]">{o.unit}</span>
                    </div>
                    <div className="mt-4 text-[14px] leading-[1.5] text-[var(--amp-muted)]">
                      {o.label}
                    </div>
                  </div>
                ))}
              </div>
            </Reveal>

            <Reveal delay={160}>
              <Link
                to="/faq"
                className="mt-12 inline-flex items-center gap-2 text-[15px] font-medium text-white underline-offset-4 hover:underline"
              >
                Read the common questions
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Reveal>
          </div>
        </div>
      </section>

      <ClosingCta
        hue="teal"
        title="Not sure which block you need first?"
        lead="That is what the assessment is for. Thirty minutes on a call is usually enough to tell you whether you need a foundation, a governance layer, or your first agent."
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
