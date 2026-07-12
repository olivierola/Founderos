// App configuration. The anon key is a public client key (safe to ship).
export const CONFIG = {
  supabaseUrl: "https://scugmxahflsjabglodyv.supabase.co",
  supabaseAnonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjdWdteGFoZmxzamFiZ2xvZHl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4OTAxMjYsImV4cCI6MjA5NTQ2NjEyNn0.HmmO5unnIPPMqhOzdQAR_HElZaVon_oWkIrDp0GsmGI",

  // Edge function that authenticates the user (account JWT) and serves the mobile
  // chat protocol. The `mobile` mode lives inside internal-agent-run (100-fn cap).
  chatFunction: "internal-agent-run",
};
