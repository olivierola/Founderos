import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import {
  useEntitlements, usePlans, useCreditPacks, useInvalidateEntitlements,
} from "@/hooks/useEntitlements";
import {
  formatCredits, formatPrice, formatLimit, consumePlanIntent, CREDITS_PER_EUR,
} from "@/lib/billing";
import { CreditsSummary, CreditsExplainer, SubscriptionNotice } from "@/features/admin/billing/parts";
import { cn } from "@/lib/utils";

const DETAIL_LIMITS: Array<[string, string]> = [
  ["services", "services"],
  ["agents", "agents"],
  ["seats", "sièges"],
  ["storage_mb", "de stockage"],
  ["knowledge_collections", "collections de connaissances"],
  ["projects", "projets"],
];

export function SettingsBillingPage() {
  const { workspaceId } = useCurrentContext();
  const { entitlements: ent } = useEntitlements();
  const { data: plans = [] } = usePlans();
  const { data: packs = [] } = useCreditPacks();
  const invalidate = useInvalidateEntitlements();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();

  // Retour de Stripe. Le webhook signé (migration 0200) applique le même achat
  // côté serveur ; cette confirmation reste utile pour que la page soit juste
  // tout de suite, sans attendre la livraison du webhook. Le premier des deux
  // qui arrive applique, l'autre repart avec `already_applied` — c'est le verrou
  // `billing_checkout_sessions` qui arbitre, pas le hasard de l'ordre.
  const sessionId = params.get("session_id");
  useEffect(() => {
    if (!sessionId || !workspaceId) return;
    let cancelled = false;
    (async () => {
      setBusy("confirm");
      try {
        const res = await callEdge<{ applied?: string; already_applied?: boolean }>("create-checkout", {
          workspace_id: workspaceId, action: "confirm", session_id: sessionId,
        });
        if (cancelled) return;
        setNotice(
          res.applied === "topup" ? "Crédits ajoutés à votre réserve."
            : res.already_applied ? "Paiement déjà pris en compte."
            : "Votre nouvelle offre est active.",
        );
        invalidate(workspaceId);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) {
          setBusy(null);
          params.delete("session_id");
          setParams(params, { replace: true });
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, workspaceId]);

  // Offre choisie sur la grille publique (`/subscribe/:plan`), ou mémorisée
  // avant l'inscription. On la reprend au premier affichage : le visiteur a déjà
  // choisi une fois, lui redemander est le meilleur moyen de le perdre.
  //
  // Le paiement n'est PAS lancé tout seul — l'offre est mise en avant et le
  // bouton attend un clic. Rediriger quelqu'un vers un écran de carte bancaire
  // sans qu'il l'ait demandé sur cette page-ci n'est pas acceptable.
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const planParam = params.get("plan");
  const changedParam = params.get("changed");
  useEffect(() => {
    // `changed` : renvoyé par `/subscribe/:plan` quand le client était déjà
    // abonné — l'offre a été modifiée en place, sans passer par Stripe Checkout
    // (le moyen de paiement était déjà enregistré). Sans ce mot, le client
    // atterrit ici sans savoir si son achat a eu lieu.
    if (changedParam) {
      setNotice(changedParam === "1"
        ? "Votre offre a été mise à jour."
        : "Vous êtes déjà sur cette offre.");
    }
    const wanted = planParam ?? consumePlanIntent();
    if (wanted) setHighlighted(wanted);
    if (planParam || changedParam) {
      params.delete("plan");
      params.delete("changed");
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planParam, changedParam]);

  /** Portail Stripe : carte, factures, résiliation. Ce qu'on y change nous
   *  revient par webhook — inutile de rafraîchir à l'aveugle au retour. */
  async function openPortal() {
    if (!workspaceId) return;
    setBusy("portal");
    setError(null);
    try {
      const res = await callEdge<{ url: string }>("create-checkout", {
        workspace_id: workspaceId, action: "portal",
        return_path: window.location.pathname,
      });
      window.location.href = res.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  async function checkout(body: Record<string, unknown>, key: string) {
    if (!workspaceId) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const res = await callEdge<{ url?: string; updated?: boolean; unchanged?: boolean }>(
        "create-checkout", { workspace_id: workspaceId, ...body },
      );
      // Un client déjà abonné ne repasse pas par Stripe Checkout : son
      // abonnement est modifié en place (moyen de paiement déjà enregistré),
      // donc pas d'URL à suivre — on reste sur la page.
      if (res.updated || res.unchanged) {
        setNotice(res.updated ? "Votre offre a été mise à jour." : "Vous êtes déjà sur cette offre.");
        invalidate(workspaceId);
        setBusy(null);
        return;
      }
      if (!res.url) throw new Error("Stripe n'a pas renvoyé d'URL de paiement.");
      window.location.href = res.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  const currentCode = ent?.plan.code ?? "free";

  return (
    <div>
      <PageHeader
        title="Facturation"
        description="Changer d'offre ou recharger vos crédits IA. Paiement sécurisé par Stripe."
      />

      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      {notice && <p className="mb-3 text-sm text-primary">{notice}</p>}
      {busy === "confirm" && (
        <p className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Validation du paiement…
        </p>
      )}

      {ent && <SubscriptionNotice ent={ent} onManage={openPortal} busy={busy !== null} />}

      {ent && (
        <Card className="mb-6">
          <CardContent className="p-5">
            <CreditsSummary ent={ent} />
            <CreditsExplainer className="mt-4" />
          </CardContent>
        </Card>
      )}

      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Offres</span>
        {ent?.subscription.has_stripe_customer && (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={openPortal}>
            {busy === "portal" && <Loader2 className="h-4 w-4 animate-spin" />}
            Gérer l'abonnement et les factures
          </Button>
        )}
      </div>
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {plans.map((p) => {
          const current = p.code === currentCode;
          const wanted = !current && p.code === highlighted;
          return (
            <Card
              key={p.code}
              className={cn(
                "h-full",
                current && "ring-1 ring-primary",
                wanted && "ring-2 ring-primary shadow-lg",
              )}
            >
              <CardContent className="flex h-full flex-col p-5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{p.name}</span>
                  {current && <Badge>Actuelle</Badge>}
                  {wanted && <Badge variant="secondary">Votre choix</Badge>}
                </div>
                <div className="font-stat-number mt-2 text-2xl font-semibold">
                  {p.is_quote ? "Sur devis" : formatPrice(p.price_cents_eur)}
                  {!p.is_quote && p.price_cents_eur > 0 && (
                    <span className="text-sm font-normal text-muted-foreground"> /mois</span>
                  )}
                </div>
                <p className="mt-1 min-h-[32px] text-xs text-muted-foreground">{p.tagline}</p>

                <div className="mt-3 border-t pt-3 text-xs">
                  <div className="font-stat-number text-sm font-medium">
                    {formatCredits(p.included_credits)} crédits / mois
                  </div>
                  <ul className="mt-2 space-y-1 text-muted-foreground">
                    {DETAIL_LIMITS.map(([key, suffix]) => (
                      <li key={key} className="flex items-center gap-1.5">
                        <Check className="h-3 w-3 shrink-0 text-primary" />
                        {formatLimit(key, p.limits?.[key] ?? 0)} {suffix}
                      </li>
                    ))}
                    {p.extra_seat_cents_eur > 0 && (
                      <li className="pt-1">Siège supplémentaire : {formatPrice(p.extra_seat_cents_eur)} /mois</li>
                    )}
                  </ul>
                </div>

                <Button
                  size="sm"
                  className="mt-4"
                  variant={current ? "outline" : "default"}
                  disabled={current || busy !== null}
                  onClick={() =>
                    p.is_quote
                      ? (window.location.href = "mailto:contact@anduran.ai?subject=Offre Enterprise")
                      : checkout({ plan: p.code }, p.code)
                  }
                >
                  {busy === p.code && <Loader2 className="h-4 w-4 animate-spin" />}
                  {current ? "Offre actuelle" : p.is_quote ? "Nous contacter" : "Choisir cette offre"}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mb-2 text-sm font-medium">Packs de crédits</div>
      <p className="mb-3 text-xs text-muted-foreground">
        Achat ponctuel, sans changer d'offre. Ces crédits n'expirent pas à la fin
        de la période : ils sont utilisés une fois l'allocation mensuelle épuisée.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {packs.map((pk) => (
          <Card key={pk.code}>
            <CardContent className="flex items-center justify-between gap-4 p-5">
              <div>
                <div className="font-stat-number text-lg font-semibold">
                  {formatCredits(pk.credits)} crédits
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatPrice(pk.price_cents_eur)} ·{" "}
                  {(pk.price_cents_eur / 100 / (pk.credits / CREDITS_PER_EUR)).toFixed(2)} € pour 1 000
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => checkout({ pack: pk.code }, pk.code)}
              >
                {busy === pk.code && <Loader2 className="h-4 w-4 animate-spin" />}
                Acheter
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Les prix sont hors taxes. Si aucun tarif Stripe n'est configuré côté
        serveur, l'achat renvoie un message explicite plutôt qu'une erreur muette.
      </p>
    </div>
  );
}
