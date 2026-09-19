// Traduction des tags posés par la télémétrie (public-agent-telemetry.ts) en
// libellés lisibles. Chaque motif dit d'où vient le signal : c'est ce qui
// permet de défendre le chiffre devant un client plutôt que d'afficher une
// catégorie devinée par un modèle.

export const REASON_LABELS: Record<string, string> = {
  answer_quality: "Qualité de la réponse",
  quick_resolution: "Réponse immédiate",
  user_effort: "Effort du visiteur",
  no_knowledge: "Rien dans la base",
  tool_failure: "Échec d'un outil",
  human_requested: "Humain demandé",
  error: "Panne technique",
  unspecified: "Non renseigné",
};

export const REASON_HINTS: Record<string, string> = {
  answer_quality: "L'agent a répondu en s'appuyant sur au moins une source de sa base.",
  quick_resolution: "Réponse sourcée en moins de 4 s, dans les deux premiers échanges.",
  user_effort: "Le visiteur a dû poser quatre questions ou plus sur le même fil.",
  no_knowledge: "Aucune source du corpus ni aucun outil n'a pu alimenter la réponse.",
  tool_failure: "Un appel d'outil a échoué pendant l'échange.",
  human_requested: "Le visiteur a explicitement demandé à parler à quelqu'un.",
  error: "La réponse n'a jamais été rendue (erreur en amont).",
  unspecified: "Conversation antérieure à la mise en place du compteur.",
};

export function reasonLabel(key: string): string {
  return REASON_LABELS[key] ?? key;
}

export const OUTCOME_LABELS: Record<string, string> = {
  resolved: "Résolue",
  unresolved: "Non résolue",
  escalated: "Escaladée",
  abandoned: "Sans réponse",
  unknown: "Non mesurée",
};

export const CHANNEL_LABELS: Record<string, string> = {
  widget: "Widget",
  playground: "Playground",
  api: "API",
};

export const DEVICE_LABELS: Record<string, string> = {
  desktop: "Ordinateur",
  mobile: "Mobile",
  tablet: "Tablette",
  unknown: "Inconnu",
};

export const RATING_LABELS: Record<number, string> = {
  5: "Très satisfait",
  4: "Satisfait",
  3: "Neutre",
  2: "Insatisfait",
  1: "Très insatisfait",
};

/**
 * Ordre FIXE des motifs. La couleur suit le motif, jamais son rang : si
 * « Effort du visiteur » passe de la 1re à la 3e place entre deux périodes, il
 * garde sa teinte, sinon deux captures d'écran du même écran ne se comparent
 * plus. C'est aussi ce qui permet aux cartes « motifs positifs » et « motifs
 * négatifs » de parler des mêmes couleurs.
 */
export const REASON_ORDER = [
  "answer_quality",
  "quick_resolution",
  "user_effort",
  "no_knowledge",
  "tool_failure",
  "human_requested",
  "error",
  "unspecified",
] as const;

export function reasonSlot(reason: string): number {
  const i = REASON_ORDER.indexOf(reason as (typeof REASON_ORDER)[number]);
  return i === -1 ? REASON_ORDER.length - 1 : i;
}
