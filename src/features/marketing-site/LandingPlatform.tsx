import { useState } from "react";
import { MinusIcon as Minus, PlusIcon as Plus } from "@phosphor-icons/react";
import { Display, Em, Reveal } from "./LandingKit";
import { ToneSection } from "./LandingTone";

/* What we do, as four claims a reader opens one at a time — and, beside them,
   the thing itself: the panel where a write action is bound to a policy. The
   accordion is the argument; the panel is the receipt. */

const CLAIMS = [
  {
    title: "Foundation before intelligence",
    body: "AI amplifies whatever is underneath it. We structure the work first — approvals that follow rules, documents in one place, data that means the same thing in every system — so an agent has something solid to stand on.",
  },
  {
    title: "Security designed in, not bolted on",
    body: "Credentials encrypted at rest and never returned to the browser, tenant-level isolation, scoped tool grants, and an approval gate on every write. The security review happens before the first agent, not after the first incident.",
  },
  {
    title: "Built on the stack you already run",
    body: "Fifty-seven integrations, no platform migration, no rip-and-replace. Agents sit on top of your systems and speak to them through the same permissions your people have.",
  },
  {
    title: "Governed at the scale you grow to",
    body: "Who can build an agent, what data it may touch, where it runs, and what it did last Tuesday. All four answerable from one registry, with an exportable trail behind every action.",
  },
];

/* The configuration panel. Light on a dark page on purpose: it is the product,
   and the product is where the reader's attention should land. */
function PolicyPanel() {
  const options = ["Check the data-residency policy", "Use the knowledge base", "Run the action", "Ask a human first"];
  const chosen = 3;

  return (
    <div className="w-full max-w-[370px] rounded-[16px] bg-[#faf9f7] p-5 text-[#101314] shadow-[0_40px_90px_-40px_rgba(0,0,0,0.9)]">
      <div className="text-[13.5px] text-black/55">When an agent wants to</div>
      <div className="mt-2 rounded-[10px] border border-black/[0.12] bg-white px-3.5 py-2.5 text-[14px]">
        Write to the finance ledger
      </div>

      <div className="mt-6 text-[13.5px] text-black/55">It must first:</div>
      <div className="mt-3 space-y-2.5">
        {options.map((o, i) => (
          <div key={o} className="flex items-center gap-2.5 text-[14px]">
            <span
              className={`grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full border-2 ${
                i === chosen ? "border-[#101314]" : "border-black/20"
              }`}
            >
              {i === chosen && <span className="h-[7px] w-[7px] rounded-full bg-[#101314]" />}
            </span>
            <span className={i === chosen ? "text-[#101314]" : "text-black/45"}>{o}</span>
          </div>
        ))}
      </div>

      <div className="mt-6 text-[13.5px] text-black/55">Tell the agent how to judge it</div>
      <div className="mt-3 rounded-[10px] border border-black/[0.12] bg-white px-3.5 py-2.5 text-[14px] leading-[1.45]">
        Only when the invoice matches the purchase order within €50.
      </div>

      <div className="mt-5 flex items-start gap-2.5">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#101314] text-[11px] font-medium text-white">
          A
        </span>
        <p className="rounded-[10px] bg-[#ffe9a8] px-3.5 py-2.5 text-[13.5px] leading-[1.45]">
          Understood. Anything above €50 stops and waits for you, and I will say which line broke the match.
        </p>
      </div>
    </div>
  );
}

export function LandingPlatform() {
  const [open, setOpen] = useState(0);

  return (
    <ToneSection tone="raised">
      <div className="mx-auto max-w-[1420px] px-5 pb-24 sm:px-9 sm:pb-28">
        <Reveal>
          <Display className="max-w-[19ch]">
            The work that makes an agent <Em>safe</Em> to switch on
          </Display>
        </Reveal>

        <div className="mt-12 grid items-start gap-10 lg:grid-cols-2 lg:gap-14">
          {/* ── The claims ────────────────────────────────────────────────── */}
          <Reveal className="border-t border-white/[0.10]">
            {CLAIMS.map((c, i) => {
              const on = i === open;
              return (
                <div key={c.title} className="border-b border-white/[0.10]">
                  <button
                    type="button"
                    aria-expanded={on}
                    // Clicking the open row leaves it open: this is a reveal,
                    // not a toggle, and a column that can be entirely closed
                    // leaves the panel beside it stranded.
                    onClick={() => setOpen(i)}
                    className="flex w-full items-center justify-between gap-6 py-6 text-left"
                  >
                    <span
                      className={`text-[17px] leading-snug tracking-[-0.015em] transition-colors duration-300 sm:text-[18.5px] ${
                        on ? "text-white" : "text-white/55 hover:text-white/80"
                      }`}
                    >
                      {c.title}
                    </span>
                    {on ? (
                      <Minus className="h-5 w-5 shrink-0 text-white/50" />
                    ) : (
                      <Plus className="h-5 w-5 shrink-0 text-white/35" />
                    )}
                  </button>

                  {/* Height animates through grid-template-rows so the body
                      stays in the document and the row eases rather than
                      snapping open. */}
                  <div
                    className={`grid transition-[grid-template-rows,opacity] duration-500 ease-[cubic-bezier(0.33,1,0.68,1)] ${
                      on ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                    }`}
                  >
                    <div className="overflow-hidden">
                      <p className="max-w-[52ch] pb-7 pr-10 text-[14.5px] leading-[1.6] text-white/55">
                        {c.body}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </Reveal>

          {/* ── The receipt ───────────────────────────────────────────────── */}
          <Reveal delay={120}>
            <div className="relative overflow-hidden rounded-[18px] bg-black/50">
              <img
                src="/landing/scale.jpg"
                alt=""
                aria-hidden
                className="absolute inset-0 h-full w-full object-cover opacity-70"
                style={{ objectPosition: "60% 45%" }}
              />
              <div
                aria-hidden
                className="absolute inset-0"
                style={{ background: "linear-gradient(140deg, rgba(8,8,8,0.45), rgba(8,8,8,0.78))" }}
              />
              <div className="relative flex justify-center px-5 py-10 sm:px-9 sm:py-14">
                <PolicyPanel />
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </ToneSection>
  );
}
