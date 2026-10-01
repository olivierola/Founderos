import { useEffect, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRightIcon as ArrowUpRight, CheckIcon as Check } from "@phosphor-icons/react";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";
import "./atlas.css";

/* ══ The Atlas vocabulary ════════════════════════════════════════════════════
   Every marketing page is built from these. The register in one line: white
   paper, Inter set tight and heavy, a Source Serif italic answering each
   heading, and the violet poured through black into white inside rounded
   panels that sit 10px in from the viewport edge.

   Everything states its own ink. These land inside pages whose roots still
   carry older skins, and a component that inherits its colour is a component
   that eventually renders white on white.                                    */

export const AT = {
  ink: "#111011",
  body: "#3d3c3d",
  muted: "#666666",
  faint: "#969696",
  line: "#e3e3e3",
  lineSoft: "#f0f0f0",
  soft: "#f7f7f7",
  violet: "#d22eff",
  deep: "#8b16c4",
  plum: "#5b0d78",
  lilac: "#e5dbeb",
  sky: "#dce4ea",
  mint: "#d2e8c8",
  cream: "#f4f2ef",
} as const;

type IconType = ComponentType<{ className?: string; weight?: "regular" | "bold" | "fill" | "duotone" | "light" | "thin"; style?: CSSProperties }>;

/** Puts the Atlas ground on <html> while a marketing page is mounted, so
    overscroll never flashes the app's own background. */
export function useAtlasSkin() {
  useEffect(() => {
    const el = document.documentElement;
    el.classList.add("at-root", "mkt-no-scrollbar");
    return () => el.classList.remove("at-root", "mkt-no-scrollbar");
  }, []);
}

/* ── Layout ─────────────────────────────────────────────────────────────── */

export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[1200px] px-5 sm:px-8", className)}>{children}</div>;
}

/** A band of the page. Generous vertical rhythm — Atlas breathes between
    sections rather than ruling them off. */
export function Section({
  children,
  className,
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("relative py-20 sm:py-28", className)}>
      {children}
    </section>
  );
}

/* ── The brand lockup ───────────────────────────────────────────────────────
   The mark in a ring, the name spaced out in the violet ramp beside it. */
export function BrandLockup({ size = "md", tone = "ink" }: { size?: "md" | "lg"; tone?: "ink" | "white" }) {
  const ring = size === "lg" ? 36 : 32;
  const color = tone === "white" ? "#ffffff" : AT.ink;
  return (
    <span className="flex items-center gap-2.5">
      <span
        className="grid shrink-0 place-items-center rounded-full"
        style={{ width: ring, height: ring, boxShadow: `inset 0 0 0 2.5px ${color}` }}
      >
        <Logo size={size === "lg" ? 15 : 13} color={color} />
      </span>
      <span
        className={cn(
          "font-medium uppercase leading-none tracking-[0.22em]",
          size === "lg" ? "text-[17px]" : "text-[15px]",
          tone === "white" ? "text-white" : "at-grad-text",
        )}
      >
        Anduran
      </span>
    </span>
  );
}

/* ── The eyebrow pill ───────────────────────────────────────────────────────
   Opens every section: an icon, a few words, the last of them in the ramp. */
export function Eyebrow({
  icon: Icon,
  children,
  accent,
  tone = "light",
  className,
}: {
  icon?: IconType;
  children?: ReactNode;
  /** The words set in the violet ramp, after `children`. */
  accent?: ReactNode;
  tone?: "light" | "glass";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-3 rounded-[22px] py-2.5 pl-4 pr-5 text-left text-[14px] font-semibold leading-[1.25] tracking-[-0.01em] sm:rounded-full sm:leading-none",
        tone === "light"
          ? "border border-[#e3e3e3] bg-white text-[#111011] shadow-[0_10px_30px_-18px_rgba(17,16,17,0.35)]"
          : "border border-white/[0.14] bg-white/[0.08] text-white backdrop-blur-md",
        className,
      )}
    >
      {Icon && <Icon className="h-[18px] w-[18px] shrink-0" />}
      <span className="min-w-0 sm:whitespace-nowrap">
        {children}
        {children && accent ? " " : null}
        {accent && <span className={tone === "light" ? "at-grad-text" : "text-white"}>{accent}</span>}
      </span>
    </span>
  );
}

/* ── Headings ───────────────────────────────────────────────────────────────
   A heavy sans line, then the answer in the serif italic. `inline` keeps the
   two on one line ("Get started exploring …"). */
const HEADING_SIZE = {
  hero: "text-[38px] sm:text-[50px] lg:text-[56px]",
  section: "text-[32px] sm:text-[40px]",
  small: "text-[26px] sm:text-[32px]",
} as const;

export function Heading({
  lead,
  serif,
  as: Tag = "h2",
  size = "section",
  tone = "ink",
  inline = false,
  className,
}: {
  lead?: ReactNode;
  serif?: ReactNode;
  as?: "h1" | "h2" | "h3";
  size?: keyof typeof HEADING_SIZE;
  tone?: "ink" | "white";
  inline?: boolean;
  className?: string;
}) {
  return (
    <Tag
      className={cn(
        // Size first: tailwind-merge treats a later font-size as resetting the
        // line-height, so `leading-*` has to come after it to survive.
        HEADING_SIZE[size],
        "text-balance font-semibold leading-[1.02] tracking-[-0.045em]",
        tone === "white" ? "text-white" : "text-[#111011]",
        className,
      )}
    >
      {lead}
      {lead && serif ? inline ? " " : <br /> : null}
      {serif && <Serif>{serif}</Serif>}
    </Tag>
  );
}

/** The serif italic, a notch larger than the sans it answers so the two share
    a cap height. */
export function Serif({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("at-serif inline-block text-[1.1em] leading-[1.08]", className)}>{children}</span>;
}

export function Lead({
  children,
  className,
  tone = "muted",
}: {
  children: ReactNode;
  className?: string;
  tone?: "muted" | "ink" | "white";
}) {
  return (
    <p
      className={cn(
        "text-[16px] font-light leading-[1.45] sm:text-[17px]",
        tone === "muted" && "text-[#666666]",
        tone === "ink" && "text-[#111011]",
        tone === "white" && "text-white/90",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** Eyebrow + heading + lead, as one block. */
export function SectionHead({
  icon,
  eyebrow,
  accent,
  lead,
  serif,
  description,
  align = "center",
  tone = "ink",
  className,
}: {
  icon?: IconType;
  eyebrow?: ReactNode;
  accent?: ReactNode;
  lead?: ReactNode;
  serif?: ReactNode;
  description?: ReactNode;
  align?: "center" | "left";
  tone?: "ink" | "white";
  className?: string;
}) {
  const center = align === "center";
  return (
    <div className={cn("flex flex-col", center ? "items-center text-center" : "items-start text-left", className)}>
      {(eyebrow || accent) && (
        <Eyebrow icon={icon} accent={accent} tone={tone === "white" ? "glass" : "light"}>
          {eyebrow}
        </Eyebrow>
      )}
      <Heading lead={lead} serif={serif} tone={tone} className={cn("mt-8", center && "max-w-[22ch]")} />
      {description && (
        <Lead
          tone={tone === "white" ? "white" : "muted"}
          className={cn("mt-5", center ? "max-w-[46ch]" : "max-w-[52ch]")}
        >
          {description}
        </Lead>
      )}
    </div>
  );
}

/* ── Buttons ────────────────────────────────────────────────────────────────
   Full pills, semibold, an up-right arrow riding along. `dark` is the black
   slab, `light` the white one with a hairline, `glass` and `white` are for
   the gradient panels. */
type BtnVariant = "dark" | "light" | "glass" | "white";

const BTN_VARIANT: Record<BtnVariant, string> = {
  dark: "bg-black text-white shadow-[0_12px_26px_-14px_rgba(0,0,0,0.7)] hover:bg-[#1d1c1d]",
  light:
    "border border-[#e6e6e6] bg-white text-[#111011] shadow-[0_12px_30px_-16px_rgba(17,16,17,0.3)] hover:border-[#d4d4d4]",
  glass: "border border-white/30 bg-white/[0.14] text-white backdrop-blur-md hover:bg-white/[0.22]",
  white: "bg-white text-[#111011] shadow-[0_14px_30px_-16px_rgba(60,0,90,0.55)] hover:bg-white/90",
};

const BTN_SIZE = {
  sm: "h-[40px] px-5 text-[14px]",
  md: "h-[46px] px-6 text-[15px]",
  lg: "h-[50px] px-8 text-[15px]",
} as const;

export function Btn({
  to,
  href,
  onClick,
  variant = "dark",
  size = "md",
  arrow = true,
  type = "button",
  className,
  children,
}: {
  to?: string;
  href?: string;
  onClick?: () => void;
  variant?: BtnVariant;
  size?: keyof typeof BTN_SIZE;
  arrow?: boolean;
  type?: "button" | "submit";
  className?: string;
  children: ReactNode;
}) {
  const cls = cn(
    "group inline-flex items-center justify-center gap-2.5 whitespace-nowrap rounded-full font-semibold tracking-[-0.015em] transition-all duration-300",
    BTN_SIZE[size],
    BTN_VARIANT[variant],
    className,
  );
  const inner = (
    <>
      {children}
      {arrow && (
        <ArrowUpRight
          weight="bold"
          className="h-4 w-4 shrink-0 transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
        />
      )}
    </>
  );
  if (to) {
    return (
      <Link to={to} onClick={onClick} className={cls}>
        {inner}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} onClick={onClick} className={cls} target="_blank" rel="noopener noreferrer">
        {inner}
      </a>
    );
  }
  return (
    <button type={type} onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}

/* ── Marks ──────────────────────────────────────────────────────────────── */

export function CheckBadge({ size = 30, tone = "dark" }: { size?: number; tone?: "dark" | "white" }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full",
        tone === "dark" ? "at-check" : "bg-white shadow-[0_4px_10px_-4px_rgba(0,0,0,0.25)]",
      )}
      style={{ width: size, height: size }}
    >
      <Check
        weight="bold"
        className={tone === "dark" ? "text-white" : "text-[#8b16c4]"}
        style={{ width: size * 0.46, height: size * 0.46 }}
      />
    </span>
  );
}

/** The check pill row under a panel: a disc and a short fact. */
export function CheckChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex min-h-[38px] items-center gap-3.5 rounded-full bg-[#f5f5f5] py-1 pl-1 pr-5 text-[14.5px] font-semibold tracking-[-0.01em] text-[#111011]",
        className,
      )}
    >
      <CheckBadge />
      <span className="py-1">{children}</span>
    </div>
  );
}

/** A white pill with an outlined icon — the facts row at the foot of a panel. */
export function InfoPill({
  icon: Icon,
  children,
  className,
}: {
  icon: IconType;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[52px] items-center gap-4 rounded-full bg-white px-5 py-3 text-[15px] font-medium tracking-[-0.01em] text-[#111011] shadow-[0_16px_40px_-24px_rgba(60,0,90,0.45)]",
        className,
      )}
    >
      <Icon className="h-[22px] w-[22px] shrink-0 text-[#111011]" />
      <span>{children}</span>
    </div>
  );
}

/** The glowing disc an icon sits in. */
export function IconOrb({
  icon: Icon,
  size = 52,
  tone = "bright",
  className,
}: {
  icon: IconType;
  size?: number;
  tone?: "bright" | "dark";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full",
        tone === "bright" ? "at-orb" : "at-orb-dark",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Icon className="text-white" style={{ width: size * 0.4, height: size * 0.4 }} />
    </span>
  );
}

/** A small grey disc with an outlined icon — list bullets and card heads. */
export function IconDisc({
  icon: Icon,
  size = 40,
  className,
}: {
  icon: IconType;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn("grid shrink-0 place-items-center rounded-full bg-[#f3f3f3] text-[#111011]", className)}
      style={{ width: size, height: size }}
    >
      <Icon style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  );
}

/* ── The tile field ─────────────────────────────────────────────────────────
   The rounded keys over the dark and violet grounds, with a few of them lit on
   a slow loop. Coordinates are [column, row] on the 93×48 pitch the pattern
   repeats on, so the lit keys land exactly on top of drawn ones. */
const DEFAULT_LIT: [number, number][] = [
  [0, 0], [1, 1], [3, 0], [4, 1], [13, 1], [14, 3], [15, 2], [14, 5],
  [0, 4], [1, 5], [2, 6], [12, 7], [13, 8], [3, 9], [15, 9],
];

export function TileField({
  lit = DEFAULT_LIT,
  className,
  mask = "linear-gradient(180deg, #000 0%, #000 55%, transparent 92%)",
  glow = "rgba(255,255,255,0.14)",
}: {
  lit?: [number, number][];
  className?: string;
  mask?: string;
  glow?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
      style={{ WebkitMaskImage: mask, maskImage: mask }}
    >
      <div className="at-tiles absolute inset-0" />
      {lit.map(([c, r], i) => (
        <span
          key={`${c}-${r}`}
          className="at-tile absolute rounded-[10px]"
          style={{
            left: c * 93 + 3,
            top: r * 48 + 3,
            width: 87,
            height: 42,
            background: glow,
            animationDelay: `${(i * 0.73) % 6}s`,
          }}
        />
      ))}
    </div>
  );
}

/* ── Panels ─────────────────────────────────────────────────────────────────
   The big rounded grounds, inset 10px from the viewport so the page's white
   frames them. `hero` and `dark` run black → violet → white; `violet` starts
   in the colour; `soft` is the pale grey tray testimonials and industries sit
   in. */
const PANEL_GROUND = {
  hero: "at-grad-hero",
  steps: "at-grad-steps",
  page: "at-grad-page",
  accent: "at-grad-accent",
  footer: "at-grad-footer",
  soft: "bg-[#f8f8f8] ring-1 ring-inset ring-[#f0f0f0]",
} as const;

export function Panel({
  variant = "hero",
  tiles = variant !== "soft",
  lit,
  tileMask,
  className,
  innerClassName,
  children,
}: {
  variant?: keyof typeof PANEL_GROUND;
  tiles?: boolean;
  lit?: [number, number][];
  tileMask?: string;
  className?: string;
  innerClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("px-[10px]", className)}>
      <div
        className={cn(
          "relative overflow-hidden rounded-[28px] sm:rounded-[40px]",
          PANEL_GROUND[variant],
          innerClassName,
        )}
      >
        {tiles && <TileField lit={lit} mask={tileMask} />}
        <div className="relative">{children}</div>
      </div>
    </div>
  );
}

/** A white card with a hairline and a long soft shadow. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "relative rounded-[28px] border border-[#f0f0f0] bg-white shadow-[0_30px_60px_-44px_rgba(17,16,17,0.35)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A small pill label ("Readiness", "Day 1"). */
export function Tag({
  children,
  tone = "light",
  className,
}: {
  children: ReactNode;
  tone?: "light" | "glass" | "accent";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-4 py-2 text-[14px] font-semibold leading-none tracking-[-0.01em]",
        tone === "light" && "border border-[#e6e6e6] bg-white text-[#111011]",
        tone === "glass" && "bg-white/20 text-white backdrop-blur-md",
        tone === "accent" && "bg-[#f7ecfc] text-[#8b16c4]",
        className,
      )}
    >
      {children}
    </span>
  );
}
