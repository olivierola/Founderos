// bridge.js — le seul script présent en permanence dans vos pages.
//
// Il ne lit rien, n'observe rien, n'envoie rien de la page : il écoute
// uniquement les messages `window.postMessage` portant notre marqueur, et sert
// deux besoins :
//
//   1. FounderOS peut savoir que l'extension est installée (l'écran d'attente
//      cesse alors de proposer d'installer le paquet Playwright) ;
//   2. presser « Démarrer » dans l'app réveille immédiatement le service
//      worker — sans quoi il faudrait attendre le prochain battement d'alarme,
//      soit jusqu'à 30 s après un clic.
//
// Il est déclaré sur toutes les URL parce que l'app peut tourner sur n'importe
// quel domaine (localhost en dev, votre domaine en production) : une liste
// d'origines codée en dur serait fausse pour quelqu'un. Le pire qu'une page
// tierce puisse en tirer, c'est déclencher une réclamation — laquelle reste
// bornée par l'identité de l'appareil et son workspace.

(() => {
  const rt = (globalThis.browser ?? globalThis.chrome).runtime;

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data.__founderos_recorder !== true) return;

    if (data.action === "ping") {
      rt.sendMessage({ type: "rec:app_here" })
        .then((res) => {
          window.postMessage({
            __founderos_recorder_reply: true,
            action: "pong",
            version: res?.version ?? null,
            recording: !!res?.recording,
          }, "*");
        })
        .catch(() => { /* service worker indisponible : l'app conclura à l'absence */ });
      return;
    }

    if (data.action === "nudge") {
      rt.sendMessage({ type: "rec:nudge" }).catch(() => {});
    }
  });

  // L'app peut être chargée avant l'extension (ou l'inverse) : on se signale
  // spontanément pour que le ping ne soit pas la seule chance de se rencontrer.
  window.postMessage({ __founderos_recorder_reply: true, action: "hello" }, "*");

  // Reconnaissance PASSIVE d'un onglet FounderOS, par le marqueur statique posé
  // dans index.html. Attendre que la page se déclare ne suffisait pas : seule la
  // page d'enregistrement le faisait, si bien qu'un agent lancé depuis le chat
  // détournait l'onglet où l'utilisateur lui parlait. Le marqueur est présent
  // sur TOUTES les pages de l'app, quelle que soit la route.
  if (document.querySelector('meta[name="founderos-app"]')) {
    rt.sendMessage({ type: "rec:app_here" }).catch(() => {});
  }
})();
