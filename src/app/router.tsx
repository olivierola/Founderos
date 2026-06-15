import { createBrowserRouter, Navigate, useParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ProtectedRoute } from "./ProtectedRoute";
import { LoginPage } from "@/features/auth/Login";
import { SignupPage } from "@/features/auth/Signup";
import { OnboardingPage } from "@/features/auth/Onboarding";
import { AcceptInvitePage } from "@/features/auth/AcceptInvite";
import { OrganisationsPage } from "@/features/orgs/Organisations";
import { ProjectsPage } from "@/features/orgs/Projects";

// Overview (merged into Admin panel — kept tabs only)
import { OverviewDashboard } from "@/features/overview/Dashboard";
import { AlertsPage } from "@/features/overview/Alerts";
import { CustomDashboardsPage } from "@/features/overview/dashboards/CustomDashboards";
import { DashboardBuilderPage } from "@/features/overview/dashboards/DashboardBuilder";

// Finance
import { RevenuePage } from "@/features/finance/Revenue";
import { TransactionsPage } from "@/features/finance/Transactions";
import { MrrMovementPage } from "@/features/finance/MrrMovement";
import { CustomersPage } from "@/features/finance/Customers";
import { SubscriptionsPage } from "@/features/finance/Subscriptions";
import {
  CohortsPage,
  ForecastingPage,
  InvestorMetricsPage,
  FinanceReportsPage,
} from "@/features/finance/Extra";

// Costs
import { CostsOverviewPage } from "@/features/costs/Overview";
import { CostsProvidersPage } from "@/features/costs/Providers";
import { LlmCostsPage } from "@/features/costs/LlmCosts";
import { OptimizationPage } from "@/features/costs/Optimization";
import { CostPerUserPage, BudgetsPage, InvoicesPage } from "@/features/costs/Extra";

// Users
import { AllUsersPage } from "@/features/users/AllUsers";
import {
  SegmentsPage,
  UserCohortsPage,
  User360Page,
  HealthScoresPage,
  ChurnRiskPage,
} from "@/features/users/Extra";
import { EngagementPage } from "@/features/users/Engagement";

import { RagAgentsPage } from "@/features/agent-rag/Agents";
import { AgentBuilderPage } from "@/features/agent-rag/AgentBuilder";
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
import { OpsTestingPage } from "@/features/ops/TestingWorkspace";
import { OpsTestRunPage } from "@/features/ops/TestRunPage";
import { OpsJobsPage } from "@/features/ops/JobsPage";
import { OpsSettingsPage } from "@/features/ops/SettingsPage";
import { OnboardingPage as RagOnboardingPage } from "@/features/agent-rag/onboarding/OnboardingPage";

import { ContentStudioPage } from "@/features/marketing/ContentStudio";
import {
  MarketingOverviewPage,
  MarketingCalendarPage,
  MarketingChannelsPage,
  MarketingAnalyticsPage,
  MarketingCampaignsPage,
  MarketingAdvisorPage,
} from "@/features/marketing/Extra";

// Office (Bureautique)
import { Suspense, lazy } from "react";
import { OfficeLibraryPage } from "@/features/office/OfficeLibrary";
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

// Code
import { RepositoriesPage } from "@/features/code/Repositories";
import { ScanResultsPage } from "@/features/code/ScanResults";
import {
  CodeOverviewPage,
  ScanComparePage,
  ArchitectureMapPage,
  DependenciesPage,
  ApiUsagePage,
  DatabaseSchemaPage,
  TechDebtPage,
} from "@/features/code/Extra";

// Security
import { SecurityFindingsPage } from "@/features/security/Findings";
import { CveAlertsPage } from "@/features/security/CveAlerts";
import { SecretsDetectionPage } from "@/features/security/Secrets";
import { LicenseAuditPage, RiskScorePage } from "@/features/security/Extra";
import { ComplianceWatchPage } from "@/features/security/Compliance";

// Health
import {
  HealthStatusPage,
  UptimePage,
  ErrorsPage,
  PerformancePage,
  DeploymentsPage,
  IncidentsPage,
  DatabasePage,
} from "@/features/health/Health";

// Actions
import { QuickActionsPage } from "@/features/actions/QuickActions";
import { StripeOperationsPage } from "@/features/actions/StripeOperations";
import { UserManagementPage } from "@/features/actions/UserManagement";
import { AuditLogPage } from "@/features/actions/AuditLog";
import {
  DatabaseConsolePage,
  EmailSenderPage,
  ActionsWebhooksPage,
} from "@/features/actions/Extra";
import { RunbooksPage } from "@/features/actions/Runbooks";
import { SaasAnalyticsPage } from "@/features/actions/SaasAnalytics";
import { SessionReplayPage } from "@/features/saas-analytics/SessionReplay";
import { EventsPage } from "@/features/saas-analytics/Events";
import { GrowthPage } from "@/features/saas-analytics/Growth";
import { FunnelsPage as AnalyticsFunnelsPage } from "@/features/saas-analytics/Funnels";
import { RetentionPage } from "@/features/saas-analytics/Retention";
import { ActivationPage } from "@/features/saas-analytics/Activation";
import { PerUserAnalyticsPage } from "@/features/actions/PerUserAnalytics";
import { GroupAnalyticsPage } from "@/features/actions/GroupAnalytics";
import { UserJourneysPage } from "@/features/actions/UserJourneys";

// AI Agent
import { AiChatPage } from "@/features/ai-agent/Chat";
import {
  AiInsightsPage,
  AiReportsPage,
  PromptTemplatesPage,
  GuardrailsPage,
} from "@/features/ai-agent/Extra";
import { AiWorkflowsPage } from "@/features/ai-agent/Workflows";

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
  // Overview was merged into the Admin panel — these three tabs were kept.
  "actions/dashboard": <OverviewDashboard />,
  "actions/custom-dashboards": <CustomDashboardsPage />,
  "actions/alerts": <AlertsPage />,

  // Finance was merged into SaaS Analytics (Revenue + Costs groups). The pages
  // are unchanged; only their route prefix moved to saas-analytics/*.
  "saas-analytics/revenue": <RevenuePage />,
  "saas-analytics/transactions": <TransactionsPage />,
  "saas-analytics/mrr-movement": <MrrMovementPage />,
  "saas-analytics/customers": <CustomersPage />,
  "saas-analytics/subscriptions": <SubscriptionsPage />,
  "saas-analytics/cohorts": <CohortsPage />,
  "saas-analytics/forecasting": <ForecastingPage />,
  "saas-analytics/investor-metrics": <InvestorMetricsPage />,
  "saas-analytics/reports": <FinanceReportsPage />,

  "saas-analytics/costs-overview": <CostsOverviewPage />,
  "saas-analytics/costs-providers": <CostsProvidersPage />,
  "saas-analytics/costs-llm": <LlmCostsPage />,
  "saas-analytics/costs-optimization": <OptimizationPage />,
  "saas-analytics/costs-per-user": <CostPerUserPage />,
  "saas-analytics/costs-budgets": <BudgetsPage />,
  "saas-analytics/costs-invoices": <InvoicesPage />,

  // SaaS Analytics module — overview + user & health sub-tabs
  "saas-analytics/overview": <SaasAnalyticsPage />,
  "saas-analytics/session-replay": <SessionReplayPage />,
  "saas-analytics/events": <EventsPage />,
  "saas-analytics/growth": <GrowthPage />,
  "saas-analytics/activation": <ActivationPage />,
  "saas-analytics/funnels": <AnalyticsFunnelsPage />,
  "saas-analytics/retention": <RetentionPage />,
  "saas-analytics/users-all": <AllUsersPage />,
  "saas-analytics/users-segments": <SegmentsPage />,
  "saas-analytics/users-cohorts": <UserCohortsPage />,
  "saas-analytics/users-360": <User360Page />,
  "saas-analytics/users-engagement": <EngagementPage />,
  "saas-analytics/users-health-scores": <HealthScoresPage />,
  "saas-analytics/users-churn": <ChurnRiskPage />,
  "saas-analytics/users-funnels": <UserJourneysPage />,
  "saas-analytics/users-per-user": <PerUserAnalyticsPage />,
  "saas-analytics/users-groups": <GroupAnalyticsPage />,
  "saas-analytics/users-journeys": <UserJourneysPage />,

  "agent/agents": <RagAgentsPage />,
  "agent/internal-agents": <InternalAgentsListPage />,
  "agent/ecosystem": <AgentEcosystemPage />,
  "agent/tasks": <AgentTasksPage />,
  "agent/onboarding": <RagOnboardingPage />,

  // Ops group (under the merged DevOps module)
  "devops/ops-overview": <OpsOverviewPage />,
  "devops/servers": <OpsServersPage />,
  "devops/deployments": <DeploymentsPage />,
  "devops/workflows": <OpsWorkflowsPage />,
  "devops/checks": <OpsChecksPage />,
  "devops/testing": <OpsTestingPage />,
  "devops/jobs": <OpsJobsPage />,
  "devops/settings": <OpsSettingsPage />,

  "marketing/overview": <MarketingOverviewPage />,
  "marketing/content-studio": <ContentStudioPage />,
  "marketing/calendar": <MarketingCalendarPage />,
  "marketing/campaigns": <MarketingCampaignsPage />,
  "marketing/channels": <MarketingChannelsPage />,
  "marketing/analytics": <MarketingAnalyticsPage />,
  "marketing/advisor": <MarketingAdvisorPage />,

  // Office (Bureautique) — library + per-kind filtered lists.
  "office/library": <OfficeLibraryPage />,
  "office/documents": <OfficeLibraryPage initialKind="document" />,
  "office/spreadsheets": <OfficeLibraryPage initialKind="spreadsheet" />,
  "office/presentations": <OfficeLibraryPage initialKind="presentation" />,

  // Code group (under the merged DevOps module)
  "devops/overview": <CodeOverviewPage />,
  "devops/repositories": <RepositoriesPage />,
  "devops/scan-results": <ScanResultsPage />,
  "devops/compare-scans": <ScanComparePage />,
  "devops/architecture-map": <ArchitectureMapPage />,
  "devops/dependencies": <DependenciesPage />,
  "devops/api-usage": <ApiUsagePage />,
  "devops/database-schema": <DatabaseSchemaPage />,
  "devops/tech-debt": <TechDebtPage />,

  // Security group
  "devops/security-overview": <SecurityFindingsPage filter="all" />,
  "devops/security-cve-alerts": <CveAlertsPage />,
  "devops/security-secrets": <SecretsDetectionPage />,
  "devops/security-risk-score": <RiskScorePage />,
  "devops/security-license-audit": <LicenseAuditPage />,
  "devops/security-compliance": <ComplianceWatchPage />,

  // Health sub-tabs under SaaS Analytics
  "saas-analytics/health-status": <HealthStatusPage />,
  "saas-analytics/health-uptime": <UptimePage />,
  "saas-analytics/health-errors": <ErrorsPage />,
  "saas-analytics/health-performance": <PerformancePage />,
  "saas-analytics/health-incidents": <IncidentsPage />,
  "saas-analytics/health-database": <DatabasePage />,

  "actions/quick-actions": <QuickActionsPage />,
  "actions/user-management": <UserManagementPage />,
  "actions/stripe-operations": <StripeOperationsPage />,
  "actions/database-console": <DatabaseConsolePage />,
  "actions/email-sender": <EmailSenderPage />,
  "actions/webhooks": <ActionsWebhooksPage />,
  "actions/runbooks": <RunbooksPage />,
  "actions/audit-log": <AuditLogPage />,

  // AI Assistant pages live in the RAG Agent module ("agent/…") since the two
  // modules were merged; the old "ai/…" paths stay registered for deep links.
  "agent/chat": <AiChatPage />,
  "agent/insights": <AiInsightsPage />,
  "agent/reports": <AiReportsPage />,
  "agent/workflows": <AiWorkflowsPage />,
  "agent/prompt-templates": <PromptTemplatesPage />,
  "agent/guardrails": <GuardrailsPage />,
  "ai/chat": <AiChatPage />,
  "ai/insights": <AiInsightsPage />,
  "ai/reports": <AiReportsPage />,
  "ai/workflows": <AiWorkflowsPage />,
  "ai/prompt-templates": <PromptTemplatesPage />,
  "ai/guardrails": <GuardrailsPage />,

  "integrations/connected": <ConnectedPage />,
  "integrations/catalog": <CatalogPage />,
  "integrations/credentials-vault": <CredentialsVaultPage />,
  "integrations/api-keys": <ApiKeysPage />,
  "integrations/webhooks": <WebhooksOutPage />,
  "integrations/automation": <AutomationPage />,

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

/** Redirects an old /finance/:sub path to /saas-analytics/:sub (same suffix).
 *  Two `..` segments climb out of `finance/:sub` back to the project root. */
function LegacyFinanceRedirect() {
  const { sub } = useParams();
  return <Navigate to={`../../saas-analytics/${sub}`} replace />;
}

/** Code + Ops were merged into the DevOps module. Old /code/:sub and /ops/:sub
 *  deep links map to /devops/:sub, except the Ops overview which was renamed. */
function LegacyCodeRedirect() {
  const { sub } = useParams();
  return <Navigate to={`../../devops/${sub}`} replace />;
}
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
  return MODULES.flatMap((mod) => {
    const subRoutes = mod.subItems.map((sub) => {
      const key = `${mod.slug}/${sub.slug}`;
      const element = PAGES[key] ?? <GenericSubPage moduleSlug={mod.slug} subSlug={sub.slug} />;
      return { path: `${mod.slug}/${sub.slug}`, element: <ErrorBoundary>{element}</ErrorBoundary> };
    });
    return [
      {
        path: mod.slug,
        element: <Navigate to={mod.subItems[0]!.slug} replace />,
      },
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
  // Auth
  { path: "/login", element: <LoginPage /> },
  { path: "/signup", element: <SignupPage /> },
  { path: "/onboarding", element: <OnboardingPage /> },
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
      { index: true, element: <Navigate to="actions/dashboard" replace /> },
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
      // Legacy redirects: Finance was merged into SaaS Analytics. Old
      // /finance/* deep links (incl. /finance/costs-*) map 1:1 to the new slug.
      { path: "finance", element: <Navigate to="../saas-analytics/revenue" replace /> },
      { path: "finance/:sub", element: <LegacyFinanceRedirect /> },
      // Legacy redirects: Code + Ops were merged into DevOps.
      { path: "code", element: <Navigate to="../devops/overview" replace /> },
      { path: "code/:sub", element: <LegacyCodeRedirect /> },
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
