// grep sur la base de connaissances (toolkit/grep.ts) : le pliage, les motifs,
// les lignes au format ripgrep, puis build_context(from) qui relit les sources.
// L'index SQL lui-même est testé dans search-index.e2e.test.ts.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LegacyToolset } from "./toolkit/catalogue.ts";
import { buildContext, contextPage, newContextState } from "./toolkit/context.ts";
import {
  buildPatterns, documentCollections, fold, foldPattern, globToLike, grep, grepTypesFor, matchingLines,
  type IndexRow, type SearchIndex,
} from "./toolkit/grep.ts";
import { applyPoolToToolRows, emptyScope } from "../edge/_shared/resource-pools.ts";

const row = (id: string, type: string, path: string, title: string, content: string, grp = id): IndexRow => ({
  id, type, path, title, content, tags: [], meta: {}, grp, source_table: "t", source_id: id, score: 0, updated_at: "2026-11-21",
});

const ROWS: IndexRow[] = [
  row("r1", "documents", "documents/contrats/contrat-cadre-acme-2026", "Contrat cadre Acme 2026",
    "Article 3 : livraison.\nArticle 4 : le délai de paiement des factures Acme est de 45 jours\nfin de mois, par virement.\nArticle 5 : résiliation.", "doc:1"),
  row("r1b", "documents", "documents/contrats/contrat-cadre-acme-2026", "Contrat cadre Acme 2026",
    "Article 6 : pénalités de retard de 3 %.", "doc:1"),
  row("r2", "facts", "facts/customer/acme-sas", "Acme SAS", "Acme SAS règle ses factures par virement."),
  row("r3", "memory", "memory/preference", "Mémoire · preference", "Léa Martin préfère être tutoyée."),
  row("r4", "conversation", "conversation/relance-abc12345/user", "Relance", "Peux-tu relancer la FACTURATION de Globex ?"),
];

/** Un index en mémoire qui suit les règles de search_grep (texte plié, score, any/all). */
function memoryIndex(rows = ROWS): SearchIndex & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const toJs = (r: string) => new RegExp(r.replace(/\\m/g, "(?<![\\p{L}\\p{N}])"), "u");
  return {
    calls,
    grep: async (p) => {
      calls.push(p);
      const res = rows
        .filter((r) => p.types.includes(r.type))
        .filter((r) => !p.path || r.path.startsWith(p.path.replace(/%$/, "").replace(/%.*/, "")))
        .map((r) => {
          const doc = fold(`${r.title ?? ""}\n${r.content}`);
          const hits = p.regexes.filter((x) => toJs(x).test(doc)).length;
          return { r, hits };
        })
        .filter(({ hits }) => (p.all ? hits === p.regexes.length : hits > 0))
        .sort((a, b) => b.hits - a.hits)
        .map(({ r, hits }) => ({ ...r, score: hits }));
      return res.slice(p.offset, p.offset + p.limit);
    },
    read: async (ids, whole) => {
      const picked = rows.filter((r) => ids.includes(r.id));
      const groups = new Set(picked.map((r) => r.grp));
      return whole ? rows.filter((r) => groups.has(r.grp)) : picked;
    },
  };
}

const noLegacy: LegacyToolset = { defs: [], run: async () => "" };
const ALL = ["documents", "memory", "team", "facts", "past_work", "artifacts", "conversation"];

describe("pliage et motifs", () => {
  it("minuscules et sans accents, comme public.search_fold", () => {
    assert.equal(fold("Délai de PAIEMENT, Œuvre à Noël"), "delai de paiement, oeuvre a noel".replace("oe", "o"));
  });
  it("le pliage d'une regex garde les échappements", () => {
    assert.equal(foldPattern("Facture n°\\D\\S+É"), "facture n°\\D\\S+e");
  });
  it("des mots : chacun cherché en début de mot ; all exige tous les mots", () => {
    const p = buildPatterns("Factur, Acme", "any");
    assert.ok(typeof p !== "string");
    assert.deepEqual(p.regexes, ["\\mfactur", "\\macme"]);
    assert.equal(p.all, false);
    assert.ok(p.js[0].test("les facturations"));
    assert.ok(!p.js[0].test("préfacturé".normalize()));
    assert.equal((buildPatterns("ab cd", "all") as { all: boolean }).all, true);
  });
  it("une phrase tolère les espaces multiples ; une regex invalide est refusée", () => {
    const p = buildPatterns("délai  de paiement", "phrase");
    assert.ok(typeof p !== "string" && p.js[0].test("le delai de   paiement"));
    assert.match(String(buildPatterns("(abc", "regex")), /invalide/);
  });
  it("un chemin à la manière d'un glob", () => {
    assert.equal(globToLike("documents/contrats/*"), "documents/contrats/%");
    assert.equal(globToLike("facts"), "facts%");
    assert.equal(globToLike(""), null);
  });
  it("les lignes trouvées et leurs voisines, au format ripgrep", () => {
    const p = buildPatterns("factures", "any") as { js: RegExp[] };
    const { text, matches } = matchingLines(ROWS[0].content, p.js, 1, 6);
    assert.equal(matches, 1);
    assert.equal(text, "1- Article 3 : livraison.\n2: Article 4 : le délai de paiement des factures Acme est de 45 jours\n3- fin de mois, par virement.");
  });
});

describe("ce que grep a le droit de lire", () => {
  const rag = (collection_ids?: string[], enabled = true) => ({
    id: "r", kind: "rag_search", name: "rag", description: null, enabled, requires_approval: false,
    config: collection_ids ? { collection_ids } : {},
  });

  it("les documents suivent search_knowledge : collections désignées, tout le projet, ou rien", () => {
    assert.deepEqual(documentCollections([rag(["c1", "c2"]), rag(["c2", "c3"])]), ["c1", "c2", "c3"]);
    assert.equal(documentCollections([rag()]), null);
    assert.deepEqual(documentCollections([]), []);
    assert.deepEqual(documentCollections([rag(["c1"], false)]), []);
  });

  it("mode pools : seules les collections des pools, jamais tout le projet", () => {
    const scope = emptyScope("agent", ["pool-1"], ["Support"]);
    scope.knowledge.add("c-support");
    // Une ligne « tout le projet », une autre sur une collection hors pools.
    const rows = applyPoolToToolRows([rag(), rag(["c-rh"])], scope);
    assert.deepEqual(documentCollections(rows as never), ["c-support"]);
    // Des pools sans collection : aucun document.
    assert.deepEqual(documentCollections(applyPoolToToolRows([rag()], emptyScope("agent", ["pool-2"], ["Vide"])) as never), []);
  });

  it("un type n'est proposé que si l'agent a l'outil qui le lit", () => {
    assert.deepEqual(grepTypesFor(["search_memory", "knowledge_search", "search_history"]), ["memory", "facts", "conversation"]);
    assert.ok(!grepTypesFor(["search_memory"]).includes("documents"));
  });
});

describe("grep puis build_context", () => {
  it("rend les lignes trouvées, rangées par type, chaque source avec son identifiant et son chemin", async () => {
    const index = memoryIndex();
    const state = newContextState();
    const out = await grep(index, state, { pattern: "factur acme" }, ALL);
    // La source qui contient les deux mots d'abord.
    assert.match(out, /^<grep pattern="factur acme" mode="any"/);
    assert.match(out, /<documents hit="g1" path="documents\/contrats\/contrat-cadre-acme-2026" title="Contrat cadre Acme 2026">\n[\s\S]*2: Article 4 : le délai de paiement des factures Acme/);
    assert.match(out, /<facts hit="g\d" path="facts\/customer\/acme-sas"/);
    assert.match(out, /<conversation hit="g\d"[\s\S]*FACTURATION de Globex/);
    // Le second passage du contrat est trouvé par son titre (« Acme ») : son début est montré.
    assert.match(out, /<documents hit="g3"[^>]*>\n1- Article 6/);
    assert.match(out, /build_context\(from=\["g1", "g2", "g3", "g4"\]\)/);
    assert.deepEqual(index.calls[0].regexes, ["\\mfactur", "\\macme"]);
  });

  it("types, chemin, sorties sources et count", async () => {
    const index = memoryIndex();
    const state = newContextState();
    const only = await grep(index, state, { pattern: "acme", types: ["facts"] }, ALL);
    assert.doesNotMatch(only, /<documents/);
    await grep(index, state, { pattern: "acme", path: "documents/contrats/*" }, ALL);
    assert.equal(index.calls.at(-1)!.path, "documents/contrats/%");
    assert.match(await grep(index, state, { pattern: "acme", output: "sources" }, ALL), /<documents hit="g\d" path="[^"]+" title="[^"]+" lines="1"\/>/);
    assert.match(await grep(index, state, { pattern: "acme", output: "count" }, ALL), /documents: 2\nfacts: 1\n-- chemins les plus touchés\ndocuments\/contrats\/contrat-cadre-acme-2026: 2/);
  });

  it("rien trouvé : des pistes ; un type non permis est refusé", async () => {
    const state = newContextState();
    assert.match(await grep(memoryIndex(), state, { pattern: "kubernetes" }, ALL), /sources="0">rien trouvé[\s\S]*synonymes/);
    assert.match(await grep(memoryIndex(), state, { pattern: "acme", types: ["memory"] }, ["documents"]), /non permis/);
  });

  it("build_context(from) relit les sources trouvées, balisées par type avec leur chemin ; whole relit le document entier", async () => {
    const index = memoryIndex();
    const state = newContextState();
    await grep(index, state, { pattern: "paiement" }, ALL);
    const one = await buildContext(noLegacy, state, { from: ["g1"] }, undefined, index);
    assert.match(one, /<documents id="c1" source="documents\/contrats\/contrat-cadre-acme-2026">\nArticle 3/);
    assert.doesNotMatch(one, /pénalités/);
    const whole = await buildContext(noLegacy, state, { from: ["g1"], whole: true }, undefined, index);
    assert.match(whole, /pénalités de retard/);
    // Ce qui est lu se garde comme le reste du contexte.
    assert.match(contextPage(state, { keep: ["c1"] }), /gardés : c1/);
    assert.match(await buildContext(noLegacy, state, { from: ["g9"] }, undefined, index), /aucune source connue/);
  });
});
