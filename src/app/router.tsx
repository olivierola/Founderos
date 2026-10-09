import { createBrowserRouter, Navigate, useParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
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
import { ConnectorOAuthCallbackPage } from "@/features/custom-connectors/OAuthCallback";
import { CompanionEntry, CompanionPage } from "@/features/companion/CompanionPage";
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
import { GovTypeSafePage } from "@/features/governance/aiops/TypeSafe";
import { GovContextIQPage } from "@/features/governance/aiops/ContextIQ";
import { GovAgentPilotPage } from "@/features/governance/aiops/AgentPilot";
import { GovPolicyGuardPage } from "@/features/governance/aiops/PolicyGuard";
import { GovSentinelFlowPage } from "@/features/governance/aiops/SentinelFlow";
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
import { IntegrationsPage } from "@/features/marketing-site/IntegrationsPage";
import { ChangelogPage } from "@/features/marketing-site/ChangelogPage";
import { DocsPage } from "@/features/marketing-site/DocsPage";
import { ContactPage } from "@/features/marketing-site/ContactPage";
// Toutes les pages marketing partagent le même chrome : LandingNav, PaperHero,
// LandingKit/PaperKit et LandingFooter. L'ancienne coque (MarketingShell) est partie
// avec les trois dernières pages qui la portaient.

import { PricingPage } from "@/features/marketing-site/PricingPage";
import { SolutionsPage } from "@/features/marketing-site/SolutionsPage";
import { SolutionPage } from "@/features/marketing-site/SolutionPage";
import { BlogPage } from "@/features/marketing-site/BlogPage";
import { BlogPostPage } from "@/features/marketing-site/BlogPostPage";
import { FaqPage } from "@/features/marketing-site/FaqPage";
import { ProductPage } from "@/features/marketing-site/ProductPage";
import { UseCasesPage } from "@/features/marketing-site/UseCasesPage";
import { AboutPage } from "@/features/marketing-site/AboutPage";

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
  "gov-typesafe": <GovTypeSafePage />,
  "gov-contextiq": <GovContextIQPage />,
  "gov-agentpilot": <GovAgentPilotPage />,
  "gov-policyguard": <GovPolicyGuardPage />,
  "gov-sentinelflow": <GovSentinelFlowPage />,
  "gov-access": <GovAccessLogsPage />,
  "gov-prompts": <GovPromptMonitoringPage />,
  "gov-costs": <GovCostsPage />,
  "gov-incidents": <GovOpsIncidentsPage />,
  "gov-actions": <AdminActionsQueuePage />,
  "gov-pentest-scope": <PentestScopePage />,
};

/** Absolute redirect to /app/:ws/:proj/<to> (slug-based, robust). */
function AbsRedirect({ to }: { to: string }) {
  const { workspaceSlug, projectSlug } = useParams();
  return <Navigate to={`/app/${workspaceSlug}/${projectSlug}/${to}`} replace />;
}

function buildModuleRoutes() {
  // test-runs & vibe-code render via explicit :sub routes (single page instance
  // that keeps its state across onglets), so they're excluded here.
  // HIDDEN_MODULES (devops/simulations/test-runs/repos…) stay routed without appearing in
  // the nav — deep links, CRM record actions and breadcrumbs keep working.
  return [...MODULES, ...HIDDEN_MODULES].filter((m) => m.slug !== "test-runs" && m.slug !== "vibe-code").flatMap((mod) => {
    // Every sub-item of every routed module has a page in PAGES — the diff is
    // enforced by the nav itself. A missing one is a wiring bug, not a "coming
    // soon", so it falls through to the catch-all instead of a placeholder.
    const subRoutes = mod.subItems.flatMap((sub) => {
      const element = PAGES[`${mod.slug}/${sub.slug}`];
      if (!element) return [];
      return [{ path: `${mod.slug}/${sub.slug}`, element: <ErrorBoundary>{element}</ErrorBoundary> }];
    });
    return [
      { path: mod.slug, element: <Navigate to={mod.subItems[0]!.slug} replace /> },
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
  { path: "/product/:slug", element: <ProductPage /> },
  { path: "/use-cases", element: <UseCasesPage /> },
  { path: "/about", element: <AboutPage /> },
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
  {
    // Retour du SSO d'entreprise d'un outil interne (popup), même principe.
    path: "/connectors/callback",
    element: <ErrorBoundary><ConnectorOAuthCallbackPage /></ErrorBoundary>,
  },
  // The browser extension's side panel (browser-recorder/src/panel.html) frames
  // these two routes. /companion handles sign-in and picks the project; the
  // project route is the panel itself. Their framing exception lives in
  // vercel.json — every other route stays X-Frame-Options: DENY.
  { path: "/companion", element: <ErrorBoundary><CompanionEntry /></ErrorBoundary> },
  {
    path: "/companion/:workspaceSlug/:projectSlug",
    element: (
      <ProtectedRoute>
        <ErrorBoundary><CompanionPage /></ErrorBoundary>
      </ProtectedRoute>
    ),
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
      // Test runs module (tabs as onglets via :sub) + its run detail.
      { path: "test-runs", element: <AbsRedirect to="test-runs/tests" /> },
      { path: "test-runs/:sub", element: <ErrorBoundary><TestRunsPage /></ErrorBoundary> },
      { path: "test-runs/run/:runId", element: <ErrorBoundary><OpsTestRunPage /></ErrorBoundary> },
      // Dépôts module: list route comes from buildModuleRoutes; add the detail.
      { path: "repos/repo/:repoId", element: <ErrorBoundary><RepoDetailPage /></ErrorBoundary> },
      // Vibe Code module (tabs as onglets via :sub).
      { path: "vibe-code", element: <AbsRedirect to="vibe-code/chat" /> },
      { path: "vibe-code/:sub", element: <ErrorBoundary><VibeCodePage /></ErrorBoundary> },
      {
        // Le constructeur de dashboards vit à côté de sa liste (crm/admin-custom-dashboards).
        path: "crm/dashboard-builder/:dashboardId",
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
      // ── Admin dashboard (single sidebar) — explicit routes, not module-generated ──
      { path: "admin", element: <AbsRedirect to={`admin/${ADMIN_LANDING}`} /> },
      ...ADMIN_ITEMS.map((it) => ({
        path: `admin/${it.slug}`,
        element: <ErrorBoundary>{ADMIN_PAGES[it.slug] ?? <Navigate to={ADMIN_LANDING} replace />}</ErrorBoundary>,
      })),
      ...buildModuleRoutes(),
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
