import { CountUp, Display, Em, Reveal } from "./LandingKit";
import { ToneSection } from "./LandingTone";

/* The block that takes over from the hero: a partner strip on an endless loop,
   one claim, and four figures inside a single slab.

   The figures used to be four separate cards. One slab with hairlines between
   the columns reads as a single measurement of one thing, which is what they
   are; four cards read as four unrelated brags. */

/* Placeholder wordmarks — set in type, not imported as brand assets, so nothing
   here implies a logo we do not have the right to show. Swap for real SVGs. */
const LOGOS = [
  { name: "Frictionless", className: "text-[21px] font-semibold tracking-[-0.03em]" },
  { name: "TAN & CO", className: "text-[14px] font-medium uppercase tracking-[0.3em]" },
  { name: "Loom", className: "font-serif text-[23px] italic tracking-[-0.01em]" },
  { name: "northbound", className: "text-[20px] font-light lowercase tracking-[0.02em]" },
  { name: "VERRIER", className: "text-[16px] font-bold uppercase tracking-[0.14em]" },
  { name: "Halden Health", className: "text-[19px] font-medium tracking-[-0.01em]" },
  { name: "ATLAS", className: "text-[17px] font-semibold uppercase tracking-[0.2em]" },
  { name: "Cordier", className: "font-serif text-[21px] tracking-[0.01em]" },
  { name: "PALEBLUE", className: "text-[15px] font-semibold uppercase tracking-[0.24em]" },
];

const PROOF = [
  { prefix: "4–", to: 8, suffix: "", label: "Weeks to the first secured milestone" },
  { to: 98, suffix: "%", label: "Of write actions behind an approval gate" },
  { to: 57, suffix: "", label: "Systems connected, without a migration" },
  { to: 100, suffix: "%", label: "Of the resulting IP stays yours" },
];

/* Which edges each cell rules, per breakpoint. `divide-*` cannot express this:
   in a two-column grid it would draw a line between the two cells of the same
   row as well as between the rows. */
const CELL_RULES = [
  "",
  "border-t sm:border-l sm:border-t-0",
  "border-t lg:border-l lg:border-t-0",
  "border-t sm:border-l lg:border-t-0",
];

/* Edge fade so wordmarks dissolve instead of being chopped by the viewport. */
const STRIP_FADE = "linear-gradient(90deg, transparent, #000 9%, #000 91%, transparent)";

export function LandingProof() {
  // Duplicated once so the -50% translate loops seamlessly.
  const track = [...LOGOS, ...LOGOS];

  return (
    <ToneSection tone="slate">
      <div className="pb-24 pt-14 sm:pb-28">
        {/* Full-bleed, so the strip runs off both edges of the page. */}
        <div
          className="relative overflow-hidden"
          style={{ WebkitMaskImage: STRIP_FADE, maskImage: STRIP_FADE }}
        >
          <div className="mkt-marquee flex w-max items-center text-white/30 hover:[animation-play-state:paused]">
            {track.map((l, i) => (
              <span key={i} className={`shrink-0 whitespace-nowrap px-9 leading-none sm:px-12 ${l.className}`}>
                {l.name}
              </span>
            ))}
          </div>
        </div>

        <div className="mx-auto max-w-[1420px] px-5 sm:px-9">
          <Reveal>
            <Display className="mt-20 max-w-[20ch] sm:mt-24">
              Adoption you can measure, not a pilot you can <Em>demo</Em>
            </Display>
          </Reveal>

          {/* ── The slab ───────────────────────────────────────────────────
              A single panel with a warm wash bled in from the left, columns
              split by hairlines. On a narrow screen the hairlines flip from
              vertical to horizontal rather than the columns stacking with no
              separation at all. */}
          <Reveal delay={120}>
            <div className="mt-12 overflow-hidden rounded-[20px] border border-white/[0.09] bg-[#171717]/60">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
                {PROOF.map((p, i) => (
                  <div
                    key={p.label}
                    className={`border-white/[0.09] px-7 py-9 sm:px-8 sm:py-10 ${CELL_RULES[i]}`}
                  >
                    <CountUp
                      to={p.to}
                      prefix={p.prefix}
                      suffix={p.suffix}
                      className="block text-[38px] font-medium leading-none tracking-[-0.035em] text-white tabular-nums sm:text-[44px]"
                    />
                    <div className="mt-4 max-w-[22ch] text-[11px] font-medium uppercase leading-[1.5] tracking-[0.12em] text-white/40">
                      {p.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </ToneSection>
  );
}
