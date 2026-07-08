// Frontend-safe mirror of the actions ("scopes") each connector exposes to
// agents. The runtime source of truth is
// supabase/functions/_shared/connector-actions.ts (CONNECTOR_ACTIONS) — that file
// is Deno/edge-only (it ships the actual `run` implementations + secrets), so we
// keep a lightweight name/description/write copy here to render in the UI.
// Keep the action names in sync with the backend catalog.

export interface ConnectorActionMeta {
  name: string;
  description: string;
  /** Outgoing/irreversible action (post, create, update…) vs read-only. */
  write?: boolean;
}

export const CONNECTOR_ACTIONS_META: Record<string, ConnectorActionMeta[]> = {
  // ── Messaging ──────────────────────────────────────────────────────────────
  slack: [
    { name: "post_message", description: "Poster un message dans un canal (chat.postMessage).", write: true },
    { name: "list_channels", description: "Lister les canaux publics visibles par le bot." },
    { name: "post_webhook", description: "Poster via le webhook entrant configuré.", write: true },
  ],
  teams: [
    { name: "post_message", description: "Poster un message dans le canal Teams (webhook entrant).", write: true },
  ],
  discord: [
    { name: "post_message", description: "Poster un message dans le canal Discord (webhook).", write: true },
  ],
  telegram: [
    { name: "send_message", description: "Envoyer un message au chat Telegram configuré.", write: true },
  ],

  // ── CRM & Support ─────────────────────────────────────────────────────────
  hubspot: [
    { name: "list_contacts", description: "Lister les contacts du CRM." },
    { name: "list_deals", description: "Lister les deals du pipeline." },
    { name: "list_companies", description: "Lister les entreprises." },
    { name: "search_contacts", description: "Rechercher des contacts (email/nom)." },
    { name: "create_note", description: "Créer une note dans le CRM.", write: true },
  ],
  pipedrive: [
    { name: "list_deals", description: "Lister les deals." },
    { name: "list_persons", description: "Lister les personnes (contacts)." },
    { name: "pipeline_summary", description: "Résumé des deals par étape du pipeline." },
  ],
  salesforce: [
    { name: "soql_query", description: "Exécuter une requête SOQL en lecture seule (SELECT)." },
    { name: "list_opportunities", description: "Lister les opportunités récentes." },
  ],
  attio: [
    { name: "list_records", description: "Interroger les enregistrements d'un objet (companies, people…)." },
  ],
  intercom: [
    { name: "list_contacts", description: "Lister les contacts." },
    { name: "search_conversations", description: "Lister les conversations récentes." },
  ],

  // ── Billing ────────────────────────────────────────────────────────────────
  stripe: [
    { name: "list_customers", description: "Lister les clients." },
    { name: "list_subscriptions", description: "Lister les abonnements (par statut)." },
    { name: "list_invoices", description: "Lister les factures." },
    { name: "balance", description: "Solde du compte." },
  ],

  // ── HR & People / Recruiting ─────────────────────────────────────────────
  bamboohr: [
    { name: "employee_directory", description: "Annuaire des employés." },
    { name: "time_off_requests", description: "Lister les demandes de congés." },
  ],
  greenhouse: [
    { name: "list_jobs", description: "Lister les postes ouverts." },
    { name: "list_candidates", description: "Lister les candidats récents." },
  ],
  deel: [
    { name: "list_people", description: "Lister les travailleurs / contractors." },
  ],
  factorial: [
    { name: "list_employees", description: "Lister les employés." },
    { name: "list_leaves", description: "Lister les congés / absences." },
  ],
  lever: [
    { name: "list_candidates", description: "Lister les candidatures / opportunités récentes." },
    { name: "list_postings", description: "Lister les offres publiées." },
  ],
  workable: [
    { name: "list_candidates", description: "Lister les candidats sur tous les postes." },
    { name: "list_jobs", description: "Lister les postes publiés." },
  ],

  // ── Docs & project management ─────────────────────────────────────────────
  notion: [
    { name: "search", description: "Rechercher pages et bases par texte." },
    { name: "query_database", description: "Interroger les lignes d'une base Notion." },
    { name: "get_page", description: "Récupérer les propriétés d'une page." },
    { name: "create_page", description: "Créer une page dans une page parente.", write: true },
  ],
  linear: [
    { name: "list_issues", description: "Lister les issues récentes (titre, état, assigné, priorité)." },
    { name: "list_teams", description: "Lister les équipes." },
    { name: "list_projects", description: "Lister les projets et leur avancement." },
    { name: "create_issue", description: "Créer une issue dans une équipe.", write: true },
  ],
  airtable: [
    { name: "list_records", description: "Lister les enregistrements d'une table." },
    { name: "create_record", description: "Créer un enregistrement dans une table.", write: true },
  ],
  github: [
    { name: "list_repos", description: "Lister les dépôts accessibles au token." },
    { name: "list_issues", description: "Lister les issues ouvertes d'un dépôt." },
    { name: "create_issue", description: "Ouvrir une issue sur un dépôt.", write: true },
  ],

  // ── Analytics & monitoring ────────────────────────────────────────────────
  posthog: [
    { name: "list_insights", description: "Lister les insights enregistrés." },
    { name: "trends", description: "Exécuter une requête de tendance sur un évènement." },
  ],
  plausible: [
    { name: "aggregate", description: "Agréger visiteurs/pages vues/rebond sur une période." },
    { name: "breakdown", description: "Top pages ou sources." },
  ],
  sentry: [
    { name: "list_projects", description: "Lister les projets accessibles." },
    { name: "list_issues", description: "Lister les issues non résolues d'un projet." },
  ],

  // ── Design ─────────────────────────────────────────────────────────────────
  figma: [
    { name: "get_file", description: "Récupérer l'arbre d'un fichier (nœuds, pages)." },
    { name: "get_comments", description: "Lister les commentaires d'un fichier." },
  ],

  // ── Productivity ───────────────────────────────────────────────────────────
  "google-calendar": [
    { name: "list_events", description: "Lister les évènements à venir." },
    { name: "create_event", description: "Créer un évènement dans le calendrier.", write: true },
  ],

  // ── Data lakes & warehouses ────────────────────────────────────────────────
  athena: [
    { name: "query", description: "Requête SQL en lecture seule sur le data lake S3 (Athena)." },
    { name: "list_tables", description: "Lister les tables de la base Glue configurée." },
  ],
  gcs: [
    { name: "list_objects", description: "Lister les objets d'un bucket GCS (par préfixe)." },
    { name: "read_object", description: "Lire le contenu texte/JSON d'un objet (100 Ko max)." },
  ],
  bigquery: [
    { name: "query", description: "Requête SQL en lecture seule (BigQuery standard SQL)." },
    { name: "list_datasets", description: "Lister les datasets du projet." },
  ],
  "azure-blob": [
    { name: "list_containers", description: "Lister les containers du compte de stockage." },
    { name: "list_blobs", description: "Lister les blobs d'un container." },
  ],
  "azure-synapse": [
    { name: "query", description: "Requête SQL en lecture seule (Synapse serverless)." },
  ],
};

export function connectorActionsMeta(slug: string): ConnectorActionMeta[] {
  return CONNECTOR_ACTIONS_META[slug] ?? [];
}
