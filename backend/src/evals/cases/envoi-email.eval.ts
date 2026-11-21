// Un envoi demandé est fait par l'outil, et la réponse le confirme avec ce que
// l'outil a rendu. Le vrai envoi est remplacé par un faux outil.

import { callTool, defineEval, say } from "../harness.ts";

export default defineEval({
  description: "un e-mail demandé part par send_email, et la réponse le confirme",
  tags: ["email", "smoke"],
  stubs: [{ tool: "send_email", outcome: { response: { ok: true, id: "msg_42" } } }],
  model: (req) => req.toolResults.some((r) => r.name === "send_email")
    ? say("C'est fait : l'e-mail de confirmation est parti à alice@acme.fr (référence msg_42).")
    : callTool("send_email", {
      to: "alice@acme.fr",
      subject: "Rendez-vous de jeudi",
      body: "Bonjour Alice, je vous confirme notre rendez-vous de jeudi à 10 h.",
    }),
  async test(t) {
    await t.send("Envoie un e-mail à alice@acme.fr pour confirmer notre rendez-vous de jeudi à 10 h.");
    t.statusIs("succeeded");
    t.calledTool("send_email", { to: "alice@acme.fr" });
    t.replyMatches(/alice@acme\.fr/i);
    t.noFailedCalls({ severity: "soft" });
  },
});
