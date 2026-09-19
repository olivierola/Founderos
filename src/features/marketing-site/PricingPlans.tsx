import { useState } from "react";
import { Link } from "react-router-dom";
import NumberFlow from "@number-flow/react";
import { Reveal } from "./LandingKit";
import { FeatureLine, MonoLabel, PAPER_ACCENT } from "./PaperKit";

/**
 * La grille tarifaire.
 *
 * Le contenu DOIT rester aligné sur `billing_plans` (migration 0194) — prix,
 * crédits inclus et limites y sont la source de vérité. Un prospect qui lit ici
 * autre chose que ce qu'il paiera à l'écran de facturation, c'est un litige.
 * Annuel = 10 mois payés (≈ -17 %).
 *
 * Les boutons passent par `/subscribe/:plan`, qui décide selon la session :
 * inscription pour un visiteur anonyme (avec l'offre mémorisée), paiement
 * Stripe pour un membre connecté.
 *
 * Les libellés ne promettent PAS d'essai gratuit : le produit n'en a pas
 * (aucun `trial_period_days` n'est envoyé à Stripe). Annoncer un essai puis
 * débiter à la souscription est le genre de promesse qui se règle en litige.
 *
 * ── La forme ────────────────────────────────────────────────────────────────
 * Un seul cadre, des colonnes séparées par des filets, plutôt que quatre cartes
 * flottantes. Quatre cartes se lisent comme quatre produits ; une table à
 * colonnes se lit comme un seul produit à quatre paliers, ce qu'il est. Le plan
 * mis en avant ne change pas de forme — il prend un liseré et un marqueur
 * couleur, parce qu'une colonne plus grande que les autres casse justement
 * l'alignement ligne à ligne qui rend la comparaison possible.
 *
 * Enterprise sort du cadre, à droite : il ne se compare pas, il se négocie.
 */

const INK = "#141414";

type Plan = {
  name: string;
  /** La ligne sous le nom : ce que le palier inclut d'emblée. */
  includes: string;
  description: string;
  /** null = sur devis. */
  price: number | null;
  yearlyPrice: number | null;
  href: string;
  buttonText: string;
  /** Le second bouton, en contour. */
  secondary?: { label: string; href: string };
  popular?: boolean;
  featuresLabel: string;
  features: string[];
};

const PLANS: Plan[] = [
  {
    name: "Individual",
    includes: "Includes the full agent runtime",
    description: "One operator, their agents, one service.",
    price: 29,
    yearlyPrice: 290,
    href: "/subscribe/individual",
    buttonText: "Get started",
    featuresLabel: "Key features include",
    features: [
      "12,000 AI credits / month",
      "3 agents · 1 service",
      "2 GB knowledge storage",
      "AI governance registry",
      "Runtime guardrails",
      "90-day audit retention",
    ],
  },
  {
    name: "Pro",
    includes: "Includes the full agent runtime",
    description: "A team running a supervised fleet of agents.",
    price: 99,
    yearlyPrice: 990,
    href: "/subscribe/pro",
    buttonText: "Get started",
    secondary: { label: "Book a demo", href: "/contact" },
    popular: true,
    featuresLabel: "Every Individual feature, plus",
    features: [
      "60,000 AI credits / month",
      "10 agents · 3 services · 5 seats",
      "Human-in-the-loop approvals",
      "Audit export · 1-year retention",
      "5 MCP tool servers",
      "Priority support",
    ],
  },
  {
    name: "Agencies",
    includes: "Includes the full agent runtime",
    description: "Several clients, several services, defensible governance.",
    price: 349,
    yearlyPrice: 3490,
    href: "/subscribe/agencies",
    buttonText: "Get started",
    secondary: { label: "Book a demo", href: "/contact" },
    featuresLabel: "Every Pro feature, plus",
    features: [
      "220,000 AI credits / month",
      "50 agents · 15 services · 20 seats",
      "White-label",
      "SSO & identity management",
      "2-year audit retention",
      "10 concurrent agent runs",
    ],
  },
];

const ENTERPRISE: Plan = {
  name: "Enterprise",
  includes: "Runs on your own infrastructure",
  description: "Volume commitment, your own provider keys, a named engineer.",
  price: null,
  yearlyPrice: null,
  href: "/contact",
  buttonText: "Talk to sales",
  secondary: { label: "Book a demo", href: "/contact" },
  featuresLabel: "Features include",
  features: [
    "Negotiated credit volume",
    "Unlimited agents, services and seats",
    "Bring your own provider keys",
    "SSO / SAML + SCIM",
    "99.9% SLA · dedicated engineer",
    "3-year audit retention + export",
  ],
};

/* ── The billing switch ─────────────────────────────────────────────────────
   A bordered box with two segments rather than a pill toggle: it sits directly
   under a left-aligned headline, and a floating pill there reads as a control
   that belongs to nothing. */
function PeriodSwitch({ yearly, onChange }: { yearly: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="inline-flex border p-1.5" style={{ borderColor: "rgba(0,0,0,0.14)" }}>
      {[
        { on: true, label: "Billed annually" },
        { on: false, label: "Billed monthly" },
      ].map((opt) => {
        const active = opt.on === yearly;
        return (
          <button
            key={opt.label}
            type="button"
            onClick={() => onChange(opt.on)}
            aria-pressed={active}
            className={`px-5 py-2.5 text-[14px] transition-colors duration-200 ${
              active ? "bg-[#E6E4DE] text-[#0E0E0E]" : "text-[#5A5A5A] hover:text-[#0E0E0E]"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function PriceBlock({ plan, yearly }: { plan: Plan; yearly: boolean }) {
  const amount = yearly ? plan.yearlyPrice : plan.price;

  if (amount === null) {
    return (
      <div className="mt-7">
        <div className="text-[30px] font-normal leading-none tracking-[-0.03em]">Custom</div>
        <div className="mt-2 text-[14px] text-[#6E6E6E]">Priced on committed volume</div>
      </div>
    );
  }

  /* Annual is billed at ten months, so the crossed-out figure is the twelve
     months it replaces — a real comparison, not a decorative strike. */
  const struck = yearly && plan.price !== null ? plan.price * 12 : null;

  return (
    <div className="mt-7">
      <div className="text-[14px] text-[#6E6E6E]">
        From <span className="text-[#0E0E0E]">20 credits</span> per agent reply
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        {struck !== null && (
          <span className="text-[24px] leading-none tracking-[-0.03em] text-[#9A9A9A] line-through tabular-nums">
            €{struck}
          </span>
        )}
        <span
          className="text-[30px] font-normal leading-none tracking-[-0.03em] tabular-nums"
          style={{ color: struck !== null ? PAPER_ACCENT : INK }}
        >
          {/* NumberFlow rolls the figure when the period flips — the whole point
              of the switch is that you see the price move, not the page
              repaint. */}
          €<NumberFlow value={amount} />
        </span>
        <span className="text-[14px] text-[#6E6E6E]">per {yearly ? "year" : "month"}</span>
      </div>
    </div>
  );
}

function PlanColumn({ plan, yearly }: { plan: Plan; yearly: boolean }) {
  return (
    <div className="relative flex h-full flex-col px-6 py-8 sm:px-7">
      {/* The featured column is marked, not enlarged: a taller card would break
          the row-by-row alignment that makes the columns comparable at all. */}
      {plan.popular && (
        <span aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={{ background: PAPER_ACCENT }} />
      )}

      <h3 className="text-[24px] font-normal leading-none tracking-[-0.025em] text-[#0E0E0E]">
        {plan.name}
      </h3>
      <div className="mt-3 flex items-center gap-2 text-[14px] text-[#4A4A4A]">
        {plan.popular && (
          <span aria-hidden className="h-[7px] w-[7px] shrink-0" style={{ background: PAPER_ACCENT }} />
        )}
        {plan.includes}
      </div>
      <p className="mt-4 text-[14px] leading-[1.5] text-[#6E6E6E]">{plan.description}</p>

      <PriceBlock plan={plan} yearly={yearly} />

      <div className="mt-7 flex flex-wrap gap-2">
        <Link
          to={plan.href}
          className="bg-[#0E0E0E] px-5 py-2.5 text-[14px] font-medium text-white transition-opacity hover:opacity-85"
        >
          {plan.buttonText}
        </Link>
        {plan.secondary && (
          <Link
            to={plan.secondary.href}
            className="border px-5 py-2.5 text-[14px] font-medium text-[#0E0E0E] transition-colors"
            style={{ borderColor: "rgba(0,0,0,0.18)" }}
          >
            {plan.secondary.label}
          </Link>
        )}
      </div>

      <MonoLabel className="mt-9">{plan.featuresLabel}</MonoLabel>
      <ul className="mt-4 flex-1 space-y-3">
        {plan.features.map((f) => (
          <FeatureLine key={f} accent={plan.popular}>
            {f}
          </FeatureLine>
        ))}
      </ul>

      <Link
        to="/pricing#compare"
        className="mt-7 inline-block text-[14px] text-[#0E0E0E] underline decoration-black/25 underline-offset-[3px] hover:decoration-black/60"
      >
        View all features
      </Link>
    </div>
  );
}

export function PricingPlans() {
  const [yearly, setYearly] = useState(true);

  return (
    <div style={{ color: INK }}>
      <Reveal>
        <PeriodSwitch yearly={yearly} onChange={setYearly} />
      </Reveal>

      {/* The offer banner. It is a plate like every other, so a promotion cannot
          quietly become a different design language on the page that sells. */}
      <Reveal delay={80}>
        <div className="relative mt-6 bg-[#F7F7F5] px-7 py-6">
          <span aria-hidden className="absolute left-1.5 top-1.5 h-[5px] w-[5px] bg-[#C4C4C4]" />
          <span aria-hidden className="absolute right-1.5 top-1.5 h-[5px] w-[5px] bg-[#C4C4C4]" />
          <span aria-hidden className="absolute bottom-1.5 left-1.5 h-[5px] w-[5px] bg-[#C4C4C4]" />
          <span aria-hidden className="absolute bottom-1.5 right-1.5 h-[5px] w-[5px] bg-[#C4C4C4]" />
          <p className="text-[19px] leading-snug tracking-[-0.015em] text-[#0E0E0E] sm:text-[22px]">
            Annual billing:{" "}
            <span style={{ color: PAPER_ACCENT }}>pay ten months</span> for twelve
          </p>
        </div>
      </Reveal>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px] lg:items-start">
        {/* ── The comparable three ──────────────────────────────────────── */}
        <Reveal delay={120}>
          <div className="border" style={{ borderColor: "rgba(0,0,0,0.13)" }}>
            <div className="border-b px-6 py-4 sm:px-7" style={{ borderColor: "rgba(0,0,0,0.13)" }}>
              <span className="text-[15px] text-[#4A4A4A]">Subscription plans</span>
            </div>
            {/* The gap paints through as the hairline between columns — one rule
                to reason about instead of four edge cases at the corners. */}
            <div className="grid gap-px lg:grid-cols-3" style={{ background: "rgba(0,0,0,0.13)" }}>
              {PLANS.map((p) => (
                <div key={p.name} className="bg-white">
                  <PlanColumn plan={p} yearly={yearly} />
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        {/* ── The one that is negotiated ────────────────────────────────── */}
        <Reveal delay={200}>
          <div className="border" style={{ borderColor: "rgba(0,0,0,0.13)" }}>
            <div className="border-b px-6 py-4" style={{ borderColor: "rgba(0,0,0,0.13)" }}>
              <span className="text-[15px] text-[#4A4A4A]">Already have your own infrastructure?</span>
            </div>
            <div className="bg-white">
              <PlanColumn plan={ENTERPRISE} yearly={yearly} />
            </div>
          </div>
        </Reveal>
      </div>

      <p className="mt-6 max-w-[70ch] text-[14px] leading-[1.6] text-[#6E6E6E]">
        Every plan includes the encrypted secrets vault, the governance registry and the audit log. There is
        no free trial: you are billed at subscription, you can cancel any time, and your data leaves with you.
      </p>
    </div>
  );
}
