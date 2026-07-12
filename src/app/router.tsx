import { createBrowserRouter, Navigate, useParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { MODULE_PROJECT_CONFIGS } from "@/lib/module-project-config";
import { ModuleProjectList } from "@/features/module-projects/ModuleProjectList";
import { ModuleProjectDetail } from "@/features/module-projects/ModuleProjectDetail";
import { AiHqDashboard } from "@/features/dashboard/AiHqDashboard";
import { ProtectedRoute } from "./ProtectedRoute";
import { LoginPage } from "@/features/auth/Login";
import { SignupPage } from "@/features/auth/Signup";
import { OnboardingPage as AuthOnboardingPage } from "@/features/auth/Onboarding";
import { AcceptInvitePage } from "@/features/auth/AcceptInvite";
import { OrganisationsPage } from "@/features/orgs/Organisations";
import { ProjectsPage } from "@/features/orgs/Projects";

// Overview (merged into Admin panel — kept tabs only)
import { OverviewDashboard } from "@/features/overview/Dashboard";
import { AlertsPage } from "@/features/overview/Alerts";
import { CustomDashboardsPage } from "@/features/overview/dashboards/CustomDashboards";
import { DashboardBuilderPage } from "@/features/overview/dashboards/DashboardBuilder";

import { AgentBuilderPage } from "@/features/agent-rag/AgentBuilder";
import { RagAgentsPage } from "@/features/agent-rag/Agents";
import {
  OnboardingFlowsPage,
  OnboardingToursPage,
  OnboardingChecklistPage,
} from "@/features/agent-rag/onboarding/OnboardingPages";
import { OnboardingTreePage } from "@/features/agent-rag/onboarding/OnboardingTreePage";
import { GoalsStudioPage } from "@/features/agent-rag/onboarding/GoalsStudio";
import { ActivationCockpitPage } from "@/features/agent-rag/onboarding/ActivationCockpit";
import { RagCenterPage, RagCollectionDetailPage } from "@/features/rag-center/RagCenter";
import { KnowledgeCollectionsPage } from "@/features/rag-center/KnowledgeCollections";
import { InternalAgentsListPage } from "@/features/internal-agents/InternalAgentsList";
import { InternalAgentDetailPage } from "@/features/internal-agents/InternalAgentDetail";
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
import { RecordViewPage } from "@/features/crm/RecordView";
import {
  SupportOverviewPage, SupportTicketsPage, SupportKbPage,
  SupportAnalyticsPage, SupportMacrosPage,
} from "@/features/support/SupportPages";
import {
  SupportChannelsPage, SupportSlaRoutingPage, SupportCallCenterPage, SupportPortalPage,
} from "@/features/support/SupportAdvanced";
import { HelpCenterPage } from "@/features/support/HelpCenter";
import { PmBoardsPage, PmMyTasksPage } from "@/features/pm/PmPages";
import { PmInboxPage } from "@/features/pm/PmInbox";
import { PmWhiteboardPage } from "@/features/pm/PmWhiteboard";
import { PmSimulationsPage } from "@/features/pm/PmSimulations";
import { PmTimesheetsPage, PmResourcingPage, PmProfitabilityPage, PmGanttPage } from "@/features/pm/PmPsa";

// Office (Bureautique)
import { Suspense, lazy } from "react";
import { OfficeLibraryPage } from "@/features/office/OfficeLibrary";
import { OfficeCopywriterPage, OfficeImageStudioPage, OfficeVideoStudioPage } from "@/features/office/OfficeGenAi";
// Office editors are lazy-loaded — the Plate document editor pulls a large
// dependency graph (media, tables, AI…), so we keep it out of the initial bundle.
const DocumentEditorPage = lazy(() =>
  import("@/features/office/DocumentEditor").then((m) => ({ default: m.DocumentEditorPage })));
const SpreadsheetEditorPage = lazy(() =>
  import("@/features/office/SpreadsheetEditor").then((m) => ({ default: m.SpreadsheetEditorPage })));
const PresentationEditorPage = lazy(() =>
  import("@/features/office/PresentationEditor").then((m) => ({ default: m.PresentationEditorPage })));

function OfficeEditorFallback() {
  return <div className="flex h-[60vh] items-center justify-center text-sm text-muted-foreground">Loading editor…</div>;
}

// Integrations
import { CatalogPage } from "@/features/integrations/Catalog";
import { ConnectedPage } from "@/features/integrations/Connected";
import { CredentialsVaultPage } from "@/features/integrations/CredentialsVault";
import { ApiKeysPage, WebhooksOutPage, AutomationPage } from "@/features/integrations/Extra";

// Settings
import { SettingsProfilePage } from "@/features/settings/Profile";
import { SettingsWorkspacePage } from "@/features/settings/Workspace";
import { SettingsProjectsPage, SettingsNotificationsPage } from "@/features/settings/Extra";
import { SettingsTeamPage } from "@/features/settings/Team";
import { SettingsRolesPage } from "@/features/settings/Roles";
import { SettingsBillingPage } from "@/features/settings/Billing";
import { SettingsSecurityPage } from "@/features/settings/Security2FA";
import { SettingsDataPrivacyPage } from "@/features/settings/DataPrivacy";

import { GenericSubPage } from "@/features/GenericSubPage";
import { MODULES } from "@/lib/navigation";

// Governance
import { GovernanceDashboard } from "@/features/governance/Dashboard";
import { GovRegistryPage } from "@/features/governance/Registry";
import { GovRisksPage } from "@/features/governance/RiskRegister";
import { GovPoliciesPage } from "@/features/governance/Policies";
import { GovControlsPage } from "@/features/governance/Controls";
import { GovApprovalsPage } from "@/features/governance/Approvals";
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
  FeaturesPage,
  PricingPage,
  IntegrationsPage,
  ChangelogPage,
  DocsPage,
  ContactPage,
} from "@/features/marketing-site/OtherPages";

type PageEl = import("react").ReactElement;

const PAGES: Record<string, PageEl> = {
  // AI HQ dashboard
  "hq/dashboard": <AiHqDashboard />,

  "agent/internal-agents": <InternalAgentsListPage />,
  "agent/public-agents": <RagAgentsPage />,
  "agent/ecosystem": <AgentEcosystemPage />,
  "agent/tasks": <AgentTasksPage />,
  "agent/knowledge": <RagCenterPage />,
  "agent/collections": <KnowledgeCollectionsPage />,

  // Ops group (infra/servers/workflows — reachable via explicit detail routes)
  "devops/ops-overview": <OpsOverviewPage />,
  "devops/servers": <OpsServersPage />,
  "devops/workflows": <OpsWorkflowsPage />,
  "devops/checks": <OpsChecksPage />,
  "devops/testing": <TestRunsPage />,
  "devops/jobs": <OpsJobsPage />,
  "devops/settings": <OpsSettingsPage />,

  // CRM (Projects, App Testing & Simulations were folded in here)
  "crm/workspace": <CrmWorkspacePage />,
  "crm/admin-dashboard": <OverviewDashboard />,
  "crm/admin-custom-dashboards": <CustomDashboardsPage />,
  "crm/admin-alerts": <AlertsPage />,

  // "Outils IA" dashboard modules.
  "repos/list": <RepositoriesPage />,
  "simulations/workspace": <PmSimulationsPage />,

  // Agentic Onboarding module — generative (palier 1) + the underlying artefacts.
  "onboarding/goals": <GoalsStudioPage />,
  "onboarding/activation": <ActivationCockpitPage />,
  "onboarding/flows": <OnboardingFlowsPage />,
  "onboarding/tours": <OnboardingToursPage />,
  "onboarding/checklist": <OnboardingChecklistPage />,
  "onboarding/tree": <OnboardingTreePage />,

  // Support
  "support/overview": <SupportOverviewPage />,
  "support/tickets": <SupportTicketsPage />,
  "support/analytics": <SupportAnalyticsPage />,
  "support/macros": <SupportMacrosPage />,
  "support/knowledge-base": <SupportKbPage />,
  "support/calls": <SupportCallCenterPage />,
  "support/portal": <SupportPortalPage />,
  "support/channels": <SupportChannelsPage />,
  "support/sla-routing": <SupportSlaRoutingPage />,

  // Projects (PM)
  "pm/boards": <PmBoardsPage />,
  "pm/my-tasks": <PmMyTasksPage />,
  "pm/inbox": <PmInboxPage />,
  "pm/whiteboard": <PmWhiteboardPage />,
  "pm/simulations": <PmSimulationsPage />,
  "pm/gantt": <PmGanttPage />,
  "pm/timesheets": <PmTimesheetsPage />,
  "pm/resourcing": <PmResourcingPage />,
  "pm/profitability": <PmProfitabilityPage />,

  // Office (Bureautique) — library + per-kind filtered lists.
  "office/library": <OfficeLibraryPage />,
  "office/documents": <OfficeLibraryPage initialKind="document" />,
  "office/spreadsheets": <OfficeLibraryPage initialKind="spreadsheet" />,
  "office/presentations": <OfficeLibraryPage initialKind="presentation" />,
  "office/gen-image": <OfficeImageStudioPage />,
  "office/gen-video": <OfficeVideoStudioPage />,
  "office/gen-copy": <OfficeCopywriterPage />,

  "integrations/connected": <ConnectedPage />,
  "integrations/catalog": <CatalogPage />,
  "integrations/credentials-vault": <CredentialsVaultPage />,
  "integrations/api-keys": <ApiKeysPage />,
  "integrations/webhooks": <WebhooksOutPage />,
  "integrations/automation": <AutomationPage />,

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

  "settings/profile": <SettingsProfilePage />,
  "settings/workspace": <SettingsWorkspacePage />,
  "settings/projects": <SettingsProjectsPage />,
  "settings/team": <SettingsTeamPage />,
  "settings/roles": <SettingsRolesPage />,
  "settings/billing": <SettingsBillingPage />,
  "settings/notifications": <SettingsNotificationsPage />,
  "settings/security": <SettingsSecurityPage />,
  "settings/data-privacy": <SettingsDataPrivacyPage />,
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
  return MODULES.filter((m) => m.slug !== "test-runs" && m.slug !== "vibe-code").flatMap((mod) => {
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
  { path: "/features", element: <FeaturesPage /> },
  { path: "/pricing", element: <PricingPage /> },
  { path: "/integrations", element: <IntegrationsPage /> },
  { path: "/changelog", element: <ChangelogPage /> },
  { path: "/docs", element: <DocsPage /> },
  { path: "/contact", element: <ContactPage /> },
  // Public help center portal
  { path: "/help/:publicKey", element: <HelpCenterPage /> },
  // Auth
  { path: "/login", element: <LoginPage /> },
  { path: "/signup", element: <SignupPage /> },
  { path: "/onboarding", element: <AuthOnboardingPage /> },
  { path: "/accept-invite", element: <AcceptInvitePage /> },
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
    path: "/app/:workspaceSlug/:projectSlug",
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <ErrorBoundary><AiHqDashboard /></ErrorBoundary> },
      // The Admin panel was merged into CRM — old /actions/* cockpit links
      // redirect (absolute, slug-based) to the new crm/admin-* locations.
      { path: "actions", element: <AdminMergeRedirect to="admin-dashboard" /> },
      { path: "actions/dashboard", element: <AdminMergeRedirect to="admin-dashboard" /> },
      { path: "actions/custom-dashboards", element: <AdminMergeRedirect to="admin-custom-dashboards" /> },
      { path: "actions/alerts", element: <AdminMergeRedirect to="admin-alerts" /> },
      // The Projects super-module was folded into CRM.
      { path: "projects", element: <AdminMergeRedirect to="admin-dashboard" /> },
      { path: "projects/all", element: <AdminMergeRedirect to="admin-dashboard" /> },
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
        path: "agent/builder/:agentId/:tab?",
        element: (
          <ErrorBoundary>
            <AgentBuilderPage />
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
        path: "agent/internal/:agentId/:tab?",
        element: (
          <ErrorBoundary>
            <InternalAgentDetailPage />
          </ErrorBoundary>
        ),
      },
      {
        path: "office/document/:docId",
        element: <ErrorBoundary><Suspense fallback={<OfficeEditorFallback />}><DocumentEditorPage /></Suspense></ErrorBoundary>,
      },
      {
        path: "office/spreadsheet/:docId",
        element: <ErrorBoundary><Suspense fallback={<OfficeEditorFallback />}><SpreadsheetEditorPage /></Suspense></ErrorBoundary>,
      },
      {
        path: "office/presentation/:docId",
        element: <ErrorBoundary><Suspense fallback={<OfficeEditorFallback />}><PresentationEditorPage /></Suspense></ErrorBoundary>,
      },
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
      // Any other old /actions/* cockpit link → CRM admin dashboard.
      { path: "actions/:sub", element: <AdminMergeRedirect to="admin-dashboard" /> },
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
      ...buildModuleRoutes(),
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
