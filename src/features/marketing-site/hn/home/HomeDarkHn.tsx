import { useRef, type ReactNode } from "react";
import { AgentBadge } from "../AgentBadge";
import { ArtPanel, Btn, CarouselButtons, Head, type Art } from "../HnKit";
import { AuditMock, CheckPipelineMock, KeysMock, RunMock, TaskCard } from "../Mocks";

/* ══ Meet the agents ═════════════════════════════════════════════════════════
   The reference's dark "Test AI HRs" band: one card per agent, the team in the
   corner, a figure on colour, the agent's name. Our figure is the agent's WORK
   — a task card on artwork — because that is what a buyer is evaluating. The
   steps are samples. The first cut had a "Hear a sample" pill that played no
   audio; it is gone. */

const AGENTS: { team: string; name: string; art: Art; title: string; steps: string[]; waiting: string; line: string }[] = [
  {
    team: "Finance",
    name: "Finance collaborator",
    art: "blue",
    title: "Reconcile March invoices",
    steps: ["Read invoices from the ledger", "Matched lines to purchase orders"],
    waiting: "Credit note waiting for approval",
    line: "Reconciliations, payables follow-up, month-end checks.",
  },
  {
    team: "HR & Recruiting",
    name: "Recruiting collaborator",
    art: "violet",
    title: "Screen applicants, Ops lead",
    steps: ["Read applications against criteria", "Wrote a note per candidate"],
    waiting: "Shortlist ready for your decision",
    line: "Screening notes, interview scheduling, onboarding packs.",
  },
  {
    team: "Customer support",
    name: "Support collaborator",
    art: "olive",
    title: "Resolve refund request #4821",
    steps: ["Found the order and its history", "Checked it against the refund policy"],
    waiting: "Refund above limit, needs you",
    line: "Ticket triage, answers from your knowledge base, refunds.",
  },
  {
    team: "Reporting",
    name: "Report writer",
    art: "gold",
    title: "Draft the Q3 board report",
    steps: ["Pulled the quarter's figures", "Wrote the narrative, sources cited"],
    waiting: "Draft ready for review",
    line: "Board packs, monthly reviews, client deliverables as PDF.",
  },
  {
    team: "Sales",
    name: "Sales collaborator",
    art: "orange",
    title: "Weekly pipeline hygiene",
    steps: ["Found 12 deals with no next step", "Drafted a follow-up for each"],
    waiting: "Emails waiting for your review",
    line: "Pipeline hygiene, account research, follow-up drafts.",
  },
];

export function HomeAgentsHn() {
  const track = useRef<HTMLDivElement>(null);
  const scroll = (d: 1 | -1) => track.current?.scrollBy({ left: d * 384, behavior: "smooth" });

  return (
    <section className="hn-dark text-white">
      <div className="hn-rails mx-auto max-w-[1200px] px-6 py-20 sm:px-12 lg:py-28">
        <Head
          split
          tone="dark"
          eyebrow="Meet your Cloud collaborators"
          title="Specialised Cloud collaborators for every team."
          lead="Each Cloud collaborator works inside your systems, follows the rules you set, and hands back finished work, ready for your approval."
        >
          <Btn to="/contact" variant="white">Book a live demo</Btn>
        </Head>

        <div ref={track} className="mt-14 flex snap-x gap-6 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {AGENTS.map((a) => (
            <article key={a.name} className="w-[340px] shrink-0 snap-start rounded-[18px] border border-white/10 bg-white/[0.04] p-2">
              <ArtPanel art={a.art} className="relative flex h-[300px] items-end justify-center rounded-[12px] p-4 pt-14">
                <span className="absolute left-4 top-4 rounded-[14px] bg-white/15 px-2.5 py-1.5 text-[13px] font-medium text-white backdrop-blur-md">
                  {a.team}
                </span>
                <TaskCard agent={a.name} title={a.title} steps={a.steps} waiting={a.waiting} />
              </ArtPanel>
              <div className="flex items-start gap-3 px-3 pb-4 pt-5">
                <AgentBadge name={a.name} size={36} />
                <div>
                  <div className="text-[18px] font-medium leading-[1.3]">{a.name}</div>
                  <p className="mt-1 text-[15px] leading-[1.4] text-white/65">{a.line}</p>
                </div>
              </div>
            </article>
          ))}
        </div>
        <CarouselButtons className="mt-10" onPrev={() => scroll(-1)} onNext={() => scroll(1)} />
      </div>
    </section>
  );
}

/* ══ What makes Anduran different ════════════════════════════════════════════
   The reference's numbered rows on the dark band: a number, a title, two
   paragraphs, and a picture on the right. Each picture is now the mechanism
   itself, drawn as the product shows it. */

const ROWS: { title: string; body: [string, string]; art: Art; visual: ReactNode }[] = [
  {
    title: "An approval gate on every write",
    body: [
      "Reading never interrupts you: searching, listing and looking something up run directly. Anything that writes, sends, deletes or pays stops in the conversation and waits.",
      "The run stays alive while it waits, so approving picks the work up exactly where it paused. Repeats of the same action can be allowed once, up front.",
    ],
    art: "blue",
    visual: <RunMock className="w-full max-w-[400px]" />,
  },
  {
    title: "A second check that only adds caution",
    body: [
      "Two checks decide whether an action needs you: a list of write verbs, then a judgement on what the list let through.",
      "The second check can add an approval, never remove one. A model that misreads an action can only make the Cloud collaborator more careful, not less.",
    ],
    art: "violet",
    visual: <CheckPipelineMock />,
  },
  {
    title: "Traceability, not just a log",
    body: [
      "“The Cloud collaborator called read_url” does not answer an auditor. Every call records the arguments passed, the start of what came back, whether it succeeded and how long it took.",
      "Each call belongs to a run you can open and replay end to end. The log exports.",
    ],
    art: "olive",
    visual: <AuditMock className="w-full max-w-[400px]" />,
  },
  {
    title: "Your keys, and your model, if you want it",
    body: [
      "Connector credentials are encrypted at rest with AES-256-GCM and decrypted only server-side, at call time. The browser never sees them in clear.",
      "Inference can leave our infrastructure too: point a Cloud collaborator at an OpenAI-compatible endpoint you host, and your prompts stay on your network.",
    ],
    art: "gold",
    visual: <KeysMock />,
  },
];

export function HomeDifferentHn() {
  return (
    <section className="hn-dark text-white">
      <div className="hn-rails mx-auto max-w-[1200px]">
        <div className="border-t border-white/10 px-6 py-20 sm:px-12">
          <Head
            split
            tone="dark"
            eyebrow="Solid foundation"
            title={
              <>
                Why teams trust
                <br />
                Anduran with real work
              </>
            }
            lead="Putting a Cloud collaborator on real systems is risky at four precise moments: the write, the audit, the key and the model. Anduran is built around each of them."
          />
        </div>
        {ROWS.map((r, i) => (
          <div key={r.title} className="grid gap-10 border-t border-white/10 px-6 py-12 sm:px-12 lg:grid-cols-2">
            <div>
              <div className="text-[16px] text-white/50">{String(i + 1).padStart(2, "0")}</div>
              <h3 className="mt-4 text-[24px] font-medium leading-[1.2] tracking-[-0.04em]">{r.title}</h3>
              {r.body.map((p) => (
                <p key={p} className="mt-5 max-w-[400px] text-[18px] leading-[1.35] text-white/70">
                  {p}
                </p>
              ))}
            </div>
            <div className="rounded-[18px] border border-white/10 bg-white/[0.04] p-4">
              <ArtPanel art={r.art} className="grid h-[320px] place-items-center rounded-[12px] p-6 sm:h-[380px]">
                {r.visual}
              </ArtPanel>
            </div>
          </div>
        ))}
        <div className="h-12 border-t border-white/10" />
      </div>
    </section>
  );
}
