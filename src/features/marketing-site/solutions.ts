import type { ComponentType } from "react";
import {
  AdoptionGrid,
  FoundationFlow,
  GovernanceCloud,
  ManagedRun,
  ReadinessScan,
  SecuredAgents,
} from "./LandingVisuals";

/* ===================== The six offers =====================
   /solutions is the overview and keeps its bespoke blocks; each offer also has
   its own page, because the nav dropdown promises six destinations with six
   distinct value propositions and six anchors on one scroll do not deliver
   that.

   The detail pages DO share a template, unlike the blocks on the index. That is
   deliberate and not the repetition problem from before: these are siblings a
   reader compares one against another, never sees two of at once, and a
   consistent shape is what makes them comparable. The variation is in the data
   instead, so a page renders a stat only if the offer has one worth showing.

   `key` is the page's hue. It is picked from the site's fixed palette rather
   than invented per page, and the hero lifts it to clear the nav (tintFromKey
   in PageHero), so a dark key here is safe.

   This array is also the ONLY list of the six: the nav dropdown, the footer
   column and the home page's cards all read it. They each used to keep their
   own copy, which is how the dropdown ended up promising "Workforce Readiness"
   in fourth position while the page it opened was numbered 01 and titled
   something else. */

export type Solution = {
  slug: string;
  num: string;
  /** Short form, for the index rail and the kicker above each page's title. */
  nav: string;
  /** Label and one-line promise for the nav dropdown and the footer column. */
  menu: { label: string; blurb: string };
  key: string;
  /** amp-viz modifier for the diagram plate, so six diagrams do not read alike. */
  viz: string;
  visual: ComponentType;
  title: string;
  lead: string;
  meta: { label: string; value: string }[];
  problem: { title: string; body: string; points: string[] };
  approach: { title: string; body: string; steps: { t: string; b: string }[] };
  deliverables: string[];
  proof?: { figure: string; unit: string; label: string };
  faq: { q: string; a: string }[];
};

export const SOLUTIONS: Solution[] = [
  {
    slug: "readiness",
    num: "01",
    nav: "Readiness",
    menu: {
      label: "AI Readiness & Maturity",
      blurb: "Map which processes are ready for agents today.",
    },
    key: "#2A9C82",
    viz: "amp-viz-grey",
    visual: ReadinessScan,
    title: "AI Readiness & Maturity Assessment",
    lead: "Before we build anything, we look at where you are. Two to three weeks, every process scored L1 to L5, and a roadmap that tells you what to do first.",
    meta: [
      { label: "Duration", value: "2 to 3 weeks" },
      { label: "Output", value: "A scored roadmap" },
      { label: "Commitment after", value: "None" },
    ],
    problem: {
      title: "Most AI roadmaps are written before anyone looked at the ground",
      body: "The pattern is consistent. A board asks for AI in the plan, a vendor demo goes well, and a programme starts on the use case that demoed best rather than on the one the organisation can actually support. Six months later the pilot works and nothing has scaled, because the process underneath it was never ready to carry an agent.",
      points: [
        "Nobody can say which processes are documented well enough to automate",
        "The same business term means different things in three systems",
        "Shadow AI is already in use, and there is no map of where",
      ],
    },
    approach: {
      title: "We score the ground before anyone draws a roadmap on it",
      body: "The assessment is deliberately unglamorous. We interview the people doing the work, read the systems rather than the org chart, and rate each process on a five-level scale so the roadmap is an output of evidence rather than of enthusiasm.",
      steps: [
        { t: "Map the work", b: "Interviews across the teams that would use agents, plus a read of the systems those teams actually touch. Two weeks of listening before any scoring." },
        { t: "Score L1 to L5", b: "Every process rated on documentation, data quality, approval clarity and integration surface. L4 and L5 are the only levels an agent can stand on today." },
        { t: "Price the gaps", b: "For each process below L4, what it would take to lift it, in effort and in weeks. This is what turns a scorecard into a plan." },
        { t: "Sequence it", b: "Quick wins first, structural work in parallel, and an explicit list of what should wait. We say no to more use cases than we say yes to." },
      ],
    },
    deliverables: [
      "A maturity score per process, with the evidence behind each rating",
      "A shadow-AI exposure map: which tools, which teams, which data classes",
      "A data and integration readiness audit across your existing stack",
      "A prioritised roadmap with effort, value and sequencing per use case",
      "A written recommendation on what NOT to attempt this year",
    ],
    proof: { figure: "2–3", unit: "wks", label: "from kick-off to a scored roadmap in your hands" },
    faq: [
      {
        q: "What if the assessment says we are not ready?",
        a: "Then we say so, and the roadmap starts with foundation work rather than with an agent. We would rather lose a quarter of scope than deliver an assistant onto a process that cannot support it.",
      },
      {
        q: "Do we have to continue with you afterwards?",
        a: "No. The assessment is a standalone engagement and the roadmap is yours, written so another partner could execute it. Most clients continue, but nothing in the deliverable depends on that.",
      },
      {
        q: "How much of our team's time does it take?",
        a: "Roughly one hour per interviewee, across eight to fifteen people, plus read access to the systems. We do not ask anyone to fill in a questionnaire.",
      },
    ],
  },
  {
    slug: "agents",
    num: "02",
    nav: "Secured Agents",
    menu: {
      label: "Secured AI Agents",
      blurb: "Agents that run inside your tenant, behind your identity.",
    },
    key: "#ff4d00",
    viz: "",
    visual: SecuredAgents,
    title: "Secured AI Agents",
    lead: "Your teams want agents. Your CISO wants to know where the data goes. Both are right, and the answer should be a document rather than a hope.",
    meta: [
      { label: "First agent live", value: "4 to 8 weeks" },
      { label: "Runs inside", value: "Your tenant" },
      { label: "Writes", value: "Approval-gated" },
    ],
    problem: {
      title: "The security conversation is where most agent projects die",
      body: "The business asks whether the agent is useful. Security asks where the data goes. A programme stalls when each side keeps answering its own question, and it usually stalls quietly, as a renewal that does not happen. A CISO rarely objects to a language model in the abstract. They object to an unbounded, unlogged process holding credentials, and they are right to.",
      points: [
        "No one can say which systems a given agent is able to write to",
        "Credentials sit in environment variables that four people can read",
        "There is no record of what the agent did last Tuesday at 3pm",
      ],
    },
    approach: {
      title: "Encrypt, scope, gate, log",
      body: "Four properties, applied from the first agent rather than retrofitted once someone asks. Together they turn the security review from a negotiation into a document exchange.",
      steps: [
        { t: "Encrypt", b: "Credentials encrypted at rest with AES-GCM and never returned in plaintext to a browser. The vault is the only place a secret exists in readable form." },
        { t: "Scope", b: "Tool grants issued per agent, not per platform. An agent that summarises invoices cannot reach your CRM, because it was never granted it." },
        { t: "Gate", b: "Reads run free, writes stop for a human. That asymmetry is what makes the gate meaningful instead of a dialog everyone learns to dismiss." },
        { t: "Log", b: "Every call recorded with its inputs, outputs and approver, exportable in a form an auditor accepts without a follow-up call." },
      ],
    },
    deliverables: [
      "Agents deployed inside your tenant, behind your identity provider",
      "An encrypted credential vault with no plaintext path to the browser",
      "Per-agent tool grants, documented with who granted what and when",
      "Human-in-the-loop approvals on every write, with auto-approve once a pattern proves itself",
      "An exportable audit trail, retained for as long as your policy requires",
      "A written data-flow document per agent: residency, retention, scope, evidence",
    ],
    proof: { figure: "98", unit: "%", label: "of write actions sitting behind an approval gate" },
    faq: [
      {
        q: "Do agents run on our own infrastructure?",
        a: "They can. Agents run inside your tenant with your identity controls and data residency, and you can route inference to a model you host yourself. Your prompts, your data and the resulting IP stay yours.",
      },
      {
        q: "What does the model provider keep?",
        a: "Nothing we can avoid sending, and nothing for training. We document per deployment which provider handles which class of data, in which region, with what retention. That document is part of the delivery.",
      },
      {
        q: "Can an agent act without a human?",
        a: "Reads are free; writes are gated by default. You decide per agent and per toolkit which writes can be auto-approved once a pattern has proven itself, and every approval, automatic or not, is recorded with its approver.",
      },
      {
        q: "What stops an agent from looping forever?",
        a: "A controller watches for repeated states and forces a replan or an escalation, and every run carries explicit budgets in time, tokens and tool calls. When a budget runs out the run stops cleanly and keeps what it already produced.",
      },
    ],
  },
  {
    slug: "foundation",
    num: "03",
    nav: "Foundation",
    menu: {
      label: "Foundation & Automation",
      blurb: "Structured data and workflows agents can stand on.",
    },
    key: "#ff8a4c",
    viz: "amp-viz-ember",
    visual: FoundationFlow,
    title: "Foundation & Process Automation",
    lead: "AI amplifies whatever is underneath it. If that is a fragmented process, you have just bought faster chaos.",
    meta: [
      { label: "Integrations", value: "57 providers" },
      { label: "Migration required", value: "None" },
      { label: "Typical scope", value: "6 to 12 weeks" },
    ],
    problem: {
      title: "A well-built assistant on a badly-built process",
      body: "There is a particular disappointment that follows this combination. The model is fine. The answers are fluent. And they are wrong often enough that people stop trusting them, because the underlying data says three different things depending on which system you ask. The fix is not a better prompt.",
      points: [
        "\"Active customer\" means one thing in billing and another in the CRM",
        "Approvals follow an unwritten convention that no agent can inherit",
        "Documents live in four places, and permissions are not machine-readable",
      ],
    },
    approach: {
      title: "Structure the work first, then let intelligence amplify it",
      body: "This is not an AI project. It is the process and data work most organisations have been postponing anyway, and it pays for itself before a single agent runs. We do it on the systems you already have, because a migration is a second risk stacked on the first.",
      steps: [
        { t: "One meaning per concept", b: "A canonical model for the entities agents read and write, reconciled across the systems that currently disagree about them." },
        { t: "Redesign, then automate", b: "Automating a broken process makes it break faster. We fix the sequence first, and only then hand steps to a machine." },
        { t: "Rules, not habits", b: "Approvals and hand-offs written as rules a runtime can evaluate, which is also the first time most teams see them written at all." },
        { t: "Wire the existing stack", b: "57 providers, plus anything speaking MCP or HTTP. Nothing gets replaced; the layer between things gets built." },
      ],
    },
    deliverables: [
      "A canonical data model, reconciled across the systems that disagree today",
      "Redesigned processes documented as rules rather than as conventions",
      "Automated hand-offs and approvals between your existing systems",
      "Documents consolidated into one retrievable, permission-aware place",
      "Integration layer across your stack, with no platform migration",
    ],
    proof: { figure: "57", unit: "", label: "systems connected without a single migration" },
    faq: [
      {
        q: "Can we skip this and go straight to agents?",
        a: "You can, and some processes genuinely are ready. The assessment tells you which. What does not work is skipping it everywhere: those programmes end up doing this work later anyway, under time pressure, with an audience.",
      },
      {
        q: "Do you replace our existing tools?",
        a: "No. Agents and automation layer onto the environment you already run. Replacing tools would stack a migration risk on top of an adoption risk, and we have never seen that end well.",
      },
      {
        q: "How do you handle systems with no API?",
        a: "MCP servers or a thin adapter we build and hand over. If a system genuinely cannot be reached safely, we say so and it stays out of scope rather than becoming a fragile screen-scrape.",
      },
    ],
  },
  {
    slug: "adoption",
    num: "04",
    nav: "Adoption",
    menu: {
      label: "Adoption & Enablement",
      blurb: "Champions, use cases, and usage you can measure.",
    },
    key: "#e8b423",
    viz: "amp-viz-deep",
    visual: AdoptionGrid,
    title: "Adoption & Change Enablement",
    lead: "The median assistant usage rate we measure is eight percent of licensed seats. The technology was never the hard part.",
    meta: [
      { label: "Measured", value: "Per team, monthly" },
      { label: "Format", value: "A journey, not a training" },
      { label: "Runs for", value: "3 to 6 months" },
    ],
    problem: {
      title: "A licence paid for twelve months and used for one",
      body: "A company buys three hundred seats. Six months later, twenty-four people use it weekly. The tool works, the rollout email went out, nothing is broken and nothing is happening. This is the most common outcome of an AI programme, and it almost never gets reported as a failure. It gets reported as a renewal decision.",
      points: [
        "A one-hour session teaches the tool and changes nothing about Tuesday",
        "Use cases are written in AI vocabulary, not in the team's vocabulary",
        "Success is measured in logins, which tells you a tab was opened",
      ],
    },
    approach: {
      title: "Adoption happens between colleagues, not in a training room",
      body: "It happens when someone in their own team, doing their own job, shows them a task they both recognise and finishes it in a third of the time. That person is worth more than any enablement deck, and every organisation already has three of them. Our job is to find them and give them room.",
      steps: [
        { t: "Find the champions", b: "One per team, named, with time actually allocated. An unfunded champion is a volunteer, and volunteers stop." },
        { t: "Start where it is loud", b: "The best first use case is the one a team complains about out loud, not the most impressive one. Solve a loud small problem and you earn a quiet large one." },
        { t: "Speak their language", b: "A use-case library written in the team's own words. If it reads like an AI brochure, it will be read like one." },
        { t: "Publish the numbers", b: "Tasks completed per team per month, shared openly. Comparison between peers does more than encouragement from above." },
      ],
    },
    deliverables: [
      "A funded champion network mapped across the teams that will use it",
      "A use-case library written in your teams' vocabulary, not ours",
      "Enablement sessions built on real work rather than on demo data",
      "A monthly measurement framework: tasks completed and hours displaced",
      "A visible request path, so people who want more do not go around you",
    ],
    proof: { figure: "8", unit: "%", label: "median usage we find on arrival, and what we exist to move" },
    faq: [
      {
        q: "Is this just change management with a new label?",
        a: "It is change management, and we would rather say so. What is different is what gets measured: tasks completed and hours displaced per team, not attendance or satisfaction scores.",
      },
      {
        q: "What if our teams resist?",
        a: "Resistance is usually information. In our experience it is rarely fear of the technology and almost always a use case chosen by someone who does not do the work. Changing the use case resolves more resistance than persuasion does.",
      },
      {
        q: "How do you measure whether it worked?",
        a: "Tasks completed with an agent, per team, per month, against the hours those tasks used to take. Both numbers are visible to you from month one, including when they are bad.",
      },
    ],
  },
  {
    slug: "governance",
    num: "05",
    nav: "Governance",
    menu: {
      label: "AI Governance",
      blurb: "Policies, approvals and an audit trail on every action.",
    },
    key: "#7c83d8",
    viz: "amp-viz-grey",
    visual: GovernanceCloud,
    title: "AI Governance",
    lead: "Somewhere in your organisation right now, someone is building an AI flow you do not know about. Governance is not about stopping them.",
    meta: [
      { label: "Registry", value: "Synced from runtime" },
      { label: "Retention", value: "Up to 3 years" },
      { label: "Aligned with", value: "EU AI Act" },
    ],
    problem: {
      title: "The questions most organisations cannot answer",
      body: "Who is allowed to build an agent? What data can it reach? Where does it run? Which systems can it write to? These are not exotic questions, and the inability to answer them is where audit findings start. A registry maintained by hand in a spreadsheet is already out of date on the day it is written.",
      points: [
        "No inventory of which AI systems are in use, or who owns them",
        "Risk classification done uniformly, so low-risk work carries high-risk process",
        "Oversight exists in practice but is documented nowhere",
      ],
    },
    approach: {
      title: "Guardrails wide enough that people build inside them",
      body: "Governance that blocks gets routed around. The aim is a perimeter people can work inside without asking permission for everything, plus enough evidence that the questions above have answers. Most of what the EU AI Act asks a deployer for falls out of this as a by-product.",
      steps: [
        { t: "Derive the registry", b: "The inventory syncs from the systems that actually run the agents, not from a form. A registry nobody has to maintain cannot drift." },
        { t: "Classify proportionally", b: "Drafting and retrieval sit in the low-risk band and need transparency, not a conformity assessment. Hiring and credit do not. Getting this right keeps the effort proportional." },
        { t: "Wire oversight to runs", b: "Approval gates on real executions, which is what makes documented human oversight true rather than aspirational." },
        { t: "Separate environments", b: "An experiment that can reach production data is not an experiment. The boundary is enforced, not agreed." },
      ],
    },
    deliverables: [
      "A live registry of every agent, its owner, its risk class and its data scope",
      "Policies and controls with the evidence attached to each one",
      "Approval gates and incident handling wired to real runs, with named owners",
      "Environment separation between experimentation and production data",
      "Audit exports in the shape a regulator or a customer's security team asks for",
    ],
    faq: [
      {
        q: "Are you EU AI Act ready?",
        a: "The platform produces what the Act asks a deployer for: a registry with owner and data scope, a risk class per system with the reasoning recorded, documented human oversight where it exists, and exportable logs. Because the registry syncs from the runtime, it cannot quietly fall out of date.",
      },
      {
        q: "Who decides what an agent is allowed to touch?",
        a: "You do, per agent, through scoped tool grants. The grant, its approver and its date are part of the registry, so nobody can widen an agent's reach without leaving a trace.",
      },
      {
        q: "Will this slow our teams down?",
        a: "It slows down the things that should be slow, which is a short list: new write scopes, new data classes, high-risk categories. Everything else gets faster, because people stop waiting for a decision nobody was assigned to make.",
      },
    ],
  },
  {
    slug: "managed",
    num: "06",
    nav: "Managed Run",
    menu: {
      label: "Managed Run",
      blurb: "An architect and a developer who know your environment.",
    },
    key: "#a1a1aa",
    viz: "amp-viz-ink",
    visual: ManagedRun,
    title: "Managed Run & Continuous Evolution",
    lead: "The go-live is not the finish line. It is the starting gun. Models update, agents drift, regulations tighten, and capabilities ship every month.",
    meta: [
      { label: "Engagement", value: "Monthly retainer" },
      { label: "Team", value: "Three named people" },
      { label: "Response", value: "Priority SLA" },
    ],
    problem: {
      title: "Month four is where unattended platforms decay",
      body: "The launch goes well. Then a provider deprecates a model, an integration changes a field, a regulation tightens, and the agent that was reliable in March is quietly wrong in July. Nobody notices immediately, because the failure mode of a drifting agent is not an error. It is a plausible answer that is no longer correct.",
      points: [
        "Model updates change behaviour without changing your code",
        "Nobody owns the question of whether the agents are still good",
        "Rebuilding context with a new partner every quarter costs more than the work",
      ],
    },
    approach: {
      title: "Three people who already know your environment",
      body: "Not a ticket queue. A standing team that carries the context, watches the things that decay, and keeps the roadmap moving between releases rather than only at them.",
      steps: [
        { t: "Architect", b: "Owns the shape of the platform, the integration surface and the security posture as both move underneath you." },
        { t: "Functional consultant", b: "Keeps the agents pointed at work that matters, and translates between the teams using them and the runtime running them." },
        { t: "Developer", b: "Ships the changes, tunes models and costs, and fixes the thing that broke on Thursday." },
      ],
    },
    deliverables: [
      "Drift and quality monitoring on every agent in production",
      "Model and cost tuning as the provider landscape moves",
      "Governance kept current against changing regulation",
      "A quarterly roadmap review against measured outcomes, not against activity",
      "Priority response, with a named person rather than a queue",
    ],
    faq: [
      {
        q: "Is this just a support contract?",
        a: "No. Support waits for you to report a problem. This watches for the problems that do not announce themselves, which for agents is most of them.",
      },
      {
        q: "Can we run it ourselves instead?",
        a: "Yes, and some clients do. Everything is documented and handed over, and a hundred percent of the resulting IP is yours. The retainer exists because carrying that context in-house is a real cost, not because we keep the keys.",
      },
      {
        q: "What if we need more than the retainer covers?",
        a: "Larger pieces get scoped as projects alongside it. We would rather quote the work than quietly stretch a retainer thin and have both of us pretend it is covered.",
      },
    ],
  },
];

export function getSolution(slug: string | undefined) {
  return SOLUTIONS.find((s) => s.slug === slug);
}
