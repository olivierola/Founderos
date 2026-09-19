import { Fragment, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRightIcon as ArrowRight,
  CheckIcon as Check,
  LockIcon as Lock,
  MinusIcon as Minus,
  RocketLaunchIcon as Rocket,
  ShieldCheckIcon as ShieldCheck,
} from "@phosphor-icons/react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { LandingClose } from "./LandingClose";
import { PricingPlans } from "./PricingPlans";
import { Reveal } from "./LandingKit";
import { PaperHero } from "./PaperHero";
import { PAPER_ACCENT, Plate, SectionTitle } from "./PaperKit";
import { ToneCanvas, ToneSection } from "./LandingTone";

/* ═══ Pricing ════════════════════════════════════════════════════════════════
   The page that sells, so it stays on paper the whole way down and only drops
   into the dark for the closing slab. The earlier cut alternated dark and light
   bands; on a page whose whole job is a comparison, every change of ground was
   a place where the reader had to re-orient instead of reading across.

   The register is the paper kit (see PaperKit): register marks at the corners
   of anything that is a surface, monospace for the labels, two-tone headings,
   and hairlines rather than gaps between things meant to be compared.        */

const INK = "#141414";

const COMPARE_GROUPS = [
  {
    label: "Usage",
    rows: [
      { feature: "AI credits / month", individual: "12,000", pro: "60,000", agencies: "220,000", ent: "Negotiated" },
      { feature: "Agents", individual: "3", pro: "10", agencies: "50", ent: "Unlimited" },
      { feature: "Services", individual: "1", pro: "3", agencies: "15", ent: "Unlimited" },
      { feature: "Seats", individual: "1", pro: "5", agencies: "20", ent: "Unlimited" },
      { feature: "Knowledge storage", individual: "2 GB", pro: "20 GB", agencies: "200 GB", ent: "Unlimited" },
      { feature: "Projects", individual: "2", pro: "10", agencies: "50", ent: "Unlimited" },
      { feature: "Concurrent agent runs", individual: "1", pro: "3", agencies: "10", ent: "50" },
    ],
  },
  {
    label: "Platform",
    rows: [
      { feature: "Encrypted secrets vault", individual: "✓", pro: "✓", agencies: "✓", ent: "✓" },
      { feature: "AI governance registry", individual: "✓", pro: "✓", agencies: "✓", ent: "✓" },
      { feature: "Runtime guardrails", individual: "✓", pro: "✓", agencies: "✓", ent: "✓" },
      { feature: "Human-in-the-loop approvals", individual: "—", pro: "✓", agencies: "✓", ent: "✓" },
      { feature: "MCP tool servers", individual: "1", pro: "5", agencies: "25", ent: "Unlimited" },
      { feature: "White-label", individual: "—", pro: "—", agencies: "✓", ent: "✓" },
      { feature: "Audit log retention", individual: "90 days", pro: "1 year", agencies: "2 years", ent: "3 years + export" },
    ],
  },
  {
    label: "Security & support",
    rows: [
      { feature: "SSO / SAML", individual: "—", pro: "—", agencies: "✓", ent: "✓" },
      { feature: "Bring your own provider keys", individual: "—", pro: "—", agencies: "—", ent: "✓" },
      { feature: "SLA", individual: "99%", pro: "99%", agencies: "99.5%", ent: "99.9%" },
      { feature: "Support", individual: "Email", pro: "Priority", agencies: "Priority", ent: "Dedicated CSM" },
    ],
  },
];

/* ── Add-ons ────────────────────────────────────────────────────────────────
   Bought on top of a plan rather than instead of one, so they sit in their own
   block below the table and never inside the plan columns — a column that mixes
   what you get with what you can also buy stops being comparable. */
const ADDONS = [
  {
    name: "Voice",
    tag: "Includes call recording",
    body: "Agents that answer and place calls, with transcription and the same approval gates as everything else. Twilio and Deepgram, wired for you.",
    price: "€89",
    unit: "/mo",
    accent: true,
  },
  {
    name: "Sandbox runners",
    body: "Dedicated compute for agents that write code, run tests and drive a browser. Isolated per service, scaled to the fleet you actually run.",
    price: "€149",
    unit: "/mo",
  },
  {
    name: "Managed run",
    body: "Our architect, functional consultant and developer on a monthly retainer, keeping the platform current as your systems and your models move.",
    price: "From €2,400",
    unit: "/mo",
  },
];

const GUARANTEES = [
  {
    icon: ShieldCheck,
    t: "Approval-gated by default",
    b: "Every write an agent performs is gated and recorded in an exportable audit log.",
  },
  {
    icon: Rocket,
    t: "Cancel any time",
    b: "No lock-in and no notice period. Export your data and pause the agents whenever you want.",
  },
  {
    icon: Lock,
    t: "Encrypted secrets",
    b: "Credentials are encrypted at rest with AES-GCM; no plaintext ever reaches the browser.",
  },
];

const PRICING_FAQ = [
  { q: "What is an AI credit?", a: "One unit of AI work. Credits cover what your agents actually spend at the AI providers: language models, vectorisation, transcription. A conversational reply costs about 20 credits, a full mission 300 to 800, indexing a 100-page document about 5." },
  { q: "What happens when I run out?", a: "Agents stop cleanly and keep whatever they already produced, so nothing is lost mid-run. You can buy a credit pack (it never expires) or move up a plan; either restores service immediately." },
  { q: "Can I change plans later?", a: "Yes, anytime. Upgrading is instant and restarts your billing period with the new allowance; downgrading applies at the end of the current period." },
  { q: "How does annual billing work?", a: "Annual plans are billed once a year for the price of ten months, about 17% off versus monthly." },
  { q: "What counts as a 'service'?", a: "One agent-centred workspace: its own agents, rooms, schedules and knowledge base. Agencies typically run one service per client." },
  { q: "What payment methods?", a: "Card via Stripe. Wire transfer + PO available on Enterprise." },
];

/** Une cellule du comparatif — ✓ / — deviennent des icônes, le reste du texte. */
function MatrixCell({ value, highlight }: { value: string; highlight?: boolean }) {
  let content: React.ReactNode = value;
  if (value === "✓")
    content = <Check className="mx-auto h-4 w-4" style={{ color: highlight ? PAPER_ACCENT : INK }} />;
  else if (value === "—") content = <Minus className="mx-auto h-4 w-4 text-black/25" />;
  return (
    <td className={"px-4 py-3.5 text-center " + (highlight ? "font-medium" : "text-black/60")}>{content}</td>
  );
}

export function PricingPage() {
  useEffect(() => {
    document.documentElement.classList.add("mkt-no-scrollbar", "amp-root");
    return () => document.documentElement.classList.remove("mkt-no-scrollbar", "amp-root");
  }, []);

  return (
    <div
      className="amplify min-h-screen text-white"
      /* Same two reasons as the landing page: `.amplify` would paint over the
         tone canvas, and an `overflow-x-hidden` root kills sticky. */
      style={{ backgroundColor: "transparent" }}
    >
      <LandingNav />

      <ToneCanvas initial="paper">
        {/* ══ The claim ═══════════════════════════════════════════════════
            Left-aligned, no collage, no framing grey line: this hero has a
            working block directly underneath it, and a centred column over a
            left-aligned table reads as two pages stapled together. */}
        <ToneSection tone="paper">
          <PaperHero
            align="left"
            tiles={[]}
            frame={[]}
            claim="One subscription for a fleet of agents that does the work"
            note={
              <>
                <Check className="h-3.5 w-3.5 text-[#0E0E0E]" weight="bold" />
                <span className="font-mono text-[11.5px] uppercase tracking-[0.11em] underline decoration-black/30 underline-offset-[4px]">
                  No per-seat tax on machine work
                </span>
              </>
            }
          />
        </ToneSection>

        {/* ══ The plans ═══════════════════════════════════════════════════ */}
        <ToneSection tone="paper">
          <div className="mx-auto max-w-[1420px] px-5 pb-24 sm:px-9 sm:pb-28" style={{ color: INK }}>
            <PricingPlans />
          </div>
        </ToneSection>

        {/* ══ Add-ons ═════════════════════════════════════════════════════ */}
        <ToneSection tone="paper">
          <div className="mx-auto max-w-[1420px] px-5 pb-24 sm:px-9 sm:pb-28" style={{ color: INK }}>
            <Reveal>
              <SectionTitle frame="bought on top of any plan" claim="Add-ons," flip />
              <p className="mt-5 max-w-xl text-[15.5px] leading-[1.6] text-[#6E6E6E]">
                Added or removed at any time, prorated to the day. None of them is required to run agents.
              </p>
            </Reveal>

            <div className="mt-12 grid gap-5 md:grid-cols-3">
              {ADDONS.map((a, i) => (
                <Plate key={a.name} accent={a.accent} delay={i * 90}>
                  <div className="flex h-full flex-col px-7 py-8">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <h3 className="text-[22px] font-normal leading-none tracking-[-0.025em]">{a.name}</h3>
                      {a.tag && (
                        <span className="flex items-center gap-2 text-[13.5px] text-[#4A4A4A]">
                          <span aria-hidden className="h-[7px] w-[7px]" style={{ background: PAPER_ACCENT }} />
                          {a.tag}
                        </span>
                      )}
                    </div>
                    <p className="mt-4 text-[14.5px] leading-[1.6] text-[#5A5A5A]">{a.body}</p>

                    {/* Pushed to the foot of the card so three cards of unequal
                        prose still line their prices up on one row. */}
                    <div className="mt-auto pt-12">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-[26px] font-normal leading-none tracking-[-0.03em]">
                          {a.price}
                        </span>
                        <span className="text-[14px] text-[#6E6E6E]">{a.unit}</span>
                      </div>
                      <Link
                        to="/contact"
                        className="mt-4 inline-block text-[14px] underline decoration-black/25 underline-offset-[3px] hover:decoration-black/60"
                      >
                        Learn more
                      </Link>
                    </div>
                  </div>
                </Plate>
              ))}
            </div>
          </div>
        </ToneSection>

        {/* ══ The comparison ══════════════════════════════════════════════ */}
        <ToneSection tone="bone" id="compare">
          <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28" style={{ color: INK }}>
            <Reveal>
              <SectionTitle frame="Every line," claim="side by side" />
            </Reveal>

            <Reveal delay={100}>
              {/* The table scrolls inside its own box: a marketing page must
                  never scroll horizontally as a whole. */}
              <div
                className="mt-12 overflow-x-auto border bg-white"
                style={{ borderColor: "rgba(20,20,20,0.13)" }}
              >
                <table className="w-full min-w-[820px] text-[13.5px]">
                  <thead
                    className="font-mono text-[11px] uppercase tracking-[0.11em] text-black/45"
                    style={{ background: "rgba(20,20,20,0.03)" }}
                  >
                    <tr>
                      <th className="px-4 py-3.5 text-left font-normal">Feature</th>
                      <th className="px-4 py-3.5 text-center font-normal">Individual</th>
                      <th className="px-4 py-3.5 text-center font-normal" style={{ color: PAPER_ACCENT }}>
                        Pro
                      </th>
                      <th className="px-4 py-3.5 text-center font-normal">Agencies</th>
                      <th className="px-4 py-3.5 text-center font-normal">Enterprise</th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMPARE_GROUPS.map((g) => (
                      <Fragment key={g.label}>
                        <tr style={{ background: "rgba(20,20,20,0.03)" }}>
                          <td
                            colSpan={5}
                            className="border-t px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.11em] text-black/45"
                            style={{ borderColor: "rgba(20,20,20,0.08)" }}
                          >
                            {g.label}
                          </td>
                        </tr>
                        {g.rows.map((r) => (
                          <tr
                            key={r.feature}
                            className="border-t transition-colors hover:bg-black/[0.02]"
                            style={{ borderColor: "rgba(20,20,20,0.07)" }}
                          >
                            <td className="px-4 py-3.5 text-black/75">{r.feature}</td>
                            <MatrixCell value={r.individual} />
                            <MatrixCell value={r.pro} highlight />
                            <MatrixCell value={r.agencies} />
                            <MatrixCell value={r.ent} />
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </Reveal>
          </div>
        </ToneSection>

        {/* ══ Get an estimate ═════════════════════════════════════════════ */}
        <ToneSection tone="paper">
          <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28" style={{ color: INK }}>
            <Reveal>
              <SectionTitle frame="Get an estimate" claim="based on your own numbers" />
            </Reveal>

            <div className="mt-12 grid gap-5 lg:grid-cols-2">
              <Plate accent delay={80}>
                <div className="px-8 py-10">
                  <h3 className="max-w-[16ch] text-balance text-[26px] font-normal leading-[1.15] tracking-[-0.03em] sm:text-[32px]">
                    Find the right plan for your team
                  </h3>
                  <p className="mt-5 max-w-[46ch] text-[15px] leading-[1.6] text-[#5A5A5A]">
                    An estimated monthly cost from your team size, the number of services you run and the
                    volume of agent work you expect.
                  </p>
                  <Link
                    to="/contact"
                    className="mt-8 inline-block text-[15px] underline decoration-black/30 underline-offset-[4px] hover:decoration-black/60"
                  >
                    Calculate costs
                  </Link>
                </div>
              </Plate>

              <Plate delay={160}>
                <div className="px-8 py-10">
                  <h3 className="max-w-[16ch] text-balance text-[26px] font-normal leading-[1.15] tracking-[-0.03em] sm:text-[32px]">
                    See what the work costs you today
                  </h3>
                  <p className="mt-5 max-w-[46ch] text-[15px] leading-[1.6] text-[#5A5A5A]">
                    The same processes priced as human hours, so the comparison lands against your current
                    bill rather than against zero.
                  </p>
                  <Link
                    to="/contact"
                    className="mt-8 inline-block text-[15px] underline decoration-black/30 underline-offset-[4px] hover:decoration-black/60"
                  >
                    Calculate savings
                  </Link>
                </div>
              </Plate>
            </div>
          </div>
        </ToneSection>

        {/* ══ The guarantees ══════════════════════════════════════════════ */}
        <ToneSection tone="paper">
          <div className="mx-auto max-w-[1420px] px-5 pb-24 sm:px-9 sm:pb-28" style={{ color: INK }}>
            <div
              className="grid gap-9 border-t pt-12 sm:grid-cols-3"
              style={{ borderColor: "rgba(0,0,0,0.12)" }}
            >
              {GUARANTEES.map((it, i) => {
                const I = it.icon;
                return (
                  <Reveal key={it.t} delay={i * 90}>
                    <I className="h-5 w-5" style={{ color: PAPER_ACCENT }} />
                    <h3 className="mt-5 text-[16.5px] font-medium leading-snug tracking-[-0.015em] text-[#0E0E0E]">
                      {it.t}
                    </h3>
                    <p className="mt-3.5 text-[14px] leading-[1.6] text-[#6E6E6E]">{it.b}</p>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </ToneSection>

        {/* ══ FAQ — billing only; the rest lives on /faq ══════════════════ */}
        <ToneSection tone="paper">
          <div className="mx-auto max-w-[1420px] px-5 pb-24 sm:px-9 sm:pb-28" style={{ color: INK }}>
            <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
              <Reveal>
                <SectionTitle frame="What people ask" claim="about the bill" />
                <p className="mt-6 max-w-sm text-[15px] leading-[1.6] text-[#6E6E6E]">
                  Six questions on billing. Security, governance and the platform have their own page.
                </p>
                <Link to="/faq" className="group mt-8 inline-flex items-center gap-2 text-[14px] text-[#0E0E0E]">
                  <span className="underline decoration-black/25 underline-offset-[3px] group-hover:decoration-black/60">
                    All questions, not just pricing
                  </span>
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </Link>
              </Reveal>

              <Reveal delay={100}>
                <div className="border-t" style={{ borderColor: "rgba(0,0,0,0.12)" }}>
                  {PRICING_FAQ.map((f, i) => (
                    <details
                      key={f.q}
                      open={i === 0}
                      className="group border-b"
                      style={{ borderColor: "rgba(0,0,0,0.12)" }}
                    >
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-6 text-[16.5px] leading-snug tracking-[-0.015em] text-[#0E0E0E] sm:text-[17.5px]">
                        {f.q}
                        <span className="ml-4 shrink-0 text-black/35 transition-transform group-open:rotate-45">
                          +
                        </span>
                      </summary>
                      <p className="max-w-[62ch] pb-7 pr-8 text-[14.5px] leading-[1.65] text-[#6E6E6E]">
                        {f.a}
                      </p>
                    </details>
                  ))}
                </div>
              </Reveal>
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
