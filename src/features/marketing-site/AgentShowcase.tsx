import type { ReactNode } from "react";
import {
  Bot,
  Check,
  Clock,
  CreditCard,
  Database,
  FileText,
  GitBranch,
  Layers,
  Loader2,
  Server,
  ShieldCheck,
} from "lucide-react";

const ORANGE = "#68bbfb";

const INTEGRATIONS = [
  { icon: CreditCard, label: "Stripe" },
  { icon: Server, label: "Vercel" },
  { icon: GitBranch, label: "GitHub" },
  { icon: Database, label: "Supabase" },
];

const TOOLS = ["issue_refund", "deploy_web", "transfer_to_human"];

const RUN_STEPS = [
  { label: "Planned 4 steps", done: true },
  { label: "Refunded $420.00", done: true },
  { label: "Redeployed web@prod", done: true },
  { label: "Emailing the customer…", done: false },
];

const AUDIT = [
  { time: "09:41", actor: "agent", action: "refund.issued", detail: "$420.00" },
  { time: "09:41", actor: "agent", action: "vercel.deploy", detail: "web@prod" },
  { time: "09:42", actor: "human", action: "approval.grant", detail: "Léa V." },
  { time: "09:42", actor: "agent", action: "email.sent", detail: "customer" },
];

// Bento grid that shows how a AchiCorp agent is defined and how it operates the
// client's SaaS — inspired by Grok's voice-agent bento, rebuilt for the AI workforce.
export function AgentShowcase() {
  return (
    <section className="relative bg-[#08080a] py-24 text-white">
      <div className="mx-auto max-w-[1500px] px-6 md:px-10">
        {/* Header */}
        <p className="text-[12px] font-semibold uppercase tracking-[0.14em]" style={{ color: ORANGE }}>
          How it works
        </p>
        <h2 className="mt-3 max-w-2xl text-3xl font-medium tracking-tight sm:text-4xl">
          Define an AI workforce, then watch it operate your SaaS.
        </h2>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-neutral-400">
          Give an agent a mission and your stack. It plans, acts across your tools, pauses for
          approvals — and every step runs live and fully audited.
        </p>

        {/* Bento */}
        <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
          {/* Row 1 */}
          <BentoCard title="Write the mission" desc="Describe the outcome. The agent plans multi-step and executes — every time.">
            <MissionMock />
          </BentoCard>
          <BentoCard title="Connect the stack" desc="Wire in Stripe, Vercel, GitHub, Supabase. The agent calls the right tool for the job.">
            <ConnectMock />
          </BentoCard>
          <BentoCard title="Watch it run — live" desc="Follow every step in the browser as it happens. No black box.">
            <RunMock />
          </BentoCard>

          {/* Row 2 */}
          <BentoCard
            className="md:col-span-2"
            title="Approvals & guardrails"
            desc="Decide what agents can and can't do. Sensitive actions pause for a human — on every run."
          >
            <GuardrailsMock />
          </BentoCard>
          <BentoCard title="Full audit trail" desc="Every action logged, attributed and reversible.">
            <AuditMock />
          </BentoCard>

          {/* Row 3 */}
          <BentoCard title="Semantic memory" desc="Hand it the docs you already have. It recalls the right passage on every task.">
            <Chip>help_center.pdf · indexed</Chip>
          </BentoCard>
          <BentoCard title="Cross-project rollups" desc="Aggregate MRR, deploys and incidents across every client you operate.">
            <RollupMock />
          </BentoCard>
          <BentoCard title="Runs 24/7 on schedule" desc="Put agents on a cron. They keep operating while you sleep.">
            <Chip>
              <Clock className="mr-1.5 inline h-3.5 w-3.5" style={{ color: ORANGE }} /> cron · every 15 min
            </Chip>
          </BentoCard>
        </div>
      </div>
    </section>
  );
}

/* ── Card shell ───────────────────────────────────────────────────────────── */
function BentoCard({
  title,
  desc,
  className,
  children,
}: {
  title: string;
  desc: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`flex flex-col rounded-3xl border border-white/10 bg-[#131316] p-6 ${className ?? ""}`}>
      <h3 className="text-[19px] font-medium tracking-tight text-white">{title}</h3>
      <p className="mt-2 max-w-md text-[13.5px] leading-relaxed text-neutral-400">{desc}</p>
      {children && <div className="mt-6 flex-1">{children}</div>}
    </div>
  );
}

/* ── Reusable bits ────────────────────────────────────────────────────────── */
function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-white/10 bg-white/[0.03] p-4 ${className ?? ""}`}>{children}</div>
  );
}

function Dots() {
  return (
    <span className="flex gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
      <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
      <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
    </span>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 font-mono text-[11px] text-neutral-300">
      {children}
    </span>
  );
}

/* ── Mockups ──────────────────────────────────────────────────────────────── */
function MissionMock() {
  return (
    <Panel>
      <div className="mb-3 flex items-center justify-between border-b border-white/10 pb-2.5">
        <Dots />
        <span className="text-[11px] text-neutral-500">Mission</span>
        <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-neutral-300">Draft</span>
      </div>
      <div className="space-y-1.5 font-mono text-[12px] leading-relaxed">
        <div className="text-violet-300/90">## PLAN</div>
        <div className="text-neutral-300">Map the client's Stripe &amp; Vercel, list open issues.</div>
        <div className="pt-1 text-violet-300/90">## EXECUTE</div>
        <div className="text-neutral-300">
          Refund the duplicate charge, redeploy, reply.
          <span className="ml-0.5 inline-block h-3.5 w-[3px] translate-y-0.5 animate-pulse bg-violet-400" />
        </div>
      </div>
    </Panel>
  );
}

function ConnectMock() {
  return (
    <Panel>
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10">
          <Bot className="h-5 w-5" style={{ color: ORANGE }} />
        </div>
        <div className="h-px flex-1 border-t border-dashed border-white/20" />
        <div className="flex flex-col gap-1.5">
          {TOOLS.map((t) => (
            <span
              key={t}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 font-mono text-[11px] text-neutral-300"
            >
              {t}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {INTEGRATIONS.map(({ icon: Icon, label }) => (
          <span
            key={label}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-medium text-neutral-300"
          >
            <Icon className="h-3.5 w-3.5" style={{ color: ORANGE }} />
            {label}
          </span>
        ))}
      </div>
    </Panel>
  );
}

function RunMock() {
  return (
    <Panel>
      <div className="mb-3 flex items-center justify-between border-b border-white/10 pb-2.5">
        <Dots />
        <span className="text-[11px] text-neutral-500">Run · acme-inc</span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
          </span>
          Live
        </span>
      </div>
      <div className="space-y-2.5">
        {RUN_STEPS.map((s) => (
          <div key={s.label} className="flex items-center gap-2.5 text-[12.5px]">
            {s.done ? (
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/20">
                <Check className="h-2.5 w-2.5 text-emerald-300" />
              </span>
            ) : (
              <Loader2 className="h-4 w-4 animate-spin" style={{ color: ORANGE }} />
            )}
            <span className={s.done ? "text-neutral-300" : "text-white"}>{s.label}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function GuardrailsMock() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col justify-center gap-2.5">
        <div className="max-w-[85%] self-start rounded-2xl rounded-bl-md bg-white/[0.06] px-3.5 py-2.5 text-[13px] text-neutral-200">
          Refund $420 to this customer?
        </div>
        <div className="max-w-[90%] self-end rounded-2xl rounded-br-md border border-amber-400/20 bg-amber-400/10 px-3.5 py-2.5 text-[13px] text-amber-100">
          Sensitive action — paused for approval.
        </div>
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-amber-400/30 bg-amber-400/10 px-2.5 py-1 text-[11px] font-medium text-amber-300">
          <ShieldCheck className="h-3.5 w-3.5" /> Waiting on a human
        </span>
      </div>
      <Panel className="flex flex-col justify-center">
        <div className="text-4xl font-semibold tracking-tight">100%</div>
        <div className="mt-1 text-[13px] text-neutral-400">of sensitive actions gated by approval</div>
        <div className="mt-3 flex flex-wrap gap-2">
          {["HITL", "No PII", "Reversible"].map((g) => (
            <span key={g} className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-neutral-300">
              {g}
            </span>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function AuditMock() {
  return (
    <Panel className="font-mono text-[11px]">
      <div className="space-y-2">
        {AUDIT.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-neutral-500">{r.time}</span>
            <span
              className="rounded px-1.5 py-0.5 text-[10px]"
              style={
                r.actor === "agent"
                  ? { backgroundColor: `${ORANGE}22`, color: ORANGE }
                  : { backgroundColor: "rgba(56,189,248,0.15)", color: "#7dd3fc" }
              }
            >
              {r.actor}
            </span>
            <span className="text-neutral-200">{r.action}</span>
            <span className="ml-auto text-neutral-500">{r.detail}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function RollupMock() {
  const rows = [
    { icon: CreditCard, label: "MRR", value: "$45.2k" },
    { icon: Layers, label: "Deploys", value: "128" },
    { icon: FileText, label: "Incidents", value: "0" },
  ];
  return (
    <Panel className="space-y-2">
      {rows.map(({ icon: Icon, label, value }) => (
        <div key={label} className="flex items-center gap-2 text-[12.5px]">
          <Icon className="h-3.5 w-3.5 text-neutral-500" />
          <span className="text-neutral-400">{label}</span>
          <span className="ml-auto font-mono text-neutral-200">{value}</span>
        </div>
      ))}
    </Panel>
  );
}
