"use client";

import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import NumberFlow from "@number-flow/react";
import { motion } from "framer-motion";
import { Bot, CheckCheck, HardDrive, LayoutGrid, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TimelineContent } from "@/components/ui/timeline-animation";

/**
 * Grille tarifaire publique.
 *
 * Le contenu DOIT rester aligné sur `billing_plans` (migration 0194) — prix,
 * crédits inclus et limites y sont la source de vérité. Un prospect qui lit ici
 * autre chose que ce qu'il paiera à l'écran de facturation, c'est un litige.
 * Annuel = 10 mois payés (≈ -17 %).
 *
 * Écart assumé avec la maquette d'origine : l'accent est l'orange de la marque
 * (#FF4D00) et non le bleu. La page vit sous la navbar du site, dont toute la
 * palette est orange/graphite — un bleu y jurerait.
 */

const ACCENT = "#ff4d00";

interface Plan {
  name: string;
  description: string;
  /** null = sur devis. */
  price: number | null;
  yearlyPrice: number | null;
  href: string;
  buttonText: string;
  popular?: boolean;
  features: Array<{ text: string; icon: React.ReactNode }>;
  includes: string[];
}

const plans: Plan[] = [
  {
    name: "Individual",
    description: "One operator, their agents, one service.",
    price: 29,
    yearlyPrice: 290,
    href: "/signup?plan=individual",
    buttonText: "Start free trial",
    features: [
      { text: "12,000 AI credits / month", icon: <Sparkles size={20} /> },
      { text: "3 agents · 1 service", icon: <Bot size={20} /> },
      { text: "2 GB knowledge storage", icon: <HardDrive size={20} /> },
    ],
    includes: [
      "Includes:",
      "AI governance registry",
      "Runtime guardrails",
      "90-day audit retention",
    ],
  },
  {
    name: "Pro",
    description: "A team running a supervised fleet of agents.",
    price: 99,
    yearlyPrice: 990,
    href: "/signup?plan=pro",
    buttonText: "Start free trial",
    popular: true,
    features: [
      { text: "60,000 AI credits / month", icon: <Sparkles size={20} /> },
      { text: "10 agents · 3 services", icon: <Bot size={20} /> },
      { text: "20 GB · 5 seats", icon: <HardDrive size={20} /> },
    ],
    includes: [
      "Everything in Individual, plus:",
      "Human-in-the-loop approvals",
      "Audit export · 1-year retention",
      "Priority support",
    ],
  },
  {
    name: "Agencies",
    description: "Several clients, several services, defensible governance.",
    price: 349,
    yearlyPrice: 3490,
    href: "/signup?plan=agencies",
    buttonText: "Start free trial",
    features: [
      { text: "220,000 AI credits / month", icon: <Sparkles size={20} /> },
      { text: "50 agents · 15 services", icon: <Bot size={20} /> },
      { text: "200 GB · 20 seats", icon: <HardDrive size={20} /> },
    ],
    includes: [
      "Everything in Pro, plus:",
      "White-label",
      "SSO",
      "2-year audit retention",
    ],
  },
  {
    name: "Enterprise",
    description: "Volume commitment, dedicated keys, SLA.",
    price: null,
    yearlyPrice: null,
    href: "/contact",
    buttonText: "Talk to sales",
    features: [
      { text: "Negotiated credit volume", icon: <Sparkles size={20} /> },
      { text: "Unlimited agents & services", icon: <Bot size={20} /> },
      { text: "Unlimited storage & seats", icon: <LayoutGrid size={20} /> },
    ],
    includes: [
      "Everything in Agencies, plus:",
      "Bring your own provider keys",
      "SSO / SAML + SCIM",
      "99.9% SLA · dedicated engineer",
    ],
  },
];

function PricingSwitch({ onSwitch }: { onSwitch: (value: string) => void }) {
  const [selected, setSelected] = useState("0");

  const handleSwitch = (value: string) => {
    setSelected(value);
    onSwitch(value);
  };

  return (
    <div className="flex justify-center">
      <div className="relative z-50 mx-auto flex w-fit rounded-full border border-black/10 bg-white/80 p-1 backdrop-blur">
        {[
          { key: "0", label: "Monthly" },
          { key: "1", label: "Yearly" },
        ].map((opt) => (
          <button
            key={opt.key}
            onClick={() => handleSwitch(opt.key)}
            className={`relative z-10 h-10 w-fit flex-shrink-0 rounded-full px-3 py-1 font-medium transition-colors sm:h-12 sm:px-6 sm:py-2 ${
              selected === opt.key ? "text-white" : "text-black/55 hover:text-black"
            }`}
          >
            {selected === opt.key && (
              <motion.span
                layoutId="pricing-switch"
                className="absolute left-0 top-0 h-10 w-full rounded-full sm:h-12"
                style={{ backgroundColor: ACCENT }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
              />
            )}
            <span className="relative flex items-center gap-2">
              {opt.label}
              {opt.key === "1" && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    selected === "1" ? "bg-white/20 text-white" : "bg-black/[0.06] text-black/70"
                  }`}
                >
                  2 months free
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function PricingSection({ className = "" }: { className?: string }) {
  const [isYearly, setIsYearly] = useState(false);
  const pricingRef = useRef<HTMLDivElement>(null);

  const revealVariants = {
    visible: (i: number) => ({
      y: 0,
      opacity: 1,
      filter: "blur(0px)",
      transition: { delay: i * 0.12, duration: 0.5 },
    }),
    hidden: { filter: "blur(10px)", y: -20, opacity: 0 },
  };

  const togglePricingPeriod = (value: string) => setIsYearly(Number.parseInt(value) === 1);

  return (
    <div ref={pricingRef} className={`relative mx-auto max-w-[1440px] px-4 sm:px-8 ${className}`}>
      <TimelineContent animationNum={0} timelineRef={pricingRef} customVariants={revealVariants}>
        <PricingSwitch onSwitch={togglePricingPeriod} />
      </TimelineContent>

      <div className="mx-auto grid max-w-[1360px] gap-4 py-8 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((plan, index) => (
          <TimelineContent
            key={plan.name}
            animationNum={1 + index}
            timelineRef={pricingRef}
            customVariants={revealVariants}
          >
            <Card
              className={`relative flex h-full flex-col rounded-2xl border-black/[0.08] shadow-[0_20px_50px_-24px_rgba(0,0,7,0.35)] ${
                plan.popular ? "bg-[#fff6f2] ring-2 ring-[#ff4d00]" : "bg-white"
              }`}
            >
              <CardHeader className="text-left">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="mb-2 text-3xl font-semibold text-[#000007]">{plan.name}</h3>
                  {plan.popular && (
                    <span
                      className="rounded-full px-3 py-1 text-sm font-medium text-white"
                      style={{ backgroundColor: ACCENT }}
                    >
                      Popular
                    </span>
                  )}
                </div>
                <p className="mb-4 min-h-[40px] text-sm text-black/60">{plan.description}</p>
                <div className="flex items-baseline">
                  {plan.price === null ? (
                    <span className="text-4xl font-semibold text-[#000007]">Custom</span>
                  ) : (
                    <>
                      <span className="text-4xl font-semibold text-[#000007]">
                        €
                        <NumberFlow
                          value={isYearly ? plan.yearlyPrice! : plan.price}
                          className="text-4xl font-semibold"
                        />
                      </span>
                      <span className="ml-1 text-black/60">/{isYearly ? "year" : "month"}</span>
                    </>
                  )}
                </div>
              </CardHeader>

              <CardContent className="flex flex-1 flex-col pt-0">
                <Link
                  to={plan.href}
                  className={`mb-6 block rounded-xl p-4 text-center text-xl transition-opacity hover:opacity-90 ${
                    plan.popular
                      ? "border border-[#ff6a2b] text-white shadow-lg shadow-[#ff4d00]/40"
                      : "border border-neutral-700 bg-gradient-to-t from-neutral-900 to-neutral-600 text-white shadow-lg shadow-neutral-900/30"
                  }`}
                  style={
                    plan.popular
                      ? { backgroundImage: "linear-gradient(to top, #ff4d00, #ff7a3d)" }
                      : undefined
                  }
                >
                  {plan.buttonText}
                </Link>

                <ul className="space-y-2 py-5 font-semibold">
                  {plan.features.map((feature) => (
                    <li key={feature.text} className="flex items-center">
                      <span className="mr-3 mt-0.5 grid place-content-center text-neutral-800">
                        {feature.icon}
                      </span>
                      <span className="text-sm text-black/60">{feature.text}</span>
                    </li>
                  ))}
                </ul>

                <div className="mt-auto space-y-3 border-t border-black/[0.08] pt-4">
                  <h4 className="mb-3 text-base font-medium text-[#000007]">{plan.includes[0]}</h4>
                  <ul className="space-y-2 font-semibold">
                    {plan.includes.slice(1).map((feature) => (
                      <li key={feature} className="flex items-center">
                        <span className="mr-3 mt-0.5 grid h-6 w-6 shrink-0 place-content-center rounded-full border border-[#ff4d00] bg-[#fff1ea]">
                          <CheckCheck className="h-4 w-4" style={{ color: ACCENT }} />
                        </span>
                        <span className="text-sm text-black/60">{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          </TimelineContent>
        ))}
      </div>
    </div>
  );
}
