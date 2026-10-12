// La fiche d'un outil interne : définition, authentification, opérations,
// politique. Tiroir plein hauteur à droite, comme les autres réglages.
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CircleNotchIcon as Loader2, PlugsConnectedIcon as Plug, PowerIcon as Power, TrashIcon as Trash2,
  WarningIcon as AlertTriangle, CheckCircleIcon as CheckCircle2, XCircleIcon as XCircle, MagnifyingGlassIcon as Search,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ToastProvider";
import { useConfirm } from "@/components/ConfirmProvider";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  AUTH_SCHEMES, type AuthConfig, type AuthScheme, type ConnectorCredential, type ConnectorOperation, type ConnectorPolicy,
  type ConnectorRelay, type CustomConnector, type TestOutcome, type HttpMethod,
  connectorAction, connectorSetupIssues, normalizeAuthConfig, normalizeOperations, normalizePolicy, qk, relayOnline, relativeTime,
} from "./api";
import { CredentialsSection } from "./CredentialsSection";
import { OperationsSection } from "./OperationsSection";
import { Drawer, Field, Pill, SectionTitle, Segmented, Toggle, inputCls, selectCls, textareaCls } from "./ui";

type Tab = "general" | "auth" | "operations" | "security";

interface Draft {
  name: string;
  description: string;
  base_url: string;
  transport: "direct" | "relay";
  relay_id: string | null;
  scoped: boolean;
  auth_scheme: AuthScheme;
  auth_config: AuthConfig;
  operations: ConnectorOperation[];
  policy: ConnectorPolicy;
  setup_notes: string;
}

function toDraft(c: CustomConnector): Draft {
  return {
    name: c.name,
    description: c.description ?? "",
    base_url: c.base_url,
    transport: c.transport,
    relay_id: c.relay_id,
    scoped: !!c.service_dashboard_id,
    auth_scheme: c.auth_scheme,
    auth_config: normalizeAuthConfig(c.auth_config),
    operations: normalizeOperations(c.operations),
    policy: normalizePolicy(c.policy),
    setup_notes: c.setup_notes ?? "",
  };
}

const kv = (m: Record<string, string> | undefined) => Object.entries(m ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
const parseKv = (s: string) => Object.fromEntries(s.split("\n").map((l) => l.split(/=(.*)/s)).filter((p) => p[0]?.trim()).map(([k, v]) => [k.trim(), (v ?? "").trim()]));
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const originOf = (u: string | undefined) => { try { return u ? new URL(u).origin : ""; } catch { return ""; } };

const STATUS_META = {
  active: { label: "Actif", tone: "green" as const },
  draft: { label: "Brouillon", tone: "amber" as const },
  disabled: { label: "Désactivé", tone: "muted" as const },
};

export function ConnectorEditor({ connector, credentials, relays, serviceDashboardId, canEdit, onClose }: {
  connector: CustomConnector;
  credentials: ConnectorCredential[];
  relays: ConnectorRelay[];
  serviceDashboardId: string | null;
  canEdit: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("general");
  const [draft, setDraft] = useState<Draft>(() => toDraft(connector));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestOutcome | null>(null);
  const baseline = useMemo(() => JSON.stringify(toDraft(connector)), [connector]);
  const dirty = JSON.stringify(draft) !== baseline;
  const readOnly = !canEdit;
  const activeCreds = credentials.filter((c) => c.status === "active");
  const issues = connectorSetupIssues({ ...draft, status: connector.status }, activeCreds.length);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setCfg = (patch: Partial<AuthConfig>) => setDraft((d) => ({ ...d, auth_config: { ...d.auth_config, ...patch } }));
  const setPolicy = (patch: Partial<ConnectorPolicy>) => setDraft((d) => ({ ...d, policy: { ...d.policy, ...patch } }));
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: qk.connectors(connector.project_id) });
    queryClient.invalidateQueries({ queryKey: qk.credentials(connector.project_id) });
  };

  async function save(): Promise<boolean> {
    const before = toDraft(connector);
    const rebinds = activeCreds.some((c) => c.location === "cloud") && (
      originOf(before.base_url) !== originOf(draft.base_url) || originOf(before.auth_config.token_url) !== originOf(draft.auth_config.token_url)
    );
    if (rebinds && !(await confirm({
      title: "L'adresse de l'outil change",
      description: "Les secrets enregistrés restent liés à l'ancienne adresse et ne seront plus envoyés : il faudra les ressaisir. C'est voulu, pour qu'un changement d'URL ne puisse pas détourner un jeton.",
      confirmText: "Enregistrer quand même",
      destructive: false,
    }))) return false;
    setSaving(true);
    const { error } = await supabase.from("custom_connectors").update({
      name: draft.name.trim() || connector.name,
      description: draft.description.trim() || null,
      base_url: draft.base_url.trim(),
      transport: draft.transport,
      relay_id: draft.transport === "relay" ? draft.relay_id : null,
      service_dashboard_id: draft.scoped ? (connector.service_dashboard_id ?? serviceDashboardId) : null,
      auth_scheme: draft.auth_scheme,
      auth_config: normalizeAuthConfig(draft.auth_config),
      operations: normalizeOperations(draft.operations),
      policy: normalizePolicy(draft.policy),
      setup_notes: draft.setup_notes.trim() || null,
    }).eq("id", connector.id);
    setSaving(false);
    if (error) { toast.error("Enregistrement impossible", error.message); return false; }
    toast.success("Connecteur enregistré");
    refresh();
    return true;
  }

  async function setStatus(status: CustomConnector["status"]) {
    if (status === "active" && issues.length) { toast.error("Pas encore activable", issues.join(" ")); return; }
    if (status === "disabled" && !(await confirm({
      title: `Désactiver ${connector.name} ?`,
      description: "Coupe-circuit immédiat : plus aucun collaborateur ne peut l'appeler. Les profils et le journal sont conservés.",
      confirmText: "Désactiver",
    }))) return;
    const { error } = await supabase.from("custom_connectors").update({ status }).eq("id", connector.id);
    if (error) toast.error("Changement refusé", error.message);
    else { toast.success(status === "active" ? "Connecteur actif" : status === "disabled" ? "Connecteur désactivé" : "Repassé en brouillon"); refresh(); }
  }

  async function remove() {
    if (!(await confirm({
      title: `Supprimer ${connector.name} ?`,
      description: "La définition et ses profils d'identifiants sont supprimés, les collaborateurs perdent l'outil. Le journal d'accès garde la trace des appels passés.",
      confirmText: "Supprimer",
      typeToConfirm: connector.name,
    }))) return;
    const { error } = await supabase.from("custom_connectors").delete().eq("id", connector.id);
    if (error) { toast.error("Suppression impossible", error.message); return; }
    toast.success("Connecteur supprimé");
    refresh();
    onClose();
  }

  async function runTest() {
    if (dirty && !(await save())) return;
    setTesting(true);
    try {
      setTest(await connectorAction<TestOutcome>({ mode: "custom.test", connector_id: connector.id }));
    } catch (e) {
      setTest({ ok: false, decision: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
      refresh();
    }
  }

  const status = STATUS_META[connector.status];

  return (
    <Drawer
      width="max-w-3xl"
      onClose={async () => {
        if (dirty && canEdit && !(await confirm({ title: "Quitter sans enregistrer ?", description: "Vos modifications seront perdues.", confirmText: "Quitter" }))) return;
        onClose();
      }}
      title={<span className="flex items-center gap-2">{connector.name} <Pill tone={status.tone}>{status.label}</Pill></span>}
      subtitle={<>Version {connector.version} · {connector.slug}{connector.last_test_at ? ` · dernier test ${relativeTime(connector.last_test_at)}` : ""}</>}
      actions={
        <Button size="sm" variant="outline" onClick={runTest} disabled={testing}>
          {testing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Plug className="mr-1 h-3.5 w-3.5" />} Tester la connexion
        </Button>
      }
      footer={canEdit ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            {connector.status === "active"
              ? <Button size="sm" variant="ghost" onClick={() => setStatus("disabled")}><Power className="mr-1 h-3.5 w-3.5" /> Désactiver</Button>
              : <Button size="sm" variant="outline" onClick={() => setStatus("active")} disabled={dirty || issues.length > 0}
                  title={issues.length ? issues.join(" ") : dirty ? "Enregistrez d'abord" : undefined}>
                  <Power className="mr-1 h-3.5 w-3.5" /> Activer
                </Button>}
            <Button size="sm" variant="ghost" onClick={remove}><Trash2 className="mr-1 h-3.5 w-3.5 text-destructive" /> Supprimer</Button>
          </div>
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Enregistrer
          </Button>
        </div>
      ) : <p className="text-[11px] text-muted-foreground">Lecture seule : seuls les owners et admins modifient un outil interne.</p>}
    >
      <div className="sticky top-0 z-10 border-b border-border bg-card/95 px-5 py-2.5 backdrop-blur">
        <Segmented value={tab} onChange={setTab} options={[
          { value: "general", label: "Général" },
          { value: "auth", label: `Authentification${activeCreds.length ? ` (${activeCreds.length})` : ""}` },
          { value: "operations", label: `Opérations (${draft.operations.length})` },
          { value: "security", label: "Sécurité" },
        ]} />
      </div>

      <div className="space-y-6 px-5 py-5">
        {test && (
          <div className={cn("rounded-lg border p-3", test.ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5")}>
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
              {test.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-amber-600" />}
              {test.ok ? "Connexion établie" : "Échec du test"}{test.operation ? ` · ${test.operation}` : ""}
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">{test.text}</pre>
          </div>
        )}

        {tab === "general" && (
          <>
            {(issues.length > 0 || draft.setup_notes) && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="h-4 w-4" /> À compléter
                </div>
                {issues.length > 0 && <ul className="ml-5 list-disc space-y-0.5 text-xs">{issues.map((i) => <li key={i}>{i}</li>)}</ul>}
                {draft.setup_notes && <p className="mt-2 whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">{draft.setup_notes}</p>}
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nom"><input className={inputCls} disabled={readOnly} value={draft.name} onChange={(e) => set({ name: e.target.value })} /></Field>
              <Field label="Réservé à">
                <Segmented value={draft.scoped ? "service" : "project"} onChange={(v) => !readOnly && set({ scoped: v === "service" })}
                  options={[{ value: "service", label: "Ce service" }, { value: "project", label: "Tout le projet" }]} />
              </Field>
            </div>
            <Field label="Description" hint="Lue par les collaborateurs pour savoir à quoi sert l'outil.">
              <input className={inputCls} disabled={readOnly} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
            </Field>
            <Field label="URL de base" hint="L'adresse de l'API de l'outil, telle qu'on la joint depuis votre réseau.">
              <input className={cn(inputCls, "font-mono")} disabled={readOnly} placeholder="https://argocd.interne.exemple" value={draft.base_url}
                onChange={(e) => set({ base_url: e.target.value })} />
            </Field>
            <div className="space-y-2">
              <span className="text-xs font-medium">Comment l'atteindre</span>
              <div className="grid gap-2 sm:grid-cols-2">
                {([
                  { v: "direct", t: "En direct", d: "L'outil est exposé sur Internet (ou derrière un proxy d'identité). L'appel part du cloud FounderOS ; les adresses privées sont refusées." },
                  { v: "relay", t: "Par un relais", d: "L'outil est sur votre réseau interne. Un relais déployé chez vous, sortant uniquement, l'appelle et applique sa propre liste blanche." },
                ] as const).map((o) => (
                  <button key={o.v} type="button" disabled={readOnly} onClick={() => set({ transport: o.v })}
                    className={cn("rounded-lg border p-3 text-left transition-colors",
                      draft.transport === o.v ? "border-primary/60 bg-primary/5" : "border-border hover:bg-secondary/40")}>
                    <span className="block text-xs font-medium">{o.t}</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{o.d}</span>
                  </button>
                ))}
              </div>
              {draft.transport === "relay" && (
                <Field label="Relais">
                  <select className={selectCls} disabled={readOnly} value={draft.relay_id ?? ""} onChange={(e) => set({ relay_id: e.target.value || null })}>
                    <option value="">Choisir un relais…</option>
                    {relays.filter((r) => r.status === "active").map((r) => (
                      <option key={r.id} value={r.id}>{r.name} · {relayOnline(r) ? "en ligne" : `hors ligne (${relativeTime(r.last_seen_at)})`}</option>
                    ))}
                  </select>
                </Field>
              )}
              {draft.transport === "relay" && relays.filter((r) => r.status === "active").length === 0 && (
                <p className="text-[11px] text-amber-600">Aucun relais pour l'instant : créez-en un dans l'onglet « Relais » de cette page.</p>
              )}
            </div>
            <Field label="Notes de mise en place" hint="Ce qu'il reste à faire à la main, pour vous ou un collègue.">
              <textarea className={cn(textareaCls, "font-sans text-xs")} rows={3} disabled={readOnly} value={draft.setup_notes}
                onChange={(e) => set({ setup_notes: e.target.value })} />
            </Field>
          </>
        )}

        {tab === "auth" && (
          <>
            <AuthConfigEditor draft={draft} readOnly={readOnly} setScheme={(s) => set({ auth_scheme: s })} setCfg={setCfg} connectorId={connector.id} />
            <div className="border-t border-border pt-5">
              <CredentialsSection connector={connector} credentials={credentials} readOnly={readOnly}
                dirty={dirty && (draft.auth_scheme !== connector.auth_scheme || JSON.stringify(draft.auth_config) !== JSON.stringify(normalizeAuthConfig(connector.auth_config)) || draft.base_url !== connector.base_url || draft.transport !== connector.transport)}
                onChanged={refresh} />
            </div>
          </>
        )}

        {tab === "operations" && (
          <OperationsSection
            connectorId={connector.id}
            operations={draft.operations}
            onChange={(ops) => set({ operations: ops })}
            transport={draft.transport}
            testOperation={draft.policy.test_operation}
            onTestOperation={(name) => setPolicy({ test_operation: name })}
            readOnly={readOnly}
            savedVersion={!dirty}
          />
        )}

        {tab === "security" && <PolicyEditor policy={draft.policy} setPolicy={setPolicy} readOnly={readOnly} />}
      </div>
    </Drawer>
  );
}

const AUTH_PRESETS: Partial<Record<AuthScheme, Array<{ label: string; cfg: AuthConfig }>>> = {
  session_login: [
    { label: "Vault AppRole", cfg: { login_path: "/v1/auth/approle/login", login_method: "POST", login_body: { role_id: "{{secret:role_id}}", secret_id: "{{secret:secret_id}}" }, token_path: "auth.client_token", ttl_path: "auth.lease_duration", header: "X-Vault-Token", prefix: "" } },
    { label: "Vault Kubernetes", cfg: { login_path: "/v1/auth/kubernetes/login", login_method: "POST", login_body: { role: "founderos", jwt: "{{secret:jwt}}" }, token_path: "auth.client_token", ttl_path: "auth.lease_duration", header: "X-Vault-Token", prefix: "" } },
    { label: "Argo CD (session)", cfg: { login_path: "/api/v1/session", login_method: "POST", login_body: { username: "{{secret:username}}", password: "{{secret:password}}" }, token_path: "token", ttl_seconds: 3600, header: "Authorization", prefix: "Bearer " } },
  ],
  headers: [
    { label: "Cloudflare Access", cfg: { header_names: ["CF-Access-Client-Id", "CF-Access-Client-Secret"] } },
  ],
  bearer: [
    { label: "Vault (jeton)", cfg: { header: "X-Vault-Token", prefix: "" } },
    { label: "Authorization: Bearer", cfg: { header: "Authorization", prefix: "Bearer " } },
  ],
  api_key: [
    { label: "GitLab (PRIVATE-TOKEN)", cfg: { in: "header", name: "PRIVATE-TOKEN" } },
  ],
};

function AuthConfigEditor({ draft, readOnly, setScheme, setCfg, connectorId }: {
  draft: Draft;
  readOnly: boolean;
  setScheme: (s: AuthScheme) => void;
  setCfg: (p: Partial<AuthConfig>) => void;
  connectorId: string;
}) {
  const toast = useToast();
  const cfg = draft.auth_config;
  const scheme = draft.auth_scheme;
  const [bodyText, setBodyText] = useState(JSON.stringify(cfg.login_body ?? {}, null, 2));
  const [discovering, setDiscovering] = useState(false);
  const meta = AUTH_SCHEMES.find((s) => s.key === scheme);
  const oauth = scheme === "oauth2_client_credentials" || scheme === "oauth2_authorization_code";

  async function discover() {
    if (!cfg.issuer) return;
    setDiscovering(true);
    try {
      const r = await connectorAction<{ ok: boolean; authorize_url?: string; token_url?: string; error?: string }>({ mode: "custom.discover_oidc", connector_id: connectorId, issuer: cfg.issuer });
      if (!r.ok) throw new Error(r.error ?? "échec");
      setCfg({ token_url: r.token_url || cfg.token_url, authorize_url: r.authorize_url || cfg.authorize_url });
      toast.success("Points d'accès OIDC trouvés");
    } catch (e) {
      toast.error("Découverte OIDC impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setDiscovering(false);
    }
  }

  return (
    <div className="space-y-4">
      <SectionTitle>Schéma d'authentification</SectionTitle>
      <Field label="Comment l'outil reconnaît le collaborateur" hint={meta?.hint}>
        <select className={selectCls} disabled={readOnly} value={scheme} onChange={(e) => setScheme(e.target.value as AuthScheme)}>
          {AUTH_SCHEMES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </Field>
      {!readOnly && AUTH_PRESETS[scheme] && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Préréglages :</span>
          {AUTH_PRESETS[scheme]!.map((p) => (
            <button key={p.label} type="button" className="rounded-full border border-border px-2.5 py-0.5 text-[11px] hover:bg-secondary/50"
              onClick={() => { setCfg(p.cfg); if (p.cfg.login_body) setBodyText(JSON.stringify(p.cfg.login_body, null, 2)); }}>
              {p.label}
            </button>
          ))}
        </div>
      )}

      {scheme === "bearer" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="En-tête"><input className={inputCls} disabled={readOnly} value={cfg.header ?? "Authorization"} onChange={(e) => setCfg({ header: e.target.value })} /></Field>
          <Field label="Préfixe" hint="Vide pour Vault (X-Vault-Token)."><input className={inputCls} disabled={readOnly} value={cfg.prefix ?? "Bearer "} onChange={(e) => setCfg({ prefix: e.target.value })} /></Field>
        </div>
      )}
      {scheme === "api_key" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Emplacement">
            <select className={selectCls} disabled={readOnly} value={cfg.in ?? "header"} onChange={(e) => setCfg({ in: e.target.value as "header" | "query" })}>
              <option value="header">En-tête</option><option value="query">Paramètre d'URL</option>
            </select>
          </Field>
          <Field label="Nom"><input className={inputCls} disabled={readOnly} placeholder="X-API-Key" value={cfg.name ?? ""} onChange={(e) => setCfg({ name: e.target.value })} /></Field>
        </div>
      )}
      {scheme === "basic" && (
        <Field label="Identifiant" hint="Le mot de passe ou jeton se saisit dans un profil d'identifiants.">
          <input className={inputCls} disabled={readOnly} value={cfg.username ?? ""} onChange={(e) => setCfg({ username: e.target.value })} />
        </Field>
      )}
      {scheme === "headers" && (
        <Field label="Noms des en-têtes secrets" hint="Un par ligne. Leurs valeurs se saisissent dans un profil.">
          <textarea className={textareaCls} rows={3} disabled={readOnly} value={(cfg.header_names ?? []).join("\n")}
            onChange={(e) => setCfg({ header_names: lines(e.target.value) })} />
        </Field>
      )}
      {oauth && (
        <>
          <div className="flex items-end gap-2">
            <Field label="Émetteur OIDC (optionnel)" hint="Keycloak, Okta, Entra ID, Dex… pour remplir les URL automatiquement." className="flex-1">
              <input className={cn(inputCls, "font-mono")} disabled={readOnly} placeholder="https://sso.interne.exemple/realms/corp" value={cfg.issuer ?? ""}
                onChange={(e) => setCfg({ issuer: e.target.value })} />
            </Field>
            {!readOnly && (
              <Button size="sm" variant="outline" className="mb-[22px]" onClick={discover} disabled={!cfg.issuer || discovering}>
                {discovering ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Search className="mr-1 h-3.5 w-3.5" />} Découvrir
              </Button>
            )}
          </div>
          {scheme === "oauth2_authorization_code" && (
            <Field label="URL d'autorisation"><input className={cn(inputCls, "font-mono")} disabled={readOnly} value={cfg.authorize_url ?? ""} onChange={(e) => setCfg({ authorize_url: e.target.value })} /></Field>
          )}
          <Field label="URL du serveur de jetons"><input className={cn(inputCls, "font-mono")} disabled={readOnly} value={cfg.token_url ?? ""} onChange={(e) => setCfg({ token_url: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="client_id"><input className={inputCls} disabled={readOnly} value={cfg.client_id ?? ""} onChange={(e) => setCfg({ client_id: e.target.value })} /></Field>
            <Field label="Envoi du secret client">
              <select className={selectCls} disabled={readOnly} value={cfg.client_auth ?? "body"} onChange={(e) => setCfg({ client_auth: e.target.value as "body" | "basic" })}>
                <option value="body">Dans le corps (client_secret_post)</option><option value="basic">En-tête Basic (client_secret_basic)</option>
              </select>
            </Field>
            <Field label="Scopes"><input className={inputCls} disabled={readOnly} value={cfg.scope ?? ""} onChange={(e) => setCfg({ scope: e.target.value })} /></Field>
            <Field label="Audience (optionnel)"><input className={inputCls} disabled={readOnly} value={cfg.audience ?? ""} onChange={(e) => setCfg({ audience: e.target.value })} /></Field>
          </div>
        </>
      )}
      {scheme === "session_login" && (
        <>
          <div className="grid gap-3 sm:grid-cols-[110px_1fr]">
            <Field label="Méthode">
              <select className={selectCls} disabled={readOnly} value={cfg.login_method ?? "POST"} onChange={(e) => setCfg({ login_method: e.target.value as "POST" | "PUT" })}>
                <option>POST</option><option>PUT</option>
              </select>
            </Field>
            <Field label="Chemin de connexion"><input className={cn(inputCls, "font-mono")} disabled={readOnly} value={cfg.login_path ?? ""} onChange={(e) => setCfg({ login_path: e.target.value })} /></Field>
          </div>
          <Field label="Corps de connexion (JSON)" hint="Les secrets s'écrivent {{secret:nom}} : chaque nom devient un champ du profil d'identifiants.">
            <textarea className={textareaCls} rows={4} disabled={readOnly} value={bodyText} onChange={(e) => setBodyText(e.target.value)}
              onBlur={() => { try { setCfg({ login_body: JSON.parse(bodyText || "{}") }); } catch { toast.error("Corps de connexion : JSON invalide"); } }} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Chemin du jeton dans la réponse" hint="Ex. token, auth.client_token."><input className={inputCls} disabled={readOnly} value={cfg.token_path ?? ""} onChange={(e) => setCfg({ token_path: e.target.value })} /></Field>
            <Field label="Chemin de la durée (s)" hint="Ex. auth.lease_duration. Sinon la durée fixe."><input className={inputCls} disabled={readOnly} value={cfg.ttl_path ?? ""} onChange={(e) => setCfg({ ttl_path: e.target.value })} /></Field>
            <Field label="En-tête du jeton"><input className={inputCls} disabled={readOnly} value={cfg.header ?? "Authorization"} onChange={(e) => setCfg({ header: e.target.value })} /></Field>
            <Field label="Préfixe"><input className={inputCls} disabled={readOnly} value={cfg.prefix ?? "Bearer "} onChange={(e) => setCfg({ prefix: e.target.value })} /></Field>
          </div>
        </>
      )}
      {scheme === "mtls" && (
        <p className="text-xs text-muted-foreground">Le certificat client et sa clé se placent dans un profil, de préférence détenu par le relais (file:/chemin/vers/client.pem).</p>
      )}
      <Field label="En-têtes fixes (non secrets)" hint="nom=valeur, un par ligne : X-Scope-OrgID pour Loki, X-Vault-Namespace pour Vault Enterprise.">
        <textarea className={textareaCls} rows={2} disabled={readOnly} defaultValue={kv(cfg.extra_headers)}
          onBlur={(e) => setCfg({ extra_headers: parseKv(e.target.value) })} />
      </Field>
    </div>
  );
}

function PolicyEditor({ policy, setPolicy, readOnly }: { policy: ConnectorPolicy; setPolicy: (p: Partial<ConnectorPolicy>) => void; readOnly: boolean }) {
  const RAW: HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
  return (
    <div className="space-y-5">
      <div>
        <SectionTitle>Approbations</SectionTitle>
        <div className="grid gap-2 sm:grid-cols-3">
          {([
            { v: "writes", t: "Écritures", d: "Lectures directes. Écritures selon l'autonomie du collaborateur. Les gestes irréversibles attendent toujours un humain." },
            { v: "destructive_only", t: "Irréversible seulement", d: "Écritures et lectures directes. Les gestes irréversibles attendent un humain." },
            { v: "all", t: "Tout", d: "Chaque appel, même une lecture, attend une approbation humaine." },
          ] as const).map((o) => (
            <button key={o.v} type="button" disabled={readOnly} onClick={() => setPolicy({ approval: o.v })}
              className={cn("rounded-lg border p-3 text-left transition-colors", policy.approval === o.v ? "border-primary/60 bg-primary/5" : "border-border hover:bg-secondary/40")}>
              <span className="block text-xs font-medium">{o.t}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{o.d}</span>
            </button>
          ))}
        </div>
      </div>
      <Toggle disabled={readOnly} checked={policy.read_only} onChange={(v) => setPolicy({ read_only: v })}
        label="Lecture seule" hint="Toute opération d'écriture est refusée, quelle que soit sa déclaration." />
      <div className="space-y-2">
        <Toggle disabled={readOnly} checked={policy.allow_raw} onChange={(v) => setPolicy({ allow_raw: v })}
          label="Autoriser la requête brute" hint="Le collaborateur choisit méthode et chemin, dans les limites ci-dessous. Utile pour explorer une API (Grafana, Prometheus) ; à éviter sur un outil d'écriture." />
        {policy.allow_raw && (
          <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <span className="text-xs font-medium">Méthodes permises</span>
              <div className="mt-1.5 flex flex-wrap gap-3">
                {RAW.map((m) => (
                  <label key={m} className="flex items-center gap-1.5 font-mono text-xs">
                    <input type="checkbox" disabled={readOnly} checked={policy.raw_methods.includes(m)}
                      onChange={(e) => setPolicy({ raw_methods: e.target.checked ? [...policy.raw_methods, m] : policy.raw_methods.filter((x) => x !== m) })} />
                    {m}
                  </label>
                ))}
              </div>
            </div>
            <Field label="Chemins autorisés" hint="Préfixes, un par ligne, * accepté. Obligatoire : vide, tout est refusé.">
              <textarea className={textareaCls} rows={4} disabled={readOnly} defaultValue={policy.path_allowlist.join("\n")}
                placeholder={"/api/v1/\n/loki/api/v1/"} onBlur={(e) => setPolicy({ path_allowlist: lines(e.target.value) })} />
            </Field>
            <Field label="Chemins interdits" hint="Prioritaires sur les autorisés.">
              <textarea className={textareaCls} rows={4} disabled={readOnly} defaultValue={policy.path_denylist.join("\n")}
                placeholder="/api/admin/" onBlur={(e) => setPolicy({ path_denylist: lines(e.target.value) })} />
            </Field>
          </div>
        )}
      </div>
      <div>
        <SectionTitle>Réponses</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Ce que lit le collaborateur" hint="Le masquage cible les champs et formats de secrets connus (jetons, clés, JWT, clés privées).">
            <select className={selectCls} disabled={readOnly} value={policy.output} onChange={(e) => setPolicy({ output: e.target.value as ConnectorPolicy["output"] })}>
              <option value="redact">Secrets masqués</option><option value="full">Réponse intégrale</option>
            </select>
          </Field>
          <Field label="Champs à masquer en plus" hint="Noms de champs, séparés par des virgules.">
            <input className={inputCls} disabled={readOnly} defaultValue={policy.redact_fields.join(", ")}
              onBlur={(e) => setPolicy({ redact_fields: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
          </Field>
          <Field label="Taille maximale lue (Ko)">
            <input type="number" className={inputCls} disabled={readOnly} value={policy.max_response_kb} onChange={(e) => setPolicy({ max_response_kb: Number(e.target.value) || 64 })} />
          </Field>
          <Field label="Appels maximum par minute">
            <input type="number" className={inputCls} disabled={readOnly} value={policy.rate_limit_per_min} onChange={(e) => setPolicy({ rate_limit_per_min: Number(e.target.value) || 60 })} />
          </Field>
        </div>
      </div>
      <Toggle disabled={readOnly} checked={policy.trace_headers} onChange={(v) => setPolicy({ trace_headers: v })}
        label="En-têtes de traçage" hint="X-Request-Id, X-FounderOS-Collaborator et X-FounderOS-Run sur chaque appel : retrouvez dans les journaux de l'outil (Loki, Argo CD) quel collaborateur a fait quoi." />
    </div>
  );
}
