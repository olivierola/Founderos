#!/usr/bin/env node
// Démarre FounderOS en local, en mode auto-hébergé (PLATFORM=self) : un seul
// backend Node (base PGlite, authentification, stockage, temps réel, fonctions,
// harnais OpenCode) et le front Vite branché dessus. Ni Supabase ni Docker.
//
//   npm run dev:local                       tout préparer puis démarrer
//   npm run dev:local -- --import "<URL>"   copier d'abord une base Supabase
//   npm run dev:local -- --no-harness       sans le harnais OpenCode
//   npm run dev:local -- --backend-only     sans le front
//   npm run dev:local -- --setup-only       préparer sans démarrer
//   npm run dev:local -- --skip-install     ne pas vérifier les dépendances
//   npm run dev:local -- --team-machine     (re)lancer aussi le conteneur de la machine d'équipe (Docker)
//
// Étapes : Node ≥ 22 ; dépendances ; backend/.env.self (créé depuis l'exemple,
// JWT_SECRET généré) ; migrations ; import éventuel ; .env.local du front
// (URL et clé anon de la plateforme, sans toucher au .env) ; démarrage des deux
// processus, le front une fois le backend prêt. Ctrl+C arrête tout.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = path.join(ROOT, "backend");
const ENV_SELF = path.join(BACKEND, ".env.self");
const ENV_SELF_EXAMPLE = path.join(BACKEND, ".env.self.example");
const FRONT_ENV_LOCAL = path.join(ROOT, ".env.local");
const WIN = process.platform === "win32";
const NPM = WIN ? "npm.cmd" : "npm";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const step = (msg) => console.log(`\n▸ ${msg}`);
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

/** Lance une commande et attend sa fin ; s'arrête si elle échoue. */
// Sous Windows, npm.cmd passe par le shell : un argument avec des caractères
// spéciaux (l'URL Postgres d'un import, son mot de passe) est mis entre guillemets.
const quote = (a) => (WIN && /[\s&|<>^"%!()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function run(cmd, cmdArgs, cwd, { capture = false } = {}) {
  const r = spawnSync(cmd, cmdArgs.map(quote), { cwd, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8", shell: WIN });
  if (r.status !== 0) fail(`${cmd} ${cmdArgs.join(" ")} a échoué (code ${r.status}).`);
  return r.stdout ?? "";
}

// ── Fichiers .env ────────────────────────────────────────────────────────────

const parseEnv = (text) => Object.fromEntries(
  text.split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
);

/** Pose des variables dans un fichier .env : remplace la ligne existante, ajoute sinon ; garde le reste. */
function setEnv(file, values, header) {
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    const active = new RegExp(`^[ \\t]*${k}[ \\t]*=.*$`, "m");
    const commented = new RegExp(`^[ \\t]*#[ \\t]*${k}[ \\t]*=.*$`, "m");
    if (active.test(text)) text = text.replace(active, line);
    else if (commented.test(text)) text = text.replace(commented, line);
    else {
      if (text && !text.endsWith(eol)) text += eol;
      if (header && !text.includes(header)) text += `${header}${eol}`;
      text += `${line}${eol}`;
    }
  }
  writeFileSync(file, text);
}

// ── 1. Node ──────────────────────────────────────────────────────────────────

step("Vérification de Node");
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) fail(`Node 22 ou plus est requis (installé : ${process.versions.node}).`);
console.log(`  Node ${process.versions.node}`);

// ── 2. Dépendances ───────────────────────────────────────────────────────────

if (!has("--skip-install")) {
  step("Dépendances");
  for (const dir of [ROOT, BACKEND]) {
    const label = path.relative(ROOT, dir) || "front";
    if (existsSync(path.join(dir, "node_modules"))) { console.log(`  ${label} : déjà installées`); continue; }
    console.log(`  ${label} : npm install…`);
    run(NPM, ["install"], dir);
  }
}

// ── 3. backend/.env.self ─────────────────────────────────────────────────────

step("Configuration du backend (backend/.env.self)");
if (!existsSync(ENV_SELF)) {
  if (!existsSync(ENV_SELF_EXAMPLE)) fail("backend/.env.self.example est introuvable.");
  copyFileSync(ENV_SELF_EXAMPLE, ENV_SELF);
  console.log("  créé depuis .env.self.example");
}
let env = parseEnv(readFileSync(ENV_SELF, "utf8"));
const fixes = {};
if (env.PLATFORM !== "self") fixes.PLATFORM = "self";
if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
  // Garder ce secret : les sessions et les clés anon / service_role en dérivent.
  fixes.JWT_SECRET = randomBytes(32).toString("hex");
  console.log("  JWT_SECRET généré");
}
if (!env.DATABASE_URL) fixes.DATABASE_URL = "pglite://./.data/pg";
if (!env.FUNCTIONS_URL) fixes.FUNCTIONS_URL = `http://localhost:${env.PORT || 8787}`;
const wantHarness = has("--no-harness") ? "0" : has("--harness") || env.HARNESS_OPENCODE === undefined ? "1" : env.HARNESS_OPENCODE;
if (env.HARNESS_OPENCODE !== wantHarness) fixes.HARNESS_OPENCODE = wantHarness;
if (Object.keys(fixes).length) setEnv(ENV_SELF, fixes);
env = parseEnv(readFileSync(ENV_SELF, "utf8"));
const backendUrl = (env.FUNCTIONS_URL || `http://localhost:${env.PORT || 8787}`).replace(/\/$/, "");
console.log(`  base : ${env.DATABASE_URL}`);
console.log(`  harnais OpenCode : ${env.HARNESS_OPENCODE === "1" ? "activé" : "désactivé"}`);
// ── La machine des équipes d'agents (team-machine/compose.yaml, :8091) ──
// Le backend et le conteneur partagent un jeton : celui de team-machine/secret
// (ignoré par git). Sans fichier, un jeton est créé ; le conteneur doit alors
// être (re)lancé avec lui : --team-machine le fait.
const MACHINE_SECRET = path.join(ROOT, "team-machine", "secret");
const machineFixes = {};
let machineToken = env.TEAM_MACHINE_TOKEN ?? "";
if (machineToken.length < 32) {
  if (existsSync(MACHINE_SECRET)) machineToken = readFileSync(MACHINE_SECRET, "utf8").trim();
  if (machineToken.length < 32) {
    machineToken = randomBytes(36).toString("base64url");
    writeFileSync(MACHINE_SECRET, machineToken);
    console.log("  jeton de la machine d'équipe créé (team-machine/secret)");
  }
  machineFixes.TEAM_MACHINE_TOKEN = machineToken;
}
if (!env.TEAM_MACHINE_URL) machineFixes.TEAM_MACHINE_URL = "http://localhost:8091";
if (Object.keys(machineFixes).length) {
  setEnv(ENV_SELF, machineFixes);
  env = parseEnv(readFileSync(ENV_SELF, "utf8"));
}
const machineUrl = env.TEAM_MACHINE_URL.replace(/\/$/, "");
const machineUp = async () => {
  try { return (await fetch(`${machineUrl}/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
};
if (has("--team-machine")) {
  console.log("  machine d'équipe : docker compose up (team-machine/compose.yaml)…");
  const r = spawnSync("docker", ["compose", "-f", path.join(ROOT, "team-machine", "compose.yaml"), "up", "-d", "--build"],
    { stdio: "inherit", env: { ...process.env, TEAM_MACHINE_TOKEN: machineToken } });
  if (r.status !== 0) console.log("  ⚠ docker compose a échoué : Docker Desktop tourne-t-il ?");
}
if (await machineUp()) {
  console.log(`  machine d'équipe : ${machineUrl} répond`);
} else {
  console.log(`  ⚠ machine d'équipe injoignable sur ${machineUrl}. Pour la lancer : npm run dev:local -- --team-machine`);
}

const LLM_KEYS = ["OPENROUTER_API_KEY", "LLM_API_KEY", "AZURE_OPENAI_API_KEY", "RUNWARE_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY"];
if (!LLM_KEYS.some((k) => env[k])) {
  console.log(`  ⚠ aucune clé de modèle dans .env.self (${LLM_KEYS.slice(0, 2).join(", ")}…) : les agents ne pourront pas répondre.`);
  console.log("    Ajoutez par exemple LLM_UPSTREAM=openrouter et OPENROUTER_API_KEY=… dans backend/.env.self.");
}

// ── 4. Migrations ────────────────────────────────────────────────────────────

step("Migrations de la base locale");
run(NPM, ["run", "--silent", "platform", "--", "migrate"], BACKEND);

// ── 5. Import éventuel ───────────────────────────────────────────────────────

const importUrl = opt("--import");
if (importUrl) {
  step("Import de la base Supabase");
  const importArgs = ["run", "--silent", "platform", "--", "import", "--from", importUrl];
  if (has("--force")) importArgs.push("--force");
  if (opt("--source-url") && opt("--source-key")) importArgs.push("--storage", "--source-url", opt("--source-url"), "--source-key", opt("--source-key"));
  run(NPM, importArgs, BACKEND);
}

// ── 6. Le front branché sur la plateforme (.env.local) ──────────────────────

step("Configuration du front (.env.local)");
const keysOut = run(NPM, ["run", "--silent", "platform", "--", "keys"], BACKEND, { capture: true });
const keys = parseEnv(keysOut);
if (!keys.VITE_SUPABASE_ANON_KEY) fail("`npm run platform -- keys` n'a pas rendu de clé anon.");
// .env.local l'emporte sur .env pour Vite : le .env du mode cloud reste intact.
setEnv(FRONT_ENV_LOCAL, {
  VITE_SUPABASE_URL: keys.VITE_SUPABASE_URL || backendUrl,
  VITE_SUPABASE_ANON_KEY: keys.VITE_SUPABASE_ANON_KEY,
  VITE_API_URL: keys.VITE_API_URL || backendUrl,
}, "# Plateforme auto-hébergée (scripts/start-local.mjs)");
console.log(`  front → ${backendUrl}`);
console.log("  (pour revenir au cloud : supprimez ces trois lignes de .env.local)");

if (has("--setup-only")) {
  console.log("\n✓ Prêt. Démarrez avec : npm run dev:local -- --skip-install");
  process.exit(0);
}

// ── 7. Démarrage ─────────────────────────────────────────────────────────────

const children = [];
function start(label, cmd, cmdArgs, cwd) {
  const child = spawn(cmd, cmdArgs, { cwd, shell: WIN, env: process.env });
  const prefix = (line) => `${label} │ ${line}`;
  for (const stream of [child.stdout, child.stderr]) {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) console.log(prefix(l));
    });
  }
  child.on("exit", (code) => {
    console.log(prefix(`arrêté (code ${code ?? "signal"})`));
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    // Sous Windows, le shell garde ses enfants : on arrête l'arbre entier.
    if (WIN) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else c.kill("SIGINT");
  }
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitForBackend(timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !stopping) {
    try {
      const res = await fetch(`${backendUrl}/health`);
      if (res.ok) return true;
    } catch { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

step("Démarrage");
start("backend", NPM, ["run", "dev:self"], BACKEND);
if (!has("--backend-only")) {
  console.log("  le front démarrera dès que le backend répondra (premier démarrage du harnais : ~20 s)…");
  if (await waitForBackend()) {
    start("front  ", NPM, ["run", "dev"], ROOT);
    console.log(`\n✓ Backend : ${backendUrl}   Front : http://localhost:5173 (ou le port affiché par Vite)   Ctrl+C pour arrêter.\n`);
  } else if (!stopping) {
    console.log("  ⚠ le backend ne répond pas sur /health : le front n'est pas lancé. Voir les messages « backend » ci-dessus.");
  }
}
