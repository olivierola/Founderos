import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";

/**
 * Cible de redirection de Stripe. Stripe ne connaît que l'uuid du workspace ;
 * cette page retrouve les slugs et renvoie vers l'onglet Facturation, qui
 * applique l'achat. Un seul endroit confirme le paiement — dupliquer l'appel
 * ici risquerait de créditer un pack deux fois.
 */
export function BillingSuccessPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  const workspaceId = params.get("ws");
  const sessionId = params.get("session_id");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!workspaceId) { navigate("/app", { replace: true }); return; }
      const { data: ws } = await supabase
        .from("workspaces").select("slug").eq("id", workspaceId).maybeSingle();
      const { data: proj } = await supabase
        .from("projects").select("slug").eq("workspace_id", workspaceId)
        .order("created_at").limit(1).maybeSingle();
      if (cancelled) return;
      if (!ws?.slug || !proj?.slug) {
        setError("Paiement enregistré, mais l'espace de travail n'a pas pu être retrouvé.");
        return;
      }
      const qs = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
      navigate(`/app/${ws.slug}/${proj.slug}/admin/billing${qs}`, { replace: true });
    })();
    return () => { cancelled = true; };
  }, [workspaceId, sessionId, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      {error ? (
        <p className="max-w-md text-center text-sm text-destructive">{error}</p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Paiement confirmé — retour à votre espace…
        </p>
      )}
    </div>
  );
}
