import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useParams } from "react-router-dom";
import {
  BrainIcon as Brain,
  CheckCircleIcon as CheckCircle,
  ListChecksIcon as ListChecks,
  SealCheckIcon as SealCheck,
  ShieldCheckIcon as ShieldCheck,
  SparkleIcon as Sparkle,
  UserFocusIcon as UserFocus,
} from "@phosphor-icons/react";
import { AgentBadge } from "./hn/AgentBadge";
import { PROVIDERS } from "@/lib/providers";
import { ALL_TOOLS, ToolMark } from "./tools";
import { HnHero, HnPage } from "./hn/HnPage";
import { ArtPanel, Btn, Card, Container, Eyebrow, FaqGrid, Fact, H, Head, IconTile, P, type Art, type IconType } from "./hn/HnKit";
import { AuditMock, MissionsMock, RegistryMock, RunMock, ToolGrid } from "./hn/Mocks";
import { PRODUCTS } from "./hn/site";

/* ═══ A product ══════════════════════════════════════════════════════════════
   hunar.ai's product-page template ("Conversational AI Agents - Self Serve"):
   a centred hero, the marks, a big screen on blue artwork, a facts strip,
   three "introducing" cards, then the dark band — three labelled stages, a
   sticky sub-navigation on the left and feature cards per topic — the agents
   row, the integrations card, a two-column FAQ, and the close.

   Facts are counts we can check in the code or the product, never usage
   figures: the reference shows calls per day; we have no measured volume to
   show. */

type Feature = { title: string; body: string; art: Art; sample: string[] };
type Topic = { id: string; label: string; title: string; body: string; features: Feature[] };

type Content = {
  title: string;
  lead: string;
  hero: ReactNode;
  facts: { value: string; label: string }[];
  intro: { eyebrow: string; title: string; lead: string; cards: { icon: IconType; title: string; body: string }[] };
  stages: { tag: string; title: string; body: string }[];
  topics: Topic[];
  faq: { q: string; a: string }[];
};

const CONTENT: Record<string, Content> = {
  agents: {
    title: "AI agents that do the work, self serve",
    lead: "Start from a template, bring your company context, connect your tools, and hand your first agent its first mission.",
    hero: (
      <div className="grid items-end gap-6 lg:grid-cols-[1.4fr_1fr]">
        <MissionsMock />
        <RunMock className="hidden lg:block" />
      </div>
    ),
    facts: [
      { value: String(PROVIDERS.length), label: "connectors ready to authorise" },
      { value: "2", label: "checks before any write action" },
      { value: "1", label: "audit trail for every call" },
      { value: "0", label: "migrations required" },
    ],
    intro: {
      eyebrow: "Built for real work",
      title: "Introducing agents that remember how you work",
      lead: "Every agent is described by three separate texts, and the context it receives is assembled per task, only what that task needs.",
      cards: [
        { icon: ListChecks, title: "Instructions", body: "What the agent must do: its job, its rules, the outcome you expect." },
        { icon: UserFocus, title: "Soul", body: "How it speaks and what it refuses, the same voice in every conversation." },
        { icon: Brain, title: "Preferences", body: "What you have taught it along the way, applied when the task calls for it." },
      ],
    },
    stages: [
      { tag: "Set up", title: "Configure your agent", body: "Pick a template, describe the job, connect the tools it may use." },
      { tag: "Run", title: "Hand it a mission", body: "Once, on a cadence or at a date, in chat, in a room or on its own." },
      { tag: "Review", title: "Approve and audit", body: "Writes wait for you; every call stays in the log." },
    ],
    topics: [
      {
        id: "agents",
        label: "Agents",
        title: "Agents",
        body: "Create agents for every team. Give each one a job, the tools it may use and the context it needs.",
        features: [
          { title: "Describe the job in plain language", body: "Write the agent's instructions the way you'd brief a colleague. No flow charts.", art: "blue", sample: ["Reconcile invoices monthly", "Flag gaps above €50", "Never write without approval"] },
          { title: "Templates for every team", body: "Finance, recruiting, support, reporting, sales, start from one and adjust it.", art: "violet", sample: ["Finance agent", "Recruiting agent", "Support agent"] },
          { title: "Skills it can learn", body: "Record a task once by doing it; the agent turns it into a skill it can reuse.", art: "olive", sample: ["Skill recorded", "Steps synthesised", "Ready to reuse"] },
          { title: "Knowledge it can search", body: "Collections of PDFs, documents and spreadsheets, built once, shared across agents.", art: "orange", sample: ["Contracts · 124 files", "Policies · 18 files", "Price lists · 6 files"] },
        ],
      },
      {
        id: "missions",
        label: "Missions",
        title: "Missions",
        body: "Hand an agent work with an expected result. It plans, acts, checks its own work at each step, and says when it's stuck.",
        features: [
          { title: "On demand, on a cadence or at a date", body: "Run a mission now, every Monday at 9:00, or once on the first of the month.", art: "blue", sample: ["Every Monday · 09:00", "1st of the month", "Now"] },
          { title: "Steps it verifies itself", body: "The agent checks each step against the expected result before moving on.", art: "pink", sample: ["Step 1 · verified", "Step 2 · verified", "Step 3 · running"] },
        ],
      },
      {
        id: "rooms",
        label: "Rooms",
        title: "Rooms",
        body: "Conversations between people and agents. Mention an agent to bring it in, and follow its work live.",
        features: [
          { title: "People and agents in one thread", body: "Mention @Finance to bring the agent in; what it produces stays attached to the room.", art: "violet", sample: ["@Finance agent joined", "Draft attached", "2 replies"] },
          { title: "Parallel work, when it helps", body: "An agent can hand independent sub-tasks to short-lived agents working side by side.", art: "olive", sample: ["3 sub-tasks started", "2 done", "1 running"] },
        ],
      },
      {
        id: "approvals",
        label: "Approvals",
        title: "Approvals",
        body: "Reads never interrupt you. Anything that writes, sends, deletes or pays stops and waits, in the conversation.",
        features: [
          { title: "Writes wait in the conversation", body: "Approve or decline right where the agent asked. The run stays alive while it waits.", art: "orange", sample: ["Credit note · waiting", "Approve", "Decline"] },
          { title: "Allow repeats once", body: "Approve an action once, or allow its repeats up front for the rest of the run.", art: "blue", sample: ["Allow once", "Allow repeats", "Allow all for this tool"] },
        ],
      },
      {
        id: "deliverables",
        label: "Deliverables",
        title: "Deliverables",
        body: "What agents produce lands in the service's artifacts: documents, spreadsheets, presentations, reports.",
        features: [
          { title: "Reports by a dedicated writer", body: "One system agent writes every report from your figures, with each source cited.", art: "pink", sample: ["Q3 board report", "12 sources cited", "Ready for review"] },
          { title: "Edit, then export", body: "A report opens in an editor; the PDF export starts from what's on screen.", art: "violet", sample: ["Edited by you", "Export PDF", "Shared"] },
        ],
      },
    ],
    faq: [
      { q: "Do we need engineers to set up an agent?", a: "No. Agents are configured in plain language through the assistant, and connectors sign in with accounts you already have. A self-hosted model or a custom MCP connector is where engineering helps." },
      { q: "Which systems can an agent use?", a: "Any connector you authorise in the service, and anything exposed through a remote MCP server. Each agent only gets the tools you grant it." },
      { q: "Can an agent act without asking?", a: "Reads run directly. Writes, sends, deletions and payments wait for approval unless you switch that specific agent to autonomous mode yourself." },
      { q: "Which model runs our agents?", a: "The platform's model by default. You can point an agent at an OpenAI-compatible endpoint you host instead, so prompts stay on your network." },
      { q: "How is usage billed?", a: "In credits, consumed by what agents actually do. Each plan includes a monthly volume; overage never switches itself on." },
      { q: "Can we stop a run?", a: "Yes, from the composer, at any time. Nothing pending is written once you stop it." },
    ],
  },
  govern: {
    title: "Govern every agent, before an auditor asks",
    lead: "A registry synced from the agents that actually run, guardrails enforced at runtime, approvals in the conversation, and an exportable audit trail.",
    hero: (
      <div className="grid items-end gap-6 lg:grid-cols-[1.4fr_1fr]">
        <RegistryMock />
        <AuditMock className="hidden lg:block" />
      </div>
    ),
    facts: [
      { value: "1", label: "registry, synced from the agents that run" },
      { value: "3", label: "guardrail levels: log, warn, block" },
      { value: "2", label: "checks before any write action" },
      { value: "AES-256", label: "encryption of credentials at rest" },
    ],
    intro: {
      eyebrow: "Built for scrutiny",
      title: "Introducing governance you don't have to maintain by hand",
      lead: "The inventory comes from the systems that actually run agents, not from a form someone forgets to update.",
      cards: [
        { icon: ListChecks, title: "Registry", body: "Every agent, its declared risk, its tool scope and its policies, in one place." },
        { icon: ShieldCheck, title: "Guardrails", body: "Written rules agents follow, documentary or enforced at runtime against the traffic." },
        { icon: SealCheck, title: "Audit trail", body: "Arguments, result, duration and run for every call, exportable for review." },
      ],
    },
    stages: [
      { tag: "Declare", title: "Register and classify", body: "Agents appear in the registry as they're created; you classify the risk." },
      { tag: "Enforce", title: "Policies at runtime", body: "Guardrails log, warn or block; writes wait for a human." },
      { tag: "Prove", title: "Export the trail", body: "Hand an auditor the log and the decisions, not a slide." },
    ],
    topics: [
      {
        id: "registry",
        label: "Registry",
        title: "Registry",
        body: "One inventory of every agent, synced from runtime, risks, policies, controls and the human decisions taken.",
        features: [
          { title: "Synced from what actually runs", body: "The registry reads the agents in the product. A registry nobody maintains can't drift.", art: "blue", sample: ["5 agents", "Synced just now", "0 unregistered"] },
          { title: "Your frameworks, your status", body: "Add the compliance frameworks you work to and keep their status. Nothing is pre-declared.", art: "violet", sample: ["EU AI Act · in progress", "Internal policy · applied", "Owner assigned"] },
        ],
      },
      {
        id: "guardrails",
        label: "Guardrails",
        title: "Guardrails",
        body: "Rules agents must follow, read by the agent in its context, or enforced against prompts, tool calls and results.",
        features: [
          { title: "Log, warn or block", body: "Three levels, tested against the traffic you choose: prompts, tool calls, results, or all.", art: "orange", sample: ["Personal data · block", "Profanity · warn", "Large export · log"] },
          { title: "A recommended baseline", body: "A new project starts with none; install the recommended baseline in one click, then adjust it.", art: "olive", sample: ["Baseline installed", "12 rules", "3 adjusted"] },
        ],
      },
      {
        id: "approvals",
        label: "Approvals",
        title: "Approvals",
        body: "Human-in-the-loop where it matters: every write waits, and the decision is recorded.",
        features: [
          { title: "A second check that only adds caution", body: "A list of write verbs, then a judgement on what it let through. The second can add an approval, never remove one.", art: "pink", sample: ["Verb check · write", "Judgement · needs approval", "Waiting for you"] },
          { title: "Autonomy is a decision", body: "Switching an agent to autonomous mode is explicit, per agent, and reversible.", art: "blue", sample: ["Autonomous mode · off", "Changed by you", "Logged"] },
        ],
      },
      {
        id: "audit",
        label: "Audit",
        title: "Audit trail",
        body: "Not just which tool, what went in and what came back, for every call, in a run you can replay.",
        features: [
          { title: "Every call, replayable", body: "Arguments, the start of the result, success, duration and the run it belongs to.", art: "violet", sample: ["ledger.create_credit_note", "1.4 s · success", "Open replay"] },
          { title: "Exportable", body: "Export the log for review. Long values are truncated in storage, enough to judge, not a copy of your data.", art: "olive", sample: ["Export CSV", "Last 90 days", "Ready"] },
        ],
      },
      {
        id: "models",
        label: "Models & keys",
        title: "Models & keys",
        body: "Credentials encrypted at rest, and inference that can stay on your network.",
        features: [
          { title: "Encrypted credentials", body: "Connector secrets encrypted with AES-256-GCM, decrypted only server-side at call time.", art: "blue", sample: ["AES-256-GCM", "Server-side only", "Never sent to the browser"] },
          { title: "Your own model endpoint", body: "Point an agent at an OpenAI-compatible endpoint you host, vLLM on your network, a GPU pod of your own.", art: "orange", sample: ["Endpoint · self-hosted", "Agent · Finance", "Prompts stay on your network"] },
        ],
      },
    ],
    faq: [
      { q: "Do you hold SOC 2 or ISO 27001?", a: "Not today, and we won't display them until we do. What we provide are the mechanisms and the evidence: registry, policies, approvals, an exportable audit log." },
      { q: "Where does the registry come from?", a: "From the agents that actually run in the product. You classify their risk and attach policies; you don't maintain the inventory by hand." },
      { q: "What exactly is logged?", a: "For every tool call: the arguments passed, the start of what came back, whether it succeeded, how long it took and the run it belongs to." },
      { q: "Can a guardrail block an action?", a: "Yes. Guardrails run at three levels, log, warn, block, against prompts, tool calls, results, or all of them." },
      { q: "Can prompts stay inside our network?", a: "Yes, by pointing an agent at an OpenAI-compatible endpoint you host. The endpoint's availability and hardening are then yours." },
      { q: "Does this help with the EU AI Act?", a: "It gives you the registry, risk classification and records the Act asks for. Whether you comply is a statement you make; we pre-declare nothing." },
    ],
  },
};

const AGENT_ORBS: { name: string; art: Art }[] = [
  { name: "Finance agent", art: "blue" },
  { name: "Recruiting agent", art: "violet" },
  { name: "Support agent", art: "olive" },
  { name: "Report writer", art: "orange" },
  { name: "Sales agent", art: "gold" },
];

const MARKS = ALL_TOOLS.slice(0, 14);

function FeatureTile({ f, wide }: { f: Feature; wide?: boolean }) {
  return (
    <Card tone="dark" hover className={`grid gap-6 p-5 ${wide ? "md:col-span-2 md:grid-cols-2 md:items-center" : ""}`}>
      <div>
        <SealCheck weight="fill" className="h-5 w-5 text-[#5aa8ff]" />
        <h3 className="mt-4 text-[20px] font-medium leading-[1.3] text-white">{f.title}</h3>
        <p className="mt-1 text-[16px] leading-[1.4] text-white/75">{f.body}</p>
      </div>
      <ArtPanel art={f.art} className="flex min-h-[180px] items-center justify-center rounded-[14px] p-5">
        <div className="w-full max-w-[280px] space-y-1.5">
          {f.sample.map((s) => (
            <div key={s} className="flex items-center gap-2 rounded-[12px] bg-white/85 px-3 py-2 text-[12.5px] text-[#0f1728] backdrop-blur-sm">
              <CheckCircle weight="fill" className="h-3.5 w-3.5 shrink-0 text-[#006edd]" />
              {s}
            </div>
          ))}
        </div>
      </ArtPanel>
    </Card>
  );
}

export function ProductPage() {
  const { slug } = useParams();
  const product = PRODUCTS.find((p) => p.slug === slug);
  const content = slug ? CONTENT[slug] : undefined;
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [slug]);

  useEffect(() => {
    if (!content) return;
    setActive(content.topics[0].id);
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id);
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    content.topics.forEach((t) => {
      const el = document.getElementById(t.id);
      if (el) io.observe(el);
    });
    return () => io.disconnect();
  }, [content]);

  if (!product || !content) return <Navigate to="/" replace />;

  return (
    <HnPage>
      <HnHero variant="center" tone="white" eyebrow={product.name} title={content.title} lead={content.lead}>
        <Btn to="/contact">Book a live demo</Btn>
      </HnHero>

      {/* ══ The marks and the big screen ═══════════════════════════════════ */}
      <section className="bg-white">
        <div
          className="overflow-hidden py-8"
          style={{ WebkitMaskImage: "linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)", maskImage: "linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)" }}
        >
          <div className="hn-marquee gap-14">
            {[...MARKS, ...MARKS].map((t, i) => (
              <span key={`${t.name}-${i}`} className="flex shrink-0 items-center gap-2 text-[#7a8496]">
                {(t.path || t.logo) && <span style={{ color: `#${t.hex}` }} className="flex"><ToolMark tool={t} size={22} /></span>}
                <span className="text-[18px] font-semibold tracking-[-0.02em]">{t.name}</span>
              </span>
            ))}
          </div>
        </div>
        <Container>
          <ArtPanel art={product.art} className="rounded-[24px] p-6 sm:p-10 lg:p-14">{content.hero}</ArtPanel>
        </Container>
      </section>

      {/* ══ Facts strip ════════════════════════════════════════════════════ */}
      <section className="mt-16 border-y border-[#e6e9ef] bg-[#f7f8fb]">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4">
          {content.facts.map((f, i) => (
            <div key={f.label} className={`px-8 py-10 lg:px-12 ${i ? "border-t border-[#e6e9ef] sm:border-l sm:border-t-0" : ""}`}>
              <Fact value={f.value} label={f.label} />
            </div>
          ))}
        </div>
      </section>

      {/* ══ Introducing ════════════════════════════════════════════════════ */}
      <section className="bg-white py-20 lg:py-24">
        <Container narrow>
          <Head eyebrow={content.intro.eyebrow} title={content.intro.title} lead={content.intro.lead} />
          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {content.intro.cards.map((c) => (
              <Card key={c.title} tone="bg" hover className="flex min-h-[260px] flex-col p-6">
                <IconTile icon={c.icon} />
                <div className="mt-auto pt-10">
                  <h3 className="text-[20px] font-medium leading-[1.3] text-[#0f1728]">{c.title}</h3>
                  <p className="mt-2 text-[18px] leading-[1.3] text-[#4b5567]">{c.body}</p>
                </div>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      {/* ══ The dark band ═════════════════════════════════════════════════ */}
      <section className="hn-dark text-white">
        <div className="px-6 py-20 sm:px-12 lg:py-24">
          <Head tone="dark" eyebrow="How it works" title={`${content.stages.length} stages, from setup to proof`} lead={content.lead} />
          <div className="mx-auto mt-12 grid max-w-[1000px] gap-8 md:grid-cols-3">
            {content.stages.map((s) => (
              <div key={s.tag} className="flex flex-col items-center text-center">
                <span className="rounded-full bg-[#006edd] px-4 py-2 text-[16px] font-medium leading-none">{s.tag}</span>
                <div className="mt-4 rounded-[14px] border border-white/10 bg-white/[0.05] px-4 py-3 text-[18px] font-medium">{s.title}</div>
                <p className="mt-4 max-w-[260px] text-[18px] leading-[1.3] text-white/75">{s.body}</p>
              </div>
            ))}
          </div>

          <div className="mt-20 grid gap-10 lg:grid-cols-[200px_1fr] lg:gap-16">
            <nav className="hidden lg:block">
              <div className="sticky top-[96px] space-y-1">
                {content.topics.map((t) => (
                  <a
                    key={t.id}
                    href={`#${t.id}`}
                    className={`block rounded-[14px] px-4 py-3 text-[16px] font-medium transition-colors ${
                      active === t.id ? "border border-white/10 bg-white/[0.06] text-white" : "text-white/45 hover:text-white/80"
                    }`}
                  >
                    {t.label}
                  </a>
                ))}
              </div>
            </nav>
            <div className="space-y-20">
              {content.topics.map((t) => (
                <div key={t.id} id={t.id} className="scroll-mt-28">
                  <H tone="white" size="sub">{t.title}</H>
                  <P tone="dim" className="mt-3 max-w-[480px]">{t.body}</P>
                  <div className="mt-8 grid gap-4 md:grid-cols-2">
                    {t.features.map((f, i) => (
                      <FeatureTile key={f.title} f={f} wide={i === 0 && t.features.length % 2 === 1} />
                    ))}
                  </div>
                </div>
              ))}

              {slug === "agents" && (
                <div className="grid grid-cols-2 gap-6 border-t border-white/10 pt-16 sm:grid-cols-3 lg:grid-cols-5">
                  {AGENT_ORBS.map((a) => (
                    <div key={a.name} className="rounded-[24px] border border-white/10 bg-white/[0.04] p-2">
                      <ArtPanel art={a.art} className="grid h-[120px] place-items-center rounded-[14px]">
                        <AgentBadge name={a.name} size={52} tone="glass" />
                      </ArtPanel>
                      <div className="px-2 pb-2 pt-3 text-[16px] font-medium">{a.name}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ══ Integrations ═══════════════════════════════════════════════════ */}
      <section className="bg-white py-20 lg:py-24">
        <Container narrow>
          <Card tone="bg" className="grid items-center gap-10 p-8 sm:p-12 lg:grid-cols-2">
            <div>
              <Eyebrow>Plug and play</Eyebrow>
              <H size="sub" className="mt-3">Integrate with the systems you already run</H>
              <P className="mt-4 max-w-[420px]">
                Connect your work, business, delivery and data tools, or anything that speaks MCP or HTTP.
              </P>
              <Btn to="/integrations" variant="link" className="mt-6">See every integration</Btn>
            </div>
            <ToolGrid names={["Microsoft 365", "Slack", "Salesforce", "Google Workspace", "HubSpot", "SAP", "Teams", "Jira", "GitHub", "Notion", "Snowflake", "Okta"]} />
          </Card>
        </Container>
      </section>

      {/* ══ FAQ ════════════════════════════════════════════════════════════ */}
      <section className="bg-white pb-20 lg:pb-24">
        <Container narrow>
          <div className="flex items-center gap-2">
            <Sparkle weight="fill" className="h-5 w-5 text-[#006edd]" />
            <span className="text-[16px] font-medium text-[#006edd]">{product.name}</span>
          </div>
          <H className="mt-3">Frequently asked questions</H>
          <div className="mt-8">
            <FaqGrid items={content.faq} />
          </div>
        </Container>
      </section>
    </HnPage>
  );
}
