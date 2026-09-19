import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowUpRightIcon as ArrowUpRight } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEntitlements } from "@/hooks/useEntitlements";
import { useToast } from "@/components/ToastProvider";
import { formatCredits, usageTone } from "@/lib/billing";

// The workspace's credit consumption for the current period, in the sidebar.
//
// It used to be fed hard-coded values (1 %, « réinitialisé dans 20 jours ») —
// a meter that lies. It now reads billing_entitlements (same source as the
// Admin → Utilisation screen), turns amber at 80 % and red at 100 %, and says
// so ONCE per period and threshold with a toast: a quota you only discover
// when a run gets blocked is the worst way to meet it.

// Coral→amber wash reused for the upgrade chip so it reads as an upsell.
const PAY_GRADIENT = "linear-gradient(105deg, hsl(var(--primary)) 0%, #F59E0B 55%, #FBBF24 100%)";

const TONE_BAR: Record<"ok" | "warn" | "over", string> = {
  ok: "bg-primary",
  warn: "bg-amber-500",
  over: "bg-destructive",
};

function daysUntil(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 86_400_000)) : null;
}

export function UsageMeter({ expanded }: {
  /** Sidebar width state — drives the compact (rail) vs. full card layout. */
  expanded: boolean;
}) {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { entitlements: ent, workspaceId } = useEntitlements();
  const toast = useToast();

  const credits = ent?.credits;
  const included = credits?.included ?? 0;
  const used = credits?.used ?? 0;
  const pct = included > 0 ? Math.min(100, Math.round((used / included) * 100)) : 0;
  const tone = usageTone(used, included > 0 ? included : -1);
  const resetDays = daysUntil(ent?.subscription.period_end);
  const blocked = !!ent?.subscription.hard_blocked;

  // One toast per period and threshold (80 %, 100 %), remembered locally so
  // it does not come back on every page load.
  const periodStart = ent?.subscription.period_start;
  useEffect(() => {
    if (!workspaceId || !periodStart || included <= 0) return;
    const threshold = pct >= 100 ? 100 : pct >= 80 ? 80 : 0;
    if (!threshold) return;
    const key = `fos-quota-alert:${workspaceId}:${periodStart}:${threshold}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch { /* private mode: at worst the toast repeats */ }
    if (threshold === 100) {
      toast.error(
        "Crédits du mois épuisés",
        ent?.subscription.overage_enabled
          ? "Le dépassement est activé : vos agents continuent, facturés à l'usage."
          : "Vos agents sont en pause jusqu'au renouvellement — rechargez ou changez d'offre.",
      );
    } else {
      toast.info("80 % de vos crédits consommés", `Il reste ${formatCredits(credits?.remaining ?? 0)} crédits jusqu'au renouvellement.`);
    }
  }, [workspaceId, periodStart, pct, included, toast, ent?.subscription.overage_enabled, credits?.remaining]);

  const base = workspaceSlug && projectSlug ? `/app/${workspaceSlug}/${projectSlug}/admin` : null;
  const openLimits = () => { if (base) navigate(`${base}/usage`); };
  const openPlans = () => { if (base) navigate(`${base}/subscription`); };

  if (!ent) return null;

  const resetLabel = resetDays == null ? null : resetDays === 0 ? "Renouvelé aujourd'hui" : `Réinitialisé dans ${resetDays} jour${resetDays > 1 ? "s" : ""}`;

  // Collapsed rail: a slim vertical gauge with the % on hover.
  if (!expanded) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={openLimits}
            aria-label={`Crédits consommés ${pct} % — limites`}
            className="mx-auto flex h-10 w-10 flex-col items-center justify-center gap-1 rounded-lg text-foreground/60 transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
          >
            <span className={cn("text-[11px] font-semibold leading-none tabular-nums", tone !== "ok" && "text-foreground")}>{pct}%</span>
            <span className="h-1 w-6 overflow-hidden rounded-full bg-muted-foreground/20">
              <span className={cn("block h-full rounded-full", TONE_BAR[tone])} style={{ width: `${pct}%` }} />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {formatCredits(used)} / {formatCredits(included)} crédits{resetLabel ? ` · ${resetLabel.toLowerCase()}` : ""}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-sidebar-accent/25">
      <div className="px-3 pt-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold tabular-nums">
            {pct}%
            <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
              {formatCredits(used)} / {formatCredits(included)} crédits
            </span>
          </span>
          <button
            onClick={openLimits}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Limites
            <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/15">
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", TONE_BAR[tone])}
            style={{ width: `${Math.max(pct, 2)}%` }}
          />
        </div>

        <p className={cn("mb-3 mt-2 text-xs", blocked ? "font-medium text-destructive" : tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
          {blocked
            ? "Agents en pause — quota atteint"
            : tone === "warn"
              ? `Plus que ${formatCredits(credits?.remaining ?? 0)} crédits`
              : resetLabel}
        </p>
      </div>

      {/* Upgrade path — the natural moment to offer it is when the gauge fills. */}
      <button
        onClick={openPlans}
        className="flex w-full items-center justify-between gap-3 border-t border-border px-3 py-2.5 text-left transition-colors hover:bg-sidebar-accent/60"
      >
        <span className="text-sm font-semibold text-foreground">
          {tone === "ok" ? `Offre ${ent.plan.name}` : "Recharger ou changer d'offre"}
        </span>
        <span className="h-5 w-8 shrink-0 rounded-md" style={{ backgroundImage: PAY_GRADIENT }} aria-hidden />
      </button>
    </div>
  );
}
