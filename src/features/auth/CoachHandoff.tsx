// Le relais entre le parcours d'arrivée et l'application.
//
// Le parcours (`/onboarding`) pose le décor : un espace, un projet, le contexte
// d'entreprise, un objectif, un premier agent. Il ne va pas plus loin
// volontairement — la première vraie tâche s'apprend DANS l'outil, pas dans un
// tunnel qui la mime.
//
// Ce composant est ce passage de témoin. Au premier chargement de l'application
// après le parcours, il ouvre l'assistant sur une conversation neuve avec une
// question qui part du contexte que la personne vient d'écrire. Rien n'est
// envoyé à sa place : le message est pré-rempli dans le composeur, elle le
// modifie ou l'envoie.
//
// Il ne se déclenche qu'une fois. Le drapeau est consommé à la lecture, avant
// même l'ouverture du panneau : un double montage (StrictMode) ou un retour en
// arrière ne doit pas relancer l'accueil.

import { useEffect } from "react";
import { useAssistant } from "@/lib/assistant-context";
import { COACH_PENDING_KEY } from "./Onboarding";

/** Consomme le drapeau et dit s'il était posé. Une seule fois, toujours. */
function takePendingFlag(): boolean {
  try {
    if (localStorage.getItem(COACH_PENDING_KEY) !== "1") return false;
    localStorage.removeItem(COACH_PENDING_KEY);
    return true;
  } catch {
    // Stockage refusé (navigation privée, site data bloqué) : pas d'accueil
    // automatique. L'assistant reste accessible par son bouton, comme toujours.
    return false;
  }
}

const OPENING_PROMPT = [
  "Je viens de créer mon espace. Aide-moi à démarrer :",
  "",
  "1. Relis le contexte de mon entreprise et dis-moi ce qui manque pour que mes agents travaillent bien.",
  "2. Propose-moi une première tâche concrète à confier à mon agent, qui serve mon objectif.",
  "3. Explique-moi ce qui se passera quand il voudra écrire quelque part.",
].join("\n");

export function CoachHandoff() {
  const { ask, available } = useAssistant();

  useEffect(() => {
    if (!available) return;
    if (!takePendingFlag()) return;
    // Un temps de respiration : la coque finit de se peindre, puis le panneau
    // s'ouvre. Ouvrir dans le même tick donne l'impression d'une modale qui
    // saute à la figure avant qu'on ait vu où on est arrivé.
    const t = setTimeout(() => {
      ask({ prompt: OPENING_PROMPT, newChat: true, autoSend: false, agent: null });
    }, 900);
    return () => clearTimeout(t);
  }, [available, ask]);

  return null;
}
