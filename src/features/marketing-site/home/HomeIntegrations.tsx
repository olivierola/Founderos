import { PlugsConnectedIcon as Plugs } from "@phosphor-icons/react";
import { Logo } from "@/components/Logo";
import { Reveal } from "../LandingKit";
import { ALL_TOOLS, ToolMark, type Tool } from "../tools";
import { Btn, Container, Section, SectionHead } from "../atlas/AtlasKit";

/* ══ Integrations ════════════════════════════════════════════════════════════
   The reference's hub: one orb in the middle, the tools on either side as
   pills, each tied to the centre by a dashed curve. Every pill is a real
   connector from tools.ts, in its brand colour. */

type Spot = { name: string; x: number; y: number };

// Positions on a 1200×520 board, the orb at (600, 290).
const SPOTS: Spot[] = [
  { name: "Microsoft 365", x: 110, y: 120 },
  { name: "Slack", x: 250, y: 205 },
  { name: "Salesforce", x: 120, y: 290 },
  { name: "Notion", x: 300, y: 330 },
  { name: "Google Workspace", x: 150, y: 420 },
  { name: "Jira", x: 330, y: 460 },
  { name: "HubSpot", x: 1080, y: 110 },
  { name: "SAP", x: 900, y: 200 },
  { name: "Snowflake", x: 1090, y: 280 },
  { name: "Okta", x: 880, y: 350 },
  { name: "GitHub", x: 1060, y: 430 },
  { name: "PostgreSQL", x: 860, y: 470 },
];

const CX = 600;
const CY = 290;

function Pill({ tool }: { tool: Tool }) {
  return (
    <div
      className="flex items-center gap-2 whitespace-nowrap rounded-full bg-white px-4 py-2.5 text-[13.5px] font-semibold tracking-[-0.02em] shadow-[0_14px_30px_-16px_rgba(17,16,17,0.45)] ring-1 ring-[#f0f0f0]"
      style={{ color: `#${tool.hex}` }}
    >
      <ToolMark tool={tool} size={18} />
      <span className="text-[#111011]">{tool.name}</span>
    </div>
  );
}

export function HomeIntegrations() {
  const byName = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t]));
  return (
    <Section>
      <Container>
        <Reveal>
          <SectionHead
            icon={Plugs}
            accent="Integrations"
            lead="Plugs into your stack."
            serif="No rip-and-replace."
            description="Agents speak to your systems through the same permissions your people have."
          />
          <div className="mt-8 flex justify-center">
            <Btn to="/integrations" variant="light">
              See every integration
            </Btn>
          </div>
        </Reveal>

        <Reveal delay={100}>
          {/* The board: fixed aspect so the curves and the pills stay aligned. */}
          <div className="relative mx-auto mt-10 hidden aspect-[1200/560] w-full max-w-[1200px] md:block">
            <svg viewBox="0 0 1200 560" className="absolute inset-0 h-full w-full" fill="none" aria-hidden>
              <defs>
                <linearGradient id="at-wire" x1="0" x2="1">
                  <stop offset="0%" stopColor="#d22eff" stopOpacity="0" />
                  <stop offset="50%" stopColor="#d22eff" stopOpacity="0.9" />
                  <stop offset="100%" stopColor="#d22eff" stopOpacity="0" />
                </linearGradient>
              </defs>
              {SPOTS.map((s) => {
                const mx = (s.x + CX) / 2;
                const d = `M ${s.x} ${s.y} C ${mx} ${s.y}, ${mx} ${CY}, ${CX} ${CY}`;
                return (
                  <g key={s.name}>
                    <path d={d} stroke="#d9d9d9" strokeWidth="1.2" strokeDasharray="4 5" />
                    <path d={d} stroke="url(#at-wire)" strokeWidth="1.4" strokeDasharray="4 8" className="at-dash" />
                  </g>
                );
              })}
            </svg>
            {/* The orb */}
            <div
              className="absolute grid -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white shadow-[0_30px_60px_-30px_rgba(17,16,17,0.5)]"
              style={{ left: `${(CX / 1200) * 100}%`, top: `${(CY / 560) * 100}%`, width: "16%", aspectRatio: "1" }}
            >
              <span className="absolute inset-[-10%] rounded-full border-t-2 border-[#d22eff]/40 at-spin-slow" />
              <span className="at-orb grid h-[55%] w-[55%] place-items-center rounded-full">
                <Logo size={30} color="#ffffff" />
              </span>
            </div>
            {SPOTS.map((s) => {
              const tool = byName[s.name];
              if (!tool) return null;
              return (
                <div
                  key={s.name}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${(s.x / 1200) * 100}%`, top: `${(s.y / 560) * 100}%` }}
                >
                  <Pill tool={tool} />
                </div>
              );
            })}
          </div>

          {/* Narrow screens: the same connectors, as a wrap of pills. */}
          <div className="mt-10 flex flex-wrap justify-center gap-2 md:hidden">
            {SPOTS.map((s) => byName[s.name] && <Pill key={s.name} tool={byName[s.name]} />)}
          </div>

          <div className="mt-6 flex justify-center">
            <span className="rounded-full border border-[#e3e3e3] bg-white px-6 py-3 text-[15px] font-semibold tracking-[-0.02em] shadow-[0_12px_30px_-20px_rgba(17,16,17,0.4)]">
              + <span className="at-grad-text">anything with an API.</span>
            </span>
          </div>
        </Reveal>
      </Container>
    </Section>
  );
}
