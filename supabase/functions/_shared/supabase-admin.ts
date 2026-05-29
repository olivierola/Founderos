import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export function createServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createUserClient(authHeader: string | null): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(url, anonKey, {
    global: { headers: authHeader ? { Authorization: authHeader } : {} },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
