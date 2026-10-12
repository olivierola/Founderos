// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/supabase-admin.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.
import { Deno } from "../../compat/index.ts";

import { createClient, SupabaseClient } from "@supabase/supabase-js";

export function createServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Accepts the raw Authorization header — or the whole Request (several ops
// functions pass `req` directly; before this normalization that produced an
// "Authorization: [object Request]" header and every call died with 401).
export function createUserClient(authHeaderOrReq: string | Request | null): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const authHeader =
    authHeaderOrReq instanceof Request
      ? authHeaderOrReq.headers.get("Authorization")
      : authHeaderOrReq;
  return createClient(url, anonKey, {
    global: { headers: authHeader ? { Authorization: authHeader } : {} },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
