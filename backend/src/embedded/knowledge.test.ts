// La recherche sur la connaissance embarquée : la sémantique de search_grep et
// search_read (0308), sur un instantané en mémoire.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPatterns, globToLike } from "../harness/toolkit/grep.ts";
import { fromJsonl, localIndex, toJsonl, type SnapshotRow } from "./knowledge.ts";

const row = (id: string, p: Partial<SnapshotRow>): SnapshotRow => ({
  id, type: "documents", path: `documents/proc/${id}`, title: null, content: "", tags: [], meta: {},
  grp: `doc:${id}`, source_table: "rag_chunks", source_id: id, updated_at: "2026-11-01T00:00:00Z", created_at: "2026-11-01T00:00:00Z", ...p,
});

const rows: SnapshotRow[] = [
  row("a", { title: "Procédure de facturation", content: "Chaque facture part le 5 du mois.\nLes avoirs suivent.", grp: "doc:proc" }),
  row("b", { content: "La préfacturation n'est pas la facturation.", grp: "doc:proc", created_at: "2026-11-02T00:00:00Z" }),
  row("c", { content: "Livraison sous 48 h, facture jointe.", path: "documents/logistique/c", updated_at: "2026-11-03T00:00:00Z" }),
  row("m", { type: "memory", path: "memory/m", content: "Le client Durand préfère les factures papier." }),
];
const index = localIndex(rows);
const grep = (pattern: string, mode: "any" | "all" | "phrase" | "regex", extra: { types?: string[]; path?: string } = {}) => {
  const p = buildPatterns(pattern, mode);
  if (typeof p === "string") throw new Error(p);
  return index.grep({
    types: extra.types ?? ["documents", "memory"], regexes: p.regexes, all: p.all,
    path: globToLike(extra.path), limit: 50, offset: 0,
  });
};

describe("connaissance embarquée : recherche locale", () => {
  it("cherche en début de mot, sans accents ni casse", async () => {
    const ids = (await grep("FACTUR", "any")).map((r) => r.id);
    assert.ok(ids.includes("a") && ids.includes("c") && ids.includes("m"));
    // « préfacturation » ne commence pas par « factur », mais la ligne b contient aussi « facturation ».
    assert.ok(ids.includes("b"));
    assert.deepEqual((await grep("prefacturation", "any")).map((r) => r.id), ["b"]);
  });

  it("classe par nombre de motifs trouvés, titre compris, puis du plus récent", async () => {
    const hits = await grep("facture avoirs", "any");
    assert.equal(hits[0].id, "a", "deux mots et le titre");
    assert.ok(hits[0].score > hits[1].score);
    const tied = hits.filter((h) => h.score === 1).map((h) => h.id);
    assert.equal(tied[0], "c", "à score égal, le plus récent");
  });

  it("all, phrase, types et chemin", async () => {
    assert.deepEqual((await grep("facture jointe", "all")).map((r) => r.id), ["c"]);
    assert.deepEqual((await grep("sous 48", "phrase")).map((r) => r.id), ["c"]);
    assert.deepEqual((await grep("factur", "any", { types: ["memory"] })).map((r) => r.id), ["m"]);
    assert.deepEqual((await grep("factur", "any", { path: "documents/logistique/*" })).map((r) => r.id), ["c"]);
  });

  it("relit une ligne, ou tout son groupe", async () => {
    assert.deepEqual((await index.read(["a"], false)).map((r) => r.id), ["a"]);
    assert.deepEqual((await index.read(["a"], true)).map((r) => r.id), ["a", "b"]);
  });

  it("une expression invalide ne trouve rien au lieu d'échouer", async () => {
    assert.deepEqual(await index.grep({ types: ["documents"], regexes: ["(("], all: false, path: null, limit: 10, offset: 0 }), []);
  });

  it("JSON Lines aller-retour, une ligne abîmée ignorée", () => {
    const back = fromJsonl(`${toJsonl(rows)}{abîmé\n`);
    assert.equal(back.length, rows.length);
    assert.equal(back[0].title, "Procédure de facturation");
  });
});
