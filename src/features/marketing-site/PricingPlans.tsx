import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import NumberFlow from "@number-flow/react";
import {
  BuildingsIcon,
  CalendarCheckIcon,
  CoinsIcon,
  CrownSimpleIcon,
  CubeIcon,
  ShieldCheckIcon,
  UserIcon,
} from "@phosphor-icons/react";
import { Reveal } from "./LandingKit";
import { Btn, CheckBadge, IconOrb, InfoPill } from "./atlas/AtlasKit";
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
 * Le registre Atlas : trois cartes arrondies, le palier mis en avant sur le
 * dégradé noir → violet avec son badge « Popular », une rangée de faits en
 * pastilles, puis Enterprise en bandeau — il ne se compare pas, il se négocie.
 * La comparaison ligne à ligne vit dans le tableau de /pricing#compare.
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
   The reference's pill toggle: two labels either side of a switch. */
function PeriodSwitch({ yearly, onChange }: { yearly: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="inline-flex items-center gap-3 rounded-full border border-[#e6e6e6] bg-white py-1.5 pl-4 pr-4 text-[14px] font-semibold text-[#111011] shadow-[0_10px_30px_-20px_rgba(17,16,17,0.35)]">
      <button type="button" onClick={() => onChange(false)} className={yearly ? "opacity-45" : ""}>
        Monthly
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={yearly}
        aria-label="Bill annually"
        onClick={() => onChange(!yearly)}
        className="relative h-[30px] w-[56px] rounded-full bg-[#111011]"
      >
        <span
          className={`absolute top-[3px] h-[24px] w-[24px] rounded-full bg-white transition-all duration-300 ${
            yearly ? "left-[29px]" : "left-[3px]"
          }`}
        />
      </button>
      <button type="button" onClick={() => onChange(true)} className={yearly ? "" : "opacity-45"}>
        Annually <span className="at-grad-text">· 2 months free</span>
      </button>
    </div>
  );
}

const PLAN_ICON: Record<string, typeof UserIcon> = {
  Individual: UserIcon,
  Pro: CrownSimpleIcon,
  Agencies: BuildingsIcon,
};

function PlanCard({ plan, yearly }: { plan: Plan; yearly: boolean }) {
  const hot = !!plan.popular;
  const Icon = PLAN_ICON[plan.name] ?? UserIcon;
  const amount = yearly ? plan.yearlyPrice : plan.price;
  /* Annual is billed at ten months, so the struck figure is the twelve months
     it replaces — a real comparison, not a decorative strike. */
  const struck = yearly && plan.price !== null ? plan.price * 12 : null;

  return (
    <div
      className={`relative flex h-full flex-col overflow-hidden rounded-[32px] p-2 ${
        hot
          ? "text-white shadow-[0_40px_80px_-40px_rgba(125,17,173,0.8)]"
          : "border border-[#ededed] bg-[linear-gradient(160deg,#ffffff_40%,#f7f7f7)] text-[#111011]"
      }`}
      style={
        hot
          ? { background: "linear-gradient(180deg, #000000 0%, #000000 22%, #5b0d78 55%, #b01fe0 80%, #d22eff 100%)" }
          : undefined
      }
    >
      {hot && (
        <span className="absolute right-3 top-3 rounded-full bg-white px-4 py-2.5 text-[14px] font-semibold leading-none text-[#111011]">
          Popular
        </span>
      )}
      <div className="flex flex-1 flex-col px-5 pb-6 pt-6">
        <span
          className={`grid h-9 w-9 place-items-center rounded-full ${hot ? "bg-white/15" : "bg-[#f1f1f1]"}`}
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className={`mt-4 text-[15px] ${hot ? "text-white/80" : "text-[#666666]"}`}>{plan.name}</div>
        {amount === null ? (
          <div className="mt-1 text-[22px] font-bold tracking-[-0.03em]">Custom</div>
        ) : (
          <div className="mt-1 flex items-baseline gap-2">
            {struck !== null && (
              <span className={`text-[16px] line-through tabular-nums ${hot ? "text-white/45" : "text-[#969696]"}`}>
                €{struck}
              </span>
            )}
            <span className="text-[22px] font-bold tracking-[-0.03em] tabular-nums">
              €<NumberFlow value={amount} />
            </span>
            <span className={`text-[15px] font-semibold ${hot ? "text-white/80" : "text-[#666666]"}`}>
              /{yearly ? "yr" : "mo"}
            </span>
          </div>
        )}
        <p className={`mt-2 text-[14px] leading-[1.45] ${hot ? "text-white/75" : "text-[#666666]"}`}>
          {plan.description}
        </p>

        <ul className="mt-7 space-y-3">
          {plan.features.map((f) => (
            <li key={f} className="flex items-center gap-3.5 text-[14.5px] font-medium tracking-[-0.01em]">
              <CheckBadge size={22} tone={hot ? "white" : "dark"} />
              <span className={hot ? "text-white" : "text-[#111011]"}>{f}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-1.5">
        <Btn to={plan.href} variant={hot ? "white" : "light"} className="w-full shadow-none">
          {plan.buttonText}
        </Btn>
        {plan.secondary && (
          <Link
            to={plan.secondary.href}
            className={`py-2 text-center text-[13.5px] font-semibold ${hot ? "text-white/85 hover:text-white" : "text-[#666666] hover:text-[#111011]"}`}
          >
            {plan.secondary.label}
          </Link>
        )}
      </div>
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
    closing note, for the home page. */
export function PricingPlans({ compact = false }: { compact?: boolean }) {
  const [yearly, setYearly] = useState(false);
  const { plans, enterprise } = usePlans();

  return (
    <div className="text-[#111011]">
      {!compact && (
        <Reveal className="flex justify-center">
          <PeriodSwitch yearly={yearly} onChange={setYearly} />
        </Reveal>
      )}

      <div className={`grid gap-2.5 lg:grid-cols-3 ${compact ? "" : "mt-8"}`}>
        {plans.map((p, i) => (
          <Reveal key={p.name} delay={i * 80} className="h-full">
            <PlanCard plan={p} yearly={yearly} />
          </Reveal>
        ))}
      </div>

      <Reveal delay={120}>
        <div className="mt-2.5 grid gap-2.5 md:grid-cols-3">
          <InfoPill icon={CalendarCheckIcon}>
            Pay yearly <span className="text-[#969696]">→</span> 2 months free
          </InfoPill>
          <InfoPill icon={CoinsIcon}>From 20 credits per agent reply</InfoPill>
          <InfoPill icon={ShieldCheckIcon}>Cancel any time — your data leaves with you</InfoPill>
        </div>
      </Reveal>

      <Reveal delay={160}>
        <div className="mt-2.5 flex flex-col gap-5 rounded-[32px] border border-[#ededed] bg-white p-6 sm:flex-row sm:items-center sm:p-7">
          <IconOrb icon={CubeIcon} size={60} />
          <div className="flex-1">
            <div className="text-[17px] font-semibold tracking-[-0.02em]">
              Enterprise <span className="text-[#969696]">/</span> {enterprise.includes}
            </div>
            <p className="mt-1.5 text-[14.5px] leading-[1.45] text-[#666666]">
              {enterprise.description} {enterprise.features.slice(0, 2).join(" · ")}.
            </p>
          </div>
          <Btn to={enterprise.href} variant="dark">
            {enterprise.buttonText}
          </Btn>
        </div>
      </Reveal>

      {!compact && (
        <p className="mx-auto mt-6 max-w-[70ch] text-center text-[14px] leading-[1.6] text-[#666666]">
          Every plan includes the encrypted secrets vault, the governance registry and the audit log. There is no
          free trial: you are billed at subscription, you can cancel any time, and your data leaves with you.
        </p>
      )}
    </div>
  );
}
