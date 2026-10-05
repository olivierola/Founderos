import { useEffect, useState, type ComponentType, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Link } from "react-router-dom";
import {
  CaretRightIcon as CaretRight,
  MinusIcon as Minus,
  PlusIcon as Plus,
  SealCheckIcon as SealCheck,
} from "@phosphor-icons/react";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";
import "./hn.css";

/* ══ The Hunar vocabulary ════════════════════════════════════════════════════
   Every marketing page is built from these. The register: Geist at 400/500
   with a tight track, one blue, warm off-white bands alternating with
   near-black ones, 4px controls and 8px cards, and gradient artwork where the
   reference uses photographs.

   Everything states its own ink. These land inside pages whose roots still
   carry older skins, and a component that inherits its colour eventually
   renders blue on blue.                                                       */

export const HN = {
  ink: "#0f1728",
  body: "#344054",
  grey: "#4b5567",
  bg: "#f7f8fb",
  soft: "#f5f7fa",
  line: "#e6e9ef",
  dark: "#0f1728",
  blue: "#006edd",
  blueLight: "#5aa8ff",
  blue50: "#eaf2ff",
} as const;

export type IconType = ComponentType<{ className?: string; weight?: "regular" | "bold" | "fill" | "duotone" | "light" | "thin"; style?: CSSProperties }>;
export type Art = "blue" | "violet" | "olive" | "orange" | "pink" | "gold";

/** Puts the white ground on <html> while a marketing page is mounted, so
    overscroll never flashes the app's own background. */
export function useHnSkin() {
  useEffect(() => {
    const el = document.documentElement;
    el.classList.add("hn-root", "mkt-no-scrollbar");
    return () => el.classList.remove("hn-root", "mkt-no-scrollbar");
  }, []);
}

/** Fades cards (`.hn-card`) and section heads (`[data-reveal]`) up as they
    scroll into view, staggered among siblings. Elements added later (FAQ
    answers, plans loaded from the database) are picked up by a mutation
    observer. Off for reduced motion. */
export function useHnReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting && e.boundingClientRect.top >= 0) continue;
          const t = e.target as HTMLElement;
          t.classList.add("is-in");
          io.unobserve(t);
          // The stagger delay would also slow the hover transitions — drop it
          // once the card has arrived.
          window.setTimeout(() => (t.style.transitionDelay = ""), 1000);
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );
    const seen = new WeakSet<Element>();
    const scan = () => {
      el.querySelectorAll<HTMLElement>(".hn-card, [data-reveal]").forEach((n) => {
        if (seen.has(n) || n.closest("[data-no-reveal]")) return;
        seen.add(n);
        const siblings = n.parentElement ? Array.from(n.parentElement.children) : [];
        n.style.transitionDelay = `${(Math.max(0, siblings.indexOf(n)) % 4) * 80}ms`;
        n.classList.add("hn-reveal");
        io.observe(n);
      });
    };
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [root]);
}

/* ── Layout ─────────────────────────────────────────────────────────────── */

/** The page width, as measured on the reference: FULL width with a 48px
    gutter — no max width, so the page widens with the screen. `narrow` is
    the fixed 1200px measure its centred sections use. */
export function Container({
  children,
  className,
  narrow = false,
}: {
  children: ReactNode;
  className?: string;
  narrow?: boolean;
}) {
  return (
    <div className={cn("mx-auto w-full px-5 sm:px-8 lg:px-12", narrow ? "max-w-[1296px]" : "max-w-none", className)}>
      {children}
    </div>
  );
}

/** A band of the page. `tone` sets the ground; the reference alternates
    white and the warm off-white, and drops into near-black for its showcase
    bands. */
export function Band({
  children,
  tone = "white",
  className,
  id,
  rule = true,
}: {
  children: ReactNode;
  tone?: "white" | "bg" | "dark" | "blue-50";
  className?: string;
  id?: string;
  /** The hairline on top of a light band. */
  rule?: boolean;
}) {
  return (
    <section
      id={id}
      className={cn(
        "relative",
        tone === "white" && "bg-white text-[#0f1728]",
        tone === "bg" && "bg-[#f7f8fb] text-[#0f1728]",
        tone === "blue-50" && "bg-[#f3f7fe] text-[#0f1728]",
        tone === "dark" && "hn-dark text-white",
        rule && tone !== "dark" && "border-t border-[#e6e9ef]",
        className,
      )}
    >
      {children}
    </section>
  );
}

/* ── The brand lockup ───────────────────────────────────────────────────────
   Hunar's treatment: the mark and a wide, geometric uppercase wordmark, both
   in the same near-black, the full stop included. Their lettering is custom
   artwork; ours is set in Audiowide, the closest open font (rounded square
   corners, wide caps). Sized so the lockup is ~28px tall, like theirs. */
export function Brand({ tone = "ink", size = "md" }: { tone?: "ink" | "white"; size?: "md" | "lg" }) {
  const color = tone === "white" ? "#ffffff" : "#0f1728";
  return (
    <span className="flex items-center gap-2.5" style={{ color }}>
      <Logo size={size === "lg" ? 26 : 22} color={color} />
      <span
        className={cn("leading-none tracking-[0.02em]", size === "lg" ? "text-[24px]" : "text-[21px]")}
        style={{ fontFamily: "'Audiowide', 'Geist', sans-serif", fontWeight: 400 }}
      >
        ANDURAN.
      </span>
    </span>
  );
}

/** The product lockup for the bubbles: the mark, ANDURAN and the product
    word, all in Audiowide — the navbar's lettering. */
export function ProductMark({ word, tone = "white", size = 20 }: { word: string; tone?: "white" | "ink"; size?: number }) {
  const color = tone === "white" ? "#ffffff" : "#0f1728";
  return (
    <span className="inline-flex items-center gap-2" style={{ color }}>
      <Logo size={size} color={color} />
      <span className="leading-none tracking-[0.02em]" style={{ fontFamily: "'Audiowide', 'Geist', sans-serif", fontSize: size }}>
        ANDURAN<span className="opacity-60"> {word}</span>
      </span>
    </span>
  );
}

/** A real product capture, framed like an app window. `tilt` is the hover
    animation of the reference's Products section (the parent carries
    `group`). */
export function ProductShot({
  src,
  alt,
  className,
  tilt = false,
}: {
  src: string;
  alt: string;
  className?: string;
  tilt?: boolean;
}) {
  return (
    <div
      className={cn(
        "hn-keep overflow-hidden rounded-[14px] border border-black/[0.06] bg-white hn-shadow-lg",
        tilt && "origin-bottom-left transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:-translate-y-2 group-hover:-rotate-[2.5deg]",
        className,
      )}
    >
      <img src={src} alt={alt} loading="lazy" className="block h-full w-full object-cover object-left-top" />
    </div>
  );
}

/* ── Eyebrow ────────────────────────────────────────────────────────────────
   A filled seal and a few words in the blue. On a dark band the blue opens up
   so it still reads. */
export function Eyebrow({
  children,
  tone = "light",
  className,
}: {
  children: ReactNode;
  tone?: "light" | "dark" | "white";
  className?: string;
}) {
  const color = tone === "dark" ? HN.blueLight : tone === "white" ? "#ffffff" : HN.blue;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-[16px] font-medium leading-none tracking-[-0.02em]", className)}
      style={{ color }}
    >
      <SealCheck weight="fill" className="h-[18px] w-[18px] shrink-0" />
      {children}
    </span>
  );
}

/* ── Headings ───────────────────────────────────────────────────────────── */
const H_SIZE = {
  hero: "text-[44px] sm:text-[56px] lg:text-[64px] leading-[1] tracking-[-0.04em]",
  section: "text-[28px] sm:text-[32px] leading-[1.2] tracking-[-0.04em]",
  sub: "text-[24px] leading-[1.2] tracking-[-0.04em]",
  card: "text-[20px] leading-[1.3] tracking-normal",
} as const;

export function H({
  children,
  as: Tag = "h2",
  size = "section",
  tone = "ink",
  className,
}: {
  children: ReactNode;
  as?: "h1" | "h2" | "h3" | "h4";
  size?: keyof typeof H_SIZE;
  tone?: "ink" | "white";
  className?: string;
}) {
  return (
    <Tag
      className={cn(
        H_SIZE[size],
        "text-balance font-medium",
        tone === "white" ? "text-white" : "text-[#0f1728]",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function P({
  children,
  className,
  tone = "grey",
  size = "lg",
}: {
  children: ReactNode;
  className?: string;
  tone?: "grey" | "ink" | "white" | "dim";
  size?: "lg" | "md" | "sm";
}) {
  return (
    <p
      className={cn(
        size === "lg" && "text-[18px] leading-[1.3]",
        size === "md" && "text-[16px] leading-[1.4]",
        size === "sm" && "text-[14px] leading-[1.45]",
        tone === "grey" && "text-[#4b5567]",
        tone === "ink" && "text-[#0f1728]",
        tone === "white" && "text-white",
        tone === "dim" && "text-white/75",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** Eyebrow + heading + lead. `split` puts the lead in a right-hand column,
    as the reference does on its dark bands and "How it works". */
export function Head({
  eyebrow,
  title,
  lead,
  align = "center",
  tone = "light",
  split = false,
  children,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  align?: "center" | "left";
  tone?: "light" | "dark";
  split?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const dark = tone === "dark";
  if (split) {
    return (
      <div data-reveal className={cn("grid items-end gap-8 lg:grid-cols-2 lg:gap-16", className)}>
        <div>
          {eyebrow && <Eyebrow tone={dark ? "dark" : "light"}>{eyebrow}</Eyebrow>}
          <H tone={dark ? "white" : "ink"} className="mt-4 max-w-[17ch]">
            {title}
          </H>
        </div>
        <div className="lg:justify-self-end">
          {lead && (
            <P tone={dark ? "dim" : "grey"} className="max-w-[44ch]">
              {lead}
            </P>
          )}
          {children && <div className="mt-6">{children}</div>}
        </div>
      </div>
    );
  }
  const center = align === "center";
  return (
    <div data-reveal className={cn("flex flex-col", center ? "items-center text-center" : "items-start", className)}>
      {eyebrow && <Eyebrow tone={dark ? "dark" : "light"}>{eyebrow}</Eyebrow>}
      <H tone={dark ? "white" : "ink"} className={cn("mt-4", center ? "max-w-[22ch]" : "max-w-[24ch]")}>
        {title}
      </H>
      {lead && (
        <P tone={dark ? "dim" : "grey"} className={cn("mt-4", center ? "max-w-[46ch]" : "max-w-[52ch]")}>
          {lead}
        </P>
      )}
      {children && <div className="mt-7">{children}</div>}
    </div>
  );
}

/* ── Buttons ────────────────────────────────────────────────────────────────
   Small radius, medium weight, a chevron riding along. `primary` is the blue
   slab, `secondary` the white one with a hairline, `link` the bare blue text
   the reference uses under every card, `ghost` the outline on dark bands. */
// The tri-colour system: black is the primary CTA (highest contrast on the
// white ground), blue the accent for secondary actions and inline links, white
// the one used on dark bands. `blue` keeps a full-colour button where the
// accent should lead rather than the black slab.
type BtnVariant = "primary" | "blue" | "secondary" | "link" | "link-light" | "ghost" | "white";

const BTN: Record<BtnVariant, string> = {
  primary: "h-11 rounded-full bg-[#0f1728] px-5 text-white hover:bg-[#1c2740]",
  blue: "h-11 rounded-full bg-[#006edd] px-5 text-white hover:bg-[#0057c2]",
  secondary: "h-11 rounded-full border border-[#e6e9ef] bg-white px-5 text-[#0f1728] hover:border-[#cfd5df]",
  white: "h-11 rounded-full bg-white px-5 text-[#0f1728] hover:bg-white/90",
  ghost: "h-11 rounded-full border border-white/20 bg-white/[0.04] px-5 text-white hover:bg-white/[0.08]",
  link: "text-[#006edd] hover:text-[#0057c2]",
  "link-light": "text-[#5aa8ff] hover:text-[#8cc2ff]",
};

export function Btn({
  to,
  href,
  onClick,
  variant = "primary",
  chevron = true,
  type = "button",
  className,
  children,
}: {
  to?: string;
  href?: string;
  onClick?: () => void;
  variant?: BtnVariant;
  chevron?: boolean;
  type?: "button" | "submit";
  className?: string;
  children: ReactNode;
}) {
  const cls = cn(
    "group inline-flex items-center gap-1.5 whitespace-nowrap text-[16px] font-medium leading-none tracking-[-0.02em] transition-colors",
    BTN[variant],
    className,
  );
  const inner = (
    <>
      {children}
      {chevron && (
        <CaretRight weight="bold" className="h-3 w-3 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5" />
      )}
    </>
  );
  if (to) return <Link to={to} onClick={onClick} className={cls}>{inner}</Link>;
  if (href) return <a href={href} onClick={onClick} className={cls} target="_blank" rel="noopener noreferrer">{inner}</a>;
  return <button type={type} onClick={onClick} className={cls}>{inner}</button>;
}

/* ── Surfaces ───────────────────────────────────────────────────────────── */

export function Card({
  children,
  className,
  tone = "white",
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  tone?: "white" | "bg" | "dark";
  /** Floods the card with the brand blue on hover (see .hn-hover). */
  hover?: boolean;
}) {
  return (
    <div
      className={cn(
        "hn-card rounded-[24px] border",
        hover && "hn-hover",
        tone === "white" && "border-[#e6e9ef] bg-white",
        tone === "bg" && "border-[#e6e9ef] bg-[#f7f8fb]",
        tone === "dark" && "border-white/10 bg-white/[0.05]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A gradient artwork panel. */
export function ArtPanel({
  art = "blue",
  className,
  children,
}: {
  art?: Art;
  className?: string;
  children?: ReactNode;
}) {
  return <div className={cn("hn-art hn-keep", `hn-art-${art}`, className)}>{children}</div>;
}

/** The small square an icon sits in, top-left of a feature card. */
export function IconTile({ icon: Icon, tone = "light", className }: { icon: IconType; tone?: "light" | "dark"; className?: string }) {
  return (
    <span
      className={cn(
        "hn-icon grid h-12 w-12 shrink-0 place-items-center rounded-[14px] border",
        tone === "light" ? "border-[#e6e9ef] bg-white text-[#006edd]" : "border-white/10 bg-white/[0.04] text-white",
        className,
      )}
    >
      <Icon className="h-6 w-6" />
    </span>
  );
}

/** The feature card: icon top-left, title and line at the foot. */
export function FeatureCard({
  icon,
  title,
  body,
  tone = "white",
  className,
}: {
  icon: IconType;
  title: ReactNode;
  body: ReactNode;
  tone?: "white" | "bg" | "dark";
  className?: string;
}) {
  const dark = tone === "dark";
  return (
    <Card tone={tone} hover className={cn("flex h-full min-h-[230px] flex-col p-6", className)}>
      {dark ? (
        <Icon icon={icon} />
      ) : (
        <IconTile icon={icon} />
      )}
      <div className="mt-auto pt-10">
        <h3 className={cn("text-[20px] font-medium leading-[1.3]", dark ? "text-white" : "text-[#0f1728]")}>
          {title}
        </h3>
        <p className={cn("mt-2 text-[18px] leading-[1.3]", dark ? "text-white/75" : "text-[#4b5567]")}>{body}</p>
      </div>
    </Card>
  );
}

function Icon({ icon: I }: { icon: IconType }) {
  return <I className="h-8 w-8 text-white" />;
}

/** A label chip ("Finance", "Industry stories"). */
export function Chip({ children, tone = "light", className }: { children: ReactNode; tone?: "light" | "dark" | "blue"; className?: string }) {
  return (
    <span
      className={cn(
        "hn-chip inline-flex items-center rounded-full border px-3.5 py-2 text-[16px] font-medium leading-none tracking-[-0.02em]",
        tone === "light" && "border-[#e6e9ef] bg-white text-[#0f1728]",
        tone === "dark" && "border-white/10 bg-white/[0.05] text-white",
        tone === "blue" && "border-transparent bg-[#006edd] text-white",
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── Accordion list ─────────────────────────────────────────────────────────
   The reference's feature lists: rows ruled by hairlines, one open at a time,
   the open row showing its line. Clicking the open row leaves it open — the
   picture beside it needs something to point at. */
export function AccordionList({
  items,
  tone = "light",
  value,
  onChange,
}: {
  items: { title: string; body: ReactNode }[];
  tone?: "light" | "dark";
  value?: number;
  onChange?: (i: number) => void;
}) {
  const [own, setOwn] = useState(0);
  const open = value ?? own;
  const set = onChange ?? setOwn;
  const dark = tone === "dark";
  return (
    <div className={cn("border-t", dark ? "border-white/10" : "border-[#e6e9ef]")}>
      {items.map((it, i) => {
        const on = i === open;
        return (
          <div key={it.title} className={cn("border-b", dark ? "border-white/10" : "border-[#e6e9ef]")}>
            <button
              type="button"
              aria-expanded={on}
              onClick={() => set(i)}
              className={cn(
                "flex w-full items-center justify-between gap-4 px-6 py-5 text-left text-[20px] font-medium leading-[1.3]",
                dark ? "text-white" : "text-[#0f1728]",
              )}
            >
              {it.title}
            </button>
            <div className={cn("grid transition-[grid-template-rows] duration-300", on ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
              <div className="overflow-hidden">
                <p className={cn("px-6 pb-6 text-[18px] leading-[1.3]", dark ? "text-white/75" : "text-[#4b5567]")}>{it.body}</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── FAQ grid ───────────────────────────────────────────────────────────────
   Two columns of bordered rows with a plus, as on the reference's solution
   pages. */
export function FaqGrid({ items }: { items: { q: string; a: string }[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const half = Math.ceil(items.length / 2);
  const cols = [items.slice(0, half), items.slice(half)];
  return (
    <div className="grid items-start gap-3 md:grid-cols-2">
      {cols.map((col, c) => (
        <div key={c} className="space-y-3">
          {col.map((f, j) => {
            const i = c * half + j;
            const on = open === i;
            return (
              <div key={f.q} className="rounded-[20px] border border-[#e6e9ef] bg-[#f7f8fb]">
                <button
                  type="button"
                  aria-expanded={on}
                  onClick={() => setOpen(on ? null : i)}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-[16px] leading-[1.35] tracking-[-0.01em] text-[#0f1728]"
                >
                  {f.q}
                  {on ? <Minus className="h-4 w-4 shrink-0" /> : <Plus className="h-4 w-4 shrink-0" />}
                </button>
                {on && <p className="px-5 pb-5 text-[15px] leading-[1.5] text-[#4b5567]">{f.a}</p>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The two blue square arrows under a carousel. */
export function CarouselButtons({ onPrev, onNext, className }: { onPrev: () => void; onNext: () => void; className?: string }) {
  return (
    <div className={cn("flex justify-center gap-2", className)}>
      {[
        { label: "Previous", on: onPrev, flip: true },
        { label: "Next", on: onNext, flip: false },
      ].map((b) => (
        <button
          key={b.label}
          type="button"
          aria-label={b.label}
          onClick={b.on}
          className="grid h-11 w-11 place-items-center rounded-full bg-[#006edd] text-white transition-colors hover:bg-[#0057c2]"
        >
          <CaretRight weight="bold" className={cn("h-3.5 w-3.5", b.flip && "rotate-180")} />
        </button>
      ))}
    </div>
  );
}

/** A big numeral and its caption, for the facts strips. */
export function Fact({ value, label, tone = "light" }: { value: ReactNode; label: ReactNode; tone?: "light" | "dark" }) {
  return (
    <div>
      <div className={cn("text-[32px] font-medium leading-[1.2] tracking-[-0.04em]", tone === "dark" ? "text-white" : "text-[#0f1728]")}>
        {value}
      </div>
      <div className={cn("mt-1 text-[18px] leading-[1.3]", tone === "dark" ? "text-white/75" : "text-[#4b5567]")}>{label}</div>
    </div>
  );
}
