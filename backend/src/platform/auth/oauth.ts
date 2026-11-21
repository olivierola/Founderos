// Connexion par un fournisseur externe — le flux de GoTrue :
//
//   GET /auth/v1/authorize?provider=…&redirect_to=…[&code_challenge=…]
//     → 302 vers le fournisseur, avec un `state` signé (JWT, 10 min)
//   GET|POST /auth/v1/callback?code=…&state=…
//     → échange du code, profil, compte trouvé ou créé, puis 302 vers
//       redirect_to : `?code=` (PKCE) ou `#access_token=…` (implicite).
//
// Fournisseurs : google, apple, github, azure, keycloak — variables
// GOTRUE_EXTERNAL_<NOM>_ENABLED / _CLIENT_ID / _SECRET / _URL, comme GoTrue
// (le préfixe AUTH_EXTERNAL_ est aussi accepté) — et les fournisseurs OIDC
// d'entreprise « custom:<slug> » enregistrés par sso-admin.

import type { Query } from "../db.ts";

export interface ProviderConfig {
  id: string;
  kind: "oidc" | "github";
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** OIDC : l'émetteur (découverte .well-known). */
  issuer?: string;
  /** Apple répond en POST quand on lui demande nom et e-mail. */
  formPost?: boolean;
}

export interface ExternalProfile {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatar: string | null;
  claims: Record<string, unknown>;
  providerToken: string | null;
  providerRefreshToken: string | null;
}

const envOf = (provider: string, key: string) =>
  process.env[`GOTRUE_EXTERNAL_${provider.toUpperCase()}_${key}`] ?? process.env[`AUTH_EXTERNAL_${provider.toUpperCase()}_${key}`] ?? "";

const BUILTIN_ISSUERS: Record<string, string> = {
  google: "https://accounts.google.com",
  apple: "https://appleid.apple.com",
  azure: "https://login.microsoftonline.com/common/v2.0",
};

export const BUILTIN_PROVIDERS = ["google", "apple", "github", "azure", "keycloak"] as const;

export function builtinProvider(id: string): ProviderConfig | null {
  if (!(BUILTIN_PROVIDERS as readonly string[]).includes(id)) return null;
  const enabled = envOf(id, "ENABLED");
  const clientId = envOf(id, "CLIENT_ID");
  if (!clientId || enabled === "false") return null;
  if (id === "github") {
    return { id, kind: "github", clientId, clientSecret: envOf(id, "SECRET"), scopes: ["read:user", "user:email"] };
  }
  const issuer = envOf(id, "URL") || BUILTIN_ISSUERS[id];
  if (!issuer) return null;
  return {
    id, kind: "oidc", clientId, clientSecret: envOf(id, "SECRET"), issuer,
    scopes: id === "apple" ? ["openid", "name", "email"] : ["openid", "email", "profile"],
    formPost: id === "apple",
  };
}

export async function findProvider(q: Query, id: string): Promise<ProviderConfig | null> {
  if (id.startsWith("custom:") || id.startsWith("sso-")) {
    const [row] = await q.query<{ identifier: string; client_id: string; client_secret: string | null; issuer: string; scopes: string[]; enabled: boolean }>(
      "select identifier, client_id, client_secret, issuer, scopes, enabled from auth.custom_oauth_providers where identifier = $1", [id]);
    if (!row || !row.enabled) return null;
    return { id, kind: "oidc", clientId: row.client_id, clientSecret: row.client_secret ?? "", issuer: row.issuer, scopes: row.scopes };
  }
  return builtinProvider(id);
}

// ── OIDC ────────────────────────────────────────────────────────────────────

interface Discovery { authorization_endpoint: string; token_endpoint: string; userinfo_endpoint?: string }
const discoveries = new Map<string, { at: number; doc: Discovery }>();

async function discover(issuer: string): Promise<Discovery> {
  const hit = discoveries.get(issuer);
  if (hit && Date.now() - hit.at < 3600_000) return hit.doc;
  const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Découverte OIDC impossible pour ${issuer} (${res.status})`);
  const doc = await res.json() as Discovery;
  discoveries.set(issuer, { at: Date.now(), doc });
  return doc;
}

export async function authorizeUrl(p: ProviderConfig, redirectUri: string, state: string, extraScopes: string[]): Promise<string> {
  const scope = [...new Set([...p.scopes, ...extraScopes])].join(" ");
  const params = new URLSearchParams({ client_id: p.clientId, redirect_uri: redirectUri, response_type: "code", scope, state });
  if (p.kind === "github") return `https://github.com/login/oauth/authorize?${params}`;
  if (p.formPost) params.set("response_mode", "form_post");
  // Les jetons de rafraîchissement de l'IdP (délégation, 0276) : Google ne les
  // donne qu'avec access_type=offline.
  if (p.id === "google") { params.set("access_type", "offline"); params.set("prompt", "consent"); }
  const d = await discover(p.issuer!);
  return `${d.authorization_endpoint}?${params}`;
}

const decodeJwtPayload = (t: string): Record<string, unknown> => {
  try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8")); } catch { return {}; }
};

export async function exchangeCode(p: ProviderConfig, code: string, redirectUri: string, formUser?: string): Promise<ExternalProfile> {
  if (p.kind === "github") {
    const tok = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: p.clientId, client_secret: p.clientSecret, code, redirect_uri: redirectUri }),
    }).then((r) => r.json()) as { access_token?: string; error_description?: string };
    if (!tok.access_token) throw new Error(tok.error_description ?? "GitHub n'a pas délivré de jeton");
    const h = { Authorization: `Bearer ${tok.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "founderos" };
    const user = await fetch("https://api.github.com/user", { headers: h }).then((r) => r.json()) as Record<string, unknown>;
    const emails = await fetch("https://api.github.com/user/emails", { headers: h }).then((r) => r.json()).catch(() => []) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const primary = Array.isArray(emails) ? emails.find((e) => e.primary) ?? emails[0] : undefined;
    return {
      sub: String(user.id), email: primary?.email ?? (user.email as string | null) ?? null, emailVerified: !!primary?.verified,
      name: (user.name as string) ?? (user.login as string) ?? null, avatar: (user.avatar_url as string) ?? null,
      claims: { ...user, sub: String(user.id) }, providerToken: tok.access_token, providerRefreshToken: null,
    };
  }

  const d = await discover(p.issuer!);
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: p.clientId });
  if (p.clientSecret) body.set("client_secret", p.clientSecret);
  const res = await fetch(d.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
  const tok = await res.json() as { access_token?: string; refresh_token?: string; id_token?: string; error_description?: string; error?: string };
  if (!res.ok || (!tok.id_token && !tok.access_token)) throw new Error(tok.error_description ?? tok.error ?? `Échange du code refusé (${res.status})`);
  // Le jeton d'identité arrive directement de l'émetteur, en TLS : OIDC Core
  // 3.1.3.7 permet de s'en remettre à TLS plutôt qu'à sa signature.
  let claims: Record<string, unknown> = tok.id_token ? decodeJwtPayload(tok.id_token) : {};
  if (d.userinfo_endpoint && tok.access_token) {
    const info = await fetch(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${tok.access_token}` } })
      .then((r) => (r.ok ? r.json() : {})).catch(() => ({})) as Record<string, unknown>;
    claims = { ...claims, ...info };
  }
  // Apple n'envoie le nom qu'une fois, dans le formulaire du premier retour.
  if (formUser) {
    try {
      const u = JSON.parse(formUser) as { name?: { firstName?: string; lastName?: string } };
      if (u.name) claims.name = [u.name.firstName, u.name.lastName].filter(Boolean).join(" ");
    } catch { /* formulaire illisible : on garde les claims */ }
  }
  const sub = String(claims.sub ?? "");
  if (!sub) throw new Error("Le fournisseur n'a pas renvoyé d'identifiant (sub)");
  const email = typeof claims.email === "string" ? claims.email
    : typeof claims.preferred_username === "string" && claims.preferred_username.includes("@") ? claims.preferred_username : null;
  const ev = claims.email_verified;
  return {
    // Entra ne publie pas email_verified ; un IdP d'entreprise déclaré par un
    // admin fait foi pour les adresses de son domaine — comme GoTrue.
    sub, email, emailVerified: ev === true || ev === "true" || ((p.id === "azure" || p.id.startsWith("custom:") || p.id.startsWith("sso-")) && !!email),
    name: (claims.name as string) ?? null, avatar: (claims.picture as string) ?? null, claims,
    providerToken: tok.access_token ?? null, providerRefreshToken: tok.refresh_token ?? null,
  };
}
