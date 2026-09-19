import { useEffect, useState } from "react";
import {
  CaretLeftIcon as ChevronLeft,
  CaretRightIcon as ChevronRight,
} from "@phosphor-icons/react";
import { CountUp, Reveal } from "./LandingKit";

/* Two cards on a grey band, sitting over an oversized "Testimonials" set in the
   page colour and faded out from the bottom: the counters live in a dark plate
   on the left, the quotes run as a photo slider on the right. */

const STATS = [
  { to: 26, suffix: "+", label: "Agents in production" },
  { to: 98, suffix: "%", label: "Approval-gated write actions" },
  { to: 57, suffix: "", label: "Integrations connected" },
];

const QUOTES = [
  {
    quote: "The readiness scan told us to fix the data before touching AI. Three months later the weekly report writes itself.",
    author: "Léa Vermont",
    role: "COO, Frictionless Studio",
    img: "/landing/foundation.jpg",
    position: "55% 45%",
  },
  {
    quote: "Agents running inside our own tenant, behind our identity controls, every write approval-gated. That is what unblocked a year of stalled pilots.",
    author: "Marcus Tan",
    role: "CTO, Tan & Co",
    img: "/landing/scale.jpg",
    position: "65% 45%",
  },
  {
    quote: "Eight percent weekly use on the old licence, seventy-plus on ours. The rollout was a journey, not a training session.",
    author: "Aïcha Diallo",
    role: "Head of Engineering, Loom Agency",
    img: "/landing/adopt.jpg",
    position: "45% 35%",
  },
];

const BAND_BG = "#e0e0e0";
const AUTOPLAY_MS = 8000;

export function LandingTestimonials() {
  const [idx, setIdx] = useState(0);
  const go = (step: number) => setIdx((i) => (i + step + QUOTES.length) % QUOTES.length);

  // Depending on idx restarts the clock after a manual move, so a click never
  // leaves you a second away from an automatic one.
  useEffect(() => {
    const t = setTimeout(() => setIdx((i) => (i + 1) % QUOTES.length), AUTOPLAY_MS);
    return () => clearTimeout(t);
  }, [idx]);

  const active = QUOTES[idx];

  return (
    <section className="relative overflow-hidden" style={{ background: BAND_BG }}>
      <div className="mx-auto max-w-[1400px] px-4 py-24 sm:px-8 sm:py-28">
        <div className="text-center text-[15px] text-black/45">(Why teams stay)</div>

        {/* The word is set in ink at low alpha and masked to nothing before it
            reaches the cards, so it dissolves into the band rather than being
            cropped by them. */}
        <h2
          aria-hidden
          // The cards clip roughly the bottom third of the word — enough for it
          // to read as set behind them, not enough to swallow the letterforms.
          className="pointer-events-none -mb-[3.6vw] mt-6 select-none text-center text-[clamp(58px,14.5vw,215px)] font-semibold leading-[0.82] tracking-[-0.045em] text-black/[0.13] sm:-mb-[3vw]"
          style={{
            WebkitMaskImage: "linear-gradient(#000 45%, rgba(0,0,0,0.5) 78%, transparent 99%)",
            maskImage: "linear-gradient(#000 45%, rgba(0,0,0,0.5) 78%, transparent 99%)",
          }}
        >
          Testimonials
        </h2>
        <span className="sr-only">Testimonials</span>

        <Reveal className="relative grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.92fr)]">
          {/* ── Counters plate ─────────────────────────────────────────────── */}
          <div className="relative flex min-h-[420px] flex-col justify-between overflow-hidden rounded-[22px] bg-[#0c0c10] p-8 sm:p-10 lg:min-h-[600px]">
            <img
              src="/landing/secure.jpg"
              alt=""
              aria-hidden
              className="absolute inset-0 h-full w-full object-cover opacity-30 grayscale"
            />
            <div
              aria-hidden
              className="absolute inset-0"
              style={{ background: "linear-gradient(150deg, rgba(0,0,7,0.30), rgba(0,0,7,0.88) 65%, #000007)" }}
            />
            <div className="relative flex flex-1 flex-col justify-between gap-12">
              {STATS.map((s) => (
                <div key={s.label}>
                  <CountUp
                    to={s.to}
                    suffix={s.suffix}
                    className="block text-[52px] font-semibold leading-none tracking-[-0.035em] text-white tabular-nums sm:text-[62px]"
                  />
                  <div className="mt-3 text-[15px] text-white/65">{s.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── Quote slider ───────────────────────────────────────────────── */}
          <div className="relative min-h-[440px] overflow-hidden rounded-[22px] bg-black lg:min-h-[600px]">
            {/* All three stay mounted and crossfade — swapping src would flash
                an unloaded frame on every move. */}
            {QUOTES.map((q, i) => (
              <img
                key={q.author}
                src={q.img}
                alt=""
                aria-hidden
                className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${
                  i === idx ? "opacity-100" : "opacity-0"
                }`}
                style={{ objectPosition: q.position }}
              />
            ))}
            <div
              aria-hidden
              className="absolute inset-0"
              style={{ background: "linear-gradient(to top, rgba(0,0,7,0.88) 8%, rgba(0,0,7,0.45) 55%, rgba(0,0,7,0.30))" }}
            />

            <div className="relative flex h-full min-h-[440px] flex-col justify-between p-7 sm:p-10 lg:min-h-[600px]">
              <div>
                <div className="text-[13px] tabular-nums text-white/85">
                  {String(idx + 1).padStart(2, "0")}{" "}
                  <span className="text-white/45">/ {String(QUOTES.length).padStart(2, "0")}</span>
                </div>
                <div className="mt-3 h-px w-14 bg-white/30" />
              </div>

              {/* Keyed on the index so the block replays its entrance on move. */}
              <figure key={idx} className="amp-in">
                <blockquote className="max-w-4xl text-balance text-[22px] font-semibold leading-[1.22] tracking-[-0.02em] text-white sm:text-[32px]">
                  “{active.quote}”
                </blockquote>
                {/* Room kept clear on the right for the absolutely-placed arrows. */}
                <figcaption className="mt-8 pr-28">
                  <div>
                    <div className="text-[15px] font-medium text-white">{active.author}</div>
                    <div className="mt-0.5 text-[14px] text-white/60">{active.role}</div>
                  </div>
                </figcaption>
              </figure>
            </div>

            {/* Outside the keyed block so the arrows never re-animate. */}
            <div className="absolute bottom-7 right-7 flex gap-2.5 sm:bottom-10 sm:right-10">
              {[
                { dir: -1, Icon: ChevronLeft, label: "Previous testimonial" },
                { dir: 1, Icon: ChevronRight, label: "Next testimonial" },
              ].map(({ dir, Icon, label }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => go(dir)}
                  aria-label={label}
                  className="grid h-11 w-11 place-items-center rounded-full border border-white/25 bg-white/5 text-white backdrop-blur-sm transition-colors hover:bg-white hover:text-black"
                >
                  <Icon className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
