// Le catalogue SQL des connecteurs maison (0293) suit CONNECTOR_ACTIONS.
//
// Le registre des ressources est écrit par des triggers SQL : il lit les
// actions des connecteurs maison dans public.connector_action_catalog, pas
// dans le TypeScript. Une action ajoutée, retirée ou passée en écriture côté
// TypeScript sans migration laisserait les pools sur un catalogue faux. Ce
// test le dit, et dit quoi faire.

import "../test-env.ts";

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const { catalogSql } = await import("./connector-catalog-sql.ts");

const MIGRATIONS = join(fileURLToPath(new URL(".", import.meta.url)), "../../../supabase/migrations");

describe("catalogue des connecteurs maison", () => {
  it("la dernière migration qui le synchronise reprend exactement CONNECTOR_ACTIONS", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    const latest = files.reverse().find((f) => readFileSync(join(MIGRATIONS, f), "utf8").includes("insert into public.connector_action_catalog"));
    assert.ok(latest, "aucune migration ne remplit connector_action_catalog");
    const sql = readFileSync(join(MIGRATIONS, latest!), "utf8").replace(/\r\n/g, "\n");
    assert.ok(sql.includes(catalogSql()),
      `${latest} ne correspond plus à _shared/connector-actions.ts. Régénérez le bloc dans une NOUVELLE migration : ` +
      "cd backend && npx tsx src/shared/connector-catalog-sql.ts");
  });
});
