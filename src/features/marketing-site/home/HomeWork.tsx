import {
  ArrowsLeftRightIcon as ArrowsLeftRight,
  CheckSquareIcon as CheckSquare,
  FileTextIcon as FileText,
  FilePdfIcon as FilePdf,
  HandPalmIcon as HandPalm,
  ListMagnifyingGlassIcon as ListMagnifyingGlass,
  PencilLineIcon as PencilLine,
  QuotesIcon as Quotes,
  ReceiptIcon as Receipt,
  RowsIcon as Rows,
  TextColumnsIcon as TextColumns,
  LightningIcon as Lightning,
  ChartBarIcon as ChartBar,
} from "@phosphor-icons/react";
import { Reveal } from "../LandingKit";
import { CheckChip, Container, IconDisc, Panel, SectionHead } from "../atlas/AtlasKit";

/* ══ The work ════════════════════════════════════════════════════════════════
   Where the reference shows three customer results, we show three units of
   work an agent actually takes on — named in the terms of the job, with no
   client and no percentage. When there are measured results from customers
   who agree to be named, they take exactly these cards.                     */

const CARDS = [
  {
    category: "Finance",
    icon: Receipt,
    img: "/landing/foundation.jpg",
    pos: "50% 40%",
    title: "The reconciliation, line by line",
    lines: [
      { icon: ArrowsLeftRight, text: "Two sources, one comparison." },
      { icon: ListMagnifyingGlass, text: "Every gap listed, with the reason for each." },
      { icon: HandPalm, text: "Corrections wait for your approval before anything is written." },
    ],
  },
  {
    category: "Reporting",
    icon: ChartBar,
    img: "/landing/adopt.jpg",
    pos: "45% 40%",
    title: "The report, written — not assembled",
    lines: [
      { icon: PencilLine, text: "One dedicated agent writes every deliverable." },
      { icon: Quotes, text: "Figures pulled from your data, each one citing its source." },
      { icon: FilePdf, text: "Exported to PDF, ready to send." },
    ],
  },
  {
    category: "Documents",
    icon: FileText,
    img: "/landing/secure.jpg",
    pos: "55% 45%",
    title: "The document, read and structured",
    lines: [
      { icon: Rows, text: "Contracts, invoices, CVs." },
      { icon: CheckSquare, text: "Extracted into the fields you define." },
      { icon: TextColumns, text: "The original passage shown alongside every value." },
    ],
  },
];

export function HomeWork() {
  return (
    <section className="relative py-6">
      <Panel variant="accent" lit={[[4, 0], [5, 0], [4, 1], [3, 1], [2, 2], [3, 2], [0, 3], [1, 3], [5, 1]]}>
        <Container className="pb-10 pt-12 sm:pt-16">
          <Reveal>
            <SectionHead
              tone="white"
              icon={Lightning}
              eyebrow="Real work."
              accent="Not demos."
              lead="One agent per workflow."
              serif="Here's what it takes on."
            />
          </Reveal>

          <div className="mt-14 grid gap-3 lg:grid-cols-3">
            {CARDS.map((c, i) => (
              <Reveal key={c.title} delay={i * 90} className="h-full">
                <div className="h-full rounded-[34px] bg-white p-1 shadow-[0_40px_80px_-50px_rgba(60,0,90,0.8)]">
                  <div className="relative h-[240px] overflow-hidden rounded-[30px]">
                    <img
                      src={c.img}
                      alt=""
                      aria-hidden
                      className="absolute inset-0 h-full w-full object-cover"
                      style={{ objectPosition: c.pos }}
                    />
                    <div
                      aria-hidden
                      className="absolute inset-0"
                      style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.25), rgba(0,0,0,0) 35%, rgba(20,6,26,0.35))" }}
                    />
                    <div className="absolute left-4 top-4 flex items-center gap-2.5 text-[15px] font-semibold text-white">
                      <span className="grid h-10 w-10 place-items-center rounded-full bg-white text-[#111011]">
                        <c.icon className="h-5 w-5" />
                      </span>
                      {c.category}
                    </div>
                    <div className="absolute inset-x-1 bottom-1 rounded-[26px] bg-[#1b1320]/55 px-5 py-4 text-center text-[16.5px] font-semibold tracking-[-0.02em] text-white backdrop-blur-xl">
                      {c.title}
                    </div>
                  </div>
                  <ul className="space-y-4 px-4 pb-6 pt-6">
                    {c.lines.map((l) => (
                      <li key={l.text} className="flex items-center gap-3.5">
                        <IconDisc icon={l.icon} size={36} />
                        <span className="text-[14.5px] leading-[1.4] text-[#3d3c3d]">{l.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Reveal>
            ))}
          </div>

          <div className="mt-3 grid gap-2.5 md:grid-cols-3">
            <CheckChip className="bg-white/80 backdrop-blur">One unit of work per agent</CheckChip>
            <CheckChip className="bg-white/80 backdrop-blur">Every call logged with its result</CheckChip>
            <CheckChip className="bg-white/80 backdrop-blur">Your data stays where it is</CheckChip>
          </div>
        </Container>
      </Panel>
    </section>
  );
}
