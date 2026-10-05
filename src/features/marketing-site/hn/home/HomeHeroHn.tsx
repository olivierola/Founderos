import type { ReactNode } from "react";
import {
  CheckCircleIcon as CheckCircle,
  HandPalmIcon as HandPalm,
  LockKeyIcon as LockKey,
} from "@phosphor-icons/react";
import { SOLUTIONS } from "../../solutions";
import { ALL_TOOLS, ToolMark } from "../../tools";
import { AgentBadge } from "../AgentBadge";
import { ArtPanel, Btn, Card, Container, H, P } from "../HnKit";
import { SOLUTION_ART } from "../site";

/* ══ The opening ═════════════════════════════════════════════════════════════
   As on the reference: a big left-aligned headline on the off-white ground,
   one line, one blue button, a small product card in the bottom-right corner;
   then a row of marks and three solution cards with artwork on top.

   The corner card is a real moment of the product — an approval waiting —
   where the reference has a video. It used to carry a play button that played
   nothing; a control that does nothing is the fastest way to look unfinished.

   The marks are the tools agents connect to — labelled as such. The reference
   shows its customers there; we show no customer strip until we have one. */

const MARQUEE = ALL_TOOLS;

/* The three solutions the home page leads with. */
const LEAD = ["agents", "foundation", "governance"];

function Glass({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`w-[250px] rounded-[18px] bg-white p-3.5 text-[#0f1728] hn-shadow-lg ${className}`}>{children}</div>
  );
}

const CARD_VISUAL: Record<string, ReactNode> = {
  agents: (
    <div className="flex h-full items-center justify-center">
      <Glass>
        <div className="flex items-center gap-2.5">
          <AgentBadge name="Finance agent" size={30} />
          <div>
            <div className="text-[12.5px] font-semibold">Finance agent</div>
            <div className="text-[11px] text-[#4b5567]">wants to write to the ledger</div>
          </div>
        </div>
        <div className="mt-3 rounded-[12px] bg-[#fff8eb] px-2.5 py-2 text-[11.5px] font-medium text-[#93370d]">
          Post credit note · €180.00
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-[11.5px] font-medium">
          <span className="rounded-[14px] border border-[#e6e9ef] py-1.5 text-center">Decline</span>
          <span className="rounded-[14px] bg-[#006edd] py-1.5 text-center text-white">Approve</span>
        </div>
      </Glass>
    </div>
  ),
  foundation: (
    <div className="flex h-full items-center justify-center">
      <Glass>
        <div className="text-[12.5px] font-semibold">Connected systems</div>
        <div className="mt-2.5 space-y-1.5">
          {ALL_TOOLS.filter((t) => ["SAP", "HubSpot", "Snowflake"].includes(t.name)).map((t) => (
            <div key={t.name} className="flex items-center gap-2 rounded-[12px] border border-[#e6e9ef] px-2.5 py-1.5" style={{ color: `#${t.hex}` }}>
              <ToolMark tool={t} size={13} />
              <span className="text-[11.5px] text-[#0f1728]">{t.name}</span>
              <span className="ml-auto text-[10px] text-[#4b5567]">read</span>
              <CheckCircle weight="fill" className="h-3.5 w-3.5 text-[#12b76a]" />
            </div>
          ))}
        </div>
        <div className="mt-2.5 text-[10.5px] text-[#4b5567]">Read where it lives · nothing migrated</div>
      </Glass>
    </div>
  ),
  governance: (
    <div className="flex h-full items-center justify-center">
      <Glass>
        <div className="flex items-center gap-2 text-[12.5px] font-semibold">
          <LockKey weight="duotone" className="h-4 w-4 text-[#4447d6]" /> Policy · Finance agent
        </div>
        {["Writes need approval", "Amounts above €50 always ask", "Personnel data blocked"].map((r) => (
          <div key={r} className="mt-2 flex items-center gap-2 text-[11.5px] text-[#344054]">
            <CheckCircle weight="fill" className="h-3.5 w-3.5 text-[#12b76a]" /> {r}
          </div>
        ))}
        <div className="mt-3 rounded-[12px] bg-[#f7f8fb] px-2.5 py-1.5 text-[10.5px] text-[#4b5567]">Every call logged and exportable</div>
      </Glass>
    </div>
  ),
};

export function HomeHeroHn() {
  const lead = LEAD.map((slug) => SOLUTIONS.find((s) => s.slug === slug)!).filter(Boolean);
  return (
    <section className="bg-[#f7f8fb]">
      <Container>
        <div className="relative pb-10 pt-16 sm:pt-24 lg:pb-14 lg:pt-32">
          <div className="amp-in max-w-[860px]">
            <H as="h1" size="hero">
              Put AI agents to work. Keep every decision yours.
            </H>
            <P className="mt-6 max-w-[560px]">
              Anduran deploys AI agents inside your own tenant. They work in the tools you already use, ask before
              they change anything, and record every step for review.
            </P>
            <div className="mt-10 flex flex-wrap items-center gap-5">
              <Btn to="/contact">Book a demo</Btn>
              <Btn to="/product/agents" variant="link">See how it works</Btn>
            </div>
          </div>

          {/* The corner card — an approval waiting, where the reference has a video. */}
          <Card className="amp-in mt-12 w-full max-w-[300px] p-2 hn-shadow lg:absolute lg:bottom-14 lg:right-0 lg:mt-0">
            <ArtPanel art="blue" className="flex h-[150px] items-center justify-center rounded-[14px] px-4">
              <div className="w-full rounded-[24px] bg-white p-2.5 text-[#0f1728] hn-shadow-lg">
                <div className="flex items-center gap-2">
                  <AgentBadge name="Finance agent" size={22} />
                  <span className="text-[11.5px] font-semibold">Approval required</span>
                  <span className="ml-auto text-[10px] text-[#8a94a6]">now</span>
                </div>
                <div className="mt-1.5 text-[11px] text-[#4b5567]">Post a credit note to the ledger</div>
                <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10.5px] font-medium">
                  <span className="rounded-[14px] border border-[#e6e9ef] py-1 text-center">Decline</span>
                  <span className="rounded-[14px] bg-[#006edd] py-1 text-center text-white">Approve</span>
                </div>
              </div>
            </ArtPanel>
            <div className="flex items-center justify-center gap-2 py-3 text-[13px] font-medium text-[#0f1728]">
              <HandPalm weight="duotone" className="h-4 w-4 text-[#006edd]" />
              Every write waits for you
            </div>
          </Card>
        </div>

        {/* ── The marks ─────────────────────────────────────────────────────── */}
        <div className="pb-8">
          <div className="mb-4 text-[14px] text-[#4b5567]">Works with the tools your teams already run</div>
          <div
            className="overflow-hidden"
            style={{ WebkitMaskImage: "linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)", maskImage: "linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)" }}
          >
            <div className="hn-marquee gap-14">
              {[...MARQUEE, ...MARQUEE].map((t, i) => (
                <span key={`${t.name}-${i}`} className="flex shrink-0 items-center gap-2 text-[#7a8496]">
                  {(t.path || t.logo) && <span style={{ color: `#${t.hex}` }} className="flex"><ToolMark tool={t} size={22} /></span>}
                  <span className="text-[18px] font-semibold tracking-[-0.02em]">{t.name}</span>
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* ── The three solution cards ──────────────────────────────────────── */}
        <div className="grid gap-6 pb-14 md:grid-cols-3">
          {lead.map((s) => (
            <Card key={s.slug} hover className="overflow-hidden hn-shadow">
              <ArtPanel art={SOLUTION_ART[s.slug] ?? "blue"} className="h-[250px] sm:h-[290px]">
                {CARD_VISUAL[s.slug]}
              </ArtPanel>
              <div className="p-5 pb-6">
                <h3 className="text-[20px] font-medium leading-[1.3] text-[#0f1728]">{s.menu.label}</h3>
                <p className="mt-1 max-w-[360px] text-[18px] leading-[1.3] text-[#4b5567]">{s.menu.blurb}</p>
                <Btn to={`/solutions/${s.slug}`} variant="link" className="mt-5">
                  Learn about {s.nav.toLowerCase()}
                </Btn>
              </div>
            </Card>
          ))}
        </div>
      </Container>
    </section>
  );
}
