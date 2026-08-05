import { Check, X } from "lucide-react";
import { ACCENT, ON_ACCENT, Reveal, SectionHead } from "./LandingKit";

const COMPARISON = [
  {
    axis: "Approach",
    them: { title: "Requirements-First", body: "Acquire requirements first, figure out value later" },
    us: { title: "Value-driven", body: "Maturity assessment first, prioritised roadmap second" },
  },
  {
    axis: "Time-to-Value",
    them: { title: "Long Runways", body: "Months of pilots that do not scale" },
    us: { title: "First results in weeks", body: "First secured milestone in 4–8 weeks" },
  },
  {
    axis: "Security",
    them: { title: "Bolted On Later", body: "Postponed after deployment" },
    us: { title: "Secure By Design", body: "Enterprise grade control from day one" },
  },
  {
    axis: "Governance",
    them: { title: "Partner-Dependent", body: "Discovered during the first audit finding" },
    us: { title: "Governed From Day One", body: "Designed before the first agent is built" },
  },
  {
    axis: "Adoption",
    them: { title: "Client Carries Risk", body: "Training sessions then set to be used" },
    us: { title: "Adoption Built In", body: "Structured journey with measurable usage" },
  },
];

export function LandingComparison() {
  return (
    <section className="amp-light relative" style={{ background: "#f7f7f7" }}>
      <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
        <div className="amp-rails relative py-24 sm:py-28">
          <SectionHead
            eyebrow="Comparison"
            title="A Different Approach to AI"
            lead="See why leading companies choose us over traditional consultancies."
            center
          />

          <Reveal className="relative mt-16">
            {/* The "them" table */}
            <div className="amp-card-light overflow-hidden rounded-2xl lg:mr-[300px]">
              <div className="grid grid-cols-[130px_1fr] border-b border-[rgba(0,0,7,0.07)] sm:grid-cols-[190px_1fr]">
                <div />
                <div className="px-6 py-5 text-[17px] text-[var(--amp-faint)]">Traditional IT Consultancies</div>
              </div>
              {COMPARISON.map((row, i) => (
                <div
                  key={row.axis}
                  className={`grid grid-cols-[130px_1fr] sm:grid-cols-[190px_1fr] ${
                    i < COMPARISON.length - 1 ? "border-b border-[rgba(0,0,7,0.07)]" : ""
                  }`}
                >
                  <div className="flex items-center px-5 py-6 text-[15px] sm:px-8">{row.axis}</div>
                  <div className="border-l border-[rgba(0,0,7,0.07)] px-6 py-6">
                    <div className="flex items-center gap-2.5">
                      <X className="h-4 w-4 shrink-0 rounded-full bg-[rgba(0,0,7,0.06)] p-0.5 text-[var(--amp-faint)]" />
                      <span className="text-[16px] text-[var(--amp-muted)]">{row.them.title}</span>
                    </div>
                    <p className="mt-1.5 pl-[26px] text-[14px] text-[var(--amp-faint)]">{row.them.body}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* The "us" card, floating over the table */}
            <div
              className="mt-6 rounded-2xl p-6 lg:absolute lg:right-0 lg:top-1/2 lg:mt-0 lg:w-[420px] lg:-translate-y-1/2 lg:p-7"
              style={{ background: ACCENT, color: ON_ACCENT, boxShadow: "0 24px 60px -20px rgba(255,77,0,0.45)" }}
            >
              {/* Everything inherits the white ink set on the card. */}
              <div className="text-[16px] font-bold uppercase tracking-[0.02em]">AchiCorp</div>
              <div className="mt-5 space-y-5">
                {COMPARISON.map((row) => (
                  <div key={row.axis} className="flex gap-3">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/60">
                      <Check className="h-3 w-3" />
                    </span>
                    <div>
                      <div className="text-[16px] font-semibold">{row.us.title}</div>
                      <div className="mt-0.5 text-[14px] leading-snug opacity-80">{row.us.body}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
