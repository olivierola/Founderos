import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Blocks, Compass, EyeOff, Layers, Minus, Plus, ShieldCheck, Sparkles } from "lucide-react";
import { BrandSplash } from "./BrandSplash";
import { LandingNav } from "./LandingNav";
import { LandingComparison } from "./LandingComparison";
import { LandingFooter } from "./LandingFooter";
import { LandingHero } from "./LandingHero";
import { LandingProof } from "./LandingProof";
import { LandingStats } from "./LandingStats";
import { LandingTestimonials } from "./LandingTestimonials";
import { CountUp, CtaGhost, CtaPrimary, Eyebrow, Reveal, SectionHead } from "./LandingKit";
import { ClosingCta } from "./PageHero";
import {
  NoFoundationArt,
  NoGovernanceArt,
  SecurityShield,
  ShadowAiArt,
} from "./LandingVisuals";
import { SOLUTIONS } from "./solutions";

/* Orange is the brand default; graphite and a warm ember break up the grid so
   six identical-looking diagrams stop reading as one block. */
const VIZ_HUES = ["", "amp-viz-grey", "amp-viz-ember"];
/* The light challenge band needs the deepened set — see globals.css. */
const VIZ_HUES_LIGHT = ["amp-viz-deep", "amp-viz-grey-deep", "amp-viz-ink"];

const STATS = [
  { prefix: "4–", to: 8, suffix: "", label: "Weeks to First-Value" },
  { prefix: "", to: 100, suffix: "%", label: "Organisation ownership of IP" },
];

const DIFFERENTIATORS = [
  {
    icon: Layers,
    title: "Foundation First",
    body: "AI amplifies what is underneath it. We make sure that is a clean process and a structured system, not chaos with an assistant on top.",
  },
  {
    icon: ShieldCheck,
    title: "Security By Design",
    body: "Encrypted credential vault, tenant-level isolation, scoped tool grants and approval gates applied from day one.",
  },
  {
    icon: Blocks,
    title: "Built On What You Have",
    body: "We layer agents onto your existing environment across 57 integrations. No platform migration, no rip-and-replace risk.",
  },
  {
    icon: Sparkles,
    title: "Proven In Production",
    body: "Agents running real support, finance, ops and engineering work — with humans kept on the decisions that matter.",
  },
];

const CHALLENGES = [
  {
    art: ShadowAiArt,
    icon: EyeOff,
    title: "Shadow AI Inside the Walls",
    body: "Your team members are pasting client data into public chatbots because the official path is too slow or does not exist. The risk is already inside.",
  },
  {
    art: NoFoundationArt,
    icon: Layers,
    title: "AI Without a Foundation",
    body: "An assistant on top of fragmented processes produces confident, low quality or even wrong outcomes. Without structured data and clear workflows, AI scales the problem.",
  },
  {
    art: NoGovernanceArt,
    icon: Compass,
    title: "No Clear Governance",
    body: "Who can build an agent? What data can it access? Where does it run? Which systems can it integrate with? Most organisations cannot answer these questions and that is where the audit findings start.",
  },
];

/* The home page pitches each offer at more length than the nav dropdown's one
   line, so the paragraph lives here — but the title, the diagram and the
   destination come from solutions.ts. The cards used to point at
   `/solutions#anchor`, which was correct while the six shared one scroll and
   has not been since each one got its own page. */
const HOME_PITCH: Record<string, string> = {
  readiness:
    "Before we build anything, we look at where you are. Our module-level maturity framework (L1 to L5) shows you which processes are ready for AI today, which need a foundation first, and which should wait. You get a clear, prioritised roadmap, not a generic AI strategy slide.",
  agents:
    "Your teams want agents that answer questions, draft documents, and handle requests. Your CISO wants to know where the data goes. Both are right. We build agents that run inside your tenant, behind your identity controls, on your data residency, so the answer to the security question is documented, not hoped for.",
  foundation:
    "An assistant on top of a broken process gives you faster chaos. Before intelligence can amplify anything, the work underneath has to be structured: approvals that follow rules, documents that live in one place, data that means the same thing in every system. We build that foundation so AI has something solid to stand on.",
  adoption:
    "The median assistant usage rate we see is eight percent. That is a licence paid for twelve months and used for one. The technology was never the hard part. The hard part is changing how a few hundred people work, and that does not happen in a training session. We design adoption as a journey with measurement that tells you whether the investment is landing.",
  governance:
    "Somewhere in your organisation right now, someone is building an AI flow you do not know about. Governance is not about stopping them. It is about knowing who builds, what data they touch, and where it runs, so innovation happens inside guardrails instead of arriving as a surprise. We set up the policies, environments and review workflows that make agents safe at scale.",
  managed:
    "The go-live is not the finish line. It is the starting gun. Models update, agents drift, regulations tighten, and new capabilities ship every month. Our retainer gives you an architect, a functional consultant, and a developer who already know your environment, keeping the platform healthy, the governance current, and the roadmap moving.",
};

const HOME_SOLUTIONS = SOLUTIONS.map((s) => ({
  visual: s.visual,
  title: s.title,
  body: HOME_PITCH[s.slug],
  to: `/solutions/${s.slug}`,
}));

const FAQ = [
  {
    q: "What does Anduran actually do?",
    a: "We help companies adopt AI safely. In practice, that means three things: we assess where your processes and data stand today, we build the secured foundation so AI has something solid to work on, and we guide adoption across your organisation with governance and change enablement.",
  },
  {
    q: "We are not sure we are ready for AI. Where do we start?",
    a: "With the readiness assessment. It rates every process from L1 to L5 and tells you which work is ready for an agent today, which needs a foundation first, and which should wait. Most teams find two or three quick wins and one structural gap they did not know about.",
  },
  {
    q: "How do you handle data security when deploying AI?",
    a: "Credentials are encrypted at rest with AES-GCM and never returned in plaintext to the browser. Every agent runs against scoped tool grants, write actions are approval-gated, and every call is recorded in an exportable audit log. We connect to your systems — we do not copy your data.",
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

export function HomePage() {
  useEffect(() => {
    document.documentElement.classList.add("mkt-no-scrollbar", "amp-root");
    return () => document.documentElement.classList.remove("mkt-no-scrollbar", "amp-root");
  }, []);

  return (
    <div className="amplify min-h-screen overflow-x-hidden">
      <BrandSplash />

      <LandingNav />

      {/* ══ 1. Hero — light canvas, inline photo chips, floating video ════ */}
      <LandingHero />

      {/* ══ 2. Proof — logo strip, one claim, four figures ════════════════ */}
      <LandingProof />

      {/* ══ 3. Why us — white ══════════════════════════════════════════════ */}
      <section className="amp-light relative">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative py-24 sm:py-28">
            <div className="grid items-start gap-12 lg:grid-cols-2 lg:gap-16">
              <Reveal>
                <Eyebrow>Why Us</Eyebrow>
                <h2 className="mt-6 max-w-md text-balance text-[36px] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-[46px]">
                  What Makes us Different
                </h2>
                <p className="mt-6 max-w-lg text-[17px] leading-[1.6] text-[var(--amp-muted)]">
                  Most consultancies are racing to put AI in front of clients. We start by asking whether your
                  organisation is ready for it and then we get you ready, properly. Our work sits at the
                  intersection of agent platforms, cloud security, and operational maturity, so AI lands on a
                  foundation that holds.
                </p>

                <div className="amp-plate mt-10 flex gap-14 rounded-lg px-9 py-8">
                  {STATS.map((s) => (
                    <div key={s.label}>
                      <CountUp
                        to={s.to}
                        prefix={s.prefix}
                        suffix={s.suffix}
                        className="block text-[42px] font-medium leading-none tracking-[-0.02em] tabular-nums"
                      />
                      <div className="mt-3 text-[15px] text-[var(--amp-muted)]">{s.label}</div>
                    </div>
                  ))}
                </div>
              </Reveal>

              <Reveal delay={140}>
                <div className="amp-viz overflow-hidden rounded-lg bg-black p-6">
                  <SecurityShield dense />
                </div>
              </Reveal>
            </div>

            <div className="mt-20 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
              {DIFFERENTIATORS.map((d, i) => {
                const Icon = d.icon;
                return (
                  <Reveal key={d.title} delay={i * 120}>
                    <div
                      className="flex h-14 w-14 items-center justify-center rounded-xl bg-white"
                      style={{ boxShadow: "0 2px 10px rgba(0,0,7,0.10)" }}
                    >
                      <Icon className="h-5 w-5" style={{ color: "var(--amp-orange)" }} />
                    </div>
                    <h3 className="mt-6 text-[19px] font-semibold tracking-[-0.01em]">{d.title}</h3>
                    <p className="mt-3 text-[15.5px] leading-[1.6] text-[var(--amp-muted)]">{d.body}</p>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ══ 3. Challenges — light grey ═════════════════════════════════════ */}
      <section className="amp-light relative" style={{ background: "#f7f7f7" }}>
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative py-24 sm:py-28">
            <SectionHead
              eyebrow="Your Challenges"
              title="The AI Question Every Company Is Asking"
              lead="Boards want AI adoption in the roadmap. Teams are already using it in one way or another. Security teams are highly concerned. Most companies are caught between moving too slow and moving without control."
              center
            />

            <div className="mt-16 grid gap-6 md:grid-cols-3">
              {CHALLENGES.map((c, i) => {
                const Art = c.art;
                return (
                  <Reveal key={c.title} delay={i * 110}>
                    <div className={`amp-card-light amp-lift amp-viz ${VIZ_HUES_LIGHT[i % VIZ_HUES_LIGHT.length]} h-full rounded-2xl p-4 hover:shadow-lg`}>
                      <div className="amp-zoom flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl bg-[#f2f2f2] p-6">
                        <Art />
                      </div>
                      <div className="px-3 pb-4 pt-7">
                        <h3 className="text-[21px] font-semibold tracking-[-0.01em]">{c.title}</h3>
                        <p className="mt-4 text-[15.5px] leading-[1.6] text-[var(--amp-muted)]">{c.body}</p>
                      </div>
                    </div>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ══ 4. Solutions — dark ════════════════════════════════════════════ */}
      <section className="relative">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative py-24 sm:py-28">
            <SectionHead
              eyebrow="Our Solutions"
              title="How We Help You Adopt AI, Safely"
              lead="We organise our work around the question every leader is asking: how do we get from where we are to AI-powered operations, without the wheels coming off? These are the building blocks."
              center
            />

            <div className="mt-16 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {HOME_SOLUTIONS.map((s, i) => {
                const Visual = s.visual;
                return (
                  <Reveal key={s.title} delay={i * 80}>
                    <div
                      className={`amp-panel amp-panel-hover amp-lift amp-zoom amp-viz ${VIZ_HUES[i % VIZ_HUES.length]} flex h-full flex-col rounded-2xl p-4`}
                    >
                      <Visual />
                      <div className="flex flex-1 flex-col px-2 pb-3 pt-7">
                        <h3 className="text-balance text-[21px] font-semibold leading-tight tracking-[-0.01em]">
                          {s.title}
                        </h3>
                        <p className="mt-4 text-[15px] leading-[1.6] text-[var(--amp-muted)]">{s.body}</p>
                        <Link
                          to={s.to}
                          className="mt-6 inline-block text-[15px] font-medium text-white underline-offset-4 hover:underline"
                        >
                          Learn More
                        </Link>
                      </div>
                    </div>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ══ 5. Testimonials — dark ═════════════════════════════════════════ */}
      <LandingTestimonials />

      {/* ══ 6. Comparison — criteria selector, light grey ═════════════════ */}
      <LandingComparison />

      {/* ══ 6. Results — dark, animated proof bars ═════════════════════════ */}
      <LandingStats />

      {/* ══ 7. FAQ — light grey ════════════════════════════════════════════ */}
      <section id="faq" className="amp-light relative" style={{ background: "#f7f7f7" }}>
        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <div className="amp-rails relative grid gap-12 py-24 sm:py-28 lg:grid-cols-2 lg:gap-16">
            <Reveal>
              <Eyebrow>FAQ</Eyebrow>
              <h2 className="mt-6 max-w-sm text-balance text-[36px] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-[46px]">
                Frequently Asked Questions
              </h2>
              <p className="mt-5 text-[17px] text-[var(--amp-muted)]">
                Everything you need to know about working with us.
              </p>
              <p className="mt-10 text-[17px] font-semibold">Still have questions? We're here to help.</p>
              <Link to="/contact" className="mt-5 inline-block">
                <CtaPrimary>Contact Us</CtaPrimary>
              </Link>
              {/* Five questions here, the full set on its own page. */}
              <Link
                to="/faq"
                className="mt-6 block text-[15px] text-[var(--amp-muted)] underline-offset-4 transition-colors hover:text-[#000007] hover:underline"
              >
                Read all the questions →
              </Link>
            </Reveal>

            <Reveal delay={100} className="space-y-4">
              {FAQ.map((f, i) => (
                <details key={f.q} open={i === 0} className="amp-card-light group rounded-xl px-7 py-6">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-[18px] font-semibold tracking-[-0.01em]">
                    {f.q}
                    <Plus className="h-5 w-5 shrink-0 text-[var(--amp-faint)] group-open:hidden" />
                    <Minus className="hidden h-5 w-5 shrink-0 text-[var(--amp-faint)] group-open:block" />
                  </summary>
                  <p className="mt-5 text-[15.5px] leading-[1.65] text-[var(--amp-muted)]">{f.a}</p>
                </details>
              ))}
            </Reveal>
          </div>
        </div>
      </section>

      {/* ══ 7. Closing CTA — the floating dark slab every page ends on ═════ */}
      <ClosingCta
        title="Ready to make AI work for your company?"
        lead="A 30-minute conversation is usually enough to know whether we are a fit. Or start with the maturity assessment, it tells you where you stand before starting."
        actions={
          <>
            <Link to="/contact">
              <CtaPrimary>Book a Consultation</CtaPrimary>
            </Link>
            <Link to="/signup">
              <CtaGhost>Start free</CtaGhost>
            </Link>
          </>
        }
      />

      <LandingFooter />
    </div>
  );
}
