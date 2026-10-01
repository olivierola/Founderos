import { ShieldCheckIcon as ShieldCheck } from "@phosphor-icons/react";
import { Reveal } from "../LandingKit";
import { CheckChip, Container, Eyebrow, Heading, Lead, Section } from "../atlas/AtlasKit";

/* ══ The principle ═══════════════════════════════════════════════════════════
   Where the reference puts an endorsement, we put the rule the product runs
   on — stated once, large, and then shown: the panel where a write action is
   bound to a policy, framed like a film still. We have no one to quote yet,
   and a quote we wrote ourselves would be the first thing a buyer discounts.  */

function PolicyPanel() {
  const options = ["Check the data-residency policy", "Use the knowledge base", "Run the action", "Ask a human first"];
  const chosen = 3;
  return (
    <div className="w-full max-w-[400px] rounded-[26px] bg-white p-6 text-[#111011] shadow-[0_50px_100px_-40px_rgba(0,0,0,0.85)]">
      <div className="text-[13.5px] text-[#666666]">When an agent wants to</div>
      <div className="mt-2 rounded-[14px] border border-[#e6e6e6] bg-[#fafafa] px-4 py-3 text-[14.5px] font-medium">
        Write to the finance ledger
      </div>
      <div className="mt-6 text-[13.5px] text-[#666666]">It must first:</div>
      <div className="mt-3 space-y-2.5">
        {options.map((o, i) => (
          <div key={o} className="flex items-center gap-3 text-[14px]">
            <span
              className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-2 ${
                i === chosen ? "border-[#8b16c4]" : "border-black/15"
              }`}
            >
              {i === chosen && <span className="h-[8px] w-[8px] rounded-full bg-[#8b16c4]" />}
            </span>
            <span className={i === chosen ? "font-medium text-[#111011]" : "text-[#969696]"}>{o}</span>
          </div>
        ))}
      </div>
      <div className="mt-6 text-[13.5px] text-[#666666]">Tell the agent how to judge it</div>
      <div className="mt-2 rounded-[14px] border border-[#e6e6e6] bg-[#fafafa] px-4 py-3 text-[14px] leading-[1.45]">
        Only when the invoice matches the purchase order within €50.
      </div>
      <div className="mt-5 flex items-start gap-3">
        <span className="at-orb grid h-8 w-8 shrink-0 place-items-center rounded-full text-[12px] font-semibold text-white">
          A
        </span>
        <p className="rounded-[16px] rounded-tl-[6px] bg-[#f7ecfc] px-4 py-3 text-[13.5px] leading-[1.45] text-[#3d0757]">
          Understood. Anything above €50 stops and waits for you, and I will say which line broke the match.
        </p>
      </div>
    </div>
  );
}

export function HomePrinciple() {
  return (
    <Section className="bg-[linear-gradient(180deg,#ffffff_0%,#fafafa_100%)]">
      <Container>
        <Reveal className="flex flex-col items-center text-center">
          <Eyebrow icon={ShieldCheck} accent="runs under">
            The rule every agent
          </Eyebrow>
          <Heading
            className="mt-8 max-w-[24ch]"
            lead="“Read freely. Write only with your approval. Keep a trace of everything.”"
          />
          <Lead tone="ink" className="mt-6 max-w-[62ch] text-[15.5px] sm:text-[16px]">
            That is the whole contract between you and an Anduran agent. Reading never interrupts you;
            anything that writes, sends, deletes or pays stops in the conversation and waits — unless you
            switch that agent to autonomous mode yourself.
          </Lead>
        </Reveal>

        <Reveal delay={120}>
          <div className="relative mx-auto mt-14 max-w-[1000px] overflow-hidden rounded-[32px] shadow-[0_60px_120px_-60px_rgba(17,16,17,0.6)] sm:rounded-[40px]">
            <img
              src="/landing/scale.jpg"
              alt=""
              aria-hidden
              className="absolute inset-0 h-full w-full object-cover"
              style={{ objectPosition: "60% 45%" }}
            />
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                background:
                  "radial-gradient(ellipse 60% 70% at 50% 60%, rgba(17,0,24,0.35), rgba(8,0,12,0.78)), linear-gradient(180deg, rgba(210,46,255,0.12), rgba(0,0,0,0.3))",
              }}
            />
            <div className="relative flex justify-center px-5 py-12 sm:px-10 sm:py-16">
              <PolicyPanel />
            </div>
          </div>
        </Reveal>

        <Reveal delay={160} className="mt-14 flex flex-col items-center text-center">
          <p className="at-serif max-w-[34ch] text-[26px] leading-[1.15] text-[#111011] sm:text-[30px]">
            “Anything above €50 stops and waits for you, and I will say which line broke the match.”
          </p>
          <p className="mt-3 text-[14.5px] text-[#111011]">— An agent, reading the policy you wrote</p>
        </Reveal>

        <Reveal delay={200} className="mt-12 grid gap-2.5 md:grid-cols-3">
          <CheckChip>Reads run directly</CheckChip>
          <CheckChip>Writes wait in the conversation</CheckChip>
          <CheckChip>Autonomous only if you switch it on</CheckChip>
        </Reveal>
      </Container>
    </Section>
  );
}
