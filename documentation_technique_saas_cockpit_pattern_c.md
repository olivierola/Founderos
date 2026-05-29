# Documentation technique complète — SaaS Cockpit Admin pour développeurs SaaS

## 1. Vision produit

### Nom de travail
**SaaS Cockpit** / **DevOps Cockpit** / **FounderOS** / **StackPilot**

### Concept
Plateforme SaaS destinée aux développeurs, indie hackers, fondateurs et petites équipes SaaS permettant de connecter un dépôt Git, scanner automatiquement le code, détecter le stack technique, les dépendances, les services tiers, les coûts, les métriques business, puis générer un cockpit d'administration centralisé.

L'objectif est de fournir un **dashboard admin intelligent, code-aware et actionnable** pour piloter un SaaS depuis une seule interface : finance, coûts, infra, utilisateurs, dépendances, sécurité, monitoring, IA, connecteurs et actions admin.

### Positionnement
> Connecte ton repo, on comprend ton SaaS, on génère ton cockpit d'administration, on surveille tes coûts, ton revenu, tes dépendances, tes utilisateurs et tes risques techniques.

### Stack imposée
- **Frontend** : Vite + React + TypeScript
- **UI** : TailwindCSS + shadcn/ui + lucide-react
- **Backend** : Supabase
- **Database** : Supabase Postgres
- **Auth** : Supabase Auth
- **Storage** : Supabase Storage
- **Edge Functions** : Supabase Edge Functions
- **Realtime** : Supabase Realtime
- **IA rapide** : Groq Cloud
- **IA code / analyse profonde** : DeepSeek
- **Paiement** : Stripe
- **Repo providers MVP** : GitHub
- **Déploiement frontend** : Vercel ou Cloudflare Pages
- **Jobs async** : Supabase Edge Functions + pg_cron + queue table Supabase

---

## 2. Utilisateurs cibles

### 2.1 Solo founder / indie hacker
Besoin : gérer plusieurs micro-SaaS, connaître le MRR réel, les coûts, les dépendances, les alertes et les optimisations possibles.

### 2.2 Développeur SaaS B2B
Besoin : voir le stack, les utilisateurs, les abonnements, les erreurs, les performances et les risques de sécurité.

### 2.3 Petite équipe SaaS
Besoin : collaborer dans un workspace, connecter plusieurs repos, assigner des rôles, suivre les métriques business et techniques.

### 2.4 Agence SaaS / no-code / dev studio
Besoin : gérer plusieurs projets clients, suivre les coûts par client, proposer des dashboards white-label.

---

## 3. Pattern UX retenu : Pattern C

Le SaaS doit utiliser une **sidebar à deux colonnes**.

### Colonne 1 — modules principaux
Largeur : 64px environ.

Contient uniquement :
- Logo / workspace switcher
- Icônes des modules principaux
- Badge d'alerte par module
- Avatar utilisateur en bas

### Colonne 2 — sous-navigation contextuelle
Largeur : 220px environ.

Elle affiche les sous-onglets du module actif.

### Pourquoi ce pattern
Ce pattern est adapté car l'application contient beaucoup de modules et de sous-modules : finance, coûts, code, IA, utilisateurs, monitoring, actions, intégrations, etc. Une sidebar simple serait trop limitée et une sidebar accordéon deviendrait trop longue.

---

## 4. Architecture globale

```txt
Frontend Vite React
        |
        | Supabase JS Client
        |
Supabase Auth ---- Supabase Postgres ---- Supabase Storage
        |                  |
        |                  | RLS policies
        |
Supabase Edge Functions
        |
        |---- GitHub OAuth / GitHub API
        |---- Stripe API
        |---- Vercel API
        |---- Supabase Management API
        |---- Groq Cloud API
        |---- DeepSeek API
        |
Background Jobs / Queue Tables / Cron
```

### 4.1 Principes d'architecture
- Multi-tenant dès le départ.
- Chaque utilisateur appartient à un ou plusieurs workspaces.
- Chaque workspace peut contenir plusieurs projets SaaS.
- Chaque projet peut contenir plusieurs repositories.
- Chaque repository peut avoir plusieurs scans.
- Les résultats de scan sont stockés sous forme structurée.
- Les credentials sont chiffrés avant stockage.
- Les actions sensibles nécessitent validation utilisateur.
- RLS Supabase obligatoire sur toutes les tables tenant-aware.

---

## 5. Modules fonctionnels

# Module 1 — Overview

## Objectif
Donner une vue globale du SaaS ou du workspace.

## Sous-onglets
- Dashboard principal
- Multi-projets
- Alertes
- Briefing IA
- Activity feed

## Fonctionnement
L'écran Overview agrège les données issues des autres modules :
- MRR
- ARR
- nombre d'utilisateurs actifs
- coûts du mois
- marge estimée
- incidents actifs
- CVE critiques
- dépendances obsolètes
- recommandations IA
- dernières actions admin

## Widgets principaux
- Revenue card
- Cost card
- Net margin card
- Active users card
- Health status card
- Code health score
- AI recommendations
- Recent alerts
- Recent scans
- Recent admin actions

## Données utilisées
- `metrics_snapshots`
- `alerts`
- `projects`
- `scan_results`
- `cost_records`
- `revenue_records`
- `activity_logs`

---

# Module 2 — Code & Discovery

## Objectif
Scanner un dépôt GitHub pour comprendre automatiquement le SaaS.

## Sous-onglets
- Repositories
- Scan Results
- Architecture Map
- Dependencies
- Environment Variables
- API Usage
- Database Schema
- Security Findings
- Tech Debt

## Fonctionnement global
1. L'utilisateur connecte son compte GitHub.
2. Il sélectionne un repository.
3. Une entrée est créée dans `repositories`.
4. Un job de scan est créé dans `scan_jobs`.
5. Une Edge Function récupère le code via GitHub API.
6. Le scan analyse les fichiers importants.
7. Les résultats sont enregistrés dans Supabase.
8. L'IA enrichit les résultats avec une analyse contextuelle.

## Fichiers à scanner
### JavaScript / TypeScript
- `package.json`
- `pnpm-lock.yaml`
- `package-lock.json`
- `yarn.lock`
- `vite.config.ts`
- `next.config.js`
- `tsconfig.json`

### Backend
- `requirements.txt`
- `pyproject.toml`
- `Pipfile`
- `Gemfile`
- `composer.json`
- `go.mod`
- `Cargo.toml`

### Infra
- `Dockerfile`
- `docker-compose.yml`
- `vercel.json`
- `netlify.toml`
- `railway.json`
- `.github/workflows/*`
- `supabase/config.toml`

### Base de données
- `prisma/schema.prisma`
- `drizzle.config.ts`
- `supabase/migrations/*`
- `db/migrations/*`

### Variables d'environnement
- `.env.example`
- `.env.sample`
- `.env.local.example`

## Détections attendues
- Framework frontend : Vite, React, Next.js, Vue, Svelte
- Backend : Express, Fastify, NestJS, Django, FastAPI, Rails
- Database : Supabase, PostgreSQL, MySQL, MongoDB, PlanetScale, Neon
- Auth : Supabase Auth, Clerk, Auth0, NextAuth
- Paiement : Stripe, LemonSqueezy, Paddle
- Email : Resend, SendGrid, Mailgun, Brevo
- IA : OpenAI, Groq, Anthropic, DeepSeek, Mistral
- Analytics : PostHog, Mixpanel, Amplitude, Plausible
- Monitoring : Sentry, Datadog, Better Stack
- Storage : Cloudinary, S3, Supabase Storage
- Jobs : Inngest, BullMQ, QStash, Trigger.dev

## Sortie JSON attendue d'un scan

```json
{
  "project_type": "b2b_saas",
  "frontend": {
    "framework": "vite-react",
    "language": "typescript",
    "ui": ["tailwindcss", "shadcn/ui"]
  },
  "backend": {
    "provider": "supabase",
    "database": "postgres",
    "auth": "supabase-auth"
  },
  "payments": ["stripe"],
  "ai_providers": ["groq", "deepseek"],
  "analytics": ["posthog"],
  "monitoring": ["sentry"],
  "dependencies": [
    {
      "name": "@supabase/supabase-js",
      "version": "2.45.0",
      "category": "backend",
      "risk": "low"
    }
  ],
  "env_vars": [
    {
      "key": "VITE_SUPABASE_URL",
      "detected_service": "supabase",
      "sensitivity": "public"
    },
    {
      "key": "STRIPE_SECRET_KEY",
      "detected_service": "stripe",
      "sensitivity": "secret"
    }
  ],
  "recommendations": [
    {
      "type": "security",
      "severity": "high",
      "message": "Stripe secret key should never be exposed client-side."
    }
  ]
}
```

## IA utilisée
### Groq Cloud
Utilisé pour :
- classification rapide des fichiers
- résumé de scan
- génération de recommandations simples
- briefing journalier

### DeepSeek
Utilisé pour :
- analyse de code plus profonde
- détection de patterns complexes
- audit sécurité applicatif
- analyse des dépendances critiques
- génération de rapport technique

---

# Module 3 — Finance & Growth

## Objectif
Suivre les revenus et métriques de croissance du SaaS client.

## Sous-onglets
- Revenue
- MRR Movement
- Subscriptions
- Customers
- Cohorts
- Forecasting
- Investor Metrics
- Reports

## Connecteur MVP
- Stripe

## Fonctionnement
1. L'utilisateur connecte Stripe via une clé API restricted read-only.
2. Le système vérifie la clé.
3. Une synchronisation initiale récupère : customers, subscriptions, invoices, charges, refunds.
4. Les données sont normalisées dans Supabase.
5. Les métriques sont recalculées quotidiennement.
6. Des webhooks Stripe peuvent mettre à jour certaines données en temps réel.

## Métriques à calculer
- MRR
- ARR
- New MRR
- Expansion MRR
- Contraction MRR
- Churned MRR
- Net MRR Movement
- Churn rate
- ARPU
- LTV
- Revenue total
- Refunds
- Active subscriptions
- Trial conversion rate
- Failed payments

## Tables principales
- `stripe_connections`
- `customers`
- `subscriptions`
- `invoices`
- `revenue_records`
- `metrics_snapshots`

---

# Module 4 — Costs & Infra

## Objectif
Suivre les dépenses techniques du SaaS.

## Sous-onglets
- Cost Overview
- By Provider
- By Environment
- LLM Costs
- Cost per User
- Optimization
- Budgets
- Invoices

## Connecteurs MVP
- Vercel
- Supabase
- Groq
- DeepSeek
- OpenAI optionnel

## Fonctionnement
1. Le scan de code détecte les fournisseurs utilisés.
2. Le SaaS propose les connecteurs pertinents.
3. L'utilisateur ajoute les credentials.
4. Les coûts sont récupérés par API quand disponible.
5. Si l'API fournisseur ne donne pas les coûts, l'utilisateur peut saisir manuellement une dépense.
6. Le système attribue les coûts par provider, projet, environnement et période.

## Métriques
- coût total mensuel
- coût par fournisseur
- coût par projet
- coût par utilisateur actif
- coût LLM par modèle
- coût LLM par feature
- évolution mensuelle
- alerte dépassement budget
- marge brute estimée

## Optimisation IA
L'IA doit générer :
- suggestions d'économie
- détection de dépenses anormales
- alternatives techniques
- recommandations de downgrade ou upgrade
- détection de surconsommation LLM

---

# Module 5 — Users & Engagement

## Objectif
Visualiser et gérer les utilisateurs finaux du SaaS client.

## Sous-onglets
- All Users
- User 360
- Segments
- Active Users
- Engagement
- Health Scores
- Churn Risk
- Funnels

## Sources possibles
- Supabase Auth
- base de données projet
- PostHog
- Stripe customers

## Fonctionnement MVP
Pour le MVP, on peut commencer avec :
- import depuis Stripe customers
- import depuis Supabase Auth si connecté
- segmentation simple

## Données affichées
- email
- date de création
- plan actif
- revenu généré
- statut abonnement
- dernière activité
- nombre d'événements
- score de santé

## Actions possibles
- rechercher un utilisateur
- filtrer par plan
- filtrer par risque churn
- ouvrir fiche 360
- déclencher email
- ban / unban si Supabase Auth connecté

---

# Module 6 — Dependencies & Security Watch

## Objectif
Surveiller les dépendances, versions, CVE, licences et risques.

## Sous-onglets
- Dependencies
- Outdated Packages
- CVE Alerts
- License Audit
- Deprecated Services
- Upgrade Suggestions
- Security Score

## Fonctionnement
1. Les dépendances sont extraites du scan.
2. Chaque package est comparé aux registres publics : npm, PyPI, etc.
3. Les versions obsolètes sont détectées.
4. Les CVE sont associées aux packages.
5. Le système génère un score de santé.
6. DeepSeek peut expliquer le risque dans le contexte du repo.

## Score de santé
Score sur 100 basé sur :
- nombre de CVE critiques
- âge des dépendances
- nombre de packages non maintenus
- présence de secrets suspects
- complexité du stack
- couverture de fichiers de config sécurité

---

# Module 7 — Health & Monitoring

## Objectif
Surveiller la santé technique du SaaS.

## Sous-onglets
- Status
- Uptime
- Errors
- Performance
- Deployments
- Database
- Incidents
- Status Page

## MVP
- Uptime check simple par URL
- statut vert/orange/rouge
- historique de disponibilité
- alertes email

## V2
- Sentry connector
- Vercel deployments
- Supabase database health
- latence p95
- corrélation incident / déploiement

---

# Module 8 — Actions & Admin

## Objectif
Permettre d'agir directement depuis le cockpit.

## Sous-onglets
- Quick Actions
- User Management
- Stripe Operations
- Database Console
- Email Sender
- Webhooks
- Jobs
- Runbooks
- Audit Log
- Approval Queue

## Actions MVP
- Refund Stripe
- Cancel subscription
- Update subscription plan
- Create coupon
- Ban user Supabase
- Reset user password
- Send transactional email

## Règles de sécurité
- Toutes les actions doivent être loggées.
- Les actions financières nécessitent confirmation.
- Les actions destructrices nécessitent double confirmation.
- Les actions bulk doivent afficher un aperçu avant exécution.
- Les actions peuvent être désactivées si le connecteur est read-only.

## Table `admin_actions`
Champs :
- id
- workspace_id
- project_id
- actor_user_id
- connector_id
- action_type
- target_type
- target_id
- payload
- status
- risk_level
- requires_approval
- approved_by
- executed_at
- created_at

---

# Module 9 — AI Agent

## Objectif
Fournir un agent IA contextuel capable d'analyser le SaaS et d'aider le fondateur.

## Sous-onglets
- Chat
- Insights
- Reports
- Workflows
- Prompt Templates
- Memory
- Guardrails
- Action History

## Fonctionnalités IA
- poser des questions sur les métriques
- expliquer une hausse de coûts
- analyser un scan de code
- générer un rapport mensuel
- recommander des optimisations
- écrire des requêtes SQL read-only
- préparer une action admin mais demander validation
- générer des emails aux utilisateurs
- résumer les incidents

## Modèle de routing IA
### Groq Cloud
Utilisation par défaut pour :
- chat rapide
- résumé simple
- classification
- extraction JSON
- recommandations simples

### DeepSeek
Utilisation pour :
- analyse de code
- audit technique
- raisonnement sur architecture
- détection de faille logique
- refactoring suggestions

## Guardrails
L'agent ne doit jamais :
- exécuter une action sans validation explicite
- afficher un secret complet
- écrire directement dans une base client sans confirmation
- supprimer des données sans double confirmation
- envoyer une campagne email sans aperçu

---

# Module 10 — Integrations

## Objectif
Gérer les services connectés.

## Sous-onglets
- Connected
- Catalog
- Credentials Vault
- API Keys
- Webhooks Out
- n8n / Make / Zapier
- MCP Servers

## Connecteurs MVP
- GitHub
- Stripe
- Supabase
- Vercel
- Groq
- DeepSeek
- PostHog
- Resend

## Statuts connecteur
- detected
- not_connected
- connected
- invalid_credentials
- read_only
- write_enabled
- needs_attention

---

# Module 11 — Settings

## Sous-onglets
- Profile
- Workspace
- Projects
- Team & Permissions
- Billing
- Notifications
- Security
- Data & Privacy
- API Access
- Audit & Compliance

## Fonctionnalités
- gérer workspace
- gérer projets
- inviter membres
- attribuer rôles
- gérer abonnement Stripe
- activer 2FA
- exporter données
- supprimer workspace
- consulter audit log

---

## 6. Navigation finale sidebar Pattern C

### Modules colonne 1
1. Overview
2. Finance
3. Costs
4. Users
5. Code
6. Security
7. Health
8. Actions
9. AI Agent
10. Integrations
11. Settings

### Sous-onglets colonne 2

#### Overview
- Dashboard
- Alerts
- Daily Briefing
- Activity Feed
- Multi-projects

#### Finance
- Revenue
- MRR Movement
- Subscriptions
- Customers
- Cohorts
- Forecasting
- Investor Metrics
- Reports

#### Costs
- Overview
- Providers
- LLM Costs
- Cost per User
- Budgets
- Optimization
- Invoices

#### Users
- All Users
- Segments
- User 360
- Engagement
- Health Scores
- Churn Risk
- Funnels

#### Code
- Repositories
- Scan Results
- Architecture Map
- Dependencies
- API Usage
- Database Schema
- Tech Debt

#### Security
- CVE Alerts
- Secrets Detection
- License Audit
- Compliance Watch
- Risk Score

#### Health
- Status
- Uptime
- Errors
- Performance
- Deployments
- Incidents

#### Actions
- Quick Actions
- User Management
- Stripe Operations
- Database Console
- Email Sender
- Webhooks
- Runbooks
- Audit Log

#### AI Agent
- Chat
- Insights
- Reports
- Workflows
- Prompt Templates
- Guardrails

#### Integrations
- Connected
- Catalog
- Credentials Vault
- API Keys
- Webhooks
- n8n / Make / Zapier

#### Settings
- Profile
- Workspace
- Projects
- Team
- Billing
- Notifications
- Security
- Data & Privacy

---

## 7. Schéma Supabase proposé

## Tables core

### `profiles`
```sql
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz default now()
);
```

### `workspaces`
```sql
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  owner_id uuid references auth.users(id),
  plan text default 'free',
  created_at timestamptz default now()
);
```

### `workspace_members`
```sql
create table workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz default now(),
  unique(workspace_id, user_id)
);
```

### `projects`
```sql
create table projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  website_url text,
  detected_stack jsonb default '{}',
  health_score int default 0,
  created_at timestamptz default now(),
  unique(workspace_id, slug)
);
```

### `repositories`
```sql
create table repositories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  provider text not null,
  external_id text,
  name text not null,
  full_name text,
  default_branch text,
  private boolean default true,
  last_scanned_at timestamptz,
  created_at timestamptz default now()
);
```

### `scan_jobs`
```sql
create table scan_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  repository_id uuid references repositories(id) on delete cascade,
  status text default 'pending',
  started_at timestamptz,
  finished_at timestamptz,
  error_message text,
  created_at timestamptz default now()
);
```

### `scan_results`
```sql
create table scan_results (
  id uuid primary key default gen_random_uuid(),
  scan_job_id uuid references scan_jobs(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  repository_id uuid references repositories(id) on delete cascade,
  summary jsonb default '{}',
  dependencies jsonb default '[]',
  env_vars jsonb default '[]',
  services jsonb default '[]',
  architecture jsonb default '{}',
  security_findings jsonb default '[]',
  ai_analysis jsonb default '{}',
  created_at timestamptz default now()
);
```

### `connectors`
```sql
create table connectors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  provider text not null,
  status text default 'not_connected',
  permissions text default 'read_only',
  metadata jsonb default '{}',
  created_at timestamptz default now()
);
```

### `encrypted_credentials`
```sql
create table encrypted_credentials (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  connector_id uuid references connectors(id) on delete cascade,
  encrypted_payload text not null,
  iv text not null,
  key_version text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

### `metrics_snapshots`
```sql
create table metrics_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  snapshot_date date not null,
  metrics jsonb not null default '{}',
  created_at timestamptz default now(),
  unique(project_id, snapshot_date)
);
```

### `cost_records`
```sql
create table cost_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  provider text not null,
  amount numeric not null,
  currency text default 'eur',
  period_start date,
  period_end date,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);
```

### `revenue_records`
```sql
create table revenue_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  provider text default 'stripe',
  amount numeric not null,
  currency text default 'eur',
  type text,
  occurred_at timestamptz,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);
```

### `alerts`
```sql
create table alerts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  type text not null,
  severity text not null,
  title text not null,
  message text,
  status text default 'open',
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  resolved_at timestamptz
);
```

### `ai_conversations`
```sql
create table ai_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  user_id uuid references auth.users(id),
  title text,
  created_at timestamptz default now()
);
```

### `ai_messages`
```sql
create table ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references ai_conversations(id) on delete cascade,
  role text not null,
  content text not null,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);
```

### `activity_logs`
```sql
create table activity_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  actor_user_id uuid references auth.users(id),
  event_type text not null,
  title text,
  payload jsonb default '{}',
  created_at timestamptz default now()
);
```

---

## 8. RLS Supabase

Toutes les tables liées à `workspace_id` doivent avoir RLS activé.

Principe : un utilisateur peut lire une donnée seulement s'il est membre du workspace.

Exemple :

```sql
create policy "Workspace members can read projects"
on projects for select
using (
  exists (
    select 1 from workspace_members wm
    where wm.workspace_id = projects.workspace_id
    and wm.user_id = auth.uid()
  )
);
```

Pour les mutations :
- owner et admin peuvent tout faire
- member peut lire et créer certains objets
- viewer read-only

---

## 9. Edge Functions Supabase

## Fonctions nécessaires MVP

### `github-oauth-callback`
Gère le callback OAuth GitHub.

### `github-list-repos`
Liste les repositories disponibles.

### `start-repo-scan`
Crée un job de scan.

### `process-repo-scan`
Exécute le scan réel.

### `ai-code-analysis`
Appelle DeepSeek pour analyser un scan.

### `ai-fast-summary`
Appelle Groq pour générer un résumé rapide.

### `connect-stripe`
Valide une clé Stripe.

### `sync-stripe-data`
Récupère les données Stripe.

### `calculate-metrics`
Calcule MRR, ARR, churn, etc.

### `sync-costs`
Synchronise les coûts des providers.

### `execute-admin-action`
Exécute une action sensible après validation.

### `ai-agent-chat`
Gère la conversation IA.

---

## 10. Frontend React

## Structure recommandée

```txt
src/
  app/
    App.tsx
    router.tsx
  components/
    layout/
      AppShell.tsx
      PrimarySidebar.tsx
      SecondarySidebar.tsx
      Topbar.tsx
    ui/
    charts/
    tables/
    cards/
  features/
    overview/
    finance/
    costs/
    users/
    code/
    security/
    health/
    actions/
    ai-agent/
    integrations/
    settings/
  lib/
    supabase.ts
    routes.ts
    navigation.ts
    permissions.ts
    formatters.ts
  hooks/
    useWorkspace.ts
    useProject.ts
    useAuth.ts
    useRealtimeAlerts.ts
  types/
    database.types.ts
    navigation.ts
```

## Routes principales

```txt
/login
/onboarding
/app/:workspaceSlug/:projectSlug/overview
/app/:workspaceSlug/:projectSlug/finance/revenue
/app/:workspaceSlug/:projectSlug/finance/mrr-movement
/app/:workspaceSlug/:projectSlug/costs/overview
/app/:workspaceSlug/:projectSlug/code/repositories
/app/:workspaceSlug/:projectSlug/code/scan-results
/app/:workspaceSlug/:projectSlug/actions/quick-actions
/app/:workspaceSlug/:projectSlug/ai/chat
/app/:workspaceSlug/:projectSlug/integrations/catalog
/app/:workspaceSlug/:projectSlug/settings/workspace
```

## Composants clés

### `AppShell`
Responsable du layout global.

### `PrimarySidebar`
Affiche les icônes des modules.

### `SecondarySidebar`
Affiche les sous-onglets du module actif.

### `CommandMenu`
Palette globale Cmd+K.

### `MetricCard`
Carte KPI réutilisable.

### `ConnectorCard`
Carte connecteur.

### `ScanStatusCard`
Carte d'état de scan.

### `AdminActionModal`
Modal de confirmation d'action sensible.

---

## 11. Design system

## Style
- Interface sombre par défaut
- Look développeur premium
- Densité élevée mais lisible
- Cards arrondies `rounded-2xl`
- Soft shadows
- Graphs clairs
- Icônes lucide-react

## Couleurs proposées
- Background : zinc / slate très sombre
- Surface : zinc-900 / slate-900
- Border : zinc-800
- Texte : zinc-100 / zinc-400
- Accent : violet, blue ou emerald
- Danger : red
- Warning : amber
- Success : emerald

## Composants shadcn/ui
- Button
- Card
- Badge
- Tabs
- Dialog
- Sheet
- DropdownMenu
- Command
- Table
- Tooltip
- ScrollArea
- Separator
- Input
- Select
- Skeleton
- Alert

---

## 12. Onboarding utilisateur

## Étape 1 — Signup
- Auth via GitHub ou email.
- Création automatique d'un workspace.

## Étape 2 — Connexion GitHub
- OAuth GitHub.
- Demander permission read-only sur les repositories.

## Étape 3 — Sélection repo
- L'utilisateur choisit un repo.
- Création du projet si aucun projet existant.

## Étape 4 — Scan automatique
- Lancement du scan.
- Affichage progression :
  - fetch repo
  - parse manifests
  - detect services
  - analyze env vars
  - AI analysis
  - generate dashboard

## Étape 5 — Connecteurs suggérés
Après scan, afficher :
- Stripe détecté → connecter Stripe
- Supabase détecté → connecter Supabase
- Vercel détecté → connecter Vercel
- Groq détecté → connecter Groq

## Étape 6 — Dashboard généré
Redirection vers Overview avec :
- Stack détecté
- connecteurs manquants
- premières métriques
- recommandations IA

---

## 13. Fonctionnement IA détaillé

## 13.1 Router IA

Créer une fonction `routeAIRequest(taskType)`.

### Groq pour :
- summary
- classification
- json extraction
- chat simple
- daily briefing
- alert explanation

### DeepSeek pour :
- code analysis
- architecture reasoning
- security review
- dependency risk explanation
- refactor suggestions
- SQL generation review

## 13.2 Prompt système AI Agent

```txt
Tu es l'agent admin technique d'un SaaS code-aware.
Tu aides un fondateur ou développeur à comprendre son produit, ses métriques, ses coûts, ses risques et ses actions possibles.
Tu peux analyser les données fournies, mais tu ne dois jamais inventer de métriques absentes.
Tu ne dois jamais exécuter d'action sans validation explicite.
Tu dois signaler les risques de sécurité, coûts anormaux, dépendances critiques et opportunités de croissance.
Réponds de manière concise, technique et actionnable.
```

## 13.3 Format des insights IA

```json
{
  "title": "Groq usage increased by 42%",
  "severity": "warning",
  "category": "costs",
  "explanation": "Your LLM usage increased mainly due to the /api/chat endpoint.",
  "recommendations": [
    "Add response caching for repeated prompts",
    "Route simple classification tasks to a smaller model",
    "Set a monthly budget alert"
  ],
  "estimated_savings": 38.5
}
```

---

## 14. Sécurité

## Obligatoire MVP
- Supabase RLS sur toutes les tables.
- Credentials chiffrés avant stockage.
- Ne jamais logger de secrets.
- Masquer les secrets dans l'UI.
- OAuth GitHub avec scopes minimaux.
- Stripe restricted keys recommandées.
- Audit log pour chaque action.
- Double confirmation pour action destructive.
- Rate limiting sur Edge Functions.
- Validation Zod sur toutes les entrées.

## Gestion credentials
Pour le MVP, chiffrer côté Edge Function avec Web Crypto API.

Variables nécessaires :
- `CREDENTIAL_ENCRYPTION_KEY`
- `GROQ_API_KEY`
- `DEEPSEEK_API_KEY`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `STRIPE_SECRET_KEY`

---

## 15. Plans et pricing

## Free
- 1 workspace
- 1 projet
- 1 repo
- 1 scan manuel
- overview basique

## Starter — 29 €/mois
- 1 workspace
- 2 projets
- 3 repos
- scans hebdomadaires
- Stripe + GitHub + Supabase
- dashboards basiques

## Pro — 99 €/mois
- 5 projets
- 15 repos
- scans automatiques
- AI Agent
- actions admin
- coûts LLM
- reports

## Team — 299 €/mois
- utilisateurs équipe
- rôles
- audit log avancé
- runbooks
- connecteurs avancés
- approval queue

## Enterprise — custom
- SSO
- SCIM
- BYOK
- hébergement dédié
- SLA
- conformité avancée

---

## 16. MVP à construire en premier

## Sprint 1 — Base produit
- Setup Vite + React + TypeScript
- Setup Tailwind + shadcn/ui
- Setup Supabase Auth
- Tables workspaces / projects / members
- Layout Pattern C
- Routing app

## Sprint 2 — GitHub + scan
- OAuth GitHub
- Liste repositories
- Sélection repo
- Scan manifest files
- Détection dépendances
- Résultat scan simple

## Sprint 3 — IA code analysis
- Intégration DeepSeek
- Intégration Groq
- Résumé de scan
- Recommandations IA
- Score technique

## Sprint 4 — Connecteurs
- Catalog connecteurs
- Credentials Vault
- Connexion Stripe
- Connexion Supabase manuelle
- Connexion Vercel manuelle

## Sprint 5 — Finance
- Sync Stripe
- Calcul MRR / ARR
- Dashboard Revenue
- Customers / Subscriptions

## Sprint 6 — Costs
- Saisie coûts manuels
- Sync Vercel si possible
- LLM costs tracking
- Cost overview
- Optimization IA simple

## Sprint 7 — AI Agent
- Chat IA contextuel
- accès aux métriques projet
- génération insights
- reports simples

## Sprint 8 — Actions Admin
- Quick actions UI
- Stripe refund
- Cancel subscription
- Audit log
- Confirmation modals

---

## 17. Prompts Claude Code recommandés

## Prompt 1 — Générer le socle frontend
```txt
Build a Vite + React + TypeScript SaaS frontend using TailwindCSS and shadcn/ui.
Implement a two-column Pattern C sidebar layout.
Primary sidebar contains module icons only.
Secondary sidebar shows sub-navigation for the selected module.
Use React Router.
Create placeholder pages for Overview, Finance, Costs, Users, Code, Security, Health, Actions, AI Agent, Integrations, Settings.
Use lucide-react icons.
Make the UI dark, premium, developer-focused.
```

## Prompt 2 — Générer le schéma Supabase
```txt
Create Supabase SQL migrations for a multi-tenant SaaS.
Tables: profiles, workspaces, workspace_members, projects, repositories, scan_jobs, scan_results, connectors, encrypted_credentials, metrics_snapshots, cost_records, revenue_records, alerts, ai_conversations, ai_messages, admin_actions, activity_logs.
Enable RLS on all workspace-scoped tables.
Add policies allowing workspace members to read data and workspace admins to mutate data.
```

## Prompt 3 — Générer le scanner GitHub MVP
```txt
Create Supabase Edge Functions for GitHub repository scanning.
The function receives repository_id and workspace_id.
It fetches repository files from GitHub API, detects package.json, requirements.txt, Dockerfile, vercel.json, supabase/config.toml, .env.example and migration files.
It extracts dependencies, environment variables, detected services and framework.
It stores the output in scan_results as JSONB.
Never execute user code.
```

## Prompt 4 — Intégrer Groq et DeepSeek
```txt
Implement an AI routing service in Supabase Edge Functions.
Use Groq Cloud for fast summarization and classification.
Use DeepSeek for deep code analysis and security review.
Create functions ai-fast-summary and ai-code-analysis.
Both must return strict JSON.
Add error handling, retries and token usage logging.
```

## Prompt 5 — Générer le dashboard finance
```txt
Build the Finance module in React.
Create pages Revenue, MRR Movement, Customers, Subscriptions, Forecasting and Reports.
Use Supabase data from revenue_records and metrics_snapshots.
Show KPI cards, charts and tables.
Create empty states when Stripe is not connected.
```

---

## 18. Définition du succès MVP

Le MVP est réussi si un utilisateur peut :
1. créer un compte ;
2. créer un workspace ;
3. connecter GitHub ;
4. sélectionner un repo ;
5. lancer un scan ;
6. voir son stack détecté ;
7. recevoir une analyse IA ;
8. connecter Stripe ;
9. voir son MRR ;
10. voir ses coûts saisis ou synchronisés ;
11. utiliser le chat IA pour poser une question ;
12. exécuter au moins une action admin simple avec audit log.

---

## 19. Roadmap V2

- GitLab connector
- Bitbucket connector
- scan AST avancé
- détection secrets
- CVE database
- PostHog connector
- Sentry connector
- Vercel deployments
- Supabase Management API avancée
- runbooks automatisés
- dashboard canvas drag-and-drop
- reports PDF
- n8n connector
- MCP server

---

## 20. Roadmap V3

- Marketplace connecteurs
- marketplace templates dashboards
- white-label agences
- SSO / SCIM
- BYOK
- SOC 2
- ISO 27001
- agent IA autonome avec approval flow
- database console avancée
- auto-PR dépendances
- code health benchmark

---

## 21. Règle produit importante

Ne pas construire un outil généraliste.
Le SaaS doit rester un produit de niche pour développeurs de SaaS :
- code-aware
- repo-first
- dashboard généré automatiquement
- métriques SaaS
- coûts infra / LLM
- actions admin
- agent IA technique

Ce positionnement est le différenciateur principal.

