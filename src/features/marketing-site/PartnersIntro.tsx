import { useRef, useState } from "react";
import { useScroll, useMotionValueEvent } from "framer-motion";
import { Circle, Hexagon, Triangle, Wind } from "lucide-react";

// Static, greyscale customer/partner wordmarks (text-based — no asset files). The
// slight per-mark font variation reads like a real logo wall.
const PARTNERS: { name: string; cls: string; icon?: typeof Circle }[] = [
  { name: "Frictionless", cls: "font-semibold tracking-tight" },
  { name: "byte studio", cls: "font-bold lowercase tracking-tight" },
  { name: "Minimal AI", cls: "font-medium", icon: Circle },
  { name: "NORDIC OPS", cls: "font-serif tracking-[0.18em] text-[15px]" },
  { name: "PixelLabs", cls: "font-semibold", icon: Hexagon },
  { name: "loomly", cls: "font-bold tracking-tight" },
  { name: "Windward", cls: "font-medium", icon: Wind },
  { name: "Northwind", cls: "font-semibold italic", icon: Triangle },
];

const INTRO_PARAS = [
  "Anduran is a control layer for agencies and studios. It connects to every " +
    "client's Stripe, Vercel, Supabase and GitHub, syncs their data in real time, " +
    "and exposes it through one unified cockpit.",
  "This lets your team operate billing, infra, deploys and support — and the AI " +
    "agents that run them — without ever leaving the panel.",
];

export function PartnersIntro() {
  return (
    <section className="relative mx-auto max-w-[1600px] px-6 pb-28 pt-8 md:px-12">
      {/* ── Partners / trust row ─────────────────────────────────────────────── */}
      <p className="text-center font-mono text-[12px] uppercase tracking-[0.16em] text-foreground/45">
        Trusted by the agencies and studios shipping the future
      </p>
      <div className="mt-9 flex flex-wrap items-center justify-center gap-x-10 gap-y-6 text-foreground/35 sm:gap-x-14">
        {PARTNERS.map((p) => {
          const Icon = p.icon;
          return (
            <span
              key={p.name}
              className={`inline-flex items-center gap-2 whitespace-nowrap text-[18px] transition-colors duration-300 hover:text-foreground/70 ${p.cls}`}
            >
              {Icon && <Icon className="h-4 w-4 opacity-80" />}
              {p.name}
            </span>
          );
        })}
      </div>

      {/* ── Scroll-colorized presentation paragraphs ─────────────────────────── */}
      <div className="mt-28 md:mt-40">
        <ScrollRevealText paragraphs={INTRO_PARAS} />
      </div>
    </section>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Maps a per-word reveal value (0 = not yet, 1 = fully revealed) to a colour. The
// transition band sweeps amber → pink → blue → white, echoing the hero gradient.
function wordColor(wp: number): string {
  if (wp >= 0.82) return "hsl(240 5% 96%)"; // revealed → near-white
  if (wp >= 0.6) return "hsl(214 62% 64%)"; // cool blue
  if (wp >= 0.4) return "hsl(309 55% 72%)"; // brand pink
  if (wp >= 0.18) return "hsl(28 82% 58%)"; // warm amber
  return "hsl(240 6% 30%)"; // not yet → dim grey
}

function ScrollRevealText({ paragraphs }: { paragraphs: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);

  // 0 when the block's top reaches 85% of the viewport, 1 when its bottom reaches
  // 40% — i.e. it fills in as the text scrolls through the screen.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.85", "end 0.4"],
  });
  useMotionValueEvent(scrollYProgress, "change", (v) => setProgress(v));

  // Continuous word index across all paragraphs so the reveal flows top → bottom.
  const totalWords = paragraphs.reduce((n, p) => n + p.split(" ").length, 0);
  const BAND = 9; // words simultaneously mid-transition → the coloured frontier
  let cursor = 0;

  return (
    <div ref={ref} className="space-y-8 md:space-y-10">
      {paragraphs.map((para, pi) => {
        const words = para.split(" ");
        return (
          <p
            key={pi}
            className="text-[30px] font-semibold leading-[1.16] tracking-tight sm:text-[46px] md:text-[60px]"
          >
            {words.map((w, wi) => {
              const i = cursor++;
              const wp = clamp((progress * (totalWords + BAND) - i) / BAND, 0, 1);
              return (
                <span key={wi} style={{ color: wordColor(wp), transition: "color 140ms linear" }}>
                  {w}
                  {wi < words.length - 1 ? " " : ""}
                </span>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}
