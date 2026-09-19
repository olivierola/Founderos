import { Link } from "react-router-dom";
import {
  FingerprintIcon as Fingerprint,
  KeyIcon as KeyRound,
  LockIcon as Lock,
  ShieldCheckIcon as ShieldCheck,
} from "@phosphor-icons/react";
import { Display, Em, Pill, Reveal } from "./LandingKit";
import { ToneSection } from "./LandingTone";

/* The security section. It is deliberately the plainest block on the page: no
   photograph, no wash, no motion. Everything here is a claim someone will be
   asked to verify, and the layout should look like it knows that. */

/* Set in type rather than as vendor badge art — printing an auditor's mark is
   a claim about a certificate, and those belong on the trust page with a date
   on them. Swap for real badges once the certificates are in hand. */
const MARKS = [
  "SOC 2 Type II",
  "ISO 27001",
  "GDPR",
  "EU AI Act",
  "AES-GCM at rest",
  "SSO & SCIM",
  "EU data residency",
  "Annual pen test",
];

const PILLARS = [
  {
    icon: ShieldCheck,
    title: "Compliance you can hand to an auditor",
    body: "Obligations mapped to controls, controls mapped to the agents they cover, and an export that answers the question in the form the auditor asked it.",
  },
  {
    icon: Lock,
    title: "Guardrails on every action",
    body: "Scoped tool grants, an approval gate on every write, and a hard stop the moment an agent reaches past the perimeter it was given.",
  },
  {
    icon: Fingerprint,
    title: "Privacy by design",
    body: "We connect to your systems; we do not copy your data. Zero-retention agreements with model providers, European residency by default.",
  },
  {
    icon: KeyRound,
    title: "Tested, not asserted",
    body: "Credentials encrypted at rest and never returned to the browser. Independent penetration testing every year, the agent layer included.",
  },
];

export function LandingTrust() {
  return (
    <ToneSection tone="ink">
      <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28">
        <div className="grid items-start gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-14">
          <Reveal>
            <Display className="max-w-[14ch]">
              Battle-tested AI with enterprise-level <Em>rigour</Em>
            </Display>
            <p className="mt-6 text-[15.5px] text-white/55">
              Trusted by teams whose security committee had to say yes first.
            </p>
          </Reveal>

          <Reveal delay={120}>
            <div className="grid grid-cols-2 overflow-hidden rounded-[18px] border border-white/[0.09] sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4">
              {MARKS.map((m, i) => (
                <div
                  key={m}
                  /* Every cell rules its own top and left edge; the outer
                     border of the panel supplies the rest, so no cell needs to
                     know whether it sits on an edge. */
                  className="border-b border-r border-white/[0.09] px-3 py-6 text-center text-[11.5px] font-medium leading-[1.4] text-white/70"
                  style={{ animationDelay: `${i * 40}ms` }}
                >
                  {m}
                </div>
              ))}
            </div>
          </Reveal>
        </div>

        <div className="mt-16 grid gap-9 border-t border-white/[0.10] pt-11 sm:grid-cols-2 lg:grid-cols-4">
          {PILLARS.map((p, i) => {
            const Icon = p.icon;
            return (
              <Reveal key={p.title} delay={i * 90}>
                <Icon className="h-5 w-5 text-white/70" />
                <h3 className="mt-5 text-[16.5px] font-medium leading-snug tracking-[-0.015em] text-white">
                  {p.title}
                </h3>
                <p className="mt-3.5 text-[13.5px] leading-[1.6] text-white/50">{p.body}</p>
              </Reveal>
            );
          })}
        </div>

        <Reveal delay={120}>
          <Link to="/solutions/governance" className="mt-12 inline-block">
            <Pill variant="light" className="px-6 py-3">
              Learn more about trust and safety
            </Pill>
          </Link>
        </Reveal>
      </div>
    </ToneSection>
  );
}
