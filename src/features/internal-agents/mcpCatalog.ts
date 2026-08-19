// Curated catalog of MCP servers, grouped by category. Users pick one and (for
// remote servers) only need to connect. Honesty matters here:
//   • url set        → a real official REMOTE endpoint (Streamable HTTP / SSE) →
//                       one-click add, then connect (OAuth) or paste a token.
//   • local: true    → only a LOCAL/stdio server exists → NOT reachable from our
//                       cloud runtime (remote transport only) → shown, disabled.
//   • neither        → exists but no known stable public endpoint → the picker
//                       prefills name/category and the user supplies the URL.
// Remote endpoints were sourced from the official docs + the awesome-remote-mcp
// lists (2026-07); they can change — the "Tester" button re-validates.

export type McpCatalogAuth = "oauth" | "header" | "none";

export interface McpCatalogEntry {
  name: string;
  url?: string;
  transport?: "http" | "sse";
  auth?: McpCatalogAuth;
  /** DCR client_name to send (servers like Figma allowlist it). */
  clientName?: string;
  /** Short guidance shown in the picker / prefilled form. */
  note?: string;
  /** Only a local/stdio server exists — not usable via our remote-only runtime. */
  local?: boolean;
}

export interface McpCatalogCategory {
  label: string;
  servers: McpCatalogEntry[];
}

const LOCAL = "Serveur local (stdio) — non joignable depuis le cloud. Utilisable seulement en auto-hébergé.";
const MANUAL = "Pas d'endpoint distant public connu — renseignez l'URL de votre instance.";
const KEY_IN_URL = (tpl: string) => `Endpoint distant avec clé d'API dans l'URL : ${tpl}`;

export const MCP_CATALOG: McpCatalogCategory[] = [
  {
    label: "Développement",
    servers: [
      { name: "GitHub", url: "https://api.githubcopilot.com/mcp", transport: "http", auth: "oauth" },
      { name: "GitLab", local: true, note: LOCAL },
      { name: "Bitbucket", note: MANUAL },
      { name: "Jira", url: "https://mcp.atlassian.com/v1/sse", transport: "sse", auth: "oauth", note: "Serveur Atlassian (Jira + Confluence)." },
      { name: "Confluence", url: "https://mcp.atlassian.com/v1/sse", transport: "sse", auth: "oauth", note: "Serveur Atlassian (Jira + Confluence)." },
      { name: "Linear", url: "https://mcp.linear.app/sse", transport: "sse", auth: "oauth" },
      { name: "Azure DevOps", local: true, note: LOCAL },
      { name: "Sentry", url: "https://mcp.sentry.dev/sse", transport: "sse", auth: "oauth" },
      { name: "Docker", local: true, note: LOCAL },
      { name: "Docker Hub", note: MANUAL },
      { name: "Kubernetes", local: true, note: LOCAL },
      { name: "Terraform", local: true, note: LOCAL },
      { name: "Helm", local: true, note: LOCAL },
      { name: "Postman", note: MANUAL },
      { name: "Swagger / OpenAPI", local: true, note: LOCAL },
      { name: "SonarQube", local: true, note: LOCAL },
      { name: "Jenkins", local: true, note: LOCAL },
      { name: "CircleCI", local: true, note: LOCAL },
      { name: "GitHub Actions", note: "Inclus dans le serveur GitHub (workflows/runs)." },
      { name: "Buildkite", url: "https://mcp.buildkite.com/mcp", transport: "http", auth: "oauth" },
      { name: "Vercel", url: "https://mcp.vercel.com", transport: "http", auth: "oauth" },
      { name: "Netlify", url: "https://netlify-mcp.netlify.app/mcp", transport: "http", auth: "oauth" },
      { name: "Railway", note: MANUAL },
      { name: "Render", note: MANUAL },
      { name: "Fly.io", local: true, note: LOCAL },
      { name: "Cloudflare", url: "https://bindings.mcp.cloudflare.com/sse", transport: "sse", auth: "oauth", note: "Workers/Bindings. Cloudflare propose aussi Docs, Observability, Radar…" },
      { name: "Firebase", local: true, note: LOCAL },
      { name: "Supabase", url: "https://mcp.supabase.com/mcp", transport: "http", auth: "oauth" },
      { name: "Neon", url: "https://mcp.neon.tech/mcp", transport: "http", auth: "oauth" },
      { name: "Prisma Postgres", url: "https://mcp.prisma.io/mcp", transport: "http", auth: "oauth" },
      { name: "PlanetScale", note: MANUAL },
      { name: "Stack Overflow", url: "https://mcp.stackoverflow.com", transport: "http", auth: "oauth" },
    ],
  },
  {
    label: "Bases de données",
    servers: [
      { name: "PostgreSQL", local: true, note: LOCAL },
      { name: "MySQL", local: true, note: LOCAL },
      { name: "MariaDB", local: true, note: LOCAL },
      { name: "SQLite", local: true, note: LOCAL },
      { name: "MongoDB", local: true, note: LOCAL },
      { name: "Redis", local: true, note: LOCAL },
      { name: "Elasticsearch", local: true, note: LOCAL },
      { name: "ClickHouse", local: true, note: LOCAL },
      { name: "Snowflake", local: true, note: LOCAL },
      { name: "BigQuery", url: "https://bigquery.googleapis.com/mcp", transport: "http", auth: "header", note: "Header Authorization: Bearer <token GCP>." },
      { name: "DuckDB", local: true, note: LOCAL },
      { name: "Cassandra", local: true, note: LOCAL },
      { name: "Neo4j", local: true, note: LOCAL },
      { name: "Pinecone", local: true, note: LOCAL },
      { name: "Weaviate", local: true, note: LOCAL },
      { name: "Qdrant", local: true, note: LOCAL },
      { name: "Milvus", local: true, note: LOCAL },
      { name: "ChromaDB", local: true, note: LOCAL },
    ],
  },
  {
    label: "Cloud",
    servers: [
      { name: "AWS", url: "https://knowledge-mcp.global.api.aws", transport: "http", auth: "none", note: "AWS Knowledge (docs/API). Les serveurs AWS opérationnels sont locaux." },
      { name: "Azure", local: true, note: LOCAL },
      { name: "Google Cloud", local: true, note: LOCAL },
      { name: "DigitalOcean", note: MANUAL },
      { name: "Oracle Cloud", note: MANUAL },
      { name: "Databricks", note: MANUAL },
    ],
  },
  {
    label: "Productivité",
    servers: [
      { name: "Notion", url: "https://mcp.notion.com/mcp", transport: "http", auth: "oauth" },
      { name: "Obsidian", local: true, note: LOCAL },
      { name: "Evernote", note: MANUAL },
      { name: "Asana", url: "https://mcp.asana.com/sse", transport: "sse", auth: "oauth" },
      { name: "Trello", note: MANUAL },
      { name: "Monday.com", url: "https://mcp.monday.com/sse", transport: "sse", auth: "oauth" },
      { name: "ClickUp", local: true, note: LOCAL },
      { name: "Airtable", url: "https://mcp.airtable.com/mcp", transport: "http", auth: "oauth" },
      { name: "Todoist", local: true, note: LOCAL },
      { name: "Coda", note: MANUAL },
      { name: "Slab", note: MANUAL },
    ],
  },
  {
    label: "Communication",
    servers: [
      { name: "Slack", local: true, note: LOCAL },
      { name: "Discord", local: true, note: LOCAL },
      { name: "Microsoft Teams", note: MANUAL },
      { name: "Telegram", local: true, note: LOCAL },
      { name: "WhatsApp", local: true, note: LOCAL },
      { name: "Gmail", local: true, note: LOCAL + " (ou déjà dispo via le connecteur Gmail natif)." },
      { name: "Outlook", note: MANUAL },
      { name: "Google Chat", note: MANUAL },
      { name: "Zoom", note: MANUAL },
    ],
  },
  {
    label: "Calendrier",
    servers: [
      { name: "Google Calendar", local: true, note: LOCAL + " (ou connecteur Google natif)." },
      { name: "Outlook Calendar", note: MANUAL },
      { name: "Apple Calendar", local: true, note: LOCAL },
      { name: "Cal.com", note: MANUAL },
    ],
  },
  {
    label: "Stockage",
    servers: [
      { name: "Google Drive", local: true, note: LOCAL + " (ou connecteur Google natif)." },
      { name: "OneDrive", note: MANUAL },
      { name: "Dropbox", note: MANUAL },
      { name: "Box", url: "https://mcp.box.com", transport: "http", auth: "oauth" },
      { name: "Nextcloud", local: true, note: LOCAL },
      { name: "SharePoint", note: MANUAL },
    ],
  },
  {
    label: "Design",
    servers: [
      { name: "Figma", url: "https://mcp.figma.com/mcp", transport: "http", auth: "oauth", clientName: "Claude Code", note: "⚠️ Figma allowliste le client_name (VS Code/Cursor/Claude Code). Contournement contre leur ToS." },
      { name: "Canva", url: "https://mcp.canva.com/mcp", transport: "http", auth: "oauth" },
      { name: "Blender", local: true, note: LOCAL },
      { name: "Unity", local: true, note: LOCAL },
      { name: "Unreal Engine", local: true, note: LOCAL },
      { name: "Godot", local: true, note: LOCAL },
    ],
  },
  {
    label: "IA",
    servers: [
      { name: "OpenAI", note: MANUAL },
      { name: "Anthropic", note: MANUAL },
      { name: "Mistral", note: MANUAL },
      { name: "Gemini", note: MANUAL },
      { name: "Hugging Face", url: "https://hf.co/mcp", transport: "http", auth: "none", note: "Public ; ajoutez un header Authorization: Bearer <HF token> (mode Header) pour vos ressources privées." },
      { name: "Ollama", local: true, note: LOCAL },
      { name: "LM Studio", local: true, note: LOCAL },
      { name: "ComfyUI", local: true, note: LOCAL },
      { name: "Automatic1111", local: true, note: LOCAL },
      { name: "Stability AI", note: MANUAL },
      { name: "Replicate", local: true, note: LOCAL },
    ],
  },
  {
    label: "Browser Automation",
    servers: [
      { name: "Playwright", local: true, note: LOCAL },
      { name: "Puppeteer", local: true, note: LOCAL },
      { name: "Chrome DevTools", local: true, note: LOCAL },
      { name: "Browserbase", note: MANUAL },
      { name: "Browser Use", local: true, note: LOCAL },
      { name: "Selenium", local: true, note: LOCAL },
    ],
  },
  {
    label: "Recherche Web",
    servers: [
      { name: "Firecrawl", note: KEY_IN_URL("https://mcp.firecrawl.dev/<API_KEY>/sse") },
      { name: "Apify", url: "https://mcp.apify.com", transport: "http", auth: "header", note: "Header Authorization: Bearer <token Apify>." },
      { name: "Bright Data", note: MANUAL },
      { name: "Tavily", note: KEY_IN_URL("https://mcp.tavily.com/mcp/?tavilyApiKey=<API_KEY>") },
      { name: "SerpAPI", note: MANUAL },
      { name: "Exa", url: "https://mcp.exa.ai/mcp", transport: "http", auth: "none", note: "Une clé Exa peut être requise (en query)." },
      { name: "Jina AI Reader", note: MANUAL },
      { name: "Context7", url: "https://mcp.context7.com/mcp", transport: "http", auth: "none" },
      { name: "DeepWiki", url: "https://mcp.deepwiki.com/sse", transport: "sse", auth: "none" },
    ],
  },
  {
    label: "Réseaux sociaux",
    servers: [
      { name: "X (Twitter)", local: true, note: LOCAL },
      { name: "Reddit", local: true, note: LOCAL },
      { name: "LinkedIn", note: MANUAL },
      { name: "YouTube", local: true, note: LOCAL },
      { name: "TikTok", note: MANUAL },
      { name: "Instagram", note: MANUAL },
      { name: "Facebook", note: MANUAL },
      { name: "Bluesky", local: true, note: LOCAL },
    ],
  },
  {
    label: "CRM / Sales",
    servers: [
      { name: "Salesforce", local: true, note: LOCAL },
      { name: "HubSpot", url: "https://app.hubspot.com/mcp/v1/http", transport: "http", auth: "header", note: "Header Authorization: Bearer <token privé HubSpot>." },
      { name: "Pipedrive", note: MANUAL },
      { name: "Zoho CRM", note: MANUAL },
      { name: "Close", url: "https://mcp.close.com/mcp", transport: "http", auth: "oauth" },
      { name: "Apollo.io", note: MANUAL },
    ],
  },
  {
    label: "Finance",
    servers: [
      { name: "Stripe", url: "https://mcp.stripe.com", transport: "http", auth: "oauth", note: "OAuth, ou mode Header avec une clé restreinte Stripe." },
      { name: "PayPal", url: "https://mcp.paypal.com/sse", transport: "sse", auth: "oauth" },
      { name: "Square", url: "https://mcp.squareup.com/sse", transport: "sse", auth: "oauth" },
      { name: "Wise", note: MANUAL },
      { name: "Plaid", url: "https://api.dashboard.plaid.com/mcp/sse", transport: "sse", auth: "oauth" },
    ],
  },
  {
    label: "E-commerce",
    servers: [
      // Storefront MCP is per-store, so there is no single URL to prefill — but
      // the pattern is fixed and needs no credentials, which is why the public
      // agent's E-commerce tab builds it from the shop domain.
      {
        name: "Shopify (Storefront)", transport: "http", auth: "none",
        note: "Endpoint public par boutique : https://{votre-boutique}/api/mcp — catalogue + panier, sans authentification.",
      },
      { name: "WooCommerce", local: true, note: LOCAL },
      { name: "BigCommerce", note: MANUAL },
      { name: "Magento", note: MANUAL },
      { name: "Wix", url: "https://mcp.wix.com/sse", transport: "sse", auth: "oauth" },
      { name: "Squarespace", note: MANUAL },
    ],
  },
  {
    label: "Automatisation",
    servers: [
      { name: "Zapier", note: "URL personnelle générée dans Zapier (https://mcp.zapier.com/…) — collez-la ici en mode Header." },
      { name: "n8n", local: true, note: LOCAL },
      { name: "Make", note: MANUAL },
      { name: "Pipedream", note: "Endpoint distant par app généré dans Pipedream — collez votre URL." },
      { name: "Activepieces", note: MANUAL },
    ],
  },
  {
    label: "Data / Analytics",
    servers: [
      { name: "Looker", local: true, note: LOCAL },
      { name: "Power BI", note: MANUAL },
      { name: "Tableau", note: MANUAL },
      { name: "Metabase", local: true, note: LOCAL },
      { name: "Grafana", local: true, note: LOCAL },
      { name: "Prometheus", local: true, note: LOCAL },
      { name: "Apache Superset", local: true, note: LOCAL },
    ],
  },
  {
    label: "Sécurité",
    servers: [
      { name: "Semgrep", url: "https://mcp.semgrep.ai/sse", transport: "sse", auth: "none" },
      { name: "Snyk", local: true, note: LOCAL },
      { name: "Wiz", note: MANUAL },
      { name: "CrowdStrike", note: MANUAL },
      { name: "Splunk", note: MANUAL },
      { name: "Elastic Security", note: MANUAL },
      { name: "SentinelOne", note: MANUAL },
    ],
  },
  {
    label: "Fichiers locaux",
    servers: [
      { name: "Filesystem", local: true, note: LOCAL },
      { name: "Desktop Commander", local: true, note: LOCAL },
      { name: "Shell", local: true, note: LOCAL },
      { name: "Terminal", local: true, note: LOCAL },
      { name: "Git", local: true, note: LOCAL },
    ],
  },
  {
    label: "Documentation",
    servers: [
      { name: "Confluence", url: "https://mcp.atlassian.com/v1/sse", transport: "sse", auth: "oauth", note: "Serveur Atlassian." },
      { name: "ReadMe", note: MANUAL },
      { name: "Mintlify", note: "Endpoint par docs généré dans Mintlify — collez votre URL." },
      { name: "Docusaurus", local: true, note: LOCAL },
      { name: "MkDocs", local: true, note: LOCAL },
    ],
  },
];

/** Flat count of servers that are one-click ready (have a remote URL). */
export function catalogReadyCount(): number {
  return MCP_CATALOG.reduce((n, c) => n + c.servers.filter((s) => s.url).length, 0);
}
