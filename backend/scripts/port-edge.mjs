#!/usr/bin/env node
// Génère backend/src/edge/ à partir de supabase/functions/.
//
// Les edge functions sont copiées avec leur arborescence (les imports relatifs
// `../_shared/x.ts` restent valides) et seules les parties propres au runtime
// Supabase sont réécrites :
//   - imports https://esm.sh/<paquet>@<version> → paquet npm ;
//   - Deno.serve(handler) → export default defineHandler(handler) ;
//   - ${<base>}/functions/v1/ → ${FUNCTIONS_URL}/functions/v1/ (ce backend) ;
//   - Deno.env / resolveDns / connectTls / readTextFile → objet `Deno` de src/compat.
//
// Les fonctions déjà réécrites à la main (src/functions/<nom>.ts, src/ws/<nom>.ts)
// ne sont pas générées. Le script vide src/edge/ avant d'écrire : on n'y modifie
// jamais rien à la main, on corrige la source puis on relance.
//
// Usage : npm run port:edge (depuis backend/)

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.resolve(backendDir, "../supabase/functions");
const configToml = path.resolve(backendDir, "../supabase/config.toml");
const outDir = path.join(backendDir, "src/edge");
const compatModule = path.join(backendDir, "src/compat/index.ts");

/** Modules deno.land/x importés par les fonctions, et leur paquet npm (même version dans package.json). */
const DENO_LAND_MODULES = [
  [/(["'])https:\/\/deno\.land\/x\/zipjs@v[\d.]+\/index\.js\1/g, "@zip.js/zip.js"],
];

/** Noms des fonctions réécrites à la main : un fichier <nom>.ts dans ces dossiers. */
function handWrittenFunctions() {
  const names = new Set();
  for (const dir of ["src/functions", "src/ws"]) {
    const abs = path.join(backendDir, dir);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs)) {
      if (file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "index.ts") {
        names.add(file.slice(0, -3));
      }
    }
  }
  return names;
}

/** Fonctions déclarées `verify_jwt = false` dans supabase/config.toml. */
function noVerifyJwtFunctions() {
  const names = [];
  let section = "";
  for (const raw of readFileSync(configToml, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) section = header[1];
    else if (/^verify_jwt\s*=\s*false$/.test(line) && section.startsWith("functions.")) {
      names.push(section.slice("functions.".length));
    }
  }
  return names.sort();
}

function listTsFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) return listTsFiles(abs);
    return entry.endsWith(".ts") ? [abs] : [];
  });
}

function transform(code, outFile, sourceRel) {
  const needs = new Set();
  let out = code;

  out = out.replace(
    /(["'])https:\/\/esm\.sh\/((?:@[^/@"'?]+\/)?[^/@"'?]+)@[^/"'?]+(\/[^"'?]*)?(?:\?[^"']*)?\1/g,
    (_m, quote, pkg, subpath = "") => `${quote}${pkg}${subpath}${quote}`,
  );
  for (const [pattern, pkg] of DENO_LAND_MODULES) {
    out = out.replace(pattern, (_m, quote) => `${quote}${pkg}${quote}`);
  }

  if (/\bDeno\.serve\(/.test(out)) {
    out = out.replace(/\bDeno\.serve\(/g, "export default defineHandler(");
    needs.add("defineHandler");
  }

  // Le `(?<!\\)` épargne les modèles de code échappés (SDK générés pour les clients).
  out = out.replace(/(?<!\\)\$\{[^}]+\}\/functions\/v1\//g, () => {
    needs.add("FUNCTIONS_URL");
    return "${FUNCTIONS_URL}/functions/v1/";
  });

  if (/\bDeno\.(env|resolveDns|connectTls|readTextFile)\b|typeof Deno\b/.test(out)) needs.add("Deno");

  let importLine = "";
  if (needs.size) {
    let rel = path.relative(path.dirname(outFile), compatModule).replace(/\\/g, "/");
    if (!rel.startsWith(".")) rel = `./${rel}`;
    importLine = `import { ${[...needs].sort().join(", ")} } from "${rel}";\n`;
  }

  const header =
    `// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/${sourceRel}.\n` +
    "// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.\n";

  // En tête de fichier : certains modules contiennent du code client dans des
  // chaînes, où une ligne « import … » ne marque pas le début des vrais imports.
  return header + importLine + "\n" + out;
}

const skip = handWrittenFunctions();
const functionNames = [];

rmSync(outDir, { recursive: true, force: true });

for (const entry of readdirSync(sourceDir).sort()) {
  const dir = path.join(sourceDir, entry);
  if (!statSync(dir).isDirectory()) continue;
  const isShared = entry === "_shared";
  if (!isShared) {
    if (!existsSync(path.join(dir, "index.ts"))) continue; // pas une fonction
    if (skip.has(entry)) continue;
    functionNames.push(entry);
  }
  for (const file of listTsFiles(dir)) {
    const sourceRel = path.relative(sourceDir, file).replace(/\\/g, "/");
    const outFile = path.join(outDir, sourceRel);
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, transform(readFileSync(file, "utf8"), outFile, sourceRel));
  }
}

const noVerify = noVerifyJwtFunctions();
const registry = `// GÉNÉRÉ par backend/scripts/port-edge.mjs — ne pas modifier à la main.

import type { EdgeHandler } from "../compat/index.ts";

export type EdgeModule = { default: EdgeHandler };

/**
 * Fonctions sans vérification du JWT à la passerelle (\`verify_jwt = false\`
 * dans supabase/config.toml, où chaque exception est justifiée).
 */
export const NO_VERIFY_JWT: ReadonlySet<string> = new Set([
${noVerify.map((n) => `  "${n}",`).join("\n")}
]);

/** Fonctions générées, chargées à la première requête. */
export const edgeFunctions: Record<string, () => Promise<EdgeModule>> = {
${functionNames.map((n) => `  "${n}": () => import("./${n}/index.ts"),`).join("\n")}
};
`;
writeFileSync(path.join(outDir, "registry.ts"), registry);

console.log(
  `[port-edge] ${functionNames.length} fonctions générées dans src/edge/ ` +
    `(${skip.size} réécrites à la main ignorées : ${[...skip].sort().join(", ")}).`,
);
