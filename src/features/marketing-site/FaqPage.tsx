import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Minus, Plus, Search } from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { ClosingCta, PageHero, useLandingSkin } from "./PageHero";
import { CtaGhost, CtaPrimary, Reveal } from "./LandingKit";

/* ===================== FAQ =====================
   An earlier cut repeated the same block six times: sticky group label on the
   left, accordion stack on the right, once per category. Six of anything in a
   row is a list, and a list of lists is unreadable.

   So there is one of each shape instead. Three questions that get asked on
   every single call are answered up front, open, no click required. Everything
   else sits in a single continuous column with one contents rail beside it,
   the way documentation is laid out, because that is what this is.

   The editorial rule for the answers: a claim plus the specific that makes it
   checkable. "Yes, it's secure" is not an answer. "Encrypted at rest with
   AES-GCM, never returned in plaintext" is. */

type Item = { q: string; a: string };
type Group = { id: string; label: string; items: Item[] };

/* Asked on essentially every first call, so they are answered before the page
   asks anyone to click anything. */
const HEADLINE: Item[] = [
  {
    q: "What does Anduran actually do?",
    a: "We help companies adopt AI safely. In practice that is three things: we assess where your processes and data stand today, we build the secured foundation so AI has something solid to work on, and we guide adoption across your organisation with the governance and change enablement that makes it stick.",
  },
  {
    q: "How do you handle data security?",
    a: "Credentials are encrypted at rest with AES-GCM and never returned in plaintext to the browser. Every agent runs against scoped tool grants, write actions are approval-gated, and every call is recorded in an exportable audit log. We connect to your systems rather than copying your data into ours.",
  },
  {
    q: "How long before we see something real?",
    a: "Four to eight weeks to the first secured milestone in production. Not a demo: one agent doing one real piece of work, inside your tenant, with the audit trail switched on.",
  },
];

const GROUPS: Group[] = [
  {
    id: "company",
    label: "Working with us",
    items: [
      {
        q: "We are not sure we are ready for AI. Where do we start?",
        a: "With the readiness assessment. It rates every process from L1 to L5 and tells you which work is ready for an agent today, which needs a foundation first, and which should wait. It takes two to three weeks. Most teams find two or three quick wins and one structural gap they did not know about.",
      },
      {
        q: "What industries and company sizes do you work with?",
        a: "From twenty-person teams to enterprises with several thousand seats, with the deepest experience in services, logistics, finance and software. The framework is the same everywhere; the depth of the governance layer scales with your regulatory surface.",
      },
      {
        q: "Are you a consultancy or a software vendor?",
        a: "Both, deliberately. The platform is ours, which is why we can promise things like tenant-level isolation and approval gates on write actions rather than hoping a vendor ships them. The consulting is what makes the platform land, because software alone has never changed how a few hundred people work.",
      },
      {
        q: "What if the assessment says we are not ready?",
        a: "Then we say so, and the roadmap starts with the foundation work rather than with an agent. We would rather lose a quarter of scope than deliver an assistant onto a process that cannot support it.",
      },
    ],
  },
  {
    id: "security",
    label: "Security & data",
    items: [
      {
        q: "Do agents run on our own infrastructure?",
        a: "They can. Agents run inside your tenant with your identity controls and data residency, and you can route inference to a model you host yourself. Your prompts, your data and the resulting IP stay yours.",
      },
      {
        q: "What does the model provider keep?",
        a: "Nothing we can avoid sending, and nothing for training. We document per deployment which provider handles which class of data, in which region, with what retention. That document is part of the delivery, not an appendix you have to ask for.",
      },
      {
        q: "Can an agent act without a human?",
        a: "Reads are free; writes are gated by default. You decide per agent and per toolkit which write actions can be auto-approved once a pattern has proven itself, and every approval, automatic or not, is recorded with its approver.",
      },
      {
        q: "What happens to our data if we leave?",
        a: "You export it and we delete ours. There is no lock-in clause, no proprietary format for the knowledge base, and the agent definitions leave with you.",
      },
    ],
  },
  {
    id: "platform",
    label: "Agents & platform",
    items: [
      {
        q: "What can an agent actually do?",
        a: "Read and write in the systems you connect it to, run multi-step missions with a plan it revises as it goes, call your own tools over MCP, hand work to sub-agents when tasks are independent, and stop to ask a human when it hits an approval gate or an ambiguity.",
      },
      {
        q: "Which systems can you connect to?",
        a: "Fifty-seven providers today across CRM, billing, support, code hosting, storage and messaging, plus anything that speaks MCP or exposes an HTTP API. No platform migration is required; agents layer onto the environment you already run.",
      },
      {
        q: "Can agents work in Slack or Teams?",
        a: "Yes. Agents can be mentioned in a channel or replied to in a thread on both, and they post their results back where the conversation started.",
      },
      {
        q: "What stops an agent from looping forever?",
        a: "A controller watches for repeated states and forces a replan or an escalation, and every run carries explicit budgets in time, tokens and tool calls. When a budget runs out the run stops cleanly and keeps whatever it already produced.",
      },
      {
        q: "Which models do you use?",
        a: "The platform routes between models rather than betting on one: a cheap model for routing and extraction, a stronger one when a run escalates. On Enterprise you can bring your own provider keys or point inference at a model you host.",
      },
    ],
  },
  {
    id: "billing",
    label: "Pricing & billing",
    items: [
      {
        q: "What is an AI credit?",
        a: "One unit of AI work. Credits cover what your agents actually spend at the AI providers: language models, vectorisation, transcription. A conversational reply costs about 20 credits, a full mission 300 to 800, indexing a 100-page document about 5.",
      },
      {
        q: "What happens when I run out?",
        a: "Agents stop cleanly and keep whatever they already produced, so nothing is lost mid-run. You can buy a credit pack, which never expires, or move up a plan. Either restores service immediately.",
      },
      {
        q: "Can I change plans later?",
        a: "Yes, anytime. Upgrading is instant and restarts your billing period with the new allowance; downgrading applies at the end of the current period.",
      },
      {
        q: "How does annual billing work?",
        a: "Annual plans are billed once a year for the price of ten months, about 17% off versus monthly.",
      },
      {
        q: "What counts as a ‘service’?",
        a: "One agent-centred workspace: its own agents, rooms, schedules and knowledge base. Agencies typically run one service per client.",
      },
      {
        q: "What payment methods do you take?",
        a: "Card via Stripe on every plan. Wire transfer and purchase orders are available on Enterprise.",
      },
    ],
  },
  {
    id: "governance",
    label: "Governance & compliance",
    items: [
      {
        q: "Are you EU AI Act ready?",
        a: "The platform produces what the Act asks a deployer for: a registry of every AI system with its owner and data scope, a risk class per system with the reasoning recorded, documented human oversight where it exists, and exportable logs. The registry syncs from the runtime rather than from a form, so it cannot drift out of date.",
      },
      {
        q: "How long are audit logs kept?",
        a: "Ninety days on Individual, one year on Pro, two years on Agencies, three years plus export on Enterprise.",
      },
      {
        q: "Who decides what an agent is allowed to touch?",
        a: "You do, per agent, through scoped tool grants. The grant, its approver and its date are part of the registry, so nobody in your organisation can widen an agent's reach without leaving a trace.",
      },
      {
        q: "Can we run our own approval workflow?",
        a: "Yes. Approvals can be routed to a named person, a role, or a channel, and repeated identical requests can be auto-approved once you have decided a pattern is safe.",
      },
    ],
  },
  {
    id: "support",
    label: "Support & delivery",
    items: [
      {
        q: "What does the managed retainer include?",
        a: "A named architect, functional consultant and developer who already know your environment, keeping the platform healthy, drift monitored, governance current and the roadmap moving. It is a monthly engagement, not a ticket queue.",
      },
      {
        q: "How fast do you respond?",
        a: "Email support on Individual, priority on Pro and Agencies, a dedicated CSM on Enterprise. SLAs run from 99% to 99.9% depending on plan, and customer success replies within four hours during EU business days.",
      },
      {
        q: "Do you train our team, or do you keep the keys?",
        a: "We train. The point of the engagement is that you can operate what we built: every agent, policy and workflow is documented and handed over, and a hundred percent of the resulting IP is yours.",
      },
    ],
  },
];

const ALL_ITEMS = GROUPS.flatMap((g) => g.items.map((it) => ({ ...it, group: g.label })));

function Accordion({ q, a, open }: Item & { open?: boolean }) {
  return (
    <details open={open} className="group border-b border-black/[0.08] py-6">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-6 text-[17px] font-medium leading-snug tracking-[-0.01em] text-[#000007]">
        {q}
        <span className="mt-0.5 shrink-0 text-black/30 transition-colors group-hover:text-black/60">
          <Plus className="h-[18px] w-[18px] group-open:hidden" />
          <Minus className="hidden h-[18px] w-[18px] group-open:block" />
        </span>
      </summary>
      <p className="mt-4 max-w-2xl text-[15.5px] leading-[1.7] text-[var(--amp-muted)]">{a}</p>
    </details>
  );
}

export function FaqPage() {
  useLandingSkin();
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const results = useMemo(
    () => (q ? ALL_ITEMS.filter((it) => (it.q + " " + it.a).toLowerCase().includes(q)) : []),
    [q],
  );

  return (
    /* No overflow clamp on the root: `overflow-x: hidden` would make this a
       scroll container, and a scroll container that never scrolls kills the
       sticky contents rail below. */
    <div className="amplify amp-light min-h-screen bg-white">
      <LandingNav />

      <PageHero
        eyebrow="FAQ"
        title="Questions, answered properly"
        lead="Everything teams ask us before an engagement. If yours is not here, ask it directly and we will add it."
        hue="amber"
        frame={620}
        padBottom={70}
      >
        <div className="relative mx-auto mt-10 max-w-md">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-black/35" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the questions…"
            aria-label="Search the questions"
            className="h-12 w-full rounded-full border border-black/[0.08] bg-white/80 pl-11 pr-4 text-[15px] text-[#000007] shadow-[0_10px_30px_-18px_rgba(0,0,7,0.35)] outline-none backdrop-blur-xl transition-colors placeholder:text-black/35 focus:border-black/20"
          />
        </div>
      </PageHero>

      {q ? (
        /* ══ Search takes over the whole body ══════════════════════════════ */
        <section className="amp-light relative bg-white">
          <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
            <div className="amp-rails relative py-14">
              <div className="mx-auto max-w-3xl">
                <p className="text-[14px] text-black/45">
                  {results.length} {results.length === 1 ? "answer" : "answers"} for “{query.trim()}”
                </p>
                {results.length > 0 ? (
                  <div className="mt-6">
                    {results.map((it) => (
                      <div key={it.q}>
                        <div className="pt-6 text-[11px] uppercase tracking-[0.14em] text-black/30">
                          {it.group}
                        </div>
                        <Accordion q={it.q} a={it.a} open />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-8 rounded-[24px] bg-[#f7f7f7] px-8 py-16 text-center">
                    <p className="text-[19px] font-medium text-[#000007]">
                      Nothing matches that yet.
                    </p>
                    <p className="mx-auto mt-3 max-w-sm text-[15px] leading-[1.6] text-[var(--amp-muted)]">
                      Ask us directly. We answer every message, and the good questions end up on
                      this page.
                    </p>
                    <Link
                      to="/contact"
                      className="mt-8 inline-block rounded-full bg-[#2b2b2b] px-6 py-3 text-[14.5px] font-medium text-white transition-colors hover:bg-[#0d0d0d]"
                    >
                      Ask your question
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : (
        <>
          {/* ══ The three that come up on every call, answered open ═════════ */}
          <section className="amp-light relative bg-white">
            <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
              <div className="amp-rails relative pb-20">
                <Reveal>
                  <div className="overflow-hidden rounded-[24px] bg-[#f7f7f7]">
                    {HEADLINE.map((it, i) => (
                      <div
                        key={it.q}
                        className={
                          "grid gap-4 p-8 sm:grid-cols-[0.75fr_1.25fr] sm:gap-10 sm:p-10 " +
                          (i > 0 ? "border-t border-black/[0.07]" : "")
                        }
                      >
                        <h2 className="text-balance text-[20px] font-semibold leading-[1.2] tracking-[-0.018em] text-[#000007]">
                          {it.q}
                        </h2>
                        <p className="text-[15.5px] leading-[1.7] text-[var(--amp-muted)]">
                          {it.a}
                        </p>
                      </div>
                    ))}
                  </div>
                </Reveal>
              </div>
            </div>
          </section>

          {/* ══ Everything else: one column, one contents rail ══════════════ */}
          <section className="amp-light relative bg-white">
            <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
              <div className="amp-rails relative grid gap-12 pb-24 lg:grid-cols-[220px_1fr] lg:gap-20">
                {/* One rail for the whole page, rather than a sticky header per
                    group. It is a table of contents, so it looks like one. */}
                <nav className="hidden lg:block">
                  <div className="sticky top-[120px]">
                    <div className="text-[11px] uppercase tracking-[0.14em] text-black/30">
                      Contents
                    </div>
                    <ul className="mt-5 space-y-1">
                      {GROUPS.map((g) => (
                        <li key={g.id}>
                          <a
                            href={`#${g.id}`}
                            className="flex items-baseline justify-between gap-3 rounded-lg py-2 pl-3 pr-2 text-[14px] text-black/55 transition-colors hover:bg-black/[0.04] hover:text-black"
                          >
                            {g.label}
                            <span className="text-[12px] tabular-nums text-black/25">
                              {g.items.length}
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                </nav>

                <div className="min-w-0">
                  {GROUPS.map((g) => (
                    <section key={g.id} id={g.id} className="scroll-mt-[110px] pt-14 first:pt-0">
                      <h2 className="text-[13px] font-medium uppercase tracking-[0.14em] text-[var(--amp-orange)]">
                        {g.label}
                      </h2>
                      <div className="mt-2 border-t border-black/[0.08]">
                        {g.items.map((it) => (
                          <Accordion key={it.q} q={it.q} a={it.a} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      <ClosingCta
        hue="amber"
        eyebrow="Still Stuck?"
        title="Still have questions? We're here to help."
        lead="A thirty-minute conversation is usually enough to know whether we are a fit, and we would rather tell you early that we are not."
        actions={
          <>
            <Link to="/contact">
              <CtaPrimary>Contact Us</CtaPrimary>
            </Link>
            <Link to="/pricing">
              <CtaGhost>See pricing</CtaGhost>
            </Link>
          </>
        }
      />

      <LandingFooter />
    </div>
  );
}
