import { useEffect, useState } from "react";
import {
  ChatsCircleIcon as Chats,
  CheckIcon as Check,
  PlayIcon as Play,
  PlugsConnectedIcon as Plugs,
  ShieldCheckIcon as ShieldCheck,
  SparkleIcon as Sparkle,
  HandPalmIcon as HandPalm,
  StackIcon as Stack,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Btn, CheckChip, Container, Eyebrow, Heading, InfoPill, Lead, Panel } from "../atlas/AtlasKit";
import { ALL_TOOLS, ToolMark } from "../tools";

/* ══ The opening ═════════════════════════════════════════════════════════════
   The black-to-violet panel: the claim on the left, the product on the right
   in a glass card you can actually operate, three facts along the foot. Under
   it, the verifiable facts as check chips, and the tools it plugs into.

   The card shows two illustrative runs and the approval that interrupts them.
   It is labelled "Sample" on purpose — it demonstrates the mechanism, it does
   not report a customer's numbers.                                           */

type Mode = "run" | "approval";

const SAMPLES = [
  {
    title: "Reconcile March invoices",
    time: "01:12",
    steps: [
      "Read the invoices from the ledger",
      "Matched each line against its purchase order",
      "Flagged the lines that disagree — reason attached",
      "Drafted the credit note · waiting for your approval",
    ],
  },
  {
    title: "Draft the Q3 board report",
    time: "02:40",
    steps: [
      "Pulled the quarter's figures from your finance tools",
      "Compared them with the plan, line by line",
      "Wrote the narrative — every figure cites its source",
      "Exported the PDF · sent to you for review",
    ],
  },
];

function Wave({ bars = 26, className }: { bars?: number; className?: string }) {
  return (
    <div aria-hidden className={cn("at-wave flex items-center gap-[3px]", className)}>
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className="w-[2px] rounded-full bg-white/70"
          style={{
            height: `${10 + ((i * 37) % 26)}px`,
            animationDelay: `${(i % 7) * 0.12}s`,
            opacity: 0.35 + ((i * 13) % 10) / 16,
          }}
        />
      ))}
    </div>
  );
}

function AgentDemoCard() {
  const [mode, setMode] = useState<Mode>("run");
  const [active, setActive] = useState(0);
  const [done, setDone] = useState(0);
  const [approved, setApproved] = useState<null | boolean>(null);

  // Steps tick in one after another; the loop restarts on a new sample.
  useEffect(() => {
    setDone(0);
    if (mode !== "run") return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) {
      setDone(SAMPLES[active].steps.length);
      return;
    }
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      setDone(n);
      if (n >= SAMPLES[active].steps.length) clearInterval(t);
    }, 900);
    return () => clearInterval(t);
  }, [active, mode]);

  useEffect(() => setApproved(null), [mode]);

  const sample = SAMPLES[active];

  return (
    <div className="relative mx-auto w-full max-w-[460px]">
      {/* ── The switch ─────────────────────────────────────────────────── */}
      <div className="mx-auto mb-4 flex w-fit max-w-full items-center gap-2 rounded-full border border-white/10 bg-black/50 p-1.5 pl-3 pr-3 text-[14px] font-semibold text-white backdrop-blur-md sm:gap-3 sm:pl-4 sm:pr-4 sm:text-[15px]">
        <button
          type="button"
          onClick={() => setMode("run")}
          className={cn("flex items-center gap-2 transition-opacity", mode === "run" ? "opacity-100" : "opacity-45")}
        >
          <Chats className="h-5 w-5" />
          Agent run
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={mode === "approval"}
          aria-label="Switch between the agent run and the approval"
          onClick={() => setMode(mode === "run" ? "approval" : "run")}
          className="relative h-[34px] w-[70px] rounded-full bg-white/15 ring-1 ring-inset ring-white/20"
        >
          <span
            className={cn(
              "absolute top-[3px] h-[28px] w-[28px] rounded-full bg-white shadow-[0_4px_10px_rgba(0,0,0,0.4)] transition-all duration-300",
              mode === "run" ? "left-[3px]" : "left-[39px]",
            )}
          />
        </button>
        <button
          type="button"
          onClick={() => setMode("approval")}
          className={cn(
            "flex items-center gap-2 transition-opacity",
            mode === "approval" ? "opacity-100" : "opacity-45",
          )}
        >
          <ShieldCheck className="h-5 w-5" />
          Approval
        </button>
      </div>

      {/* ── The card ───────────────────────────────────────────────────── */}
      <div className="rounded-[36px] border border-white/15 bg-white/[0.07] p-5 shadow-[0_40px_80px_-40px_rgba(0,0,0,0.8)] backdrop-blur-xl">
        <div className="relative h-[228px] overflow-hidden rounded-[26px]">
          {mode === "run" ? (
            <div key={`run-${active}`} className="amp-in flex h-full flex-col">
              <div className="flex items-center gap-4">
                <span className="relative grid h-[58px] w-[58px] shrink-0 place-items-center">
                  <span className="at-pulse-ring absolute inset-0 rounded-full bg-[#d22eff]/40" />
                  <span className="at-orb-dark relative grid h-[58px] w-[58px] place-items-center rounded-full ring-1 ring-white/20">
                    <Sparkle weight="fill" className="h-5 w-5 text-white" />
                  </span>
                </span>
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-white/55">
                    Finance agent · live
                  </div>
                  <div className="truncate text-[16px] font-semibold tracking-[-0.02em] text-white">
                    {sample.title}
                  </div>
                </div>
              </div>
              <ul className="mt-5 space-y-2.5">
                {sample.steps.map((s, i) => {
                  const on = i < done;
                  const last = i === sample.steps.length - 1;
                  return (
                    <li
                      key={s}
                      className={cn(
                        "flex items-start gap-3 text-[13.5px] leading-snug transition-all duration-500",
                        on ? "translate-y-0 opacity-100" : "translate-y-1 opacity-30",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-px grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full",
                          on ? (last ? "bg-[#ffd76a]" : "bg-white") : "bg-white/20",
                        )}
                      >
                        {on && <Check weight="bold" className="h-2.5 w-2.5 text-[#111011]" />}
                      </span>
                      <span className={on ? "text-white" : "text-white/70"}>{s}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <div className="amp-in flex h-full flex-col justify-center">
              <div className="rounded-[22px] bg-white p-4 text-[#111011] shadow-[0_24px_50px_-24px_rgba(0,0,0,0.6)]">
                <div className="flex items-center justify-between">
                  <span className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-[#8b16c4]">
                    Approval required
                  </span>
                  <span className="rounded-full bg-[#f5f5f5] px-2.5 py-1 text-[11px] font-medium text-[#666666]">
                    write action
                  </span>
                </div>
                <div className="mt-2.5 text-[15px] font-semibold tracking-[-0.02em]">
                  Post a credit note to the finance ledger
                </div>
                <p className="mt-1.5 text-[12.5px] leading-snug text-[#666666]">
                  The invoice differs from its purchase order by more than your €50 rule. The line that broke
                  the match is attached.
                </p>
                <div className="mt-3.5 flex gap-2">
                  {approved === null ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setApproved(true)}
                        className="flex-1 rounded-full bg-black py-2 text-[13px] font-semibold text-white"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => setApproved(false)}
                        className="flex-1 rounded-full border border-[#e6e6e6] py-2 text-[13px] font-semibold"
                      >
                        Decline
                      </button>
                    </>
                  ) : (
                    <div className="amp-in flex w-full items-center gap-2 rounded-full bg-[#f7ecfc] px-3 py-2 text-[12.5px] font-medium text-[#5b0d78]">
                      <Check weight="bold" className="h-3.5 w-3.5" />
                      {approved ? "Approved — the agent resumes the run." : "Declined — nothing was written."}{" "}
                      Logged.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <Wave className="mx-auto mt-3 h-8 w-fit" />

        {/* ── The samples ──────────────────────────────────────────────── */}
        <div className="mt-3 space-y-2.5">
          {SAMPLES.map((s, i) => (
            <button
              key={s.title}
              type="button"
              onClick={() => {
                setMode("run");
                setActive(i);
              }}
              className={cn(
                "flex w-full items-center gap-3 rounded-[28px] border p-2.5 pr-5 text-left transition-colors",
                mode === "run" && i === active
                  ? "border-white/35 bg-white/[0.16]"
                  : "border-white/15 bg-white/[0.06] hover:bg-white/[0.1]",
              )}
            >
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/15">
                <Play weight="fill" className="h-4 w-4 text-white" />
              </span>
              <span className="min-w-0 flex-1 text-[14.5px] font-semibold leading-tight tracking-[-0.02em] text-white">
                Sample {i + 1}: “{s.title}”
              </span>
              <span className="shrink-0 text-[14.5px] font-semibold tabular-nums text-white">{s.time}</span>
            </button>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <Btn to="/contact" variant="white" className="w-full">
            Talk to us
          </Btn>
          <Btn to="/signup" variant="glass" className="w-full">
            Get started
          </Btn>
        </div>
      </div>
    </div>
  );
}

const MARKS = ALL_TOOLS.filter((t) =>
  ["Microsoft 365", "Salesforce", "HubSpot", "SAP", "Slack", "Notion", "Snowflake"].includes(t.name),
);

export function HomeHero() {
  return (
    <section className="relative pt-[70px]">
      <Panel variant="hero" lit={[[0, 0], [0, 1], [0, 2], [1, 3], [13, 2], [14, 4], [15, 5], [14, 6], [15, 7]]}>
        <Container className="pb-4 pt-12 sm:pt-16 lg:pt-20">
          <div className="grid items-center gap-12 lg:grid-cols-[1.15fr_1fr] lg:gap-10">
            <div className="min-w-0">
              <div className="amp-in" style={{ animationDelay: "40ms" }}>
                <Eyebrow icon={Sparkle} tone="glass">
                  The AI workforce that runs inside your own tenant
                </Eyebrow>
              </div>
              <div className="amp-in" style={{ animationDelay: "120ms" }}>
                <Heading
                  as="h1"
                  size="hero"
                  tone="white"
                  inline
                  className="mt-8 max-w-[17ch]"
                  lead="Put AI agents to work on your real systems,"
                  serif="& keep every action under your control."
                />
              </div>
              <div className="amp-in" style={{ animationDelay: "220ms" }}>
                <Lead tone="white" className="mt-7 max-w-[44ch] font-normal">
                  Most AI pilots demo well and never ship. Anduran puts a governed AI workforce inside your
                  tenant: agents that read your systems freely, stop for your approval before they write, and
                  leave every call in an audit log. No migration.
                </Lead>
              </div>
            </div>
            <div className="amp-in min-w-0" style={{ animationDelay: "320ms" }}>
              <AgentDemoCard />
            </div>
          </div>

          <div className="mt-14 grid gap-2.5 md:grid-cols-3 lg:mt-20">
            <InfoPill icon={Stack}>Runs inside your tenant</InfoPill>
            <InfoPill icon={HandPalm}>Every write waits for your approval</InfoPill>
            <InfoPill icon={Plugs}>No migration required</InfoPill>
          </div>
        </Container>
      </Panel>

      {/* ── The facts, and the stack ───────────────────────────────────────
          Things a reader can check in the product, not endorsements. The logos
          are connectors, labelled as such — never a customer strip. */}
      <Container className="mt-3">
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          <CheckChip>Tool access scoped per agent</CheckChip>
          <CheckChip>AES-256-GCM encryption at rest</CheckChip>
          <CheckChip>Exportable audit log</CheckChip>
          <CheckChip>Self-hostable model endpoint</CheckChip>
        </div>
        <div className="mt-2.5 rounded-[24px] bg-[#f7f7f7] p-2.5">
          <div className="px-3 pb-2.5 pt-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-[#969696]">
            Connects to the tools you already run
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {MARKS.map((t) => (
              <div
                key={t.name}
                className="group flex h-[64px] items-center justify-center gap-2.5 rounded-[18px] bg-white text-[#111011] transition-colors hover:text-[var(--brand)]"
                style={{ ["--brand" as string]: `#${t.hex}` }}
              >
                <ToolMark tool={t} size={22} />
                <span className="text-[14px] font-semibold tracking-[-0.02em]">{t.name}</span>
              </div>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}
