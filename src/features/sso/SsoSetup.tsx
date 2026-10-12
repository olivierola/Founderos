import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CircleNotchIcon as Loader2, IdentificationBadgeIcon } from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { useWorkspaces, type WorkspaceMembership } from "@/hooks/useWorkspace";

/**
 * Cible du lien « Set up SSO » de la page de connexion.
 *
 * Le SSO d'une organisation se configure dans Administration → Authentification,
 * qui vit sous un projet (/app/<org>/<projet>/admin/sso). Cette page retrouve
 * les organisations où la personne est propriétaire ou admin — les seuls rôles
 * que sso-admin accepte — et l'y envoie : directement s'il n'y en a qu'une, au
 * choix sinon.
 */
export function SsoSetupPage() {
  const navigate = useNavigate();
  const { data: memberships, isLoading } = useWorkspaces();
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const admins = (memberships ?? []).filter((m) => m.role === "owner" || m.role === "admin");

  async function open(m: WorkspaceMembership) {
    setOpening(m.workspace_id);
    setError(null);
    const { data: proj } = await supabase
      .from("projects").select("slug").eq("workspace_id", m.workspace_id)
      .order("created_at").limit(1).maybeSingle();
    if (!proj?.slug || !m.workspaces?.slug) {
      setOpening(null);
      setError(`« ${m.workspaces?.name ?? "Cette organisation"} » n'a pas encore de projet : créez-en un, puis revenez ici.`);
      return;
    }
    navigate(`/app/${m.workspaces.slug}/${proj.slug}/admin/sso`, { replace: true });
  }

  // Une seule organisation administrée : pas de choix à faire.
  const only = !isLoading && admins.length === 1 ? admins[0] : null;
  useEffect(() => {
    if (only) void open(only);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [only?.workspace_id]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6">
        <div className="mb-4 flex items-center gap-2.5">
          <IdentificationBadgeIcon className="size-5 text-primary" />
          <h1 className="text-[15px] font-semibold">SSO de l'entreprise</h1>
        </div>

        {isLoading || (only && !error) ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Ouverture des réglages d'authentification…
          </p>
        ) : admins.length === 0 ? (
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Seuls les propriétaires et les administrateurs d'une organisation configurent son SSO. Demandez-le à l'un
              d'eux, ou créez votre organisation.
            </p>
            <Link to="/orgs" className="font-medium text-primary hover:underline">Mes organisations</Link>
          </div>
        ) : (
          <div className="space-y-2">
            {admins.length > 1 && (
              <p className="mb-3 text-sm text-muted-foreground">Pour quelle organisation ?</p>
            )}
            {admins.length > 1 && admins.map((m) => (
              <button
                key={m.workspace_id}
                type="button"
                disabled={!!opening}
                onClick={() => void open(m)}
                className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2.5 text-left text-sm hover:bg-secondary disabled:opacity-60"
              >
                <span className="font-medium">{m.workspaces?.name ?? m.workspace_id}</span>
                {opening === m.workspace_id
                  ? <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  : <span className="text-[11px] text-muted-foreground">{m.role === "owner" ? "Propriétaire" : "Admin"}</span>}
              </button>
            ))}
          </div>
        )}

        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
