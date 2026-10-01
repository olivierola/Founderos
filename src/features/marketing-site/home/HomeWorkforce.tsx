import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowsClockwiseIcon as ArrowsClockwise,
  BellRingingIcon as BellRinging,
  ChartLineUpIcon as ChartLineUp,
  CubeIcon as Cube,
  GaugeIcon as Gauge,
  HandPalmIcon as HandPalm,
  MoonStarsIcon as MoonStars,
  ShieldWarningIcon as ShieldWarning,
  SparkleIcon as Sparkle,
  UsersThreeIcon as UsersThree,
  RobotIcon as Robot,
  BookOpenTextIcon as BookOpen,
  ChatsCircleIcon as Chats,
  ListChecksIcon as ListChecks,
  ClockCountdownIcon as Clock,
  PlugsConnectedIcon as Plugs,
  ArrowUpRightIcon as ArrowUpRight,
} from "@phosphor-icons/react";
import { Reveal } from "../LandingKit";
import { SOLUTIONS } from "../solutions";
import { BrandLockup, Btn, CheckBadge, Container, Eyebrow, Heading, IconOrb, Lead, Section, Tag } from "../atlas/AtlasKit";

/* ══ The workforce ═══════════════════════════════════════════════════════════
   What you get: a tilted product screen beside the claim, then the six offers
   as cards, each with a small drawing of what that offer produces. The six
   come from solutions.ts — the same list the nav and the footer read. The
   lines inside the drawings are samples of what an agent says, not results.  */

function Shell({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`at-graphic relative h-[270px] overflow-hidden rounded-[26px] ${className}`}>{children}</div>
  );
}

function Bars({ side }: { side: "left" | "right" }) {
  return (
    <div className={`absolute top-1/2 flex -translate-y-1/2 items-center gap-[5px] ${side === "left" ? "left-4" : "right-4"}`}>
      {Array.from({ length: 11 }).map((_, i) => (
        <span
          key={i}
          className="w-[2px] rounded-full bg-[#d22eff]"
          style={{ height: `${14 + ((i * 29) % 56)}px`, opacity: 0.25 + ((i * 7) % 10) / 14 }}
        />
      ))}
    </div>
  );
}

const GRAPHICS: Record<string, () => ReactNode> = {
  readiness: () => (
    <Shell>
      <Bars side="left" />
      <Bars side="right" />
      <div className="absolute left-1/2 top-[44%] grid h-[170px] w-[170px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/60 ring-1 ring-[#f0e2f7]">
        <div className="grid h-[120px] w-[120px] place-items-center rounded-full bg-white/80 ring-1 ring-[#f0e2f7]">
          <IconOrb icon={Gauge} size={86} />
        </div>
      </div>
      <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2.5 whitespace-nowrap rounded-full bg-white py-1.5 pl-1.5 pr-4 text-[13px] text-[#666666] shadow-[0_10px_24px_-16px_rgba(17,16,17,0.45)]">
        <CheckBadge size={24} />
        Every process scored L1–L5
      </div>
    </Shell>
  ),
  agents: () => (
    <Shell>
      <div className="absolute inset-x-8 top-5 bottom-0 rounded-t-[28px] bg-white shadow-[0_20px_50px_-30px_rgba(17,16,17,0.5)]">
        <div className="flex flex-col items-center border-b border-[#f0f0f0] pb-3 pt-4">
          <IconOrb icon={Robot} size={38} />
          <div className="mt-1.5 text-[12.5px] font-semibold">
            Finance <span className="text-[#b01fe0]">agent</span>
          </div>
        </div>
        <div className="px-5 pt-4">
          <div className="ml-auto max-w-[85%] rounded-[16px] rounded-br-[6px] bg-[#111011] px-3.5 py-2.5 text-[12px] leading-snug text-white">
            Raise the credit note for invoice 1042.
          </div>
          <div className="mt-2.5 max-w-[92%] rounded-[16px] rounded-bl-[6px] bg-[#f7f7f7] px-3.5 py-2.5 text-[12px] leading-snug text-[#666666]">
            I can, but it is a write action on the ledger — it waits for your approval.
          </div>
        </div>
      </div>
    </Shell>
  ),
  foundation: () => (
    <Shell>
      <div className="absolute left-1/2 top-1/2 h-[330px] w-[330px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#efe1f6]" />
      <div className="absolute left-1/2 top-1/2 h-[240px] w-[240px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#efe1f6]" />
      <div className="absolute left-1/2 top-1/2 grid h-[84px] w-[84px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white shadow-[0_14px_30px_-18px_rgba(17,16,17,0.5)]">
        <ArrowsClockwise className="h-8 w-8 text-[#b01fe0]" />
      </div>
      <div className="absolute left-4 top-5 flex items-center gap-2.5 rounded-[16px] bg-white p-2 pr-3.5 shadow-[0_10px_24px_-16px_rgba(17,16,17,0.45)]">
        <IconOrb icon={Plugs} size={32} />
        <div className="text-[11.5px] leading-tight text-[#969696]">
          3 systems call
          <br />a field “client”
        </div>
      </div>
      <div className="absolute bottom-5 right-4 flex items-center gap-2.5 rounded-[16px] bg-white p-2 pr-3.5 shadow-[0_10px_24px_-16px_rgba(17,16,17,0.45)]">
        <IconOrb icon={ListChecks} size={32} />
        <div>
          <div className="text-[12.5px] font-semibold text-[#111011]">Mapped to one</div>
          <div className="text-[11.5px] text-[#969696]">disagreeing rows flagged</div>
        </div>
      </div>
    </Shell>
  ),
  adoption: () => (
    <Shell>
      <div className="absolute left-5 top-5 w-[70%] rounded-[18px] bg-white p-3.5 shadow-[0_10px_24px_-16px_rgba(17,16,17,0.45)]">
        <div className="flex items-center gap-2 text-[12px] font-semibold">
          <UsersThree className="h-4 w-4 text-[#b01fe0]" /> Usage by team
        </div>
        <div className="mt-1.5 text-[11.5px] leading-snug text-[#969696]">
          Nine of twelve champions used an agent this week. Finance has not.
        </div>
      </div>
      <svg viewBox="0 0 320 150" className="absolute bottom-6 left-4 right-4 w-[calc(100%-2rem)]" fill="none">
        <defs>
          <linearGradient id="at-adopt" x1="0" x2="1">
            <stop offset="0%" stopColor="#d22eff" />
            <stop offset="100%" stopColor="#8b16c4" />
          </linearGradient>
        </defs>
        <path d="M4 132 C 50 128, 70 110, 110 112 S 170 90, 200 78 S 250 40, 300 18" stroke="url(#at-adopt)" strokeWidth="2.5" />
        <circle cx="200" cy="78" r="5" fill="#d22eff" />
        <circle cx="300" cy="18" r="9" fill="white" stroke="#d22eff" strokeWidth="2.5" />
      </svg>
      <div className="absolute bottom-5 right-5 rounded-[16px] bg-white px-3 py-2 text-center shadow-[0_10px_24px_-16px_rgba(17,16,17,0.45)]">
        <ChartLineUp className="mx-auto h-5 w-5 text-[#b01fe0]" />
        <div className="text-[11.5px] font-semibold text-[#b01fe0]">per team</div>
      </div>
    </Shell>
  ),
  governance: () => (
    <Shell>
      <div className="absolute left-1/2 top-1/2 w-[82%] -translate-x-1/2 -translate-y-1/2 -rotate-3 rounded-[22px] bg-white p-4 shadow-[0_24px_50px_-28px_rgba(17,16,17,0.55)]">
        <div className="flex items-start justify-between gap-3">
          <ShieldWarning className="h-6 w-6 text-[#b01fe0]" />
          <IconOrb icon={HandPalm} size={40} />
        </div>
        <div className="mt-2 text-[14px] font-semibold tracking-[-0.02em]">Stopped: outside declared scope</div>
        <div className="mt-1 text-[12px] leading-snug text-[#969696]">
          This agent was about to touch personnel data. That is outside its declared scope.
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-[12px] bg-[#f7ecfc] px-3 py-2 text-[12px] font-medium text-[#8b16c4]">
          <BookOpen className="h-4 w-4" />
          Logged to the audit trail
        </div>
      </div>
    </Shell>
  ),
  managed: () => (
    <Shell className="!bg-none">
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 60% at 80% 10%, #f3c2ff 0%, transparent 55%), linear-gradient(200deg, #b01fe0 0%, #5b0d78 45%, #f7ecfc 100%)",
        }}
      />
      {[
        [18, 22],
        [62, 14],
        [40, 40],
        [84, 48],
        [26, 58],
      ].map(([x, y]) => (
        <span key={`${x}-${y}`} className="absolute h-1 w-1 rounded-full bg-white/80" style={{ left: `${x}%`, top: `${y}%` }} />
      ))}
      <MoonStars weight="fill" className="absolute right-6 top-5 h-12 w-12 text-white" />
      <div className="absolute bottom-4 left-4 right-10 rounded-[20px] bg-white p-3.5 shadow-[0_24px_50px_-24px_rgba(17,16,17,0.6)]">
        <div className="flex items-center gap-2.5">
          <IconOrb icon={Sparkle} size={32} />
          <div className="text-[13.5px] font-semibold tracking-[-0.02em]">Provider change handled</div>
        </div>
        <div className="mt-2.5 space-y-1.5 border-t border-[#f0f0f0] pt-2.5 text-[12px] text-[#969696]">
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5" /> Your four agents migrated overnight
          </div>
          <div className="flex items-center gap-2">
            <BellRinging className="h-3.5 w-3.5" /> Your team notified
          </div>
        </div>
      </div>
    </Shell>
  ),
};

/* The tilted product screen. Built, not screenshotted, so it stays sharp and
   stays in the palette; it is a drawing of the layout, not a status report. */
function TiltedScreen() {
  const items = [
    { icon: Gauge, label: "Dashboard", on: true },
    { icon: Robot, label: "Agents" },
    { icon: Chats, label: "Rooms" },
    { icon: BookOpen, label: "Knowledge" },
    { icon: HandPalm, label: "Approvals" },
    { icon: ListChecks, label: "Audit log" },
    { icon: Plugs, label: "Integrations" },
  ];
  return (
    <div
      className="relative h-[420px] overflow-hidden sm:h-[480px]"
      style={{
        WebkitMaskImage: "radial-gradient(ellipse 70% 70% at 45% 45%, #000 45%, transparent 80%)",
        maskImage: "radial-gradient(ellipse 70% 70% at 45% 45%, #000 45%, transparent 80%)",
      }}
    >
      <div className="absolute left-1/2 top-1/2" style={{ perspective: "1600px" }}>
        <div
          className="w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-[28px] border border-[#ecdff3] bg-white shadow-[-30px_40px_80px_-30px_rgba(210,46,255,0.45)]"
          style={{ transform: "translate(-50%, -50%) rotateX(52deg) rotateZ(-32deg)" }}
        >
          <div className="flex">
            <div className="w-[190px] border-r border-[#f0f0f0] p-4">
              <BrandLockup />
              <div className="mt-6 space-y-1">
                {items.map((it) => (
                  <div
                    key={it.label}
                    className={`flex items-center gap-2.5 rounded-full px-3 py-2 text-[13px] ${
                      it.on ? "bg-[#111011] font-semibold text-white" : "text-[#666666]"
                    }`}
                  >
                    <it.icon className="h-4 w-4" />
                    {it.label}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex-1 p-5">
              <div className="text-[18px] font-semibold tracking-[-0.03em]">Welcome back</div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#969696]">Your workforce</div>
              <div className="mt-4 space-y-2.5">
                {["Finance agent · reconciliation", "Report writer · Q3 draft", "Recruiting agent · screening"].map((t) => (
                  <div key={t} className="flex items-center justify-between rounded-[16px] border border-[#f0f0f0] px-3.5 py-3 text-[13px]">
                    <span className="flex items-center gap-2.5">
                      <span className="at-orb h-6 w-6 rounded-full" />
                      {t}
                    </span>
                    <ArrowUpRight className="h-4 w-4 text-[#969696]" />
                  </div>
                ))}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2.5">
                <div className="rounded-[16px] bg-[#f7ecfc] p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#8b16c4]">Waiting for you</div>
                  <div className="mt-1 text-[13px] font-semibold">Approvals</div>
                </div>
                <div className="rounded-[16px] bg-[#f7f7f7] p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#969696]">Recorded</div>
                  <div className="mt-1 text-[13px] font-semibold">Audit trail</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function HomeWorkforce() {
  return (
    <Section>
      <Container>
        <div className="grid items-center gap-8 lg:grid-cols-[1fr_1.1fr]">
          <Reveal>
            <Eyebrow icon={Cube} accent="workforce">
              The Anduran
            </Eyebrow>
            <Heading className="mt-8" lead="We don't sell you a chatbot." serif="we put a governed workforce to work" />
            <Lead className="mt-6 max-w-[44ch]">
              Six blocks, in the order they actually happen: find what is ready, secure the ground, put agents
              on it, make them used, keep them governed, keep them running. Take one, or take all six.
            </Lead>
          </Reveal>
          <Reveal delay={100}>
            <TiltedScreen />
          </Reveal>
        </div>

        <div className="mt-6 grid gap-3 rounded-[40px] md:grid-cols-2 lg:grid-cols-3">
          {SOLUTIONS.map((s, i) => {
            const Graphic = GRAPHICS[s.slug];
            return (
              <Reveal key={s.slug} delay={(i % 3) * 90} className="h-full">
                <Link
                  to={`/solutions/${s.slug}`}
                  className="group flex h-full flex-col rounded-[34px] border border-[#f0f0f0] bg-white p-2.5 shadow-[0_30px_60px_-50px_rgba(17,16,17,0.5)] transition-shadow duration-300 hover:shadow-[0_40px_70px_-40px_rgba(91,13,120,0.45)]"
                >
                  {Graphic ? <Graphic /> : <Shell>{null}</Shell>}
                  <div className="flex flex-1 flex-col px-5 pb-6 pt-6">
                    <Tag className="self-start">
                      Anduran&nbsp;<span className="at-grad-text">{s.nav}</span>
                    </Tag>
                    <h3 className="mt-5 text-[18px] font-semibold tracking-[-0.03em] text-[#111011]">{s.menu.label}</h3>
                    <p className="mt-3 text-[15px] font-light leading-[1.45] text-[#3d3c3d]">{s.lead}</p>
                    <span className="mt-auto inline-flex items-center gap-1.5 pt-5 text-[13.5px] font-semibold text-[#111011] transition-colors group-hover:text-[#8b16c4]">
                      See the detail
                      <ArrowUpRight weight="bold" className="h-3.5 w-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </Link>
              </Reveal>
            );
          })}
        </div>

        <div className="mt-12 flex justify-center">
          <Btn to="/contact" variant="light">
            Talk to us
          </Btn>
        </div>
      </Container>
    </Section>
  );
}
