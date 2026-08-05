import { CountUp, Reveal } from "./LandingKit";
import { HERO_BG } from "./LandingHero";

/* The block that takes over from the hero: a partner strip on an endless loop,
   one claim, and four figures on white cards keyed by a colour rail. */

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

/* Four rails, four hues — the reference reads as four separate figures because
   no two share a colour. Brand orange leads; the others are deepened enough to
   hold their own next to it rather than compete with it. */
const PROOF = [
  {
    rail: "#ff4d00",
    prefix: "4–",
    to: 8,
    suffix: "",
    label: ["weeks to the first", "secured milestone"],
  },
  {
    rail: "#12574a",
    to: 98,
    suffix: "%",
    label: ["of write actions behind", "an approval gate"],
  },
  {
    rail: "#7c83d8",
    to: 57,
    suffix: "",
    label: ["systems connected,", "no migration"],
  },
  {
    rail: "#e8b423",
    to: 100,
    suffix: "%",
    label: ["of the resulting IP", "stays yours"],
  },
];

/* Edge fade so wordmarks dissolve instead of being chopped by the viewport. */
const STRIP_FADE = "linear-gradient(90deg, transparent, #000 9%, #000 91%, transparent)";

export function LandingProof() {
  // Duplicated once so the -50% translate loops seamlessly.
  const track = [...LOGOS, ...LOGOS];

  return (
    <section className="amp-light relative" style={{ background: HERO_BG }}>
      <div className="py-24 sm:py-32">
        {/* Full-bleed, so the strip runs off both edges of the page. */}
        <div
          className="relative overflow-hidden"
          style={{ WebkitMaskImage: STRIP_FADE, maskImage: STRIP_FADE }}
        >
          <div className="mkt-marquee flex w-max items-center text-black/30 hover:[animation-play-state:paused]">
            {track.map((l, i) => (
              <span key={i} className={`shrink-0 whitespace-nowrap px-10 leading-none sm:px-14 ${l.className}`}>
                {l.name}
              </span>
            ))}
          </div>
        </div>

        <div className="mx-auto max-w-[1280px] px-4 sm:px-8">
          <Reveal delay={90}>
            <h2 className="mx-auto mt-24 max-w-3xl text-balance text-center text-[32px] font-semibold leading-[1.1] tracking-[-0.03em] text-[#0d0d0d] sm:mt-32 sm:text-[50px]">
              Agents that hold up in production, not just in a pilot
            </h2>
          </Reveal>

          <div className="mt-16 grid gap-4 sm:mt-20 sm:grid-cols-2 lg:grid-cols-4">
            {PROOF.map((p, i) => (
              <Reveal key={p.label.join(" ")} delay={i * 90}>
                {/* The rail is a child rather than a border so the card's rounded
                    left corners cut it, exactly as on the reference. */}
                <div className="group relative flex h-full min-h-[330px] flex-col justify-between overflow-hidden rounded-[16px] bg-white pb-9 pl-10 pr-7 pt-9 shadow-[0_1px_2px_rgba(0,0,7,0.05)] transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-1.5 hover:shadow-[0_26px_50px_-24px_rgba(0,0,7,0.35)] motion-reduce:transition-none motion-reduce:hover:translate-y-0">
                  {/* On hover the rail thickens and its colour bleeds into the
                      card — the figure picks up its own key instead of the card
                      just moving. */}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                    style={{ background: `linear-gradient(100deg, ${p.rail}1f, transparent 62%)` }}
                  />
                  <span
                    aria-hidden
                    className="amp-grain amp-grain-strong absolute inset-y-0 left-0 w-[13px] transition-[width] duration-[450ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:w-[19px]"
                    style={{ background: p.rail }}
                  />
                  <CountUp
                    to={p.to}
                    prefix={p.prefix}
                    suffix={p.suffix}
                    className="block text-[48px] leading-none tracking-[-0.03em] text-[#0d0d0d] tabular-nums sm:text-[58px]"
                  />
                  <div className="mt-12 text-[15.5px] leading-[1.45] text-black/55">
                    {p.label.map((line) => (
                      <div key={line}>{line}</div>
                    ))}
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
