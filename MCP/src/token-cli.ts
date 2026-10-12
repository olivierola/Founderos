// Générateur de jetons d'API du serveur MCP.
//
// Jeton tournant (mode par défaut, AUTH_MODE=rotating) :
//   npm run token -- seed [--file seed.txt] [--period 24h]     la graine, une fois, à l'installation
//   npm run token -- current [--file seed.txt] [--period 24h]  le jeton de la période, à coller dans FounderOS
//
// Jetons fixes d'un fichier (AUTH_MODE=token) :
//   npm run token -- generate --label founderos-lecture --role ai-ops-reader [--expires 90] [--file tokens.json]
//   npm run token -- list [--file tokens.json]
//   npm run token -- revoke --id <id> [--file tokens.json]
//
// Dans l'image (sans Node local) : node dist/token-cli.js generate …
//
// `generate` affiche le jeton UNE fois : copiez-le dans FounderOS (Serveurs MCP
// → Jeton d'API). Le fichier ne garde que son empreinte ; il devient le Secret
// Kubernetes monté par le serveur (MCP_TOKENS_FILE), relu à chaud.
// Sans --scope, les scopes sont ceux que le catalogue accorde aux rôles donnés.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateToken, parseTokenFile, type TokenFile } from "./lib/api-tokens.ts";
import { loadCatalog } from "./lib/catalog.ts";
import { currentToken, generateSeed, parseDuration, readSeedFile, tokenIdOf } from "./lib/rotating-token.ts";

function args(argv: string[]) {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    (out[key] ??= []).push(v);
  }
  return out;
}

const load = (file: string): TokenFile => (existsSync(file) ? parseTokenFile(readFileSync(file, "utf8")) : { tokens: [] });
const save = (file: string, data: TokenFile) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });

function fail(msg: string): never {
  console.error(`erreur : ${msg}`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const opt = args(rest);
const file = opt.file?.[0] ?? (command === "seed" || command === "current" ? "seed.txt" : "tokens.json");

if (command === "seed") {
  if (existsSync(file) && opt.force?.[0] !== "true") fail(`${file} existe déjà : une nouvelle graine invalide le jeton de FounderOS (--force pour la remplacer)`);
  const period = parseDuration(opt.period?.[0] ?? "24h");
  writeFileSync(file, `${generateSeed()}
`, { mode: 0o600 });
  const seed = readSeedFile(file);
  console.log(`Graine du jeton tournant écrite dans ${file} (id du jeton : ${tokenIdOf(seed)}). Elle ne quitte jamais le serveur ; publiez-la comme Secret :`);
  console.log(`  kubectl -n ai-mcp create secret generic mcp-token-seed --from-file=seed=${file}`);
  console.log("");
  console.log("Jeton de la période en cours, à coller UNE fois dans FounderOS (Serveurs MCP → Jeton d'API) :");
  console.log("");
  console.log("  " + currentToken(seed, period));
  console.log("");
  console.log("Ensuite, le serveur livre lui-même chaque nouveau jeton à FounderOS (MCP_FOUNDEROS_URL).");
} else if (command === "current") {
  const seed = readSeedFile(file);
  const period = parseDuration(opt.period?.[0] ?? "24h");
  console.log(`Jeton de la période en cours (id ${tokenIdOf(seed)}, période de ${opt.period?.[0] ?? "24h"}) — à coller dans FounderOS pour réenrôler le serveur :`);
  console.log("");
  console.log("  " + currentToken(seed, period));
} else if (command === "generate") {
  const label = opt.label?.[0] ?? fail("--label requis (ex. founderos-lecture)");
  const roles = opt.role ?? [];
  let scopes = (opt.scope ?? []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  if (!roles.length && !scopes.length) fail("donnez au moins un --role (ex. ai-ops-reader) ou un --scope");
  const catalog = loadCatalog();
  for (const r of roles) if (!(r in catalog.role_scopes)) fail(`rôle inconnu du catalogue : ${r} (connus : ${Object.keys(catalog.role_scopes).join(", ")})`);
  if (!scopes.length) scopes = [...new Set(roles.flatMap((r) => catalog.role_scopes[r] ?? []))];
  const expires = opt.expires?.[0] ? Number(opt.expires[0]) : 90;
  if (!(expires > 0)) fail("--expires : un nombre de jours positif");
  const { token, entry } = generateToken({ label, roles, scopes, expiresInDays: expires });
  const data = load(file);
  data.tokens.push(entry);
  save(file, data);
  console.log(`Jeton « ${label} » (id ${entry.id}), valable jusqu'au ${entry.expires_at?.slice(0, 10)}.`);
  console.log(`Rôles : ${roles.join(", ") || "—"} · scopes : ${scopes.join(", ")}`);
  console.log("");
  console.log("  " + token);
  console.log("");
  console.log("Copiez-le maintenant dans FounderOS (Serveurs MCP → Jeton d'API) : il ne sera plus jamais affiché.");
  console.log(`Le fichier ${file} ne contient que son empreinte. Publiez-le comme Secret :`);
  console.log(`  kubectl -n ai-mcp create secret generic mcp-tokens --from-file=tokens.json=${file} --dry-run=client -o yaml | kubectl apply -f -`);
} else if (command === "list") {
  for (const t of load(file).tokens) {
    const state = t.revoked_at ? `révoqué le ${t.revoked_at.slice(0, 10)}` : t.expires_at && Date.parse(t.expires_at) <= Date.now() ? "expiré" : `valable jusqu'au ${t.expires_at?.slice(0, 10) ?? "—"}`;
    console.log(`${t.id}  ${t.label.padEnd(24)}  ${state}  rôles=${t.roles.join(",") || "—"}  scopes=${t.scopes.join(",")}`);
  }
} else if (command === "revoke") {
  const id = opt.id?.[0] ?? fail("--id requis (voir « list »)");
  const data = load(file);
  const t = data.tokens.find((x) => x.id === id) ?? fail(`aucun jeton ${id} dans ${file}`);
  t.revoked_at = new Date().toISOString();
  save(file, data);
  console.log(`Jeton ${id} révoqué. Republiez le Secret : le serveur le relit en quelques secondes.`);
} else {
  console.log("usage : token seed [--file seed.txt] [--period 24h] [--force]");
  console.log("        token current [--file seed.txt] [--period 24h]");
  console.log("        token generate --label <nom> --role <rôle> [--scope s] [--expires jours] [--file tokens.json]");
  console.log("        token list [--file tokens.json]");
  console.log("        token revoke --id <id> [--file tokens.json]");
  process.exit(command ? 1 : 0);
}
