// Les comptes, identités et sessions, dans les tables de GoTrue (schéma auth).
//
// Les formats rendus (utilisateur, session) sont ceux de GoTrue, champ pour
// champ : supabase-js et le front les lisent tels quels.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Db, Query } from "../db.ts";
import { signJwt } from "../jwt.ts";

export type UserRow = {
  id: string;
  aud: string | null;
  role: string | null;
  email: string | null;
  encrypted_password: string | null;
  email_confirmed_at: string | null;
  phone: string | null;
  phone_confirmed_at: string | null;
  confirmed_at: string | null;
  confirmation_sent_at: string | null;
  recovery_sent_at: string | null;
  email_change: string | null;
  email_change_sent_at: string | null;
  invited_at: string | null;
  last_sign_in_at: string | null;
  raw_app_meta_data: Record<string, unknown> | null;
  raw_user_meta_data: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  banned_until: string | null;
  is_sso_user: boolean;
  is_anonymous: boolean;
  deleted_at: string | null;
};

export interface AuthSettings {
  jwtSecret: string;
  jwtExpiry: number;
  issuer: string;
}

const USER_COLS = `id, aud, role, email, encrypted_password, email_confirmed_at, phone, phone_confirmed_at, confirmed_at,
  confirmation_sent_at, recovery_sent_at, email_change, email_change_sent_at, invited_at, last_sign_in_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at, banned_until, is_sso_user, is_anonymous, deleted_at`;

/** Les horodatages au format JSON de GoTrue (ISO), quel que soit le pilote. */
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const json = (v: unknown): Record<string, unknown> => (v == null ? {} : typeof v === "string" ? JSON.parse(v) : v as Record<string, unknown>);

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const checkPassword = (pw: string, hash: string | null) => (hash ? bcrypt.compare(pw, hash) : Promise.resolve(false));

export async function getUserById(q: Query, id: string): Promise<UserRow | null> {
  const [u] = await q.query<UserRow>(`select ${USER_COLS} from auth.users where id = $1 and deleted_at is null`, [id]);
  return u ?? null;
}

export async function getUserByEmail(q: Query, email: string): Promise<UserRow | null> {
  const [u] = await q.query<UserRow>(
    `select ${USER_COLS} from auth.users where lower(email) = lower($1) and is_sso_user = false and deleted_at is null limit 1`, [email]);
  return u ?? null;
}

export async function identitiesOf(q: Query, userId: string) {
  const rows = await q.query<Record<string, unknown>>(
    `select id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at, email
       from auth.identities where user_id = $1 order by created_at`, [userId]);
  return rows.map((r) => ({
    identity_id: r.id, id: r.provider_id, user_id: r.user_id, identity_data: json(r.identity_data),
    provider: r.provider, last_sign_in_at: iso(r.last_sign_in_at), created_at: iso(r.created_at),
    updated_at: iso(r.updated_at), email: r.email ?? null,
  }));
}

export async function factorsOf(q: Query, userId: string) {
  const rows = await q.query<Record<string, unknown>>(
    `select id, friendly_name, factor_type::text as factor_type, status::text as status, created_at, updated_at, phone, last_challenged_at
       from auth.mfa_factors where user_id = $1 order by created_at`, [userId]);
  return rows.map((r) => ({
    id: r.id, friendly_name: r.friendly_name ?? undefined, factor_type: r.factor_type, status: r.status,
    created_at: iso(r.created_at), updated_at: iso(r.updated_at), phone: r.phone ?? undefined,
    last_challenged_at: iso(r.last_challenged_at) ?? undefined,
  }));
}

/** L'utilisateur tel que GoTrue le renvoie. */
export async function serializeUser(q: Query, u: UserRow) {
  const factors = await factorsOf(q, u.id);
  return {
    id: u.id,
    aud: u.aud ?? "authenticated",
    role: u.role ?? "authenticated",
    email: u.email ?? "",
    email_confirmed_at: iso(u.email_confirmed_at) ?? undefined,
    phone: u.phone ?? "",
    phone_confirmed_at: iso(u.phone_confirmed_at) ?? undefined,
    confirmation_sent_at: iso(u.confirmation_sent_at) ?? undefined,
    confirmed_at: iso(u.confirmed_at) ?? undefined,
    recovery_sent_at: iso(u.recovery_sent_at) ?? undefined,
    new_email: u.email_change || undefined,
    email_change_sent_at: iso(u.email_change_sent_at) ?? undefined,
    invited_at: iso(u.invited_at) ?? undefined,
    last_sign_in_at: iso(u.last_sign_in_at) ?? undefined,
    app_metadata: json(u.raw_app_meta_data),
    user_metadata: json(u.raw_user_meta_data),
    identities: await identitiesOf(q, u.id),
    ...(factors.length ? { factors } : {}),
    created_at: iso(u.created_at),
    updated_at: iso(u.updated_at),
    is_anonymous: !!u.is_anonymous,
    is_sso_user: !!u.is_sso_user,
    banned_until: iso(u.banned_until) ?? undefined,
  };
}

export interface CreateUserInput {
  email: string;
  password?: string | null;
  userMetadata?: Record<string, unknown>;
  appMetadata?: Record<string, unknown>;
  confirmed: boolean;
  provider: string;
  providerId?: string;
  identityData?: Record<string, unknown>;
  invited?: boolean;
  isSso?: boolean;
}

/**
 * Crée le compte et son identité. Les déclencheurs des migrations sur
 * auth.users (profil, organisation…) s'exécutent ici comme chez Supabase.
 */
export async function createUser(q: Query, input: CreateUserInput): Promise<UserRow> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const providers = [input.provider];
  const appMeta = { provider: input.provider, providers, ...(input.appMetadata ?? {}) };
  await q.query(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, invited_at,
       raw_app_meta_data, raw_user_meta_data, is_super_admin, created_at, updated_at, is_sso_user, is_anonymous)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', lower($2), $3, $4, $5,
       $6::jsonb, $7::jsonb, false, $8, $8, $9, false)`,
    [
      id, input.email, input.password ? await hashPassword(input.password) : null,
      input.confirmed ? now : null, input.invited ? now : null,
      JSON.stringify(appMeta), JSON.stringify(input.userMetadata ?? {}), now, !!input.isSso,
    ],
  );
  const identityData = input.identityData ?? {
    sub: id, email: input.email.toLowerCase(), email_verified: input.confirmed, phone_verified: false,
  };
  await q.query(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     values ($1, $2, $3::jsonb, $4, $5, $5, $5)`,
    [input.providerId ?? id, id, JSON.stringify(identityData), input.provider, now],
  );
  return (await getUserById(q, id))!;
}

// ── Sessions ────────────────────────────────────────────────────────────────

export interface Amr { method: string; timestamp: number }

export async function issueSession(db: Db, s: AuthSettings, user: UserRow, opts: {
  amr: Amr[]; aal?: "aal1" | "aal2"; sessionId?: string; userAgent?: string | null; ip?: string | null;
}) {
  const now = Math.floor(Date.now() / 1000);
  const sessionId = opts.sessionId ?? randomUUID();
  const refresh = randomToken(24);
  const aal = opts.aal ?? "aal1";
  await db.tx(async (q) => {
    if (!opts.sessionId) {
      await q.query(
        `insert into auth.sessions (id, user_id, created_at, updated_at, aal, user_agent, ip)
         values ($1, $2, now(), now(), $3::auth.aal_level, $4, $5::inet)`,
        [sessionId, user.id, aal, opts.userAgent ?? null, opts.ip && /^[0-9a-f:.]+$/i.test(opts.ip) ? opts.ip : null],
      );
    } else {
      await q.query("update auth.sessions set aal = $2::auth.aal_level, updated_at = now(), refreshed_at = now() where id = $1", [sessionId, aal]);
    }
    for (const a of opts.amr) {
      await q.query(
        `insert into auth.mfa_amr_claims (session_id, created_at, updated_at, authentication_method, id)
         values ($1, now(), now(), $2, gen_random_uuid())
         on conflict (session_id, authentication_method) do update set updated_at = now()`,
        [sessionId, a.method],
      );
    }
    await q.query(
      `insert into auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
       values ('00000000-0000-0000-0000-000000000000', $1, $2, false, now(), now(), $3)`,
      [refresh, user.id, sessionId],
    );
    await q.query("update auth.users set last_sign_in_at = now(), updated_at = now() where id = $1", [user.id]);
  });
  const fresh = (await getUserById(db, user.id))!;
  return sessionPayload(db, s, fresh, sessionId, refresh, aal, opts.amr, now);
}

export async function sessionPayload(q: Query, s: AuthSettings, user: UserRow, sessionId: string, refresh: string, aal: string, amr: Amr[], now = Math.floor(Date.now() / 1000)) {
  const exp = now + s.jwtExpiry;
  const access = signJwt({
    aud: "authenticated",
    exp,
    iat: now,
    iss: s.issuer,
    sub: user.id,
    email: user.email ?? "",
    phone: user.phone ?? "",
    app_metadata: json(user.raw_app_meta_data),
    user_metadata: json(user.raw_user_meta_data),
    role: user.role ?? "authenticated",
    aal,
    amr,
    session_id: sessionId,
    is_anonymous: !!user.is_anonymous,
  }, s.jwtSecret);
  return {
    access_token: access,
    token_type: "bearer",
    expires_in: s.jwtExpiry,
    expires_at: exp,
    refresh_token: refresh,
    user: await serializeUser(q, user),
  };
}

/** Les méthodes d'authentification d'une session (claim `amr`). */
export async function amrOf(q: Query, sessionId: string): Promise<Amr[]> {
  const rows = await q.query<{ authentication_method: string; updated_at: unknown }>(
    "select authentication_method, updated_at from auth.mfa_amr_claims where session_id = $1 order by updated_at desc", [sessionId]);
  return rows.map((r) => ({ method: r.authentication_method, timestamp: Math.floor(new Date(String(r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at)).getTime() / 1000) }));
}

export function isBanned(u: UserRow): boolean {
  return !!u.banned_until && new Date(String(u.banned_until)).getTime() > Date.now();
}
