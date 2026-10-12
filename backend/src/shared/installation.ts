// Réglages de l'installation (G4, migration 0283), côté backend Express.
//
// Ce qui était en variables d'environnement se règle aussi depuis
// Administration → Installation. Le backend lit la table au démarrage puis
// chaque minute, et sert ses valeurs au code porté des edge functions par
// Deno.env.get (compat/index.ts) : rien d'autre à changer dans les ~90
// fonctions qui lisent l'environnement.
//
// L'environnement garde la priorité : une variable présente verrouille le
// réglage. Les secrets n'entrent jamais dans la table : l'écran dit seulement
// s'ils sont présents. Seuls les réglages du catalogue ci-dessous sont permis.

import type { SupabaseClient } from "@supabase/supabase-js";
import { setEnvOverlay } from "../compat/index.ts";

export type SettingGroup = "llm" | "connections" | "approvals" | "sso";

export interface SettingSpec {
  key: string;
  label: string;
  group: SettingGroup;
  hint?: string;
  /** Valeurs permises (liste fermée). */
  options?: string[];
  /** Validation d'une valeur non vide. */
  pattern?: RegExp;
  /** Libellé de la forme attendue, pour l'erreur. */
  expects?: string;
  /** Défaut appliqué par le code quand rien n'est réglé (affichage). */
  default?: string;
}

const URL_RE = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/;
const NAME_RE = /^[A-Za-z0-9._:\/-]{1,200}$/;
const HOSTS_RE = /^[A-Za-z0-9.*:-]+(\s*,\s*[A-Za-z0-9.*:-]+)*$/;
const GUID_RE = /^[0-9a-fA-F-]{36}$|^[A-Za-z0-9.-]{3,100}$/;

export const SETTINGS: SettingSpec[] = [
  { key: "LLM_UPSTREAM", label: "Passerelle LLM imposée", group: "llm", options: ["", "litellm", "azure"],
    hint: "Vide : les fournisseurs par défaut de FounderOS. litellm ou azure : tous les appels passent par la passerelle de l'entreprise." },
  { key: "LLM_BASE_URL", label: "LiteLLM : URL", group: "llm", pattern: URL_RE, expects: "une URL http(s)" },
  { key: "LLM_MODEL_DEFAULT", label: "LiteLLM : alias courant", group: "llm", pattern: NAME_RE, expects: "un nom d'alias", default: "ops-default" },
  { key: "LLM_MODEL_HEAVY", label: "LiteLLM : alias de raisonnement", group: "llm", pattern: NAME_RE, expects: "un nom d'alias" },
  { key: "LLM_EMBEDDING_MODEL", label: "LiteLLM : alias d'embeddings", group: "llm", pattern: NAME_RE, expects: "un nom d'alias" },
  { key: "LLM_REASONING", label: "LiteLLM : modèle de raisonnement", group: "llm", options: ["", "0", "1"] },
  { key: "AZURE_OPENAI_BASE_URL", label: "Azure OpenAI : URL", group: "llm", pattern: URL_RE, expects: "une URL http(s)" },
  { key: "AZURE_OPENAI_DEPLOYMENT", label: "Azure OpenAI : déploiement courant", group: "llm", pattern: NAME_RE, expects: "un nom de déploiement" },
  { key: "AZURE_OPENAI_DEPLOYMENT_HEAVY", label: "Azure OpenAI : déploiement de raisonnement", group: "llm", pattern: NAME_RE, expects: "un nom de déploiement" },
  { key: "AZURE_OPENAI_EMBEDDING_DEPLOYMENT", label: "Azure OpenAI : déploiement d'embeddings", group: "llm", pattern: NAME_RE, expects: "un nom de déploiement" },
  { key: "AZURE_OPENAI_REASONING", label: "Azure OpenAI : modèle de raisonnement", group: "llm", options: ["", "0", "1"] },
  { key: "AZURE_OPENAI_TENANT_ID", label: "Azure OpenAI : locataire Entra (sans clé)", group: "llm", pattern: GUID_RE, expects: "un identifiant de locataire" },
  { key: "AZURE_OPENAI_CLIENT_ID", label: "Azure OpenAI : client Entra (sans clé)", group: "llm", pattern: NAME_RE, expects: "un client ID" },
  { key: "LLM_ALLOWED_HOSTS", label: "Autres hôtes LLM permis", group: "llm", pattern: HOSTS_RE, expects: "des hôtes séparés par des virgules" },
  { key: "MCP_INTERNAL_HOSTS", label: "Hôtes des serveurs MCP internes", group: "connections", pattern: HOSTS_RE, expects: "des motifs d'hôtes séparés par des virgules",
    hint: "Seuls ces hôtes reçoivent un jeton d'appel délégué en direct (ex. *.apps-int.*.interne.exemple)." },
  { key: "OPA_URL", label: "OPA (pré-décision des tools MCP)", group: "connections", pattern: URL_RE, expects: "une URL http(s)" },
  { key: "APP_BASE_URL", label: "Adresse publique de l'interface", group: "approvals", pattern: URL_RE, expects: "une URL http(s)",
    hint: "Pour les liens des notifications (écran Approbations)." },
  { key: "APPROVAL_ISSUER", label: "Émetteur des jetons signés par FounderOS", group: "approvals", pattern: URL_RE, expects: "une URL http(s)",
    hint: "iss des jetons d'approbation et des contextes signés : les serveurs MCP et les outils le vérifient." },
  { key: "SSO_DNS_RESOLVER_URL", label: "Résolveur DNS-over-HTTPS (vérification des domaines SSO)", group: "sso", pattern: URL_RE, expects: "une URL http(s)",
    default: "https://cloudflare-dns.com/dns-query" },
];

const SPEC = new Map(SETTINGS.map((s) => [s.key, s]));

/** Les secrets dont l'écran dit seulement s'ils sont présents. */
export const SECRETS: Array<{ key: string; label: string; anyOf?: string[] }> = [
  { key: "SUPABASE_SERVICE_ROLE_KEY", label: "Clé de service Supabase" },
  { key: "CREDENTIAL_ENCRYPTION_KEY", label: "Clé de chiffrement des secrets (32 octets en base64)" },
  { key: "APPROVAL_SIGNING_KEY", label: "Clé de signature des approbations et des contextes signés" },
  { key: "LLM_API_KEY", label: "LiteLLM : clé commune", anyOf: ["LLM_API_KEY", "LLM_AGENT_KEYS"] },
  { key: "LLM_AGENT_KEYS", label: "LiteLLM : clés virtuelles par agent" },
  { key: "AZURE_OPENAI_API_KEY", label: "Azure OpenAI : clé", anyOf: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_CLIENT_SECRET"] },
  { key: "AZURE_OPENAI_CLIENT_SECRET", label: "Azure OpenAI : secret du client Entra" },
  { key: "DEEPSEEK_API_KEY", label: "Fournisseur par défaut : DeepSeek" },
  { key: "GROQ_API_KEY", label: "Fournisseur par défaut : Groq" },
  { key: "APPROVAL_NOTIFY_WEBHOOK", label: "Webhook des approbateurs (Teams, Slack, astreinte)" },
];

export type SettingSource = "env" | "installation" | "default" | "unset";

export interface EffectiveSetting extends Omit<SettingSpec, "pattern"> {
  value: string;
  source: SettingSource;
  /** Fixé par l'environnement : non modifiable à l'écran. */
  locked: boolean;
  stored: string | null;
}

/** Ce que voit le code : l'environnement, sinon le réglage d'installation, sinon le défaut. */
export function effectiveSettings(stored: Record<string, string>, env: Record<string, string | undefined>): EffectiveSetting[] {
  return SETTINGS.map(({ pattern: _pattern, ...spec }) => {
    const fromEnv = env[spec.key];
    const fromDb = stored[spec.key];
    if (fromEnv !== undefined && fromEnv !== "") {
      return { ...spec, value: fromEnv, source: "env", locked: true, stored: fromDb ?? null };
    }
    if (fromDb !== undefined && fromDb !== "") return { ...spec, value: fromDb, source: "installation", locked: false, stored: fromDb };
    if (spec.default) return { ...spec, value: spec.default, source: "default", locked: false, stored: null };
    return { ...spec, value: "", source: "unset", locked: false, stored: null };
  });
}

export class SettingsError extends Error {}

/**
 * Valide des changements : seulement des réglages du catalogue, non verrouillés
 * par l'environnement, à la forme attendue. Vide ou null : retire le réglage.
 */
export function applySettingChanges(
  current: Record<string, string>,
  changes: Record<string, unknown>,
  env: Record<string, string | undefined>,
): { next: Record<string, string>; changed: Array<{ key: string; old: string | null; value: string | null }> } {
  const next = { ...current };
  const changed: Array<{ key: string; old: string | null; value: string | null }> = [];
  for (const [key, raw] of Object.entries(changes)) {
    const spec = SPEC.get(key);
    if (!spec) throw new SettingsError(`Réglage inconnu : ${key}.`);
    if (env[key] !== undefined && env[key] !== "") {
      throw new SettingsError(`${spec.label} est fixé par l'environnement (${key}) : il se change là où l'installation est pilotée.`);
    }
    if (raw !== null && typeof raw !== "string") throw new SettingsError(`${spec.label} : une chaîne est attendue.`);
    const value = (raw ?? "").trim();
    if (value.length > 2000 || /[\r\n\0]/.test(value)) throw new SettingsError(`${spec.label} : valeur trop longue ou sur plusieurs lignes.`);
    if (value && spec.options && !spec.options.includes(value)) {
      throw new SettingsError(`${spec.label} : ${spec.options.filter(Boolean).join(" ou ")} (ou vide).`);
    }
    if (value && spec.pattern && !spec.pattern.test(value)) throw new SettingsError(`${spec.label} : ${spec.expects ?? "valeur invalide"}.`);
    const old = current[key] ?? null;
    if ((old ?? "") === value) continue;
    if (value) next[key] = value; else delete next[key];
    changed.push({ key, old, value: value || null });
  }
  return { next, changed };
}

/** Présent ou non, jamais la valeur. CREDENTIAL_ENCRYPTION_KEY : aussi sa forme. */
export function secretsPresence(env: Record<string, string | undefined>) {
  return SECRETS.map((s) => {
    const present = !!env[s.key];
    let detail: string | null = null;
    if (s.key === "CREDENTIAL_ENCRYPTION_KEY" && present) {
      try {
        if (Buffer.from(env[s.key]!, "base64").length !== 32) detail = "présente, mais pas 32 octets en base64 : les secrets ne se chiffrent pas";
      } catch {
        detail = "illisible";
      }
    }
    return { key: s.key, label: s.label, present, ...(detail ? { detail } : {}) };
  });
}

// ── Qui administre l'installation ───────────────────────────────────────────

export interface AdminContext {
  email: string | null;
  /** INSTALLATION_ADMINS : adresses séparées par des virgules. */
  adminsEnv: string | undefined;
  ownerWorkspaceId: string | null;
  /** L'organisation « maison » du SSO dédié (0272), s'il y en a une. */
  homeWorkspaceId: string | null;
  /** Les rôles de la personne : organisation → rôle. */
  roles: Record<string, string>;
  /** Le nombre d'organisations sur l'instance. */
  workspaceCount: number;
}

/**
 * Administrateur de l'installation : une adresse de INSTALLATION_ADMINS, ou un
 * owner ou admin de l'organisation propriétaire (à défaut, de l'organisation
 * « maison » du SSO dédié).
 *
 * Revendication, sur une instance NEUVE seulement : personne n'administre
 * encore, et la personne est owner de la seule organisation de l'instance. Sur
 * le cloud partagé, il y en a plusieurs : l'exploitant renseigne INSTALLATION_ADMINS.
 */
export function resolveInstallationAdmin(c: AdminContext): { isAdmin: boolean; canClaim: boolean; via: string | null } {
  const listed = (c.adminsEnv ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (c.email && listed.includes(c.email.toLowerCase())) return { isAdmin: true, canClaim: false, via: "INSTALLATION_ADMINS" };
  const owner = c.ownerWorkspaceId ?? c.homeWorkspaceId;
  if (owner) {
    const role = c.roles[owner];
    const ok = role === "owner" || role === "admin";
    return { isAdmin: ok, canClaim: false, via: ok ? (c.ownerWorkspaceId ? "organisation propriétaire" : "organisation du SSO dédié") : null };
  }
  const ownsOnly = c.workspaceCount === 1 && Object.entries(c.roles).some(([, r]) => r === "owner");
  return { isAdmin: false, canClaim: listed.length === 0 && ownsOnly, via: null };
}

// ── Chargement et surcouche de l'environnement ──────────────────────────────

export async function loadInstallationSettings(admin: SupabaseClient): Promise<{ settings: Record<string, string>; ownerWorkspaceId: string | null }> {
  const { data, error } = await admin.from("installation_settings").select("settings, owner_workspace_id").maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { settings?: Record<string, string>; owner_workspace_id?: string | null } | null;
  return { settings: row?.settings ?? {}, ownerWorkspaceId: row?.owner_workspace_id ?? null };
}

/** Ne garde que le catalogue : une ligne écrite à la main ne peut rien injecter d'autre. */
export function overlayFrom(settings: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(settings).filter(([k, v]) => SPEC.has(k) && typeof v === "string" && v !== ""));
}

export function applyInstallationOverlay(settings: Record<string, string>): void {
  setEnvOverlay(overlayFrom(settings));
}

/** Au démarrage, puis chaque minute : les autres réplicas suivent en moins d'une minute. */
export function startInstallationSync(admin: SupabaseClient, everyMs = 60_000): () => void {
  const tick = () => loadInstallationSettings(admin)
    .then(({ settings }) => applyInstallationOverlay(settings))
    .catch(() => { /* table absente (migration 0283) ou base injoignable : l'environnement seul */ });
  void tick();
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
