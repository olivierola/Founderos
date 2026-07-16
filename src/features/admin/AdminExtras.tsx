import { Link, useParams } from "react-router-dom";
import { Check, CreditCard } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

// Plan catalogue — mirrors the Billing page so the two views agree.
const PLANS = [
  { id: "free", name: "Free", price: "0 €", requests: "1 k", seats: "1", desc: "1 projet, 1 dépôt, scans manuels." },
  { id: "starter", name: "Starter", price: "29 €/mo", requests: "25 k", seats: "3", desc: "2 projets, 3 dépôts, scans hebdo." },
  { id: "pro", name: "Pro", price: "99 €/mo", requests: "250 k", seats: "10", desc: "5 projets, 15 dépôts, scans auto, agents IA." },
  { id: "team", name: "Team", price: "299 €/mo", requests: "1 M", seats: "Illimité", desc: "Multi-équipe, audit avancé, runbooks." },
] as const;

function planIndex(plan: string) {
  const i = PLANS.findIndex((p) => p.id === plan);
  return i < 0 ? 0 : i;
}

/** ABONNEMENTS › Abonnements — the current plan + entitlements. Facturation
 *  (checkout / invoices) lives in the sibling Billing tab. */
export function AdminSubscriptionPage() {
  const { workspace } = useCurrentContext();
  const { workspaceSlug, projectSlug } = useParams();
  const base = `/app/${workspaceSlug}/${projectSlug}`;
  const plan = ((workspace as any)?.plan ?? "free") as string;
  const current = PLANS[planIndex(plan)];

  return (
    <div>
      <PageHeader
        title="Abonnements"
        description="Votre offre actuelle et ce qu'elle inclut."
        actions={
          <Button asChild size="sm">
            <Link to={`${base}/admin/billing`}>
              <CreditCard className="h-4 w-4" /> Gérer la facturation
            </Link>
          </Button>
        }
      />

      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">Offre {current.name}</span>
              <Badge variant={plan === "free" ? "outline" : "default"} className="capitalize">{plan}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{current.desc}</p>
          </div>
          <div className="text-right">
            <div className="font-stat-number text-2xl font-semibold">{current.price}</div>
            <div className="text-xs text-muted-foreground">{current.requests} requêtes API / mois · {current.seats} sièges</div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {PLANS.map((p, i) => {
          const isCurrent = p.id === plan;
          return (
            <Card key={p.id} className={cn(isCurrent && "ring-1 ring-primary")}>
              <CardContent className="flex h-full flex-col p-5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{p.name}</span>
                  {isCurrent && <Badge variant="secondary">Actuel</Badge>}
                </div>
                <div className="font-stat-number mt-2 text-xl font-semibold">{p.price}</div>
                <p className="mt-2 flex-1 text-xs text-muted-foreground">{p.desc}</p>
                <Button
                  asChild
                  size="sm"
                  variant={isCurrent ? "outline" : i > planIndex(plan) ? "default" : "outline"}
                  className="mt-3"
                  disabled={isCurrent}
                >
                  <Link to={`${base}/admin/billing`}>
                    {isCurrent ? <><Check className="h-4 w-4" /> Sélectionné</> : i > planIndex(plan) ? "Passer à cette offre" : "Choisir"}
                  </Link>
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
