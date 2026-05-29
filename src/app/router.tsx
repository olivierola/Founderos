import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ProtectedRoute } from "./ProtectedRoute";
import { LoginPage } from "@/features/auth/Login";
import { SignupPage } from "@/features/auth/Signup";
import { OnboardingPage } from "@/features/auth/Onboarding";
import { AcceptInvitePage } from "@/features/auth/AcceptInvite";
import { OrganisationsPage } from "@/features/orgs/Organisations";
import { ProjectsPage } from "@/features/orgs/Projects";

// Overview
import { OverviewDashboard } from "@/features/overview/Dashboard";
import { AlertsPage } from "@/features/overview/Alerts";
import { ActivityFeedPage } from "@/features/overview/ActivityFeed";
import { DailyBriefingPage } from "@/features/overview/DailyBriefing";
import { MultiProjectsPage } from "@/features/overview/MultiProjects";
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
  FunnelsPage,
} from "@/features/users/Extra";
import { EngagementPage } from "@/features/users/Engagement";

import { RagAgentsPage } from "@/features/agent-rag/Agents";
import { AgentBuilderPage } from "@/features/agent-rag/AgentBuilder";

import { ContentStudioPage } from "@/features/marketing/ContentStudio";
import {
  MarketingOverviewPage,
  MarketingCalendarPage,
  MarketingChannelsPage,
  MarketingAnalyticsPage,
  MarketingCampaignsPage,
  MarketingAdvisorPage,
} from "@/features/marketing/Extra";

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
  ApprovalsPage,
} from "@/features/actions/Extra";
import { RunbooksPage } from "@/features/actions/Runbooks";

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
import { SettingsBillingPage } from "@/features/settings/Billing";
import { SettingsSecurityPage } from "@/features/settings/Security2FA";
import { SettingsDataPrivacyPage } from "@/features/settings/DataPrivacy";

import { GenericSubPage } from "@/features/GenericSubPage";
import { MODULES } from "@/lib/navigation";

type PageEl = JSX.Element;

const PAGES: Record<string, PageEl> = {
  "overview/dashboard": <OverviewDashboard />,
  "overview/custom-dashboards": <CustomDashboardsPage />,
  "overview/alerts": <AlertsPage />,
  "overview/activity-feed": <ActivityFeedPage />,
  "overview/daily-briefing": <DailyBriefingPage />,
  "overview/multi-projects": <MultiProjectsPage />,

  "finance/revenue": <RevenuePage />,
  "finance/transactions": <TransactionsPage />,
  "finance/mrr-movement": <MrrMovementPage />,
  "finance/customers": <CustomersPage />,
  "finance/subscriptions": <SubscriptionsPage />,
  "finance/cohorts": <CohortsPage />,
  "finance/forecasting": <ForecastingPage />,
  "finance/investor-metrics": <InvestorMetricsPage />,
  "finance/reports": <FinanceReportsPage />,

  "costs/overview": <CostsOverviewPage />,
  "costs/providers": <CostsProvidersPage />,
  "costs/llm-costs": <LlmCostsPage />,
  "costs/optimization": <OptimizationPage />,
  "costs/cost-per-user": <CostPerUserPage />,
  "costs/budgets": <BudgetsPage />,
  "costs/invoices": <InvoicesPage />,

  "users/all-users": <AllUsersPage />,
  "users/segments": <SegmentsPage />,
  "users/cohorts-ltv": <UserCohortsPage />,
  "users/user-360": <User360Page />,
  "users/engagement": <EngagementPage />,
  "users/health-scores": <HealthScoresPage />,
  "users/churn-risk": <ChurnRiskPage />,
  "users/funnels": <FunnelsPage />,

  "agent/agents": <RagAgentsPage />,

  "marketing/overview": <MarketingOverviewPage />,
  "marketing/content-studio": <ContentStudioPage />,
  "marketing/calendar": <MarketingCalendarPage />,
  "marketing/campaigns": <MarketingCampaignsPage />,
  "marketing/channels": <MarketingChannelsPage />,
  "marketing/analytics": <MarketingAnalyticsPage />,
  "marketing/advisor": <MarketingAdvisorPage />,

  "code/overview": <CodeOverviewPage />,
  "code/repositories": <RepositoriesPage />,
  "code/scan-results": <ScanResultsPage />,
  "code/compare-scans": <ScanComparePage />,
  "code/architecture-map": <ArchitectureMapPage />,
  "code/dependencies": <DependenciesPage />,
  "code/api-usage": <ApiUsagePage />,
  "code/database-schema": <DatabaseSchemaPage />,
  "code/tech-debt": <TechDebtPage />,

  "security/overview": <SecurityFindingsPage filter="all" />,
  "security/cve-alerts": <CveAlertsPage />,
  "security/secrets-detection": <SecretsDetectionPage />,
  "security/risk-score": <RiskScorePage />,
  "security/license-audit": <LicenseAuditPage />,
  "security/compliance-watch": <ComplianceWatchPage />,

  "health/status": <HealthStatusPage />,
  "health/uptime": <UptimePage />,
  "health/errors": <ErrorsPage />,
  "health/performance": <PerformancePage />,
  "health/deployments": <DeploymentsPage />,
  "health/incidents": <IncidentsPage />,
  "health/database": <DatabasePage />,

  "actions/quick-actions": <QuickActionsPage />,
  "actions/approvals": <ApprovalsPage />,
  "actions/user-management": <UserManagementPage />,
  "actions/stripe-operations": <StripeOperationsPage />,
  "actions/database-console": <DatabaseConsolePage />,
  "actions/email-sender": <EmailSenderPage />,
  "actions/webhooks": <ActionsWebhooksPage />,
  "actions/runbooks": <RunbooksPage />,
  "actions/audit-log": <AuditLogPage />,

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
  "settings/billing": <SettingsBillingPage />,
  "settings/notifications": <SettingsNotificationsPage />,
  "settings/security": <SettingsSecurityPage />,
  "settings/data-privacy": <SettingsDataPrivacyPage />,
};

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
  { path: "/", element: <Navigate to="/login" replace /> },
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
      { index: true, element: <Navigate to="overview/dashboard" replace /> },
      {
        path: "overview/dashboard-builder/:dashboardId",
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
      ...buildModuleRoutes(),
    ],
  },
  { path: "*", element: <Navigate to="/login" replace /> },
]);
