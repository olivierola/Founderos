// Les relais : le pont sortant entre vos outils internes et FounderOS.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  PlusIcon as Plus, ArrowsClockwiseIcon as Rotate, ProhibitIcon as Ban, CopyIcon as Copy, CheckIcon as Check,
  HardDrivesIcon as Server, CircleIcon as Dot,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { useToast } from "@/components/ToastProvider";
import { useConfirm, usePromptText } from "@/components/ConfirmProvider";
import { cn } from "@/lib/utils";
import { type ConnectorRelay, connectorAction, qk, relayOnline, relativeTime } from "./api";
import { Pill, Segmented } from "./ui";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

function installSnippets(token: string): Record<"docker" | "helm" | "env", string> {
  return {
    docker: [
      "docker run -d --name founderos-relay --restart unless-stopped \\",
      `  -e FOUNDEROS_URL=${SUPABASE_URL} \\`,
      `  -e RELAY_TOKEN=${token} \\`,
      "  -e RELAY_ALLOWED_HOSTS=\"argocd.interne.exemple,vault.interne.exemple:8200\" \\",
      "  founderos/connector-relay:0.1.0",
    ].join("\n"),
    helm: [
      "helm install founderos-relay ./connector-relay/helm/connector-relay -n founderos --create-namespace \\",
      `  --set founderosUrl=${SUPABASE_URL} \\`,
      `  --set relayToken=${token} \\`,
      "  --set-string allowedHosts=\"argocd-server.argocd.svc.cluster.local\\,*.monitoring.svc.cluster.local\" \\",
      "  --set-string allowedBinaries=\"helm\"",
    ].join("\n"),
    env: [
      `FOUNDEROS_URL=${SUPABASE_URL}`,
      `RELAY_TOKEN=${token}`,
      "RELAY_ALLOWED_HOSTS=argocd.interne.exemple,vault.interne.exemple:8200",
      "RELAY_ALLOWED_BINARIES=",
    ].join("\n"),
  };
}

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted/50 p-3 pr-10 font-mono text-[11px] leading-relaxed">{text}</pre>
      <button
        type="button"
        onClick={async () => { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
        aria-label="Copier"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function TokenReveal({ name, token, onClose }: { name: string; token: string; onClose: () => void }) {
  const [tab, setTab] = useState<"docker" | "helm" | "env">("docker");
  const snippets = installSnippets(token);
  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/40" />
      <div className="fixed left-1/2 top-1/2 z-[60] w-[min(680px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card shadow-2xl">
        <div className="border-b border-border px-5 py-3.5">
          <h3 className="text-sm font-semibold">Relais « {name} » : son jeton</h3>
          <p className="text-[11px] text-muted-foreground">Copiez-le maintenant : il ne sera plus jamais affiché. Seule son empreinte est conservée.</p>
        </div>
        <div className="space-y-4 px-5 py-4">
          <CopyBlock text={token} />
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Déployer dans votre réseau</span>
              <Segmented size="sm" value={tab} onChange={setTab} options={[
                { value: "docker", label: "Docker" }, { value: "helm", label: "Kubernetes (Helm)" }, { value: "env", label: "Fichier .env" },
              ]} />
            </div>
            <CopyBlock text={snippets[tab]} />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Le relais ne fait que des appels sortants en HTTPS : aucun port à ouvrir. RELAY_ALLOWED_HOSTS est sa liste blanche, appliquée chez vous :
              vide, il refuse tout. Le code, le Dockerfile et le chart sont dans le dossier connector-relay du dépôt.
            </p>
          </div>
        </div>
        <div className="flex justify-end border-t border-border px-5 py-3">
          <Button size="sm" onClick={onClose}>J'ai copié le jeton</Button>
        </div>
      </div>
    </>
  );
}

export function RelaysPanel({ relays, workspaceId, projectId, canEdit }: {
  relays: ConnectorRelay[];
  workspaceId: string | null;
  projectId: string | null;
  canEdit: boolean;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const promptText = usePromptText();
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState<{ name: string; token: string } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.relays(projectId) });

  async function create() {
    const name = await promptText({ title: "Nouveau relais", label: "Nom", placeholder: "cluster-prod, datacenter-paris…", confirmText: "Créer" });
    if (!name?.trim()) return;
    try {
      const r = await connectorAction<{ ok: boolean; token: string }>({ mode: "relay.create", workspace_id: workspaceId, project_id: projectId, name: name.trim() });
      setRevealed({ name: name.trim(), token: r.token });
      refresh();
    } catch (e) {
      toast.error("Création impossible", e instanceof Error ? e.message : String(e));
    }
  }

  async function rotate(r: ConnectorRelay) {
    if (!(await confirm({
      title: `Nouveau jeton pour « ${r.name} » ?`,
      description: "L'ancien jeton cesse de fonctionner tout de suite : le relais s'arrêtera jusqu'à ce que vous le redéployiez avec le nouveau.",
      confirmText: "Renouveler",
    }))) return;
    try {
      const out = await connectorAction<{ ok: boolean; token: string }>({ mode: "relay.rotate", relay_id: r.id });
      setRevealed({ name: r.name, token: out.token });
      refresh();
    } catch (e) {
      toast.error("Renouvellement impossible", e instanceof Error ? e.message : String(e));
    }
  }

  async function revoke(r: ConnectorRelay) {
    if (!(await confirm({
      title: `Révoquer « ${r.name} » ?`,
      description: "Le relais est refusé à son prochain contact et s'arrête. Les outils qui passent par lui deviennent injoignables.",
      confirmText: "Révoquer",
    }))) return;
    await toast.run(() => connectorAction({ mode: "relay.revoke", relay_id: r.id }), {
      loading: "Révocation…", success: "Relais révoqué", error: (e) => (e instanceof Error ? e.message : "Échec"),
    });
    refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Un relais tourne dans votre réseau, à côté de vos outils. Il vient chercher les requêtes des collaborateurs, les exécute si sa propre liste blanche
          le permet, et renvoie la réponse. Vos URL internes ne sont jamais exposées.
        </p>
        {canEdit && <Button size="sm" onClick={create}><Plus className="mr-1 h-3.5 w-3.5" /> Nouveau relais</Button>}
      </div>

      {relays.length === 0 ? (
        <EmptyState icon={Server} title="Aucun relais" description="Nécessaire pour tout outil sur une URL interne (cluster Kubernetes, réseau privé, VPN)." />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {relays.map((r) => {
            const online = relayOnline(r);
            return (
              <div key={r.id} className={cn("rounded-xl border border-border p-4", r.status === "revoked" && "opacity-60")}>
                <div className="flex items-center gap-2">
                  <Dot weight="fill" className={cn("h-2.5 w-2.5", r.status === "revoked" ? "text-muted-foreground" : online ? "text-emerald-500" : "text-amber-500")} />
                  <span className="text-sm font-medium">{r.name}</span>
                  <Pill tone={r.status === "revoked" ? "muted" : online ? "green" : "amber"}>
                    {r.status === "revoked" ? "Révoqué" : online ? "En ligne" : "Hors ligne"}
                  </Pill>
                  {r.version && <span className="ml-auto font-mono text-[10px] text-muted-foreground">v{r.version}</span>}
                </div>
                <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                  <div>Dernier contact : {relativeTime(r.last_seen_at)}{r.hostname ? ` · ${r.hostname}` : ""}{r.last_ip ? ` · ${r.last_ip}` : ""}</div>
                  <div>Jeton ••••{r.token_hint ?? "????"}</div>
                </div>
                <div className="mt-3">
                  <span className="text-[11px] font-medium">Hôtes autorisés par le relais</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {r.reported_hosts.length
                      ? r.reported_hosts.map((h) => <span key={h} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{h}</span>)
                      : <span className="text-[11px] text-muted-foreground">{r.last_seen_at ? "Aucun : le relais refuse tout appel HTTP." : "Connu au premier contact."}</span>}
                  </div>
                  {r.reported_binaries.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {r.reported_binaries.map((b) => <span key={b} className="rounded bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] text-violet-700 dark:text-violet-300">{b}</span>)}
                    </div>
                  )}
                </div>
                {canEdit && r.status === "active" && (
                  <div className="mt-3 flex gap-1 border-t border-border pt-2">
                    <Button size="sm" variant="ghost" onClick={() => rotate(r)}><Rotate className="mr-1 h-3.5 w-3.5" /> Nouveau jeton</Button>
                    <Button size="sm" variant="ghost" onClick={() => revoke(r)}><Ban className="mr-1 h-3.5 w-3.5" /> Révoquer</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {revealed && <TokenReveal name={revealed.name} token={revealed.token} onClose={() => setRevealed(null)} />}
    </div>
  );
}
