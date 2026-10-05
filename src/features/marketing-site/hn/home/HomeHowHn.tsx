import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BookOpenTextIcon as BookOpen,
  CalendarCheckIcon as CalendarCheck,
  ChatsCircleIcon as Chats,
  FileTextIcon as FileText,
  HandPalmIcon as HandPalm,
  PlugsConnectedIcon as Plugs,
} from "@phosphor-icons/react";
import { ArtPanel, Btn, Container, Eyebrow, FeatureCard, H, Head, P, ProductMark, ProductShot, type Art } from "../HnKit";
import {
  StepConnectMock,
  StepGuardrailsMock,
  StepInstructionsMock,
  StepLiveMock,
  StepReviewMock,
  StepTemplateMock,
} from "../Mocks";
import { PRODUCTS } from "../site";

/* ══ The product band ════════════════════════════════════════════════════════
   The reference's blue band: a product name tag, "best for", the claim and a
   link on the left, a screen of the product running off the right edge. */
export function HomeAgentsBandHn() {
  const p = PRODUCTS[0];
  return (
    <section className="hn-sky overflow-hidden">
      <div className="px-5 sm:px-8 lg:px-12">
        <div className="pt-16 lg:pt-20">
          <span className="inline-flex items-center rounded-full border border-white/25 bg-white/10 px-5 py-3 backdrop-blur-md">
            <ProductMark word={p.short} size={20} />
          </span>
        </div>
        <div className="grid items-center gap-12 pt-14 lg:grid-cols-[0.75fr_1.25fr] lg:gap-16">
          <div className="pb-16 lg:pb-28">
            <Eyebrow tone="white">{p.bestFor}</Eyebrow>
            <H tone="white" size="hero" className="mt-5 max-w-[14ch] !text-[40px] sm:!text-[48px]">
              Your first agent, live in minutes
            </H>
            <P tone="dim" className="mt-5 max-w-[36ch]">
              Start from a template, add your company context, connect your tools, and hand your agent its first
              mission. No code, no integration project.
            </P>
            <div className="mt-9 flex flex-wrap items-center gap-5">
              <Btn to="/contact" variant="white">Book a demo</Btn>
              <Btn to={`/product/${p.slug}`} variant="link" className="!text-white hover:!text-white/80">
                Learn more
              </Btn>
            </div>
          </div>
          <div className="-mr-5 self-end sm:-mr-8 lg:-mr-12">
            <ProductShot src={p.shot} alt={p.shotAlt} className="aspect-[1440/860] w-full min-w-[640px] rounded-b-none rounded-r-none lg:min-w-0" />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ══ Built for real work ═════════════════════════════════════════════════════
   Six icon cards on the pale-blue ground — the reference's "Built for
   conversations at scale". */
const FEATURES = [
  { icon: Plugs, title: "Your systems, not a copy", body: "Agents read your data where it lives, through the connectors you authorise. Nothing is migrated." },
  { icon: HandPalm, title: "Approval-gated writes", body: "Writing, sending, deleting and paying stop and wait for you, in the conversation." },
  { icon: CalendarCheck, title: "Missions on a schedule", body: "Hand an agent a job once, on demand, on a cadence or at a set date." },
  { icon: BookOpen, title: "Knowledge it can search", body: "Collections of PDFs, documents and spreadsheets, built once and shared across agents." },
  { icon: Chats, title: "Rooms with people and agents", body: "Mention an agent to bring it into a conversation; follow its work live." },
  { icon: FileText, title: "Reports, written properly", body: "A dedicated agent writes deliverables from your figures, with sources cited, ready as PDF." },
];

export function HomeFeaturesHn() {
  return (
    <section className="bg-[#f3f7fe] py-20 lg:py-24">
      <Container narrow>
        <Head
          eyebrow="Platform"
          title="Everything an agent needs to deliver real work"
          lead="Connect your tools, give agents knowledge and missions, and stay in control of every action they take."
        />
        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <FeatureCard key={f.title} icon={f.icon} title={f.title} body={f.body} />
          ))}
        </div>
      </Container>
    </section>
  );
}

/* ══ How it works ════════════════════════════════════════════════════════════
   The reference pins the section and slides a row of screens sideways as you
   scroll down. Same here on wide screens: a tall runway, a sticky stage, and
   the track translated by the scroll progress through the runway. On narrow
   screens it falls back to a plain horizontal scroller. */
const STEPS: { title: string; body: string; art: Art; mock: ReactNode }[] = [
  { title: "Pick a template", body: "Start from an agent built for the job and adjust it.", art: "blue", mock: <StepTemplateMock /> },
  { title: "Describe the job", body: "Write what the agent must do, its rules and its tone, in plain language.", art: "violet", mock: <StepInstructionsMock /> },
  { title: "Connect your tools", body: "Authorise a connector, then grant each agent only the tools it needs.", art: "olive", mock: <StepConnectMock /> },
  { title: "Set the approvals", body: "Decide what waits for a human, what is blocked, and whether autonomy is ever allowed.", art: "orange", mock: <StepGuardrailsMock /> },
  { title: "Watch it run", body: "Follow every mission live, and step in when an approval is waiting.", art: "pink", mock: <StepLiveMock /> },
  { title: "Review every call", body: "Open a run to replay each step, each call and each approval.", art: "blue", mock: <StepReviewMock /> },
];

function StepCard({ s }: { s: (typeof STEPS)[number] }) {
  return (
    <div className="w-[82vw] max-w-[850px] shrink-0 snap-start sm:w-[70vw] lg:w-[850px]">
      <ArtPanel art={s.art} className="flex h-[320px] items-center justify-center rounded-[24px] p-6 sm:h-[460px] sm:p-10 lg:h-[min(548px,calc(100vh-380px))] lg:p-12">
        <div className="w-full max-w-[520px] lg:[zoom:1.25]">{s.mock}</div>
      </ArtPanel>
      <h3 className="mt-6 text-[20px] font-medium leading-[1.3] text-[#0f1728]">{s.title}</h3>
      <p className="mt-1 text-[18px] leading-[1.3] text-[#4b5567]">{s.body}</p>
    </div>
  );
}

export function HomeHowHn() {
  const runway = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px) and (prefers-reduced-motion: no-preference)");
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!wide) return;
    const onScroll = () => {
      const r = runway.current, t = track.current;
      if (!r || !t) return;
      const rect = r.getBoundingClientRect();
      const span = r.offsetHeight - window.innerHeight;
      const progress = Math.min(1, Math.max(0, -rect.top / Math.max(1, span)));
      const max = t.scrollWidth - window.innerWidth + 96;
      setX(-progress * Math.max(0, max));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [wide]);

  const head = (
    <Container narrow className="pt-20 lg:pt-24">
      <Head
        split
        eyebrow="How it works"
        title="From first agent to first result, no engineering required"
        lead="Pick a template, describe the job in plain language, connect your tools and set the approvals. Then watch your agent work, and review every step."
      />
    </Container>
  );

  if (!wide) {
    return (
      <section className="border-t border-[#e6e9ef] bg-white pb-20">
        {head}
        <div className="mt-12 flex snap-x snap-mandatory gap-6 overflow-x-auto px-5 pb-2 sm:px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {STEPS.map((s) => (
            <StepCard key={s.title} s={s} />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="border-t border-[#e6e9ef] bg-white">
      <div ref={runway} style={{ height: `${STEPS.length * 70}vh` }} className="relative">
        <div className="sticky top-[72px] flex h-[calc(100vh-72px)] flex-col overflow-hidden">
          {head}
          <div className="flex flex-1 items-center">
            <div
              ref={track}
              className="flex gap-12 pl-12 will-change-transform"
              style={{ transform: `translate3d(${x}px,0,0)` }}
            >
              {STEPS.map((s) => (
                <StepCard key={s.title} s={s} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
