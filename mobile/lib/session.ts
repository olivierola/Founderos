import * as SecureStore from "expo-secure-store";
import { CONFIG } from "./config";

// A Anduran user session, persisted encrypted on-device. Mirrors the fields the
// Supabase auth REST endpoints return (we talk to them directly — no SDK).
export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix seconds
  user: { id: string; email: string | null };
}

const KEY = "founderos.session.v1";

// ── Supabase auth REST ───────────────────────────────────────────────────────
async function authFetch(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${CONFIG.supabaseUrl}/auth/v1/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: CONFIG.supabaseAnonKey,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.error_description || data?.msg || data?.error || data?.message || `Erreur ${res.status}`;
    throw new Error(String(msg));
  }
  return data;
}

function sessionFromToken(data: any): Session {
  const expiresAt = data.expires_at
    ? Number(data.expires_at)
    : Math.floor(Date.now() / 1000) + (Number(data.expires_in) || 3600);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    user: { id: data.user?.id ?? "", email: data.user?.email ?? null },
  };
}

export async function signInWithPassword(email: string, password: string): Promise<Session> {
  const data = await authFetch("token?grant_type=password", { email: email.trim(), password });
  return sessionFromToken(data);
}

export async function signUpWithPassword(email: string, password: string): Promise<Session | null> {
  const data = await authFetch("signup", { email: email.trim(), password });
  // If e-mail confirmation is required, there is no session yet.
  if (!data.access_token) return null;
  return sessionFromToken(data);
}

async function refresh(refreshToken: string): Promise<Session> {
  const data = await authFetch("token?grant_type=refresh_token", { refresh_token: refreshToken });
  return sessionFromToken(data);
}

// ── Persistence ──────────────────────────────────────────────────────────────
export async function loadSession(): Promise<Session | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export async function persistSession(session: Session | null): Promise<void> {
  if (session) await SecureStore.setItemAsync(KEY, JSON.stringify(session));
  else await SecureStore.deleteItemAsync(KEY);
}

// Returns a still-valid access token, transparently refreshing (and re-persisting)
// when the current one is within 60s of expiry. Throws if the session is dead.
export async function ensureFreshSession(session: Session): Promise<Session> {
  const now = Math.floor(Date.now() / 1000);
  if (session.expiresAt - now > 60) return session;
  const next = await refresh(session.refreshToken);
  await persistSession(next);
  return next;
}
