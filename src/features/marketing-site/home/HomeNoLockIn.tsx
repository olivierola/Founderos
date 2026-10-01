import { CheckCircleIcon as CheckCircle, SparkleIcon as Sparkle } from "@phosphor-icons/react";
import { Reveal } from "../LandingKit";
import { Container, Heading, Lead, Panel } from "../atlas/AtlasKit";

/* ══ The promise ═════════════════════════════════════════════════════════════
   The reference's guarantee panel. Ours is the commitment the method already
   makes — each phase ends with something you own and a decision you are free
   to take either way — set as a seal beside the sentence. */

function Seal() {
  return (
    <div className="relative mx-auto w-[240px] sm:w-[260px]">
      <div className="relative aspect-square rounded-full bg-[radial-gradient(circle_at_50%_40%,#2a0439_0%,#0b0010_70%)] p-3 shadow-[0_40px_80px_-30px_rgba(20,0,30,0.9)] ring-1 ring-white/20">
        <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full" aria-hidden>
          <defs>
            <path id="at-seal-arc" d="M 30 100 A 70 70 0 0 1 170 100" />
          </defs>
          <text className="fill-white/85" style={{ fontSize: 12, letterSpacing: 3, fontWeight: 600 }}>
            <textPath href="#at-seal-arc" startOffset="50%" textAnchor="middle">
              ANDURAN · NO LOCK-IN
            </textPath>
          </text>
        </svg>
        <div className="absolute inset-[22%] flex flex-col items-center justify-center rounded-[46%_46%_50%_50%/40%_40%_60%_60%] bg-[linear-gradient(180deg,#3d0757,#8b16c4)] text-center ring-1 ring-white/25">
          <div className="text-[34px] font-bold leading-none tracking-[-0.04em] text-white">Stop</div>
          <div className="mt-1.5 text-[10.5px] font-semibold uppercase leading-tight tracking-[0.12em] text-white/85">
            after any
            <br />
            phase
          </div>
          <Sparkle weight="fill" className="mt-2 h-3.5 w-3.5 text-white/80" />
        </div>
      </div>
      <div className="relative mx-auto -mt-4 flex w-fit items-center gap-2 whitespace-nowrap rounded-full bg-[#3d0757] px-4 py-2 text-[11.5px] font-medium text-white ring-1 ring-white/20">
        <CheckCircle className="h-4 w-4" /> No twelve-month contract
      </div>
    </div>
  );
}

export function HomeNoLockIn() {
  return (
    <section className="relative py-6">
      <Panel variant="accent" lit={[[10, 1], [11, 1], [12, 0], [13, 0], [14, 1], [15, 1], [9, 5], [10, 6], [13, 6]]}>
        <Container className="py-14 sm:py-16">
          <div className="grid items-center gap-12 lg:grid-cols-[0.8fr_1.2fr]">
            <Reveal>
              <Seal />
            </Reveal>
            <Reveal delay={100}>
              <Heading
                tone="white"
                lead="If a phase doesn't earn the next,"
                serif="you stop there. Period."
              />
              <Lead tone="white" className="mt-6 max-w-[54ch] font-normal">
                No twelve-month programme signed on day one. Each phase ends with something you own — a
                scored roadmap, a secured foundation, agents in production — and a decision you are free to
                make either way.
              </Lead>
            </Reveal>
          </div>
        </Container>
      </Panel>
    </section>
  );
}
