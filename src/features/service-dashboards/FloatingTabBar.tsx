import { cn } from "@/lib/utils";

/**
 * Floating rounded tab switcher, overlaid on top of a panel's content (which
 * runs all the way up behind it) instead of a bordered header pushing the
 * content down. Shared by the Room panel (General/Task/Artifacts) and the
 * agent-in-dashboard panel (Settings/Skills/…).
 */
export function FloatingTabBar<T extends string>({
  sections, active, onSelect, iconOnly, trailing, className,
}: {
  sections: { key: T; label: string; icon: any }[];
  active: T;
  onSelect: (k: T) => void;
  /** Icon-only tabs, label revealed only for the active one. */
  iconOnly?: boolean;
  /** Extra control on the right of the bar (e.g. a close button). */
  trailing?: React.ReactNode;
  /** Override positioning/width (e.g. to reserve space for a close button). */
  className?: string;
}) {
  return (
    <nav className={cn("absolute left-1/2 top-3 z-10 flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-background/95 px-1.5 py-1 shadow-md backdrop-blur", className)}>
      {sections.map((s) => {
        const Icon = s.icon;
        const on = s.key === active;
        return (
          <button
            key={s.key}
            onClick={() => onSelect(s.key)}
            title={iconOnly && !on ? s.label : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs transition-colors",
              on ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground hover:bg-muted",
            )}
          >
            <Icon className="h-4 w-4" /> {(!iconOnly || on) && s.label}
          </button>
        );
      })}
      {trailing}
    </nav>
  );
}
