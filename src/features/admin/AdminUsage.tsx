import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useEntitlements } from "@/hooks/useEntitlements";
import { fetchUsageBreakdown, formatCredits } from "@/lib/billing";
import { CreditsSummary, CreditsExplainer } from "@/features/admin/billing/parts";
import { cn } from "@/lib/utils";

type Dimension = "provider" | "feature" | "agent" | "sku";

const DIMENSIONS: Array<{ key: Dimension; label: string }> = [
  { key: "provider", label: "Fournisseur" },
  { key: "feature", label: "Fonctionnalité" },
  { key: "agent", label: "Agent" },
  { key: "sku", label: "Modèle" },
];

const RANGES = [7, 30, 90];

/** ABONNEMENTS › Consommation — où partent les crédits. Répond à la seule
 *  question que se pose un client dont le solde descend : « à cause de quoi ? ». */
export function AdminUsagePage() {
  const { workspaceId } = useCurrentContext();
  const { entitlements: ent } = useEntitlements();
  const [dimension, setDimension] = useState<Dimension>("provider");
  const [days, setDays] = useState(30);

  const breakdown = useQuery({
    queryKey: ["usage-breakdown", workspaceId, dimension, days],
    enabled: !!workspaceId,
    queryFn: () => fetchUsageBreakdown(workspaceId!, dimension, days),
  });

  // Les agents sont identifiés par uuid dans le journal : sans ce mapping la
  // ventilation « par agent » affiche des identifiants illisibles.
  const agents = useQuery({
    queryKey: ["agent-names", workspaceId],
    enabled: !!workspaceId && dimension === "agent",
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents").select("id, name").eq("workspace_id", workspaceId!);
      return Object.fromEntries((data ?? []).map((a) => [a.id, a.name])) as Record<string, string>;
    },
  });

  const rows = breakdown.data ?? [];
  const total = useMemo(() => rows.reduce((n, r) => n + Number(r.credits), 0), [rows]);

  const labelOf = (raw: string) =>
    dimension === "agent" ? (agents.data?.[raw] ?? "Agent supprimé") : raw;

  return (
    <div>
      <PageHeader
        title="Consommation"
        description="Ce que vos agents dépensent réellement, et sur quoi."
      />

      {ent && (
        <Card className="mb-4">
          <CardContent className="p-5">
            <CreditsSummary ent={ent} />
            <CreditsExplainer className="mt-4" />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1">
              {DIMENSIONS.map((d) => (
                <Button
                  key={d.key}
                  size="sm"
                  variant={dimension === d.key ? "secondary" : "ghost"}
                  onClick={() => setDimension(d.key)}
                >
                  {d.label}
                </Button>
              ))}
            </div>
            <div className="flex gap-1">
              {RANGES.map((r) => (
                <Button
                  key={r}
                  size="sm"
                  variant={days === r ? "secondary" : "ghost"}
                  onClick={() => setDays(r)}
                >
                  {r} j
                </Button>
              ))}
            </div>
          </div>

          {breakdown.isLoading && (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Calcul…
            </div>
          )}
          {breakdown.error && (
            <p className="py-4 text-sm text-destructive">{(breakdown.error as Error).message}</p>
          )}
          {!breakdown.isLoading && rows.length === 0 && (
            <p className="py-8 text-sm text-muted-foreground">
              Aucune consommation sur la période — vos agents n'ont pas encore travaillé.
            </p>
          )}

          {rows.length > 0 && (
            <div className="space-y-3">
              {rows.map((r) => {
                const share = total > 0 ? (Number(r.credits) / total) * 100 : 0;
                return (
                  <div key={r.label}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm">{labelOf(r.label)}</span>
                      <span className="font-stat-number shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatCredits(Number(r.credits))} cr · {share.toFixed(0)} %
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full bg-primary")}
                        style={{ width: `${Math.max(share, 1)}%` }}
                      />
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {Number(r.events).toLocaleString("fr-FR")} appels ·{" "}
                      {Number(r.quantity).toLocaleString("fr-FR")} unités
                    </div>
                  </div>
                );
              })}
              <div className="border-t pt-3 text-sm">
                <span className="text-muted-foreground">Total sur {days} jours : </span>
                <span className="font-stat-number font-medium tabular-nums">
                  {formatCredits(total)} crédits
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
