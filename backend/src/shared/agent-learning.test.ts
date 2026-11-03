// Auto-apprentissage (0288) : quelles remarques méritent un juge, et des
// corrections de fichier qui s'annulent exactement.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyLearningPatch, applyPreferenceLesson, feedbackCue, LESSONS_HEADING,
} from "../edge/_shared/agent-learning.ts";

/** What agent_learning_decide('revert') does when the file has moved on. */
const revert = (file: string, p: { find: string; replace: string }) => file.replace(p.replace, p.find);

describe("quelles remarques passent au juge", () => {
  it("repère les corrections", () => {
    for (const t of [
      "Non, c'est pas le bon fichier",
      "tu as oublié de joindre le devis",
      "La prochaine fois passe par le CRM plutôt que le tableur",
      "Je t'avais dit de ne jamais poster dans #general",
      "you forgot the attachment again",
      "ça ne marche pas, le lien est cassé",
    ]) assert.ok(feedbackCue(t) > 0, t);
  });

  it("laisse passer les demandes et les remerciements", () => {
    for (const t of ["merci !", "ok", "Parfait 👍", "Prépare un résumé des ventes de mars", "Peux-tu analyser ce PDF ?"]) {
      assert.equal(feedbackCue(t), 0, t);
    }
  });
});

describe("instructions", () => {
  const base = "# Rôle\nTu traites les devis.\n\n## Règles\n- Toujours en euros.";

  it("ajoute une section Leçons apprises, puis y empile", () => {
    const a = applyLearningPatch("instructions", base, { op: "append", text: "Joindre le PDF du devis avant envoi." });
    assert.ok(a.ok);
    assert.ok(a.file.endsWith(`${LESSONS_HEADING}\n- Joindre le PDF du devis avant envoi.`));
    const b = applyLearningPatch("instructions", a.file, { op: "append", text: "Vérifier le montant TTC." });
    assert.ok(b.ok);
    assert.equal(b.file.split(LESSONS_HEADING).length, 2, "une seule section");
    assert.ok(b.file.endsWith("- Joindre le PDF du devis avant envoi.\n- Vérifier le montant TTC."));
    // Annuler la deuxième leçon rend exactement le fichier d'avant.
    assert.equal(revert(b.file, b), a.file);
  });

  it("insère dans la section existante même si elle n'est pas en dernier", () => {
    const file = `${base}\n\n${LESSONS_HEADING}\n- Une leçon.\n\n## Annexe\nTexte.`;
    const r = applyLearningPatch("instructions", file, { op: "append", text: "Deuxième leçon." });
    assert.ok(r.ok);
    assert.ok(r.file.includes("- Une leçon.\n- Deuxième leçon.\n\n## Annexe"));
  });

  it("remplace la phrase fautive, et l'annulation la rend", () => {
    const r = applyLearningPatch("instructions", base, { op: "replace", find: "- Toujours en euros.", text: "- Toujours en euros TTC, HT entre parenthèses." });
    assert.ok(r.ok);
    assert.ok(r.file.includes("TTC, HT entre parenthèses"));
    assert.equal(revert(r.file, r), base);
  });

  it("refuse un extrait introuvable, ambigu ou une leçon déjà présente", () => {
    assert.equal(applyLearningPatch("instructions", base, { op: "replace", find: "phrase qui n'existe pas", text: "x".repeat(20) }).ok, false);
    assert.equal(applyLearningPatch("instructions", "aaaa aaaa bbbb\naaaa aaaa bbbb", { op: "replace", find: "aaaa aaaa bbbb", text: "cccc" }).ok, false);
    assert.equal(applyLearningPatch("instructions", base, { op: "append", text: "toujours en euros" }).ok, false);
  });

  it("refuse un remplacement qui efface une procédure", () => {
    const long = "Étape détaillée de la procédure. ".repeat(20);
    assert.equal(applyLearningPatch("instructions", long + "\nFin.", { op: "replace", find: long, text: "Court." }).ok, false);
  });
});

describe("âme et préférences", () => {
  it("l'âme reste sous sa limite", () => {
    const r = applyLearningPatch("soul", "x".repeat(2390), { op: "append", text: "Tu vérifies avant d'affirmer." });
    assert.equal(r.ok, false);
  });

  it("une préférence s'ajoute sans réécrire le fichier humain", () => {
    const file = "réponses courtes\n- [langue] Répondre en français.";
    const r = applyPreferenceLesson(file, { text: "Envoyer les alertes sur Slack, pas par mail.", topic: "canal" });
    assert.ok(r.ok);
    assert.ok(r.file.startsWith("réponses courtes\n"), "la ligne libre n'est pas reformatée");
    assert.equal(revert(r.file, r), file);
    assert.equal(applyPreferenceLesson(file, { text: "Répondre en français.", topic: "langue" }).ok, false);
  });
});
