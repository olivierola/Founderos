import { Link } from "react-router-dom";
import { ArrowRightIcon as ArrowRight, CheckIcon as Check } from "@phosphor-icons/react";
import { Display, Em, Pill, Reveal } from "./LandingKit";
import { ToneSection } from "./LandingTone";

/* ── The light interlude, part one ──────────────────────────────────────────
   Everything above this point argues that the work holds up. This is the first
   block that says how it actually runs, and it is set on paper rather than on
   the dark canvas for exactly that reason: a process is a document, and the
   change of ground is what tells a reader they have moved from the pitch to
   the plan.

   ── Why it is not four columns ──────────────────────────────────────────────
   It was, and it read as a wall: four equal blocks, same width, same weight,
   same ~40 words each, nothing telling you where to start or that the four are
   in an order at all. Four things laid out identically are a list; these are a
   sequence, and the layout was contradicting the copy.

   So the sequence is drawn. One timeline down the left, the phases as rows
   rather than columns, and three things vary down the page:

   · the rule fills in. Each row's rail is a segment of one continuous line, so
     the eye reads it as travel rather than as four separate cards;
   · the weight drops. Phase 01 is the one you actually buy, so it carries the
     largest type and the accent; by 04 the row is quiet;
   · the outcome gets its own column, as a panel rather than a footnote buried
     in the paragraph — it is the reason the phase exists, and it is what a
     reader is actually shopping for.

   The ground is white. It was the "bone" tone, one step down from paper so two
   light bands would not merge — but the phase panels are light plates, and a
   light plate on a light-grey ground has nothing to sit on. On white the
   hairline does the separating.

   The canvas only paints the ground (see LandingTone), so every ink in here is
   written out. Nothing in this section may rely on the page's white default.  */

const INK = "#111111";
const GREY = "#777777";
/* The one colour in the palette, deepened for type on paper (6.0:1). */
const ACCENT = "#176995";
const RULE = "rgba(17,17,17,0.12)";

/* `artifacts` is what filled the hole on the right. The row used to end in a
   single chip with 300px of white beside it, which is the emptiness you feel
   before you can name it: a column that exists but says almost nothing. These
   are the actual things that land at the end of a phase — nameable, checkable,
   and the answer to the only question a reader has here, which is "and then
   what do I have". */
const STEPS = [
  {
    num: "01",
    when: "Weeks 1–3",
    title: "We score the ground",
    body: "Interviews with the people doing the work, a read of the systems they actually touch, and every process rated L1 to L5. You end up with a prioritised roadmap instead of a wish list.",
    gives: "A scored roadmap",
    artifacts: ["Process inventory, L1–L5", "System & data map", "Ranked shortlist with effort"],
    who: "2 consultants · your process owners",
  },
  {
    num: "02",
    when: "Weeks 3–8",
    title: "We build the foundation",
    body: "Approvals that follow rules, documents in one place, one definition per business term. The unglamorous half, and the half that decides whether anything built on top of it survives.",
    gives: "A first secured milestone",
    artifacts: ["Approval rules, in production", "One document store", "A business glossary"],
    who: "Architect · developer · your IT",
  },
  {
    num: "03",
    when: "Weeks 6–12",
    title: "We put agents to work",
    body: "Agents inside your tenant, behind your identity controls, with scoped grants and an approval gate on every write. Shipped one workflow at a time, each with a measure attached.",
    gives: "Agents in production",
    artifacts: ["One agent per workflow", "Scoped grants + audit log", "A measure on each one"],
    who: "Developer · functional consultant",
  },
  {
    num: "04",
    when: "Ongoing",
    title: "We keep it standing",
    body: "Models change, regulations tighten, agents drift. An architect, a functional consultant and a developer who already know your environment keep the platform current.",
    gives: "A quarterly roadmap review",
    artifacts: ["Drift & cost monitoring", "Model and policy updates", "Quarterly roadmap review"],
    who: "The same three people",
  },
];

/* The type steps down across the four rows. Written out per row rather than
   computed, because the drop is not linear — 01 is the sales conversation and
   has to be visibly the loudest, 02 and 03 are the work, 04 is the footnote. */
const TITLE_SIZE = [
  "text-[26px] sm:text-[34px]",
  "text-[24px] sm:text-[29px]",
  "text-[24px] sm:text-[29px]",
  "text-[22px] sm:text-[26px]",
];

export function LandingMethod() {
  return (
    <ToneSection tone="paper">
      <div className="mx-auto max-w-[1420px] px-5 py-24 sm:px-9 sm:py-28" style={{ color: INK }}>
        <Reveal>
          <div className="flex flex-col justify-between gap-8 lg:flex-row lg:items-end">
            <div>
              <span
                className="inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em]"
                style={{ color: ACCENT }}
              >
                <span aria-hidden className="h-[6px] w-[6px] rounded-full" style={{ background: ACCENT }} />
                How an engagement runs
              </span>
              <Display className="mt-6 max-w-[17ch] text-[#111111]">
                Four phases, and you can stop after <Em>any</Em> of them
              </Display>
            </div>
            <p className="max-w-sm text-[15.5px] leading-[1.65]" style={{ color: GREY }}>
              No twelve-month programme signed on day one. Each phase ends with something you own and a
              decision you are free to make either way.
            </p>
          </div>
        </Reveal>

        <div className="mt-16">
          {STEPS.map((s, i) => {
            const first = i === 0;
            const last = i === STEPS.length - 1;
            return (
              <Reveal key={s.num} delay={i * 90}>
                <div className="group grid gap-y-5 sm:grid-cols-[auto_1fr] sm:gap-x-8 lg:grid-cols-[auto_minmax(0,1fr)_320px] lg:gap-x-14">
                  {/* ── The rail ──────────────────────────────────────────
                      The number sits ON the line, and the line continues below
                      it. That is what makes four rows read as one journey: the
                      segment leaving a row is the segment entering the next. */}
                  <div className="relative flex gap-6 sm:block">
                    <div className="relative flex w-[44px] flex-col items-center">
                      <span
                        className="relative z-10 flex h-[44px] w-[44px] items-center justify-center rounded-full text-[13px] font-medium tabular-nums transition-colors duration-300"
                        style={
                          first
                            ? { background: ACCENT, color: "#FFFFFF" }
                            : { background: "#FFFFFF", color: GREY, boxShadow: `inset 0 0 0 1px ${RULE}` }
                        }
                      >
                        {s.num}
                      </span>
                      {/* Absolute, so the segment spans the whole row's height
                          whatever the copy does — a flex-1 line would only reach
                          as far as the shortest column. */}
                      {!last && (
                        <span
                          aria-hidden
                          className="absolute left-1/2 top-[44px] w-px -translate-x-1/2"
                          style={{ bottom: "-2.5rem", background: RULE }}
                        />
                      )}
                    </div>
                  </div>

                  {/* ── The phase ─────────────────────────────────────────── */}
                  <div className={last ? "pb-2" : "pb-10"}>
                    <div
                      className="font-mono text-[11px] uppercase tracking-[0.11em]"
                      style={{ color: first ? ACCENT : GREY }}
                    >
                      {s.when}
                    </div>
                    <h3
                      className={`mt-3 font-normal leading-[1.12] tracking-[-0.03em] ${TITLE_SIZE[i]}`}
                      style={{ color: INK }}
                    >
                      {s.title}
                    </h3>
                    <p className="mt-4 max-w-[58ch] text-[15px] leading-[1.65]" style={{ color: GREY }}>
                      {s.body}
                    </p>
                  </div>

                  {/* ── What you walk away with ───────────────────────────
                      A panel, not a chip. The deliverable heads it, the things
                      that actually land are listed under it, and the people in
                      the room close it — enough to hold the column on its own
                      instead of leaving a strip of white beside every phase. */}
                  <div className={last ? "pb-2" : "pb-10"}>
                    <div
                      className="border p-5"
                      style={{
                        borderColor: first ? `${ACCENT}40` : RULE,
                        background: first ? `${ACCENT}0A` : "#FAFAFA",
                      }}
                    >
                      <div
                        className="flex items-center gap-2.5 text-[13.5px] font-medium"
                        style={{ color: first ? ACCENT : INK }}
                      >
                        <Check className="h-3.5 w-3.5 shrink-0" weight="bold" />
                        {s.gives}
                      </div>

                      <ul
                        className="mt-4 space-y-2 border-t pt-4"
                        style={{ borderColor: first ? `${ACCENT}26` : RULE }}
                      >
                        {s.artifacts.map((a) => (
                          <li key={a} className="flex gap-2.5 text-[13.5px] leading-[1.45]">
                            <span
                              aria-hidden
                              className="mt-[7px] h-[4px] w-[4px] shrink-0"
                              style={{ background: first ? ACCENT : "#B4B4B4" }}
                            />
                            <span style={{ color: INK }}>{a}</span>
                          </li>
                        ))}
                      </ul>

                      <div
                        className="mt-4 border-t pt-3 font-mono text-[10.5px] uppercase tracking-[0.1em]"
                        style={{ borderColor: first ? `${ACCENT}26` : RULE, color: GREY }}
                      >
                        {s.who}
                      </div>
                    </div>
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>

        <Reveal delay={120}>
          <div
            className="mt-6 flex flex-wrap items-center gap-4 border-t pt-10"
            style={{ borderColor: RULE }}
          >
            <Link to="/contact">
              <Pill className="gap-2.5 px-6 py-3">
                Start with the assessment
                <ArrowRight className="h-4 w-4" />
              </Pill>
            </Link>
            <span className="text-[14px]" style={{ color: GREY }}>
              Two to three weeks. No commitment after it.
            </span>
          </div>
        </Reveal>
      </div>
    </ToneSection>
  );
}
