import { useEffect, useRef, useState, type ReactNode } from "react";
import NumberFlow from "@number-flow/react";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

/* The wordmark face. Fascinate is a single-weight display cut — never ask it
   for bold, the browser would smear a synthetic weight over an already-heavy
   drawing. */
export const BRAND_FONT = "'Fascinate', cursive";

export const CYAN = "var(--amp-cyan)";
export const ACCENT = "var(--amp-accent)";
export const ON_ACCENT = "var(--amp-on-accent)";

/* ── Per-character headline reveal ──────────────────────────────────────────
   Words stay unbreakable (inline-block) so the line still wraps naturally,
   while every glyph fades up from a blur on its own delay.                    */
export function AnimatedText({
  text,
  className,
  delay = 0,
  step = 14,
}: {
  text: string;
  className?: string;
  delay?: number;
  step?: number;
}) {
  let index = 0;
  return (
    <span className={className} aria-label={text}>
      {text.split(" ").map((word, w) => (
        <span key={`${word}-${w}`} className="inline-block">
          {Array.from(w === 0 ? word : ` ${word}`).map((ch, c) => {
            const d = delay + index++ * step;
            return (
              <span key={c} aria-hidden className="amp-char" style={{ animationDelay: `${d}ms` }}>
                {ch}
              </span>
            );
          })}
        </span>
      ))}
    </span>
  );
}

/* ── Typewriter ─────────────────────────────────────────────────────────────
   Types a phrase, holds it, deletes it, moves to the next. A single word is
   typed once and kept — the deletion loop only runs when there is somewhere to
   go. The caret stays mounted the whole time so the line never collapses.     */
export function Typewriter({
  words,
  className,
  caretClassName,
  startDelay = 0,
  typeMs = 58,
  deleteMs = 28,
  holdMs = 2000,
}: {
  words: string[];
  className?: string;
  caretClassName?: string;
  startDelay?: number;
  typeMs?: number;
  deleteMs?: number;
  holdMs?: number;
}) {
  const [index, setIndex] = useState(0);
  const [len, setLen] = useState(0);
  const [phase, setPhase] = useState<"wait" | "typing" | "deleting">("wait");

  // Typing letter by letter is exactly the motion this opts out of, so the
  // reduced-motion path just prints the first phrase.
  const [still] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  const word = words[index % words.length];

  useEffect(() => {
    if (still) return;

    if (phase === "wait") {
      const t = setTimeout(() => setPhase("typing"), startDelay);
      return () => clearTimeout(t);
    }

    if (phase === "typing") {
      if (len < word.length) {
        const t = setTimeout(() => setLen(len + 1), typeMs);
        return () => clearTimeout(t);
      }
      if (words.length < 2) return; // nothing to rotate to — leave it typed
      const t = setTimeout(() => setPhase("deleting"), holdMs);
      return () => clearTimeout(t);
    }

    if (len > 0) {
      const t = setTimeout(() => setLen(len - 1), deleteMs);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setIndex((i) => (i + 1) % words.length);
      setPhase("typing");
    }, 240);
    return () => clearTimeout(t);
  }, [still, phase, len, word, words.length, startDelay, typeMs, deleteMs, holdMs]);

  // The longest phrase holds the box open. Without it the headline re-wraps on
  // every keystroke — and loses a whole line while the tail is empty — which
  // walks the paragraph and the buttons up and down the page.
  const widest = words.reduce((a, b) => (b.length > a.length ? b : a), "");

  return (
    <span className={cn("relative inline-block whitespace-nowrap text-left align-baseline", className)}>
      {/* Screen readers get the sentence whole; the animation is decoration. */}
      <span className="sr-only">{words[0]}</span>

      {/* In flow, invisible: this is what the line is measured against, so the
          width never changes and neither does the line count. */}
      <span aria-hidden className="invisible pr-[0.14em]">
        {widest}
      </span>

      {/* Out of flow, centred on that reserved slot. */}
      <span aria-hidden className="absolute left-0 top-0 w-full text-center">
        {still ? words[0] : word.slice(0, len)}
        <span
          className={cn(
            "amp-caret ml-[0.06em] inline-block h-[0.74em] w-[0.055em] translate-y-[0.06em] bg-current align-baseline",
            caretClassName,
          )}
        />
      </span>
    </span>
  );
}

/* ── Scroll-triggered reveal wrapper ────────────────────────────────────── */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        // Also reveal anything already scrolled past (deep links, anchor jumps),
        // otherwise those blocks would stay invisible forever.
        if (entry.isIntersecting || entry.boundingClientRect.top < 0) {
          el.classList.add("is-in");
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={cn("amp-reveal", className)} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

/* ── Figure that counts up the first time it scrolls into view ───────────── */
export function CountUp({
  to,
  prefix,
  suffix,
  className,
}: {
  to: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting || entry.boundingClientRect.top < 0) {
          setValue(to);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [to]);

  return (
    <span ref={ref} className={className}>
      {prefix}
      <NumberFlow value={value} />
      {suffix}
    </span>
  );
}

/* ── Solid accent badge that opens every section. ───────────────────────── */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2.5 py-1.5 text-[11px] font-semibold uppercase leading-none tracking-[0.03em]",
        className,
      )}
      style={{ background: ACCENT, color: ON_ACCENT }}
    >
      {children}
    </span>
  );
}

/* ── Section header: eyebrow + title + optional lead paragraph ───────────── */
export function SectionHead({
  eyebrow,
  title,
  lead,
  center = false,
  className,
}: {
  eyebrow: string;
  title: string;
  lead?: string;
  center?: boolean;
  className?: string;
}) {
  return (
    <Reveal className={cn(center && "flex flex-col items-center text-center", className)}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-7 max-w-3xl text-balance text-[34px] font-semibold leading-[1.06] tracking-[-0.028em] sm:text-[46px] lg:text-[54px]">
        {title}
      </h2>
      {lead && (
        <p className="mt-6 max-w-2xl text-[17px] leading-[1.6] text-[var(--amp-muted)]">{lead}</p>
      )}
    </Reveal>
  );
}

/* ── Call-to-action buttons ─────────────────────────────────────────────────
   Primary: an accent slab with a white tile on the right holding the arrow.
   Ghost: the neutral panel surface, so it works on both dark and light bands. */
export function CtaPrimary({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-4 rounded-xl py-2 pl-6 pr-2 text-[15px] font-medium transition-opacity hover:opacity-90",
        className,
      )}
      style={{ background: ACCENT, color: ON_ACCENT }}
    >
      {children}
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white">
        {/* The accent itself — ON_ACCENT is white and would vanish on the tile. */}
        <ArrowUpRight className="h-4 w-4" style={{ color: ACCENT }} />
      </span>
    </span>
  );
}

/* Hero button: a near-black pill, arrow inline. Deliberately not the accent
   slab — the hero already carries orange in the headline. */
export function CtaPill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "group inline-flex items-center gap-2.5 rounded-full bg-[#2b2b2b] px-7 py-3.5 text-[15px] font-medium text-white shadow-[0_12px_28px_-14px_rgba(0,0,7,0.8)] transition-colors hover:bg-[#0d0d0d]",
        className,
      )}
    >
      {children}
      <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
    </span>
  );
}

export function CtaGhost({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "amp-panel amp-panel-hover inline-flex items-center gap-2 rounded-xl px-6 py-4 text-[15px] font-medium leading-none",
        className,
      )}
    >
      {children}
    </span>
  );
}
