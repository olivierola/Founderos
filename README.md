# FounderOS

SaaS Cockpit code-aware pour développeurs SaaS, indie hackers et fondateurs.
Connecte ton repo, on comprend ton SaaS, on génère ton cockpit d'administration.

## Stack

- Frontend : Vite + React + TypeScript
- UI : TailwindCSS + shadcn/ui + lucide-react
- Backend : Supabase (Postgres, Auth, Storage, Edge Functions, Realtime)
- IA : Groq Cloud (rapide) + DeepSeek (analyse profonde)
- Paiement : Stripe
- Repo provider MVP : GitHub

## Démarrage rapide

```bash
# 1. Installer les dépendances
npm install

# 2. Configurer Supabase
cp .env.example .env
# puis remplir VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY

# 3. Appliquer les migrations
# (depuis le Studio Supabase ou via supabase db push)
# Voir supabase/migrations/0001_init_core.sql

# 4. Lancer le dev server
npm run dev
```

L'app tourne sur http://localhost:5173.

## Structure

```
src/
  app/              # Router + ProtectedRoute
  components/
    layout/         # AppShell, PrimarySidebar, SecondarySidebar, Topbar
    ui/             # button, card, badge, input, separator, tooltip
  features/
    auth/           # Login + Onboarding
    overview/       # Dashboard Overview
    GenericSubPage  # Placeholder réutilisable pour les sous-onglets restants
  lib/
    supabase.ts     # client Supabase
    auth-context.tsx
    navigation.ts   # config des 11 modules + sous-onglets
    utils.ts        # cn(), formatters
  styles/
    globals.css     # tokens design system dark
supabase/
  migrations/
    0001_init_core.sql  # profiles, workspaces, members, projects, repositories + RLS
```

## Pattern UX — Pattern C

Sidebar à deux colonnes :
- Colonne 1 (64px) : icônes des modules
- Colonne 2 (220px) : sous-navigation contextuelle du module actif

## Sprint 1 — état actuel

Sprint 1 complet :
- Vite + React + TS + Tailwind + shadcn/ui de base
- Layout Pattern C complet
- Supabase client + AuthProvider + ProtectedRoute
- Routing pour 11 modules × N sous-onglets
- Page Login (GitHub OAuth + magic link)
- Page Onboarding
- Dashboard Overview riche
- Migrations SQL : profiles, workspaces, workspace_members, projects, repositories avec RLS
- Trigger auto-création workspace/profil à l'inscription

## Prochains sprints

- Sprint 2 : OAuth GitHub + scan repo + Edge Function `process-repo-scan`
- Sprint 3 : Intégration Groq + DeepSeek
- Sprint 4 : Connecteurs + Credentials Vault
- Sprint 5 : Sync Stripe + métriques Finance
- Sprint 6 : Costs + LLM tracking
- Sprint 7 : AI Agent chat
- Sprint 8 : Actions admin + audit log
