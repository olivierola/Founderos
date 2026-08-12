import { Fragment, useEffect } from "react";
import { Check, Lock, Minus, Rocket, ShieldCheck } from "lucide-react";
import { GrainGradient } from "@paper-design/shaders-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { HERO_BG } from "./LandingHero";
import PricingSection from "@/components/ui/pricing-section";

/* ===================== Pricing Page =====================
   Même chrome que la landing : sa navbar, sa typo, son orange. Le hero reprend
   le champ animé de la page de connexion (GrainGradient), RE-ÉCLAIRÉ pour une
   toile claire : la navbar de la landing est écrite en noir, la version sombre
   du shader la rendrait illisible. Même shader, mêmes couleurs de marque, fond
   inversé — c'est le même objet, posé sur du blanc.

   Le reste de la page est blanc, et les cartes remontent sur le hero (marge
   négative) pour que la grille tarifaire soit la première chose qu'on lise. */

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

const PRICING_FAQ = [
  { q: "What is an AI credit?", a: "One unit of AI work. Credits cover what your agents actually spend at the AI providers — language models, vectorisation, transcription. A conversational reply costs about 20 credits, a full mission 300 to 800, indexing a 100-page document about 5." },
  { q: "What happens when I run out?", a: "Agents stop cleanly and keep whatever they already produced — nothing is lost mid-run. You can buy a credit pack (it never expires) or move up a plan; either restores service immediately." },
  { q: "Can I change plans later?", a: "Yes, anytime. Upgrading is instant and restarts your billing period with the new allowance; downgrading applies at the end of the current period." },
  { q: "How does annual billing work?", a: "Annual plans are billed once a year for the price of ten months — about 17% off versus monthly." },
  { q: "What counts as a 'service'?", a: "One agent-centred workspace: its own agents, rooms, schedules and knowledge base. Agencies typically run one service per client." },
  { q: "What payment methods?", a: "Card via Stripe. Wire transfer + PO available on Enterprise." },
];

/** Une cellule du comparatif — ✓ / — deviennent des icônes, le reste du texte. */
function MatrixCell({ value, highlight }: { value: string; highlight?: boolean }) {
  let content: React.ReactNode = value;
  if (value === "✓") content = <Check className="mx-auto h-4 w-4 text-[#ff4d00]" />;
  else if (value === "—") content = <Minus className="mx-auto h-4 w-4 text-black/25" />;
  return (
    <td className={"px-4 py-3 text-center " + (highlight ? "font-medium text-[#000007]" : "text-black/60")}>
      {content}
    </td>
  );
}

export function PricingPage() {
  useEffect(() => {
    document.documentElement.classList.add("mkt-no-scrollbar", "amp-root");
    return () => document.documentElement.classList.remove("mkt-no-scrollbar", "amp-root");
  }, []);

  return (
    <div className="amplify amp-light min-h-screen overflow-x-hidden bg-white">
      <LandingNav />

      {/* ══ Hero — le champ animé de la page de connexion, sur toile claire ══
          Le padding bas est volontairement excessif : c'est lui qui laisse la
          place aux cartes qui remontent par-dessus. */}
      <section className="relative overflow-hidden pt-[104px] pb-[260px]">
        <GrainGradient
          speed={1}
          scale={1}
          rotation={0}
          offsetX={0}
          offsetY={0}
          softness={0.5}
          intensity={0.5}
          noise={0.25}
          shape="corners"
          frame={2854.5}
          colors={["#FFFFFF", "#FF4D00", "#FC7819", "#FFFFFF"]}
          /* HERO_BG et non blanc pur : c'est la teinte que la navbar utilise
             pour son encoche, elles se rejoignent donc sans couture. */
          colorBack={HERO_BG}
          className="absolute inset-0"
        />
        {/* Fondu vers le blanc de la page — sans ça la bordure du shader coupe
            net juste derrière les cartes. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-64 bg-gradient-to-b from-transparent to-white" />

        <div className="relative mx-auto max-w-3xl px-4 pt-10 text-center sm:px-6">
          <h1 className="text-balance text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-[#000007] sm:text-[56px] lg:text-[64px]">
            Pricing that follows the work
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-[17px] leading-[1.6] text-black/65">
            One subscription per team, and credits that cover exactly what your agents
            spend at the AI providers. No per-seat tax on the work itself.
          </p>
        </div>
      </section>

      {/* ══ Cartes — elles mordent sur le hero ══════════════════════════════ */}
      <PricingSection className="z-10 -mt-[230px] pb-20" />

      {/* ══ Comparatif ═════════════════════════════════════════════════════ */}
      <section className="bg-[#fafafa] py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="mb-8 text-center text-[30px] font-semibold tracking-[-0.025em] text-[#000007]">
            Compare plans in detail
          </h2>
          <div className="overflow-x-auto rounded-2xl border border-black/[0.08] bg-white">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-black/[0.08] bg-black/[0.02] text-xs uppercase tracking-wider text-black/50">
                <tr>
                  <th className="px-4 py-3 text-left">Feature</th>
                  <th className="px-4 py-3 text-center">Individual</th>
                  <th className="px-4 py-3 text-center text-[#ff4d00]">Pro</th>
                  <th className="px-4 py-3 text-center">Agencies</th>
                  <th className="px-4 py-3 text-center">Enterprise</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/[0.06]">
                {COMPARE_GROUPS.map((g) => (
                  <Fragment key={g.label}>
                    <tr className="bg-black/[0.02]">
                      <td colSpan={5} className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-black/45">
                        {g.label}
                      </td>
                    </tr>
                    {g.rows.map((row) => (
                      <tr key={row.feature} className="hover:bg-black/[0.02]">
                        <td className="px-4 py-3 font-medium text-[#000007]">{row.feature}</td>
                        <MatrixCell value={row.individual} />
                        <MatrixCell value={row.pro} highlight />
                        <MatrixCell value={row.agencies} />
                        <MatrixCell value={row.ent} />
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ══ Bandeau de confiance ═══════════════════════════════════════════ */}
      <section className="border-t border-black/[0.06] bg-white py-14">
        <div className="mx-auto grid max-w-5xl gap-6 px-4 sm:grid-cols-3 sm:px-6">
          {[
            { icon: ShieldCheck, t: "Approval-gated by default", b: "Every write an agent performs is gated and audit-logged." },
            { icon: Rocket, t: "Cancel anytime", b: "No lock-in. Export your data and pause the agents whenever you want." },
            { icon: Lock, t: "Encrypted secrets", b: "Credentials are encrypted at rest; no plaintext leaves the browser." },
          ].map((it) => {
            const I = it.icon;
            return (
              <div key={it.t} className="flex gap-3">
                <I className="mt-0.5 h-5 w-5 shrink-0 text-[#ff4d00]" />
                <div>
                  <div className="text-sm font-medium text-[#000007]">{it.t}</div>
                  <div className="text-sm text-black/60">{it.b}</div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ══ FAQ ════════════════════════════════════════════════════════════ */}
      <section className="border-t border-black/[0.06] bg-white py-24">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <h2 className="text-center text-[30px] font-semibold tracking-[-0.025em] text-[#000007]">
            Pricing FAQ
          </h2>
          <div className="mt-10 space-y-3">
            {PRICING_FAQ.map((f) => (
              <details key={f.q} className="group rounded-2xl border border-black/[0.08] bg-white p-5 open:bg-[#fafafa]">
                <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-[#000007]">
                  {f.q}
                  <span className="ml-4 text-black/40 transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-black/65">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <LandingFooter />
    </div>
  );
}
