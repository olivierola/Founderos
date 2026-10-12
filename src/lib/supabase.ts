import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./runtime-config";

const url = SUPABASE_URL;
const anonKey = SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing Supabase URL or anon key: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY at build time, or FOUNDEROS_SUPABASE_URL and FOUNDEROS_SUPABASE_ANON_KEY in the interface container.",
  );
}

export const supabase: SupabaseClient = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
