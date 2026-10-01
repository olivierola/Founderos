import { CheckIcon as Check, ScalesIcon as Scales, XIcon as X } from "@phosphor-icons/react";
import { Reveal } from "../LandingKit";
import { Container, Section, SectionHead } from "../atlas/AtlasKit";

/* ══ The old way vs. Anduran ═════════════════════════════════════════════════
   The reference's comparison table: a grey tray, the row names and the old
   way on the left, the new way in a black-to-violet column on the right. Every
   line on the right is something the product does today.                    */

const ROWS = [
  {
    topic: "Security review",
    old: "An agent acting with whatever permissions it was handed.",
    now: "Scoped tool grants per agent; credentials encrypted, never sent back to the browser.",
  },
  {
    topic: "Write actions",
    old: "It sends, deletes or pays — and you find out afterwards.",
    now: "Every write stops in the conversation and waits for your approval.",
  },
  {
    topic: "Audit trail",
    old: "“The agent called read_url.” Nothing more.",
    now: "Arguments, result, duration and run — for every call, exportable.",
  },
  {
    topic: "Your data",
    old: "Copied into yet another platform before it is useful.",
    now: "Read where it lives. Nothing migrated, nothing duplicated.",
  },
  {
    topic: "The model",
    old: "Whatever the vendor runs, wherever it runs it.",
    now: "Cloud by default, or an OpenAI-compatible endpoint you host.",
  },
  {
    topic: "Integrations",
    old: "Rip-and-replace, or a second source of truth to keep in sync.",
    now: "Connectors on the stack you already run.",
  },
  {
    topic: "Adoption",
    old: "A licence bought for everyone, used by a few.",
    now: "Usage measured per team, on your own runs.",
  },
  {
    topic: "Governance",
    old: "A policy document nobody can check an agent against.",
    now: "Registry, risks, policies and controls kept in the product.",
  },
];

export function HomeCompare() {
  return (
    <Section>
      <Container>
        <Reveal>
          <SectionHead
            icon={Scales}
            eyebrow="The old way vs."
            accent="the Anduran way"
            lead="The old way vs."
            serif="a governed AI workforce"
            description="The usual way of putting AI to work costs you a security review, then a pilot, then a shrug. Here is what changes."
          />
        </Reveal>

        <Reveal delay={100}>
          <div className="relative mt-14 overflow-hidden rounded-[32px] bg-[#f7f7f7] p-2.5 sm:rounded-[40px] lg:p-3">
            {/* The violet column, drawn once behind the right-hand cells so
                it reads as one piece rather than eight stacked strips. */}
            <div
              aria-hidden
              className="absolute bottom-3 right-3 top-3 hidden w-[38%] rounded-[32px] lg:block"
              style={{ background: "linear-gradient(180deg, #000000 0%, #1a0226 16%, #5b0d78 50%, #b01fe0 80%, #d22eff 100%)" }}
            />
            <div className="relative">
              <div className="hidden grid-cols-[1fr_1.35fr_38%] lg:grid">
                <div />
                <div className="px-5 py-5 text-[16px] font-semibold tracking-[-0.02em] text-[#111011]">The old way</div>
                <div className="px-7 py-5 text-[16px] font-semibold tracking-[-0.02em] text-white">
                  The Anduran way
                </div>
              </div>
              {ROWS.map((r, i) => (
                <div
                  key={r.topic}
                  className={`grid gap-2 py-4 lg:grid-cols-[1fr_1.35fr_38%] lg:gap-0 lg:py-0 ${i ? "border-t border-[#e6e6e6] lg:border-t-0" : ""}`}
                >
                  <div className={`px-3 text-[15px] font-semibold tracking-[-0.01em] text-[#111011] lg:flex lg:items-center lg:px-5 lg:py-5 ${i ? "lg:border-t lg:border-[#e6e6e6]" : ""}`}>
                    {r.topic}
                  </div>
                  <div className={`flex items-center gap-3.5 px-3 lg:px-5 lg:py-4 ${i ? "lg:border-t lg:border-[#e6e6e6]" : ""}`}>
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white">
                      <X className="h-4 w-4 text-[#111011]" />
                    </span>
                    <span className="text-[14.5px] leading-[1.4] text-[#3d3c3d]">{r.old}</span>
                  </div>
                  <div
                    className="mx-1 flex items-center gap-3.5 rounded-[20px] px-3 py-3 lg:mx-0 lg:rounded-none lg:border-t lg:border-white/10 lg:px-7 lg:py-4"
                    style={
                      i === 0
                        ? { borderTopColor: "transparent" }
                        : undefined
                    }
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#111011] lg:bg-white/15">
                      <Check weight="bold" className="h-4 w-4 text-white" />
                    </span>
                    <span className="text-[14.5px] font-medium leading-[1.4] text-[#111011] lg:text-white">{r.now}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </Container>
    </Section>
  );
}
