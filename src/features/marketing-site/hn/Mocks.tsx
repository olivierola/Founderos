import type { ReactNode } from "react";
import {
  BookOpenTextIcon as BookOpen,
  ChatsCircleIcon as Chats,
  CheckCircleIcon as CheckCircle,
  CheckIcon as Check,
  ClockIcon as Clock,
  GaugeIcon as Gauge,
  GearSixIcon as Gear,
  HandPalmIcon as HandPalm,
  ListChecksIcon as ListChecks,
  MagnifyingGlassIcon as Search,
  PlugsConnectedIcon as Plugs,
  PlusIcon as Plus,
  RobotIcon as Robot,
  ShieldCheckIcon as ShieldCheck,
  SquaresFourIcon as Squares,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { AgentBadge } from "./AgentBadge";
import { ALL_TOOLS, ToolMark } from "../tools";

/* ══ Product mockups ═════════════════════════════════════════════════════════
   The reference shows screenshots of its product. These are drawings of ours,
   built in JSX so they stay sharp, stay in the palette and never go stale with
   a release. Every row in them is SAMPLE content — no customer, no measured
   figure — and they are drawn small, the way a screenshot reads. */

const RAIL = [Squares, Robot, Chats, BookOpen, HandPalm, ListChecks, Gear];

export function MockWindow({
  title,
  children,
  active = 1,
  className,
  right,
}: {
  title: string;
  children: ReactNode;
  active?: number;
  className?: string;
  right?: ReactNode;
}) {
  return (
    <div className={cn("flex overflow-hidden rounded-[24px] border border-[#e6e9ef] bg-white text-[#0f1728] shadow-[0_30px_70px_-40px_rgba(0,30,90,0.5)]", className)}>
      <div className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-[#e6e9ef] py-3">
        {RAIL.map((I, i) => (
          <span key={i} className={cn("grid h-6 w-6 place-items-center rounded-[14px]", i === active ? "bg-[#eaf2ff] text-[#006edd]" : "text-[#8a94a6]")}>
            <I className="h-3.5 w-3.5" />
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="truncate text-[14px] font-semibold tracking-[-0.02em]">{title}</div>
          {right}
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

function Status({ s }: { s: "Running" | "Waiting" | "Done" | "Scheduled" }) {
  const map = {
    Running: "bg-[#eaf2ff] text-[#006edd]",
    Waiting: "bg-[#fff4e0] text-[#a15c00]",
    Done: "bg-[#e7f6ec] text-[#1a7f3c]",
    Scheduled: "bg-[#eef1f5] text-[#555]",
  } as const;
  return <span className={cn("rounded-full px-2 py-0.5 text-[9.5px] font-medium", map[s])}>{s}</span>;
}

const MISSIONS = [
  { name: "Reconcile March invoices", s: "Waiting", agent: "Finance collaborator", done: 3, of: 4 },
  { name: "Draft Q3 board report", s: "Running", agent: "Report writer", done: 2, of: 5 },
  { name: "Screen applicants, Ops lead", s: "Running", agent: "Recruiting collaborator", done: 41, of: 60 },
  { name: "Weekly pipeline hygiene", s: "Scheduled", agent: "Sales collaborator", done: 0, of: 1 },
  { name: "Supplier onboarding pack", s: "Done", agent: "Ops Cloud collaborator", done: 6, of: 6 },
  { name: "Contract clause extraction", s: "Done", agent: "Legal Cloud collaborator", done: 12, of: 12 },
] as const;

/** The missions table — the product's main list. */
export function MissionsMock({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <MockWindow
      title="Missions"
      className={className}
      right={
        <span className="flex items-center gap-1 rounded-[14px] bg-[#0b1220] px-2 py-1 text-[9.5px] font-medium text-white">
          <Plus className="h-2.5 w-2.5" /> New mission
        </span>
      }
    >
      <div className="grid grid-cols-4 gap-2">
        {[
          { l: "Running", v: "2" },
          { l: "Waiting for you", v: "1" },
          { l: "Scheduled", v: "1" },
          { l: "Done this week", v: "2" },
        ].map((k) => (
          <div key={k.l} className="rounded-[14px] bg-[#f7f8fb] px-2 py-1.5">
            <div className="text-[8.5px] text-[#4b5567]">{k.l}</div>
            <div className="text-[13px] font-semibold">{k.v}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-[14px] border border-[#e6e9ef] px-2 py-1 text-[9px] text-[#8a94a6]">
        <Search className="h-2.5 w-2.5" /> Search missions, Cloud collaborators…
      </div>
      <table className="mt-2 w-full text-left text-[9.5px]">
        <thead className="text-[#8a94a6]">
          <tr className="border-b border-[#e6e9ef]">
            <th className="py-1.5 font-normal">Mission</th>
            <th className="font-normal">Status</th>
            <th className="font-normal">Steps</th>
            <th className="hidden font-normal sm:table-cell">Cloud collaborator</th>
          </tr>
        </thead>
        <tbody>
          {MISSIONS.slice(0, rows).map((m) => (
            <tr key={m.name} className="border-b border-[#eef1f5]">
              <td className="max-w-[150px] truncate py-1.5 text-[#006edd]">{m.name}</td>
              <td><Status s={m.s} /></td>
              <td className="tabular-nums text-[#555]">{m.done} / {m.of}</td>
              <td className="hidden text-[#555] sm:table-cell">{m.agent}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 text-[8.5px] text-[#8a94a6]">Sample data</div>
    </MockWindow>
  );
}

/** A single run, with its steps and the approval that interrupts it. */
export function RunMock({ className }: { className?: string }) {
  const steps = [
    "Read the invoices from the ledger",
    "Matched each line against its purchase order",
    "Flagged 3 lines that disagree, reason attached",
  ];
  return (
    <div className={cn("rounded-[24px] border border-[#e6e9ef] bg-white p-4 text-[#0f1728] shadow-[0_30px_70px_-40px_rgba(0,30,90,0.5)]", className)}>
      <div className="flex items-center gap-2.5">
        <AgentBadge name="Finance collaborator" size={30} />
        <div>
          <div className="text-[12px] font-semibold tracking-[-0.01em]">Finance collaborator</div>
          <div className="text-[10px] text-[#4b5567]">Reconcile March invoices · sample</div>
        </div>
        <span className="ml-auto"><Status s="Waiting" /></span>
      </div>
      <ul className="mt-3 space-y-1.5">
        {steps.map((s) => (
          <li key={s} className="flex items-start gap-2 text-[10.5px] text-[#344054]">
            <CheckCircle weight="fill" className="mt-px h-3 w-3 shrink-0 text-[#1a7f3c]" />
            {s}
          </li>
        ))}
      </ul>
      <div className="mt-3 rounded-[12px] border border-[#ffe2b3] bg-[#fffaf0] p-2.5">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[#a15c00]">
          <HandPalm className="h-3 w-3" /> Approval required · write action
        </div>
        <div className="mt-1 text-[11px] font-medium">Post a credit note to the finance ledger</div>
        <div className="mt-2 flex gap-1.5">
          <span className="rounded-[14px] bg-[#006edd] px-2.5 py-1 text-[10px] font-medium text-white">Approve</span>
          <span className="rounded-[14px] border border-[#e6e9ef] px-2.5 py-1 text-[10px] font-medium">Decline</span>
        </div>
      </div>
    </div>
  );
}

const REGISTRY = [
  { agent: "Finance collaborator", risk: "Medium", scope: "Ledger · read, write*", policy: "Writes > €50 need approval" },
  { agent: "Recruiting collaborator", risk: "High", scope: "ATS · read", policy: "No automated rejection" },
  { agent: "Report writer", risk: "Low", scope: "Warehouse · read", policy: "Cite every figure" },
  { agent: "Support collaborator", risk: "Medium", scope: "Helpdesk · read, write*", policy: "Refunds need approval" },
  { agent: "Sales collaborator", risk: "Low", scope: "CRM · read, write*", policy: "Emails wait for review" },
];

/** The governance registry. */
export function RegistryMock({ className }: { className?: string }) {
  const tone = (r: string) =>
    r === "High" ? "bg-[#fdecec] text-[#b42318]" : r === "Medium" ? "bg-[#fff4e0] text-[#a15c00]" : "bg-[#e7f6ec] text-[#1a7f3c]";
  return (
    <MockWindow title="Governance registry" active={4} className={className} right={<span className="text-[9.5px] text-[#4b5567]">5 Cloud collaborators · sample</span>}>
      <table className="w-full text-left text-[9.5px]">
        <thead className="text-[#8a94a6]">
          <tr className="border-b border-[#e6e9ef]">
            <th className="py-1.5 font-normal">Cloud collaborator</th>
            <th className="font-normal">Risk</th>
            <th className="hidden font-normal sm:table-cell">Tool scope</th>
            <th className="font-normal">Policy</th>
          </tr>
        </thead>
        <tbody>
          {REGISTRY.map((r) => (
            <tr key={r.agent} className="border-b border-[#eef1f5]">
              <td className="py-1.5">
                <span className="flex items-center gap-1.5">
                  <AgentBadge name={r.agent} size={16} />
                  {r.agent}
                </span>
              </td>
              <td><span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-medium", tone(r.risk))}>{r.risk}</span></td>
              <td className="hidden text-[#555] sm:table-cell">{r.scope}</td>
              <td className="max-w-[140px] truncate text-[#555]">{r.policy}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 text-[8.5px] text-[#8a94a6]">* write actions are approval-gated</div>
    </MockWindow>
  );
}

/** One audited call, as the log shows it. */
export function AuditMock({ className }: { className?: string }) {
  const rows = [
    ["Tool", "ledger.create_credit_note"],
    ["Arguments", "{ invoice: 1042, amount: 180.00 }"],
    ["Result", "credit note CN-2291 created"],
    ["Approved by", "you · 14:02"],
    ["Duration", "1.4 s"],
    ["Run", "run_8f2c…  (open replay)"],
  ];
  return (
    <div className={cn("rounded-[24px] border border-[#e6e9ef] bg-white p-4 text-[#0f1728] shadow-[0_30px_70px_-40px_rgba(0,30,90,0.5)]", className)}>
      <div className="flex items-center gap-2 text-[12px] font-semibold">
        <ShieldCheck className="h-3.5 w-3.5 text-[#006edd]" /> Audit log · one call
      </div>
      <dl className="mt-3 space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[80px_1fr] gap-2 text-[10.5px]">
            <dt className="text-[#8a94a6]">{k}</dt>
            <dd className="truncate font-mono text-[10px] text-[#344054]">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 text-[8.5px] text-[#8a94a6]">Sample entry</div>
    </div>
  );
}

/** A conversation with an agent: the chat-bubble card the solution blocks use. */
export function ChatMock({
  agent,
  lines,
  className,
}: {
  agent: string;
  lines: { from: "you" | "agent"; text: string }[];
  className?: string;
}) {
  return (
    <div className={cn("w-full max-w-[340px] rounded-[18px] bg-white p-4 text-[#0f1728] shadow-[0_30px_60px_-30px_rgba(0,20,60,0.55)]", className)}>
      <div className="flex items-center gap-2 border-b border-[#eef1f5] pb-3">
        <AgentBadge name={agent} size={28} />
        <div className="text-[13px] font-semibold tracking-[-0.01em]">{agent}</div>
        <span className="ml-auto text-[10px] text-[#8a94a6]">sample</span>
      </div>
      <div className="mt-3 space-y-2">
        {lines.map((l, i) => (
          <div
            key={i}
            className={cn(
              "max-w-[88%] rounded-[18px] px-3 py-2 text-[12.5px] leading-[1.4]",
              l.from === "you" ? "ml-auto rounded-br-full bg-[#006edd] text-white" : "rounded-bl-full bg-[#f4f4f3] text-[#0f1728]",
            )}
          >
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── The six "how it works" screens ─────────────────────────────────────── */

export function StepTemplateMock() {
  const t = ["Finance collaborator", "Recruiting collaborator", "Support collaborator", "Report writer"];
  return (
    <MockWindow title="Create a new Cloud collaborator" active={1}>
      <div className="text-[10px] text-[#4b5567]">Start from a template</div>
      <div className="mt-2 grid grid-cols-4 gap-2">
        {t.map((n, i) => (
          <div key={n} className={cn("flex flex-col items-center rounded-[12px] border p-2", i === 0 ? "border-[#006edd] bg-[#f3f7fe]" : "border-[#e6e9ef]")}>
            <AgentBadge name={n} size={30} />
            <div className="mt-1.5 text-center text-[9px] leading-tight">{n}</div>
            <div className={cn("mt-1.5 w-full rounded-full py-0.5 text-center text-[8.5px]", i === 0 ? "bg-[#0b1220] text-white" : "border border-[#e6e9ef]")}>
              {i === 0 ? "Selected" : "Select"}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 text-[10px] text-[#4b5567]">Name</div>
      <div className="mt-1 rounded-[14px] border border-[#e6e9ef] px-2 py-1.5 text-[10.5px]">Finance collaborator, reconciliation</div>
    </MockWindow>
  );
}

export function StepInstructionsMock() {
  return (
    <MockWindow title="Instructions" active={1}>
      <div className="text-[10px] text-[#4b5567]">What is this Cloud collaborator's job?</div>
      <div className="mt-1 rounded-[14px] border border-[#e6e9ef] px-2 py-1.5 text-[10.5px]">Reconcile supplier invoices against purchase orders every month.</div>
      <div className="mt-2.5 rounded-[14px] border border-[#e6e9ef] bg-[#f7f8fb] p-2 font-mono text-[9.5px] leading-[1.55] text-[#344054]">
        # Goal
        <br />Match every invoice line to its PO.
        <br /># Rules
        <br />Flag differences above €50, with the reason.
        <br />Never write to the ledger without approval.
        <br /># Tone
        <br />Short, factual, cite the source document.
      </div>
    </MockWindow>
  );
}

export function StepConnectMock() {
  const tools = ALL_TOOLS.filter((t) => ["SAP", "Microsoft 365", "Slack", "Snowflake"].includes(t.name));
  return (
    <MockWindow title="Connectors" active={3}>
      <div className="space-y-1.5">
        {tools.map((t, i) => (
          <div key={t.name} className="flex items-center gap-2 rounded-[12px] border border-[#e6e9ef] px-2 py-1.5" style={{ color: `#${t.hex}` }}>
            <ToolMark tool={t} size={14} />
            <span className="text-[10.5px] text-[#0f1728]">{t.name}</span>
            <span className="ml-auto text-[9px] text-[#4b5567]">{i === 0 ? "read · write*" : "read"}</span>
            <span className={cn("h-3.5 w-6 rounded-full p-0.5", "bg-[#006edd]")}>
              <span className="ml-auto block h-2.5 w-2.5 rounded-full bg-white" />
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[8.5px] text-[#8a94a6]">* write tools stay behind approval</div>
    </MockWindow>
  );
}

export function StepGuardrailsMock() {
  return (
    <MockWindow title="Approvals & guardrails" active={4}>
      <div className="space-y-2">
        {[
          { t: "Write actions", d: "Ask a human first", on: true },
          { t: "Amount above €50", d: "Always ask, even if repeated", on: true },
          { t: "Personnel data", d: "Block, outside declared scope", on: true },
          { t: "Autonomous mode", d: "Off", on: false },
        ].map((r) => (
          <div key={r.t} className="flex items-center gap-2 rounded-[12px] border border-[#e6e9ef] px-2.5 py-2">
            <CheckCircle weight="fill" className={cn("h-3.5 w-3.5", r.on ? "text-[#1a7f3c]" : "text-[#d0d0d0]")} />
            <div>
              <div className="text-[10.5px] font-medium">{r.t}</div>
              <div className="text-[9px] text-[#4b5567]">{r.d}</div>
            </div>
          </div>
        ))}
      </div>
    </MockWindow>
  );
}

export function StepLiveMock() {
  return (
    <MockWindow title="Live" active={0}>
      <div className="space-y-1.5">
        {MISSIONS.slice(0, 4).map((m) => (
          <div key={m.name} className="flex items-center gap-2 rounded-[12px] border border-[#e6e9ef] px-2 py-1.5">
            <AgentBadge name={m.agent} size={18} />
            <span className="truncate text-[10.5px]">{m.name}</span>
            <span className="ml-auto"><Status s={m.s} /></span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1 text-[9px] text-[#4b5567]">
        <Clock className="h-2.5 w-2.5" /> Updated live · sample
      </div>
    </MockWindow>
  );
}

export function StepReviewMock() {
  return (
    <MockWindow title="Run detail" active={5}>
      <div className="grid gap-2 sm:grid-cols-[1fr_120px]">
        <div className="space-y-1">
          {["Read invoices", "Match lines to POs", "Flag 3 differences", "Credit note, approved", "Summary sent"].map((s) => (
            <div key={s} className="flex items-center gap-1.5 text-[10px] text-[#344054]">
              <Check weight="bold" className="h-2.5 w-2.5 text-[#1a7f3c]" /> {s}
            </div>
          ))}
        </div>
        <div className="rounded-[14px] bg-[#f7f8fb] p-2 text-[9px] leading-[1.6] text-[#555]">
          <div className="font-medium text-[#0f1728]">Run</div>
          Cloud collaborator: Finance collaborator
          <br />Calls: 14
          <br />Approvals: 1
          <br />Duration: 2m 10s
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1 text-[9px] text-[#4b5567]">
        <Gauge className="h-2.5 w-2.5" /> Every call logged · sample
      </div>
    </MockWindow>
  );
}

/** The tile grid of connector marks, tinted squares as on the reference. */
export function ToolGrid({ names, className }: { names?: string[]; className?: string }) {
  const list = (names ? ALL_TOOLS.filter((t) => names.includes(t.name)) : ALL_TOOLS.filter((t) => t.path).slice(0, 12));
  return (
    <div className={cn("grid grid-cols-4 gap-3 sm:grid-cols-6", className)}>
      {list.map((t) => (
        <div
          key={t.name}
          title={t.name}
          className="grid aspect-square place-items-center rounded-[24px] ring-1 ring-inset ring-black/[0.04]"
          style={{ background: `#${t.hex}1a`, color: `#${t.hex}` }}
        >
          <ToolMark tool={t} size={26} />
        </div>
      ))}
    </div>
  );
}

/** Small white sticker used on artwork panels. */
export function Sticker({ icon: I, children, className }: { icon?: typeof Plugs; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-[24px] bg-white px-3 py-2 text-[12px] font-medium text-[#0f1728] shadow-[0_14px_30px_-16px_rgba(0,20,60,0.5)]", className)}>
      {I && <I className="h-4 w-4 text-[#006edd]" />}
      {children}
    </div>
  );
}

/* ── Task card ──────────────────────────────────────────────────────────────
   One agent, one piece of work, its steps and where it stands. The visual for
   use cases and agent cards: it shows what the agent DOES, which is the point
   of the page, where a mascot only showed what it looks like. */
export function TaskCard({
  agent,
  title,
  steps,
  waiting,
  className,
}: {
  agent: string;
  title: string;
  steps: string[];
  /** The last line, shown as the step waiting for a human. */
  waiting?: string;
  className?: string;
}) {
  return (
    <div className={cn("w-full max-w-[360px] rounded-[18px] border border-white/60 bg-white p-4 text-[#0f1728] hn-shadow-lg", className)}>
      <div className="flex items-center gap-2.5">
        <AgentBadge name={agent} size={30} />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold tracking-[-0.01em]">{agent}</div>
          <div className="truncate text-[11.5px] text-[#4b5567]">{title}</div>
        </div>
      </div>
      <ul className="mt-3.5 space-y-2 border-t border-[#eef1f5] pt-3.5">
        {steps.map((s) => (
          <li key={s} className="flex items-start gap-2 text-[12px] leading-[1.4] text-[#344054]">
            <CheckCircle weight="fill" className="mt-px h-3.5 w-3.5 shrink-0 text-[#12b76a]" />
            {s}
          </li>
        ))}
        {waiting && (
          <li className="flex items-start gap-2 rounded-[12px] bg-[#fff8eb] px-2 py-1.5 text-[12px] font-medium leading-[1.4] text-[#93370d]">
            <HandPalm weight="fill" className="mt-px h-3.5 w-3.5 shrink-0" />
            {waiting}
          </li>
        )}
      </ul>
    </div>
  );
}

/** The two checks in front of every write: a verb list, then a judgement that
    can only add an approval. */
export function CheckPipelineMock({ className }: { className?: string }) {
  const rows = [
    { k: "Action", v: "crm.update_deal_stage", tone: "text-[#0f1728]" },
    { k: "Check 1 · verbs", v: "“update” → write action", tone: "text-[#0b5ed7]" },
    { k: "Check 2 · judgement", v: "changes customer data → approval", tone: "text-[#4447d6]" },
    { k: "Result", v: "Waiting for your approval", tone: "text-[#93370d]" },
  ];
  return (
    <div className={cn("w-full max-w-[380px] rounded-[18px] bg-white p-4 text-[#0f1728] hn-shadow-lg", className)}>
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <ShieldCheck weight="duotone" className="h-4 w-4 text-[#0b5ed7]" /> Before any write
      </div>
      <ol className="mt-3 space-y-0">
        {rows.map((r, i) => (
          <li key={r.k} className="relative flex gap-3 pb-3 last:pb-0">
            <span className="relative z-10 mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-full border border-[#cfd5df] bg-white text-[9px] font-semibold text-[#4b5567]">
              {i + 1}
            </span>
            {i < rows.length - 1 && <span aria-hidden className="absolute left-[7.5px] top-5 h-full w-px bg-[#e6e9ef]" />}
            <div className="min-w-0">
              <div className="text-[10.5px] text-[#8a94a6]">{r.k}</div>
              <div className={cn("truncate text-[12.5px] font-medium", r.tone)}>{r.v}</div>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-3 rounded-[12px] bg-[#f7f8fb] px-2.5 py-1.5 text-[10.5px] text-[#4b5567]">The second check can add an approval, never remove one.</div>
    </div>
  );
}

/** Where the keys live and which model runs the agent. */
export function KeysMock({ className }: { className?: string }) {
  return (
    <div className={cn("w-full max-w-[380px] rounded-[18px] bg-white p-4 text-[#0f1728] hn-shadow-lg", className)}>
      <div className="flex items-center gap-2 text-[13px] font-semibold">
        <Gear weight="duotone" className="h-4 w-4 text-[#0b5ed7]" /> Finance collaborator · runtime
      </div>
      <div className="mt-3 space-y-2">
        <div className="rounded-[12px] border border-[#e6e9ef] px-3 py-2">
          <div className="text-[10.5px] text-[#8a94a6]">Ledger credentials</div>
          <div className="mt-0.5 flex items-center justify-between text-[12px] font-medium">
            <span className="font-mono tracking-[0.1em]">••••••••••••</span>
            <span className="rounded-full bg-[#ecfdf3] px-2 py-0.5 text-[10px] font-medium text-[#067647]">AES-256-GCM</span>
          </div>
        </div>
        <div className="rounded-[12px] border border-[#e6e9ef] px-3 py-2">
          <div className="text-[10.5px] text-[#8a94a6]">Model endpoint</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-[#344054]">https://llm.internal.yourco.eu/v1</div>
          <div className="mt-1 text-[10.5px] text-[#4b5567]">OpenAI-compatible · hosted by you</div>
        </div>
      </div>
      <div className="mt-3 text-[10.5px] text-[#8a94a6]">Sample configuration</div>
    </div>
  );
}
