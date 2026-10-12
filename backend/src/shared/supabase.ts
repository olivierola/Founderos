// Mêmes noms que supabase/functions/_shared/supabase-admin.ts, pour que le code
// porté depuis les edge functions change le moins possible.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.ts";

let serviceClient: SupabaseClient | null = null;

/**
 * Client service role : il IGNORE RLS. Toute route qui s'en sert vérifie les
 * droits de l'appelant elle-même, avec les gardes de ./authz.ts.
 */
export function createServiceClient(): SupabaseClient {
  serviceClient ??= createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serviceClient;
}

/** Client au nom de l'utilisateur : ses requêtes passent par RLS. */
export function createUserClient(authHeader: string | null | undefined): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    global: { headers: authHeader ? { Authorization: authHeader } : {} },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
