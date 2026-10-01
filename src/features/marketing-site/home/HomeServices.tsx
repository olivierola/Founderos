import {
  BuildingsIcon as Buildings,
  ChartLineUpIcon as ChartLineUp,
  HandshakeIcon as Handshake,
  LightningIcon as Lightning,
  PlugsConnectedIcon as Plugs,
  ReceiptIcon as Receipt,
  TruckIcon as Truck,
  UserFocusIcon as UserFocus,
  SquaresFourIcon as SquaresFour,
  PaletteIcon as Palette,
} from "@phosphor-icons/react";
import { Reveal } from "../LandingKit";
import { Container, IconDisc, IconOrb, Panel, SectionHead } from "../atlas/AtlasKit";

/* ══ The services ════════════════════════════════════════════════════════════
   The reference's industries row: five cards, a title and a line each, and a
   picture at the foot. Our agents live in the service dashboard they work for,
   so the five are services — every one of them a module the product ships.
   The pictures are drawn in the palette's pastels rather than stock photos. */

const SERVICES = [
  {
    icon: Receipt,
    title: "Finance",
    line: "Reconciliation, payables and receivables, month-end, reporting",
    tint: "#e5dbeb",
    sample: "Invoice 1042 matched to its PO",
  },
  {
    icon: Handshake,
    title: "Sales & CRM",
    line: "Pipeline hygiene, follow-ups, account research",
    tint: "#dce4ea",
    sample: "Follow-up drafted · waits for you",
  },
  {
    icon: UserFocus,
    title: "HR & Recruiting",
    line: "Candidate screening, onboarding, HR documents",
    tint: "#d2e8c8",
    sample: "Screening notes, criteria cited",
  },
  {
    icon: Truck,
    title: "Operations & Supply",
    line: "Inventory, suppliers, purchase orders, shipments",
    tint: "#f4f2ef",
    sample: "Reorder point reached — PO ready",
  },
  {
    icon: Palette,
    title: "Agencies & Partners",
    line: "White-label Anduran for your own clients",
    tint: "#f3dcfb",
    sample: "Your brand on every agent",
  },
];

const POINTS = [
  { icon: Plugs, title: "Built on your stack", body: "Connectors on the tools you already run. Nothing to migrate." },
  { icon: Lightning, title: "Fast to start", body: "The readiness scan takes two to three weeks, not a quarter." },
  { icon: ChartLineUp, title: "Measured on your runs", body: "Usage per team, from your own data — not a market average." },
];

export function HomeServices() {
  return (
    <section className="relative py-6">
      <Panel variant="soft">
        <Container className="pb-3 pt-14 sm:pt-20">
          <Reveal>
            <SectionHead
              icon={Buildings}
              accent="Services"
              lead="Built for every service."
              serif="Configured for yours."
              description="Each agent lives in the dashboard of the service it works for — with that service's knowledge, tools and approvals."
            />
          </Reveal>

          <div className="mt-14 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {SERVICES.map((s, i) => (
              <Reveal key={s.title} delay={i * 70} className="h-full">
                <div className="flex h-full flex-col rounded-[28px] bg-white p-2.5">
                  <div className="px-3 pb-8 pt-3">
                    <IconDisc icon={s.icon} size={34} />
                    <h3 className="mt-4 text-[17px] font-semibold tracking-[-0.03em] text-[#111011]">{s.title}</h3>
                    <p className="mt-2 text-[14px] leading-[1.45] text-[#666666]">{s.line}</p>
                  </div>
                  <div
                    className="relative mt-auto grid h-[190px] place-items-center overflow-hidden rounded-[22px]"
                    style={{ background: `radial-gradient(circle at 30% 20%, #ffffff 0%, ${s.tint} 65%)` }}
                  >
                    <SquaresFour aria-hidden className="absolute -right-6 -top-6 h-28 w-28 text-white/60" />
                    <div className="relative mx-4 rounded-[16px] bg-white p-3 shadow-[0_18px_36px_-20px_rgba(17,16,17,0.45)]">
                      <div className="flex items-center gap-2">
                        <span className="at-orb h-5 w-5 shrink-0 rounded-full" />
                        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[#969696]">
                          {s.title.split(" ")[0]} agent
                        </span>
                      </div>
                      <div className="mt-1.5 text-[12.5px] font-medium leading-snug text-[#111011]">{s.sample}</div>
                    </div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={120}>
            <div className="mt-2 grid gap-8 rounded-[28px] bg-white px-8 py-8 md:grid-cols-3">
              {POINTS.map((p) => (
                <div key={p.title} className="flex items-center gap-5">
                  <IconOrb icon={p.icon} size={50} />
                  <div>
                    <div className="text-[16px] font-semibold tracking-[-0.02em]">{p.title}</div>
                    <p className="mt-1 text-[14px] leading-[1.45] text-[#666666]">{p.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </Reveal>
        </Container>
      </Panel>
    </section>
  );
}
