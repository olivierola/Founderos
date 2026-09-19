import type { Icon as LucideIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import {
  ArrowRightIcon as ArrowRight,
  CreditCardIcon as CreditCard,
  FileTextIcon as FileText,
  HashIcon as Hash,
  EnvelopeSimpleIcon as Mail,
  ChatIcon as MessageSquare,
  PlusIcon as Plus,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

type Tone = "primary" | "foreground" | "violet" | "emerald" | "sky" | "amber";

type AppPreset = "slack" | "gmail" | "stripe" | "notion" | "discord";

export interface AppItem {
  preset?: AppPreset;
  image?: string;
  alt?: string;
  /** A tile rendered by the caller — a coloured block icon, an avatar, anything
   *  that is not a logo. Takes precedence over `image` and `preset`. */
  node?: ReactNode;
  /** Native tooltip on the tile, so a chain of icons stays readable. */
  title?: string;
}

export interface Automation10Props {
  apps?: AppItem[];
  name?: string;
  description?: string;
  installs?: number;
  installsLabel?: string;
  ctaLabel?: string;
  tone?: Tone;
  className?: string;
  /** Pill in the header row — a status, a category. */
  badge?: ReactNode;
  /** Replaces the installs counter when the card has something better to say. */
  footerLeft?: ReactNode;
  /** Rendered top-right, above the card's click target (a delete button…). */
  actions?: ReactNode;
  /** Defaults to Plus, which only makes sense for an "add / install" CTA. */
  ctaIcon?: LucideIcon;
  onCtaClick?: () => void;
  /** Makes the whole card activatable. Needs `cardLabel` for screen readers. */
  onCardClick?: () => void;
  cardLabel?: string;
  /** Fill the parent (grid cell) instead of centring a 20rem card in a frame.
   *  The default keeps the showcase framing the component ships with. */
  fill?: boolean;
}

const PRESETS: Record<AppPreset, { icon: LucideIcon; tile: string }> = {
  slack: { icon: Hash, tile: "bg-violet-500 text-white" },
  gmail: { icon: Mail, tile: "bg-rose-500 text-white" },
  stripe: { icon: CreditCard, tile: "bg-indigo-500 text-white" },
  notion: {
    icon: FileText,
    tile: "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900",
  },
  discord: { icon: MessageSquare, tile: "bg-indigo-600 text-white" },
};

const ctaClasses: Record<Tone, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  foreground: "bg-foreground text-background hover:bg-foreground/90",
  violet: "bg-violet-500 text-white hover:bg-violet-600",
  emerald: "bg-emerald-500 text-white hover:bg-emerald-600",
  sky: "bg-sky-500 text-white hover:bg-sky-600",
  amber: "bg-amber-500 text-white hover:bg-amber-600",
};

export const automation10Demo: Automation10Props = {
  apps: [
    { preset: "stripe", alt: "Stripe" },
    { preset: "notion", alt: "Notion" },
    { preset: "slack", alt: "Slack" },
  ],
  name: "Sync paid invoices to Notion and ping Slack",
  description:
    "Triggers on Stripe payment, logs the invoice in Notion, and posts a thread to #revenue.",
  installs: 4280,
  installsLabel: "installs",
  ctaLabel: "Use recipe",
  tone: "primary",
};

function AppIcon({ item }: { item: AppItem }) {
  if (item.node) return <>{item.node}</>;
  if (item.image) {
    return (
      <span className="relative size-7 shrink-0 overflow-hidden rounded-lg bg-muted">
        <img
          src={item.image}
          alt={item.alt ?? ""}
          className="absolute inset-0 size-full object-cover"
        />
      </span>
    );
  }
  if (item.preset) {
    const cfg = PRESETS[item.preset];
    const Icon = cfg.icon;
    return (
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-lg",
          cfg.tile,
        )}
        title={item.title}
        aria-hidden="true"
      >
        <Icon className="size-3.5" />
      </span>
    );
  }
  return (
    <span className="size-7 shrink-0 rounded-lg bg-muted" aria-hidden="true" />
  );
}

export function Automation10({
  apps = [],
  name = "Recipe",
  description,
  installs,
  installsLabel = "installs",
  ctaLabel = "Use recipe",
  tone = "primary",
  className,
  badge,
  footerLeft,
  actions,
  ctaIcon: CtaIcon = Plus,
  onCtaClick,
  onCardClick,
  cardLabel,
  fill = false,
}: Automation10Props) {
  const hasFooter =
    Boolean(footerLeft) || typeof installs === "number" || Boolean(ctaLabel);

  return (
    <div
      className={cn(
        fill
          ? "relative size-full"
          : "relative flex size-full items-center justify-center p-4",
        className,
      )}
    >
      <div
        className={cn(
          "group/card relative flex w-full flex-col gap-2.5 rounded-2xl border border-border/70 bg-card p-4",
          fill ? "h-full" : "max-w-80",
          onCardClick && "transition-all hover:border-border hover:shadow-md hover:shadow-black/5",
        )}
      >
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {apps.map((a, i) => (
              <div key={i} className="flex items-center gap-1">
                <AppIcon item={a} />
                {i < apps.length - 1 && (
                  <ArrowRight
                    className="size-3 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
              </div>
            ))}
          </div>
          {badge}
        </div>

        <span className="text-[15px] font-semibold leading-snug text-card-foreground">
          {name}
        </span>

        {description && (
          <p className="line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}

        {hasFooter && (
          <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-3">
            {footerLeft ??
              (typeof installs === "number" && (
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {installs.toLocaleString()} {installsLabel}
                </span>
              ))}
            {ctaLabel && (
              <button
                type="button"
                onClick={onCtaClick}
                className={cn(
                  "relative z-10 ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                  ctaClasses[tone],
                )}
              >
                <CtaIcon className="size-3" aria-hidden="true" />
                {ctaLabel}
              </button>
            )}
          </div>
        )}

        {actions && (
          <div className="absolute right-2 top-2 z-10">{actions}</div>
        )}

        {/* Last in the DOM so it paints over the static content and catches a
            click anywhere on the card; the CTA and actions sit above it via
            z-10. A nested <button> would be invalid markup. */}
        {onCardClick && (
          <button
            type="button"
            onClick={onCardClick}
            aria-label={cardLabel ?? name}
            className="absolute inset-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          />
        )}
      </div>
    </div>
  );
}

export default Automation10;
