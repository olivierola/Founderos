// Déclarer ou modifier un fournisseur d'identité. Trois préréglages remplissent
// ce qui peut l'être (issuer, claim des groupes, attributs SAML d'Entra) ; le
// reste se recopie depuis la console de l'IdP.
import { useState } from "react";
import { CheckCircleIcon as Ok, WarningCircleIcon as Ko, CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ToastProvider";
import { Drawer, Field, Segmented, Toggle, inputCls, selectCls, textareaCls } from "@/features/custom-connectors/ui";
import {
  OIDC_REDIRECT_URI, saveProvider, testProvider,
  type Delegation, type ProviderDraft, type SsoPreset, type SsoProvider, type SsoProtocol, type TestResult,
} from "./api";

type Kind = "entra" | "keycloak" | "oidc" | "saml";

const KIND_LABEL: Record<Kind, string> = {
  entra: "Microsoft Entra ID",
  keycloak: "Keycloak",
  oidc: "OIDC générique",
  saml: "SAML 2.0",
};

const ENTRA_SAML_GROUPS = "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups";
const ENTRA_SAML_EMAIL = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";

function kindOf(p: SsoProvider): Kind {
  if (p.protocol === "saml") return "saml";
  return p.preset === "entra" ? "entra" : p.preset === "keycloak" ? "keycloak" : "oidc";
}

const ENTRA_ISSUER_RE = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0$/;
const KEYCLOAK_ISSUER_RE = /^(https?:\/\/.+)\/realms\/([^/]+)$/;

interface FormState {
  kind: Kind;
  name: string;
  slug: string;
  tenant: string;
  kcBase: string;
  kcRealm: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  groupsClaim: string;
  metaMode: "url" | "xml";
  metadataUrl: string;
  metadataXml: string;
  domains: string;
  groupsAttribute: string;
  emailAttribute: string;
  defaultRole: "" | "viewer" | "member";
  enabled: boolean;
  delegation: Delegation;
}

function initialState(p: SsoProvider | null): FormState {
  if (!p) {
    return {
      kind: "entra", name: KIND_LABEL.entra, slug: "entra", tenant: "", kcBase: "", kcRealm: "", issuer: "",
      clientId: "", clientSecret: "", scopes: "openid profile email", groupsClaim: "roles",
      metaMode: "url", metadataUrl: "", metadataXml: "", domains: "", groupsAttribute: ENTRA_SAML_GROUPS, emailAttribute: "",
      defaultRole: "", enabled: true, delegation: "none",
    };
  }
  const issuer = p.issuer ?? "";
  const entra = ENTRA_ISSUER_RE.exec(issuer);
  const kc = KEYCLOAK_ISSUER_RE.exec(issuer);
  // Un issuer qui ne suit pas la forme du préréglage s'édite en clair.
  const kind: Kind = kindOf(p) === "entra" && !entra ? "oidc" : kindOf(p) === "keycloak" && !kc ? "oidc" : kindOf(p);
  return {
    kind, name: p.name, slug: p.auth_ref.replace(/^custom:/, ""),
    tenant: entra?.[1] ?? "", kcBase: kc?.[1] ?? "", kcRealm: kc?.[2] ?? "", issuer,
    clientId: p.client_id ?? "", clientSecret: "", scopes: "openid profile email", groupsClaim: p.groups_claim,
    metaMode: "url", metadataUrl: p.metadata_url ?? "", metadataXml: "", domains: p.domains.join(", "),
    groupsAttribute: p.groups_attribute ?? "", emailAttribute: p.email_attribute ?? "",
    defaultRole: p.default_role ?? "", enabled: p.enabled, delegation: p.delegation ?? "none",
  };
}

function toDraft(s: FormState, existing: SsoProvider | null): ProviderDraft {
  const protocol: SsoProtocol = s.kind === "saml" ? "saml" : "oidc";
  const preset: SsoPreset = s.kind === "entra" ? "entra" : s.kind === "keycloak" ? "keycloak" : (existing?.preset ?? "generic");
  const issuer = s.kind === "entra"
    ? `https://login.microsoftonline.com/${s.tenant.trim()}/v2.0`
    : s.kind === "keycloak"
      ? `${s.kcBase.trim().replace(/\/+$/, "")}/realms/${s.kcRealm.trim()}`
      : s.issuer.trim();
  const base = {
    id: existing?.id,
    protocol,
    preset,
    name: s.name.trim(),
    domains: s.domains.split(/[\s,;]+/).map((d) => d.trim()).filter(Boolean),
    default_role: s.defaultRole || null,
    enabled: s.enabled,
  };
  if (protocol === "oidc") {
    return {
      ...base,
      slug: s.slug.trim(),
      issuer,
      client_id: s.clientId.trim(),
      client_secret: s.clientSecret.trim() || undefined,
      scopes: s.scopes.split(/\s+/).filter(Boolean),
      groups_claim: s.groupsClaim.trim(),
      delegation: s.delegation,
      // Entra ID : le sub change d'une application à l'autre, oid non.
      subject_claim: preset === "entra" ? "oid" : "sub",
    };
  }
  return {
    ...base,
    metadata_url: s.metaMode === "url" ? s.metadataUrl.trim() : undefined,
    metadata_xml: s.metaMode === "xml" ? s.metadataXml.trim() : undefined,
    groups_attribute: s.groupsAttribute.trim(),
    email_attribute: s.emailAttribute.trim(),
  };
}

export function ProviderForm({ workspaceId, provider, onClose, onSaved, shared = false, verifiedDomains = [] }: {
  workspaceId: string;
  provider: SsoProvider | null;
  /** Mode partagé (0282) : le fournisseur ne vaut que pour des domaines vérifiés. */
  shared?: boolean;
  verifiedDomains?: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [s, setS] = useState<FormState>(() => initialState(provider));
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const creating = !provider;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => { setS((prev) => ({ ...prev, [k]: v })); setTest(null); };

  function pickKind(kind: Kind) {
    // Les préréglages ne remplacent que des valeurs encore par défaut.
    setS((prev) => ({
      ...prev,
      kind,
      name: Object.values(KIND_LABEL).includes(prev.name) || !prev.name ? (kind === "oidc" || kind === "saml" ? "SSO de l'entreprise" : KIND_LABEL[kind]) : prev.name,
      slug: ["entra", "keycloak", "sso", ""].includes(prev.slug) ? (kind === "keycloak" ? "keycloak" : kind === "entra" ? "entra" : "sso") : prev.slug,
      groupsClaim: kind === "entra" ? "roles" : kind === "keycloak" ? "groups" : prev.groupsClaim || "groups",
    }));
    setTest(null);
  }

  async function runTest() {
    setTesting(true);
    try {
      setTest(await testProvider(workspaceId, toDraft(s, provider)));
    } catch (e) {
      setTest({ ok: false, detail: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await saveProvider(workspaceId, toDraft(s, provider));
      toast.success(creating ? "Fournisseur enregistré" : "Fournisseur mis à jour");
      onSaved();
    } catch (e) {
      toast.error("Enregistrement impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const isOidc = s.kind !== "saml";

  return (
    <Drawer
      title={creating ? "Nouveau fournisseur d'identité" : `Modifier « ${provider!.name} »`}
      subtitle={isOidc ? `Redirect URI à déclarer chez l'IdP : ${OIDC_REDIRECT_URI}` : "Entity ID et URL ACS : voir « À déclarer chez votre IdP »."}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2">
          <Button size="sm" variant="outline" onClick={runTest} disabled={testing}>
            {testing && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Tester
          </Button>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>Annuler</Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Enregistrer
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5 px-5 py-4">
        {creating ? (
          <Segmented<Kind> value={s.kind} onChange={pickKind} options={(Object.keys(KIND_LABEL) as Kind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
        ) : (
          <p className="text-xs text-muted-foreground">{KIND_LABEL[s.kind]} · {provider!.auth_ref}</p>
        )}

        {shared && (
          <Field label="Domaines vérifiés couverts" hint="Seules les adresses de ces domaines pourront se connecter par ce fournisseur : la base refuse toutes les autres.">
            <div className="flex flex-wrap gap-3 pt-1">
              {verifiedDomains.map((d) => {
                const picked = s.domains.split(/[\s,;]+/).filter(Boolean);
                return (
                  <label key={d} className="inline-flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={picked.includes(d)}
                      onChange={(e) => set("domains", (e.target.checked ? [...picked, d] : picked.filter((x) => x !== d)).join(", "))} />
                    <span className="font-mono">{d}</span>
                  </label>
                );
              })}
              {!verifiedDomains.length && <span className="text-xs text-muted-foreground">Aucun domaine vérifié : vérifiez-en un d'abord.</span>}
            </div>
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Libellé du bouton" hint="Affiché sur la page de connexion : « Continue with … ».">
            <input className={inputCls} value={s.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          {isOidc && (
            <Field label="Identifiant" hint={creating ? `Devient custom:${shared ? "o<organisation>-" : ""}${s.slug || "…"} dans l'Auth. Fixé à la création.` : "Fixé à la création."}>
              <input className={inputCls} value={s.slug} disabled={!creating} onChange={(e) => set("slug", e.target.value.toLowerCase())} />
            </Field>
          )}
        </div>

        {s.kind === "entra" && (
          <div className="space-y-4">
            <Field label="ID du locataire (tenant)" hint="Entra ID → Vue d'ensemble → ID du locataire. L'issuer devient https://login.microsoftonline.com/<tenant>/v2.0.">
              <input className={inputCls} value={s.tenant} onChange={(e) => set("tenant", e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
            </Field>
            <EntraHint />
          </div>
        )}

        {s.kind === "keycloak" && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="URL du serveur Keycloak" hint="Sans /realms. Keycloak 17+ : pas de /auth.">
                <input className={inputCls} value={s.kcBase} onChange={(e) => set("kcBase", e.target.value)} placeholder="https://keycloak.interne.exemple" />
              </Field>
              <Field label="Realm">
                <input className={inputCls} value={s.kcRealm} onChange={(e) => set("kcRealm", e.target.value)} placeholder="entreprise" />
              </Field>
            </div>
            <KeycloakHint />
          </div>
        )}

        {s.kind === "oidc" && (
          <Field label="Issuer" hint="Exactement la valeur « issuer » de /.well-known/openid-configuration.">
            <input className={inputCls} value={s.issuer} onChange={(e) => set("issuer", e.target.value)} placeholder="https://idp.exemple/realms/x" />
          </Field>
        )}

        {isOidc && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Client ID" hint={s.kind === "entra" ? "ID d'application (client)." : undefined}>
                <input className={inputCls} value={s.clientId} onChange={(e) => set("clientId", e.target.value)} />
              </Field>
              <Field label="Secret client" hint={s.delegation !== "none"
                ? (creating || provider?.delegation === "none" ? "Requis : conservé aussi par FounderOS, chiffré, pour la délégation." : "Laisser vide pour le conserver.")
                : creating ? "Stocké uniquement dans Supabase Auth." : "Laisser vide pour le conserver."}>
                <input className={inputCls} type="password" autoComplete="off" value={s.clientSecret} onChange={(e) => set("clientSecret", e.target.value)} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Scopes">
                <input className={inputCls} value={s.scopes} onChange={(e) => set("scopes", e.target.value)} />
              </Field>
              <Field label="Claim des groupes" hint={s.kind === "entra" ? "roles : rôles d'application (recommandé). groups : object IDs des groupes." : s.kind === "keycloak" ? "groups (mapper Group Membership) ou realm_access.roles." : "Chemin pointé dans le jeton d'ID."}>
                {s.kind === "entra" ? (
                  <select className={selectCls} value={s.groupsClaim} onChange={(e) => set("groupsClaim", e.target.value)}>
                    <option value="roles">roles (rôles d'application)</option>
                    <option value="groups">groups (groupes de sécurité)</option>
                  </select>
                ) : (
                  <input className={inputCls} value={s.groupsClaim} onChange={(e) => set("groupsClaim", e.target.value)} />
                )}
              </Field>
            </div>
            <Field
              label="Délégation aux agents"
              hint={s.delegation === "entra_obo"
                ? "Entra ID émet, par On-Behalf-Of, un jeton au nom de la personne pour chaque outil. Chaque agent a sa propre application (Identités des agents)."
                : s.delegation === "token_exchange"
                  ? "L'IdP échange le jeton de la personne contre un jeton court pour un outil (RFC 8693 : Keycloak, Okta…). Chaque agent a son propre client."
                  : "Les agents n'agissent pas au nom des personnes auprès de cet IdP."}
            >
              <select className={selectCls} value={s.delegation} onChange={(e) => set("delegation", e.target.value as Delegation)}>
                <option value="none">Aucune</option>
                <option value="token_exchange">Échange de jeton (RFC 8693)</option>
                <option value="entra_obo">Entra ID On-Behalf-Of</option>
              </select>
            </Field>
            {s.delegation !== "none" && (
              <p className="text-[11px] text-muted-foreground">
                Le scope offline_access est ajouté : sans jeton de rafraîchissement, aucun agent ne peut agir au nom d'une personne après sa connexion.
                Le point de jeton est lu dans le document de découverte de l'IdP à l'enregistrement.
              </p>
            )}
          </>
        )}

        {s.kind === "saml" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Métadonnées de l'IdP</span>
              <Segmented size="sm" value={s.metaMode} onChange={(v) => set("metaMode", v)} options={[{ value: "url", label: "URL" }, { value: "xml", label: "XML" }]} />
            </div>
            {s.metaMode === "url" ? (
              <input className={inputCls} value={s.metadataUrl} onChange={(e) => set("metadataUrl", e.target.value)} placeholder="https://login.microsoftonline.com/<tenant>/federationmetadata/2007-06/federationmetadata.xml?appid=…" />
            ) : (
              <textarea className={textareaCls} rows={6} value={s.metadataXml} onChange={(e) => set("metadataXml", e.target.value)} placeholder="<EntityDescriptor …>" />
            )}
            {!creating && <p className="text-[11px] text-muted-foreground">Laisser vide pour garder les métadonnées enregistrées.</p>}
            {!shared && (
              <Field label="Domaines e-mail" hint="Séparés par des virgules. Un domaine ne peut appartenir qu'à un seul fournisseur SAML.">
                <input className={inputCls} value={s.domains} onChange={(e) => set("domains", e.target.value)} placeholder="entreprise.fr, filiale.fr" />
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Attribut des groupes" hint="Entra ID : …/claims/groups.">
                <input className={inputCls} value={s.groupsAttribute} onChange={(e) => set("groupsAttribute", e.target.value)} />
              </Field>
              <Field label="Attribut de l'e-mail" hint="Si le NameID n'est pas une adresse e-mail.">
                <input className={inputCls} value={s.emailAttribute} onChange={(e) => set("emailAttribute", e.target.value)} placeholder={ENTRA_SAML_EMAIL} />
              </Field>
            </div>
          </div>
        )}

        <Field label="Sans groupe reconnu" hint="Rôle d'une personne authentifiée dont aucun groupe n'a de correspondance.">
          <select className={selectCls} value={s.defaultRole} onChange={(e) => set("defaultRole", e.target.value as FormState["defaultRole"])}>
            <option value="">Aucun accès (recommandé)</option>
            <option value="viewer">Lecteur</option>
            <option value="member">Membre</option>
          </select>
        </Field>

        {!creating && (
          <Toggle
            checked={s.enabled}
            onChange={(v) => set("enabled", v)}
            label="Actif"
            hint={isOidc
              ? "Désactivé : le bouton disparaît et la connexion ne donne plus aucun rôle. Pour couper aussi l'authentification, supprimez le fournisseur."
              : "Désactivé : l'Auth refuse les connexions par ce fournisseur."}
          />
        )}

        {test && <TestOutcome result={test} />}
      </div>
    </Drawer>
  );
}

function TestOutcome({ result }: { result: TestResult }) {
  const Icon = result.ok ? Ok : Ko;
  return (
    <div className={result.ok ? "rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3" : "rounded-lg border border-red-500/30 bg-red-500/5 p-3"}>
      <div className="flex items-center gap-2 text-xs font-medium">
        <Icon className={result.ok ? "h-4 w-4 text-emerald-600" : "h-4 w-4 text-red-600"} />
        {result.ok ? "L'IdP répond comme attendu." : "Vérification échouée."}
      </div>
      <div className="mt-1.5 space-y-0.5 break-all text-[11px] text-muted-foreground">
        {result.detail && <div>{result.detail}</div>}
        {result.issuer && <div>Issuer : {result.issuer}</div>}
        {result.authorization_endpoint && <div>Autorisation : {result.authorization_endpoint}</div>}
        {result.claims_supported && <div>Claims annoncés : {result.claims_supported.join(", ")}</div>}
        {result.entity_id && <div>Entity ID de l'IdP : {result.entity_id}</div>}
        {result.sso_url && <div>URL SSO : {result.sso_url}</div>}
        {result.signing_cert === false && <div>Aucun certificat de signature dans les métadonnées.</div>}
      </div>
    </div>
  );
}

function Hint({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
      <div className="mb-1 font-medium text-foreground">{title}</div>
      <ol className="list-decimal space-y-0.5 pl-4">{items.map((i) => <li key={i}>{i}</li>)}</ol>
    </div>
  );
}

function EntraHint() {
  return (
    <Hint title="Côté Entra ID (Inscriptions d'applications)" items={[
      `Plateforme Web, URI de redirection : ${OIDC_REDIRECT_URI}`,
      "Certificats & secrets : créez un secret client et collez-le ici.",
      "Configuration du jeton : ajoutez le claim facultatif « email » au jeton d'ID. Sans e-mail, l'Auth refuse la connexion.",
      "Rôles d'application (recommandé) : déclarez un rôle par niveau d'accès, puis assignez-les aux groupes dans Applications d'entreprise. Ils arrivent dans le claim « roles », sans la limite des 200 groupes.",
      "À défaut, « Ajouter un claim de groupes » (ID de groupe) : les valeurs reçues sont des object IDs.",
    ]} />
  );
}

function KeycloakHint() {
  return (
    <Hint title="Côté Keycloak (Clients)" items={[
      "Client OpenID Connect, authentification client activée, flux standard.",
      `Valid redirect URIs : ${OIDC_REDIRECT_URI}`,
      "Client scopes → dedicated → Add mapper « Group Membership » : nom du claim groups, ajouté au jeton d'ID. Avec « Full group path », les valeurs ressemblent à /sre.",
      "Ou bien des rôles de realm : claim realm_access.roles.",
    ]} />
  );
}
