import { createBrowserRouter, Navigate, useParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { MODULE_PROJECT_CONFIGS } from "@/lib/module-project-config";
import { ModuleProjectList } from "@/features/module-projects/ModuleProjectList";
import { ModuleProjectDetail } from "@/features/module-projects/ModuleProjectDetail";
import { AiHqDashboard } from "@/features/dashboard/AiHqDashboard";
import { CompanyContextPage } from "@/features/company/CompanyContextPage";
import { CompanyObjectivesPage } from "@/features/company/CompanyObjectivesPage";
import { CompanyGraphPage } from "@/features/company/CompanyGraphPage";
import { CompanyRoiPage } from "@/features/company/CompanyRoiPage";
import { ProtectedRoute } from "./ProtectedRoute";
import { PlaneLanding } from "./PlaneLanding";
import { LoginPage } from "@/features/auth/Login";
import { SignupPage } from "@/features/auth/Signup";
import { OnboardingPage as AuthOnboardingPage } from "@/features/auth/Onboarding";
import { AcceptInvitePage } from "@/features/auth/AcceptInvite";
import { OrganisationsPage } from "@/features/orgs/Organisations";
import { ProjectsPage } from "@/features/orgs/Projects";

// Overview (merged into Admin panel — kept tabs only)
import { AlertsPage } from "@/features/overview/Alerts";
import { CustomDashboardsPage } from "@/features/overview/dashboards/CustomDashboards";
import { DashboardBuilderPage } from "@/features/overview/dashboards/DashboardBuilder";

import { PublicAgentRedirect } from "@/features/agent-rag/PublicAgentRedirect";
import { AgentsPage } from "@/features/agent-rag/Agents";
// The "Agentic Onboarding" module was removed — onboarding is now a public
// agent with a conditional Onboarding tab in the RAG builder. Old /onboarding/*
// deep links redirect to the public agents list (see the app children below).
import { RagCenterPage, RagCollectionDetailPage } from "@/features/rag-center/RagCenter";
import { KnowledgeCollectionsPage } from "@/features/rag-center/KnowledgeCollections";
import { SkillsLibraryPage } from "@/features/internal-agents/InternalAgentDetail";
import {
  InternalAgentRedirect, InternalAgentsIndexRedirect,
} from "@/features/internal-agents/AgentRouteRedirects";
import { SkillEditorPage } from "@/features/internal-agents/SkillEditor";
import { SkillRecorderPage } from "@/features/internal-agents/SkillRecorder";
import { TrainingPage } from "@/features/training/TrainingPage";
import { McpServersPage, McpOAuthCallbackPage } from "@/features/internal-agents/McpServers";
import { AgentEcosystemPage } from "@/features/internal-agents/AgentEcosystem";
import { AgentTasksPage } from "@/features/internal-agents/TasksPage";
import { OpsOverviewPage } from "@/features/ops/OverviewPage";
import { OpsServersPage } from "@/features/ops/ServersPage";
import { OpsServerDetailPage } from "@/features/ops/ServerDetailPage";
import { OpsWorkflowsPage } from "@/features/ops/WorkflowsPage";
import { OpsBundleDetailPage } from "@/features/ops/BundleDetailPage";
import { OpsInfraProjectDetailPage } from "@/features/ops/InfraProjectDetailPage";
import { OpsChecksPage } from "@/features/ops/ChecksPage";
import { TestRunsPage } from "@/features/ops/TestingWorkspace";
import { RepositoriesPage } from "@/features/ops/Repositories";
import { RepoDetailPage } from "@/features/ops/RepoDetail";
import { VibeCodePage } from "@/features/ops/VibeCode";
import { OpsTestRunPage } from "@/features/ops/TestRunPage";
import { OpsJobsPage } from "@/features/ops/JobsPage";
import { OpsSettingsPage } from "@/features/ops/SettingsPage";

// CRM
import { CrmWorkspacePage } from "@/features/crm/CrmWorkspace";
import { CrmOverviewPage } from "@/features/crm/overview/CrmOverview";
import { RecordViewPage } from "@/features/crm/RecordView";
// Support module deleted (2026-07-17) — only the public help-center portal
// survives; tickets live on as CRM records.
import { HelpCenterPage } from "@/features/support/HelpCenter";
import { PublicAgentStatsPage } from "@/features/agent-rag/PublicAgentStats";
import { PmSimulationsPage } from "@/features/pm/PmSimulations";

// Agent artifacts — the Office (Bureautique) module was deleted (2026-08-10):
// agents produce documents/spreadsheets/presentations themselves via
// create_artifact, so only the EDITORS survive, as the surface a human opens
// an artifact in (from a room's Artifacts tab or a CRM record). They are
// lazy-loaded — the Plate document editor pulls a large dependency graph
// (media, tables, AI…), so we keep it out of the initial bundle.
import { Suspense, lazy } from "react";
import { Skeleton } from "@/components/ui/skeleton";
const DocumentEditorPage = lazy(() =>
  import("@/features/artifacts/DocumentEditor").then((m) => ({ default: m.DocumentEditorPage })));
const SpreadsheetEditorPage = lazy(() =>
  import("@/features/artifacts/SpreadsheetEditor").then((m) => ({ default: m.SpreadsheetEditorPage })));
const PresentationEditorPage = lazy(() =>
  import("@/features/artifacts/PresentationEditor").then((m) => ({ default: m.PresentationEditorPage })));

function ArtifactEditorFallback() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Skeleton className="h-8 w-8 rounded-lg" />
        <Skeleton className="h-6 w-40" />
        <div className="ml-auto flex gap-2"><Skeleton className="h-8 w-16 rounded-full" /><Skeleton className="h-8 w-16 rounded-full" /></div>
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-4 p-8">
        <Skeleton className="h-9 w-2/3" />
        <div className="space-y-2.5 pt-2">
          <Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-11/12" /><Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-3/4" />
        </div>
      </div>
    </div>
  );
}

// Integrations — folded into the Admin dashboard's single "Connecteurs" tab,
// now backed by Composio (composio.dev). The in-house Catalog/ConnectorDialog/
// providers.ts path stays in the repo, untouched, simply unlinked from here.
import { ComposioCatalog } from "@/features/integrations/ComposioCatalog";

// Settings pages — reused as tabs of the Admin dashboard.
import { SettingsWorkspacePage } from "@/features/settings/Workspace";
import { SettingsProjectsPage } from "@/features/settings/Extra";
import { MembersPage } from "@/features/settings/MembersPage";
import { SettingsRolesPage } from "@/features/settings/Roles";
import { SettingsBillingPage } from "@/features/settings/Billing";
import { SubscribeRedirectPage } from "@/features/settings/SubscribeRedirect";
import { SettingsSecurityPage } from "@/features/settings/Security2FA";

// Admin dashboard (single-sidebar) — new page(s) + the mapping of its tabs to
// the existing settings/integrations/governance page components.
import { AdminSubscriptionPage } from "@/features/admin/AdminExtras";
import { AdminUsagePage } from "@/features/admin/AdminUsage";
import { BillingSuccessPage } from "@/features/settings/BillingSuccess";
import { ADMIN_ITEMS, ADMIN_LANDING } from "@/lib/admin-navigation";

import { GenericSubPage } from "@/features/GenericSubPage";
import { MODULES, HIDDEN_MODULES } from "@/lib/navigation";

// Governance
import { GovernanceDashboard } from "@/features/governance/Dashboard";
import { GovRegistryPage } from "@/features/governance/Registry";
import { GovRisksPage } from "@/features/governance/RiskRegister";
import { GovPoliciesPage } from "@/features/governance/Policies";
import { GovControlsPage } from "@/features/governance/Controls";
import { GovApprovalsPage } from "@/features/governance/Approvals";
import { AdminActionsQueuePage } from "@/features/governance/AdminActionsQueue";
import { PentestScopePage } from "@/features/governance/PentestScope";
import { ServiceDashboardPage } from "@/features/service-dashboards/ServiceDashboardShell";
import { GovIncidentsPage } from "@/features/governance/Incidents";
import { GovDataAssetsPage } from "@/features/governance/DataAssets";
import { GovAuditPage } from "@/features/governance/AuditTrail";
// AI Ops & Governance — onglet "AI Governance"
import { GovGuardrailsPage } from "@/features/governance/aiops/Guardrails";
import { GovAccessLogsPage } from "@/features/governance/aiops/AccessLogs";
import { GovPromptMonitoringPage } from "@/features/governance/aiops/PromptMonitoring";
import { GovCostsPage } from "@/features/governance/aiops/Costs";
import { GovOpsIncidentsPage } from "@/features/governance/aiops/OpsIncidents";
// AI Ops & Governance — onglet "Ops"
import { GovOpsServersPage } from "@/features/governance/aiops/OpsServers";
import { GovOpsLivePage } from "@/features/governance/aiops/OpsLive";
import { GovOpsInfraIncidentsPage } from "@/features/governance/aiops/OpsInfraIncidents";
import { GovOpsFinetuningPage } from "@/features/governance/aiops/OpsFinetuning";
import { GovOpsModelsPage } from "@/features/governance/aiops/OpsModels";
// AI Ops & Governance — onglet "Fine-tuning Studio"
import { GovFtOverviewPage } from "@/features/governance/aiops/FtOverview";
import { GovFtDatasetsPage } from "@/features/governance/aiops/FtDatasets";
import { GovFtDataPrepPage } from "@/features/governance/aiops/FtDataPrep";
import { GovFtLabelingPage } from "@/features/governance/aiops/FtLabeling";
import { GovFtExperimentsPage } from "@/features/governance/aiops/FtExperiments";
import { GovFtEvaluationPage } from "@/features/governance/aiops/FtEvaluation";
import { GovFtPromptTestsPage } from "@/features/governance/aiops/FtPromptTests";
import { GovFtVersionsPage } from "@/features/governance/aiops/FtVersions";
import { GovFtDeploymentPage } from "@/features/governance/aiops/FtDeployment";
import { GovFtMonitoringPage } from "@/features/governance/aiops/FtMonitoring";
import { GovFtCostsPage } from "@/features/governance/aiops/FtCosts";
import { GovFtSecurityPage } from "@/features/governance/aiops/FtSecurity";
import { GovFtSettingsPage } from "@/features/governance/aiops/FtSettings";

// Marketing site
import { HomePage } from "@/features/marketing-site/HomePage";
import {
  IntegrationsPage,
  ChangelogPage,
  DocsPage,
} from "@/features/marketing-site/OtherPages";
import { ContactPage } from "@/features/marketing-site/ContactPage";
// Ces pages partagent le chrome de la landing (sa navbar, son hero animé, son
// footer sombre) au lieu du MarketingShell hérité — d'où leurs fichiers séparés.
import { PricingPage } from "@/features/marketing-site/PricingPage";
import { SolutionsPage } from "@/features/marketing-site/SolutionsPage";
import { SolutionPage } from "@/features/marketing-site/SolutionPage";
import { BlogPage } from "@/features/marketing-site/BlogPage";
import { BlogPostPage } from "@/features/marketing-site/BlogPostPage";
import { FaqPage } from "@/features/marketing-site/FaqPage";

type PageEl = import("react").ReactElement;

const PAGES: Record<string, PageEl> = {
  // AI HQ dashboard
  "hq/dashboard": <AiHqDashboard />,

  // La couche Entreprise (0212 → 0215) : ce que l'entreprise EST, ce qu'elle
  // doit accomplir, sa carte, et ce que la workforce lui rapporte. Le même
  // contexte alimente le prompt système de chaque agent.
  "company/context": <CompanyContextPage />,
  "company/objectives": <CompanyObjectivesPage />,
  "company/graph": <CompanyGraphPage />,
  "company/roi": <CompanyRoiPage />,

  // The internal-agent list & detail pages are gone from the main dashboard —
  // agents are worked with in their service dashboard. Old URLs resolve there.
  "agent/internal-agents": <InternalAgentsIndexRedirect />,
  "agent/agents": <AgentsPage />,
  "agent/ecosystem": <AgentEcosystemPage />,
  "agent/tasks": <AgentTasksPage />,
  "agent/knowledge": <RagCenterPage />,
  "agent/collections": <KnowledgeCollectionsPage />,
  "agent/skills": <SkillsLibraryPage />,
  // Les parcours qui apprennent un outil à un nouvel arrivant — guidés dans
  // l'outil par l'extension (migration 0218), à partir des skills démontrées.
  "agent/training": <TrainingPage />,
  "agent/mcp": <McpServersPage />,
  // Connecteurs is a TAB OF A SERVICE DASHBOARD (see ServiceDashboardShell) —
  // a connection belongs to one dashboard, or to one person inside it (0177).
  // This page stays routed for the legacy project-wide rows only.
  "agent/connectors": <ComposioCatalog />,

  // Ops group (infra/servers/workflows — reachable via explicit detail routes)
  "devops/ops-overview": <OpsOverviewPage />,
  "devops/servers": <OpsServersPage />,
  "devops/workflows": <OpsWorkflowsPage />,
  "devops/checks": <OpsChecksPage />,
  "devops/testing": <TestRunsPage />,
  "devops/jobs": <OpsJobsPage />,
  "devops/settings": <OpsSettingsPage />,

  // CRM (Projects, App Testing & Simulations were folded in here)
  "crm/overview": <CrmOverviewPage />,
  "crm/workspace": <CrmWorkspacePage />,
  "crm/admin-custom-dashboards": <CustomDashboardsPage />,
  "crm/admin-alerts": <AlertsPage />,

  // "Outils IA" dashboard modules.
  "repos/list": <RepositoriesPage />,
  "simulations/workspace": <PmSimulationsPage />,

  // ── AI Governance module ──
  "governance/guardrails": <GovGuardrailsPage />,
  "governance/agent-access": <GovAccessLogsPage />,
  "governance/prompts": <GovPromptMonitoringPage />,
  "governance/costs": <GovCostsPage />,
  "governance/ops-incidents": <GovOpsIncidentsPage />,
  "governance/ft-security": <GovFtSecurityPage />,
  // ── AI Ops module ──
  "aiops/ops-servers": <GovOpsServersPage />,
  "aiops/ops-live": <GovOpsLivePage />,
  "aiops/ops-infra": <GovOpsInfraIncidentsPage />,
  "aiops/ops-models": <GovOpsModelsPage />,
  "aiops/ft-deployment": <GovFtDeploymentPage />,
  "aiops/ft-monitoring": <GovFtMonitoringPage />,
  "aiops/ft-costs": <GovFtCostsPage />,
  // ── Fine-tuning Studio module ──
  "finetuning/ft-overview": <GovFtOverviewPage />,
  "finetuning/ft-datasets": <GovFtDatasetsPage />,
  "finetuning/ft-dataprep": <GovFtDataPrepPage />,
  "finetuning/ft-labeling": <GovFtLabelingPage />,
  "finetuning/ft-experiments": <GovFtExperimentsPage />,
  "finetuning/ops-finetuning": <GovOpsFinetuningPage />,
  "finetuning/ft-evaluation": <GovFtEvaluationPage />,
  "finetuning/ft-prompt-tests": <GovFtPromptTestsPage />,
  "finetuning/ft-versions": <GovFtVersionsPage />,
  "finetuning/ft-settings": <GovFtSettingsPage />,

};

/** Admin dashboard — every tab of the single-sidebar admin area maps to a page
 *  component (existing settings/integrations/governance pages, reused, plus the
 *  new subscription/usage/limits pages). Keyed by admin sub-slug. */
const ADMIN_PAGES: Record<string, PageEl> = {
  // ── Administration ──
  organisation: <SettingsWorkspacePage />,
  access: <SettingsRolesPage />,
  members: <MembersPage />,
  workspaces: <SettingsProjectsPage />,
  repositories: <RepositoriesPage />,
  security: <SettingsSecurityPage />,
  // ── Abonnements ──
  subscription: <AdminSubscriptionPage />,
  usage: <AdminUsagePage />,
  billing: <SettingsBillingPage />,
  // ── Gouvernance IA ──
  "gov-guardrails": <GovGuardrailsPage />,
  "gov-access": <GovAccessLogsPage />,
  "gov-prompts": <GovPromptMonitoringPage />,
  "gov-costs": <GovCostsPage />,
  "gov-incidents": <GovOpsIncidentsPage />,
  "gov-actions": <AdminActionsQueuePage />,
  "gov-pentest-scope": <PentestScopePage />,
};

/** Old settings/* routes → the admin dashboard tab that replaced them. Tabs that
 *  no longer exist in the admin sidebar fall back to the landing tab. */
const SETTINGS_TO_ADMIN: Record<string, string> = {
  workspace: "organisation",
  projects: "workspaces",
  team: "members",
  roles: "access",
  billing: "billing",
  security: "security",
};

/** Admin panel cockpit was merged into CRM. Redirect old /actions/* links to
 *  /app/:ws/:proj/crm/admin-* using an absolute, slug-based path (relative
 *  ../.. math across two dynamic segments is fragile and could drop to the root). */
function AdminMergeRedirect({ to }: { to: string }) {
  const { workspaceSlug, projectSlug } = useParams();
  return <Navigate to={`/app/${workspaceSlug}/${projectSlug}/crm/${to}`} replace />;
}

/** Absolute redirect to /app/:ws/:proj/<to> (slug-based, robust). */
function AbsRedirect({ to }: { to: string }) {
  const { workspaceSlug, projectSlug } = useParams();
  return <Navigate to={`/app/${workspaceSlug}/${projectSlug}/${to}`} replace />;
}

/** The Settings module moved into the Admin dashboard — remap old settings/:sub
 *  deep links to their new admin/* tab (falling back to the admin landing tab). */
function SettingsRedirect() {
  const { workspaceSlug, projectSlug, sub } = useParams();
  const target = (sub && SETTINGS_TO_ADMIN[sub]) || ADMIN_LANDING;
  return <Navigate to={`/app/${workspaceSlug}/${projectSlug}/admin/${target}`} replace />;
}

/** Absolute redirect whose suffix is built from the route params. */
function ParamRedirect({ build }: { build: (p: Record<string, string | undefined>) => string }) {
  const params = useParams();
  const { workspaceSlug, projectSlug } = params;
  return <Navigate to={`/app/${workspaceSlug}/${projectSlug}/${build(params)}`} replace />;
}

/** Ops deep links map to /devops/:sub, except the Ops overview which was renamed. */
function LegacyOpsRedirect() {
  const { sub } = useParams();
  const target = sub === "overview" ? "ops-overview" : sub;
  return <Navigate to={`../../devops/${target}`} replace />;
}
/** Ops detail pages: /ops/<kind>/:id → /devops/<kind>/:id (three segments up). */
function LegacyOpsDetailRedirect({ kind }: { kind: "servers" | "workflows" | "infra" }) {
  const { id } = useParams();
  return <Navigate to={`../../../devops/${kind}/${id}`} replace />;
}

/** Overview was merged into the Admin panel. Kept tabs map 1:1 to actions/*;
 *  dropped tabs (daily-briefing, activity-feed, multi-projects) fall back to the
 *  dashboard. */
const KEPT_OVERVIEW = new Set(["dashboard", "custom-dashboards", "alerts"]);
function LegacyOverviewRedirect() {
  const { sub } = useParams();
  const target = sub && KEPT_OVERVIEW.has(sub) ? sub : "dashboard";
  return <Navigate to={`../../actions/${target}`} replace />;
}
/** Old /overview/dashboard-builder/:id → /actions/dashboard-builder/:id (3 up). */
function LegacyBuilderRedirect() {
  const { dashboardId } = useParams();
  return <Navigate to={`../../../actions/dashboard-builder/${dashboardId}`} replace />;
}

function buildModuleRoutes() {
  // test-runs & vibe-code render via explicit :sub routes (single page instance
  // that keeps its state across onglets), so they're excluded here.
  // HIDDEN_MODULES (devops/simulations/test-runs/repos…) stay routed without appearing in
  // the nav — deep links, CRM record actions and breadcrumbs keep working.
  return [...MODULES, ...HIDDEN_MODULES].filter((m) => m.slug !== "test-runs" && m.slug !== "vibe-code").flatMap((mod) => {
    const hasProjectConfig = MODULE_PROJECT_CONFIGS[mod.slug] != null;

    const subRoutes = mod.subItems.map((sub) => {
      const key = `${mod.slug}/${sub.slug}`;
      const element = PAGES[key] ?? <GenericSubPage moduleSlug={mod.slug} subSlug={sub.slug} />;
      return { path: `${mod.slug}/${sub.slug}`, element: <ErrorBoundary>{element}</ErrorBoundary> };
    });
    return [
      {
        path: mod.slug,
        element: hasProjectConfig
          ? <ErrorBoundary><ModuleProjectList /></ErrorBoundary>
          : <Navigate to={mod.subItems[0]!.slug} replace />,
      },
      ...(hasProjectConfig ? [
        { path: `${mod.slug}/project/:moduleProjectId`, element: <ErrorBoundary><ModuleProjectDetail /></ErrorBoundary> },
        { path: `${mod.slug}/project/:moduleProjectId/:tabSlug`, element: <ErrorBoundary><ModuleProjectDetail /></ErrorBoundary> },
      ] : []),
      ...subRoutes,
    ];
  });
}

export const router = createBrowserRouter([
  // Public marketing site
  { path: "/", element: <HomePage /> },
  { path: "/solutions", element: <SolutionsPage /> },
  { path: "/solutions/:slug", element: <SolutionPage /> },
  // Ancienne URL de la page Solutions — gardée vivante, les liens externes et
  // les anciennes signatures d'email pointent encore dessus.
  { path: "/features", element: <Navigate to="/solutions" replace /> },
  { path: "/pricing", element: <PricingPage /> },
  { path: "/blog", element: <BlogPage /> },
  { path: "/blog/:slug", element: <BlogPostPage /> },
  { path: "/faq", element: <FaqPage /> },
  { path: "/integrations", element: <IntegrationsPage /> },
  { path: "/changelog", element: <ChangelogPage /> },
  { path: "/docs", element: <DocsPage /> },
  { path: "/contact", element: <ContactPage /> },
  // Public help center portal
  { path: "/help/:publicKey", element: <HelpCenterPage /> },
  // Public, opt-in stats of a public agent (aggregates only — migration 0253).
  { path: "/stats/:publicKey", element: <PublicAgentStatsPage /> },
  // Auth
  { path: "/login", element: <LoginPage /> },
  { path: "/signup", element: <SignupPage /> },
  { path: "/onboarding", element: <AuthOnboardingPage /> },
  { path: "/accept-invite", element: <AcceptInvitePage /> },
  // Entrée en paiement depuis la grille publique. Volontairement hors
  // ProtectedRoute : la page doit voir le visiteur anonyme pour mémoriser
  // l'offre choisie avant de l'envoyer s'inscrire.
  { path: "/subscribe/:plan", element: <SubscribeRedirectPage /> },
  // Retour de Stripe Checkout : Stripe ne connaît que l'uuid du workspace, cette
  // page résout les slugs et renvoie vers l'onglet Facturation.
  {
    path: "/billing-success",
    element: (
      <ProtectedRoute>
        <BillingSuccessPage />
      </ProtectedRoute>
    ),
  },
  {
    path: "/orgs",
    element: (
      <ProtectedRoute>
        <OrganisationsPage />
      </ProtectedRoute>
    ),
  },
  {
    path: "/orgs/:workspaceSlug/projects",
    element: (
      <ProtectedRoute>
        <ProjectsPage />
      </ProtectedRoute>
    ),
  },
  {
    // MCP OAuth redirect target (popup) — public so it renders without a login
    // bounce; it uses the shared session token to finish the exchange.
    path: "/mcp/callback",
    element: <ErrorBoundary><McpOAuthCallbackPage /></ErrorBoundary>,
  },
  // Service dashboards render OUTSIDE the AppShell chrome (no top navbar) — a
  // clean single-sidebar workspace. Top-level sibling so it bypasses AppShell.
  {
    // `:leaf` est le troisième niveau : la section d'un projet de suivi
    // (/projects/:projectId/issues). Optionnel, donc toutes les URLs à deux
    // segments continuent de résoudre exactement comme avant.
    path: "/app/:workspaceSlug/:projectSlug/service/:dashboardId/:tab?/:sub?/:leaf?",
    element: (
      <ProtectedRoute>
        <ServiceDashboardPage />
      </ProtectedRoute>
    ),
  },
  {
    path: "/app/:workspaceSlug/:projectSlug",
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      // Landing = AI HQ. Redirect to the canonical hq route (not render inline)
      // so the module resolves to "hq" — primary sidebar highlights it and the
      // secondary sidebar hides.
      // Le module de travail (Plane) est la page d’arrivée : c’est là qu’on passe
      // la journée. Sans tableau de service, PlaneLanding retombe sur hq.
      { index: true, element: <PlaneLanding /> },
      // The Admin panel was merged into CRM — old /actions/* cockpit links
      // redirect (absolute, slug-based) to the new crm/* locations. The
      // crm/admin-dashboard tab was retired, so its former targets land on the
      // CRM Overview instead.
      { path: "actions", element: <AdminMergeRedirect to="overview" /> },
      { path: "actions/dashboard", element: <AdminMergeRedirect to="overview" /> },
      { path: "actions/custom-dashboards", element: <AdminMergeRedirect to="admin-custom-dashboards" /> },
      { path: "actions/alerts", element: <AdminMergeRedirect to="admin-alerts" /> },
      // The Projects super-module was folded into CRM.
      { path: "projects", element: <AdminMergeRedirect to="overview" /> },
      { path: "projects/all", element: <AdminMergeRedirect to="overview" /> },
      // App Testing split into Test runs / Dépôts / Vibe Code modules (Outils IA).
      { path: "crm/testing", element: <AbsRedirect to="test-runs/tests" /> },
      { path: "crm/simulations", element: <AbsRedirect to="simulations/workspace" /> },
      { path: "simulations/list", element: <AbsRedirect to="simulations/workspace" /> },
      // Test runs module (tabs as onglets via :sub) + its run detail.
      { path: "test-runs", element: <AbsRedirect to="test-runs/tests" /> },
      { path: "test-runs/:sub", element: <ErrorBoundary><TestRunsPage /></ErrorBoundary> },
      { path: "test-runs/run/:runId", element: <ErrorBoundary><OpsTestRunPage /></ErrorBoundary> },
      // Dépôts module: list route comes from buildModuleRoutes; add the detail.
      { path: "repos/repo/:repoId", element: <ErrorBoundary><RepoDetailPage /></ErrorBoundary> },
      // Vibe Code module (tabs as onglets via :sub).
      { path: "vibe-code", element: <AbsRedirect to="vibe-code/chat" /> },
      { path: "vibe-code/:sub", element: <ErrorBoundary><VibeCodePage /></ErrorBoundary> },
      // Back-compat for the old testing/* links.
      { path: "testing/workspace", element: <AbsRedirect to="test-runs/tests" /> },
      { path: "testing/repositories", element: <AbsRedirect to="repos/list" /> },
      { path: "testing/vibe-code", element: <AbsRedirect to="vibe-code/chat" /> },
      { path: "testing/repositories/:repoId", element: <ParamRedirect build={(p) => `repos/repo/${p.repoId}`} /> },
      { path: "testing/run/:runId", element: <ParamRedirect build={(p) => `test-runs/run/${p.runId}`} /> },
      {
        path: "actions/dashboard-builder/:dashboardId",
        element: (
          <ErrorBoundary>
            <DashboardBuilderPage />
          </ErrorBoundary>
        ),
      },
      {
        // The public-agent builder became a page of the service dashboard that
        // owns the agent (0195) — this resolves the dashboard and bounces there.
        path: "agent/builder/:agentId/:tab?",
        element: (
          <ErrorBoundary>
            <PublicAgentRedirect />
          </ErrorBoundary>
        ),
      },
      {
        path: "crm/workspace/:objectSlug",
        element: (
          <ErrorBoundary>
            <CrmWorkspacePage />
          </ErrorBoundary>
        ),
      },
      {
        path: "crm/workspace/:objectSlug/:recordId",
        element: (
          <ErrorBoundary>
            <RecordViewPage />
          </ErrorBoundary>
        ),
      },
      {
        path: "agent/knowledge/:collectionId",
        element: (
          <ErrorBoundary>
            <RagCollectionDetailPage />
          </ErrorBoundary>
        ),
      },
      {
        // Legacy deep links (…/chat, …/settings?s=tools) — the inner tab is
        // dropped, the service dashboard opens the agent on its own tabs.
        path: "agent/internal/:agentId/:tab?",
        element: (
          <ErrorBoundary>
            <InternalAgentRedirect />
          </ErrorBoundary>
        ),
      },
      {
        // Enregistrement d'une démonstration → skill (voir skill-recorder/).
        path: "agent/skills/record",
        element: (
          <ErrorBoundary>
            <SkillRecorderPage />
          </ErrorBoundary>
        ),
      },
      {
        path: "agent/skills/new",
        element: (
          <ErrorBoundary>
            <SkillEditorPage />
          </ErrorBoundary>
        ),
      },
      {
        path: "agent/skills/:skillId/edit",
        element: (
          <ErrorBoundary>
            <SkillEditorPage />
          </ErrorBoundary>
        ),
      },
      // Agent artifact editors (the Office module's only survivors).
      {
        path: "artifact/document/:docId",
        element: <ErrorBoundary><Suspense fallback={<ArtifactEditorFallback />}><DocumentEditorPage /></Suspense></ErrorBoundary>,
      },
      {
        path: "artifact/spreadsheet/:docId",
        element: <ErrorBoundary><Suspense fallback={<ArtifactEditorFallback />}><SpreadsheetEditorPage /></Suspense></ErrorBoundary>,
      },
      {
        path: "artifact/presentation/:docId",
        element: <ErrorBoundary><Suspense fallback={<ArtifactEditorFallback />}><PresentationEditorPage /></Suspense></ErrorBoundary>,
      },
      // Old Office deep links → the artifact editor that replaced them; every
      // other office/* page is gone, so it lands on the CRM.
      { path: "office/document/:docId", element: <ParamRedirect build={(p) => `artifact/document/${p.docId}`} /> },
      { path: "office/spreadsheet/:docId", element: <ParamRedirect build={(p) => `artifact/spreadsheet/${p.docId}`} /> },
      { path: "office/presentation/:docId", element: <ParamRedirect build={(p) => `artifact/presentation/${p.docId}`} /> },
      { path: "office", element: <AbsRedirect to="crm/workspace" /> },
      { path: "office/:sub", element: <AbsRedirect to="crm/workspace" /> },
      {
        path: "devops/servers/:serverId",
        element: (
          <ErrorBoundary>
            <OpsServerDetailPage />
          </ErrorBoundary>
        ),
      },
      {
        path: "devops/workflows/:bundleId",
        element: (
          <ErrorBoundary>
            <OpsBundleDetailPage />
          </ErrorBoundary>
        ),
      },
      {
        path: "devops/infra/:infraId",
        element: (
          <ErrorBoundary>
            <OpsInfraProjectDetailPage />
          </ErrorBoundary>
        ),
      },
      {
        path: "devops/testing/run/:runId",
        element: (
          <ErrorBoundary>
            <OpsTestRunPage />
          </ErrorBoundary>
        ),
      },
      // Any other old /actions/* cockpit link → CRM Overview.
      { path: "actions/:sub", element: <AdminMergeRedirect to="overview" /> },
      // PM & Support modules deleted (2026-07-17); the whiteboard they had
      // passed to Office went with the Office module itself (2026-08-10).
      // Simulations have their own module, everything else lives as CRM records.
      { path: "pm/whiteboard", element: <AbsRedirect to="crm/workspace" /> },
      { path: "pm/simulations", element: <AbsRedirect to="simulations/workspace" /> },
      { path: "pm/:sub", element: <AbsRedirect to="crm/workspace" /> },
      { path: "support/:sub", element: <AbsRedirect to="crm/workspace" /> },
      // Legacy redirects: Ops deep links map to DevOps detail routes.
      { path: "ops", element: <Navigate to="../devops/ops-overview" replace /> },
      { path: "ops/servers/:id", element: <LegacyOpsDetailRedirect kind="servers" /> },
      { path: "ops/workflows/:id", element: <LegacyOpsDetailRedirect kind="workflows" /> },
      { path: "ops/infra/:id", element: <LegacyOpsDetailRedirect kind="infra" /> },
      { path: "ops/:sub", element: <LegacyOpsRedirect /> },
      // Legacy redirects: Overview was merged into the Admin panel.
      { path: "overview", element: <Navigate to="../actions/dashboard" replace /> },
      { path: "overview/dashboard-builder/:dashboardId", element: <LegacyBuilderRedirect /> },
      { path: "overview/:sub", element: <LegacyOverviewRedirect /> },
      // ── Admin dashboard (single sidebar) — explicit routes, not module-generated ──
      { path: "admin", element: <AbsRedirect to={`admin/${ADMIN_LANDING}`} /> },
      ...ADMIN_ITEMS.map((it) => ({
        path: `admin/${it.slug}`,
        element: <ErrorBoundary>{ADMIN_PAGES[it.slug] ?? <Navigate to={ADMIN_LANDING} replace />}</ErrorBoundary>,
      })),
      // The Settings module was folded into the Admin dashboard.
      { path: "settings", element: <AbsRedirect to={`admin/${ADMIN_LANDING}`} /> },
      { path: "settings/:sub", element: <SettingsRedirect /> },
      // The Integrations module was folded into a single "Connecteurs" tab,
      // which now lives in AI Workforce — every old link lands there.
      { path: "integrations", element: <AbsRedirect to="agent/connectors" /> },
      { path: "integrations/:sub", element: <AbsRedirect to="agent/connectors" /> },
      { path: "admin/connectors", element: <AbsRedirect to="agent/connectors" /> },
      // The "Agentic Onboarding" module became a conditional tab on public
      // agents — its old deep links land on the public agents list.
      { path: "onboarding", element: <AbsRedirect to="agent/agents" /> },
      { path: "onboarding/:sub", element: <AbsRedirect to="agent/agents" /> },
      // "Agents publics" became the unified "Agents" roster (internal + public
      // in one list), so its old slug redirects rather than 404-ing.
      { path: "agent/public-agents", element: <AbsRedirect to="agent/agents" /> },
      ...buildModuleRoutes(),
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
