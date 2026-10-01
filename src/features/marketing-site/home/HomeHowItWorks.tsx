import {
  ArrowsClockwiseIcon as ArrowsClockwise,
  GaugeIcon as Gauge,
  QuestionIcon as Question,
  RobotIcon as Robot,
  StackIcon as Stack,
} from "@phosphor-icons/react";
import { Reveal } from "../LandingKit";
import { CheckBadge, Container, IconOrb, Panel, SectionHead } from "../atlas/AtlasKit";

/* ══ How it works ════════════════════════════════════════════════════════════
   The engagement as four steps on the black-to-violet ground: a numbered rail
   across the top, one glass card per phase, and the promise that each phase
   ends with something you own — so you are free to stop after any of them. */

const STEPS = [
  {
    icon: Gauge,
    when: "Weeks 1–3",
    title: "We score the ground",
    body: "Interviews with the people doing the work, a read of the systems they touch, every process rated L1 to L5.",
  },
  {
    icon: Stack,
    when: "Weeks 3–8",
    title: "We build the foundation",
    body: "Approvals that follow rules, documents in one place, one definition per business term.",
  },
  {
    icon: Robot,
    when: "Weeks 6–12",
    title: "We put agents to work",
    body: "Inside your tenant, behind your identity controls, one workflow at a time — each with a measure attached.",
  },
  {
    icon: ArrowsClockwise,
    when: "Ongoing",
    title: "We keep it standing",
    body: "Models change and agents drift. The same people who built it keep the platform current.",
  },
];

export function HomeHowItWorks() {
  return (
    <section className="relative py-6">
      <Panel variant="steps" lit={[[3, 0], [4, 0], [3, 1], [4, 1], [3, 2], [12, 3], [13, 3], [14, 4], [15, 4]]}>
        <Container className="pb-10 pt-12 sm:pt-16">
          <Reveal>
            <SectionHead
              tone="white"
              icon={Question}
              eyebrow="How it works?"
              lead="Four phases."
              serif="Stop after any of them."
            />
          </Reveal>

          {/* The rail. Four stops on one line, so the phases read as travel. */}
          <div className="relative mx-auto mt-16 hidden max-w-[1000px] lg:block" aria-hidden>
            <div className="absolute left-[12.5%] right-[12.5%] top-1/2 h-px -translate-y-1/2 bg-white/35" />
            <div className="relative grid grid-cols-4">
              {STEPS.map((_, i) => (
                <div key={i} className="flex justify-center">
                  <span className="grid h-[50px] w-[50px] place-items-center rounded-full bg-white/10 ring-1 ring-white/25 backdrop-blur">
                    <span className="grid h-8 w-8 place-items-center rounded-full bg-[#111011]/50 text-[13px] font-semibold text-white ring-1 ring-white/30">
                      {i + 1}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-10 grid gap-2.5 sm:grid-cols-2 lg:mt-5 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <Reveal key={s.title} delay={i * 90} className="h-full">
                <div className="flex h-full flex-col items-center rounded-[32px] bg-white/[0.14] px-6 pb-8 pt-8 text-center ring-1 ring-inset ring-white/15 backdrop-blur-md">
                  <IconOrb icon={s.icon} tone="dark" size={78} />
                  <span className="mt-6 rounded-full bg-white/20 px-3.5 py-2 text-[14px] font-semibold leading-none text-white">
                    {s.when}
                  </span>
                  <h3 className="mt-5 text-[18px] font-semibold tracking-[-0.03em] text-white">{s.title}</h3>
                  <p className="mt-3 text-[14.5px] leading-[1.4] text-white/90">{s.body}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <div className="mt-14 flex justify-center">
            <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 rounded-[28px] bg-white py-1.5 pl-1.5 pr-6 text-[14.5px] font-semibold tracking-[-0.01em] text-[#111011] shadow-[0_20px_40px_-24px_rgba(60,0,90,0.6)] sm:rounded-full">
              <CheckBadge />
              <span>No twelve-month programme.</span>
              <span className="hidden h-6 w-px bg-[#e6e6e6] sm:block" />
              <span>Nothing to migrate.</span>
              <span className="hidden h-6 w-px bg-[#e6e6e6] sm:block" />
              <span className="at-grad-text">Just agents in production.</span>
            </div>
          </div>
        </Container>
      </Panel>
    </section>
  );
}
