import {
  Github,
  Gitlab,
  CreditCard,
  Database,
  Cloud,
  Sparkles,
  Brain,
  BarChart3,
  Mail,
  Bot,
  ShieldAlert,
  Activity,
  MessageSquare,
  Send,
  Box,
  Cpu,
  LineChart,
  Bug,
  Lock,
  Webhook,
  HardDrive,
  Boxes,
  Workflow,
  Users,
  FileText,
  Phone,
  Search,
  Headphones,
  Zap,
  Megaphone,
  Twitter,
  Linkedin,
  CalendarClock,
  Palette,
  Image,
  Table2,
  PieChart,
  UserCheck,
  BriefcaseBusiness,
  type LucideIcon,
} from "lucide-react";

export interface ProviderField {
  key: string;
  label: string;
  placeholder?: string;
  secret: boolean;
  helpUrl?: string;
}

export type ProviderCategory =
  | "repo"
  | "payments"
  | "backend"
  | "hosting"
  | "ai"
  | "analytics"
  | "email"
  | "monitoring"
  | "messaging"
  | "storage"
  | "automation"
  | "security"
  | "crm"
  | "marketing"
  | "hr"
  | "design"
  | "data"
  | "tooling";

export interface ProviderDef {
  slug: string;
  name: string;
  category: ProviderCategory;
  icon: LucideIcon;
  description: string;
  fields: ProviderField[];
  mvp: boolean;
}

function apiKeyField(label = "API key", placeholder = "key…", helpUrl?: string): ProviderField {
  return { key: "api_key", label, placeholder, secret: true, helpUrl };
}

export const PROVIDERS: ProviderDef[] = [
  {
    slug: "github",
    name: "GitHub",
    category: "repo",
    icon: Github,
    description: "Read-only access to scan your repositories.",
    mvp: true,
    fields: [
      {
        key: "token",
        label: "Personal Access Token",
        placeholder: "github_pat_…",
        secret: true,
        helpUrl: "https://github.com/settings/tokens?type=beta",
      },
    ],
  },
  {
    slug: "stripe",
    name: "Stripe",
    category: "payments",
    icon: CreditCard,
    description: "Sync customers, subscriptions, invoices and compute MRR/ARR.",
    mvp: true,
    fields: [
      {
        key: "secret_key",
        label: "Restricted secret key (read-only)",
        placeholder: "rk_live_… or sk_test_…",
        secret: true,
        helpUrl: "https://dashboard.stripe.com/apikeys/create",
      },
    ],
  },
  {
    slug: "vercel",
    name: "Vercel",
    category: "hosting",
    icon: Cloud,
    description: "Pull deployments and usage data.",
    mvp: true,
    fields: [
      {
        key: "token",
        label: "Vercel access token",
        placeholder: "Token from Account Settings → Tokens",
        secret: true,
        helpUrl: "https://vercel.com/account/tokens",
      },
      {
        key: "team_id",
        label: "Team ID (optional)",
        placeholder: "team_xxx",
        secret: false,
      },
    ],
  },
  {
    slug: "supabase",
    name: "Supabase",
    category: "backend",
    icon: Database,
    description: "Browse tables, add rows and manage auth users without writing SQL.",
    mvp: true,
    fields: [
      {
        key: "access_token",
        label: "Supabase Personal Access Token",
        placeholder: "sbp_…",
        secret: true,
        helpUrl: "https://supabase.com/dashboard/account/tokens",
      },
      {
        key: "project_url",
        label: "Project URL (for table browsing / CRUD)",
        placeholder: "https://xxxx.supabase.co",
        secret: false,
      },
      {
        key: "service_role_key",
        label: "Service role key (for CRUD — stored encrypted)",
        placeholder: "eyJ… (service_role)",
        secret: true,
        helpUrl: "https://supabase.com/dashboard/project/_/settings/api",
      },
    ],
  },
  {
    slug: "groq",
    name: "Groq",
    category: "ai",
    icon: Sparkles,
    description: "Fast LLM for classification, summarisation, JSON extraction.",
    mvp: true,
    fields: [
      {
        key: "api_key",
        label: "Groq API key",
        placeholder: "gsk_…",
        secret: true,
        helpUrl: "https://console.groq.com/keys",
      },
    ],
  },
  {
    slug: "deepseek",
    name: "DeepSeek",
    category: "ai",
    icon: Brain,
    description: "Deeper LLM for code, architecture and security review.",
    mvp: true,
    fields: [
      {
        key: "api_key",
        label: "DeepSeek API key",
        placeholder: "sk-…",
        secret: true,
        helpUrl: "https://platform.deepseek.com/api_keys",
      },
    ],
  },
  {
    slug: "posthog",
    name: "PostHog",
    category: "analytics",
    icon: BarChart3,
    description: "Pull engagement metrics and feature usage.",
    mvp: true,
    fields: [
      { key: "api_key", label: "Personal API key", placeholder: "phx_…", secret: true, helpUrl: "https://posthog.com/" },
      { key: "host", label: "Host", placeholder: "https://eu.posthog.com", secret: false },
    ],
  },
  {
    slug: "resend",
    name: "Resend",
    category: "email",
    icon: Mail,
    description: "Send transactional emails from admin actions.",
    mvp: true,
    fields: [
      { key: "api_key", label: "Resend API key", placeholder: "re_…", secret: true, helpUrl: "https://resend.com/api-keys" },
    ],
  },

  // --- Repo providers ---
  {
    slug: "gitlab",
    name: "GitLab",
    category: "repo",
    icon: Gitlab,
    description: "Scan GitLab repositories.",
    mvp: true,
    fields: [apiKeyField("Personal Access Token", "glpat-…", "https://gitlab.com/-/profile/personal_access_tokens")],
  },

  // --- Payments ---
  {
    slug: "lemonsqueezy",
    name: "Lemon Squeezy",
    category: "payments",
    icon: CreditCard,
    description: "Merchant-of-record billing, subscriptions and orders.",
    mvp: true,
    fields: [apiKeyField("API key", "eyJ…", "https://app.lemonsqueezy.com/settings/api")],
  },
  {
    slug: "paddle",
    name: "Paddle",
    category: "payments",
    icon: CreditCard,
    description: "Subscription billing and tax compliance.",
    mvp: true,
    fields: [apiKeyField("API key", "pdl_…", "https://vendors.paddle.com/authentication")],
  },

  // --- AI providers ---
  {
    slug: "openai",
    name: "OpenAI",
    category: "ai",
    icon: Sparkles,
    description: "GPT models for chat, embeddings and analysis.",
    mvp: true,
    fields: [apiKeyField("OpenAI API key", "sk-…", "https://platform.openai.com/api-keys")],
  },
  {
    slug: "anthropic",
    name: "Anthropic",
    category: "ai",
    icon: Bot,
    description: "Claude models for deep reasoning and code.",
    mvp: true,
    fields: [apiKeyField("Anthropic API key", "sk-ant-…", "https://console.anthropic.com/settings/keys")],
  },
  {
    slug: "mistral",
    name: "Mistral",
    category: "ai",
    icon: Cpu,
    description: "Open-weight European LLMs.",
    mvp: true,
    fields: [apiKeyField("Mistral API key", "…", "https://console.mistral.ai/api-keys")],
  },
  {
    slug: "openrouter",
    name: "OpenRouter",
    category: "ai",
    icon: Workflow,
    description: "Unified gateway to many LLM providers.",
    mvp: true,
    fields: [apiKeyField("OpenRouter key", "sk-or-…", "https://openrouter.ai/keys")],
  },

  // --- Analytics ---
  {
    slug: "mixpanel",
    name: "Mixpanel",
    category: "analytics",
    icon: LineChart,
    description: "Product analytics and funnels.",
    mvp: true,
    fields: [
      { key: "project_token", label: "Project token", placeholder: "…", secret: true },
      apiKeyField("API secret", "…", "https://mixpanel.com/settings/project"),
    ],
  },
  {
    slug: "plausible",
    name: "Plausible",
    category: "analytics",
    icon: BarChart3,
    description: "Privacy-friendly web analytics.",
    mvp: true,
    fields: [apiKeyField("API key", "…", "https://plausible.io/settings/api-keys")],
  },
  {
    slug: "amplitude",
    name: "Amplitude",
    category: "analytics",
    icon: LineChart,
    description: "Digital product analytics.",
    mvp: true,
    fields: [apiKeyField("API key", "…", "https://amplitude.com")],
  },
  {
    slug: "posthog",
    name: "PostHog",
    category: "analytics",
    icon: BarChart3,
    description: "Use PostHog as your external analytics: import events into FounderOS and mirror tracked events back to PostHog.",
    mvp: true,
    fields: [
      {
        key: "host",
        label: "Host",
        placeholder: "https://eu.i.posthog.com (or us.i.posthog.com / your self-hosted URL)",
        secret: false,
        helpUrl: "https://posthog.com/docs/api",
      },
      {
        key: "project_id",
        label: "Project ID",
        placeholder: "12345",
        secret: false,
        helpUrl: "https://app.posthog.com/settings/project#variables",
      },
      {
        key: "personal_api_key",
        label: "Personal API key (read — for importing events)",
        placeholder: "phx_…",
        secret: true,
        helpUrl: "https://app.posthog.com/settings/user-api-keys",
      },
      {
        key: "project_api_key",
        label: "Project API key (write — optional, to mirror events to PostHog)",
        placeholder: "phc_…",
        secret: false,
        helpUrl: "https://app.posthog.com/settings/project#variables",
      },
    ],
  },

  // --- Monitoring ---
  {
    slug: "sentry",
    name: "Sentry",
    category: "monitoring",
    icon: Bug,
    description: "Error tracking and performance monitoring.",
    mvp: true,
    fields: [apiKeyField("Auth token", "sntrys_…", "https://sentry.io/settings/account/api/auth-tokens/")],
  },
  {
    slug: "datadog",
    name: "Datadog",
    category: "monitoring",
    icon: Activity,
    description: "Infrastructure and APM monitoring.",
    mvp: true,
    fields: [
      apiKeyField("API key", "…", "https://app.datadoghq.com/organization-settings/api-keys"),
      { key: "app_key", label: "Application key", placeholder: "…", secret: true },
    ],
  },
  {
    slug: "betterstack",
    name: "Better Stack",
    category: "monitoring",
    icon: Activity,
    description: "Uptime monitoring and incident management.",
    mvp: true,
    fields: [apiKeyField("API token", "…", "https://betterstack.com")],
  },

  // --- Messaging ---
  {
    slug: "slack",
    name: "Slack",
    category: "messaging",
    icon: MessageSquare,
    description: "Send alerts and admin notifications to Slack.",
    mvp: true,
    fields: [
      { key: "webhook_url", label: "Incoming webhook URL", placeholder: "https://hooks.slack.com/…", secret: true, helpUrl: "https://api.slack.com/messaging/webhooks" },
    ],
  },
  {
    slug: "discord",
    name: "Discord",
    category: "messaging",
    icon: MessageSquare,
    description: "Post notifications to a Discord channel.",
    mvp: true,
    fields: [
      { key: "webhook_url", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/…", secret: true },
    ],
  },
  {
    slug: "telegram",
    name: "Telegram",
    category: "messaging",
    icon: Send,
    description: "Bot notifications to a Telegram chat.",
    mvp: true,
    fields: [
      apiKeyField("Bot token", "123:ABC…"),
      { key: "chat_id", label: "Chat ID", placeholder: "-100…", secret: false },
    ],
  },

  // --- Email (more) ---
  {
    slug: "sendgrid",
    name: "SendGrid",
    category: "email",
    icon: Mail,
    description: "Transactional and marketing email.",
    mvp: true,
    fields: [apiKeyField("API key", "SG.…", "https://app.sendgrid.com/settings/api_keys")],
  },
  {
    slug: "postmark",
    name: "Postmark",
    category: "email",
    icon: Mail,
    description: "Fast transactional email delivery.",
    mvp: true,
    fields: [apiKeyField("Server token", "…", "https://postmarkapp.com")],
  },

  // --- Storage ---
  {
    slug: "aws-s3",
    name: "AWS S3",
    category: "storage",
    icon: HardDrive,
    description: "Object storage buckets and usage.",
    mvp: true,
    fields: [
      { key: "access_key_id", label: "Access key ID", placeholder: "AKIA…", secret: true },
      { key: "secret_access_key", label: "Secret access key", placeholder: "…", secret: true },
      { key: "region", label: "Region", placeholder: "eu-west-1", secret: false },
    ],
  },
  {
    slug: "cloudflare",
    name: "Cloudflare",
    category: "hosting",
    icon: Cloud,
    description: "Pages, Workers, R2 and CDN analytics.",
    mvp: true,
    fields: [apiKeyField("API token", "…", "https://dash.cloudflare.com/profile/api-tokens")],
  },
  {
    slug: "cloudinary",
    name: "Cloudinary",
    category: "storage",
    icon: Box,
    description: "Media storage and transformation.",
    mvp: true,
    fields: [
      { key: "cloud_name", label: "Cloud name", placeholder: "my-cloud", secret: false },
      apiKeyField("API key", "…", "https://cloudinary.com/console"),
      { key: "api_secret", label: "API secret", placeholder: "…", secret: true },
    ],
  },

  // --- Hosting (more) ---
  {
    slug: "netlify",
    name: "Netlify",
    category: "hosting",
    icon: Cloud,
    description: "Deploys and build usage.",
    mvp: true,
    fields: [apiKeyField("Personal access token", "…", "https://app.netlify.com/user/applications")],
  },
  {
    slug: "railway",
    name: "Railway",
    category: "hosting",
    icon: Boxes,
    description: "App hosting and usage costs.",
    mvp: true,
    fields: [apiKeyField("API token", "…", "https://railway.app/account/tokens")],
  },
  {
    slug: "render",
    name: "Render",
    category: "hosting",
    icon: Cloud,
    description: "Web services and deploys.",
    mvp: true,
    fields: [apiKeyField("API key", "rnd_…", "https://dashboard.render.com/u/settings#api-keys")],
  },
  {
    slug: "fly",
    name: "Fly.io",
    category: "hosting",
    icon: Cloud,
    description: "Edge VM hosting — pull releases per app.",
    mvp: true,
    fields: [
      apiKeyField("API token", "fly_…", "https://fly.io/user/personal_access_tokens"),
    ],
  },
  {
    slug: "heroku",
    name: "Heroku",
    category: "hosting",
    icon: Cloud,
    description: "Classic PaaS — fetch releases per app.",
    mvp: true,
    fields: [
      apiKeyField("API token", "HRKU-…", "https://dashboard.heroku.com/account#api-key"),
    ],
  },
  {
    slug: "firebase",
    name: "Firebase",
    category: "backend",
    icon: Cloud,
    description: "Browse and edit Firestore collections; read Auth users.",
    mvp: true,
    fields: [
      { key: "project_id", label: "Project ID", placeholder: "my-app-prod", secret: false, helpUrl: "https://console.firebase.google.com/" },
      {
        key: "service_account",
        label: "Service account JSON",
        placeholder: '{ "type": "service_account", "project_id": "…", "private_key": "…", "client_email": "…" }',
        secret: true,
        helpUrl: "https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk",
      },
    ],
  },
  {
    slug: "digitalocean",
    name: "DigitalOcean",
    category: "hosting",
    icon: Cloud,
    description: "Droplets, App Platform — infra events and deploys.",
    mvp: true,
    fields: [
      apiKeyField("Personal access token", "dop_v1_…", "https://cloud.digitalocean.com/account/api/tokens"),
    ],
  },
  {
    slug: "hetzner",
    name: "Hetzner Cloud",
    category: "hosting",
    icon: Cloud,
    description: "EU VPS — server actions as infra events.",
    mvp: true,
    fields: [
      apiKeyField("API token", "…", "https://docs.hetzner.cloud/#getting-started"),
    ],
  },

  // --- Backend / auth (more) ---
  {
    slug: "clerk",
    name: "Clerk",
    category: "backend",
    icon: Lock,
    description: "Auth and user management.",
    mvp: true,
    fields: [apiKeyField("Secret key", "sk_…", "https://dashboard.clerk.com")],
  },
  {
    slug: "neon",
    name: "Neon",
    category: "backend",
    icon: Database,
    description: "Serverless Postgres — browse & edit tables, run visual queries.",
    mvp: true,
    fields: [
      {
        key: "connection_string",
        label: "Connection string",
        placeholder: "postgresql://user:pass@ep-xxx.neon.tech/db?sslmode=require",
        secret: true,
        helpUrl: "https://console.neon.tech/app/projects",
      },
      apiKeyField("API key (optional, for metrics)", "…", "https://console.neon.tech/app/settings/api-keys"),
    ],
  },
  {
    slug: "postgres",
    name: "Postgres",
    category: "backend",
    icon: Database,
    description: "Any Postgres database — browse & edit tables, run visual queries.",
    mvp: true,
    fields: [
      {
        key: "connection_string",
        label: "Connection string",
        placeholder: "postgresql://user:pass@host:5432/db?sslmode=require",
        secret: true,
      },
    ],
  },
  {
    slug: "planetscale",
    name: "PlanetScale",
    category: "backend",
    icon: Database,
    description: "Serverless MySQL platform.",
    mvp: true,
    fields: [
      { key: "service_token_id", label: "Service token ID", placeholder: "…", secret: false },
      apiKeyField("Service token", "pscale_tkn_…", "https://app.planetscale.com"),
    ],
  },

  // --- Automation ---
  {
    slug: "n8n",
    name: "n8n",
    category: "automation",
    icon: Workflow,
    description: "Trigger n8n workflows from FounderOS events.",
    mvp: true,
    fields: [{ key: "webhook_url", label: "Webhook URL", placeholder: "https://…/webhook/…", secret: true }],
  },
  {
    slug: "zapier",
    name: "Zapier",
    category: "automation",
    icon: Webhook,
    description: "Connect to 6000+ apps via Zapier.",
    mvp: true,
    fields: [{ key: "webhook_url", label: "Catch hook URL", placeholder: "https://hooks.zapier.com/…", secret: true }],
  },
  {
    slug: "make",
    name: "Make",
    category: "automation",
    icon: Workflow,
    description: "Visual automation scenarios.",
    mvp: true,
    fields: [{ key: "webhook_url", label: "Webhook URL", placeholder: "https://hook.…/…", secret: true }],
  },

  // --- Security ---
  {
    slug: "snyk",
    name: "Snyk",
    category: "security",
    icon: ShieldAlert,
    description: "Dependency vulnerability scanning.",
    mvp: true,
    fields: [apiKeyField("API token", "…", "https://app.snyk.io/account")],
  },

  // --- CRM ---
  {
    slug: "hubspot",
    name: "HubSpot",
    category: "crm",
    icon: Users,
    description: "CRM contacts, deals and pipelines.",
    mvp: true,
    fields: [apiKeyField("Private app token", "pat-…", "https://app.hubspot.com")],
  },
  {
    slug: "intercom",
    name: "Intercom",
    category: "crm",
    icon: Headphones,
    description: "Customer support conversations and contacts.",
    mvp: true,
    fields: [apiKeyField("Access token", "…", "https://app.intercom.com")],
  },
  {
    slug: "pipedrive",
    name: "Pipedrive",
    category: "crm",
    icon: Users,
    description: "Sales CRM — deals, persons, pipelines. Agents read & report on the funnel.",
    mvp: true,
    fields: [
      { key: "company_domain", label: "Company domain", placeholder: "acme (from acme.pipedrive.com)", secret: false },
      apiKeyField("API token", "…", "https://developers.pipedrive.com/docs/api/v1"),
    ],
  },
  {
    slug: "salesforce",
    name: "Salesforce",
    category: "crm",
    icon: Cloud,
    description: "Enterprise CRM — accounts, opportunities, leads via REST API.",
    mvp: true,
    fields: [
      { key: "instance_url", label: "Instance URL", placeholder: "https://yourco.my.salesforce.com", secret: false, helpUrl: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/" },
      { key: "access_token", label: "Access token (OAuth)", placeholder: "00D…", secret: true },
    ],
  },
  {
    slug: "attio",
    name: "Attio",
    category: "crm",
    icon: Users,
    description: "Modern CRM — records, lists, notes. Agents query and summarise relationships.",
    mvp: true,
    fields: [apiKeyField("API key", "…", "https://developers.attio.com/")],
  },
  {
    slug: "linear",
    name: "Linear",
    category: "tooling",
    icon: Zap,
    description: "Issues, projects and engineering velocity.",
    mvp: true,
    fields: [apiKeyField("API key", "lin_api_…", "https://linear.app/settings/api")],
  },
  {
    slug: "notion",
    name: "Notion",
    category: "tooling",
    icon: FileText,
    description: "Docs, wikis and databases.",
    mvp: true,
    fields: [apiKeyField("Integration token", "secret_…", "https://www.notion.so/my-integrations")],
  },
  {
    slug: "algolia",
    name: "Algolia",
    category: "tooling",
    icon: Search,
    description: "Hosted search and indexing.",
    mvp: true,
    fields: [
      { key: "app_id", label: "Application ID", placeholder: "…", secret: false },
      apiKeyField("Admin API key", "…", "https://dashboard.algolia.com/account/api-keys"),
    ],
  },
  {
    slug: "twilio",
    name: "Twilio",
    category: "messaging",
    icon: Phone,
    description: "SMS and voice notifications.",
    mvp: true,
    fields: [
      { key: "account_sid", label: "Account SID", placeholder: "AC…", secret: false },
      apiKeyField("Auth token", "…", "https://console.twilio.com"),
      { key: "from_number", label: "From number (E.164, optional)", placeholder: "+1…", secret: false },
    ],
  },
  {
    slug: "segment",
    name: "Segment",
    category: "analytics",
    icon: BarChart3,
    description: "Customer data pipeline.",
    mvp: true,
    fields: [apiKeyField("Write key", "…", "https://app.segment.com")],
  },
  {
    slug: "upstash",
    name: "Upstash",
    category: "backend",
    icon: Database,
    description: "Serverless Redis and Kafka.",
    mvp: true,
    fields: [
      { key: "host", label: "REST URL", placeholder: "https://xxx.upstash.io", secret: false, helpUrl: "https://console.upstash.com" },
      apiKeyField("REST token", "…", "https://console.upstash.com"),
    ],
  },
  {
    slug: "inngest",
    name: "Inngest",
    category: "automation",
    icon: Workflow,
    description: "Durable background jobs and workflows.",
    mvp: true,
    fields: [apiKeyField("Event key", "…", "https://app.inngest.com")],
  },

  // --- Marketing / social publishing ---
  {
    slug: "buffer",
    name: "Buffer",
    category: "marketing",
    icon: Megaphone,
    description: "Schedule & publish posts to X, LinkedIn, Instagram, Facebook and more from one place.",
    mvp: true,
    fields: [
      { key: "access_token", label: "Buffer access token", placeholder: "1/…", secret: true, helpUrl: "https://buffer.com/developers/api" },
    ],
  },
  {
    slug: "typefully",
    name: "Typefully",
    category: "marketing",
    icon: CalendarClock,
    description: "Write, schedule and publish threads to X and LinkedIn.",
    mvp: true,
    fields: [apiKeyField("API key", "…", "https://typefully.com/settings/api")],
  },
  {
    slug: "hypefury",
    name: "Hypefury",
    category: "marketing",
    icon: CalendarClock,
    description: "Grow and automate your social presence.",
    mvp: true,
    fields: [apiKeyField("API key", "…", "https://hypefury.com")],
  },
  {
    slug: "x",
    name: "X (Twitter)",
    category: "marketing",
    icon: Twitter,
    description: "Publish posts directly to X via the API v2.",
    mvp: true,
    fields: [
      { key: "bearer_token", label: "Bearer token", placeholder: "AAAA…", secret: true, helpUrl: "https://developer.twitter.com" },
    ],
  },
  {
    slug: "linkedin",
    name: "LinkedIn",
    category: "marketing",
    icon: Linkedin,
    description: "Publish posts to a LinkedIn page or profile.",
    mvp: true,
    fields: [
      { key: "access_token", label: "Access token", placeholder: "…", secret: true, helpUrl: "https://www.linkedin.com/developers/" },
    ],
  },
  {
    slug: "social-webhook",
    name: "Social webhook (n8n/Make/Zapier)",
    category: "marketing",
    icon: Webhook,
    description: "Relay posts to any channel via an automation webhook.",
    mvp: true,
    fields: [{ key: "webhook_url", label: "Webhook URL", placeholder: "https://…", secret: true }],
  },

  // --- HR / People ---
  {
    slug: "bamboohr",
    name: "BambooHR",
    category: "hr",
    icon: Users,
    description: "Employee directory, time off, onboarding — agents read HR data & build reports.",
    mvp: true,
    fields: [
      { key: "subdomain", label: "Company subdomain", placeholder: "acme (from acme.bamboohr.com)", secret: false },
      apiKeyField("API key", "…", "https://documentation.bamboohr.com/docs"),
    ],
  },
  {
    slug: "personio",
    name: "Personio",
    category: "hr",
    icon: BriefcaseBusiness,
    description: "EU HR platform — employees, absences, payroll context for HR agents.",
    mvp: true,
    fields: [
      { key: "client_id", label: "Client ID", placeholder: "…", secret: false },
      { key: "client_secret", label: "Client secret", placeholder: "…", secret: true, helpUrl: "https://developer.personio.de/docs" },
    ],
  },
  {
    slug: "greenhouse",
    name: "Greenhouse",
    category: "hr",
    icon: UserCheck,
    description: "Recruiting & ATS — candidates, jobs, pipeline analytics for hiring agents.",
    mvp: true,
    fields: [apiKeyField("Harvest API key", "…", "https://developers.greenhouse.io/harvest.html")],
  },
  {
    slug: "deel",
    name: "Deel",
    category: "hr",
    icon: Users,
    description: "Global payroll & contractors — contracts and payments for people ops.",
    mvp: true,
    fields: [apiKeyField("API token", "…", "https://developer.deel.com/")],
  },
  {
    slug: "factorial",
    name: "Factorial",
    category: "hr",
    icon: Users,
    description: "EU HR suite — employees, time off, payroll. Agents build people reports.",
    mvp: true,
    fields: [apiKeyField("API key", "…", "https://apidoc.factorialhr.com/")],
  },

  // --- Design ---
  {
    slug: "figma",
    name: "Figma",
    category: "design",
    icon: Palette,
    description: "Design files, components, comments — agents review designs & export assets.",
    mvp: true,
    fields: [apiKeyField("Personal access token", "figd_…", "https://www.figma.com/developers/api#access-tokens")],
  },
  {
    slug: "canva",
    name: "Canva",
    category: "design",
    icon: Image,
    description: "Create & export branded visuals — agents generate on-brand graphics.",
    mvp: true,
    fields: [apiKeyField("API key", "…", "https://www.canva.dev/docs/connect/")],
  },
  {
    slug: "cloudinary-design",
    name: "Cloudinary (assets)",
    category: "design",
    icon: Image,
    description: "Media asset management & transforms for design/marketing agents.",
    mvp: true,
    fields: [
      { key: "cloud_name", label: "Cloud name", placeholder: "my-cloud", secret: false },
      { key: "api_key", label: "API key", placeholder: "…", secret: false },
      { key: "api_secret", label: "API secret", placeholder: "…", secret: true, helpUrl: "https://cloudinary.com/documentation/admin_api" },
    ],
  },
  {
    slug: "unsplash",
    name: "Unsplash",
    category: "design",
    icon: Image,
    description: "Stock imagery — agents source visuals for content & decks.",
    mvp: true,
    fields: [apiKeyField("Access key", "…", "https://unsplash.com/developers")],
  },

  // --- Data & analytics (warehouses / BI) ---
  {
    slug: "bigquery",
    name: "BigQuery",
    category: "data",
    icon: Table2,
    description: "Google data warehouse — agents run analytical queries & build reports.",
    mvp: true,
    fields: [
      { key: "project_id", label: "GCP project ID", placeholder: "my-gcp-project", secret: false },
      {
        key: "service_account",
        label: "Service account JSON",
        placeholder: '{ "type": "service_account", "project_id": "…", "private_key": "…", "client_email": "…" }',
        secret: true,
        helpUrl: "https://cloud.google.com/bigquery/docs/authentication/service-account-file",
      },
    ],
  },
  {
    slug: "snowflake",
    name: "Snowflake",
    category: "data",
    icon: Database,
    description: "Cloud data warehouse — query company data for analyses & dashboards.",
    mvp: true,
    fields: [
      { key: "account", label: "Account identifier", placeholder: "xy12345.eu-west-1", secret: false },
      { key: "username", label: "User", placeholder: "ANALYST", secret: false },
      { key: "password", label: "Password", placeholder: "…", secret: true },
      { key: "warehouse", label: "Warehouse", placeholder: "COMPUTE_WH", secret: false },
    ],
  },
  {
    slug: "metabase",
    name: "Metabase",
    category: "data",
    icon: PieChart,
    description: "BI dashboards & questions — agents fetch metrics and assemble reports.",
    mvp: true,
    fields: [
      { key: "base_url", label: "Metabase URL", placeholder: "https://metabase.acme.com", secret: false },
      apiKeyField("API key", "…", "https://www.metabase.com/docs/latest/people-and-groups/api-keys"),
    ],
  },
  {
    slug: "airtable",
    name: "Airtable",
    category: "data",
    icon: Table2,
    description: "Flexible tables & bases — agents read/write structured data and report on it.",
    mvp: true,
    fields: [apiKeyField("Personal access token", "pat…", "https://airtable.com/create/tokens")],
  },
  {
    slug: "googlesheets",
    name: "Google Sheets",
    category: "data",
    icon: Table2,
    description: "Spreadsheets — agents read data, append rows and produce summaries.",
    mvp: true,
    fields: [
      { key: "service_account", label: "Service account JSON", placeholder: '{ "client_email": "…", "private_key": "…" }', secret: true, helpUrl: "https://developers.google.com/sheets/api/guides/authorizing" },
    ],
  },

  // --- Data lakes ---
  {
    slug: "athena",
    name: "AWS Athena (S3 data lake)",
    category: "data",
    icon: Database,
    description: "Query your S3 data lake with SQL via Athena. Agents run read-only analyses.",
    mvp: true,
    fields: [
      { key: "access_key_id", label: "Access key ID", placeholder: "AKIA…", secret: true },
      { key: "secret_access_key", label: "Secret access key", placeholder: "…", secret: true },
      { key: "region", label: "Region", placeholder: "eu-west-1", secret: false },
      { key: "database", label: "Glue database", placeholder: "analytics", secret: false },
      { key: "output_location", label: "Results S3 location", placeholder: "s3://my-athena-results/", secret: false, helpUrl: "https://docs.aws.amazon.com/athena/latest/APIReference/Welcome.html" },
      { key: "workgroup", label: "Workgroup (optional)", placeholder: "primary", secret: false },
    ],
  },
  {
    slug: "azure-blob",
    name: "Azure Blob Storage",
    category: "data",
    icon: HardDrive,
    description: "Azure object storage — list containers & read data-lake files.",
    mvp: true,
    fields: [
      { key: "account", label: "Storage account", placeholder: "mydatalake", secret: false },
      { key: "sas_token", label: "SAS token", placeholder: "sv=2022-…&sig=…", secret: true, helpUrl: "https://learn.microsoft.com/rest/api/storageservices/" },
    ],
  },
  {
    slug: "azure-synapse",
    name: "Azure Synapse",
    category: "data",
    icon: Database,
    description: "Synapse serverless SQL over your lake. Agents run read-only queries.",
    mvp: true,
    fields: [
      { key: "workspace", label: "Synapse workspace", placeholder: "myworkspace", secret: false, helpUrl: "https://learn.microsoft.com/rest/api/synapse/" },
      { key: "access_token", label: "Access token (AAD)", placeholder: "eyJ0…", secret: true },
      { key: "database", label: "Database", placeholder: "lakehouse", secret: false },
    ],
  },
  {
    slug: "gcs",
    name: "Google Cloud Storage",
    category: "data",
    icon: HardDrive,
    description: "GCS buckets & data-lake objects — agents list and read files.",
    mvp: true,
    fields: [
      { key: "service_account", label: "Service account JSON", placeholder: '{ "client_email": "…", "private_key": "…" }', secret: true, helpUrl: "https://cloud.google.com/storage/docs/json_api" },
    ],
  },
];

export function findProvider(slug: string) {
  return PROVIDERS.find((p) => p.slug === slug);
}
