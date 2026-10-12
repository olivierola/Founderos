#!/usr/bin/env node
// Branche le front et le backend Express sur la stack Supabase LOCALE.
//
// À lancer depuis la racine, une fois `npx supabase start` terminé :
//   node scripts/dev-local-env.mjs
//
// Écrit deux fichiers ignorés par git, qui l'emportent sur les .env :
//   .env.local          front (Vite)    : Supabase local + VITE_API_URL
//   backend/.env.local  backend Express : clés locales, SSO ouvert, passerelle stricte
// puis affiche le SQL qui remplit le vault (tâches pg_cron → backend).
//
// Les clés LLM ne sont pas touchées : ajoutez DEEPSEEK_API_KEY, ou les
// variables AZURE_OPENAI_*, dans backend/.env.local.

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

let raw;
try {
  raw = execSync("npx --no-install supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  console.error("`supabase status` a échoué : la stack locale tourne-t-elle (npx supabase start) ?\n");
  console.error(String(e.stderr ?? e.message));
  process.exit(1);
}

const status = Object.fromEntries(
  raw.split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=(?:"(.*)"|(.*))$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2] ?? m[3]]),
);
for (const key of ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY"]) {
  if (!status[key]) {
    console.error(`${key} absent de \`supabase status -o env\`.`);
    process.exit(1);
  }
}

/** Garde les lignes déjà présentes (une clé LLM ajoutée à la main), remplace les nôtres. */
function writeEnv(file, values, header) {
  const kept = existsSync(file)
    ? readFileSync(file, "utf8").split(/\r?\n/).filter((l) => {
        const k = l.match(/^([A-Z0-9_]+)=/)?.[1];
        return l.trim() && !l.startsWith("#") && !(k && k in values);
      })
    : [];
  const lines = [header, ...Object.entries(values).map(([k, v]) => `${k}=${v}`), ...kept];
  writeFileSync(file, lines.join("\n") + "\n");
}

// Le secret partagé entre pg_cron et internal-agent-run : gardé s'il existe déjà.
const previous = existsSync("backend/.env.local") ? readFileSync("backend/.env.local", "utf8") : "";
const tickSecret = previous.match(/^AGENT_TICK_SECRET=(.+)$/m)?.[1] ?? randomBytes(24).toString("hex");

writeEnv(".env.local", {
  VITE_SUPABASE_URL: status.API_URL,
  VITE_SUPABASE_ANON_KEY: status.ANON_KEY,
  VITE_API_URL: "http://localhost:8787",
}, "# Écrit par scripts/dev-local-env.mjs — stack Supabase locale.");

writeEnv("backend/.env.local", {
  SUPABASE_URL: status.API_URL,
  SUPABASE_ANON_KEY: status.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  ...(status.JWT_SECRET ? { SUPABASE_JWT_SECRET: status.JWT_SECRET } : {}),
  PORT: "8787",
  // Vu depuis les conteneurs Supabase (pg_net) : l'hôte, pas localhost.
  FUNCTIONS_URL: "http://host.docker.internal:8787",
  TRUST_PROXY: "loopback",
  GATEWAY_VERIFY_JWT: "strict",
  APP_URL: "http://localhost:5173",
  SSO_ADMIN_ENABLED: "1",
  SSO_ALLOW_HTTP: "1",
  AGENT_TICK_SECRET: tickSecret,
}, "# Écrit par scripts/dev-local-env.mjs — stack Supabase locale. Ajoutez vos clés LLM en dessous.");

console.log("Écrit : .env.local et backend/.env.local\n");
console.log("À exécuter une fois dans Studio (" + (status.STUDIO_URL ?? "http://127.0.0.1:54323") + " → SQL Editor) :\n");
console.log(`select vault.create_secret('http://host.docker.internal:8787', 'functions_base_url');
select vault.create_secret('${status.SERVICE_ROLE_KEY}', 'agent_service_key');
select vault.create_secret('${tickSecret}', 'agent_tick_secret');
`);
console.log("Puis : npm run dev:backend  (terminal 1)   et   npm run dev  (terminal 2).");
