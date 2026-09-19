import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Floating rounded tab switcher, overlaid on top of a panel's content (which
 * runs all the way up behind it) instead of a bordered header pushing the
 * content down. Shared by the Room panel (General/Flow/Artifacts) and the
 * agent pages in a dashboard (configuration tabs).
 *
 * Every tab shows its icon AND its name. When the row can't fit the width it
 * is given, it wraps to a second line rather than scrolling: a tab you have to
 * discover by dragging the bar sideways may as well not be there.
 */
export function FloatingTabBar<T extends string>({
  sections, active, onSelect, trailing, className, style, variant = "main", onHeight,
}: {
  sections: { key: T; label: string; icon: any }[];
  active: T;
  onSelect: (k: T) => void;
  /** "sub" est la seconde barre : même langage, un cran plus discret, pour que
   *  la hiérarchie se lise sans avoir à comparer les libellés. */
  variant?: "main" | "sub";
  /** Positionnement calculé par l'hôte (la barre secondaire se pose sous la
   *  principale, dont la hauteur dépend du nombre de lignes). */
  style?: React.CSSProperties;
  /** Extra control on the right of the bar (e.g. a close button). */
  trailing?: React.ReactNode;
  /** Override positioning/width (e.g. to keep clear of floating side pills). */
  className?: string;
  /** Measured height, so the host can keep its first row clear of the bar —
   *  which is not a constant: the bar wraps to a second line when narrow. */
  onHeight?: (px: number) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !onHeight) return;
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    onHeight(el.offsetHeight);
    return () => ro.disconnect();
  }, [onHeight]);

  const sub = variant === "sub";
  return (
    <nav
      ref={ref}
      style={style}
      className={cn(
        "absolute left-1/2 z-10 flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-wrap items-center justify-center backdrop-blur",
        sub
          ? "gap-0.5 rounded-2xl border border-border/60 bg-background/80 px-1.5 py-1 shadow-sm"
          : "top-3 gap-1 rounded-3xl border border-border bg-background/95 px-2 py-1.5 shadow-md",
        className,
      )}
    >
      {sections.map((s) => {
        const Icon = s.icon;
        const on = s.key === active;
        return (
          <button
            key={s.key}
            onClick={() => onSelect(s.key)}
            aria-pressed={on}
            className={cn(
              "flex shrink-0 items-center rounded-full transition-colors",
              sub ? "gap-1.5 px-3 py-1.5 text-xs" : "gap-2 px-3.5 py-2 text-[13px]",
              on
                ? sub ? "bg-muted font-medium text-foreground" : "bg-sidebar-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            <Icon className={sub ? "h-4 w-4" : "h-[18px] w-[18px]"} /> {s.label}
          </button>
        );
      })}
      {trailing}
    </nav>
  );
}
