import { Asterisk } from "lucide-react";

/* The block directly under the hero in the reference: a full-bleed row of
   service tags scrolling forever, separated by a small mark. */

const TAGS = [
  "Secured AI Agents",
  "Process Automation",
  "AI Governance",
  "Adoption & Enablement",
  "Readiness Assessment",
  "Managed Run",
];

export function LandingMarquee({ background }: { background: string }) {
  // Duplicated once so the -50% translate loops seamlessly.
  const track = [...TAGS, ...TAGS];

  return (
    <section className="relative overflow-hidden border-y border-black/10 py-7" style={{ background }}>
      <div className="mkt-marquee flex w-max items-center">
        {track.map((t, i) => (
          <span key={i} className="flex shrink-0 items-center">
            <span className="whitespace-nowrap px-7 text-[26px] font-medium tracking-[-0.02em] text-[#0d0d0d] sm:text-[34px]">
              {t}
            </span>
            <Asterisk className="h-5 w-5 shrink-0" style={{ color: "var(--amp-orange)" }} />
          </span>
        ))}
      </div>
    </section>
  );
}
