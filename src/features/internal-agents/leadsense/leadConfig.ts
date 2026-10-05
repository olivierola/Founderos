// La grille LeadSense d'un projet (table leadsense_config).
//
// Copie VOLONTAIRE des types et des valeurs par défaut du runtime
// (supabase/functions/_shared/leadsense.ts) : le navigateur ne peut pas
// importer un module Deno. Le runtime reste la référence — une config vide ou
// partielle y est complétée par SES défauts.

export interface Criterion {
  key: string;
  label: string;
  /** Ce que le critère mesure — l'énoncé de la question. */
  what: string;
  /** Quatre situations, de 0 à 3. */
  levels: [string, string, string, string];
  weight: number;
}

export interface LeadType {
  key: string;
  label: string;
  what: string;
  not_for?: string;
  examples?: string[];
  /** Ce type mérite-t-il un score commercial ? (non pour spam, candidature…) */
  qualify: boolean;
}

export interface Rep {
  id: string;
  name: string;
  email?: string;
  /** Ce que ce commercial couvre : segment, taille, secteur, région, langue. */
  covers: string;
}

export interface LeadConfig {
  ideal_customer: string;
  criteria: Criterion[];
  lead_types: LeadType[];
  hot_rule: string;
  reps: Rep[];
  tiers: { a: number; b: number; c: number };
}

export const DEFAULT_LEAD_CONFIG: LeadConfig = {
  ideal_customer: "",
  criteria: [
    {
      key: "besoin", label: "Besoin", weight: 25,
      what: "Le prospect exprime-t-il un problème que notre offre résout ?",
      levels: [
        "Aucun besoin exprimé : message vide, question hors sujet, simple bonjour.",
        "Curiosité : il se renseigne, sans problème précis à régler.",
        "Problème identifié : il décrit une difficulté que notre offre adresse.",
        "Besoin précis : cas d'usage détaillé, volumes, outils actuels ou contrainte chiffrée.",
      ],
    },
    {
      key: "budget", label: "Budget", weight: 20,
      what: "Y a-t-il des signes que le prospect peut et veut payer ?",
      levels: [
        "Signaux contraires : cherche du gratuit, étudiant, projet personnel sans moyens.",
        "Aucun indice sur le budget.",
        "Budget plausible : taille d'équipe ou d'entreprise compatible, outil payant déjà en place.",
        "Budget affirmé : demande de devis chiffré, enveloppe citée, achat déjà décidé.",
      ],
    },
    {
      key: "decideur", label: "Décideur", weight: 20,
      what: "La personne a-t-elle le pouvoir de décider de l'achat ?",
      levels: [
        "Aucun pouvoir : particulier, étudiant, stagiaire.",
        "Utilisateur : il utiliserait l'outil mais ne décide pas.",
        "Prescripteur : manager ou chef de projet qui recommande.",
        "Décideur : fondateur, dirigeant, directeur, responsable des achats.",
      ],
    },
    {
      key: "echeance", label: "Échéance", weight: 15,
      what: "Quand le prospect compte-t-il agir ?",
      levels: [
        "Aucune échéance, ou « un jour peut-être ».",
        "Lointaine : dans plus de six mois, prochain exercice.",
        "Ce trimestre : projet planifié, appel d'offres en cours.",
        "Immédiate : besoin sous un mois, date butoir, remplacement urgent d'un outil.",
      ],
    },
    {
      key: "adequation", label: "Adéquation", weight: 20,
      what: "Le prospect ressemble-t-il à notre client idéal ?",
      levels: [
        "Hors cible : secteur, taille ou pays que nous ne servons pas.",
        "Marginal : servable, mais loin de nos clients habituels.",
        "Proche : ressemble à nos clients sur l'essentiel.",
        "Cœur de cible : exactement le profil de nos meilleurs clients.",
      ],
    },
  ],
  lead_types: [
    {
      key: "demo", label: "Demande de démo", qualify: true,
      what: "Le prospect veut voir le produit : démonstration, essai accompagné, rendez-vous de présentation.",
      examples: ["je voudrais une démo pour mon équipe", "pouvez-vous me montrer comment ça marche ?"],
    },
    {
      key: "devis", label: "Demande de devis", qualify: true,
      what: "Le prospect veut un prix pour son cas : devis, tarif sur mesure, offre entreprise, volume.",
      not_for: "Une question sur les tarifs publics sans projet d'achat (c'est une question).",
      examples: ["combien pour 50 utilisateurs ?", "pouvez-vous m'envoyer une proposition commerciale ?"],
    },
    {
      key: "question", label: "Question avant-vente", qualify: true,
      what: "Une question sur l'offre avant d'acheter : fonctionnalité, intégration, sécurité, conditions.",
      examples: ["est-ce que vous vous intégrez à Salesforce ?", "êtes-vous conformes RGPD ?"],
    },
    {
      key: "partenariat", label: "Partenariat", qualify: true,
      what: "Une proposition de partenariat, de revente, d'intégration ou d'affiliation.",
      examples: ["nous sommes intégrateurs et aimerions revendre votre solution"],
    },
    {
      key: "client_existant", label: "Client existant (support)", qualify: false,
      what: "Un client actuel qui a un problème ou une question sur son compte, ce n'est pas un prospect.",
      examples: ["ma facture est fausse", "je n'arrive plus à me connecter"],
    },
    {
      key: "candidature", label: "Candidature", qualify: false,
      what: "Une candidature spontanée, une demande de stage ou d'emploi.",
      examples: ["je souhaite rejoindre votre équipe", "vous recrutez des alternants ?"],
    },
    {
      key: "fournisseur", label: "Prospection entrante", qualify: false,
      what: "Quelqu'un qui veut NOUS vendre quelque chose : agence, prestataire, outil, levée de fonds.",
      examples: ["nous aidons les SaaS à générer des leads", "offre de référencement SEO"],
    },
    {
      key: "spam", label: "Spam", qualify: false,
      what: "Message automatique, sans rapport, promotionnel ou frauduleux.",
      examples: ["gagnez 10 000 € par mois", "lien suspect sans texte"],
    },
  ],
  hot_rule:
    "Le prospect demande une action commerciale immédiate (démo, devis, rappel, rendez-vous) ET donne des signes sérieux : entreprise identifiée, besoin précis, ou échéance proche.",
  reps: [],
  tiers: { a: 75, b: 50, c: 25 },
};

export function normalizeLeadConfig(raw: unknown): LeadConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<LeadConfig>;
  const d = DEFAULT_LEAD_CONFIG;
  const criteria = Array.isArray(r.criteria)
    ? r.criteria.filter((c): c is Criterion =>
        !!c && typeof c.key === "string" && !!c.key && Array.isArray(c.levels) && c.levels.length === 4)
    : [];
  const types = Array.isArray(r.lead_types)
    ? r.lead_types.filter((t): t is LeadType => !!t && typeof t.key === "string" && !!t.key && typeof t.label === "string")
    : [];
  const reps = Array.isArray(r.reps)
    ? r.reps.filter((x): x is Rep => !!x && typeof x.id === "string" && typeof x.name === "string" && !!x.name.trim())
    : [];
  const tiers = (r.tiers ?? {}) as Partial<LeadConfig["tiers"]>;
  const n = (v: unknown, fb: number) => (Number.isFinite(Number(v)) ? Number(v) : fb);
  return {
    ideal_customer: typeof r.ideal_customer === "string" ? r.ideal_customer : d.ideal_customer,
    criteria: criteria.length ? criteria.slice(0, 10) : d.criteria,
    lead_types: types.length >= 2 ? types.slice(0, 30) : d.lead_types,
    hot_rule: typeof r.hot_rule === "string" && r.hot_rule.trim() ? r.hot_rule : d.hot_rule,
    reps: reps.slice(0, 50),
    tiers: { a: n(tiers.a, d.tiers.a), b: n(tiers.b, d.tiers.b), c: n(tiers.c, d.tiers.c) },
  };
}
