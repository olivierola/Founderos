// Un envoi qui échoue n'est jamais annoncé comme fait. Le faux outil rend une
// panne au premier appel, puis un succès : l'agent qui réessaie une fois doit
// annoncer l'envoi ; celui qui abandonne doit dire qu'il a échoué.

import { callTool, defineEval, say } from "../harness.ts";

export default defineEval({
  description: "une panne d'envoi puis un succès : la réponse dit ce qui s'est réellement passé",
  tags: ["email", "pannes"],
  stubs: [{
    tool: "send_email",
    outcomes: [
      { throw: { message: "Resend : 503 Service Unavailable" } },
      { response: { ok: true, id: "msg_77" } },
    ],
  }],
  model: (req) => {
    const sends = req.toolResults.filter((r) => r.name === "send_email");
    if (sends.length === 0 || (sends.length === 1 && sends[0].content.startsWith("ERROR"))) {
      return callTool("send_email", { to: "compta@acme.fr", subject: "Facture 2026-114", body: "Bonjour, voici la facture." });
    }
    return say("La première tentative a échoué (503), la seconde est passée : la facture est partie à compta@acme.fr (msg_77).");
  },
  async test(t) {
    await t.send("Envoie la facture 2026-114 à compta@acme.fr.");
    t.statusIs("succeeded");
    t.check("deux tentatives d'envoi", t.calls.filter((c) => c.name === "send_email").length === 2,
      { detail: `${t.calls.filter((c) => c.name === "send_email").length} tentative(s)` });
    t.check("la première a échoué, la seconde a réussi",
      t.calls.filter((c) => c.name === "send_email").map((c) => c.ok).join(",") === "false,true");
    t.replyMatches(/msg_77/);
  },
});
