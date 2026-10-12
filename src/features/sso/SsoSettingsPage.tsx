// Administration → Authentification : le SSO de l'entreprise.
//
// Deux modes (sso-admin) : partagé, le cas du cloud, où chaque organisation
// configure son SSO pour ses domaines vérifiés ; dédié, où l'organisation
// « maison » d'une installation gère le SSO de toute l'instance.
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PlusIcon as Plus, PencilSimpleIcon as Edit, TrashIcon as Trash, CopyIcon as Copy, CheckIcon as Check,
  IdentificationBadgeIcon as Idp, CircleNotchIcon as Loader2,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { useToast } from "@/components/ToastProvider";
import { useConfirm } from "@/components/ConfirmProvider";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { Pill, SectionTitle, Toggle, inputCls, selectCls, type Tone } from "@/features/custom-connectors/ui";
import {
  AUTH_PUBLIC_URL, OIDC_REDIRECT_URI, addMapping, deleteProvider, fetchStatus, listLogins, listMappings, listOffboardings, listProviders,
  qk, removeMapping, saveSsoOnly,
  type MappedRole, type SsoLogin, type SsoProvider, type SsoRoleMapping,
} from "./api";
import { ProviderForm } from "./ProviderForm";
import { AgentIdentities } from "./AgentIdentities";
import { DomainsSection, useSsoDomains } from "./DomainsSection";

const ROLE_LABEL: Record<string, string> = { admin: "Admin", member: "Membre", viewer: "Lecteur" };

const ACTION_META: Record<SsoLogin["action"], { label: string; tone: Tone }> = {
  granted: { label: "Accès créé", tone: "green" },
  updated: { label: "Rôle modifié", tone: "blue" },
  unchanged: { label: "Inchangé", tone: "muted" },
  revoked: { label: "Accès retiré", tone: "amber" },
  denied: { label: "Aucun groupe reconnu", tone: "red" },
  kept_manual: { label: "Géré à la main", tone: "violet" },
};

export function SsoSettingsPage() {
  const { workspaceId } = useCurrentContext();
  const { data: status, isLoading } = useQuery({
    queryKey: qk.status(workspaceId ?? ""),
    enabled: !!workspaceId,
    queryFn: () => fetchStatus(workspaceId!),
  });

  return (
    <div>
      <PageHeader
        title="Authentification"
        description="Connexion par le fournisseur d'identité de l'entreprise (Entra ID, Keycloak, SAML), et rôles déduits des groupes à chaque connexion."
      />
      {isLoading || !workspaceId ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : !status?.enabled ? (
        status?.mode === "off" ? (
          <Notice title="SSO désactivé sur cette installation">
            L'exploitant a fermé le SSO d'entreprise (SSO_MODE=off dans les secrets des fonctions).
          </Notice>
        ) : (
          <Notice title="SSO momentanément fermé">
            La garde qui réserve chaque fournisseur aux domaines vérifiés de son organisation n'a pas pu être installée dans la base
            (migration 0282, déclencheur sur auth.identities). Sans elle, le SSO reste fermé : contactez l'exploitant.
          </Notice>
        )
      ) : status.claimed && !status.is_home ? (
        <Notice title="Géré depuis une autre organisation">
          Le SSO de cette installation est rattaché à une autre organisation. Ses owners et admins le configurent depuis celle-ci.
        </Notice>
      ) : !status.can_manage ? (
        <Notice title="Réservé aux owners">
          La première configuration du SSO rattache l'installation à cette organisation : seul un owner peut la faire.
        </Notice>
      ) : (
        <SsoAdmin workspaceId={workspaceId} ssoOnly={status.sso_only} saml={status.saml} shared={status.mode !== "dedicated"} />
      )}
    </div>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="max-w-2xl rounded-xl border border-border p-5">
      <div className="text-sm font-medium">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function SsoAdmin({ workspaceId, ssoOnly, saml, shared }: {
  workspaceId: string;
  ssoOnly: boolean;
  saml: { entity_id: string | null; acs_url: string | null } | null;
  /** Mode partagé : domaines vérifiés, « SSO seulement » par domaine. */
  shared: boolean;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<SsoProvider | "new" | null>(null);

  const providers = useQuery({ queryKey: qk.providers(workspaceId), queryFn: () => listProviders(workspaceId) });
  const mappings = useQuery({ queryKey: qk.mappings(workspaceId), queryFn: () => listMappings(workspaceId) });
  const logins = useQuery({ queryKey: qk.logins(workspaceId), queryFn: () => listLogins(workspaceId) });
  const departures = useQuery({ queryKey: ["sso", "offboarding", workspaceId], queryFn: () => listOffboardings(workspaceId) });
  const domains = useSsoDomains(workspaceId, shared);
  const verifiedDomains = (domains.data ?? []).filter((d) => d.verified_at).map((d) => d.domain);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["sso"] });

  async function remove(p: SsoProvider) {
    if (!(await confirm({
      title: `Supprimer « ${p.name} » ?`,
      description: "Il est retiré de Supabase Auth : plus personne ne peut se connecter par lui. Les comptes et appartenances déjà créés restent.",
      confirmText: "Supprimer",
    }))) return;
    await toast.run(() => deleteProvider(workspaceId, p.id), {
      loading: "Suppression…", success: "Fournisseur supprimé", error: (e) => (e instanceof Error ? e.message : "Échec"),
    });
    refresh();
  }

  async function toggleSsoOnly(v: boolean) {
    try {
      await saveSsoOnly(workspaceId, v);
      refresh();
    } catch (e) {
      toast.error("Réglage refusé", e instanceof Error ? e.message : String(e));
    }
  }

  const list = providers.data ?? [];

  return (
    <div className="space-y-8">
      {shared && (
        <DomainsSection
          workspaceId={workspaceId}
          coveredDomains={(providers.data ?? []).filter((p) => p.enabled).flatMap((p) => p.domains)}
        />
      )}

      <section>
        <SectionTitle>À déclarer chez votre IdP</SectionTitle>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-xl border border-border p-4">
            <div className="mb-2 text-xs font-medium">OIDC (Entra ID, Keycloak)</div>
            <CopyLine label="Redirect URI" value={OIDC_REDIRECT_URI} />
          </div>
          <div className="rounded-xl border border-border p-4">
            <div className="mb-2 text-xs font-medium">SAML 2.0</div>
            {saml ? (
              <div className="space-y-2">
                <CopyLine label="Entity ID (identifiant)" value={saml.entity_id ?? `${AUTH_PUBLIC_URL}/sso/saml/metadata`} />
                <CopyLine label="URL ACS (réponse)" value={saml.acs_url ?? `${AUTH_PUBLIC_URL}/sso/saml/acs`} />
                <CopyLine label="Métadonnées du fournisseur de service" value={`${AUTH_PUBLIC_URL}/sso/saml/metadata`} />
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                SAML n'est pas activé dans l'Auth : GOTRUE_SAML_ENABLED=true et GOTRUE_SAML_PRIVATE_KEY (clé RSA 2048 bits, PKCS#1 en base64).
              </p>
            )}
          </div>
        </div>
      </section>

      <section>
        <SectionTitle aside={<Button size="sm" onClick={() => setEditing("new")} disabled={shared && verifiedDomains.length === 0}
          title={shared && verifiedDomains.length === 0 ? "Vérifiez d'abord un domaine de l'organisation." : undefined}><Plus className="mr-1 h-3.5 w-3.5" /> Ajouter un fournisseur</Button>}>
          Fournisseurs
        </SectionTitle>
        {providers.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : list.length === 0 ? (
          <EmptyState icon={Idp} title="Aucun fournisseur" description={shared
            ? "Vérifiez un domaine, puis ajoutez Entra ID, Keycloak ou SAML : ses adresses pourront se connecter par le SSO dès l'enregistrement."
            : "Ajoutez Entra ID ou Keycloak : le bouton apparaît sur la page de connexion dès l'enregistrement."} />
        ) : (
          <div className="space-y-3">
            {list.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                mappings={(mappings.data ?? []).filter((m) => m.provider_id === p.id)}
                onEdit={() => setEditing(p)}
                onDelete={() => remove(p)}
                onChanged={refresh}
              />
            ))}
          </div>
        )}
      </section>

      {list.some((p) => p.delegation !== "none") && (
        <AgentIdentities workspaceId={workspaceId} providers={list.filter((p) => p.delegation !== "none")} />
      )}

      {shared ? (
        <section className="max-w-2xl">
          <SectionTitle>Page de connexion</SectionTitle>
          <p className="text-xs text-muted-foreground">
            Sur une instance partagée, la page de connexion ne liste pas les fournisseurs : la personne saisit son adresse, et
            FounderOS l'envoie au fournisseur de son domaine. « SSO seulement » se règle par domaine, ci-dessus.
          </p>
        </section>
      ) : (
      <section className="max-w-2xl">
        <SectionTitle>Page de connexion</SectionTitle>
        <Toggle
          checked={ssoOnly}
          onChange={toggleSsoOnly}
          disabled={!list.some((p) => p.enabled)}
          label="Connexion par SSO uniquement"
          hint="Masque l'e-mail et le mot de passe sur la page de connexion, et l'inscription. Pour le refuser aussi côté serveur, désactivez le fournisseur e-mail de l'Auth (GOTRUE_EXTERNAL_EMAIL_ENABLED=false) une fois le SSO validé."
        />
      </section>
      )}

      <section>
        <SectionTitle>Dernières connexions SSO</SectionTitle>
        <LoginsTable logins={logins.data ?? []} providers={list} />
      </section>

      <section>
        <SectionTitle>Départs</SectionTitle>
        <p className="mb-2 max-w-2xl text-xs text-muted-foreground">
          Un membre retiré (par un admin, ou par le SSO faute de groupe reconnu) perd aussitôt ses demandes d'approbation en attente,
          ses jetons d'IdP conservés pour les agents et ses groupes relevés ; sans autre organisation, ses sessions sont fermées.
          Les sessions sont de toute façon bornées dans l'Auth : un départ dans l'IdP prend effet en quelques heures.
        </p>
        {(departures.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucun départ enregistré.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-left text-[11px] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Personne</th>
                  <th className="px-3 py-2 font-medium">Rôle</th>
                  <th className="px-3 py-2 font-medium">Coupé</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {departures.data!.map((d) => (
                  <tr key={d.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{new Date(d.at).toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono text-[10px]">{d.user_id.slice(0, 8)}{d.managed_by === "sso" ? " · SSO" : ""}</td>
                    <td className="px-3 py-2">{d.role ? (ROLE_LABEL[d.role] ?? d.role) : "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {d.approvals_withdrawn} demande(s) retirée(s), {d.idp_tokens_deleted} jeton(s) IdP, {d.idp_roles_cleared} rôle(s), {d.sessions_revoked} session(s)
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <ProviderForm
          workspaceId={workspaceId}
          shared={shared}
          verifiedDomains={verifiedDomains}
          provider={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}

function CopyLine({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px]" title={value}>{value}</code>
        <button
          type="button"
          onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          aria-label={`Copier ${label}`}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

function valueHint(p: SsoProvider): string {
  if (p.preset === "entra") return p.groups_claim === "roles" ? "Valeur du rôle d'application" : "Object ID du groupe";
  if (p.preset === "keycloak") return p.groups_claim === "groups" ? "Groupe (ex. /sre)" : "Rôle";
  return `Valeur du claim ${p.groups_claim}`;
}

function ProviderCard({ provider: p, mappings, onEdit, onDelete, onChanged }: {
  provider: SsoProvider;
  mappings: SsoRoleMapping[];
  onEdit: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<MappedRole>("member");
  const [adding, setAdding] = useState(false);

  async function add() {
    if (!value.trim()) return;
    setAdding(true);
    try {
      await addMapping({ provider_id: p.id, workspace_id: p.workspace_id, idp_value: value.trim(), role, label: label.trim() || null });
      setValue("");
      setLabel("");
      onChanged();
    } catch (e) {
      toast.error("Correspondance refusée", e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  async function drop(m: SsoRoleMapping) {
    try {
      await removeMapping(m.id);
      onChanged();
    } catch (e) {
      toast.error("Suppression impossible", e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className={cn("rounded-xl border border-border p-4", !p.enabled && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{p.name}</span>
        <Pill tone="blue">{p.protocol.toUpperCase()}</Pill>
        <Pill tone={p.enabled ? "green" : "muted"}>{p.enabled ? "Actif" : "Désactivé"}</Pill>
        {p.delegation !== "none" && (
          <Pill tone="violet" title="Les agents peuvent agir au nom des personnes connectées par ce fournisseur.">
            Délègue · {p.delegation === "entra_obo" ? "On-Behalf-Of" : "échange de jeton"}
          </Pill>
        )}
        <span className="font-mono text-[10px] text-muted-foreground">{p.auth_ref}</span>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit}><Edit className="mr-1 h-3.5 w-3.5" /> Modifier</Button>
          <Button size="sm" variant="ghost" onClick={onDelete}><Trash className="mr-1 h-3.5 w-3.5" /> Supprimer</Button>
        </div>
      </div>
      <div className="mt-1.5 space-y-0.5 break-all text-[11px] text-muted-foreground">
        {p.issuer && <div>Issuer : {p.issuer}</div>}
        {p.metadata_url && <div>Métadonnées : {p.metadata_url}</div>}
        {p.delegation !== "none" && p.token_endpoint && <div>Point de jeton : {p.token_endpoint} · personne identifiée par « {p.subject_claim} »</div>}
        {p.domains.length > 0 && <div>Domaines : {p.domains.join(", ")}</div>}
        <div>
          Groupes lus dans « {p.groups_claim} »{p.groups_attribute ? ` (attribut ${p.groups_attribute})` : ""} · sans groupe reconnu :{" "}
          {p.default_role ? ROLE_LABEL[p.default_role] : "aucun accès"}
        </div>
      </div>

      <div className="mt-4 border-t border-border pt-3">
        <div className="mb-2 text-xs font-medium">Groupe → rôle dans l'organisation</div>
        {mappings.length === 0 ? (
          <p className="mb-2 text-[11px] text-muted-foreground">
            Aucune correspondance : {p.default_role ? `toute personne authentifiée devient ${ROLE_LABEL[p.default_role].toLowerCase()}.` : "personne n'entre pour l'instant."}
          </p>
        ) : (
          <div className="mb-3 divide-y divide-border rounded-lg border border-border">
            {mappings.map((m) => (
              <div key={m.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={m.idp_value}>{m.idp_value}</span>
                {m.label && <span className="truncate text-muted-foreground">{m.label}</span>}
                <Pill tone={m.role === "admin" ? "amber" : m.role === "member" ? "blue" : "muted"}>{ROLE_LABEL[m.role]}</Pill>
                <button type="button" onClick={() => drop(m)} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Retirer">
                  <Trash className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input className={cn(inputCls, "h-8 min-w-[220px] flex-[2] text-xs")} placeholder={valueHint(p)} value={value} onChange={(e) => setValue(e.target.value)} />
          <input className={cn(inputCls, "h-8 min-w-[140px] flex-1 text-xs")} placeholder="Libellé (facultatif)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <select className={cn(selectCls, "h-8 w-32 text-xs")} value={role} onChange={(e) => setRole(e.target.value as MappedRole)}>
            <option value="viewer">Lecteur</option>
            <option value="member">Membre</option>
            <option value="admin">Admin</option>
          </select>
          <Button size="sm" variant="outline" onClick={add} disabled={adding || !value.trim()}>Ajouter</Button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Recalculé à chaque connexion : le rôle le plus fort l'emporte, et un groupe retiré dans l'IdP retire l'accès à la connexion suivante.
          Les membres invités à la main ne sont jamais modifiés.
        </p>
      </div>
    </div>
  );
}

function LoginsTable({ logins, providers }: { logins: SsoLogin[]; providers: SsoProvider[] }) {
  if (!logins.length) return <p className="text-sm text-muted-foreground">Aucune connexion SSO pour l'instant.</p>;
  const nameOf = (id: string | null) => providers.find((p) => p.id === id)?.name ?? "—";
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-left text-[11px] text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Personne</th>
            <th className="px-3 py-2 font-medium">Fournisseur</th>
            <th className="px-3 py-2 font-medium">Résultat</th>
            <th className="px-3 py-2 font-medium">Valeurs reçues</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {logins.map((l) => (
            <tr key={l.id}>
              <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{new Date(l.created_at).toLocaleString()}</td>
              <td className="px-3 py-2">{l.email ?? "—"}</td>
              <td className="px-3 py-2">{nameOf(l.provider_id)}</td>
              <td className="px-3 py-2">
                <Pill tone={ACTION_META[l.action].tone}>{ACTION_META[l.action].label}</Pill>
                {l.role_applied && <span className="ml-1.5 text-muted-foreground">{ROLE_LABEL[l.role_applied] ?? l.role_applied}</span>}
              </td>
              <td className="max-w-[320px] truncate px-3 py-2 font-mono text-[10px] text-muted-foreground" title={l.idp_values.join(", ")}>
                {l.claim_found ? (l.idp_values.join(", ") || "(vide)") : "claim absent du jeton"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
