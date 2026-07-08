// App configuration. The anon key is a public client key (safe to ship).
export const CONFIG = {
  supabaseUrl: "https://scugmxahflsjabglodyv.supabase.co",
  supabaseAnonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjdWdteGFoZmxzamFiZ2xvZHl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4OTAxMjYsImV4cCI6MjA5NTQ2NjEyNn0.HmmO5unnIPPMqhOzdQAR_HElZaVon_oWkIrDp0GsmGI",

  // Edge function that authenticates an agent by (id + secret) and replies. The
  // `mobile_chat` mode lives inside internal-agent-run (kept under the 100-fn cap).
  chatFunction: "internal-agent-run",

  // Set to true to run register → chat with canned replies (no backend). With the
  // real backend deployed (migration 0105 + mobile_chat mode) and a secret
  // generated in the web agent settings, keep this false.
  mock: false,
};
