// /auth/v1 — l'API de GoTrue, telle que supabase-js (auth-js) la parle.
//
// Utilisateur : signup, token (password, refresh_token, pkce), user (GET/PUT),
// logout, recover, verify, authorize/callback (OAuth), factors (MFA TOTP),
// settings, health. Admin (clé service_role) : users, generate_link, invite,
// custom-providers. Le SAML (/sso) n'est pas pris en charge : voir README.
//
// Réglages, sous leur nom GoTrue (GOTRUE_…) ou AUTH_… :
//   SITE_URL, URI_ALLOW_LIST (ADDITIONAL_REDIRECT_URLS), JWT_EXP,
//   DISABLE_SIGNUP, MAILER_AUTOCONFIRM, PASSWORD_MIN_LENGTH,
//   EXTERNAL_EMAIL_ENABLED.

import { createHash, randomUUID } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import QRCode from "qrcode";
import type { Query } from "../db.ts";
import { JwtError, signJwt, verifyJwt } from "../jwt.ts";
import type { Platform } from "../platform.ts";
import { linkMail, mailerConfigured, sendMail } from "./mailer.ts";
import { BUILTIN_PROVIDERS, authorizeUrl, builtinProvider, exchangeCode, findProvider } from "./oauth.ts";
import {
  amrOf, checkPassword, createUser, getUserByEmail, getUserById, hashPassword, hashToken, isBanned,
  issueSession, randomToken, serializeUser, sessionPayload, type AuthSettings, type UserRow,
} from "./store.ts";
import { newTotpSecret, totpUri, verifyTotp } from "./totp.ts";

const API_VERSION = "2024-01-01";

class AuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const setting = (name: string, fallback = "") =>
  process.env[`GOTRUE_${name}`] ?? process.env[`AUTH_${name}`] ?? fallback;
const flag = (name: string, fallback: boolean) => {
  const v = setting(name, "");
  return v === "" ? fallback : v === "true" || v === "1";
};

interface AuthConfig extends AuthSettings {
  siteUrl: string;
  allowList: string[];
  disableSignup: boolean;
  autoconfirm: boolean;
  passwordMin: number;
  emailEnabled: boolean;
  publicUrl: string;
}

function authConfig(p: Platform): AuthConfig {
  const publicUrl = p.config.publicUrl.replace(/\/$/, "");
  return {
    jwtSecret: p.jwtSecret,
    jwtExpiry: Number(setting("JWT_EXP", "3600")),
    issuer: `${publicUrl}/auth/v1`,
    publicUrl,
    siteUrl: (setting("SITE_URL") || process.env.APP_BASE_URL || process.env.APP_URL || "http://localhost:5173").replace(/\/$/, ""),
    allowList: (setting("URI_ALLOW_LIST") || setting("ADDITIONAL_REDIRECT_URLS")).split(",").map((s) => s.trim()).filter(Boolean),
    disableSignup: flag("DISABLE_SIGNUP", false),
    // Sans moyen d'envoyer un e-mail, une confirmation serait une impasse.
    autoconfirm: flag("MAILER_AUTOCONFIRM", !mailerConfigured()),
    passwordMin: Number(setting("PASSWORD_MIN_LENGTH", "6")),
    emailEnabled: flag("EXTERNAL_EMAIL_ENABLED", true),
  };
}

/** redirect_to n'est suivi que s'il est sous SITE_URL ou dans la liste (jokers *). */
function safeRedirect(c: AuthConfig, wanted: unknown): string {
  const url = typeof wanted === "string" ? wanted.trim() : "";
  if (!url) return c.siteUrl;
  if (url === c.siteUrl || url.startsWith(`${c.siteUrl}/`) || url.startsWith(`${c.siteUrl}?`) || url.startsWith(`${c.siteUrl}#`)) return url;
  for (const pattern of c.allowList) {
    const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/(?<!\.)\*/g, "[^/]*")}$`);
    if (re.test(url)) return url;
  }
  return c.siteUrl;
}

const withFragment = (url: string, params: Record<string, string | number>) =>
  `${url.split("#")[0]}#${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;
const withQuery = (url: string, params: Record<string, string>) => {
  const [base, frag] = url.split("#");
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return `${u.toString()}${frag ? `#${frag}` : ""}`;
};

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const ipOf = (req: Request) => req.ip ?? null;
const ua = (req: Request) => (typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null);

export function authRouter(p: Platform): Router {
  const r = express.Router();
  r.use(express.json({ limit: "1mb" }));
  r.use(express.urlencoded({ extended: false }));
  r.use((_req, res, next) => { res.setHeader("x-supabase-api-version", API_VERSION); next(); });
  const db = p.db;
  const cfg = () => authConfig(p);

  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof AuthError) {
        res.status(e.status).json({ code: e.code, error_code: e.code, msg: e.message, message: e.message, ...e.extra });
        return;
      }
      console.error("[auth]", e);
      res.status(500).json({ code: "unexpected_failure", error_code: "unexpected_failure", msg: e instanceof Error ? e.message : String(e) });
    }
  };

  /** Le jeton d'accès d'un utilisateur, et sa session encore vivante. */
  async function userFromToken(req: Request): Promise<{ user: UserRow; claims: Record<string, unknown> }> {
    const h = String(req.headers.authorization ?? "");
    const token = /^Bearer\s+(.+)$/i.exec(h)?.[1];
    if (!token) throw new AuthError(401, "no_authorization", "This endpoint requires a Bearer token");
    let claims: Record<string, unknown>;
    try { claims = verifyJwt(token, p.jwtSecret); } catch (e) {
      throw new AuthError(403, "bad_jwt", `invalid JWT: unable to parse or verify signature, ${(e as JwtError).message}`);
    }
    if (claims.role === "anon" || !claims.sub) throw new AuthError(403, "bad_jwt", "invalid claim: missing sub claim");
    if (claims.session_id) {
      const [s] = await db.query("select 1 from auth.sessions where id = $1", [claims.session_id]);
      if (!s) throw new AuthError(403, "session_not_found", "Session from session_id claim in JWT does not exist");
    }
    const user = await getUserById(db, String(claims.sub));
    if (!user) throw new AuthError(403, "user_not_found", "User from sub claim in JWT does not exist");
    return { user, claims };
  }

  function requireAdmin(req: Request) {
    const h = String(req.headers.authorization ?? "");
    const token = /^Bearer\s+(.+)$/i.exec(h)?.[1];
    try {
      const c = token ? verifyJwt(token, p.jwtSecret) : null;
      if (c && (c.role === "service_role" || c.role === "supabase_admin")) return;
    } catch { /* refusé ci-dessous */ }
    throw new AuthError(403, "not_admin", "User not allowed");
  }

  function checkPasswordStrength(c: AuthConfig, pw: unknown): string {
    const s = typeof pw === "string" ? pw : "";
    if (s.length < c.passwordMin) {
      throw new AuthError(422, "weak_password", `Password should be at least ${c.passwordMin} characters.`, { weak_password: { reasons: ["length"] } });
    }
    return s;
  }

  /** Un lien d'e-mail : jeton aléatoire, son empreinte en base. */
  async function emailLink(kind: "signup" | "recovery" | "invite" | "magiclink", user: UserRow, redirectTo: string, send: boolean) {
    const token = randomToken(24);
    const column = kind === "recovery" || kind === "magiclink" ? "recovery_token" : "confirmation_token";
    const sent = kind === "recovery" || kind === "magiclink" ? "recovery_sent_at" : "confirmation_sent_at";
    await db.query(`update auth.users set ${column} = $2, ${sent} = now(), updated_at = now() where id = $1`, [user.id, hashToken(token)]);
    const link = `${cfg().issuer}/verify?token=${encodeURIComponent(token)}&type=${kind}&redirect_to=${encodeURIComponent(redirectTo)}`;
    if (send && user.email) await sendMail(linkMail(user.email, kind, link));
    return { token, link, hashed: hashToken(token) };
  }

  /** PKCE : un code à usage unique, échangé ensuite contre la session. */
  async function newFlowState(q: Query, opts: { userId?: string | null; challenge: string; method: string; provider: string; auth: string; providerTokens?: { access: string | null; refresh: string | null } }) {
    const id = randomUUID();
    const code = randomUUID();
    await q.query(
      `insert into auth.flow_state (id, user_id, auth_code, code_challenge_method, code_challenge, provider_type,
         provider_access_token, provider_refresh_token, created_at, updated_at, authentication_method, auth_code_issued_at)
       values ($1, $2, $3, $4::auth.code_challenge_method, $5, $6, $7, $8, now(), now(), $9, case when $2::uuid is null then null else now() end)`,
      [id, opts.userId ?? null, code, opts.method === "plain" ? "plain" : "s256", opts.challenge, opts.provider,
        opts.providerTokens?.access ?? null, opts.providerTokens?.refresh ?? null, opts.auth],
    );
    return { id, code };
  }

  // ── Public ────────────────────────────────────────────────────────────────

  r.get("/health", (_req, res) => { res.json({ version: "founderos-platform", name: "GoTrue", description: "FounderOS auth" }); });

  r.get("/settings", handle(async (_req, res) => {
    const c = cfg();
    const external: Record<string, boolean> = { email: c.emailEnabled, phone: false, anonymous_users: false, saml: false };
    for (const id of BUILTIN_PROVIDERS) external[id] = !!builtinProvider(id);
    res.json({ external, disable_signup: c.disableSignup, mailer_autoconfirm: c.autoconfirm, phone_autoconfirm: false, sms_provider: "", saml_enabled: false });
  }));

  r.get("/.well-known/jwks.json", (_req, res) => { res.json({ keys: [] }); });

  r.post("/signup", handle(async (req, res) => {
    const c = cfg();
    if (c.disableSignup) throw new AuthError(422, "signup_disabled", "Signups not allowed for this instance");
    if (!c.emailEnabled) throw new AuthError(422, "email_provider_disabled", "Email signups are disabled");
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError(400, "validation_failed", "Unable to validate email address: invalid format");
    const password = checkPasswordStrength(c, req.body?.password);
    const redirectTo = safeRedirect(c, req.query.redirect_to ?? req.body?.options?.emailRedirectTo);

    const existing = await getUserByEmail(db, email);
    if (existing) {
      if (c.autoconfirm || existing.email_confirmed_at) throw new AuthError(422, "user_already_exists", "User already registered");
      // Compte en attente de confirmation : on renvoie le lien, sans dire s'il existait.
      await emailLink("signup", existing, redirectTo, true);
      res.json(await serializeUser(db, existing));
      return;
    }
    const user = await db.tx((q) => createUser(q, {
      email, password, userMetadata: (req.body?.data ?? {}) as Record<string, unknown>, confirmed: c.autoconfirm, provider: "email",
    }));
    if (c.autoconfirm) {
      res.json(await issueSession(db, c, user, { amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }], userAgent: ua(req), ip: ipOf(req) }));
      return;
    }
    if (req.body?.code_challenge) {
      await newFlowState(db, { userId: user.id, challenge: String(req.body.code_challenge), method: String(req.body.code_challenge_method ?? "s256"), provider: "email", auth: "email/signup" });
    }
    await emailLink("signup", user, redirectTo, true);
    res.json(await serializeUser(db, (await getUserById(db, user.id))!));
  }));

  r.post("/token", handle(async (req, res) => {
    const c = cfg();
    const grant = String(req.query.grant_type ?? req.body?.grant_type ?? "");
    const now = Math.floor(Date.now() / 1000);

    if (grant === "password") {
      if (!c.emailEnabled) throw new AuthError(400, "email_provider_disabled", "Email logins are disabled");
      const email = String(req.body?.email ?? "").trim();
      const user = email ? await getUserByEmail(db, email) : null;
      if (!user || !(await checkPassword(String(req.body?.password ?? ""), user.encrypted_password))) {
        throw new AuthError(400, "invalid_credentials", "Invalid login credentials");
      }
      if (isBanned(user)) throw new AuthError(400, "user_banned", "User is banned");
      if (!user.email_confirmed_at && !c.autoconfirm) throw new AuthError(400, "email_not_confirmed", "Email not confirmed");
      res.json(await issueSession(db, c, user, { amr: [{ method: "password", timestamp: now }], userAgent: ua(req), ip: ipOf(req) }));
      return;
    }

    if (grant === "refresh_token") {
      const token = String(req.body?.refresh_token ?? "");
      if (!token) throw new AuthError(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
      const out = await db.tx(async (q) => {
        const [rt] = await q.query<{ id: string; user_id: string; revoked: boolean; session_id: string; updated_at: unknown }>(
          "select id, user_id, revoked, session_id, updated_at from auth.refresh_tokens where token = $1 for update", [token]);
        if (!rt || !rt.session_id) throw new AuthError(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
        const [session] = await q.query<{ aal: string; not_after: unknown }>("select aal::text as aal, not_after from auth.sessions where id = $1", [rt.session_id]);
        if (!session) throw new AuthError(400, "session_not_found", "Invalid Refresh Token: Session Not Found");
        if (session.not_after && new Date(String(session.not_after)).getTime() < Date.now()) {
          throw new AuthError(400, "session_expired", "Invalid Refresh Token: Session Expired");
        }
        let fresh: string;
        if (rt.revoked) {
          // Fenêtre de réutilisation de GoTrue (10 s) : deux onglets qui
          // rafraîchissent en même temps reçoivent le même successeur.
          const [child] = await q.query<{ token: string; created_at: unknown }>(
            "select token, created_at from auth.refresh_tokens where parent = $1 and revoked = false order by id desc limit 1", [token]);
          if (!child || Date.now() - new Date(String(child.created_at)).getTime() > 10_000) {
            await q.query("delete from auth.sessions where id = $1", [rt.session_id]);
            throw new AuthError(400, "refresh_token_already_used", "Invalid Refresh Token: Already Used");
          }
          fresh = child.token;
        } else {
          fresh = randomToken(24);
          await q.query("update auth.refresh_tokens set revoked = true, updated_at = now() where id = $1", [rt.id]);
          await q.query(
            `insert into auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, parent, session_id)
             values ('00000000-0000-0000-0000-000000000000', $1, $2, false, now(), now(), $3, $4)`,
            [fresh, rt.user_id, token, rt.session_id]);
          await q.query("update auth.sessions set refreshed_at = now(), updated_at = now() where id = $1", [rt.session_id]);
        }
        return { userId: rt.user_id, sessionId: rt.session_id, aal: session.aal ?? "aal1", fresh };
      });
      const user = await getUserById(db, out.userId);
      if (!user) throw new AuthError(400, "user_not_found", "User not found");
      if (isBanned(user)) throw new AuthError(400, "user_banned", "User is banned");
      res.json(await sessionPayload(db, c, user, out.sessionId, out.fresh, out.aal, await amrOf(db, out.sessionId)));
      return;
    }

    if (grant === "pkce") {
      const code = String(req.body?.auth_code ?? "");
      const verifier = String(req.body?.code_verifier ?? "");
      const [fs] = await db.query<{ id: string; user_id: string | null; code_challenge: string; code_challenge_method: string; authentication_method: string; provider_type: string; provider_access_token: string | null; provider_refresh_token: string | null; auth_code_issued_at: unknown }>(
        `select id, user_id, code_challenge, code_challenge_method::text as code_challenge_method, authentication_method, provider_type,
                provider_access_token, provider_refresh_token, auth_code_issued_at from auth.flow_state where auth_code = $1`, [code]);
      if (!fs || !fs.user_id) throw new AuthError(404, "flow_state_not_found", "invalid flow state, no valid flow state found");
      await db.query("delete from auth.flow_state where id = $1", [fs.id]);
      if (fs.auth_code_issued_at && Date.now() - new Date(String(fs.auth_code_issued_at)).getTime() > 5 * 60_000) {
        throw new AuthError(400, "flow_state_expired", "invalid flow state, flow state has expired");
      }
      const expected = fs.code_challenge_method === "plain" ? verifier : s256(verifier);
      if (expected !== fs.code_challenge) throw new AuthError(400, "bad_code_verifier", "code challenge does not match previously saved code verifier");
      const user = await getUserById(db, fs.user_id);
      if (!user) throw new AuthError(400, "user_not_found", "User not found");
      const method = fs.authentication_method.includes("recovery") ? "recovery" : fs.provider_type === "email" ? "email/signup" : "oauth";
      const session = await issueSession(db, c, user, { amr: [{ method, timestamp: now }], userAgent: ua(req), ip: ipOf(req) });
      res.json({ ...session, provider_token: fs.provider_access_token ?? undefined, provider_refresh_token: fs.provider_refresh_token ?? undefined });
      return;
    }

    throw new AuthError(400, "unsupported_grant_type", `Unsupported grant type: ${grant}`);
  }));

  r.get("/user", handle(async (req, res) => {
    const { user } = await userFromToken(req);
    res.json(await serializeUser(db, user));
  }));

  r.put("/user", handle(async (req, res) => {
    const c = cfg();
    const { user, claims } = await userFromToken(req);
    const b = req.body ?? {};
    if (b.data && typeof b.data === "object") {
      await db.query("update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || $2::jsonb, updated_at = now() where id = $1",
        [user.id, JSON.stringify(b.data)]);
    }
    if (typeof b.password === "string") {
      checkPasswordStrength(c, b.password);
      await db.query("update auth.users set encrypted_password = $2, updated_at = now() where id = $1", [user.id, await hashPassword(b.password)]);
    }
    if (typeof b.email === "string" && b.email.trim().toLowerCase() !== (user.email ?? "")) {
      const email = b.email.trim().toLowerCase();
      if (await getUserByEmail(db, email)) throw new AuthError(422, "email_exists", "A user with this email address has already been registered");
      if (c.autoconfirm) {
        await db.query("update auth.users set email = $2, email_confirmed_at = now(), updated_at = now() where id = $1", [user.id, email]);
      } else {
        const token = randomToken(24);
        await db.query("update auth.users set email_change = $2, email_change_token_new = $3, email_change_sent_at = now(), updated_at = now() where id = $1",
          [user.id, email, hashToken(token)]);
        const redirectTo = safeRedirect(c, req.query.redirect_to);
        await sendMail(linkMail(email, "email_change", `${c.issuer}/verify?token=${encodeURIComponent(token)}&type=email_change&redirect_to=${encodeURIComponent(redirectTo)}`));
      }
    }
    void claims;
    res.json(await serializeUser(db, (await getUserById(db, user.id))!));
  }));

  r.post("/logout", handle(async (req, res) => {
    let claims: Record<string, unknown>;
    try { claims = (await userFromToken(req)).claims; } catch { res.status(204).end(); return; }
    const scope = String(req.query.scope ?? "global");
    if (scope === "local") await db.query("delete from auth.sessions where id = $1", [claims.session_id]);
    else if (scope === "others") await db.query("delete from auth.sessions where user_id = $1 and id <> $2", [claims.sub, claims.session_id]);
    else await db.query("delete from auth.sessions where user_id = $1", [claims.sub]);
    res.status(204).end();
  }));

  r.post("/recover", handle(async (req, res) => {
    const c = cfg();
    const email = String(req.body?.email ?? "").trim();
    const user = email ? await getUserByEmail(db, email) : null;
    // Toujours la même réponse : on ne révèle pas qui a un compte.
    if (user) {
      const redirectTo = safeRedirect(c, req.query.redirect_to);
      if (req.body?.code_challenge) {
        await newFlowState(db, { userId: user.id, challenge: String(req.body.code_challenge), method: String(req.body.code_challenge_method ?? "s256"), provider: "email", auth: "recovery" });
      }
      await emailLink("recovery", user, redirectTo, true);
    }
    res.json({});
  }));

  /** Le jeton d'un lien d'e-mail → l'utilisateur, consommé. */
  async function consumeToken(type: string, token: string, byHash = false): Promise<UserRow> {
    const h = byHash ? token : hashToken(token);
    const col = type === "recovery" || type === "magiclink" ? "recovery_token" : type === "email_change" ? "email_change_token_new" : "confirmation_token";
    const sentCol = type === "recovery" || type === "magiclink" ? "recovery_sent_at" : type === "email_change" ? "email_change_sent_at" : "confirmation_sent_at";
    const [u] = await db.query<{ id: string; sent: unknown; email_change: string | null }>(
      `select id, ${sentCol} as sent, email_change from auth.users where ${col} = $1 and deleted_at is null`, [h]);
    if (!u) throw new AuthError(403, "otp_expired", "Email link is invalid or has expired");
    if (u.sent && Date.now() - new Date(String(u.sent)).getTime() > 24 * 3600_000) throw new AuthError(403, "otp_expired", "Email link is invalid or has expired");
    if (type === "email_change") {
      await db.query("update auth.users set email = email_change, email_change = '', email_change_token_new = '', email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = $1", [u.id]);
    } else {
      await db.query(`update auth.users set ${col} = '', email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = $1`, [u.id]);
    }
    return (await getUserById(db, u.id))!;
  }

  r.get("/verify", handle(async (req, res) => {
    const c = cfg();
    const type = String(req.query.type ?? "");
    const redirectTo = safeRedirect(c, req.query.redirect_to);
    let user: UserRow;
    try {
      user = await consumeToken(type, String(req.query.token ?? ""));
    } catch (e) {
      const ae = e instanceof AuthError ? e : new AuthError(403, "otp_expired", "Email link is invalid or has expired");
      res.redirect(303, withFragment(redirectTo, { error: "access_denied", error_code: ae.code, error_description: ae.message }));
      return;
    }
    // Un parcours PKCE en attente pour ce compte : on rend un code.
    const [fs] = await db.query<{ id: string; auth_code: string }>(
      "select id, auth_code from auth.flow_state where user_id = $1 and provider_type = 'email' order by created_at desc limit 1", [user.id]);
    if (fs) {
      await db.query("update auth.flow_state set auth_code_issued_at = now() where id = $1", [fs.id]);
      res.redirect(303, withQuery(redirectTo, { code: fs.auth_code }));
      return;
    }
    const method = type === "recovery" ? "otp" : type === "invite" ? "invite" : "otp";
    const s = await issueSession(db, c, user, { amr: [{ method, timestamp: Math.floor(Date.now() / 1000) }], userAgent: ua(req), ip: ipOf(req) });
    res.redirect(303, withFragment(redirectTo, {
      access_token: s.access_token, expires_at: s.expires_at, expires_in: s.expires_in, refresh_token: s.refresh_token,
      token_type: "bearer", type: type === "signup" ? "signup" : type,
    }));
  }));

  r.post("/verify", handle(async (req, res) => {
    const c = cfg();
    const type = String(req.body?.type ?? "");
    const user = req.body?.token_hash
      ? await consumeToken(type, String(req.body.token_hash), true)
      : await consumeToken(type, String(req.body?.token ?? ""));
    res.json(await issueSession(db, c, user, { amr: [{ method: "otp", timestamp: Math.floor(Date.now() / 1000) }], userAgent: ua(req), ip: ipOf(req) }));
  }));

  // ── OAuth ─────────────────────────────────────────────────────────────────

  r.get("/authorize", handle(async (req, res) => {
    const c = cfg();
    const providerId = String(req.query.provider ?? "");
    const provider = await findProvider(db, providerId);
    if (!provider) throw new AuthError(400, "validation_failed", `Unsupported provider: provider ${providerId} could not be found`);
    const redirectTo = safeRedirect(c, req.query.redirect_to);
    let flowId: string | null = null;
    if (req.query.code_challenge) {
      flowId = (await newFlowState(db, { challenge: String(req.query.code_challenge), method: String(req.query.code_challenge_method ?? "s256"), provider: providerId, auth: "oauth" })).id;
    }
    const state = signJwt({
      provider: providerId, redirect_to: redirectTo, flow_state_id: flowId, nonce: randomToken(8),
      exp: Math.floor(Date.now() / 1000) + 600,
    }, p.jwtSecret);
    const extra = String(req.query.scopes ?? "").split(/[\s,]+/).filter(Boolean);
    const url = await authorizeUrl(provider, `${c.issuer}/callback`, state, extra);
    if (req.query.skip_http_redirect === "true") { res.json({ url }); return; }
    res.redirect(302, url);
  }));

  const callback = handle(async (req, res) => {
    const c = cfg();
    const src = { ...req.query, ...(req.body ?? {}) } as Record<string, string>;
    let state: Record<string, unknown>;
    try { state = verifyJwt(String(src.state ?? ""), p.jwtSecret); } catch {
      res.redirect(303, withFragment(c.siteUrl, { error: "invalid_request", error_code: "bad_oauth_state", error_description: "OAuth state parameter is invalid" }));
      return;
    }
    const redirectTo = String(state.redirect_to ?? c.siteUrl);
    const fail = (code: string, message: string) => res.redirect(303, withFragment(redirectTo, { error: "server_error", error_code: code, error_description: message }));
    if (src.error) { fail(String(src.error), String(src.error_description ?? src.error)); return; }
    const provider = await findProvider(db, String(state.provider));
    if (!provider) { fail("provider_disabled", "Provider is disabled"); return; }

    let profile;
    try { profile = await exchangeCode(provider, String(src.code ?? ""), `${c.issuer}/callback`, src.user); } catch (e) {
      fail("bad_oauth_callback", e instanceof Error ? e.message : String(e)); return;
    }
    const identityData = {
      ...profile.claims, sub: profile.sub, email: profile.email, email_verified: profile.emailVerified,
      full_name: profile.name ?? undefined, name: profile.name ?? undefined, avatar_url: profile.avatar ?? undefined,
      provider_id: profile.sub, iss: provider.issuer ?? provider.id,
    };

    const user = await db.tx(async (q) => {
      const [ident] = await q.query<{ user_id: string }>("select user_id from auth.identities where provider = $1 and provider_id = $2", [provider.id, profile.sub]);
      if (ident) {
        await q.query("update auth.identities set identity_data = $3::jsonb, last_sign_in_at = now(), updated_at = now() where provider = $1 and provider_id = $2",
          [provider.id, profile.sub, JSON.stringify(identityData)]);
        return (await getUserById(q, ident.user_id))!;
      }
      // Liaison automatique de GoTrue : même adresse, vérifiée par le fournisseur.
      const sameEmail = profile.email && profile.emailVerified ? await getUserByEmail(q, profile.email) : null;
      if (sameEmail) {
        await q.query(
          `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
           values ($1, $2, $3::jsonb, $4, now(), now(), now())`, [profile.sub, sameEmail.id, JSON.stringify(identityData), provider.id]);
        await q.query(
          `update auth.users set raw_app_meta_data = jsonb_set(coalesce(raw_app_meta_data, '{}'::jsonb), '{providers}',
             (select coalesce(jsonb_agg(distinct p), '[]'::jsonb) from jsonb_array_elements_text(coalesce(raw_app_meta_data->'providers', '[]'::jsonb) || to_jsonb($2::text)) p)),
             email_confirmed_at = coalesce(email_confirmed_at, now()), updated_at = now() where id = $1`, [sameEmail.id, provider.id]);
        return (await getUserById(q, sameEmail.id))!;
      }
      if (c.disableSignup) throw new AuthError(422, "signup_disabled", "Signups not allowed for this instance");
      if (!profile.email) throw new AuthError(422, "email_address_not_provided", "Error getting user email from external provider");
      return createUser(q, {
        email: profile.email, confirmed: profile.emailVerified, provider: provider.id, providerId: profile.sub, identityData,
        userMetadata: { ...identityData },
      });
    }).catch((e) => { fail(e instanceof AuthError ? e.code : "server_error", e instanceof Error ? e.message : String(e)); return null; });
    if (!user) return;
    if (isBanned(user)) { fail("user_banned", "User is banned"); return; }

    if (state.flow_state_id) {
      const code = randomUUID();
      await db.query(
        `update auth.flow_state set user_id = $2, auth_code = $3, auth_code_issued_at = now(), provider_access_token = $4, provider_refresh_token = $5, updated_at = now() where id = $1`,
        [state.flow_state_id, user.id, code, profile.providerToken, profile.providerRefreshToken]);
      res.redirect(303, withQuery(redirectTo, { code }));
      return;
    }
    const s = await issueSession(db, c, user, { amr: [{ method: "oauth", timestamp: Math.floor(Date.now() / 1000) }], userAgent: ua(req), ip: ipOf(req) });
    const frag: Record<string, string | number> = {
      access_token: s.access_token, expires_at: s.expires_at, expires_in: s.expires_in, refresh_token: s.refresh_token, token_type: "bearer",
    };
    if (profile.providerToken) frag.provider_token = profile.providerToken;
    if (profile.providerRefreshToken) frag.provider_refresh_token = profile.providerRefreshToken;
    res.redirect(303, withFragment(redirectTo, frag));
  });
  r.get("/callback", callback);
  r.post("/callback", callback);

  r.post("/sso", handle(async () => {
    throw new AuthError(400, "saml_provider_disabled", "SAML 2.0 is not supported by this server — use an OIDC provider (Administration → Authentification).");
  }));

  // ── MFA (TOTP) ────────────────────────────────────────────────────────────

  r.post("/factors", handle(async (req, res) => {
    const { user } = await userFromToken(req);
    if ((req.body?.factor_type ?? "totp") !== "totp") throw new AuthError(422, "mfa_factor_type_unsupported", "Only TOTP factors are supported");
    const secret = newTotpSecret();
    const id = randomUUID();
    const issuer = String(req.body?.issuer ?? new URL(cfg().siteUrl).host);
    const uri = totpUri(secret, user.email ?? user.id, issuer);
    await db.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
       values ($1, $2, $3, 'totp', 'unverified', now(), now(), $4)`, [id, user.id, req.body?.friendly_name ?? null, secret]);
    const svg = await QRCode.toString(uri, { type: "svg", margin: 1 });
    res.json({
      id, type: "totp", friendly_name: req.body?.friendly_name ?? undefined,
      totp: { qr_code: `data:image/svg+xml;utf-8,${svg}`, secret, uri },
    });
  }));

  r.post("/factors/:id/challenge", handle(async (req, res) => {
    const { user } = await userFromToken(req);
    const [f] = await db.query("select id from auth.mfa_factors where id = $1 and user_id = $2", [String(req.params.id), user.id]);
    if (!f) throw new AuthError(404, "mfa_factor_not_found", "Factor not found");
    const id = randomUUID();
    await db.query("insert into auth.mfa_challenges (id, factor_id, created_at, ip_address) values ($1, $2, now(), $3::inet)",
      [id, String(req.params.id), ipOf(req) && /^[0-9a-f:.]+$/i.test(ipOf(req)!) ? ipOf(req) : null]);
    await db.query("update auth.mfa_factors set last_challenged_at = now() where id = $1", [String(req.params.id)]);
    res.json({ id, type: "totp", expires_at: Math.floor(Date.now() / 1000) + 300 });
  }));

  r.post("/factors/:id/verify", handle(async (req, res) => {
    const c = cfg();
    const { user, claims } = await userFromToken(req);
    const [f] = await db.query<{ id: string; secret: string }>("select id, secret from auth.mfa_factors where id = $1 and user_id = $2", [String(req.params.id), user.id]);
    if (!f) throw new AuthError(404, "mfa_factor_not_found", "Factor not found");
    const [ch] = await db.query<{ id: string; created_at: unknown; verified_at: unknown }>(
      "select id, created_at, verified_at from auth.mfa_challenges where id = $1 and factor_id = $2", [req.body?.challenge_id, f.id]);
    if (!ch || ch.verified_at) throw new AuthError(404, "mfa_challenge_expired", "Challenge not found");
    if (Date.now() - new Date(String(ch.created_at)).getTime() > 300_000) throw new AuthError(400, "mfa_challenge_expired", "MFA challenge has expired, verify against another challenge or create a new challenge.");
    if (!verifyTotp(f.secret, String(req.body?.code ?? ""))) throw new AuthError(422, "mfa_verification_failed", "Invalid TOTP code entered");
    await db.query("update auth.mfa_challenges set verified_at = now() where id = $1", [ch.id]);
    await db.query("update auth.mfa_factors set status = 'verified', updated_at = now() where id = $1", [f.id]);
    const amr = [...await amrOf(db, String(claims.session_id)), { method: "totp", timestamp: Math.floor(Date.now() / 1000) }];
    res.json(await issueSession(db, c, user, { amr, aal: "aal2", sessionId: String(claims.session_id) }));
  }));

  r.delete("/factors/:id", handle(async (req, res) => {
    const { user, claims } = await userFromToken(req);
    const [f] = await db.query<{ status: string }>("select status::text as status from auth.mfa_factors where id = $1 and user_id = $2", [String(req.params.id), user.id]);
    if (!f) throw new AuthError(404, "mfa_factor_not_found", "Factor not found");
    if (f.status === "verified" && claims.aal !== "aal2") throw new AuthError(403, "insufficient_aal", "AAL2 required to unenroll verified factor");
    await db.query("delete from auth.mfa_factors where id = $1", [String(req.params.id)]);
    res.json({ id: String(req.params.id) });
  }));

  // ── Admin (clé service_role) ──────────────────────────────────────────────

  r.get("/admin/users", handle(async (req, res) => {
    requireAdmin(req);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const perPage = Math.min(1000, Math.max(1, Number(req.query.per_page ?? 50)));
    const [{ n }] = await db.query<{ n: number }>("select count(*)::int as n from auth.users where deleted_at is null");
    const ids = await db.query<{ id: string }>("select id from auth.users where deleted_at is null order by created_at desc limit $1 offset $2", [perPage, (page - 1) * perPage]);
    const users = [];
    for (const { id } of ids) { const u = await getUserById(db, id); if (u) users.push(await serializeUser(db, u)); }
    res.setHeader("x-total-count", String(n));
    res.json({ users, aud: "authenticated" });
  }));

  r.post("/admin/users", handle(async (req, res) => {
    requireAdmin(req);
    const b = req.body ?? {};
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!email) throw new AuthError(400, "validation_failed", "Unable to validate email address: invalid format");
    if (await getUserByEmail(db, email)) throw new AuthError(422, "email_exists", "A user with this email address has already been registered");
    const user = await db.tx((q) => createUser(q, {
      email, password: b.password ?? null, confirmed: b.email_confirm === true, provider: "email",
      userMetadata: b.user_metadata ?? {}, appMetadata: b.app_metadata ?? {},
    }));
    res.json(await serializeUser(db, user));
  }));

  const banUntil = (d: unknown): string | null | undefined => {
    if (d === undefined) return undefined;
    if (d === "none" || d === null) return null;
    const m = /^(\d+)(h|m|s)$/.exec(String(d));
    if (!m) throw new AuthError(400, "validation_failed", "ban_duration: invalid format (ex. 24h, none)");
    const ms = Number(m[1]) * (m[2] === "h" ? 3600_000 : m[2] === "m" ? 60_000 : 1000);
    return new Date(Date.now() + ms).toISOString();
  };

  r.get("/admin/users/:id", handle(async (req, res) => {
    requireAdmin(req);
    const u = await getUserById(db, String(req.params.id));
    if (!u) throw new AuthError(404, "user_not_found", "User not found");
    res.json(await serializeUser(db, u));
  }));

  r.put("/admin/users/:id", handle(async (req, res) => {
    requireAdmin(req);
    const b = req.body ?? {};
    const u = await getUserById(db, String(req.params.id));
    if (!u) throw new AuthError(404, "user_not_found", "User not found");
    if (b.email !== undefined) await db.query("update auth.users set email = lower($2) where id = $1", [u.id, b.email]);
    if (b.password !== undefined) await db.query("update auth.users set encrypted_password = $2 where id = $1", [u.id, await hashPassword(String(b.password))]);
    if (b.email_confirm === true) await db.query("update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = $1", [u.id]);
    if (b.user_metadata) await db.query("update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || $2::jsonb where id = $1", [u.id, JSON.stringify(b.user_metadata)]);
    if (b.app_metadata) await db.query("update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || $2::jsonb where id = $1", [u.id, JSON.stringify(b.app_metadata)]);
    const ban = banUntil(b.ban_duration);
    if (ban !== undefined) {
      await db.query("update auth.users set banned_until = $2 where id = $1", [u.id, ban]);
      // Bannir coupe les sessions ouvertes, comme GoTrue.
      if (ban) await db.query("delete from auth.sessions where user_id = $1", [u.id]);
    }
    await db.query("update auth.users set updated_at = now() where id = $1", [u.id]);
    res.json(await serializeUser(db, (await getUserById(db, u.id))!));
  }));

  r.delete("/admin/users/:id", handle(async (req, res) => {
    requireAdmin(req);
    const u = await getUserById(db, String(req.params.id));
    if (!u) throw new AuthError(404, "user_not_found", "User not found");
    if (req.body?.should_soft_delete === true) {
      await db.query("update auth.users set deleted_at = now(), email = null, encrypted_password = null where id = $1", [u.id]);
      await db.query("delete from auth.sessions where user_id = $1", [u.id]);
    } else {
      // Comme GoTrue : une clé étrangère sans cascade (un espace dont le compte
      // est propriétaire…) fait échouer la suppression, sans détail SQL.
      await db.query("delete from auth.users where id = $1", [u.id]).catch((e) => {
        throw new AuthError(500, "unexpected_failure", "Database error deleting user", { details: (e as Error).message });
      });
    }
    res.json({});
  }));

  r.post("/admin/generate_link", handle(async (req, res) => {
    requireAdmin(req);
    const c = cfg();
    const b = req.body ?? {};
    const type = String(b.type ?? "");
    const email = String(b.email ?? "").trim().toLowerCase();
    const redirectTo = safeRedirect(c, b.redirect_to ?? b.options?.redirectTo);
    let user = await getUserByEmail(db, email);
    if (type === "signup" || type === "invite") {
      if (!user) user = await db.tx((q) => createUser(q, { email, password: b.password ?? null, confirmed: false, provider: "email", invited: type === "invite", userMetadata: b.data ?? {} }));
    }
    if (!user) throw new AuthError(404, "user_not_found", "User with this email not found");
    const kind = type === "recovery" ? "recovery" : type === "magiclink" ? "magiclink" : type === "invite" ? "invite" : "signup";
    const link = await emailLink(kind, user, redirectTo, false);
    res.json({
      ...(await serializeUser(db, user)),
      action_link: link.link, email_otp: "", hashed_token: link.hashed, verification_type: kind, redirect_to: redirectTo,
      properties: { action_link: link.link, email_otp: "", hashed_token: link.hashed, redirect_to: redirectTo, verification_type: kind },
    });
  }));

  r.post("/invite", handle(async (req, res) => {
    requireAdmin(req);
    const c = cfg();
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (await getUserByEmail(db, email)) throw new AuthError(422, "email_exists", "A user with this email address has already been registered");
    const user = await db.tx((q) => createUser(q, { email, confirmed: false, provider: "email", invited: true, userMetadata: req.body?.data ?? {} }));
    await emailLink("invite", user, safeRedirect(c, req.query.redirect_to ?? req.body?.redirect_to), true);
    res.json(await serializeUser(db, (await getUserById(db, user.id))!));
  }));

  // Fournisseurs OIDC d'entreprise (sso-admin), comme GOTRUE_CUSTOM_OAUTH.
  r.get("/admin/custom-providers", handle(async (req, res) => {
    requireAdmin(req);
    res.json({ providers: await db.query("select identifier, provider_type, name, client_id, issuer, scopes, enabled, created_at, updated_at from auth.custom_oauth_providers order by created_at") });
  }));
  r.post("/admin/custom-providers", handle(async (req, res) => {
    requireAdmin(req);
    const b = req.body ?? {};
    if (!b.identifier || !b.client_id || !b.issuer) throw new AuthError(400, "validation_failed", "identifier, client_id et issuer sont requis");
    const [row] = await db.query(
      `insert into auth.custom_oauth_providers (identifier, provider_type, name, client_id, client_secret, issuer, scopes)
       values ($1, coalesce($2, 'oidc'), coalesce($3, $1), $4, $5, $6, coalesce($7::text[], array['openid','profile','email']))
       returning identifier, provider_type, name, client_id, issuer, scopes, enabled`,
      [b.identifier, b.provider_type ?? null, b.name ?? null, b.client_id, b.client_secret ?? null, b.issuer, b.scopes ?? null]);
    res.status(201).json(row);
  }));
  r.get("/admin/custom-providers/:id", handle(async (req, res) => {
    requireAdmin(req);
    const [row] = await db.query("select identifier, provider_type, name, client_id, issuer, scopes, enabled from auth.custom_oauth_providers where identifier = $1", [String(req.params.id)]);
    if (!row) throw new AuthError(404, "provider_not_found", "Provider not found");
    res.json(row);
  }));
  r.put("/admin/custom-providers/:id", handle(async (req, res) => {
    requireAdmin(req);
    const b = req.body ?? {};
    const [row] = await db.query(
      `update auth.custom_oauth_providers set name = coalesce($2, name), client_id = coalesce($3, client_id),
         client_secret = coalesce($4, client_secret), issuer = coalesce($5, issuer), scopes = coalesce($6::text[], scopes),
         enabled = coalesce($7, enabled), updated_at = now()
       where identifier = $1 returning identifier, provider_type, name, client_id, issuer, scopes, enabled`,
      [String(req.params.id), b.name ?? null, b.client_id ?? null, b.client_secret ?? null, b.issuer ?? null, b.scopes ?? null, b.enabled ?? null]);
    if (!row) throw new AuthError(404, "provider_not_found", "Provider not found");
    res.json(row);
  }));
  r.delete("/admin/custom-providers/:id", handle(async (req, res) => {
    requireAdmin(req);
    const n = await db.command("delete from auth.custom_oauth_providers where identifier = $1", [String(req.params.id)]);
    if (!n) throw new AuthError(404, "provider_not_found", "Provider not found");
    res.json({});
  }));

  r.all(["/admin/sso/providers", "/admin/sso/providers/:id"], handle(async (req) => {
    requireAdmin(req);
    throw new AuthError(400, "saml_provider_disabled", "SAML 2.0 is not supported by this server — declare an OIDC provider instead.");
  }));

  return r;
}
