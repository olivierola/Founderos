import {
  ClipboardTextIcon as ClipboardText,
  InfoIcon as Info,
  LockKeyIcon as LockKey,
  TreeStructureIcon as TreeStructure,
  UsersThreeIcon as UsersThree,
  WarningIcon as Warning,
  GaugeIcon as Gauge,
} from "@phosphor-icons/react";
import { Reveal } from "../LandingKit";
import { Container, Eyebrow, Heading, IconDisc, Lead, Section } from "../atlas/AtlasKit";

/* ══ The problem ═════════════════════════════════════════════════════════════
   Why pilots stall, as four plain points — no market statistic, because we
   have not measured one — and beside them the thing we do about it: the
   readiness scan, drawn as the product draws it. The rows are a sample. */

const POINTS = [
  {
    icon: LockKey,
    text: "The security conversation is where most agent projects die: nobody can say where the credentials live, what the agent may touch, or who approved its last write.",
  },
  {
    icon: TreeStructure,
    text: "A well-built assistant on a badly-built process is the same process, faster. Approval rules scattered across three inboxes do not become rules because an agent reads them.",
  },
  {
    icon: UsersThree,
    text: "A licence paid for twelve months and used for one. Adoption happens between colleagues, not in a training room — and usually nobody is measuring it.",
  },
  {
    icon: ClipboardText,
    text: "“The agent called read_url” does not answer an auditor. Without the arguments, the result and the run behind each call, there is a log — not a trail.",
  },
];

const ROWS = [
  { name: "Order-to-cash", note: "Approvals live in three inboxes", level: "L2", bad: true },
  { name: "Supplier onboarding", note: "No single document store", level: "L2", bad: true },
  { name: "Invoice matching", note: "Ready for an agent", level: "L4", bad: false },
  { name: "Month-end close", note: "Needs one business glossary", level: "L3", bad: false },
];

function ReadinessGraphic() {
  const r = 78;
  const c = 2 * Math.PI * r;
  const share = 2 / 5;
  return (
    <div className="relative mx-auto w-full max-w-[540px]">
      <div className="overflow-hidden rounded-[36px] bg-[linear-gradient(180deg,#b01fe0_0%,#5b0d78_22%,#f7ecfc_23%,#ffffff_60%)] p-1 shadow-[0_50px_100px_-60px_rgba(91,13,120,0.8)]">
        <div className="h-[92px]" />
        <div className="rounded-[32px] bg-white/90 p-3 backdrop-blur">
          <div className="flex items-center gap-3 rounded-[22px] bg-white px-3 py-3 shadow-[0_10px_30px_-20px_rgba(17,16,17,0.4)]">
            <span className="grid h-11 w-11 place-items-center rounded-full bg-[#f3f3f3]">
              <Gauge className="h-5 w-5" />
            </span>
            <div>
              <div className="text-[15px] font-semibold tracking-[-0.02em] text-[#111011]">Readiness scan</div>
              <div className="text-[12.5px] text-[#666666]">Sample · every process scored L1–L5</div>
            </div>
          </div>
          <div className="mt-2 space-y-2">
            {ROWS.map((row, i) => (
              <div
                key={row.name}
                className="flex items-center gap-3 rounded-[18px] bg-[#fafafa] px-3.5 py-3"
                style={{ opacity: i === ROWS.length - 1 ? 0.45 : 1 }}
              >
                <span
                  className={`grid h-8 min-w-[38px] place-items-center rounded-full px-2 text-[12px] font-bold ${
                    row.bad ? "bg-[#ffe8ea] text-[#d4252f]" : "bg-[#f7ecfc] text-[#8b16c4]"
                  }`}
                >
                  {row.level}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={`text-[14px] font-semibold ${row.bad ? "text-[#d4252f]" : "text-[#111011]"}`}>
                    {row.name}
                  </div>
                  <div className="truncate text-[12.5px] text-[#969696]">{row.note}</div>
                </div>
                <Info className="h-5 w-5 shrink-0 text-[#969696]" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* The gauge, overlapping the head of the card as in the reference. */}
      <div className="absolute -top-6 right-2 w-[220px] rounded-[30px] bg-white p-4 shadow-[0_30px_60px_-30px_rgba(17,16,17,0.55)] sm:right-6 sm:w-[240px]">
        <div className="relative mx-auto aspect-square w-full">
          <svg viewBox="0 0 200 200" className="h-full w-full -rotate-90">
            <defs>
              <linearGradient id="at-gauge" x1="0" x2="1" y1="0" y2="1">
                <stop offset="0%" stopColor="#f0a8ff" />
                <stop offset="100%" stopColor="#5b0d78" />
              </linearGradient>
            </defs>
            <circle cx="100" cy="100" r={r} fill="none" stroke="#ededed" strokeWidth="18" strokeDasharray="3 5" />
            <circle
              cx="100"
              cy="100"
              r={r}
              fill="none"
              stroke="url(#at-gauge)"
              strokeWidth="18"
              strokeLinecap="round"
              strokeDasharray={`${c * share} ${c}`}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <Warning className="h-5 w-5 text-[#111011]" />
            <div className="at-grad-figure mt-1 text-[40px] font-bold leading-none tracking-[-0.05em]">L2</div>
            <div className="mt-1 text-[11.5px] text-[#969696]">Order-to-cash</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function HomeProblem() {
  return (
    <Section>
      <Container>
        <div className="grid items-center gap-14 lg:grid-cols-2 lg:gap-16">
          <Reveal>
            <Eyebrow icon={Warning} accent="pilot trap">
              The
            </Eyebrow>
            <Heading className="mt-8" lead="Your AI pilot demoed well" serif="then it never shipped." />
            <Lead tone="ink" className="mt-6 max-w-[48ch] text-[16.5px]">
              Most agent projects do not fail on the model. They stall on the ground under it — and the
              ground is the part nobody scoped.
            </Lead>
            <ul className="mt-10 space-y-6">
              {POINTS.map((p) => (
                <li key={p.text} className="flex gap-4">
                  <IconDisc icon={p.icon} size={48} />
                  <p className="pt-1 text-[15px] font-light leading-[1.45] text-[#3d3c3d]">{p.text}</p>
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal delay={120} className="pt-8 lg:pt-0">
            <ReadinessGraphic />
          </Reveal>
        </div>
      </Container>
    </Section>
  );
}
