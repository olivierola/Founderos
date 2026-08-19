import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { rememberPlanIntent } from "@/lib/billing";

/**
 * « Get started » → Stripe, sans détour.
 *
 * La grille tarifaire est publique, le paiement ne peut pas l'être : facturer
 * suppose un espace de travail et un propriétaire. Cette page fait la jonction
 * en une seule étape invisible — elle crée la session Checkout et redirige.
 *
 *   visiteur anonyme    → inscription, l'offre choisie est mémorisée
 *   propriétaire        → Stripe Checkout directement
 *   les cas non payables (pas encore propriétaire, offre sans tarif, changement
 *   d'offre appliqué en place) → page Facturation avec le message qui explique
 *
 * On ne renvoie donc vers la page d'abonnement que lorsqu'il y a réellement
 * quelque chose à y lire. Un client qui clique « acheter » veut payer, pas
 * relire la grille qu'il vient de quitter.
 */
export function SubscribeRedirectPage() {
  const { plan: planParam } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);

  const plan = planParam ?? params.get("plan") ?? "";

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!plan) { navigate("/pricing", { replace: true }); return; }

      const { data: session } = await supabase.auth.getSession();
      if (cancelled) return;

      if (!session.session) {
        rememberPlanIntent(plan);
        navigate(`/signup?plan=${encodeURIComponent(plan)}`, { replace: true });
        return;
      }

      // Même résolution que le retour de Stripe (`BillingSuccessPage`) : les URL
      // de l'application sont en slugs, l'API de facturation travaille en uuid.
      //
      // On cherche d'abord un espace dont l'utilisateur est PROPRIÉTAIRE : lui
      // seul peut souscrire. Prendre le plus ancien espace au hasard enverrait
      // un invité d'une autre organisation droit sur un refus incompréhensible.
      const { data: owned } = await supabase
        .from("workspace_members")
        .select("workspace_id, workspaces(id, slug)")
        .eq("user_id", session.session.user.id)
        .eq("role", "owner")
        .limit(1)
        .maybeSingle();
      if (cancelled) return;

      // PostgREST rend la relation tantôt en objet, tantôt en tableau selon la
      // façon dont il infère la cardinalité. On accepte les deux.
      const rel: unknown = owned?.workspaces;
      const ownedWs = ((Array.isArray(rel) ? rel[0] : rel) ?? null) as
        | { id: string; slug: string }
        | null;

      let ws = ownedWs;
      if (!ws?.slug) {
        const { data: anyWs } = await supabase
          .from("workspaces").select("id, slug").order("created_at").limit(1).maybeSingle();
        if (cancelled) return;
        ws = anyWs;
      }
      if (!ws?.slug) {
        // Compte sans espace de travail : rien à facturer tant que l'onboarding
        // n'est pas passé. L'intention survit à l'aller-retour.
        rememberPlanIntent(plan);
        navigate("/orgs", { replace: true });
        return;
      }
      const { data: proj } = await supabase
        .from("projects").select("slug").eq("workspace_id", ws.id)
        .order("created_at").limit(1).maybeSingle();
      if (cancelled) return;

      const billingUrl = proj?.slug
        ? `/app/${ws.slug}/${proj.slug}/admin/billing`
        : null;
      if (!billingUrl) { rememberPlanIntent(plan); navigate("/orgs", { replace: true }); return; }

      try {
        const res = await callEdge<{ url?: string; updated?: boolean; unchanged?: boolean }>(
          "create-checkout", { workspace_id: ws.id, plan },
        );
        if (cancelled) return;

        if (res.url) { window.location.href = res.url; return; }

        // Client déjà abonné : l'abonnement a été modifié en place, il n'y a pas
        // de page de paiement à afficher (le moyen de paiement est déjà connu).
        navigate(`${billingUrl}?changed=${res.updated ? "1" : "0"}`, { replace: true });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        // Offre sur devis, tarif Stripe non configuré, ou membre non
        // propriétaire : le message de l'API est déjà explicite, on l'affiche
        // au lieu de rediriger dans le vide.
        setError(msg);
        setFallback(billingUrl);
      }
    })().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });

    return () => { cancelled = true; };
  }, [plan, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      {error ? (
        <div className="max-w-md text-center">
          <p className="text-sm text-destructive">{error}</p>
          <div className="mt-4 flex justify-center gap-3 text-sm">
            {fallback && (
              <Link to={fallback} className="text-primary underline underline-offset-4">
                Voir les offres
              </Link>
            )}
            <Link to="/pricing" className="text-muted-foreground underline underline-offset-4">
              Retour aux tarifs
            </Link>
          </div>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Ouverture du paiement sécurisé…
        </p>
      )}
    </div>
  );
}
