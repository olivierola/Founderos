import type { ComponentType, ReactNode } from "react";
import { ArrowsOutSimpleIcon as Maximize2 } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** How the delta pill reads. `neutral` when a variation carries no judgement. */
export type StatTone = "positive" | "negative" | "neutral" | "info";

export interface StatisticsCardItem {
  key?: string;
  title: string;
  /** The period or scope the value covers — "30 derniers jours". */
  subtitle?: string;
  value: string;
  /** Colour the headline number only when the number itself means something. */
  valueClassName?: string;
  badge?: {
    text: string;
    /** Lucide or Phosphor — anything that accepts a className. */
    icon?: ComponentType<{ className?: string }>;
    tone?: StatTone;
  };
  /** An already-built pill, when the caller has its own delta semantics.
   *  Takes precedence over `badge`. */
  badgeNode?: ReactNode;
  /** The comparison line under the value. */
  subtext?: ReactNode;

  // ── Optional instrumentation, for dashboards ────────────────────────────
  /** Small glyph in the corner of the cell. */
  icon?: ComponentType<{ className?: string }>;
  /** Hex colour tinting the icon tile and the corner glow. */
  accent?: string;
  /** A chart the caller renders itself — this component stays chart-agnostic. */
  sparkline?: ReactNode;
  /** Shows a "can be expanded" affordance on hover. */
  hint?: boolean;
  expanded?: boolean;
  onClick?: () => void;
}

export interface StatisticsCard7Props {
  cards: StatisticsCardItem[];
  /** Column classes. Defaults to one column per card, capped at 4. */
  columnsClassName?: string;
  /** `compact` fits six cells across without shrinking the numbers to noise. */
  size?: "default" | "compact";
  className?: string;
}

const BADGE_VARIANT: Record<StatTone, "success" | "destructive" | "secondary" | "info"> = {
  positive: "success",
  negative: "destructive",
  neutral: "secondary",
  info: "info",
};

const COLUMNS: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

/**
 * A segmented strip of statistics: one bordered surface, the cells separated by
 * hairlines rather than floating apart. Reads as a single instrument panel,
 * which is what a row of related numbers is.
 *
 * The hairlines come from `gap-px` over a `bg-border` ground rather than from
 * `divide-*`: a divide rule follows DOM order, so it draws a stray edge at the
 * start of every wrapped row. This technique survives any column count.
 */
export function StatisticsCard7({
  cards,
  columnsClassName,
  size = "default",
  className,
}: StatisticsCard7Props) {
  const cols = columnsClassName ?? COLUMNS[Math.min(cards.length, 4)] ?? COLUMNS[3];
  const compact = size === "compact";

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border",
        cols,
        className,
      )}
    >
      {cards.map((card, i) => {
        const BadgeIcon = card.badge?.icon;
        const Icon = card.icon;
        const interactive = !!card.onClick;

        return (
          <div
            key={card.key ?? i}
            onClick={card.onClick}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
            onKeyDown={
              interactive
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      card.onClick?.();
                    }
                  }
                : undefined
            }
            className={cn(
              "group relative flex flex-col justify-between overflow-hidden bg-card",
              compact ? "gap-3 p-4" : "gap-5 p-5",
              interactive && "cursor-pointer transition-colors hover:bg-accent/40",
              card.expanded && "ring-2 ring-inset ring-primary/40",
            )}
          >
            {card.accent && (
              <div
                aria-hidden
                className="pointer-events-none absolute -right-10 -top-12 h-28 w-28 rounded-full opacity-[0.16] blur-2xl"
                style={{ background: card.accent }}
              />
            )}
            {card.hint && (
              <div
                aria-hidden
                className="pointer-events-none absolute right-2.5 top-2.5 rounded-md bg-muted/80 p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
              >
                <Maximize2 className="h-3 w-3" />
              </div>
            )}

            <div className="relative flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div
                  className={cn(
                    "truncate font-semibold text-foreground",
                    compact ? "text-[11px] font-medium text-muted-foreground" : "text-sm",
                  )}
                >
                  {card.title}
                </div>
                {card.subtitle && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {card.subtitle}
                  </div>
                )}
              </div>
              {Icon && (
                <div
                  className={cn(
                    "flex shrink-0 items-center justify-center rounded-xl",
                    compact ? "h-8 w-8" : "h-9 w-9",
                    !card.accent && "bg-muted text-muted-foreground",
                  )}
                  style={card.accent ? { background: `${card.accent}1f`, color: card.accent } : undefined}
                >
                  <Icon className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
                </div>
              )}
            </div>

            <div className="relative flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "truncate font-bold tracking-tight tabular-nums",
                    compact ? "text-xl" : "text-3xl",
                    card.valueClassName,
                  )}
                >
                  {card.value}
                </span>
                {card.badgeNode ??
                  (card.badge && (
                    <Badge
                      variant={BADGE_VARIANT[card.badge.tone ?? "neutral"]}
                      className="gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                    >
                      {BadgeIcon && <BadgeIcon className="h-3 w-3" aria-hidden="true" />}
                      {card.badge.text}
                    </Badge>
                  ))}
              </div>
              {card.subtext && (
                <div className={cn("truncate", compact ? "text-[11px] text-muted-foreground" : "text-sm")}>
                  {card.subtext}
                </div>
              )}
              {card.sparkline && <div className="mt-1 h-10">{card.sparkline}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default StatisticsCard7;
