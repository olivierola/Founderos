// Acquisition attribution — where a new account came from.
//
// The public widget's « Powered by » link carries ?ref=widget&agent=<public
// key>&utm_*: every embedded agent advertises the product on a customer's
// site, and this is what tells us which customer brought which sign-up.
//
// First touch wins, kept 30 days in localStorage: the visitor who clicks the
// badge today and signs up next week is still credited to it. It is written
// into the user's metadata at email sign-up, or on the first session for OAuth
// sign-ups (which cannot carry metadata through the redirect).
import { supabase } from "@/lib/supabase";

const KEY = "fos-acquisition";
const TTL_MS = 30 * 86_400_000;
const PARAMS = ["ref", "agent", "utm_source", "utm_medium", "utm_campaign", "utm_content"] as const;

export type Acquisition = Partial<Record<(typeof PARAMS)[number], string>> & {
  landing?: string;
  referrer?: string;
  at: number;
};

/** Read the landing URL once, at boot. Keeps the FIRST touch only. */
export function captureAttribution(): void {
  try {
    const url = new URL(window.location.href);
    const found: Partial<Record<(typeof PARAMS)[number], string>> = {};
    for (const p of PARAMS) {
      const v = url.searchParams.get(p);
      if (v) found[p] = v.slice(0, 120);
    }
    if (Object.keys(found).length === 0) return;
    const existing = readAttribution();
    if (existing) return;
    const record: Acquisition = {
      ...found,
      landing: url.pathname.slice(0, 200),
      referrer: document.referrer ? new URL(document.referrer).host : undefined,
      at: Date.now(),
    };
    localStorage.setItem(KEY, JSON.stringify(record));
  } catch { /* private mode / bad URL: attribution is best-effort */ }
}

export function readAttribution(): Acquisition | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as Acquisition;
    if (!rec.at || Date.now() - rec.at > TTL_MS) { localStorage.removeItem(KEY); return null; }
    return rec;
  } catch {
    return null;
  }
}

/** For OAuth sign-ups: attach the stored touch to the account once, then
 *  forget it. No-op if the account already has one. */
export async function persistAttributionToUser(user: { user_metadata?: Record<string, unknown> } | null): Promise<void> {
  const rec = readAttribution();
  if (!rec || !user) return;
  if (user.user_metadata?.acquisition) {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    return;
  }
  const { error } = await supabase.auth.updateUser({ data: { acquisition: rec } });
  if (!error) { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
}
