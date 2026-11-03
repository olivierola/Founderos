// Graphe de connaissances (0289) : un nom = une clé, quel que soit l'écrit, et
// rien qui ressemble à un secret n'entre.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entityKey, looksSecret, relationName } from "../edge/_shared/knowledge-graph.ts";

describe("nommage", () => {
  it("plie les écritures d'un même nom sur une seule clé", () => {
    assert.equal(entityKey("Acme SAS"), "acme sas");
    assert.equal(entityKey("  ACME   s.a.s "), "acme s a s");
    assert.equal(entityKey("Hélène Désiré"), "helene desire");
    assert.equal(entityKey("API de facturation (v2)"), "api de facturation v2");
  });

  it("normalise les relations en snake_case", () => {
    assert.equal(relationName("Travaille pour"), "travaille_pour");
    assert.equal(relationName("dépend-de"), "depend_de");
    assert.equal(relationName("!"), null);
  });
});

describe("secrets", () => {
  it("écarte les identifiants et numéros sensibles", () => {
    for (const t of [
      "La clé Stripe est sk_live_51HxQ2aB3cD4eF5gH6iJ7",
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123",
      "mot de passe = Hunter2!!",
      "Carte 4111 1111 1111 1111",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
    ]) assert.ok(looksSecret(t), t);
  });

  it("laisse passer les faits ordinaires", () => {
    for (const t of [
      "Acme SAS est client depuis mars 2025, contrat annuel de 48 k€.",
      "Marie Dupont est responsable du pipeline de facturation.",
      "Le déploiement de production passe par Argo CD.",
    ]) assert.equal(looksSecret(t), false, t);
  });
});
