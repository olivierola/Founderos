import { useMemo, useState } from "react";
import { MagnifyingGlassIcon as Search, CheckCircleIcon as CheckCircle } from "@phosphor-icons/react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { LandingClose } from "./LandingClose";
import { Reveal } from "./LandingKit";
import { PaperHero } from "./PaperHero";
import { MonoLabel, SectionTitle } from "./PaperKit";
import { ToneCanvas, ToneSection } from "./LandingTone";
import { Btn, useHnSkin } from "./hn/HnKit";

/* ═══ Documentation ══════════════════════════════════════════════════════════
   L'ancienne page était une façade. Un champ de recherche qui n'était relié à
   rien, trois raccourcis vers un « tour produit de 5 minutes », un « guide
   d'architecture » et « 80+ recettes de widgets » qui n'existent pas — et des
   <div> présentés comme des liens. Une page de documentation qui ne documente
   rien coûte plus cher que pas de page du tout : elle est le premier endroit où
   un acheteur technique va vérifier qu'on est sérieux.

   Celle-ci porte le contenu réel. Pas de liens vers des pages à écrire : ce
   qu'il y a à dire est ici, sur une page, et la recherche filtre ce qui y est
   effectivement écrit. Quand un site de docs complet existera, cette page en
   deviendra le sommaire — d'ici là elle se suffit.

   Chaque affirmation ci-dessous décrit un comportement vérifié dans le produit
   au moment de l'écriture (23/09/2026), limites comprises. Traduite en anglais
   le 01/10/2026 pour que tout le site parle une seule langue. */

interface Topic {
  id: string;
  section: string;
  title: string;
  body: string;
  points?: string[];
}

const TOPICS: Topic[] = [
  // ── Concepts ──────────────────────────────────────────────────────────────
  {
    id: "workspace",
    section: "The objects",
    title: "Workspace, project, service",
    body:
      "A workspace carries billing, members and roles. It contains projects, and a project contains services. A service is the unit that matters day to day: an agent-centred dashboard with its own rooms, schedules, connections and knowledge base. An agency usually keeps one service per client.",
    points: [
      "Quotas (agents, services, seats, storage) apply to the workspace, not to the project",
      "A connection to an external tool belongs to ONE service, or to one person within that service",
    ],
  },
  {
    id: "agent",
    section: "The objects",
    title: "Internal and public agents",
    body:
      "An internal agent works for your team: it has tools, missions, a schedule, and it hands in deliverables. A public agent faces your customers, it is the one behind a website widget, a Slack or a Teams channel. Both appear in the same directory, told apart by a badge; you configure them in the dashboard of the service that employs them.",
  },
  {
    id: "three-files",
    section: "The objects",
    title: "The three files of an agent",
    body:
      "An agent is described by three separate texts. The instructions say what it must do. The soul says how it speaks and what it refuses. The preferences keep what you have taught it along the way. The context sent to the model is assembled per task: only the skills and preferences relevant to the task at hand go in.",
  },

  // ── Getting started ───────────────────────────────────────────────────────
  {
    id: "first-agent",
    section: "Getting started",
    title: "Create your first agent",
    body:
      "Start from an agent template rather than a blank page: it comes with instructions, a coherent set of tools and typical missions you adjust. Then describe your company's context, what you do, for whom, in what vocabulary. That context feeds every agent's system prompt, so you fill it in once and it serves everywhere.",
    points: [
      "An agent without substantial instructions stays flagged “to configure” until it has something to work with",
      "Skills are added as you go: you can record one by doing the task yourself",
    ],
  },
  {
    id: "connect",
    section: "Getting started",
    title: "Connect your tools",
    body:
      "A connection is authorised from the service's Connectors tab, with your own account and through OAuth when the tool offers it. You then choose, agent by agent, which tools of that connection it is granted. An agent can only call what it has been granted.",
    points: [
      "An internal system without a ready-made connector goes through a remote MCP server, declared once",
      "Credentials are encrypted at rest and decrypted only server-side, at call time",
    ],
  },
  {
    id: "knowledge",
    section: "Getting started",
    title: "Give it knowledge",
    body:
      "A knowledge collection groups documents your agents can search. Drop in PDFs, Word documents, spreadsheets; the content is chunked and indexed. The same collection can be attached to several agents, you build it once.",
  },

  // ── Day to day ────────────────────────────────────────────────────────────
  {
    id: "approvals",
    section: "Day to day",
    title: "Approve an action",
    body:
      "When an agent wants to do something that writes, sends, deletes or pays, it stops and asks you, in the conversation. The run stays alive while it waits. You can approve once, allow repeats of the same action up front, or allow everything for a given tool.",
    points: [
      "Reads, searching, listing, looking something up, run without asking",
      "Two checks decide: a list of verbs, then a judgement on what the list lets through. The second can only add an approval",
      "An agent you switch to autonomous mode no longer waits: an explicit, reversible choice",
    ],
  },
  {
    id: "missions",
    section: "Day to day",
    title: "Missions and scheduling",
    body:
      "A mission is work handed to an agent, with an expected result. It can run on demand, on a cadence, or at a set date. The agent breaks its mission into steps, checks its own work at each stage, and says when it is going round in circles rather than insisting.",
  },
  {
    id: "deliverables",
    section: "Day to day",
    title: "Deliverables and reports",
    body:
      "What an agent produces lands in the service's artifacts: documents, spreadsheets, presentations. Reports are written by a dedicated system agent, from the figures in your data, with sources cited. A report opens in an editor and can be reworked by hand; the PDF export starts from what is on screen.",
  },
  {
    id: "rooms",
    section: "Day to day",
    title: "Rooms",
    body:
      "A room is a conversation between several people and agents. Mention an agent to bring it in, follow its work live, and the artifacts it produces stay attached to the room. An agent can also hand independent sub-tasks to short-lived agents working in parallel.",
  },

  // ── Governance ────────────────────────────────────────────────────────────
  {
    id: "guardrails",
    section: "Governance",
    title: "Guardrails",
    body:
      "A guardrail is a written rule agents must follow. It can be documentary, read by the agent in its context, or enforced at runtime, with a detection pattern tested against the traffic: prompts, tool calls, results, or all of them. Three levels: log, warn, block.",
    points: ["A new project has no guardrails: install the recommended baseline in one click, then adjust it"],
  },
  {
    id: "audit",
    section: "Governance",
    title: "Log and traceability",
    body:
      "Every tool call records the arguments passed, the start of what came back, whether it succeeded, how long it took and the run it belongs to, which you open to replay the whole sequence. The log exports. Long values are truncated in storage: you read enough to judge, not a copy of your data.",
  },
  {
    id: "registry",
    section: "Governance",
    title: "Registry and compliance",
    body:
      "The registry lists your agents, declared risks, policies, controls and the human decisions taken. You add your compliance frameworks and keep their status. We pre-declare no status: compliance is a statement that commits you, not a box ticked by default.",
  },

  // ── Models & costs ────────────────────────────────────────────────────────
  {
    id: "models",
    section: "Models & costs",
    title: "Which model runs an agent",
    body:
      "By default an agent runs on the platform's model. You can instead point it at an OpenAI-compatible endpoint you host, vLLM on your network, a GPU pod of your own, and your prompts then never leave your infrastructure. The choice is made agent by agent.",
  },
  {
    id: "credits",
    section: "Models & costs",
    title: "Credits and quotas",
    body:
      "Usage is measured in credits, consumed by what agents actually do. Each plan includes a monthly volume and sets limits: agents, services, seats, storage, concurrent runs. Overage never switches itself on, you allow it and you cap it.",
    points: [
      "An alert fires at 80% of the included volume, before you hit the wall",
      "There is no free trial: the subscription is billed when you subscribe",
    ],
  },
];

const SECTIONS = Array.from(new Set(TOPICS.map((t) => t.section)));

/* Each section heading in the two voices: the sans line, then the serif. */
const SECTION_TITLE: Record<string, { frame: string; claim: string }> = {
  "The objects": { frame: "What the product", claim: "is made of" },
  "Getting started": { frame: "Where", claim: "to start" },
  "Day to day": { frame: "What happens", claim: "next" },
  Governance: { frame: "What", claim: "protects you" },
  "Models & costs": { frame: "What it costs,", claim: "and on which model" },
};

export function DocsPage() {
  useHnSkin();
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TOPICS;
    return TOPICS.filter((t) =>
      [t.title, t.body, t.section, ...(t.points ?? [])].join(" ").toLowerCase().includes(q),
    );
  }, [query]);

  const sections = SECTIONS.filter((s) => shown.some((t) => t.section === s));

  return (
    <div className="amplify hn min-h-screen" style={{ backgroundColor: "transparent" }}>
      <LandingNav />
      <ToneCanvas initial="paper">
        <PaperHero
          label="Documentation"
          frame={["How it works,"]}
          claim="on one page"
          lead={
            <>
              The product's objects, getting started, what happens day to day and what governance covers.
              Everything is here, the search only filters what is written.
            </>
          }
          align="left"
        />

        <ToneSection tone="paper">
          <div className="px-5 pb-10 sm:px-8 lg:px-12">
            {/* ── Search ───────────────────────────────────────────────────── */}
            <Reveal>
              <div className="relative max-w-md">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8a94a6]"
                />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search the documentation"
                  placeholder="Search, approval, credits, MCP…"
                  className="h-12 w-full rounded-full border border-[#e6e9ef] bg-white pl-11 pr-4 text-[14.5px] text-[#0f1728]  outline-none transition-colors placeholder:text-[#8a94a6] focus:border-[#006edd]"
                />
              </div>
              <p className="mt-3 pl-1 text-[13px] text-[#4b5567]" role="status">
                {query.trim()
                  ? `${shown.length} topic${shown.length > 1 ? "s" : ""} out of ${TOPICS.length}`
                  : `${TOPICS.length} topics`}
              </p>
            </Reveal>

            {shown.length === 0 ? (
              <div className="mt-12 rounded-[24px] bg-[#f5f7fa] p-8">
                <p className="text-[15.5px] leading-[1.6] text-[#0f1728]">
                  Nothing on “{query.trim()}” yet. Write to us: what is missing here is usually what we should
                  have explained first.
                </p>
                <div className="mt-6">
                  <Btn to="/contact" variant="primary">
                    Ask the question
                  </Btn>
                </div>
              </div>
            ) : (
              sections.map((section) => (
                <section key={section} className="mt-20 first:mt-14">
                  <Reveal>
                    <SectionTitle
                      frame={SECTION_TITLE[section]?.frame ?? section}
                      claim={SECTION_TITLE[section]?.claim ?? ""}
                    />
                  </Reveal>

                  <div className="mt-9 grid gap-2.5 lg:grid-cols-2">
                    {shown
                      .filter((t) => t.section === section)
                      .map((t, i) => (
                        <Reveal key={t.id} delay={Math.min(i, 3) * 70} className="h-full">
                          <article
                            id={t.id}
                            className="hn-card hn-hover h-full rounded-[24px] border border-[#e6e9ef] bg-[#f7f8fb] p-7 sm:p-9"
                          >
                            <MonoLabel>{t.section}</MonoLabel>
                            <h3 className="mt-4 text-[21px] font-semibold leading-[1.2] tracking-[-0.035em] text-[#0f1728] sm:text-[23px]">
                              {t.title}
                            </h3>
                            <p className="mt-4 text-[15px] leading-[1.6] text-[#4b5567]">{t.body}</p>
                            {t.points && (
                              <ul className="mt-6 space-y-3 border-t border-[#e6e9ef] pt-6">
                                {t.points.map((p) => (
                                  <li key={p} className="flex gap-3 text-[14px] leading-[1.5] text-[#0f1728]">
                                    <span className="mt-[1px]">
                                      <CheckCircle weight="fill" className="h-5 w-5 text-[#006edd]" />
                                    </span>
                                    <span>{p}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </article>
                        </Reveal>
                      ))}
                  </div>
                </section>
              ))
            )}

            <Reveal delay={120}>
              <div className="mt-16 flex flex-col gap-6 rounded-[24px] bg-[#f5f7fa] p-8 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <MonoLabel>What this page does not cover yet</MonoLabel>
                  <p className="mt-4 max-w-[64ch] text-[15px] leading-[1.6] text-[#0f1728]">
                    There is no public API reference or step-by-step integration guide yet. We will not link to
                    pages that do not exist: when those guides are written, they will appear here. Until then, a
                    question sent through the contact form gets a real answer.
                  </p>
                </div>
                <Btn to="/contact" variant="primary" className="shrink-0">
                  Write to us
                </Btn>
              </div>
            </Reveal>
          </div>
        </ToneSection>

        <LandingClose />

        <ToneSection tone="paper">
          <LandingFooter band="transparent" />
        </ToneSection>
      </ToneCanvas>
    </div>
  );
}
