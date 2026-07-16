import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type UsageMeterProps = {
  /** Whole-workspace consumption for the current period, 0–100. */
  percent?: number;
  /** Days until the quota resets. */
  resetDays?: number;
  /** Sidebar width state — drives the compact (rail) vs. full card layout. */
  expanded: boolean;
  onOpenLimits?: () => void;
  onEnablePayPerUse?: () => void;
};

// Coral→amber wash reused for the pay-per-use chip so it reads as an upsell.
const PAY_GRADIENT = "linear-gradient(105deg, hsl(var(--primary)) 0%, #F59E0B 55%, #FBBF24 100%)";

export function UsageMeter({
  percent = 1,
  resetDays = 20,
  expanded,
  onOpenLimits,
  onEnablePayPerUse,
}: UsageMeterProps) {
  const pct = Math.min(100, Math.max(0, percent));

  // Collapsed rail: a slim vertical gauge with the % on hover.
  if (!expanded) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onOpenLimits}
            aria-label={`Usage ${pct}% — limites`}
            className="mx-auto flex h-10 w-10 flex-col items-center justify-center gap-1 rounded-lg text-foreground/60 transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
          >
            <span className="text-[11px] font-semibold leading-none tabular-nums">{pct}%</span>
            <span className="h-1 w-6 overflow-hidden rounded-full bg-muted-foreground/20">
              <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          Usage {pct}% · réinitialisé dans {resetDays} jours
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-sidebar-accent/25">
      {/* Consumption + jump to the limits screen */}
      <div className="px-3 pt-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold tabular-nums">{pct}%</span>
          <button
            onClick={onOpenLimits}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Limites
            <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/15">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${Math.max(pct, 2)}%` }}
          />
        </div>

        <p className="mb-3 mt-2 text-xs text-muted-foreground">Réinitialisé dans {resetDays} jours</p>
      </div>

      {/* Pay-per-use upsell */}
      <button
        onClick={onEnablePayPerUse}
        className={cn(
          "flex w-full items-center justify-between gap-3 border-t border-border px-3 py-2.5",
          "text-left transition-colors hover:bg-sidebar-accent/60",
        )}
      >
        <span className="text-sm font-semibold text-foreground">Activer Pay-per-use</span>
        <span className="h-5 w-8 shrink-0 rounded-md" style={{ backgroundImage: PAY_GRADIENT }} aria-hidden />
      </button>
    </div>
  );
}
