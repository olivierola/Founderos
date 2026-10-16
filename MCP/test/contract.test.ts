// Contrat des tools : chaque tool de chaque module, construit depuis les
// exemples de configuration (qui doivent donc rester valables), respecte les
// règles qui font la rigueur du serveur :
//   - un nom, une description utile, un scope au catalogue, la même nature
//     lecture/écriture que le catalogue ;
//   - aucun paramètre sans borne : chaîne bornée en longueur ou par une
//     expression ancrée, nombre borné des deux côtés, liste bornée ;
//   - le catalogue ne cite que des tools qui existent, et n'exige d'approbation
//     que pour des écritures.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { loadCatalog, type Cluster } from "../src/lib/catalog.ts";
import type { AnyToolSpec } from "../src/lib/tool.ts";
import { SERVERS } from "../src/servers/index.ts";
import { fakeSecrets } from "./helpers.ts";

const examples = path.join(path.dirname(fileURLToPath(import.meta.url)), "../config/examples");
const catalog = loadCatalog();

/** Les tools de chaque module, depuis ses exemples (module.cluster.json). */
function allTools(): Array<{ module: string; tool: AnyToolSpec }> {
  const out: Array<{ module: string; tool: AnyToolSpec }> = [];
  for (const file of readdirSync(examples).filter((f) => f.endsWith(".json"))) {
    const [module, cluster] = file.split(".");
    const mod = SERVERS[module];
    assert.ok(mod, `${file} : module inconnu`);
    const parsed = mod.configSchema.safeParse(JSON.parse(readFileSync(path.join(examples, file), "utf8")));
    assert.ok(parsed.success, `${file} : configuration invalide : ${parsed.success ? "" : JSON.stringify(parsed.error.issues).slice(0, 300)}`);
    for (const tool of mod.createTools({ config: parsed.data, cluster: cluster as Cluster, secrets: fakeSecrets })) out.push({ module, tool });
  }
  return out;
}

/** Ce qui ne va pas dans un paramètre (vide : borné). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unbounded(schema: any, where: string): string[] {
  const def = schema._zod.def;
  const checks = (def.checks ?? []).map((c: { _zod: { def: Record<string, unknown> } }) => c._zod.def);
  switch (def.type) {
    case "optional": case "default": case "nullable": case "readonly": case "prefault":
      return unbounded(def.innerType, where);
    case "string": {
      const anchored = checks.some((c: Record<string, unknown>) => c.format === "regex" && /^\/\^.*\$\/[a-z]*$/.test(String(c.pattern)));
      return schema.maxLength != null || anchored ? [] : [`${where} : chaîne sans longueur maximale ni expression ancrée`];
    }
    case "number":
      return Number.isFinite(schema.minValue) && Number.isFinite(schema.maxValue) ? [] : [`${where} : nombre non borné`];
    case "array": {
      const max = checks.some((c: Record<string, unknown>) => c.check === "max_length");
      return [...(max ? [] : [`${where} : liste sans taille maximale`]), ...unbounded(def.element, `${where}[]`)];
    }
    case "object":
      return Object.entries(def.shape as Record<string, z.ZodTypeAny>).flatMap(([k, v]) => unbounded(v, `${where}.${k}`));
    case "enum": case "boolean": case "literal":
      return [];
    default:
      return [`${where} : type ${def.type} non vérifié`];
  }
}

describe("contrat des tools", () => {
  const tools = allTools();
  const names = new Set(tools.map((t) => t.tool.name));

  it("chaque exemple de configuration est valable et chaque module fournit des tools", () => {
    assert.ok(tools.length >= 30, `${tools.length} tools seulement`);
    for (const m of Object.keys(SERVERS)) assert.ok(tools.some((t) => t.module === m), `${m} n'a pas d'exemple de configuration`);
  });

  it("nom, description utile, scope au catalogue, nature lecture/écriture identique au catalogue", () => {
    const problems: string[] = [];
    for (const { module, tool } of tools) {
      if (!/^[a-z][a-z0-9_]{2,40}$/.test(tool.name)) problems.push(`${module}/${tool.name} : nom`);
      if (tool.description.length < 30 || tool.description.length > 400) problems.push(`${module}/${tool.name} : description de ${tool.description.length} caractères`);
      if (!catalog.scopes[tool.name]) problems.push(`${module}/${tool.name} : pas de scope au catalogue`);
      if (catalog.write_tools.includes(tool.name) !== tool.write) problems.push(`${module}/${tool.name} : écriture ${tool.write} dans le code, pas dans le catalogue`);
    }
    assert.deepEqual(problems, []);
  });

  it("aucun paramètre sans borne", () => {
    const problems = tools.flatMap(({ module, tool }) =>
      Object.entries(tool.input as Record<string, z.ZodTypeAny>).flatMap(([k, v]) => unbounded(v, `${module}/${tool.name}.${k}`)));
    assert.deepEqual(problems, []);
  });

  it("le catalogue ne cite que des tools qui existent ; l'approbation ne vise que des écritures", () => {
    for (const [cluster, list] of Object.entries(catalog.tools)) {
      for (const t of list) assert.ok(names.has(t), `catalogue ${cluster} : ${t} n'existe dans aucun module`);
    }
    for (const t of Object.keys(catalog.scopes)) assert.ok(names.has(t), `scope sans tool : ${t}`);
    for (const [cluster, list] of Object.entries(catalog.approval_required)) {
      for (const t of list) assert.ok(catalog.write_tools.includes(t), `approbation en ${cluster} pour une lecture : ${t}`);
    }
  });

  it("chaque écriture accepte une simulation : dry_run booléen, faux par défaut", () => {
    for (const { module, tool } of tools.filter((t) => t.tool.write)) {
      const dry = (tool.input as Record<string, z.ZodTypeAny>).dry_run;
      assert.ok(dry, `${module}/${tool.name} : pas de dry_run`);
      assert.equal(dry.parse(undefined), false, `${module}/${tool.name} : dry_run doit valoir false par défaut`);
      assert.equal(dry.safeParse("oui").success, false);
    }
  });

  it("chaque module déclare ses vérifications de disponibilité, sous des noms distincts", () => {
    const seen = new Set<string>();
    for (const file of readdirSync(examples).filter((f) => f.endsWith(".json"))) {
      const [module, cluster] = file.split(".");
      const mod = SERVERS[module];
      const config = mod.configSchema.parse(JSON.parse(readFileSync(path.join(examples, file), "utf8")));
      const checks = mod.checks?.({ config, cluster: cluster as Cluster, secrets: fakeSecrets }) ?? [];
      assert.ok(checks.length, `${module} ne vérifie rien`);
      for (const c of checks) {
        assert.equal(c.critical, false, `${c.name} : un outil indisponible ne doit pas retirer le serveur du service`);
        seen.add(c.name);
      }
    }
    assert.ok(seen.size >= 10, `${seen.size} vérifications`);
  });

  it("le Hub (FounderOS et son serveur MCP) et PRD : toute écriture sur leurs ressources exige une approbation", () => {
    for (const cluster of ["hub", "prd"] as const) {
      const writes = catalog.tools[cluster].filter((t) => catalog.write_tools.includes(t) && t !== "alert_silence_create");
      for (const t of writes) assert.ok(catalog.approval_required[cluster]?.includes(t), `${cluster} : ${t} sans approbation`);
    }
  });

  it("un serveur par cluster : chaque cluster du catalogue a ses valeurs Helm, et ses modules fournissent tous ses tools", () => {
    const values = path.join(path.dirname(fileURLToPath(import.meta.url)), "../deploy/values");
    for (const [cluster, list] of Object.entries(catalog.tools)) {
      const file = path.join(values, `cluster-${cluster}.yaml`);
      const yaml = readFileSync(file, "utf8");
      assert.match(yaml, new RegExp(`^cluster: ${cluster}$`, "m"), `${file} : cluster`);
      const servers = /^servers: \[([^\]]+)\]$/m.exec(yaml)?.[1].split(",").map((s) => s.trim()) ?? [];
      const offered = new Set(tools.filter((t) => servers.includes(t.module)).map((t) => t.tool.name));
      for (const t of list) assert.ok(offered.has(t), `${cluster} : ${t} au catalogue, mais aucun module de [${servers}] ne le fournit`);
    }
  });

  it("chaque scope d'écriture n'est accordé qu'au rôle opérateur", () => {
    const writeScopes = new Set(catalog.write_tools.map((t) => catalog.scopes[t]));
    for (const s of writeScopes) {
      assert.ok(!catalog.role_scopes["ai-ops-reader"].includes(s), `le lecteur détient ${s}`);
      assert.ok(catalog.role_scopes["ai-ops-operator"].includes(s), `l'opérateur ne détient pas ${s}`);
    }
  });
});
