import { Link, useParams } from "react-router-dom";
import { Check, CreditCard, Loader2, Minus } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useEntitlements, usePlans } from "@/hooks/useEntitlements";
import {
  formatCredits, formatPrice, formatLimit,
  FEATURE_LABELS, RESOURCE_ORDER, type BillingPlan,
} from "@/lib/billing";
import { CreditsSummary, CreditsExplainer, UsageBar } from "@/features/admin/billing/parts";
import { cn } from "@/lib/utils";

/** Les limites mises en avant sur une carte d'offre : ce qui décide d'un achat.
 *  Le détail complet reste dans le tableau de consommation ci-dessous. */
const HEADLINE_LIMITS: Array<[string, string]> = [
  ["services", "services"],
  ["agents", "agents"],
  ["seats", "sièges"],
  ["storage_mb", "de stockage"],
];

function PlanCard({
  plan, current, rank, currentRank, base,
}: {
  plan: BillingPlan;
  current: boolean;
  rank: number;
  currentRank: number;
  base: string;
}) {
  return (
    <Card className={cn("h-full", current && "ring-1 ring-primary")}>
      <CardContent className="flex h-full flex-col p-5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{plan.name}</span>
          {current && <Badge variant="secondary">Actuel</Badge>}
        </div>

        <div className="font-stat-number mt-2 text-2xl font-semibold">
          {plan.is_quote ? "Sur devis" : formatPrice(plan.price_cents_eur)}
          {!plan.is_quote && plan.price_cents_eur > 0 && (
            <span className="text-sm font-normal text-muted-foreground"> /mois</span>
          )}
        </div>
        <p className="mt-1 min-h-[32px] text-xs text-muted-foreground">{plan.tagline}</p>

        <div className="mt-3 border-t pt-3">
          <div className="font-stat-number text-sm font-medium">
            {formatCredits(plan.included_credits)} crédits<span className="font-normal text-muted-foreground"> /mois</span>
          </div>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {HEADLINE_LIMITS.map(([key, suffix]) => (
              <li key={key} className="flex items-center gap-1.5">
                <Check className="h-3 w-3 shrink-0 text-primary" />
                <span>
                  {formatLimit(key, plan.limits?.[key] ?? 0)} {suffix}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <Button
          asChild={!current}
          size="sm"
          variant={current ? "outline" : rank > currentRank ? "default" : "outline"}
          className="mt-4"
          disabled={current}
        >
          {current ? (
            <span><Check className="h-4 w-4" /> Offre actuelle</span>
          ) : (
            <Link to={`${base}/admin/billing`}>
              {plan.is_quote ? "Nous contacter" : rank > currentRank ? "Passer à cette offre" : "Choisir"}
            </Link>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

/** ABONNEMENTS › Abonnements — l'offre en cours, ce qu'elle autorise, et où on
 *  en est. Le paiement lui-même vit dans l'onglet Facturation. */
export function AdminSubscriptionPage() {
  const { workspaceSlug, projectSlug } = useParams();
  const base = `/app/${workspaceSlug}/${projectSlug}`;
  const { entitlements: ent, isLoading, error } = useEntitlements();
  const { data: plans = [] } = usePlans();

  const currentCode = ent?.plan.code ?? "free";
  const currentRank = plans.findIndex((p) => p.code === currentCode);

  return (
    <div>
      <PageHeader
        title="Abonnements"
        description="Votre offre, vos quotas et leur consommation sur la période en cours."
        actions={
          <Button asChild size="sm">
            <Link to={`${base}/admin/billing`}>
              <CreditCard className="h-4 w-4" /> Gérer la facturation
            </Link>
          </Button>
        }
      />

      {isLoading && (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Chargement des droits…
        </div>
      )}
      {error && <p className="mb-4 text-sm text-destructive">{(error as Error).message}</p>}

      {ent && (
        <>
          <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardContent className="p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-semibold">Offre {ent.plan.name}</span>
                    <Badge variant={ent.plan.code === "free" ? "outline" : "default"}>
                      {ent.subscription.status === "active" ? "active" : ent.subscription.status}
                    </Badge>
                  </div>
                  <span className="font-stat-number text-sm text-muted-foreground">
                    {ent.plan.is_quote ? "Sur devis" : `${formatPrice(ent.plan.price_cents_eur)} / mois`}
                  </span>
                </div>
                <CreditsSummary ent={ent} />
                <CreditsExplainer className="mt-4" />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Inclus dans l'offre
                </div>
                <ul className="mt-3 space-y-1.5">
                  {Object.entries(FEATURE_LABELS).map(([key, label]) => {
                    const on = ent.plan.features?.[key] === true;
                    return (
                      <li
                        key={key}
                        className={cn(
                          "flex items-center gap-2 text-xs",
                          on ? "text-foreground" : "text-muted-foreground/60",
                        )}
                      >
                        {on ? (
                          <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                        ) : (
                          <Minus className="h-3.5 w-3.5 shrink-0" />
                        )}
                        {label}
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          </div>

          <Card className="mb-6">
            <CardContent className="p-5">
              <div className="mb-4 text-sm font-medium">Quotas de l'offre</div>
              <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                {RESOURCE_ORDER.filter((k) => ent.resources?.[k]).map((key) => {
                  const r = ent.resources[key];
                  return (
                    <UsageBar
                      key={key}
                      metric={key}
                      label={r.label}
                      used={Number(r.used)}
                      limit={Number(r.limit)}
                    />
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <div className="mb-2 text-sm font-medium">Toutes les offres</div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {plans.map((p, i) => (
          <PlanCard
            key={p.code}
            plan={p}
            current={p.code === currentCode}
            rank={i}
            currentRank={currentRank}
            base={base}
          />
        ))}
      </div>
    </div>
  );
}
