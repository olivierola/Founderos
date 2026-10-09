// Les profils d'identifiants d'un connecteur.
//
// Un secret s'écrit ici et ne se relit jamais : l'écran n'en montre qu'un
// indice (••••a1b2) ou la référence côté relais (env:ARGOCD_TOKEN). Plusieurs
// profils par outil (lecture seule, prod-admin, SSO d'une personne) : chaque
// collaborateur reçoit celui dont il a besoin, pas plus.
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  KeyIcon as KeyRound, PlusIcon as Plus, ArrowsClockwiseIcon as Rotate, ProhibitIcon as Ban, TrashIcon as Trash2,
  CircleNotchIcon as Loader2, SignInIcon as LogIn, UsersThreeIcon as Users, HardDrivesIcon as Server, LockKeyIcon as Lock,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ToastProvider";
import { useConfirm } from "@/components/ConfirmProvider";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  type ConnectorCredential, type CustomConnector,
  connectorAction, normalizeAuthConfig, relativeTime, secretFieldsFor,
} from "./api";
import { Field, Pill, SectionTitle, Segmented, inputCls, textareaCls } from "./ui";

interface AgentLite { id: string; name: string; service_dashboard_id: string | null }

export function useProjectCollaborators(projectId: string | null) {
  return useQuery({
    queryKey: ["ccx_collaborators", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("id, name, service_dashboard_id")
        .eq("project_id", projectId!).eq("is_archived", false).order("name");
      return (data ?? []) as AgentLite[];
    },
  });
}

function expiryTone(iso: string | null): "red" | "amber" | null {
  if (!iso) return null;
  const days = (Date.parse(iso) - Date.now()) / 86_400_000;
  return days < 0 ? "red" : days < 14 ? "amber" : null;
}

export function CredentialsSection({ connector, credentials, readOnly, dirty, onChanged }: {
  connector: CustomConnector;
  credentials: ConnectorCredential[];
  readOnly: boolean;
  /** Définition modifiée et non enregistrée : un secret se lie à la version enregistrée. */
  dirty: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: agents } = useProjectCollaborators(connector.project_id);
  const [form, setForm] = useState<null | { credential?: ConnectorCredential }>(null);
  const [access, setAccess] = useState<ConnectorCredential | null>(null);
  const eligible = (agents ?? []).filter((a) => !connector.service_dashboard_id || a.service_dashboard_id === connector.service_dashboard_id);
  const nameOf = (id: string) => eligible.find((a) => a.id === id)?.name ?? (agents ?? []).find((a) => a.id === id)?.name ?? "collaborateur retiré";
  const active = credentials.filter((c) => c.status === "active");
  const revoked = credentials.filter((c) => c.status === "revoked");

  if (connector.auth_scheme === "none") {
    return (
      <div>
        <SectionTitle>Identifiants</SectionTitle>
        <p className="text-xs text-muted-foreground">Aucune authentification : rien à enregistrer. Choisissez un schéma ci-dessus si l'outil en demande une.</p>
      </div>
    );
  }

  async function revoke(c: ConnectorCredential) {
    if (!(await confirm({
      title: `Révoquer le profil « ${c.label} » ?`,
      description: "Le secret est effacé immédiatement et les collaborateurs qui l'utilisent perdent l'accès. Pensez aussi à le révoquer dans l'outil lui-même.",
      confirmText: "Révoquer",
    }))) return;
    await toast.run(() => connectorAction({ mode: "custom.update_credential", credential_id: c.id, status: "revoked" }), {
      loading: "Révocation…", success: "Profil révoqué", error: (e) => (e instanceof Error ? e.message : "Échec"),
    });
    onChanged();
  }

  async function remove(c: ConnectorCredential) {
    if (!(await confirm({ title: `Supprimer le profil « ${c.label} » ?`, description: "Le journal d'accès garde la trace des appels déjà faits avec lui.", confirmText: "Supprimer" }))) return;
    await toast.run(() => connectorAction({ mode: "custom.delete_credential", credential_id: c.id }), {
      loading: "Suppression…", success: "Profil supprimé", error: (e) => (e instanceof Error ? e.message : "Échec"),
    });
    onChanged();
  }

  return (
    <div>
      <SectionTitle
        aside={!readOnly && (
          <div className="flex items-center gap-1.5">
            {connector.auth_scheme === "oauth2_authorization_code" && <SsoConnectButton connector={connector} disabled={dirty} onDone={onChanged} />}
            {connector.auth_scheme !== "oauth2_authorization_code" && (
              <Button size="sm" variant="outline" disabled={dirty} onClick={() => setForm({})}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Profil d'identifiants
              </Button>
            )}
          </div>
        )}
      >
        Identifiants ({active.length})
      </SectionTitle>
      {dirty && !readOnly && <p className="mb-2 text-[11px] text-amber-600">Enregistrez d'abord la définition : un secret est lié à l'URL enregistrée.</p>}

      {active.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          {connector.auth_scheme === "oauth2_authorization_code"
            ? "Personne ne s'est encore connecté via le SSO."
            : "Aucun profil. Le connecteur ne peut pas s'authentifier tant qu'il n'en a pas un."}
        </p>
      ) : (
        <div className="space-y-2">
          {active.map((c) => {
            const tone = expiryTone(c.expires_at);
            return (
              <div key={c.id} className="rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-sm font-medium">{c.label}</span>
                  {c.location === "relay"
                    ? <Pill tone="violet" title="La valeur ne quitte jamais votre réseau : le relais la lit chez vous."><Server className="h-2.5 w-2.5" /> Détenu par le relais</Pill>
                    : <Pill tone="blue" title="Chiffré (AES-256-GCM), jamais relu par l'interface ni montré aux collaborateurs."><Lock className="h-2.5 w-2.5" /> Chiffré</Pill>}
                  {c.identity && <Pill>{c.identity}</Pill>}
                  {tone && <Pill tone={tone}>{tone === "red" ? "Expiré" : `Expire dans ${Math.max(1, Math.ceil((Date.parse(c.expires_at!) - Date.now()) / 86_400_000))} j`}</Pill>}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(c.hints ?? {}).map(([k, v]) => (
                    <span key={k} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{k}: {v}</span>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />
                    {(c.allowed_agent_ids ?? []).length ? c.allowed_agent_ids.map(nameOf).join(", ") : "Tous les collaborateurs autorisés"}
                  </span>
                  <span>{c.last_used_at ? `Utilisé ${relativeTime(c.last_used_at)}` : "Jamais utilisé"}</span>
                  <span>{c.rotated_at ? `Renouvelé ${relativeTime(c.rotated_at)}` : `Créé ${relativeTime(c.created_at)}`}</span>
                  {c.expires_at && !tone && <span>Expire le {new Date(c.expires_at).toLocaleDateString("fr-FR")}</span>}
                </div>
                {!readOnly && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {connector.auth_scheme !== "oauth2_authorization_code" && (
                      <Button size="sm" variant="ghost" disabled={dirty} onClick={() => setForm({ credential: c })}><Rotate className="mr-1 h-3.5 w-3.5" /> Renouveler le secret</Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setAccess(c)}><Users className="mr-1 h-3.5 w-3.5" /> Accès et expiration</Button>
                    <Button size="sm" variant="ghost" onClick={() => revoke(c)}><Ban className="mr-1 h-3.5 w-3.5" /> Révoquer</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {revoked.length > 0 && (
        <div className="mt-3 space-y-1">
          {revoked.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-md px-2 py-1 text-[11px] text-muted-foreground">
              <span>{c.label} · révoqué</span>
              {!readOnly && <button className="hover:text-destructive" onClick={() => remove(c)} aria-label="Supprimer"><Trash2 className="h-3.5 w-3.5" /></button>}
            </div>
          ))}
        </div>
      )}

      {form && (
        <CredentialForm
          connector={connector}
          credential={form.credential}
          collaborators={eligible}
          onClose={() => setForm(null)}
          onSaved={() => { setForm(null); onChanged(); }}
        />
      )}
      {access && (
        <AccessForm credential={access} collaborators={eligible} onClose={() => setAccess(null)} onSaved={() => { setAccess(null); onChanged(); }} />
      )}
    </div>
  );
}

function CollaboratorPicker({ value, onChange, collaborators }: { value: string[]; onChange: (v: string[]) => void; collaborators: AgentLite[] }) {
  return (
    <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border p-1.5">
      <label className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-secondary/40">
        <input type="radio" checked={value.length === 0} onChange={() => onChange([])} />
        Tous les collaborateurs à qui l'outil est confié
      </label>
      {collaborators.map((a) => (
        <label key={a.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-secondary/40">
          <input type="checkbox" checked={value.includes(a.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, a.id] : value.filter((x) => x !== a.id))} />
          {a.name}
        </label>
      ))}
      {collaborators.length === 0 && <p className="px-1.5 py-1 text-[11px] text-muted-foreground">Aucun collaborateur dans ce périmètre.</p>}
    </div>
  );
}

function Modal({ title, subtitle, children, onClose, footer }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; footer: ReactNode }) {
  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/40" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-[60] flex max-h-[88vh] w-[min(560px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-card shadow-2xl">
        <div className="border-b border-border px-5 py-3.5">
          <h3 className="text-sm font-semibold">{title}</h3>
          {subtitle && <p className="text-[11px] text-muted-foreground">{subtitle}</p>}
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
      </div>
    </>
  );
}

function CredentialForm({ connector, credential, collaborators, onClose, onSaved }: {
  connector: CustomConnector;
  credential?: ConnectorCredential;
  collaborators: AgentLite[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const cfg = normalizeAuthConfig(connector.auth_config);
  const fields = secretFieldsFor(connector.auth_scheme, cfg);
  const [label, setLabel] = useState(credential?.label ?? (credential ? "" : "Par défaut"));
  const [location, setLocation] = useState<"cloud" | "relay">(credential?.location ?? (connector.transport === "relay" ? "relay" : "cloud"));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [refs, setRefs] = useState<Record<string, string>>(credential?.relay_refs ?? {});
  const [identity, setIdentity] = useState(credential?.identity ?? "");
  const [expires, setExpires] = useState(credential?.expires_at?.slice(0, 10) ?? "");
  const [allowed, setAllowed] = useState<string[]>(credential?.allowed_agent_ids ?? []);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await connectorAction({
        mode: "custom.save_credential", connector_id: connector.id, credential_id: credential?.id ?? null,
        label, location, secrets: location === "cloud" ? secrets : {}, relay_refs: location === "relay" ? refs : {},
        identity, expires_at: expires ? new Date(`${expires}T23:59:59Z`).toISOString() : null, allowed_agent_ids: allowed,
      });
      toast.success(credential ? "Secret renouvelé" : "Profil enregistré");
      onSaved();
    } catch (e) {
      toast.error("Enregistrement refusé", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setSecrets({});
    }
  }

  return (
    <Modal
      title={credential ? `Renouveler « ${credential.label} »` : "Nouveau profil d'identifiants"}
      subtitle="Le secret est chiffré à l'enregistrement et ne sera plus jamais affiché. Les collaborateurs ne le voient pas."
      onClose={onClose}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose}>Annuler</Button>
        <Button size="sm" onClick={save} disabled={busy || !label.trim()}>
          {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Enregistrer
        </Button>
      </>}
    >
      <Field label="Nom du profil" hint="Ex. « Lecture seule », « Prod admin », « Compte de service CI ».">
        <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label="Où vit le secret">
        <Segmented
          value={location}
          onChange={setLocation}
          options={[
            { value: "cloud", label: "Chiffré par FounderOS" },
            ...(connector.transport === "relay" ? [{ value: "relay" as const, label: "Détenu par le relais" }] : []),
          ]}
        />
      </Field>
      {location === "relay" ? (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">
            Rien de secret n'est envoyé : indiquez où le relais trouve chaque valeur, une variable d'environnement (env:NOM) ou un fichier monté (file:/chemin).
          </p>
          {fields.map((f) => (
            <Field key={f.name} label={f.label}>
              <input className={cn(inputCls, "font-mono")} placeholder={`env:${f.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`} value={refs[f.name] ?? ""}
                onChange={(e) => setRefs((r) => ({ ...r, [f.name]: e.target.value }))} />
            </Field>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {credential && <p className="text-[11px] text-muted-foreground">Laissez vide un champ à conserver tel quel, sauf si l'URL du connecteur a changé : tout doit alors être ressaisi.</p>}
          {fields.map((f) => (
            <Field key={f.name} label={`${f.label}${f.optional ? " (optionnel)" : ""}`} hint={credential?.hints?.[f.name] ? `Actuel : ${credential.hints[f.name]}` : undefined}>
              {f.multiline ? (
                <textarea className={textareaCls} rows={4} autoComplete="off" spellCheck={false} value={secrets[f.name] ?? ""}
                  onChange={(e) => setSecrets((s) => ({ ...s, [f.name]: e.target.value }))} />
              ) : (
                <input type="password" autoComplete="new-password" className={cn(inputCls, "font-mono")} value={secrets[f.name] ?? ""}
                  onChange={(e) => setSecrets((s) => ({ ...s, [f.name]: e.target.value }))} />
              )}
            </Field>
          ))}
          {connector.auth_scheme === "basic" && (
            <Field label="Identifiant (si différent de celui de la configuration)">
              <input className={inputCls} autoComplete="off" value={secrets.username ?? ""} onChange={(e) => setSecrets((s) => ({ ...s, username: e.target.value }))} />
            </Field>
          )}
        </div>
      )}
      <Field label="Identité" hint="Au nom de qui partent les appels, tel que l'outil le voit. Repris au journal d'accès.">
        <input className={inputCls} placeholder="sa-founderos-readonly" value={identity} onChange={(e) => setIdentity(e.target.value)} />
      </Field>
      <Field label="Expiration" hint="Rappel visuel avant échéance ; après, le profil est refusé.">
        <input type="date" className={inputCls} value={expires} onChange={(e) => setExpires(e.target.value)} />
      </Field>
      <Field label="Collaborateurs autorisés à s'en servir">
        <CollaboratorPicker value={allowed} onChange={setAllowed} collaborators={collaborators} />
      </Field>
    </Modal>
  );
}

function AccessForm({ credential, collaborators, onClose, onSaved }: {
  credential: ConnectorCredential;
  collaborators: AgentLite[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState(credential.label);
  const [allowed, setAllowed] = useState<string[]>(credential.allowed_agent_ids ?? []);
  const [expires, setExpires] = useState(credential.expires_at?.slice(0, 10) ?? "");
  const [identity, setIdentity] = useState(credential.identity ?? "");
  return (
    <Modal
      title={`Accès au profil « ${credential.label} »`}
      onClose={onClose}
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose}>Annuler</Button>
        <Button size="sm" onClick={async () => {
          await toast.run(() => connectorAction({
            mode: "custom.update_credential", credential_id: credential.id, label, allowed_agent_ids: allowed, identity,
            expires_at: expires ? new Date(`${expires}T23:59:59Z`).toISOString() : null,
          }), { loading: "Enregistrement…", success: "Accès mis à jour", error: (e) => (e instanceof Error ? e.message : "Échec") });
          onSaved();
        }}>Enregistrer</Button>
      </>}
    >
      <Field label="Nom du profil"><input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
      <Field label="Identité"><input className={inputCls} value={identity} onChange={(e) => setIdentity(e.target.value)} /></Field>
      <Field label="Expiration"><input type="date" className={inputCls} value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
      <Field label="Collaborateurs autorisés"><CollaboratorPicker value={allowed} onChange={setAllowed} collaborators={collaborators} /></Field>
    </Modal>
  );
}

/** SSO utilisateur : la personne se connecte avec le SSO de l'entreprise, les appels partent sous son identité. */
function SsoConnectButton({ connector, disabled, onDone }: { connector: CustomConnector; disabled: boolean; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("SSO");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin || e.data?.type !== "ccx-oauth") return;
      setBusy(false);
      if (e.data.ok) { toast.success("Connecté via le SSO", e.data.identity ?? undefined); onDone(); }
      else toast.error("Connexion SSO refusée", e.data.error);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onDone, toast]);

  async function start() {
    setBusy(true);
    try {
      const res = await connectorAction<{ ok: boolean; authorize_url?: string; error?: string }>({
        mode: "custom.oauth_start", connector_id: connector.id, label,
        redirect_uri: `${window.location.origin}/connectors/callback`, client_secret: secret || undefined,
      });
      if (!res.authorize_url) throw new Error(res.error ?? "URL d'autorisation absente");
      window.open(res.authorize_url, "ccx-oauth", "width=560,height=720");
      setOpen(false);
      setSecret("");
    } catch (e) {
      setBusy(false);
      toast.error("SSO indisponible", e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => setOpen(true)}>
        {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <LogIn className="mr-1 h-3.5 w-3.5" />} Se connecter via le SSO
      </Button>
      {open && (
        <Modal
          title="Connexion via le SSO de l'entreprise"
          subtitle={`URL de redirection à déclarer chez votre fournisseur d'identité : ${window.location.origin}/connectors/callback`}
          onClose={() => setOpen(false)}
          footer={<>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
            <Button size="sm" onClick={start} disabled={!label.trim()}>Continuer</Button>
          </>}
        >
          <Field label="Nom du profil" hint="Ex. « SSO de Camille ». Les appels partiront sous l'identité connectée.">
            <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Client secret (optionnel)" hint="Vide pour un client public avec PKCE. Chiffré, jamais réaffiché.">
            <input type="password" autoComplete="new-password" className={inputCls} value={secret} onChange={(e) => setSecret(e.target.value)} />
          </Field>
        </Modal>
      )}
    </>
  );
}
