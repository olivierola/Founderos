import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/* Shared agent card — one shell for the AI Workforce list, the public-agents
   grid and the Agents tab of a service dashboard, so the three stop drifting.

   Anatomy (measured from the reference): a raised top zone holding the agent's
   identity centred, then a body with name, one-line description and a row of
   capability chips tinted with their own colour, plus optional square icon
   actions and dim meta text pushed to the right. Corners stay tight (the app's
   own --radius) rather than the pill-ish 2xl the old cards used. */

export type AgentChip = {
  icon: LucideIcon;
  label: string;
  /** Any CSS colour; the chip tints its background from it. */
  color: string;
  title?: string;
};

/* Chip palette, lifted from the reference so the set reads as one family. */
export const CHIP_COLORS = {
  chat: "#8d9af7",
  missions: "#67b382",
  sources: "#76c3eb",
  studio: "#ddb44d",
  alert: "#c4375c",
  accent: "hsl(var(--primary-soft))",
} as const;

export function AgentCard({
  identity,
  name,
  description,
  chips = [],
  actions,
  meta,
  onClick,
  className,
}: {
  /** Rendered centred in the top zone — an avatar, orb or logo. */
  identity: ReactNode;
  name: string;
  description?: string | null;
  chips?: AgentChip[];
  /** Square bordered icon buttons sitting after the chips. */
  actions?: ReactNode;
  /** Dim text pinned to the right of the chip row (counts, status…). */
  meta?: ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "group flex flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-card transition-colors",
        onClick && "cursor-pointer hover:border-foreground/20",
        className,
      )}
    >
      {/* Top zone — raised surface, identity centred */}
      <div className="flex h-[120px] shrink-0 items-center justify-center bg-secondary/60">{identity}</div>

      {/* Body */}
      <div className="flex flex-1 flex-col p-4">
        <h3 className="truncate text-[15px] font-bold leading-tight">{name}</h3>
        <p className="mt-1.5 truncate text-[13px] leading-snug text-muted-foreground">
          {description || "No description"}
        </p>

        <div className="mt-auto flex items-center gap-2 pt-4">
          {chips.map((c) => {
            const Icon = c.icon;
            return (
              <span
                key={c.label}
                title={c.title ?? c.label}
                className="agent-chip inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium"
                style={{ ["--chip" as string]: c.color }}
              >
                <Icon className="h-3 w-3" />
                {c.label}
              </span>
            );
          })}
          {actions}
          {meta && (
            <span className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground/70">{meta}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/* Square bordered icon button matching the small chip in the reference row. */
export function AgentCardAction({
  icon: Icon,
  title,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="flex h-6 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
