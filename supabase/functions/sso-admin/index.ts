// sso-admin — enregistre les fournisseurs SSO de l'instance dans Supabase Auth.
//
// Body : { action, workspace_id, ... }
//   status                       → { enabled, claimed, is_home, can_manage, saml }
//   test     { provider }        → vérifie l'issuer OIDC ou les métadonnées SAML,
//                                  sans rien enregistrer
//   save     { provider }        → crée ou met à jour, dans l'Auth puis ici
//   delete   { provider_id }
//   settings { sso_only }               (dédié : toute l'installation)
//
// Domaines (mode partagé, migration 0282) :
//   domain_add      { domain }           → le jeton à publier en TXT _founderos-sso.<domaine>
//   domain_verify   { domain_id }        → lit le DNS ; vérifié, le domaine est à cette organisation
//   domain_remove   { domain_id }
//   domain_settings { domain_id, sso_only }
//
// Délégation aux agents (docs/enterprise-generalisation.md G1, migration 0276) :
//   save     { provider: { …, delegation, subject_claim } } — le point de jeton
//            est lu dans le document de découverte, le secret client gardé chiffré
//   agent_identity_save   { agent_id, provider_id, client_id, client_secret?, user_scope? }
//   agent_identity_delete { id }
//   delegation_test       { provider_id, agent_id?, audience? } → un jeton est-il émis ?
//
// DEUX MODES (_shared/sso-domains.ts)
// Un fournisseur d'identité est global à l'instance Supabase. Sur une instance
// partagée par plusieurs clients, une organisation pourrait donc déclarer un
// IdP qui revendique les adresses d'une autre.
//   Partagé (défaut, le cloud) : chaque organisation configure son SSO, pour
//   les seuls domaines qu'elle a vérifiés en DNS. La base refuse toute
//   connexion SSO hors de ces domaines (0282) ; sans cette garde installée, le
//   mode reste fermé.
//   Dédié (SSO_MODE=dedicated, ou l'ancien SSO_ADMIN_ENABLED=1) : la première
//   organisation qui enregistre un fournisseur devient l'organisation « maison »
//   de l'installation (enterprise_sso_settings) ; il faut en être owner pour la
//   revendiquer. Ensuite, ses owners et admins seuls gèrent le SSO, et les
//   comptes SSO n'entrent que dans cette organisation.
//   SSO_MODE=off ferme tout.
//
// Les correspondances groupe → rôle ne passent pas par ici : elles s'écrivent
// depuis l'interface, sous RLS (enterprise_sso_role_mappings).

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { requireWorkspaceMember } from "../_shared/authz.ts";
import { decryptSecret, encryptSecret } from "../_shared/crypto.ts";
import { resetIdpDirectoryCache } from "../_shared/idp-directory.ts";
import { postToken, type IdpConfig } from "../_shared/idp-tokens.ts";
import { entraScopeFor } from "../_shared/mcp-auth.ts";
import {
  configuredSsoMode, DOMAIN_RE as SSO_DOMAIN_RE, effectiveSsoMode, newVerificationToken, sharedAuthRef, verificationRecordName, verifyDomainTxt,
} from "../_shared/sso-domains.ts";

type Protocol = "oidc" | "saml";
type Delegation = "none" | "token_exchange" | "entra_obo";

interface ProviderInput {
  id?: string;
  protocol: Protocol;
  preset?: "entra" | "keycloak" | "generic";
  name: string;
  /** OIDC : identifiant court, devient « custom:<slug> ». Fixé à la création. */
  slug?: string;
  issuer?: string;
  client_id?: string;
  /** Requis à la création ; vide à la mise à jour = inchangé. */
  client_secret?: string;
  scopes?: string[];
  metadata_url?: string;
  metadata_xml?: string;
  domains?: string[];
  groups_claim?: string;
  groups_attribute?: string;
  email_attribute?: string;
  default_role?: "viewer" | "member" | null;
  enabled?: boolean;
  /** OIDC : l'IdP émet-il des jetons au nom des personnes pour les agents ? */
  delegation?: Delegation;
  /** `sub`, ou `oid` chez Entra ID. */
  subject_claim?: "sub" | "oid";
}

const CLIENT_ID_RE = /^[A-Za-z0-9._:/@-]{1,200}$/;
const SCOPE_RE = /^[A-Za-z0-9._:/ -]{1,300}$/;
const secretHint = (secret: string) => `••••${secret.slice(-4)}`;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CLAIM_RE = /^[A-Za-z0-9_:/.-]{1,200}$/;

class InputError extends Error {}

function bad(message: string): never {
  throw new InputError(message);
}

/** Un IdP interne (Keycloak du réseau) peut n'être joignable qu'en clair en
 *  recette ; en production, https seulement. */
function checkUrl(raw: string | undefined, field: string): string {
  const v = String(raw ?? "").trim().replace(/\/+$/, "");
  let u: URL;
  try { u = new URL(v); } catch { bad(`${field} : URL invalide.`); }
  const insecureOk = Deno.env.get("SSO_ALLOW_HTTP") === "1";
  if (u.protocol !== "https:" && !(insecureOk && u.protocol === "http:")) {
    bad(`${field} : https obligatoire (SSO_ALLOW_HTTP=1 pour une recette en clair).`);
  }
  return v;
}

function normalize(p: ProviderInput, creating: boolean) {
  if (p.protocol !== "oidc" && p.protocol !== "saml") bad("protocol : oidc ou saml.");
  const name = String(p.name ?? "").trim();
  if (!name || name.length > 80) bad("Nom : 1 à 80 caractères.");
  const domains = [...new Set((p.domains ?? []).map((d) => String(d).trim().toLowerCase()).filter(Boolean))];
  for (const d of domains) if (!DOMAIN_RE.test(d)) bad(`Domaine invalide : ${d}`);
  const default_role = p.default_role === "viewer" || p.default_role === "member" ? p.default_role : null;
  const preset = p.preset === "entra" || p.preset === "keycloak" ? p.preset : "generic";

  if (p.protocol === "oidc") {
    const slug = String(p.slug ?? "").trim().toLowerCase();
    if (creating && !SLUG_RE.test(slug)) bad("Identifiant : minuscules, chiffres et tirets, 41 caractères au plus.");
    const issuer = checkUrl(p.issuer, "Issuer");
    const client_id = String(p.client_id ?? "").trim();
    if (!client_id) bad("Client ID requis.");
    const client_secret = String(p.client_secret ?? "").trim();
    if (creating && !client_secret) bad("Secret client requis.");
    const scopes = [...new Set(["openid", ...(p.scopes ?? ["profile", "email"]).map((s) => String(s).trim()).filter(Boolean)])];
    const groups_claim = String(p.groups_claim ?? "groups").trim();
    if (!CLAIM_RE.test(groups_claim)) bad("Claim des groupes invalide.");
    const delegation: Delegation = p.delegation === "token_exchange" || p.delegation === "entra_obo" ? p.delegation : "none";
    const subject_claim = p.subject_claim === "oid" || (p.subject_claim === undefined && preset === "entra") ? "oid" : "sub";
    // L'IdP ne renvoie un jeton de rafraîchissement que si on le demande.
    const withOffline = delegation === "none" ? scopes : [...new Set([...scopes, "offline_access"])];
    return {
      protocol: "oidc" as const, preset, name, slug, issuer, client_id, client_secret, scopes: withOffline, domains, groups_claim, default_role,
      enabled: p.enabled !== false, delegation, subject_claim,
    };
  }

  const metadata_xml = String(p.metadata_xml ?? "").trim();
  if (metadata_xml.length > 200_000) bad("Métadonnées trop volumineuses.");
  if (creating && !metadata_xml && !String(p.metadata_url ?? "").trim()) bad("URL ou XML des métadonnées requis.");
  // À la mise à jour, ni URL ni XML : les métadonnées enregistrées restent.
  const metadata_url = metadata_xml || !String(p.metadata_url ?? "").trim() ? "" : checkUrl(p.metadata_url, "URL des métadonnées");
  const groups_attribute = String(p.groups_attribute ?? "").trim().slice(0, 300) || null;
  const email_attribute = String(p.email_attribute ?? "").trim().slice(0, 300) || null;
  // L'Auth recopie l'attribut SAML sous la clé de mapping : on la fixe, le
  // trigger sait alors toujours où lire.
  return { protocol: "saml" as const, preset, name, metadata_url, metadata_xml, domains, groups_claim: "groups", groups_attribute, email_attribute, default_role, enabled: p.enabled !== false };
}

// ── API admin de Supabase Auth ──────────────────────────────────────────────

async function authAdmin(path: string, method: string, body?: unknown): Promise<any> {
  const base = Deno.env.get("SUPABASE_URL")!.replace(/\/+$/, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const res = await fetch(`${base}/auth/v1/admin${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text } }
  if (!res.ok) {
    const msg = json?.msg ?? json?.message ?? json?.error_description ?? json?.error ?? text;
    const err = new Error(`Supabase Auth (${res.status}) : ${String(msg).slice(0, 300)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return json;
}

function samlAttributeMapping(groupsAttr: string | null, emailAttr: string | null) {
  const keys: Record<string, unknown> = {};
  if (groupsAttr) keys.groups = { name: groupsAttr, array: true };
  if (emailAttr) keys.email = { name: emailAttr };
  return { keys };
}

// ── Vérifications sans enregistrement ───────────────────────────────────────

async function fetchText(url: string, timeoutMs = 8000): Promise<{ status: number; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    return { status: res.status, text: (await res.text()).slice(0, 300_000) };
  } finally {
    clearTimeout(t);
  }
}

function samlSummary(xml: string) {
  if (!/EntityDescriptor/.test(xml)) return { ok: false, detail: "Ce document n'est pas une métadonnée SAML (EntityDescriptor absent)." };
  const entityId = /entityID="([^"]+)"/.exec(xml)?.[1] ?? null;
  const sso = /SingleSignOnService[^>]*Location="([^"]+)"/.exec(xml)?.[1] ?? null;
  if (!/IDPSSODescriptor/.test(xml)) return { ok: false, detail: "Pas de IDPSSODescriptor : ce sont peut-être les métadonnées d'un fournisseur de service.", entity_id: entityId };
  return { ok: true, entity_id: entityId, sso_url: sso, signing_cert: /X509Certificate/.test(xml) };
}

async function testProvider(n: ReturnType<typeof normalize>) {
  if (n.protocol === "oidc") {
    const { status, text } = await fetchText(`${n.issuer}/.well-known/openid-configuration`);
    if (status !== 200) return { ok: false, detail: `Document de découverte introuvable (HTTP ${status}).` };
    let doc: any;
    try { doc = JSON.parse(text); } catch { return { ok: false, detail: "Le document de découverte n'est pas du JSON." }; }
    const declared = String(doc.issuer ?? "").replace(/\/+$/, "");
    if (declared !== n.issuer) {
      return { ok: false, detail: `L'IdP se déclare « ${doc.issuer} » : saisissez exactement cet issuer, sinon la vérification des jetons échouera.` };
    }
    return {
      ok: true,
      issuer: doc.issuer,
      authorization_endpoint: doc.authorization_endpoint,
      token_endpoint: doc.token_endpoint,
      jwks_uri: doc.jwks_uri,
      claims_supported: Array.isArray(doc.claims_supported) ? doc.claims_supported.slice(0, 60) : null,
    };
  }
  if (n.metadata_xml) return samlSummary(n.metadata_xml);
  if (!n.metadata_url) return { ok: false, detail: "Saisissez l'URL ou le XML des métadonnées à tester." };
  const { status, text } = await fetchText(n.metadata_url);
  if (status !== 200) return { ok: false, detail: `Métadonnées inaccessibles (HTTP ${status}).` };
  return samlSummary(text);
}

/** Ce que l'Auth annonce comme fournisseur de service SAML : l'entity ID et
 *  l'URL ACS à donner à l'IdP. Null si SAML n'est pas activé dans l'Auth. */
async function samlServiceProvider() {
  const base = Deno.env.get("SUPABASE_URL")!.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/auth/v1/sso/saml/metadata`, {
      headers: { apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
    });
    if (!res.ok) return null;
    const xml = await res.text();
    return {
      entity_id: /entityID="([^"]+)"/.exec(xml)?.[1] ?? null,
      acs_url: /AssertionConsumerService[^>]*Location="([^"]+)"/.exec(xml)?.[1] ?? null,
    };
  } catch {
    return null;
  }
}

// ── Test de la délégation ───────────────────────────────────────────────────

function claimsOf(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1] ?? "";
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch {
    return {};
  }
}

/**
 * Un jeton est-il émis pour cet agent ? Sans personne en jeu : le compte de
 * service du client de l'agent, puis, s'il y a une audience et que l'IdP fait
 * de l'échange de jeton, l'échange de ce jeton vers elle (ce que l'agent fera
 * au nom d'une personne). Rien n'est conservé.
 */
async function testDelegation(
  admin: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data: p } = await admin.from("enterprise_sso_providers")
    .select("id, auth_ref, issuer, client_id, delegation, token_endpoint, subject_claim")
    .eq("id", String(body.provider_id ?? "")).eq("workspace_id", workspaceId).maybeSingle();
  const provider = p as {
    id: string; auth_ref: string; issuer: string; client_id: string; delegation: Delegation; token_endpoint: string | null; subject_claim: "sub" | "oid";
  } | null;
  if (!provider) return { ok: false, detail: "Fournisseur introuvable." };
  if (provider.delegation === "none" || !provider.token_endpoint) return { ok: false, detail: "Ce fournisseur ne délègue pas aux agents." };
  const { data: secret } = await admin.from("enterprise_sso_provider_secrets").select("provider_id").eq("provider_id", provider.id).maybeSingle();
  if (!secret) return { ok: false, detail: "Secret du client du portail absent : ressaisissez-le sur le fournisseur." };
  if (!body.agent_id) {
    return { ok: true, detail: `Délégation prête : point de jeton ${provider.token_endpoint}, secret du portail conservé.` };
  }

  const { data: ident } = await admin.from("agent_idp_identities")
    .select("client_id, secret_enc, iv").eq("agent_id", String(body.agent_id)).eq("provider_id", provider.id).maybeSingle();
  const identity = ident as { client_id: string; secret_enc: string; iv: string } | null;
  if (!identity) return { ok: false, detail: "Cet agent n'a pas d'identité auprès de ce fournisseur." };
  const clientSecret = await decryptSecret(identity.secret_enc, identity.iv);
  const cfg: IdpConfig = {
    provider: provider.auth_ref, issuer: provider.issuer, tokenEndpoint: provider.token_endpoint, delegation: provider.delegation,
    subjectClaim: provider.subject_claim, portalClientId: provider.client_id, portalClientSecret: "",
  };
  const audience = typeof body.audience === "string" && body.audience.trim() ? body.audience.trim() : null;
  try {
    let tokens = await postToken(cfg, {
      grant_type: "client_credentials", client_id: identity.client_id, client_secret: clientSecret,
      // Entra ID exige une ressource ; Graph répond toujours, faute d'audience.
      ...(provider.delegation === "entra_obo" ? { scope: audience ? entraScopeFor(audience) : "https://graph.microsoft.com/.default" } : {}),
    });
    let step = "compte de service de l'agent";
    if (audience && provider.delegation === "token_exchange") {
      tokens = await postToken(cfg, {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        client_id: identity.client_id, client_secret: clientSecret,
        subject_token: String(tokens.access_token ?? ""),
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        audience,
      });
      step = `échange vers ${audience}`;
    }
    const c = claimsOf(String(tokens.access_token ?? ""));
    return {
      ok: true,
      detail: `Jeton émis (${step}).`,
      claims: {
        aud: c.aud ?? null, azp: c.azp ?? c.appid ?? null, sub: c.sub ?? null,
        scope: c.scope ?? c.scp ?? null, roles: c.roles ?? (c.realm_access as { roles?: unknown } | undefined)?.roles ?? null,
        lifetime_s: typeof c.exp === "number" && typeof c.iat === "number" ? c.exp - c.iat : null,
      },
    };
  } catch (e) {
    return { ok: false, detail: `L'IdP refuse : ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const workspaceId = String(body.workspace_id ?? "");

    const auth = await requireWorkspaceMember(req, workspaceId, "admin");
    if (!auth.ok) return auth.response;

    const admin = createServiceClient();
    const { data: settings } = await admin.from("enterprise_sso_settings").select("*").maybeSingle();
    const mode = effectiveSsoMode(configuredSsoMode(), !!settings);
    // Mode partagé : seulement si la garde des connexions est en place (0282).
    let guardInstalled = true;
    if (mode === "shared") {
      const { data } = await admin.rpc("sso_guard_installed");
      guardInstalled = data === true;
    }
    const enabled = mode !== "off" && guardInstalled;
    const isHome = settings?.home_workspace_id === workspaceId;
    // Partagé : les owners et admins de chaque organisation. Dédié : avant
    // revendication, il faut être owner ; après, owner ou admin de la maison.
    const canManage = enabled && (mode === "shared" ? true : (settings ? isHome : auth.role === "owner"));
    const shared = mode === "shared";

    if (action === "status") {
      return jsonResponse({
        enabled,
        mode,
        guard_installed: guardInstalled,
        claimed: !!settings,
        is_home: isHome,
        can_manage: canManage,
        sso_only: settings?.sso_only ?? false,
        saml: enabled ? await samlServiceProvider() : null,
      });
    }

    if (!enabled) {
      return jsonResponse({
        error: mode === "off"
          ? "Le SSO est désactivé sur cette installation (SSO_MODE=off)."
          : "Le SSO partagé exige la garde des connexions sur auth.identities (migration 0282), qui n'a pas pu être installée : le SSO reste fermé.",
      }, { status: 403 });
    }
    if (!canManage) {
      return jsonResponse({
        error: settings
          ? "Le SSO de cette installation est géré depuis une autre organisation."
          : "Seul un owner peut configurer le SSO de l'installation.",
      }, { status: 403 });
    }

    if (action === "test") {
      const n = normalize(body.provider ?? {}, !body.provider?.id);
      return jsonResponse(await testProvider(n));
    }

    // ── Domaines (mode partagé) ─────────────────────────────────────────────
    if (action.startsWith("domain_")) {
      if (!shared) return jsonResponse({ error: "Installation dédiée : les domaines se déclarent sur le fournisseur, sans vérification." }, { status: 400 });
      if (action === "domain_add") {
        const domain = String(body.domain ?? "").trim().toLowerCase().replace(/\.$/, "");
        if (!SSO_DOMAIN_RE.test(domain)) bad(`Domaine invalide : ${domain}`);
        const { data: taken } = await admin.from("enterprise_sso_domains")
          .select("workspace_id").eq("domain", domain).not("verified_at", "is", null).maybeSingle();
        if (taken && (taken as { workspace_id: string }).workspace_id !== workspaceId) {
          bad("Ce domaine est déjà vérifié par une autre organisation.");
        }
        const { data: existing } = await admin.from("enterprise_sso_domains")
          .select("*").eq("workspace_id", workspaceId).eq("domain", domain).maybeSingle();
        const row = existing ?? (await admin.from("enterprise_sso_domains").insert({
          workspace_id: workspaceId, domain, verification_token: newVerificationToken(), created_by: auth.userId,
        }).select().single()).data;
        if (!row) throw new Error("Domaine non enregistré.");
        return jsonResponse({ ok: true, domain: row, record: { type: "TXT", name: verificationRecordName(domain), value: (row as { verification_token: string }).verification_token } });
      }
      const { data: d } = await admin.from("enterprise_sso_domains")
        .select("*").eq("id", String(body.domain_id ?? "")).eq("workspace_id", workspaceId).maybeSingle();
      const dom = d as { id: string; domain: string; verification_token: string; verified_at: string | null; sso_only: boolean } | null;
      if (!dom) return jsonResponse({ error: "Domaine introuvable." }, { status: 404 });
      if (action === "domain_verify") {
        const check = await verifyDomainTxt(dom.domain, dom.verification_token);
        if (!check.ok) return jsonResponse({ ok: false, detail: check.detail });
        const { error } = await admin.from("enterprise_sso_domains")
          .update({ verified_at: new Date().toISOString(), verified_by: auth.userId }).eq("id", dom.id);
        // L'index unique : une autre organisation l'a vérifié entre-temps.
        if (error) return jsonResponse({ ok: false, detail: "Ce domaine est déjà vérifié par une autre organisation." });
        return jsonResponse({ ok: true, detail: check.detail });
      }
      if (action === "domain_remove") {
        const { data: users } = await admin.from("enterprise_sso_providers")
          .select("name").eq("workspace_id", workspaceId).contains("domains", [dom.domain]);
        if ((users ?? []).length) {
          bad(`Retirez d'abord ce domaine du fournisseur « ${(users as Array<{ name: string }>)[0].name} » : ses comptes ne pourraient plus se connecter.`);
        }
        await admin.from("enterprise_sso_domains").delete().eq("id", dom.id);
        return jsonResponse({ ok: true });
      }
      if (action === "domain_settings") {
        const ssoOnly = body.sso_only === true;
        if (ssoOnly) {
          if (!dom.verified_at) bad("Vérifiez d'abord le domaine.");
          const { count } = await admin.from("enterprise_sso_providers").select("id", { count: "exact", head: true })
            .eq("workspace_id", workspaceId).eq("enabled", true).contains("domains", [dom.domain]);
          if (!count) bad("Activez d'abord un fournisseur pour ce domaine, sinon ses comptes ne pourraient plus se connecter.");
        }
        await admin.from("enterprise_sso_domains").update({ sso_only: ssoOnly }).eq("id", dom.id);
        return jsonResponse({ ok: true, sso_only: ssoOnly });
      }
      return jsonResponse({ error: `Action inconnue : ${action}` }, { status: 400 });
    }

    if (action === "settings") {
      if (shared) return jsonResponse({ error: "Mode partagé : « SSO seulement » se règle par domaine." }, { status: 400 });
      if (!settings) return jsonResponse({ error: "Enregistrez d'abord un fournisseur." }, { status: 400 });
      const ssoOnly = body.sso_only === true;
      if (ssoOnly) {
        const { count } = await admin.from("enterprise_sso_providers")
          .select("id", { count: "exact", head: true }).eq("enabled", true);
        if (!count) return jsonResponse({ error: "Activez au moins un fournisseur avant de masquer la connexion par mot de passe." }, { status: 400 });
      }
      await admin.from("enterprise_sso_settings")
        .update({ sso_only: ssoOnly, updated_by: auth.userId, updated_at: new Date().toISOString() })
        .eq("id", true);
      return jsonResponse({ ok: true, sso_only: ssoOnly });
    }

    if (action === "save") {
      const input = (body.provider ?? {}) as ProviderInput;
      const existing = input.id
        ? (await admin.from("enterprise_sso_providers").select("*").eq("id", input.id).eq("workspace_id", workspaceId).maybeSingle()).data
        : null;
      if (input.id && !existing) return jsonResponse({ error: "Fournisseur introuvable." }, { status: 404 });
      if (existing && existing.protocol !== input.protocol) bad("Le protocole d'un fournisseur ne change pas : créez-en un autre.");
      const n = normalize(input, !existing);

      // Mode partagé : un fournisseur ne vaut que pour des domaines vérifiés par
      // cette organisation. La base refusera toute adresse hors de cette liste.
      if (shared) {
        if (!n.domains.length) bad("Mode partagé : choisissez au moins un domaine vérifié de votre organisation.");
        const { data: verified } = await admin.from("enterprise_sso_domains")
          .select("domain").eq("workspace_id", workspaceId).not("verified_at", "is", null).in("domain", n.domains);
        const ok = new Set(((verified ?? []) as Array<{ domain: string }>).map((v) => v.domain));
        const missing = n.domains.filter((d) => !ok.has(d));
        if (missing.length) bad(`Domaine non vérifié par votre organisation : ${missing.join(", ")}. Vérifiez-le d'abord (onglet Domaines).`);
      }

      // Délégation : il faut le secret du client du portail pour rafraîchir le
      // jeton des personnes, et le point de jeton de l'IdP. Vérifié AVANT
      // d'écrire quoi que ce soit dans l'Auth.
      let tokenEndpoint: string | null = null;
      if (n.protocol === "oidc" && n.delegation !== "none") {
        if (!n.client_secret && existing) {
          const { data: stored } = await admin.from("enterprise_sso_provider_secrets")
            .select("provider_id").eq("provider_id", existing.id).maybeSingle();
          if (!stored) bad("Délégation : ressaisissez le secret client, FounderOS doit le garder pour rafraîchir le jeton des personnes.");
        }
        const found = await testProvider(n);
        if (!found.ok || typeof (found as { token_endpoint?: unknown }).token_endpoint !== "string") {
          bad(`Délégation : point de jeton introuvable dans la découverte de l'IdP (${(found as { detail?: string }).detail ?? "token_endpoint absent"}).`);
        }
        tokenEndpoint = checkUrl((found as { token_endpoint: string }).token_endpoint, "Point de jeton");
      }

      let authRef: string = existing?.auth_ref ?? "";
      if (n.protocol === "oidc") {
        if (!existing) {
          authRef = shared ? sharedAuthRef(workspaceId, n.slug) : `custom:${n.slug}`;
          await authAdmin("/custom-providers", "POST", {
            provider_type: "oidc", identifier: authRef, name: n.name,
            client_id: n.client_id, client_secret: n.client_secret, issuer: n.issuer, scopes: n.scopes,
          });
        } else {
          await authAdmin(`/custom-providers/${authRef}`, "PUT", {
            name: n.name, client_id: n.client_id, issuer: n.issuer, scopes: n.scopes,
            ...(n.client_secret ? { client_secret: n.client_secret } : {}),
          });
        }
      } else {
        const payload = {
          ...(n.metadata_xml ? { metadata_xml: n.metadata_xml } : n.metadata_url ? { metadata_url: n.metadata_url } : {}),
          domains: n.domains,
          attribute_mapping: samlAttributeMapping(n.groups_attribute, n.email_attribute),
          disabled: !n.enabled,
        };
        if (!existing) {
          const created = await authAdmin("/sso/providers", "POST", { type: "saml", ...payload });
          authRef = String(created?.id ?? "");
          if (!authRef) throw new Error("Supabase Auth n'a pas renvoyé l'identifiant du fournisseur SAML.");
        } else {
          await authAdmin(`/sso/providers/${authRef}`, "PUT", payload);
        }
      }

      if (!settings && !shared) {
        await admin.from("enterprise_sso_settings").insert({ id: true, home_workspace_id: workspaceId, updated_by: auth.userId });
      }

      const row = {
        workspace_id: workspaceId,
        protocol: n.protocol,
        preset: n.preset,
        auth_ref: authRef,
        name: n.name,
        domains: n.domains,
        issuer: n.protocol === "oidc" ? n.issuer : null,
        client_id: n.protocol === "oidc" ? n.client_id : null,
        metadata_url: n.protocol === "saml" ? (n.metadata_url || existing?.metadata_url || null) : null,
        groups_claim: n.groups_claim,
        groups_attribute: n.protocol === "saml" ? n.groups_attribute : null,
        email_attribute: n.protocol === "saml" ? n.email_attribute : null,
        default_role: n.default_role,
        enabled: n.enabled,
        delegation: n.protocol === "oidc" ? n.delegation : "none",
        token_endpoint: tokenEndpoint,
        subject_claim: n.protocol === "oidc" ? n.subject_claim : "sub",
        updated_at: new Date().toISOString(),
      };
      const saved = existing
        ? await admin.from("enterprise_sso_providers").update(row).eq("id", existing.id).select().single()
        : await admin.from("enterprise_sso_providers").insert({ ...row, created_by: auth.userId }).select().single();
      if (saved.error) throw new Error(saved.error.message);
      const providerId = (saved.data as { id: string }).id;
      if (n.protocol === "oidc" && n.delegation !== "none" && n.client_secret) {
        const { ciphertext, iv } = await encryptSecret(n.client_secret);
        const { error } = await admin.from("enterprise_sso_provider_secrets").upsert({
          provider_id: providerId, secret_enc: ciphertext, iv, updated_by: auth.userId, updated_at: new Date().toISOString(),
        });
        if (error) throw new Error(error.message);
      } else if (n.protocol === "oidc" && n.delegation === "none") {
        // Plus de délégation : plus de raison de garder le secret.
        await admin.from("enterprise_sso_provider_secrets").delete().eq("provider_id", providerId);
      }
      resetIdpDirectoryCache();
      return jsonResponse({ ok: true, provider: saved.data });
    }

    if (action === "agent_identity_save") {
      const providerId = String(body.provider_id ?? "");
      const agentId = String(body.agent_id ?? "");
      const clientId = String(body.client_id ?? "").trim();
      const clientSecret = String(body.client_secret ?? "").trim();
      const userScope = String(body.user_scope ?? "").trim() || null;
      if (!CLIENT_ID_RE.test(clientId)) bad("Client ID de l'agent invalide.");
      if (userScope && !SCOPE_RE.test(userScope)) bad("Portée invalide.");
      const { data: provider } = await admin.from("enterprise_sso_providers")
        .select("id, delegation").eq("id", providerId).eq("workspace_id", workspaceId).maybeSingle();
      if (!provider) return jsonResponse({ error: "Fournisseur introuvable." }, { status: 404 });
      if ((provider as { delegation: string }).delegation === "none") bad("Ce fournisseur ne délègue pas aux agents : activez d'abord la délégation.");
      const { data: agent } = await admin.from("internal_agents")
        .select("id").eq("id", agentId).eq("workspace_id", workspaceId).maybeSingle();
      if (!agent) return jsonResponse({ error: "Agent introuvable dans cette organisation." }, { status: 404 });
      const { data: existing } = await admin.from("agent_idp_identities")
        .select("id").eq("agent_id", agentId).eq("provider_id", providerId).maybeSingle();
      if (!existing && !clientSecret) bad("Secret du client de l'agent requis.");
      const enc = clientSecret ? await encryptSecret(clientSecret) : null;
      const fields = {
        client_id: clientId, user_scope: userScope, updated_at: new Date().toISOString(),
        ...(enc ? { secret_enc: enc.ciphertext, iv: enc.iv, secret_hint: secretHint(clientSecret) } : {}),
      };
      const out = existing
        ? await admin.from("agent_idp_identities").update(fields).eq("id", (existing as { id: string }).id)
          .select("id, agent_id, provider_id, client_id, user_scope, secret_hint, updated_at").single()
        : await admin.from("agent_idp_identities").insert({
          ...fields, agent_id: agentId, provider_id: providerId, workspace_id: workspaceId, created_by: auth.userId,
        }).select("id, agent_id, provider_id, client_id, user_scope, secret_hint, updated_at").single();
      if (out.error) throw new Error(out.error.message);
      return jsonResponse({ ok: true, identity: out.data });
    }

    if (action === "agent_identity_delete") {
      const { error } = await admin.from("agent_idp_identities")
        .delete().eq("id", String(body.id ?? "")).eq("workspace_id", workspaceId);
      if (error) throw new Error(error.message);
      return jsonResponse({ ok: true });
    }

    if (action === "delegation_test") {
      return jsonResponse(await testDelegation(admin, workspaceId, body));
    }

    if (action === "delete") {
      const { data: p } = await admin.from("enterprise_sso_providers")
        .select("*").eq("id", String(body.provider_id ?? "")).eq("workspace_id", workspaceId).maybeSingle();
      if (!p) return jsonResponse({ error: "Fournisseur introuvable." }, { status: 404 });
      const path = p.protocol === "oidc" ? `/custom-providers/${p.auth_ref}` : `/sso/providers/${p.auth_ref}`;
      try {
        await authAdmin(path, "DELETE");
      } catch (e) {
        // Déjà retiré de l'Auth (à la main, ou une tentative précédente) : on
        // termine le ménage ici.
        if ((e as { status?: number }).status !== 404) throw e;
      }
      await admin.from("enterprise_sso_providers").delete().eq("id", p.id);
      if (shared) {
        // Un domaine « SSO seulement » sans fournisseur actif : ses comptes
        // doivent retrouver le mot de passe.
        const { data: doms } = await admin.from("enterprise_sso_domains").select("id, domain").eq("workspace_id", workspaceId).eq("sso_only", true);
        for (const d of (doms ?? []) as Array<{ id: string; domain: string }>) {
          const { count } = await admin.from("enterprise_sso_providers").select("id", { count: "exact", head: true })
            .eq("workspace_id", workspaceId).eq("enabled", true).contains("domains", [d.domain]);
          if (!count) await admin.from("enterprise_sso_domains").update({ sso_only: false }).eq("id", d.id);
        }
        return jsonResponse({ ok: true });
      }
      // Plus aucun fournisseur actif : la page de connexion doit retrouver le
      // mot de passe, sinon plus personne n'entre.
      const { count } = await admin.from("enterprise_sso_providers")
        .select("id", { count: "exact", head: true }).eq("enabled", true);
      if (!count) await admin.from("enterprise_sso_settings").update({ sso_only: false }).eq("id", true);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: `Action inconnue : ${action}` }, { status: 400 });
  } catch (e) {
    const status = e instanceof InputError ? 400 : 500;
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
});
