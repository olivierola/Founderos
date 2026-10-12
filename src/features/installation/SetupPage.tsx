// Premier démarrage d'une installation (G5) : l'adresse que donnent
// l'installateur et le chart (NOTES.txt). Quatre étapes, chacune lue en direct :
//   1. le compte administrateur (la personne connectée) ;
//   2. l'installation rattachée (INSTALLATION_ADMINS, ou revendication sur une instance neuve) ;
//   3. le diagnostic de chaque brique (Administration → Installation) ;
//   4. le SSO de l'entreprise, puis le premier agent.
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircleIcon as Done, CircleIcon as Todo, CircleNotchIcon as Loader2, WarningIcon as Warn } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { callEdge } from "@/lib/edge";
import { supabase } from "@/lib/supabase";
import { useWorkspaces } from "@/hooks/useWorkspace";
import { fetchStatus as fetchSsoStatus, listProviders } from "@/features/sso/api";

interface InstallStatus { is_admin: boolean; can_claim: boolean; via: string | null }
interface Check { id: string; label: string; status: "ok" | "warn" | "error" | "skipped"; detail: string; fix?: string }

export function SetupPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: memberships } = useWorkspaces();
  // L'organisation que la personne administre (la seule, sur une instance neuve).
  const ws = (memberships ?? []).find((m) => m.role === "owner" || m.role === "admin");
  const { data: project } = useQuery({
    queryKey: ["setup-project", ws?.workspace_id],
    enabled: !!ws,
    queryFn: async () => (await supabase.from("projects").select("slug").eq("workspace_id", ws!.workspace_id).order("created_at").limit(1).maybeSingle()).data as { slug: string } | null,
  });
  const base = ws && project ? `/app/${ws.workspaces.slug}/${project.slug}` : null;

  const install = useQuery({
    queryKey: ["installation-admin"],
    queryFn: () => callEdge<InstallStatus>("installation-admin", { action: "status" }),
    retry: false,
  });
  const sso = useQuery({
    queryKey: ["setup-sso", ws?.workspace_id],
    enabled: !!ws,
    queryFn: async () => {
      const [status, providers] = await Promise.all([fetchSsoStatus(ws!.workspace_id).catch(() => null), listProviders(ws!.workspace_id).catch(() => [])]);
      return { status, providers: providers.filter((p) => p.enabled).length };
    },
  });
  const agents = useQuery({
    queryKey: ["setup-agents", ws?.workspace_id],
    enabled: !!ws,
    queryFn: async () => (await supabase.from("internal_agents").select("id", { count: "exact", head: true }).eq("workspace_id", ws!.workspace_id)).count ?? 0,
  });

  const [checks, setChecks] = useState<Check[] | null>(null);
  const [running, setRunning] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  async function diagnose() {
    if (!ws) return;
    setRunning(true);
    try {
      setChecks((await callEdge<{ checks: Check[] }>("installation-admin", { action: "diagnose", workspace_id: ws.workspace_id })).checks);
    } finally {
      setRunning(false);
    }
  }
  async function claim() {
    setClaimError(null);
    try {
      await callEdge("installation-admin", { action: "claim", workspace_id: ws?.workspace_id });
      await queryClient.invalidateQueries({ queryKey: ["installation-admin"] });
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : String(e));
    }
  }
  // Le diagnostic se lance de lui-même dès que la personne administre.
  useEffect(() => {
    if (install.data?.is_admin && ws && !checks && !running) void diagnose();
  }, [install.data?.is_admin, ws?.workspace_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const errors = (checks ?? []).filter((c) => c.status === "error");
  const ssoDone = (sso.data?.providers ?? 0) > 0;

  return (
    <div className="min-h-screen bg-background px-6 py-12">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">Premier démarrage</h1>
        <p className="mt-1 text-sm text-muted-foreground">Quatre étapes pour une installation prête : elles se cochent d'elles-mêmes.</p>

        <ol className="mt-8 space-y-4">
          <Step done title="Compte administrateur">
            Connecté en tant que <span className="font-medium text-foreground">{user?.email}</span>.
          </Step>

          <Step
            done={!!install.data?.is_admin}
            warn={install.isError}
            title="Installation rattachée"
          >
            {install.isLoading ? <Loader2 className="h-4 w-4 animate-spin" />
              : install.isError ? "Le backend de l'installation ne répond pas (VITE_API_URL, ou FOUNDEROS_API_URL dans l'image de l'interface)."
              : install.data?.is_admin ? `Vous administrez l'installation (${install.data.via}).`
              : install.data?.can_claim ? (
                <span className="block space-y-2">
                  <span className="block">Instance neuve : rattachez-la à votre organisation pour la régler.</span>
                  <Button size="sm" onClick={claim}>Rattacher l'installation</Button>
                  {claimError && <span className="block text-destructive">{claimError}</span>}
                </span>
              ) : "Réservé aux administrateurs de l'installation (INSTALLATION_ADMINS, ou l'organisation propriétaire)."}
          </Step>

          <Step done={!!checks && errors.length === 0} warn={errors.length > 0} title="Diagnostic des briques">
            {!install.data?.is_admin ? "Après le rattachement."
              : running ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Base, chiffrement, signature, passerelle LLM, SSO, relais, serveurs MCP…</span>
              : checks ? (
                <span className="block space-y-1">
                  <span className="block">{checks.filter((c) => c.status === "ok").length} en ordre, {checks.filter((c) => c.status === "warn").length} à voir, {errors.length} en panne.</span>
                  {errors.map((c) => <span key={c.id} className="block text-destructive">{c.label} : {c.detail}{c.fix ? ` → ${c.fix}` : ""}</span>)}
                  <span className="flex gap-3 pt-1">
                    <button type="button" onClick={diagnose} className="text-primary hover:underline">Relancer</button>
                    {base && <Link to={`${base}/admin/installation`} className="text-primary hover:underline">Réglages de l'installation</Link>}
                  </span>
                </span>
              ) : <button type="button" onClick={diagnose} className="text-primary hover:underline">Lancer le diagnostic</button>}
          </Step>

          <Step done={ssoDone} title="SSO de l'entreprise">
            {ssoDone ? `${sso.data!.providers} fournisseur(s) actif(s).`
              : sso.data?.status && !sso.data.status.enabled ? "Le SSO est fermé sur cette installation (SSO_MODE)."
              : <span>Entra ID, Keycloak ou SAML : <Link to="/sso-setup" className="text-primary hover:underline">configurer le SSO</Link>. Facultatif : le mot de passe reste possible.</span>}
          </Step>

          <Step done={(agents.data ?? 0) > 0} title="Premier agent">
            {(agents.data ?? 0) > 0 ? `${agents.data} agent(s) dans l'organisation.`
              : base ? <span><Link to={`${base}/agent/agents`} className="text-primary hover:underline">Créer le premier agent</Link>, puis ses serveurs MCP et outils internes.</span>
              : "Après la création de votre organisation."}
          </Step>
        </ol>

        {base && (
          <div className="mt-10">
            <Link to={base}><Button>Ouvrir FounderOS</Button></Link>
          </div>
        )}
      </div>
    </div>
  );
}

function Step({ done = false, warn = false, title, children }: { done?: boolean; warn?: boolean; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 rounded-xl border border-border p-4">
      <span className="pt-0.5">
        {done ? <Done weight="fill" className="h-5 w-5 text-emerald-600" /> : warn ? <Warn className="h-5 w-5 text-amber-500" /> : <Todo className="h-5 w-5 text-muted-foreground" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}
