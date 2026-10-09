// La configuration ResolveAI d'un agent public (rag_agents.support_config).
//
// Copie VOLONTAIRE du catalogue par défaut du runtime
// (supabase/functions/_shared/resolveai.ts) : le navigateur ne peut pas
// importer un module Deno. Le runtime reste la référence — une config vide ou
// partielle y est complétée par SES valeurs par défaut, pas par celles-ci. Cet
// écran ne sert qu'à montrer ce qui s'applique et à le personnaliser.

export interface IntentDef {
  key: string;
  label: string;
  what: string;
  not_for?: string;
  examples?: string[];
  auto_reply: boolean;
  route?: string;
  playbook?: string;
}

export interface SupportConfig {
  intents: IntentDef[];
  sla_hours: { urgent: number; high: number; normal: number; low: number };
  handoff_message: string;
}

export const DEFAULT_SUPPORT_CONFIG: SupportConfig = {
  intents: [
    {
      key: "information", label: "Question produit", auto_reply: true, route: "Support",
      what: "Une question sur le fonctionnement, les fonctionnalités, les prix publics, les horaires ou les conditions, la réponse est dans la documentation.",
      not_for: "Un problème rencontré sur son compte ou sa commande (c'est un bug ou une commande).",
      examples: ["est-ce que vous livrez en Belgique ?", "comment exporter mes données en CSV ?", "quels sont vos tarifs ?"],
    },
    {
      key: "commande", label: "Commande & livraison", auto_reply: true, route: "Logistique",
      what: "Le suivi d'une commande précise : où en est-elle, retard, colis non reçu, erreur d'article, retour à organiser.",
      not_for: "Une demande de remboursement d'argent (c'est un remboursement).",
      examples: ["ma commande 4521 n'est toujours pas arrivée", "j'ai reçu la mauvaise taille, comment faire un retour ?"],
    },
    {
      key: "remboursement", label: "Remboursement", auto_reply: false, route: "Facturation",
      what: "Le client veut récupérer de l'argent : remboursement, avoir, geste commercial, contestation d'un prélèvement.",
      not_for: "Une simple question sur la politique de remboursement, sans demande pour lui-même (c'est une question produit).",
      examples: ["je veux être remboursé", "vous m'avez prélevé deux fois", "je conteste ce paiement"],
    },
    {
      key: "facturation", label: "Facturation", auto_reply: true, route: "Facturation",
      what: "Factures, moyens de paiement, changement d'offre, TVA, adresse de facturation, sans demande de remboursement.",
      not_for: "Récupérer de l'argent (c'est un remboursement). Arrêter l'abonnement (c'est une résiliation).",
      examples: ["où trouver ma facture de mars ?", "je veux changer de carte bancaire", "passer à l'offre annuelle"],
    },
    {
      key: "bug", label: "Bug / incident", auto_reply: false, route: "Technique",
      what: "Quelque chose ne marche pas comme prévu : erreur, page blanche, fonctionnalité cassée, données disparues, lenteur anormale.",
      not_for: "Ne pas savoir comment faire quelque chose qui fonctionne (c'est une question produit). Un problème de connexion à son compte (c'est un accès).",
      examples: ["le bouton payer ne fait rien", "erreur 500 quand j'importe mon fichier", "mes projets ont disparu"],
    },
    {
      key: "acces", label: "Compte & accès", auto_reply: true, route: "Support",
      what: "Connexion impossible, mot de passe, double authentification, e-mail du compte, invitation d'un collègue.",
      not_for: "Supprimer son compte ou arrêter l'abonnement (c'est une résiliation).",
      examples: ["je n'arrive plus à me connecter", "je ne reçois pas le code de vérification"],
    },
    {
      key: "resiliation", label: "Résiliation", auto_reply: false, route: "Rétention",
      what: "Le client veut arrêter : résilier, se désabonner, supprimer son compte, ne pas renouveler.",
      not_for: "Une question sur les conditions de résiliation sans intention de partir (c'est une question produit).",
      examples: ["je veux résilier mon abonnement", "supprimez mon compte", "comment annuler le renouvellement ?"],
    },
    {
      key: "avant_vente", label: "Avant-vente", auto_reply: true, route: "Commercial",
      what: "Un prospect qui envisage d'acheter : devis, démo, offre entreprise, volume, partenariat.",
      not_for: "Un client existant qui change d'offre (c'est de la facturation).",
      examples: ["je voudrais une démo pour mon équipe de 40 personnes", "vous faites des tarifs pour les associations ?"],
    },
    {
      key: "reclamation", label: "Réclamation", auto_reply: false, route: "Support",
      what: "Un mécontentement exprimé sur le service reçu : plainte, insatisfaction, menace d'avis négatif ou de recours.",
      not_for: "Un problème technique décrit calmement (c'est un bug).",
      examples: ["c'est inadmissible, trois semaines sans réponse", "je vais laisser un avis sur Trustpilot"],
    },
  ],
  sla_hours: { urgent: 1, high: 4, normal: 24, low: 72 },
  handoff_message:
    "Je transmets votre demande à l'équipe, qui reviendra vers vous. Si vous le souhaitez, laissez-moi votre adresse e-mail pour être recontacté.",
};

/** Même règle que le runtime : ce qui manque ou est abîmé prend la valeur par défaut. */
export function normalizeSupportConfig(raw: unknown): SupportConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<SupportConfig>;
  const intents = Array.isArray(r.intents)
    ? r.intents.filter((i): i is IntentDef => !!i && typeof i.key === "string" && !!i.key && typeof i.label === "string")
    : [];
  const sla = (r.sla_hours ?? {}) as Partial<SupportConfig["sla_hours"]>;
  const hours = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const d = DEFAULT_SUPPORT_CONFIG;
  return {
    intents: intents.length ? intents : d.intents,
    sla_hours: {
      urgent: hours(sla.urgent, d.sla_hours.urgent),
      high: hours(sla.high, d.sla_hours.high),
      normal: hours(sla.normal, d.sla_hours.normal),
      low: hours(sla.low, d.sla_hours.low),
    },
    handoff_message: typeof r.handoff_message === "string" && r.handoff_message.trim() ? r.handoff_message : d.handoff_message,
  };
}

/** Une clé d'intention sûre à partir d'un libellé. */
export const intentKey = (label: string): string =>
  label.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "intention";

export const PRIORITY_META: Record<string, { label: string; rank: number }> = {
  urgent: { label: "Urgente", rank: 3 },
  high: { label: "Haute", rank: 2 },
  normal: { label: "Normale", rank: 1 },
  low: { label: "Basse", rank: 0 },
};

export const STATUS_META: Record<string, { label: string }> = {
  open: { label: "À traiter" },
  in_progress: { label: "En cours" },
  auto: { label: "Traitée par le collaborateur" },
  closed: { label: "Close" },
};
