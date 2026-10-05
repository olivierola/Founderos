import { useEffect, useState } from "react";
import NumberFlow from "@number-flow/react";
import {
  BuildingsIcon,
  CheckCircleIcon,
  CalendarCheckIcon,
  CoinsIcon,
  CrownSimpleIcon,
  CubeIcon,
  ShieldCheckIcon,
  UserIcon,
} from "@phosphor-icons/react";
import { Reveal } from "./LandingKit";
import { Btn } from "./hn/HnKit";
import { fetchPlans, type BillingPlan } from "@/lib/billing";

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
 * Le registre Hunar : trois cartes à angles courts, le palier mis en avant
 * cerné de bleu avec son badge « Popular », une rangée de faits, puis
 * Enterprise en bandeau — il ne se compare pas, il se négocie. La comparaison
 * ligne à ligne vit dans le tableau de /pricing#compare.
 */

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
    "99.9% SLA · dedicated engineer",
    "3-year audit retention + export",
  ],
};

/** Les nombres de la grille viennent de `billing_plans` — la table qui FACTURE.
 *
 *  Ils étaient écrits en dur ici. Ils concordaient le jour où je les ai
 *  comparés, ce qui est exactement le problème : rien ne les tient ensemble, et
 *  le jour où un prix bouge en base, la page publique continue d'annoncer
 *  l'ancien. Un visiteur voit 29 €, sa carte est débitée d'autre chose.
 *
 *  La table est lisible sans compte (policy « Anyone reads active plans »), donc
 *  la page marketing peut l'interroger telle quelle. Si l'appel échoue — réseau,
 *  Supabase en rade — on retombe sur les valeurs écrites : une grille tarifaire
 *  légèrement datée vaut mieux qu'une page de prix vide.
 *
 *  Les puces qualitatives (« White-label », « Priority support ») restent
 *  éditoriales : ce sont des promesses commerciales, pas des quotas. */
function usePlanPricing() {
  const [byCode, setByCode] = useState<Record<string, BillingPlan>>({});
  useEffect(() => {
    let cancelled = false;
    void fetchPlans()
      .then((plans) => {
        if (cancelled) return;
        setByCode(Object.fromEntries(plans.map((p) => [p.code, p])));
      })
      .catch(() => { /* on garde les valeurs écrites */ });
    return () => { cancelled = true; };
  }, []);
  return byCode;
}

const fmtCredits = (n: number) => n.toLocaleString("en-US");

/** Remplace les nombres d'un palier par ceux de la base, quand elle répond. */
function reconcile(plan: Plan, row: BillingPlan | undefined): Plan {
  if (!row) return plan;
  const l = row.limits ?? {};
  const quantified: string[] = [
    `${fmtCredits(row.included_credits)} AI credits / month`,
    [
      l.agents != null && l.agents >= 0 ? `${l.agents} agents` : null,
      l.services != null && l.services >= 0 ? `${l.services} service${l.services > 1 ? "s" : ""}` : null,
      l.seats != null && l.seats >= 0 ? `${l.seats} seat${l.seats > 1 ? "s" : ""}` : null,
    ].filter(Boolean).join(" · "),
  ].filter((s) => s.length > 0);

  // Les deux premières puces d'un palier sont toujours les quotas ; le reste
  // est du discours et ne bouge pas.
  return {
    ...plan,
    price: row.is_quote ? null : Math.round(row.price_cents_eur / 100),
    yearlyPrice: row.is_quote || row.annual_price_cents_eur == null
      ? null
      : Math.round(row.annual_price_cents_eur / 100),
    features: [...quantified, ...plan.features.slice(quantified.length)],
  };
}

/* ── The billing switch ─────────────────────────────────────────────────────
   A two-segment control, square-cornered like the rest of the register. */
function PeriodSwitch({ yearly, onChange }: { yearly: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="inline-flex rounded-full border border-[#e6e9ef] bg-white p-1 text-[15px]">
      {[
        { on: false, label: "Monthly" },
        { on: true, label: "Yearly · 2 months free" },
      ].map((opt) => {
        const active = opt.on === yearly;
        return (
          <button
            key={opt.label}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.on)}
            className={`rounded-full px-4 py-2 transition-colors ${active ? "bg-[#006edd] text-white" : "text-[#0f1728] hover:text-[#006edd]"}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

const PLAN_ICON: Record<string, typeof UserIcon> = {
  Individual: UserIcon,
  Pro: CrownSimpleIcon,
  Agencies: BuildingsIcon,
};

function Tick() {
  return <CheckCircleIcon weight="fill" className="mt-[2px] h-[18px] w-[18px] shrink-0 text-[#006edd]" />;
}

function PlanCard({ plan, yearly }: { plan: Plan; yearly: boolean }) {
  const hot = !!plan.popular;
  const Icon = PLAN_ICON[plan.name] ?? UserIcon;
  const amount = yearly ? plan.yearlyPrice : plan.price;
  /* Annual is billed at ten months, so the struck figure is the twelve months
     it replaces — a real comparison, not a decorative strike. */
  const struck = yearly && plan.price !== null ? plan.price * 12 : null;

  return (
    <div
      className={`flex h-full flex-col rounded-[24px] border bg-white p-6 ${
        hot ? "border-[#006edd] shadow-[0_24px_50px_-30px_rgba(0,110,221,0.55)]" : "border-[#e6e9ef]"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-[14px] border border-[#e6e9ef] text-[#006edd]">
          <Icon className="h-6 w-6" />
        </span>
        {hot && (
          <span className="rounded-full bg-[#006edd] px-3 py-1.5 text-[13px] font-medium leading-none text-white">
            Popular
          </span>
        )}
      </div>
      <div className="mt-6 text-[22px] font-medium tracking-[-0.03em] text-[#0f1728]">{plan.name}</div>
      <p className="mt-1 text-[16px] leading-[1.4] text-[#4b5567]">{plan.description}</p>
      {amount === null ? (
        <div className="mt-6 text-[36px] font-medium leading-none tracking-[-0.04em] text-[#0f1728]">Custom</div>
      ) : (
        <div className="mt-6 flex items-baseline gap-2">
          {struck !== null && <span className="text-[18px] text-[#8a94a6] line-through tabular-nums">€{struck}</span>}
          <span className="text-[36px] font-medium leading-none tracking-[-0.04em] text-[#0f1728] tabular-nums">
            €<NumberFlow value={amount} />
          </span>
          <span className="text-[16px] text-[#4b5567]">/{yearly ? "year" : "month"}</span>
        </div>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Btn to={plan.href} variant={hot ? "primary" : "secondary"}>
          {plan.buttonText}
        </Btn>
        {plan.secondary && (
          <Btn to={plan.secondary.href} variant="link" className="px-2">
            {plan.secondary.label}
          </Btn>
        )}
      </div>
      <div className="mt-8 border-t border-[#e6e9ef] pt-6 text-[14px] text-[#4b5567]">{plan.featuresLabel}</div>
      <ul className="mt-4 space-y-3">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-[16px] leading-[1.4] text-[#0f1728]">
            <Tick />
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Reconciled plans, for any page that shows the grid. */
export function usePlans() {
  const byCode = usePlanPricing();
  return {
    plans: PLANS.map((p) => reconcile(p, byCode[p.name.toLowerCase()])),
    enterprise: reconcile(ENTERPRISE, byCode.enterprise),
  };
}

/** The grid: three plan cards, the facts row, and Enterprise as a banner —
    it does not compare, it negotiates. `compact` drops the switch and the
    closing note. */
export function PricingPlans({ compact = false }: { compact?: boolean }) {
  const [yearly, setYearly] = useState(false);
  const { plans, enterprise } = usePlans();

  return (
    <div className="text-[#0f1728]">
      {!compact && (
        <Reveal>
          <PeriodSwitch yearly={yearly} onChange={setYearly} />
        </Reveal>
      )}

      <div className={`grid gap-6 lg:grid-cols-3 ${compact ? "" : "mt-8"}`}>
        {plans.map((p, i) => (
          <Reveal key={p.name} delay={i * 80} className="h-full">
            <PlanCard plan={p} yearly={yearly} />
          </Reveal>
        ))}
      </div>

      <Reveal delay={120}>
        <div className="mt-6 grid gap-6 rounded-[24px] border border-[#e6e9ef] bg-[#f7f8fb] p-6 sm:grid-cols-3">
          {[
            { icon: CalendarCheckIcon, t: "Pay yearly", d: "Two months free on every plan." },
            { icon: CoinsIcon, t: "Usage in credits", d: "From 20 credits per agent reply." },
            { icon: ShieldCheckIcon, t: "Cancel any time", d: "Your data leaves with you." },
          ].map((f) => (
            <div key={f.t} className="flex items-start gap-3">
              <f.icon className="mt-0.5 h-6 w-6 shrink-0 text-[#006edd]" />
              <div>
                <div className="text-[17px] font-medium tracking-[-0.02em]">{f.t}</div>
                <div className="text-[15px] text-[#4b5567]">{f.d}</div>
              </div>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal delay={160}>
        <div className="mt-6 flex flex-col gap-5 rounded-[24px] border border-[#e6e9ef] bg-white p-6 sm:flex-row sm:items-center sm:p-8">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] border border-[#e6e9ef] text-[#006edd]">
            <CubeIcon className="h-6 w-6" />
          </span>
          <div className="flex-1">
            <div className="text-[20px] font-medium tracking-[-0.02em]">
              Enterprise <span className="text-[#8a94a6]">·</span> {enterprise.includes}
            </div>
            <p className="mt-1 text-[16px] leading-[1.4] text-[#4b5567]">
              {enterprise.description} {enterprise.features.slice(0, 2).join(" · ")}.
            </p>
          </div>
          <Btn to={enterprise.href}>{enterprise.buttonText}</Btn>
        </div>
      </Reveal>

      {!compact && (
        <p className="mt-6 max-w-[70ch] text-[15px] leading-[1.55] text-[#4b5567]">
          Every plan includes the encrypted secrets vault, the governance registry and the audit log. There is no
          free trial: you are billed at subscription, you can cancel any time, and your data leaves with you.
        </p>
      )}
    </div>
  );
}
