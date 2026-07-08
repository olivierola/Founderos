// Pre-designed, "coded" automations an agent can switch on from Customize →
// Automation. Each one is a recipe that, when enabled:
//   1. grants the agent the connector-action tools it needs (one per provider), and
//   2. spawns a scheduled mission (title + brief) the existing agent scheduler runs.
// The brief IS the coded behaviour — the agent executes it on every schedule tick
// using the granted connector actions. Provider slugs must exist in PROVIDERS and
// the actions referenced must exist in the connector-actions catalog.
import {
  TrendingUp, LifeBuoy, Bug, ListChecks, BarChart3, Users, CalendarClock,
  BookOpen, Receipt, Megaphone, type LucideIcon,
} from "lucide-react";
import type { MissionSchedule } from "./shared";

export interface AgentAutomation {
  key: string;
  name: string;
  description: string;
  category: string;
  icon: LucideIcon;
  /** Connector slugs the automation needs (granted as tools + must be connected). */
  providers: string[];
  /** Human-readable actions used, shown on the card. */
  uses: string[];
  schedule: Exclude<MissionSchedule, null>;
  missionTitle: string;
  missionBrief: string;
}

export const AGENT_AUTOMATIONS: AgentAutomation[] = [
  {
    key: "daily_pipeline_digest",
    name: "Résumé quotidien du pipeline",
    description: "Chaque jour, synthétise l'évolution du pipeline CRM et poste un récap dans Slack.",
    category: "Ventes & CRM",
    icon: TrendingUp,
    providers: ["hubspot", "slack"],
    uses: ["hubspot · list_deals", "hubspot · list_contacts", "slack · post_message"],
    schedule: "daily",
    missionTitle: "Résumé quotidien du pipeline",
    missionBrief:
      "Chaque jour : récupère les deals et contacts récents de HubSpot, synthétise l'évolution du pipeline " +
      "(nouveaux deals, montants totaux par étape, deals bougés) et poste un résumé clair et concis dans Slack. " +
      "Mets en avant les deals à risque et les prochaines actions recommandées.",
  },
  {
    key: "weekly_revenue_report",
    name: "Rapport de revenus hebdo",
    description: "Compile MRR, factures et abonnements Stripe en un rapport hebdomadaire posté sur Slack.",
    category: "Finance",
    icon: Receipt,
    providers: ["stripe", "slack"],
    uses: ["stripe · list_invoices", "stripe · list_subscriptions", "stripe · balance", "slack · post_message"],
    schedule: "weekly",
    missionTitle: "Rapport de revenus hebdomadaire",
    missionBrief:
      "Chaque semaine : récupère factures, abonnements et solde via Stripe. Calcule les revenus de la semaine, " +
      "les nouvelles souscriptions et les churn/impayés notables, puis poste un rapport structuré dans Slack. " +
      "Produis aussi un délivrable rapport avec les chiffres clés.",
  },
  {
    key: "support_triage",
    name: "Tri des conversations support",
    description: "Trie les nouvelles conversations Intercom, évalue l'urgence et prépare des brouillons de réponse.",
    category: "Support",
    icon: LifeBuoy,
    providers: ["intercom"],
    uses: ["intercom · search_conversations", "intercom · list_contacts"],
    schedule: "daily",
    missionTitle: "Tri quotidien du support",
    missionBrief:
      "Chaque jour : liste les conversations Intercom récentes, classe-les par urgence et thème, identifie celles " +
      "qui nécessitent une escalade, et prépare pour chacune un brouillon de réponse en délivrable. " +
      "Signale les tickets bloqués depuis plus de 24h.",
  },
  {
    key: "sentry_error_watch",
    name: "Veille erreurs Sentry",
    description: "Surveille les erreurs Sentry non résolues et alerte Slack sur les régressions critiques.",
    category: "DevOps & Monitoring",
    icon: Bug,
    providers: ["sentry", "slack"],
    uses: ["sentry · list_issues", "sentry · list_projects", "slack · post_message"],
    schedule: "daily",
    missionTitle: "Veille erreurs Sentry",
    missionBrief:
      "Chaque jour : récupère les issues non résolues des projets Sentry, repère les nouvelles erreurs et les pics " +
      "de fréquence, puis poste dans Slack un résumé des problèmes critiques avec lien et nombre d'occurrences. " +
      "Ne signale que ce qui est réellement actionnable.",
  },
  {
    key: "linear_standup",
    name: "Standup produit automatique",
    description: "Génère un standup quotidien de l'avancement des issues et projets Linear, posté sur Slack.",
    category: "Produit",
    icon: ListChecks,
    providers: ["linear", "slack"],
    uses: ["linear · list_issues", "linear · list_projects", "slack · post_message"],
    schedule: "daily",
    missionTitle: "Standup produit quotidien",
    missionBrief:
      "Chaque jour : récupère les issues en cours et l'avancement des projets Linear, puis rédige un standup concis " +
      "(fait / en cours / bloqué) et poste-le dans Slack. Mets en évidence les issues sans assigné et les échéances proches.",
  },
  {
    key: "analytics_weekly",
    name: "Bilan analytics hebdo",
    description: "Résume les tendances produit de la semaine (PostHog) en un délivrable exploitable.",
    category: "Analytics",
    icon: BarChart3,
    providers: ["posthog"],
    uses: ["posthog · trends", "posthog · list_insights"],
    schedule: "weekly",
    missionTitle: "Bilan analytics hebdomadaire",
    missionBrief:
      "Chaque semaine : interroge PostHog sur les évènements clés (pageviews, activation, rétention), compare à la " +
      "semaine précédente et produis un délivrable synthétique avec les tendances, anomalies et recommandations.",
  },
  {
    key: "hiring_pipeline",
    name: "Suivi du pipeline de recrutement",
    description: "Résume postes ouverts et candidats (Greenhouse) chaque semaine.",
    category: "RH & Recrutement",
    icon: Users,
    providers: ["greenhouse"],
    uses: ["greenhouse · list_jobs", "greenhouse · list_candidates"],
    schedule: "weekly",
    missionTitle: "Suivi hebdo du recrutement",
    missionBrief:
      "Chaque semaine : liste les postes ouverts et les candidats récents dans Greenhouse, synthétise l'avancement " +
      "par poste (nombre de candidats par étape, postes en souffrance) et produis un délivrable de suivi RH.",
  },
  {
    key: "morning_calendar_brief",
    name: "Briefing matinal de l'agenda",
    description: "Chaque matin, envoie sur Slack le récap des réunions du jour et la préparation utile.",
    category: "Productivité",
    icon: CalendarClock,
    providers: ["google-calendar", "slack"],
    uses: ["google-calendar · list_events", "slack · post_message"],
    schedule: "daily",
    missionTitle: "Briefing matinal de l'agenda",
    missionBrief:
      "Chaque matin : liste les évènements du jour via Google Calendar, résume-les (heure, sujet, participants) et " +
      "poste un briefing dans Slack avec, pour chaque réunion importante, un rappel de préparation.",
  },
  {
    key: "notion_knowledge_digest",
    name: "Digest de la base Notion",
    description: "Compile les mises à jour récentes de Notion en un digest hebdomadaire.",
    category: "Docs & Connaissance",
    icon: BookOpen,
    providers: ["notion"],
    uses: ["notion · search", "notion · query_database"],
    schedule: "weekly",
    missionTitle: "Digest hebdo de la base Notion",
    missionBrief:
      "Chaque semaine : recherche les pages et bases Notion mises à jour récemment, résume les changements notables " +
      "et produis un digest de connaissance en délivrable pour l'équipe.",
  },
  {
    key: "social_publishing",
    name: "Publication sociale programmée",
    description: "Rédige et poste un contenu récurrent sur le canal Slack de l'équipe marketing.",
    category: "Marketing",
    icon: Megaphone,
    providers: ["slack"],
    uses: ["slack · post_message"],
    schedule: "weekly",
    missionTitle: "Publication sociale hebdomadaire",
    missionBrief:
      "Chaque semaine : propose un contenu court et engageant aligné sur l'actualité de l'entreprise, puis poste-le " +
      "dans le canal Slack marketing pour relecture avant publication externe.",
  },
];

export function automationsByCategory(): { category: string; items: AgentAutomation[] }[] {
  const order: string[] = [];
  const map: Record<string, AgentAutomation[]> = {};
  for (const a of AGENT_AUTOMATIONS) {
    if (!map[a.category]) { map[a.category] = []; order.push(a.category); }
    map[a.category].push(a);
  }
  return order.map((category) => ({ category, items: map[category] }));
}

/** Compute the next fire time so enabling doesn't trigger an immediate run. */
export function nextRunAt(schedule: Exclude<MissionSchedule, null>): string {
  const d = new Date();
  if (schedule === "daily") d.setDate(d.getDate() + 1);
  else if (schedule === "weekly") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}
