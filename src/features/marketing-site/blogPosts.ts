/* ===================== Blog content =====================
   The posts live here rather than in a CMS: the marketing site is a static
   bundle, and a handful of long-form pieces is not worth a fetch on first
   paint. Body blocks are a deliberately small vocabulary, and the renderer in
   BlogPostPage knows exactly these five shapes, so no post can smuggle in a
   layout the design system has not accounted for.

   Posts vary their block order on purpose. Six articles that all run
   p / h2 / p / list / quote read as one article printed six times. */

export type Block =
  | { type: "p"; text: string }
  | { type: "h2"; text: string }
  | { type: "list"; items: string[] }
  | { type: "quote"; text: string; by?: string }
  | { type: "callout"; title: string; text: string };

export type Post = {
  slug: string;
  title: string;
  excerpt: string;
  category: (typeof CATEGORIES)[number];
  date: string; // ISO, formatted at render so the list can sort on it
  readMinutes: number;
  author: { name: string; role: string; initials: string };
  /* Cover art is generated, not photographed: a two-stop wash keyed per post so
     the shelf reads as a set instead of a stock-photo album. The first stop is
     the post's key colour and does double duty as the article hero's hue, so
     keep them DISTINCT across posts: two articles sharing a key open on the
     same field. It is picked for a dark card, so the hero lifts it to clear the
     nav rather than using it raw (see tintFromKey in PageHero). */
  cover: [string, string];
  body: Block[];
};

export const CATEGORIES = [
  "Governance",
  "Agents",
  "Adoption",
  "Security",
  "Engineering",
] as const;

const OLIVIER = { name: "Olivier Kamga", role: "Founder & AI Architect", initials: "OK" };
const LEA = { name: "Léa Verrier", role: "Adoption Lead", initials: "LV" };
const MARC = { name: "Marc Tissot", role: "Principal Consultant", initials: "MT" };

export const POSTS: Post[] = [
  {
    slug: "shadow-ai-is-already-inside",
    title: "Shadow AI is already inside your walls",
    excerpt:
      "Nobody asked for permission, and that is the point. Your teams are pasting client data into public chatbots because the official path is too slow, or does not exist yet.",
    category: "Governance",
    date: "2026-08-04",
    readMinutes: 7,
    author: OLIVIER,
    cover: ["#ff4d00", "#1e1e22"],
    body: [
      {
        type: "p",
        text: "Every organisation we assess believes it has an AI adoption problem in front of it. Almost all of them already have one behind them. Before a single policy was written, somebody in finance pasted a supplier contract into a public chatbot to get a summary, and somebody in support pasted a customer thread to draft a reply. The risk did not arrive with the roadmap. It arrived with the browser tab.",
      },
      { type: "h2", text: "Why banning it does not work" },
      {
        type: "p",
        text: "The instinct is to block the domains. It buys about three weeks. People do not use these tools because they are careless. They use them because the tool removes forty minutes of drudgery from their day and the official alternative removes none. Block the tool without replacing the outcome and the usage moves to a personal device, where you cannot see it at all.",
      },
      {
        type: "quote",
        text: "The question is never whether people will use AI. It is whether you will be able to see it when they do.",
      },
      {
        type: "callout",
        title: "The uncomfortable finding",
        text: "In the assessments we ran this year, the median gap between the first unsanctioned AI use inside a company and the first written AI policy was eleven months.",
      },
      { type: "h2", text: "What to do in the first month" },
      {
        type: "p",
        text: "Shadow AI is a symptom of a latency gap between what people need and what the organisation has sanctioned. Closing it is mostly an exercise in visibility and speed, not in prohibition:",
      },
      {
        type: "list",
        items: [
          "Survey honestly, and promise amnesty. You want the real map, not the compliant one. People will not tell you what they use if the answer gets them written up.",
          "Sanction one path fast. A single approved assistant, running inside your tenant, beats a six-month evaluation of five vendors.",
          "Publish what is allowed with which data class, in one page, in plain language. Most policies fail because nobody can tell which bucket their document falls into.",
          "Instrument it. If you cannot list which agents exist, who owns them and what they touch, you do not have governance. You have a memo.",
        ],
      },
      {
        type: "p",
        text: "None of this requires a platform decision on day one. It requires accepting that the adoption curve started without you, and that your job is to catch up to it with something safer and faster, rather than to argue with it.",
      },
    ],
  },
  {
    slug: "agents-that-survive-production",
    title: "What separates an agent that survives production from a demo",
    excerpt:
      "A demo agent needs to succeed once, on a happy path, with someone watching. A production agent needs to fail safely, ten thousand times, while nobody is looking.",
    category: "Agents",
    date: "2026-07-22",
    readMinutes: 9,
    author: OLIVIER,
    cover: ["#ff8a4c", "#2b0d00"],
    body: [
      {
        type: "quote",
        text: "Design for the failure path first. The happy path is the part the model already handles.",
        by: "Internal engineering note",
      },
      {
        type: "p",
        text: "The gap between a convincing agent demo and an agent you can leave running is not model quality. It has almost never been model quality. It is everything around the model: what happens on the fourth retry, what the agent does when a tool returns an empty list, and whether anyone finds out when it quietly stops.",
      },
      { type: "h2", text: "A verifiable definition of done" },
      {
        type: "p",
        text: "Agents that drift are usually agents that were never told what finished looks like. A mission needs a success contract the runtime can check: a file that exists, a record whose status changed, a number that reconciles. Not the model's own opinion that it did well. Self-assessment is the single most expensive shortcut in agent engineering.",
      },
      { type: "h2", text: "Stagnation is a first-class failure" },
      {
        type: "p",
        text: "Left alone, a stuck agent does not stop. It re-reads the same file, re-runs the same query, and burns budget looking productive. A controller that watches for repeated states and forces a replan, or an escalation to a human, turns an infinite loop into a two-minute interruption.",
      },
      {
        type: "list",
        items: [
          "Every write action gated, every read free, so approvals only sit where they buy you something.",
          "Evidence per step, so a run can be audited after the fact without replaying it.",
          "Explicit budgets in tokens, time and tool calls, with a clean stop when they run out.",
          "A compaction strategy for context, because the fortieth turn is where quality quietly dies.",
        ],
      },
      {
        type: "p",
        text: "None of this is glamorous, and none of it shows up in a demo. It is, however, the entire difference between an agent your team trusts with real work and one that gets quietly switched off in month three.",
      },
    ],
  },
  {
    slug: "eight-percent-adoption-problem",
    title: "The eight percent problem",
    excerpt:
      "The median assistant usage rate we measure is eight percent of licensed seats. The technology was never the hard part.",
    category: "Adoption",
    date: "2026-07-09",
    readMinutes: 6,
    author: LEA,
    cover: ["#7c83d8", "#17171a"],
    body: [
      {
        type: "p",
        text: "A company buys three hundred assistant licences. Six months later, twenty-four people use it weekly. The tool works. The rollout email went out. Nothing is broken, and nothing is happening. This is the most common outcome of an AI programme, and it almost never gets reported as a failure. It gets reported as a renewal decision.",
      },
      { type: "h2", text: "Training is not adoption" },
      {
        type: "p",
        text: "A one-hour session teaches people what the tool does. It does not change what they do on Tuesday morning. Adoption happens when someone in their own team, doing their own job, shows them a task they both recognise and finishes it in a third of the time. That person is worth more than any enablement deck, and every organisation already has three of them.",
      },
      {
        type: "list",
        items: [
          "One champion per team, named, with time actually allocated for it.",
          "Use cases written in the team's own vocabulary, not in AI vocabulary.",
          "A monthly number per team, shared openly. Comparison does more than encouragement.",
          "A visible path for requests, so the people who want more do not have to go around you.",
        ],
      },
      {
        type: "callout",
        title: "What we measure instead of logins",
        text: "Tasks completed with an agent, per team, per month, and the hours those tasks used to take. A login tells you somebody opened a tab. A completed task tells you the work moved.",
      },
      { type: "h2", text: "Start where the pain is loud" },
      {
        type: "p",
        text: "The best first use case is rarely the most impressive one. It is the one a team complains about out loud: the weekly report nobody wants to assemble, the inbox triage, the quote that takes four systems to produce. Solve a loud, small problem well and you buy the credibility to attempt a quiet, large one.",
      },
    ],
  },
  {
    slug: "where-does-the-data-go",
    title: "\"Where does the data go?\" Answering your CISO properly",
    excerpt:
      "The security conversation stalls because both sides are answering different questions. Here is the version that ends it.",
    category: "Security",
    date: "2026-06-27",
    readMinutes: 8,
    author: MARC,
    cover: ["#12574a", "#08120f"],
    body: [
      {
        type: "p",
        text: "The business asks whether the agent is useful. Security asks where the data goes. Both questions are reasonable, and a programme stalls when each side keeps answering its own. The way through is to make the second question answerable in writing, with specifics, before the first one is even settled.",
      },
      { type: "h2", text: "Four specifics that end the argument" },
      {
        type: "list",
        items: [
          "Residency: which region the inference runs in, and whether prompts leave it at all.",
          "Retention: what the provider keeps, for how long, and whether it trains on it.",
          "Scope: which systems this specific agent can read, which it can write, and who granted that.",
          "Evidence: whether every call is logged in a form you can export to an auditor.",
        ],
      },
      {
        type: "p",
        text: "Notice that none of these are about the model. A CISO rarely objects to a language model in the abstract. They object to an unbounded, unlogged process holding credentials, and they are right to.",
      },
      {
        type: "quote",
        text: "An agent your security team cannot describe is an agent your security team will eventually switch off.",
      },
      { type: "h2", text: "Encrypt, scope, gate, log" },
      {
        type: "p",
        text: "Credentials encrypted at rest and never returned in plaintext to a browser. Tool grants scoped per agent rather than per platform. Write actions gated behind a human approval, reads left free so the gate means something. Every call recorded with its inputs, its outputs and its approver. Do those four and the security review becomes a document exchange rather than a negotiation.",
      },
    ],
  },
  {
    slug: "foundation-before-intelligence",
    title: "Foundation before intelligence",
    excerpt:
      "AI amplifies whatever is underneath it. If that is a fragmented process, you have just bought faster chaos.",
    category: "Engineering",
    date: "2026-06-11",
    readMinutes: 7,
    author: OLIVIER,
    cover: ["#e8b423", "#2a2109"],
    body: [
      {
        type: "p",
        text: "There is a particular kind of disappointment that follows a well-built assistant landing on a badly-built process. The model is fine. The answers are fluent. And they are wrong often enough that people stop trusting them, because the underlying data says three different things depending on which system you ask.",
      },
      {
        type: "callout",
        title: "A cheap test",
        text: "Ask three people in different teams to define your most-used business term. If you get three answers, an agent will get three answers too, and it will pick one, confidently.",
      },
      { type: "h2", text: "The three things agents need underneath" },
      {
        type: "list",
        items: [
          "One canonical meaning per concept. If \"active customer\" means something different in billing and in CRM, no agent can reconcile that for you.",
          "Documents in one retrievable place, with permissions that are readable by a machine.",
          "Approvals that follow a rule rather than a habit. An agent cannot inherit an unwritten convention.",
        ],
      },
      {
        type: "p",
        text: "The good news is that this work is not an AI project. It is the process and data work most organisations have been postponing anyway, and it pays for itself before a single agent runs. The bad news is that it cannot be skipped, and every programme that tries ends up doing it later, under time pressure, with an audience.",
      },
    ],
  },
  {
    slug: "eu-ai-act-without-panic",
    title: "The EU AI Act without the panic",
    excerpt:
      "Most of what the Act asks for is a registry, a risk classification and evidence. If you run agents properly, you are most of the way there.",
    category: "Governance",
    date: "2026-05-28",
    readMinutes: 10,
    author: MARC,
    cover: ["#a1a1aa", "#1e1e22"],
    body: [
      {
        type: "p",
        text: "The Act reads as intimidating and lands as administrative. Strip out the parts that apply to model providers and what remains, for most companies deploying agents, is a small set of obligations that good engineering practice already produces as a by-product.",
      },
      { type: "h2", text: "Know what you run" },
      {
        type: "p",
        text: "An inventory of every AI system in use, its purpose, its owner and its data scope. If your registry is maintained by hand in a spreadsheet, it is already out of date. If it is derived from the systems that actually run the agents, it cannot be.",
      },
      { type: "h2", text: "Classify, then act proportionally" },
      {
        type: "p",
        text: "Most internal agents doing drafting, summarising and retrieval sit in the low-risk band and need transparency, not a conformity assessment. The ones that touch hiring, credit, or access to services do not. Getting the classification right early is what keeps the governance effort proportional instead of uniform and exhausting.",
      },
      {
        type: "list",
        items: [
          "A registry that syncs from the runtime, not from a form.",
          "Risk class per system, with the reasoning recorded next to it.",
          "Human oversight documented where it exists. Approval gates count.",
          "Logs retained long enough to answer a question you have not been asked yet.",
        ],
      },
      {
        type: "quote",
        text: "Compliance is not a document you write at the end. It is a shape you give the system at the start.",
      },
    ],
  },
  {
    slug: "cost-of-an-agent",
    title: "What an agent actually costs to run",
    excerpt:
      "Model pricing is the number everyone quotes and rarely the number that matters. Here is where the spend really goes.",
    category: "Engineering",
    date: "2026-05-14",
    readMinutes: 6,
    author: OLIVIER,
    cover: ["#c1436d", "#2b0a16"],
    body: [
      {
        type: "p",
        text: "Teams budget for AI by looking up a price per million tokens and multiplying. The result is usually wrong by an order of magnitude in both directions: too low because a mission is not one call, too high because most of a well-built agent's traffic never needs the expensive model.",
      },
      { type: "h2", text: "A mission is not a message" },
      {
        type: "p",
        text: "A conversational reply is one round trip. A mission is a loop: plan, act, observe, replan, verify. Twenty to eighty calls is normal, and the context grows with each one unless something is actively compacting it. That growth, not the per-token rate, is what determines the bill.",
      },
      {
        type: "callout",
        title: "Rule of thumb",
        text: "In the deployments we run, model tiering and context compaction together cut spend by 60 to 75 percent with no measurable drop in task success.",
      },
      { type: "h2", text: "Where the savings actually are" },
      {
        type: "list",
        items: [
          "Tier the model: a cheap one for routing and extraction, an expensive one only when the run escalates.",
          "Compact context aggressively. An agent re-reading its own transcript is paying for the same tokens repeatedly.",
          "Trim tool definitions. Fifty tools in the system prompt on every call is a fixed tax on every single turn.",
          "Cache what is stable. Prompt caching is the cheapest optimisation nobody turns on.",
        ],
      },
    ],
  },
];

/** Newest first, the list order everywhere the posts are shown. */
export const POSTS_BY_DATE = [...POSTS].sort((a, b) => b.date.localeCompare(a.date));

export function getPost(slug: string | undefined) {
  return POSTS.find((p) => p.slug === slug);
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
