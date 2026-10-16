// SSO d'entreprise : les appels du front.
//
// Les fournisseurs vivent dans Supabase Auth et ne s'enregistrent que par la
// fonction sso-admin. Les correspondances groupe → rôle et le journal se lisent
// et s'écrivent directement, sous RLS (owners et admins de l'organisation).
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { SUPABASE_URL } from "@/lib/runtime-config";

export type SsoProtocol = "oidc" | "saml";
export type SsoPreset = "entra" | "keycloak" | "generic";
export type MappedRole = "admin" | "member" | "viewer";
/** Comment l'IdP émet un jeton au nom d'une personne pour un agent (G1). */
export type Delegation = "none" | "token_exchange" | "entra_obo";

export interface SsoLoginProvider {
  id: string;
  protocol: SsoProtocol;
  preset: SsoPreset;
  /** OIDC : « custom:xxx ». SAML : l'UUID du fournisseur dans l'Auth. */
  ref: string;
  name: string;
  domains: string[];
}

export interface SsoLoginOptions {
  /** dedicated : les boutons des fournisseurs ; shared : la découverte par adresse (0282). */
  mode?: "dedicated" | "shared";
  discovery?: boolean;
  sso_only: boolean;
  providers: SsoLoginProvider[];
}

/** Le fournisseur d'une adresse (mode partagé) : de quoi rediriger, rien de plus. */
export interface SsoDiscovery extends SsoLoginProvider {
  sso_only: boolean;
}

/** Un domaine e-mail de l'organisation (0282), vérifié par un enregistrement DNS TXT. */
export interface SsoDomain {
  id: string;
  domain: string;
  verification_token: string;
  verified_at: string | null;
  sso_only: boolean;
  created_at: string;
}

export interface SsoProvider {
  id: string;
  workspace_id: string;
  protocol: SsoProtocol;
  preset: SsoPreset;
  auth_ref: string;
  name: string;
  domains: string[];
  issuer: string | null;
  client_id: string | null;
  metadata_url: string | null;
  groups_claim: string;
  groups_attribute: string | null;
  email_attribute: string | null;
  default_role: "viewer" | "member" | null;
  enabled: boolean;
  delegation: Delegation;
  token_endpoint: string | null;
  subject_claim: "sub" | "oid";
  created_at: string;
}

/** Le client d'un agent auprès de l'IdP (le secret ne revient jamais au navigateur). */
export interface AgentIdentity {
  id: string;
  agent_id: string;
  provider_id: string;
  client_id: string;
  user_scope: string | null;
  secret_hint: string | null;
  updated_at: string;
}

export interface DelegationTestResult {
  ok: boolean;
  detail: string;
  claims?: { aud: unknown; azp: unknown; sub: unknown; scope: unknown; roles: unknown; lifetime_s: number | null };
}

export interface SsoRoleMapping {
  id: string;
  provider_id: string;
  workspace_id: string;
  idp_value: string;
  role: MappedRole;
  label: string | null;
}

export interface SsoLogin {
  id: number;
  provider_id: string | null;
  email: string | null;
  idp_values: string[];
  claim_found: boolean;
  role_applied: string | null;
  action: "granted" | "updated" | "unchanged" | "revoked" | "denied" | "kept_manual";
  created_at: string;
}

export interface SsoStatus {
  enabled: boolean;
  /** shared : chaque organisation, ses domaines vérifiés ; dedicated : l'organisation « maison » ; off. */
  mode?: "dedicated" | "shared" | "off";
  /** Mode partagé : la garde des connexions de 0282 est-elle en place ? */
  guard_installed?: boolean;
  claimed: boolean;
  is_home: boolean;
  can_manage: boolean;
  sso_only: boolean;
  /** Ce que l'Auth annonce comme fournisseur de service SAML. Null : SAML désactivé. */
  saml: { entity_id: string | null; acs_url: string | null } | null;
}

export interface ProviderDraft {
  id?: string;
  protocol: SsoProtocol;
  preset: SsoPreset;
  name: string;
  slug?: string;
  issuer?: string;
  client_id?: string;
  client_secret?: string;
  scopes?: string[];
  metadata_url?: string;
  metadata_xml?: string;
  domains: string[];
  groups_claim?: string;
  groups_attribute?: string;
  email_attribute?: string;
  default_role: "viewer" | "member" | null;
  enabled: boolean;
  delegation?: Delegation;
  subject_claim?: "sub" | "oid";
}

export interface TestResult {
  ok: boolean;
  detail?: string;
  issuer?: string;
  authorization_endpoint?: string;
  claims_supported?: string[] | null;
  entity_id?: string | null;
  sso_url?: string | null;
  signing_cert?: boolean;
}

/** L'URL publique de l'Auth : celle que voit le navigateur, donc celle à
 *  déclarer chez l'IdP. */
export const AUTH_PUBLIC_URL = `${SUPABASE_URL.replace(/\/+$/, "")}/auth/v1`;
export const OIDC_REDIRECT_URI = `${AUTH_PUBLIC_URL}/callback`;

export const qk = {
  status: (ws: string) => ["sso", "status", ws] as const,
  providers: (ws: string) => ["sso", "providers", ws] as const,
  mappings: (ws: string) => ["sso", "mappings", ws] as const,
  logins: (ws: string) => ["sso", "logins", ws] as const,
  identities: (ws: string) => ["sso", "agent-identities", ws] as const,
  agents: (ws: string) => ["sso", "agents", ws] as const,
  domains: (ws: string) => ["sso", "domains", ws] as const,
};

/** Appelée sans session, depuis la page de connexion. Une erreur (migration
 *  absente, réseau) vaut « pas de SSO » : la connexion par mot de passe reste. */
export async function fetchLoginOptions(): Promise<SsoLoginOptions> {
  const fallback: SsoLoginOptions = { sso_only: false, providers: [] };
  // The sign-in form waits for this answer; a request that never comes back
  // must not leave the page without a form. After a few seconds, no SSO.
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
  const answer = await Promise.race([supabase.rpc("sso_login_options"), timeout]);
  if (!answer || answer.error || !answer.data) return fallback;
  return answer.data as SsoLoginOptions;
}

/** Mode partagé : le fournisseur SSO d'une adresse, ou null. Appelée sans session. */
export async function discoverSso(email: string): Promise<SsoDiscovery | null> {
  const { data, error } = await supabase.rpc("sso_discover", { p_email: email });
  if (error || !data) return null;
  return data as SsoDiscovery;
}

export async function listDomains(workspaceId: string): Promise<SsoDomain[]> {
  const { data, error } = await supabase.from("enterprise_sso_domains")
    .select("id, domain, verification_token, verified_at, sso_only, created_at")
    .eq("workspace_id", workspaceId).order("created_at");
  if (error) throw error;
  return (data ?? []) as SsoDomain[];
}

export function addDomain(workspaceId: string, domain: string) {
  return callEdge<{ ok: true; domain: SsoDomain; record: { type: "TXT"; name: string; value: string } }>(
    "sso-admin", { action: "domain_add", workspace_id: workspaceId, domain },
  );
}

export function verifyDomain(workspaceId: string, domainId: string) {
  return callEdge<{ ok: boolean; detail: string }>("sso-admin", { action: "domain_verify", workspace_id: workspaceId, domain_id: domainId });
}

export function removeDomain(workspaceId: string, domainId: string) {
  return callEdge<{ ok: true }>("sso-admin", { action: "domain_remove", workspace_id: workspaceId, domain_id: domainId });
}

export function saveDomainSsoOnly(workspaceId: string, domainId: string, ssoOnly: boolean) {
  return callEdge<{ ok: true; sso_only: boolean }>("sso-admin", { action: "domain_settings", workspace_id: workspaceId, domain_id: domainId, sso_only: ssoOnly });
}

export function fetchStatus(workspaceId: string) {
  return callEdge<SsoStatus>("sso-admin", { action: "status", workspace_id: workspaceId });
}

export function testProvider(workspaceId: string, provider: ProviderDraft) {
  return callEdge<TestResult>("sso-admin", { action: "test", workspace_id: workspaceId, provider });
}

export function saveProvider(workspaceId: string, provider: ProviderDraft) {
  return callEdge<{ ok: true; provider: SsoProvider }>("sso-admin", { action: "save", workspace_id: workspaceId, provider });
}

export function deleteProvider(workspaceId: string, providerId: string) {
  return callEdge<{ ok: true }>("sso-admin", { action: "delete", workspace_id: workspaceId, provider_id: providerId });
}

export function saveSsoOnly(workspaceId: string, ssoOnly: boolean) {
  return callEdge<{ ok: true; sso_only: boolean }>("sso-admin", { action: "settings", workspace_id: workspaceId, sso_only: ssoOnly });
}

export async function listProviders(workspaceId: string): Promise<SsoProvider[]> {
  const { data, error } = await supabase
    .from("enterprise_sso_providers").select("*")
    .eq("workspace_id", workspaceId).order("created_at");
  if (error) throw error;
  return (data ?? []) as SsoProvider[];
}

export async function listMappings(workspaceId: string): Promise<SsoRoleMapping[]> {
  const { data, error } = await supabase
    .from("enterprise_sso_role_mappings").select("*")
    .eq("workspace_id", workspaceId).order("created_at");
  if (error) throw error;
  return (data ?? []) as SsoRoleMapping[];
}

export async function addMapping(m: Omit<SsoRoleMapping, "id">) {
  const { error } = await supabase.from("enterprise_sso_role_mappings").insert(m);
  if (error) throw new Error(error.code === "23505" ? "Cette valeur a déjà une correspondance." : error.message);
}

export async function removeMapping(id: string) {
  const { error } = await supabase.from("enterprise_sso_role_mappings").delete().eq("id", id);
  if (error) throw error;
}

export async function listLogins(workspaceId: string): Promise<SsoLogin[]> {
  const { data, error } = await supabase
    .from("enterprise_sso_logins").select("*")
    .eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(30);
  if (error) throw error;
  return (data ?? []) as SsoLogin[];
}

/** Un départ de l'organisation (0284) : ce qui a été coupé, pour la trace. */
export interface MemberOffboarding {
  id: number;
  user_id: string;
  role: string | null;
  managed_by: string | null;
  approvals_withdrawn: number;
  idp_tokens_deleted: number;
  idp_roles_cleared: number;
  sessions_revoked: number;
  at: string;
}

export async function listOffboardings(workspaceId: string): Promise<MemberOffboarding[]> {
  const { data, error } = await supabase
    .from("member_offboarding_log").select("*")
    .eq("workspace_id", workspaceId).order("at", { ascending: false }).limit(30);
  if (error) return []; // migration 0284 absente : rien à montrer
  return (data ?? []) as MemberOffboarding[];
}

// ── Délégation aux agents (G1) ──────────────────────────────────────────────

export async function listAgentIdentities(workspaceId: string): Promise<AgentIdentity[]> {
  const { data, error } = await supabase
    .from("agent_idp_identities").select("id, agent_id, provider_id, client_id, user_scope, secret_hint, updated_at")
    .eq("workspace_id", workspaceId).order("created_at");
  if (error) throw error;
  return (data ?? []) as AgentIdentity[];
}

export async function listAgents(workspaceId: string): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await supabase.from("internal_agents").select("id, name").eq("workspace_id", workspaceId).order("name");
  if (error) throw error;
  return (data ?? []) as Array<{ id: string; name: string }>;
}

export function saveAgentIdentity(workspaceId: string, input: {
  agent_id: string; provider_id: string; client_id: string; client_secret?: string; user_scope?: string;
}) {
  return callEdge<{ ok: true; identity: AgentIdentity }>("sso-admin", { action: "agent_identity_save", workspace_id: workspaceId, ...input });
}

export function deleteAgentIdentity(workspaceId: string, id: string) {
  return callEdge<{ ok: true }>("sso-admin", { action: "agent_identity_delete", workspace_id: workspaceId, id });
}

export function testDelegation(workspaceId: string, input: { provider_id: string; agent_id?: string; audience?: string }) {
  return callEdge<DelegationTestResult>("sso-admin", { action: "delegation_test", workspace_id: workspaceId, ...input });
}
