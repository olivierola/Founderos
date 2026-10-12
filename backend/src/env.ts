// Configuration lue une seule fois, au démarrage. Une variable manquante arrête
// le serveur immédiatement plutôt qu'au premier appel qui en aurait besoin.

// Les variables déjà présentes dans l'environnement gardent la priorité, puis
// .env.local (la stack Supabase locale, écrit par scripts/dev-local-env.mjs),
// puis .env. loadEnvFile n'écrase jamais une variable déjà définie.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Fichier absent : en production, tout vient de l'hébergeur.
  }
}

const REQUIRED = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(
    `Variables d'environnement manquantes : ${missing.join(", ")}. ` +
      "Copiez backend/.env.example vers backend/.env et remplissez-les.",
  );
}

/** `TRUST_PROXY` accepte un nombre de sauts, un booléen ou une valeur Express ("loopback"…). */
function parseTrustProxy(raw: string | undefined): number | boolean | string {
  if (raw === undefined || raw === "") return 1;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

const gatewayMode = process.env.GATEWAY_VERIFY_JWT || "production";
if (gatewayMode !== "production" && gatewayMode !== "strict") {
  throw new Error(`GATEWAY_VERIFY_JWT doit valoir "production" ou "strict" (reçu : "${gatewayMode}").`);
}

const port = Number(process.env.PORT ?? 8787);

// Port de gestion (/metrics) : 0 le désactive. Jamais exposé par une Route.
const mgmtPort = Number(process.env.MGMT_PORT ?? 9090);

export const env = {
  port,
  mgmtPort,
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  /** Optionnel : vérifie localement les JWT HS256 au lieu d'interroger Supabase Auth. */
  supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET || null,
  /** URL publique de ce backend : appels entre fonctions, webhooks, redirections OAuth. */
  functionsUrl: (process.env.FUNCTIONS_URL || `http://localhost:${port}`).replace(/\/$/, ""),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  /** Fonctions soumises au JWT : celles de la production, ou toutes (voir shared/gateway.ts). */
  gatewayMode: gatewayMode as "production" | "strict",
};
