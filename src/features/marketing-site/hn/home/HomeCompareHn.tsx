import { CheckIcon as Check } from "@phosphor-icons/react";
import { Brand, Eyebrow, H, P } from "../HnKit";

/* ══ Why it holds up ═════════════════════════════════════════════════════════
   The reference's comparison card on the sky band: text on the left, three
   bars on the right. Its bars are measured multipliers; ours compare what each
   setup GUARANTEES — a count of capabilities, not a performance figure. */

const ROWS = [
  { label: <>A chatbot</>, guarantees: ["Answers questions"], width: "33%", tone: "bg-[#cfd5df]" },
  { label: <>An agent with tool access</>, guarantees: ["Answers", "Acts on your systems"], width: "66%", tone: "bg-[#84b6f4]" },
  {
    label: (
      <span className="flex items-center gap-2">
        An agent on <Brand />
      </span>
    ),
    guarantees: ["Answers", "Acts", "Every write approved & logged"],
    width: "100%",
    tone: "bg-[#006edd]",
  },
];

export function HomeCompareHn() {
  return (
    <section className="hn-sky overflow-hidden px-5 py-16 sm:py-24">
      <div className="mx-auto grid max-w-[950px] gap-12 rounded-[24px] bg-white p-8 hn-shadow-lg sm:p-12 md:grid-cols-[1fr_1fr]">
        <div>
          <Eyebrow>Built to be trusted</Eyebrow>
          <H size="sub" className="mt-3">More than an agent with access</H>
          <P className="mt-3">
            Any agent can demo well. What makes one safe to run on your real systems is everything around it.
          </P>
          <div className="mt-8 border-t border-[#e5e5e5] pt-6 text-[16px] leading-[1.4] text-[#4b5567]">
            <span className="font-medium text-[#006edd]">3 of 3</span> guarantees on every Anduran agent: it reads,
            it acts, and nothing it writes leaves without you.
          </div>
        </div>
        <div className="flex flex-col justify-center gap-8">
          {ROWS.map((r, i) => (
            <div key={i}>
              <div className="text-[15px] font-medium text-[#0f1728]">{r.label}</div>
              <div className="mt-2 h-2 w-full rounded-full bg-[#ececec]">
                <div className={`h-2 rounded-full ${r.tone}`} style={{ width: r.width }} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {r.guarantees.map((g) => (
                  <span key={g} className="flex items-center gap-1 text-[13px] text-[#4b5567]">
                    <Check weight="bold" className="h-3 w-3 text-[#006edd]" /> {g}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
