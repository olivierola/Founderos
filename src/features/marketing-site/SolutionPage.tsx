import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  CheckCircleIcon as CheckCircle,
  ClockIcon as Clock,
  ShieldCheckIcon as ShieldCheck,
  SquaresFourIcon as Squares,
  WarningCircleIcon as WarningCircle,
} from "@phosphor-icons/react";
import { SOLUTIONS, getSolution } from "./solutions";
import { ALL_TOOLS, ToolMark } from "./tools";
import { HnHero, HnPage } from "./hn/HnPage";
import { AccordionList, ArtPanel, Btn, Card, Container, FaqGrid, H, Head, P, type IconType } from "./hn/HnKit";
import { ChatMock } from "./hn/Mocks";
import { SOLUTION_ART } from "./hn/site";
import { UseCaseCarousel } from "./hn/home/HomeProductsHn";

/* ═══ One solution ═══════════════════════════════════════════════════════════
   Six sibling pages on hunar.ai's "Solutions for …" template: a split hero
   (text left, a tall artwork right), a quote-and-picture card, a feature block
   (an accordion beside a picture, three facts under it), the stories
   carousel, a two-column FAQ, and the close.

   Where the reference quotes a customer, we state the problem the solution
   exists for — no customer has agreed to be quoted yet. Everything else comes
   from solutions.ts, the same data the nav and the footer read. */

const CHAT: Record<string, { agent: string; lines: { from: "you" | "agent"; text: string }[] }> = {
  readiness: {
    agent: "Readiness Cloud collaborator",
    lines: [
      { from: "agent", text: "Order-to-cash scores L2: the approval rules live in three inboxes. Fix that first and it clears L4." },
      { from: "you", text: "What else is ready today?" },
    ],
  },
  agents: {
    agent: "Finance collaborator",
    lines: [
      { from: "you", text: "Raise the credit note for invoice 1042." },
      { from: "agent", text: "I can, it's a write action on the ledger, so it waits for your approval." },
    ],
  },
  foundation: {
    agent: "Foundation Cloud collaborator",
    lines: [
      { from: "agent", text: "Three systems call this field “client”. I've mapped them to one and flagged the rows that disagree." },
      { from: "you", text: "Send me the list." },
    ],
  },
  adoption: {
    agent: "Adoption collaborator",
    lines: [
      { from: "agent", text: "Nine of your twelve champions used a Cloud collaborator this week. Finance hasn't yet, worth a look?" },
      { from: "you", text: "Yes, set up a session with them." },
    ],
  },
  governance: {
    agent: "Governance collaborator",
    lines: [
      { from: "agent", text: "This Cloud collaborator was about to touch personnel data. That's outside its declared scope, so I stopped it." },
      { from: "you", text: "Good. Log it and tell me who owns the policy." },
    ],
  },
  managed: {
    agent: "Run Cloud collaborator",
    lines: [
      { from: "agent", text: "The model provider shipped a breaking change on Tuesday. Your four Cloud collaborators were migrated Wednesday." },
      { from: "you", text: "Anything I need to check?" },
    ],
  },
};

const META_ICON: IconType[] = [Clock, Squares, ShieldCheck];
const MARKS = ALL_TOOLS.filter((t) => ["Microsoft 365", "Salesforce", "Slack", "SAP", "Snowflake"].includes(t.name));

export function SolutionPage() {
  const { slug } = useParams();
  const solution = getSolution(slug);
  const [open, setOpen] = useState(0);

  useEffect(() => {
    window.scrollTo({ top: 0 });
    setOpen(0);
  }, [slug]);

  if (!solution) return <Navigate to="/solutions" replace />;

  const art = SOLUTION_ART[solution.slug] ?? "blue";
  const chat = CHAT[solution.slug];
  const others = SOLUTIONS.filter((s) => s.slug !== solution.slug);

  return (
    <HnPage>
      {/* ══ Hero ═════════════════════════════════════════════════════════ */}
      <HnHero
        variant="split"
        tone="white"
        eyebrow={`Solutions for ${solution.nav}`}
        title={solution.title}
        lead={solution.lead}
        note={
          <div>
            <div className="max-w-[320px]">Works on the systems you already run</div>
            <div className="mt-5 flex flex-wrap items-center gap-7 text-[#7a8496]">
              {MARKS.map((t) => (
                <span key={t.name} className="flex items-center gap-1.5">
                  <span style={{ color: `#${t.hex}` }} className="flex"><ToolMark tool={t} size={18} /></span>
                  <span className="text-[15px] font-semibold tracking-[-0.02em]">{t.name}</span>
                </span>
              ))}
            </div>
          </div>
        }
        aside={
          <ArtPanel art={art} className="flex h-full min-h-[480px] items-center justify-center rounded-[24px] p-6 lg:min-h-[640px]">
            {chat && <ChatMock agent={chat.agent} lines={chat.lines} className="max-w-[380px]" />}
          </ArtPanel>
        }
      >
        <Btn to="/contact">Book a demo</Btn>
      </HnHero>

      {/* ══ The problem — where the reference quotes a customer ════════════ */}
      <section className="bg-white py-16 lg:py-20">
        <Container narrow className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <Card tone="bg" className="flex flex-col p-6 sm:p-8">
            <h2 className="text-[28px] font-medium leading-[1.2] tracking-[-0.04em] text-[#0f1728] sm:text-[32px]">
              “{solution.problem.title}”
            </h2>
            <p className="mt-6 text-[18px] leading-[1.3] text-[#4b5567]">{solution.problem.body}</p>
            <div className="mt-auto pt-10">
              <div className="text-[20px] font-medium leading-[1.3] text-[#0f1728]">The problem</div>
              <div className="text-[20px] font-medium leading-[1.3] text-[#4b5567]">{solution.menu.label}</div>
            </div>
          </Card>
          <ArtPanel art={art} className="flex min-h-[420px] flex-col justify-center gap-3 rounded-[24px] p-8">
            {solution.problem.points.map((pt) => (
              <div key={pt} className="flex items-start gap-3 rounded-[24px] bg-white/90 px-4 py-3 text-[16px] leading-[1.35] text-[#0f1728] backdrop-blur-sm">
                <WarningCircle weight="fill" className="mt-0.5 h-5 w-5 shrink-0 text-[#d97706]" />
                {pt}
              </div>
            ))}
          </ArtPanel>
        </Container>
      </section>

      {/* ══ The approach — accordion, picture, three facts ═════════════════ */}
      <section className="bg-white pb-16 lg:pb-24">
        <Container narrow>
          <div className="grid gap-10 lg:grid-cols-2 lg:gap-12">
            <div className="flex flex-col">
              <div className="px-6">
                <H>{solution.approach.title}</H>
                <P className="mt-4 max-w-[450px]">{solution.approach.body}</P>
              </div>
              <div className="mt-10 lg:mt-auto">
                <AccordionList
                  value={open}
                  onChange={setOpen}
                  items={solution.approach.steps.map((s) => ({ title: s.t, body: s.b }))}
                />
              </div>
            </div>
            <ArtPanel art={art} className="flex min-h-[460px] items-center justify-center rounded-[28px] p-8">
              <div className="w-full max-w-[420px] rounded-[18px] bg-white p-5 text-[#0f1728] shadow-[0_30px_60px_-30px_rgba(0,20,60,0.55)]">
                <div className="text-[14px] text-[#4b5567]">Step {open + 1} of {solution.approach.steps.length}</div>
                <div className="mt-1 text-[24px] font-medium leading-[1.2] tracking-[-0.04em]">{solution.approach.steps[open]?.t}</div>
                <p className="mt-3 text-[16px] leading-[1.4] text-[#4b5567]">{solution.approach.steps[open]?.b}</p>
              </div>
            </ArtPanel>
          </div>
          <div className="mt-6 grid gap-6 md:grid-cols-3">
            {solution.meta.map((m, i) => {
              const Icon = META_ICON[i % META_ICON.length];
              return (
                <Card key={m.label} tone="bg" hover className="flex min-h-[200px] flex-col p-4">
                  <Icon className="h-8 w-8 text-[#c9c9c9]" />
                  <div className="mt-auto pt-10">
                    <div className="text-[20px] font-medium leading-[1.3] text-[#0f1728]">{m.label}</div>
                    <div className="mt-1 text-[18px] leading-[1.3] text-[#4b5567]">{m.value}</div>
                  </div>
                </Card>
              );
            })}
          </div>
        </Container>
      </section>

      {/* ══ What you walk away with ════════════════════════════════════════ */}
      <section className="border-t border-[#e6e9ef] bg-[#f7f8fb] py-16 lg:py-24">
        <Container narrow className="grid gap-10 lg:grid-cols-2 lg:gap-16">
          <div>
            <Head align="left" eyebrow="Deliverables" title="Everything on this list is yours to keep" />
            {solution.proof && (
              <div className="mt-10 border-l-2 border-[#006edd] pl-5">
                <div className="text-[32px] font-medium leading-[1.2] tracking-[-0.04em] text-[#0f1728]">
                  {solution.proof.figure}
                  <span className="text-[#006edd]">{solution.proof.unit}</span>
                </div>
                <div className="mt-1 max-w-[320px] text-[18px] leading-[1.3] text-[#4b5567]">{solution.proof.label}</div>
              </div>
            )}
          </div>
          <ul className="space-y-3">
            {solution.deliverables.map((d) => (
              <li key={d} className="hn-card hn-hover flex items-start gap-3 rounded-[24px] border border-[#e6e9ef] bg-white px-5 py-4 text-[18px] leading-[1.3] text-[#0f1728]">
                <CheckCircle weight="fill" className="mt-0.5 h-5 w-5 shrink-0 text-[#006edd]" />
                {d}
              </li>
            ))}
          </ul>
        </Container>
      </section>

      {/* ══ Use cases ══════════════════════════════════════════════════════ */}
      <section className="border-t border-[#e6e9ef] bg-white py-16 lg:py-24">
        <Container>
          <Head
            eyebrow="Use cases"
            title="Real work. Real systems."
            lead="Illustrative workflows, what a Cloud collaborator does in each, described as the product runs it. Not customer results."
          />
        </Container>
        <div className="mt-12 pl-5 sm:pl-8 lg:pl-12">
          <UseCaseCarousel />
        </div>
      </section>

      {/* ══ FAQ ════════════════════════════════════════════════════════════ */}
      <section className="bg-white pb-16 lg:pb-24">
        <Container narrow>
          <H>Frequently asked questions</H>
          <P className="mt-2 max-w-[640px]">
            What teams ask about {solution.menu.label.toLowerCase()} before they start.
          </P>
          <div className="mt-8">
            <FaqGrid items={solution.faq} />
          </div>
        </Container>
      </section>

      {/* ══ The other solutions ════════════════════════════════════════════ */}
      <section className="border-t border-[#e6e9ef] bg-[#f7f8fb] py-16">
        <Container narrow>
          <div className="text-[16px] font-medium text-[#4b5567]">The other solutions</div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {others.map((s) => (
              <Link key={s.slug} to={`/solutions/${s.slug}`} className="group">
                <Card hover className="h-full overflow-hidden">
                  <ArtPanel art={SOLUTION_ART[s.slug] ?? "blue"} className="h-20" />
                  <div className="p-4">
                    <div className="text-[16px] font-medium leading-[1.3] text-[#0f1728] group-hover:text-[#006edd]">{s.menu.label}</div>
                    <div className="mt-1 text-[14px] leading-[1.4] text-[#4b5567]">{s.menu.blurb}</div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </Container>
      </section>
    </HnPage>
  );
}
