import { apiKeys } from "./platform/jwt.ts";

// Configuration lue une seule fois, au démarrage. Une variable manquante arrête
// le serveur immédiatement plutôt qu'au premier appel qui en aurait besoin.

// Les variables déjà présentes dans l'environnement gardent la priorité, puis
// .env.local (la stack Supabase locale, écrit par scripts/dev-local-env.mjs),
// puis .env. loadEnvFile n'écrase jamais une variable déjà définie.
// Sous `node --test` (NODE_TEST_CONTEXT), rien n'est lu : les clés locales
// (OPENROUTER_API_KEY…) changeraient la passerelle des tests et les feraient
// appeler les vrais fournisseurs.
for (const file of process.env.NODE_TEST_CONTEXT ? [] : [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Fichier absent : en production, tout vient de l'hébergeur.
  }
}

// ── Plateforme : Supabase, ou auto-hébergée ──────────────────────────────────
// PLATFORM=supabase (défaut) : base, auth, storage et realtime chez Supabase.
// PLATFORM=self : ce backend les sert lui-même sur DATABASE_URL (src/platform).
// Le code des fonctions parle à SUPABASE_URL avec les clés SUPABASE_* : en
// mode self, ce sont l'URL de ce backend et des clés signées par JWT_SECRET —
// le code porté ne voit aucune différence, et revenir à Supabase ne demande
// que de remettre PLATFORM=supabase.
const platformMode = (process.env.PLATFORM || "supabase").toLowerCase();
if (platformMode !== "supabase" && platformMode !== "self") {
  throw new Error(`PLATFORM doit valoir "supabase" ou "self" (reçu : "${process.env.PLATFORM}").`);
}
const port = Number(process.env.PORT ?? 8787);
if (platformMode === "self") {
  const missingSelf = ["DATABASE_URL", "JWT_SECRET"].filter((n) => !process.env[n]);
  if (missingSelf.length) {
    throw new Error(`PLATFORM=self : variables manquantes : ${missingSelf.join(", ")} (voir backend/.env.example, « Plateforme auto-hébergée »).`);
  }
  if (process.env.JWT_SECRET!.length < 32) throw new Error("JWT_SECRET doit faire au moins 32 caractères.");
  const keys = apiKeys(process.env.JWT_SECRET!);
  const self = (process.env.FUNCTIONS_URL || `http://localhost:${port}`).replace(/\/$/, "");
  // Forcés, pas « par défaut » : des clés Supabase restées dans le .env ne
  // doivent pas faire parler le backend à l'ancienne instance.
  process.env.SUPABASE_URL = self;
  process.env.SUPABASE_ANON_KEY = process.env.PLATFORM_ANON_KEY || keys.anon;
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.PLATFORM_SERVICE_ROLE_KEY || keys.service;
  process.env.SUPABASE_JWT_SECRET = process.env.JWT_SECRET;
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
  /** La plateforme auto-hébergée, quand PLATFORM=self. */
  platform: platformMode === "self"
    ? {
      databaseUrl: process.env.DATABASE_URL!,
      jwtSecret: process.env.JWT_SECRET!,
      schemas: (process.env.PGRST_DB_SCHEMAS || "public").split(",").map((x) => x.trim()).filter(Boolean),
      migrate: process.env.PLATFORM_MIGRATE !== "false",
      workers: process.env.PLATFORM_WORKERS !== "false",
      storageDir: process.env.STORAGE_DIR || "./.data/storage",
    }
    : null,
};
