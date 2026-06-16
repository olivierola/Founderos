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

// Business modules — HR / CRM / Support / Projects / Finance
import {
  HrOverviewPage, HrEmployeesPage, HrOrgChartPage, HrLeavePage, HrPayrollPage,
} from "@/features/hr/HrPages";
import { RecruitmentPage } from "@/features/hr/Recruitment";
import { OpeningDetailPage } from "@/features/hr/OpeningDetail";
import {
  CrmOverviewPage, CrmContactsPage, CrmPipelinePage, CrmActivitiesPage,
} from "@/features/crm/CrmPages";
import {
  SupportOverviewPage, SupportTicketsPage, SupportKbPage,
  SupportAnalyticsPage, SupportMacrosPage,
} from "@/features/support/SupportPages";
import { PmBoardsPage, PmMyTasksPage } from "@/features/pm/PmPages";
import { PmInboxPage } from "@/features/pm/PmInbox";
import { PmWhiteboardPage } from "@/features/pm/PmWhiteboard";
import { PmSimulationsPage } from "@/features/pm/PmSimulations";
import {
  ScOverviewPage, ScInventoryPage, ScSuppliersPage, ScPurchaseOrdersPage, ScShipmentsPage,
} from "@/features/supply/ScPages";
import {
  FinanceOverviewPage, FinanceInvoicesPage, FinanceExpensesPage, FinanceBudgetsPage,
} from "@/features/finance-mod/FinancePages";

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
import { SecurityScansPage } from "@/features/security/SecurityScans";

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
  "software/revenue": <RevenuePage />,
  "software/transactions": <TransactionsPage />,
  "software/mrr-movement": <MrrMovementPage />,
  "software/customers": <CustomersPage />,
  "software/subscriptions": <SubscriptionsPage />,
  "software/cohorts": <CohortsPage />,
  "software/forecasting": <ForecastingPage />,
  "software/investor-metrics": <InvestorMetricsPage />,
  "software/reports": <FinanceReportsPage />,

  "software/costs-overview": <CostsOverviewPage />,
  "software/costs-providers": <CostsProvidersPage />,
  "software/costs-llm": <LlmCostsPage />,
  "software/costs-optimization": <OptimizationPage />,
  "software/costs-per-user": <CostPerUserPage />,
  "software/costs-budgets": <BudgetsPage />,
  "software/costs-invoices": <InvoicesPage />,

  // SaaS Analytics module — overview + user & health sub-tabs
  "software/overview": <SaasAnalyticsPage />,
  "software/session-replay": <SessionReplayPage />,
  "software/events": <EventsPage />,
  "software/growth": <GrowthPage />,
  "software/activation": <ActivationPage />,
  "software/funnels": <AnalyticsFunnelsPage />,
  "software/retention": <RetentionPage />,
  "software/users-all": <AllUsersPage />,
  "software/users-segments": <SegmentsPage />,
  "software/users-cohorts": <UserCohortsPage />,
  "software/users-360": <User360Page />,
  "software/users-engagement": <EngagementPage />,
  "software/users-health-scores": <HealthScoresPage />,
  "software/users-churn": <ChurnRiskPage />,
  "software/users-funnels": <UserJourneysPage />,
  "software/users-per-user": <PerUserAnalyticsPage />,
  "software/users-groups": <GroupAnalyticsPage />,
  "software/users-journeys": <UserJourneysPage />,

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

  // HR
  "hr/overview": <HrOverviewPage />,
  "hr/employees": <HrEmployeesPage />,
  "hr/org-chart": <HrOrgChartPage />,
  "hr/leave": <HrLeavePage />,
  "hr/recruitment": <RecruitmentPage />,
  "hr/payroll": <HrPayrollPage />,

  // CRM
  "crm/overview": <CrmOverviewPage />,
  "crm/contacts": <CrmContactsPage />,
  "crm/pipeline": <CrmPipelinePage />,
  "crm/activities": <CrmActivitiesPage />,

  // Support
  "support/overview": <SupportOverviewPage />,
  "support/tickets": <SupportTicketsPage />,
  "support/analytics": <SupportAnalyticsPage />,
  "support/macros": <SupportMacrosPage />,
  "support/knowledge-base": <SupportKbPage />,

  // Projects (PM)
  "pm/boards": <PmBoardsPage />,
  "pm/my-tasks": <PmMyTasksPage />,
  "pm/inbox": <PmInboxPage />,
  "pm/whiteboard": <PmWhiteboardPage />,
  "pm/simulations": <PmSimulationsPage />,

  // Supply Chain
  "supply/overview": <ScOverviewPage />,
  "supply/inventory": <ScInventoryPage />,
  "supply/suppliers": <ScSuppliersPage />,
  "supply/purchase-orders": <ScPurchaseOrdersPage />,
  "supply/shipments": <ScShipmentsPage />,

  // Finance
  "finance-mod/overview": <FinanceOverviewPage />,
  "finance-mod/invoices": <FinanceInvoicesPage />,
  "finance-mod/expenses": <FinanceExpensesPage />,
  "finance-mod/budgets": <FinanceBudgetsPage />,

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
  "devops/security-scans": <SecurityScansPage />,

  // Health sub-tabs under SaaS Analytics
  "software/health-status": <HealthStatusPage />,
  "software/health-uptime": <UptimePage />,
  "software/health-errors": <ErrorsPage />,
  "software/health-performance": <PerformancePage />,
  "software/health-incidents": <IncidentsPage />,
  "software/health-database": <DatabasePage />,

  "software/quick-actions": <QuickActionsPage />,
  "software/user-management": <UserManagementPage />,
  "software/stripe-operations": <StripeOperationsPage />,
  "software/database-console": <DatabaseConsolePage />,
  "software/email-sender": <EmailSenderPage />,
  "software/webhooks": <ActionsWebhooksPage />,
  "software/runbooks": <RunbooksPage />,
  "software/audit-log": <AuditLogPage />,

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

/** Redirects an old /finance/:sub path to /software/:sub (same suffix). */
function LegacyFinanceRedirect() {
  const { sub } = useParams();
  return <Navigate to={`../../software/${sub}`} replace />;
}

/** SaaS Analytics was renamed/merged into the Software module. Old
 *  /saas-analytics/:sub deep links map 1:1 to /software/:sub. */
function LegacySaasRedirect() {
  const { sub } = useParams();
  return <Navigate to={`../../software/${sub}`} replace />;
}

/** The admin tools moved from Admin panel (/actions/*) into Software. These
 *  specific slugs redirect; the kept Overview tabs stay under /actions/*. */
const MOVED_ADMIN = new Set([
  "quick-actions", "user-management", "stripe-operations", "database-console",
  "email-sender", "webhooks", "runbooks", "audit-log",
]);
function LegacyActionsRedirect() {
  const { sub } = useParams();
  if (sub && MOVED_ADMIN.has(sub)) return <Navigate to={`../../software/${sub}`} replace />;
  // Unknown/overview slug → keep on the dashboard.
  return <Navigate to="../dashboard" replace />;
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
        path: "hr/opening/:openingId/:tab?",
        element: (
          <ErrorBoundary>
            <OpeningDetailPage />
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
      // Legacy redirects: Finance / SaaS Analytics merged into the Software module.
      { path: "finance", element: <Navigate to="../software/revenue" replace /> },
      { path: "finance/:sub", element: <LegacyFinanceRedirect /> },
      { path: "saas-analytics", element: <Navigate to="../software/overview" replace /> },
      { path: "saas-analytics/:sub", element: <LegacySaasRedirect /> },
      // Admin tools moved from Admin panel (/actions/*) into Software.
      { path: "actions/:sub", element: <LegacyActionsRedirect /> },
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
