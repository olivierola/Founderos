import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ClockIcon as Clock,
  FingerprintIcon as Fingerprint,
  KeyIcon as Key,
  ListChecksIcon as ListChecks,
  LockKeyIcon as LockKey,
  ShieldCheckIcon as ShieldCheck,
  SquaresFourIcon as Squares,
  StackIcon as Stack,
  CpuIcon as Cpu,
} from "@phosphor-icons/react";
import { SOLUTIONS } from "../../solutions";
import { POSTS_BY_DATE, formatDate } from "../../blogPosts";
import { AccordionList, ArtPanel, Btn, Card, Chip, Container, Eyebrow, FeatureCard, H, Head, P, ProductMark, ProductShot, type IconType } from "../HnKit";
import { ChatMock, RunMock, ToolGrid } from "../Mocks";
import { CATEGORY_ART, PRODUCTS, SOLUTION_ART } from "../site";

/* ══ The principle ═══════════════════════════════════════════════════════════
   The reference's testimonial block — a portrait on a slanted panel, the
   customer's logo, the quote, the name. We have no customer to quote yet, so
   the block carries the rule the product runs on, attributed to what it is. */
export function HomePrincipleHn() {
  return (
    <section className="bg-white py-20 lg:py-28">
      <Container narrow className="grid items-center gap-12 lg:grid-cols-[450px_1fr] lg:gap-16">
        <ArtPanel art="blue" className="relative grid h-[380px] place-items-center overflow-hidden rounded-[24px] p-8 sm:h-[440px]">
          <div
            aria-hidden
            className="absolute inset-0 bg-white"
            style={{ clipPath: "polygon(0 0, 100% 0, 0 100%)", opacity: 0.9 }}
          />
          <RunMock className="relative w-full max-w-[360px]" />
        </ArtPanel>
        <div>
          <Chip className="border-[#d7e7fb] bg-[#eaf2ff] font-medium text-[#006edd]">The rule every Cloud collaborator runs under</Chip>
          <blockquote className="mt-6 text-[32px] font-medium leading-[1.2] tracking-[-0.04em] text-[#0f1728]">
            “Read freely. Write only with your approval. Keep a trace of everything.”
          </blockquote>
          <div className="mt-6 text-[20px] font-medium leading-[1.3] text-[#0f1728]">Every Anduran Cloud collaborator</div>
          <div className="text-[20px] font-medium leading-[1.3] text-[#4b5567]">unless you switch it to autonomous mode yourself</div>
          <Btn to="/docs" variant="link" className="mt-8">
            Read how it works
          </Btn>
        </div>
      </Container>
    </section>
  );
}

/* ══ Anduran Govern ══════════════════════════════════════════════════════════
   The reference's second dark band: "best for large teams", the product name
   tag and its pitch, a big screen of the product sitting on a blue strip; then
   one block per solution — an accordion of what it does beside a picture, and
   three facts underneath. */

const BLOCKS = ["agents", "governance", "adoption"];

const BLOCK_CHAT: Record<string, { agent: string; lines: { from: "you" | "agent"; text: string }[] }> = {
  agents: {
    agent: "Finance collaborator",
    lines: [
      { from: "you", text: "Raise the credit note for invoice 1042." },
      { from: "agent", text: "I can, it's a write action on the ledger, so it waits for your approval." },
    ],
  },
  governance: {
    agent: "Governance collaborator",
    lines: [
      { from: "agent", text: "This Cloud collaborator was about to touch personnel data. That's outside its declared scope, so I stopped it." },
      { from: "you", text: "Good. Log it and tell me who owns the policy." },
    ],
  },
  adoption: {
    agent: "Adoption collaborator",
    lines: [
      { from: "agent", text: "Nine of your twelve champions used a Cloud collaborator this week. Finance hasn't yet, worth a look?" },
      { from: "you", text: "Yes, set up a session with them." },
    ],
  },
};

const META_ICON: IconType[] = [Clock, Squares, ShieldCheck];

function SolutionBlock({ slug }: { slug: string }) {
  const s = SOLUTIONS.find((x) => x.slug === slug)!;
  const [open, setOpen] = useState(0);
  const chat = BLOCK_CHAT[slug];
  return (
    <div className="border-t border-white/10 px-6 py-16 sm:px-12 lg:px-24">
      <div className="grid gap-10 lg:grid-cols-2 lg:gap-12">
        <div>
          <h3 className="text-[32px] font-medium leading-[1.2] tracking-[-0.04em] text-white">{s.menu.label}</h3>
          <P tone="dim" className="mt-4 max-w-[40ch]">{s.lead}</P>
          <Btn to={`/solutions/${s.slug}`} variant="link-light" className="mt-6">
            Learn more about {s.nav.toLowerCase()}
          </Btn>
          <div className="mt-10">
            <AccordionList tone="dark" value={open} onChange={setOpen} items={s.approach.steps.map((st) => ({ title: st.t, body: st.b }))} />
          </div>
        </div>
        <div className="rounded-[28px] border border-white/10 bg-white/[0.05] p-6">
          <ArtPanel art={SOLUTION_ART[s.slug] ?? "blue"} className="grid h-full min-h-[420px] place-items-center rounded-[24px] p-6">
            {chat && <ChatMock agent={chat.agent} lines={chat.lines} />}
          </ArtPanel>
        </div>
      </div>
      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {s.meta.map((m, i) => {
          const Icon = META_ICON[i % META_ICON.length];
          return (
            <Card key={m.label} tone="dark" hover className="flex min-h-[200px] flex-col p-4">
              <Icon className="h-8 w-8 text-white" />
              <div className="mt-auto pt-10">
                <div className="text-[20px] font-medium leading-[1.3] text-white">{m.label}</div>
                <div className="mt-1 text-[18px] leading-[1.3] text-white/75">{m.value}</div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export function HomeGovernHn() {
  const p = PRODUCTS[1];
  return (
    <section className="hn-dark text-white">
      <div className="hn-rails mx-5 sm:mx-8 lg:mx-12">
        <div className="grid gap-10 px-6 pb-14 pt-20 sm:px-12 lg:grid-cols-2 lg:px-24">
          <div className="self-end">
            <Eyebrow tone="dark">{p.bestFor}</Eyebrow>
            <H tone="white" className="mt-6 max-w-[18ch]">Governance built in, for teams that answer to an auditor.</H>
          </div>
          <div className="lg:justify-self-end">
            <span className="inline-flex items-center rounded-full border border-white/15 bg-white/[0.05] px-5 py-3">
              <ProductMark word={p.short} size={20} />
            </span>
            <P tone="dim" className="mt-8 max-w-[30ch]">Registry, policies, approvals and an exportable audit trail, for every Cloud collaborator.</P>
            <Btn to={`/product/${p.slug}`} variant="white" className="mt-6">Learn more</Btn>
          </div>
        </div>
        <div className="relative px-6 sm:px-12 lg:px-24">
          <div aria-hidden className="hn-sky absolute inset-x-0 bottom-0 top-[60%]" />
          <div className="relative rounded-[28px] border border-white/10 bg-white/[0.04] p-4 sm:p-6">
            <ProductShot src={p.shot} alt={p.shotAlt} className="aspect-[1440/860] w-full" />
          </div>
          <div className="relative h-12" />
        </div>
        {BLOCKS.map((slug) => (
          <SolutionBlock key={slug} slug={slug} />
        ))}
      </div>
    </section>
  );
}

/* ══ Built for scrutiny ══════════════════════════════════════════════════════
   The reference's "Tested. Trusted. Enterprise ready." grid. Every card here
   is a measure that exists in the product — no certification we do not hold,
   no uptime we have not measured. */
const TRUST = [
  { icon: LockKey, title: "Encrypted at rest", body: "Connector credentials encrypted with AES-256-GCM, decrypted only server-side at call time." },
  { icon: Stack, title: "Isolated per workspace", body: "Row-level security on every table, and storage partitioned per customer." },
  { icon: Fingerprint, title: "Two-factor sign-in", body: "TOTP two-factor authentication available on every account." },
  { icon: Key, title: "Scoped tool grants", body: "Each Cloud collaborator gets an explicit list of tools. Outside it, the call stops." },
  { icon: ListChecks, title: "Exportable audit log", body: "Arguments, result, duration and run for every call, exportable for review." },
  { icon: Cpu, title: "Self-hostable model", body: "Point a Cloud collaborator at an OpenAI-compatible endpoint you host; prompts stay on your network." },
];

export function HomeTrustHn() {
  return (
    <section className="border-t border-[#e6e9ef] bg-white py-20 lg:py-28">
      <Container narrow>
        <Head
          eyebrow="Security"
          title="Security and governance by design"
          lead="Every safeguard below is live in the product today, and verifiable. Certifications will appear here once they are issued."
        />
        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {TRUST.map((t) => (
            <FeatureCard key={t.title} tone="bg" icon={t.icon} title={t.title} body={t.body} />
          ))}
        </div>

        <Card tone="bg" className="mt-6 grid items-center gap-10 p-8 sm:p-12 lg:grid-cols-2">
          <div>
            <Eyebrow>Plug and play</Eyebrow>
            <H size="sub" className="mt-3">Works with the systems you already run</H>
            <P className="mt-4 max-w-[40ch]">
              Connect Cloud collaborators to your work, business, delivery and data tools, or anything that speaks MCP or HTTP.
              No migration, no second source of truth.
            </P>
            <Btn to="/integrations" variant="link" className="mt-6">See every integration</Btn>
          </div>
          <ToolGrid
            names={["Microsoft 365", "Slack", "Salesforce", "Google Workspace", "HubSpot", "SAP", "Teams", "Jira", "GitHub", "Notion", "Snowflake", "Okta"]}
          />
        </Card>
      </Container>
    </section>
  );
}

/* ══ From the blog ═══════════════════════════════════════════════════════════
   Where the reference shows three customer testimonials, we show our three
   latest articles — real content we can stand behind. */
export function HomeBlogHn() {
  const posts = POSTS_BY_DATE.slice(0, 3);
  return (
    <section className="border-t border-[#e6e9ef] bg-white py-20 lg:py-24">
      <Container narrow>
        <Head
          align="left"
          eyebrow="From the blog"
          title={
            <>
              Insights on running
              <br />
              Cloud collaborators in production.
            </>
          }
          lead="Practical lessons on governance, adoption and engineering, from putting Cloud collaborators to work on real systems."
        >
          <Btn to="/blog" variant="link">Go to the blog</Btn>
        </Head>
        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {posts.map((p) => (
            <Link key={p.slug} to={`/blog/${p.slug}`} className="group">
              <Card hover className="h-full overflow-hidden">
                <ArtPanel art={CATEGORY_ART[p.category] ?? "blue"} className="h-[200px]" />
                <div className="p-5">
                  <div className="flex items-center gap-3 text-[14px] text-[#4b5567]">
                    <Chip className="px-2 py-1 text-[13px]">{p.category}</Chip>
                    {formatDate(p.date)}
                  </div>
                  <h3 className="mt-4 text-[20px] font-medium leading-[1.3] text-[#0f1728] transition-colors group-hover:text-[#006edd]">
                    {p.title}
                  </h3>
                  <p className="mt-2 text-[18px] leading-[1.3] text-[#4b5567]">{p.excerpt}</p>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </Container>
    </section>
  );
}

