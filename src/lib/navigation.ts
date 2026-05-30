import {
  LayoutDashboard,
  LineChart,
  Megaphone,
  Code2,
  Zap,
  Sparkle,
  Bot,
  Plug,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface SubNavItem {
  label: string;
  slug: string;
  /** Optional section label. When set, the SecondarySidebar renders a divider + label above this item. */
  group?: string;
  /** Optional slug of the parent sub-item; when set, this item is a nested child rendered inside an accordion. */
  parent?: string;
}

export interface ModuleNavItem {
  slug: string;
  label: string;
  icon: LucideIcon;
  /** Tailwind text color class for the module icon (soft, per-module hue) */
  color: string;
  subItems: SubNavItem[];
}

export const MODULES: ModuleNavItem[] = [
  {
    slug: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    color: "text-slate-400",
    subItems: [
      { label: "Dashboard", slug: "dashboard" },
      { label: "Custom Dashboards", slug: "custom-dashboards" },
      { label: "Alerts", slug: "alerts" },
      { label: "Daily Briefing", slug: "daily-briefing" },
      { label: "Activity Feed", slug: "activity-feed" },
      { label: "Multi-projects", slug: "multi-projects" },
    ],
  },
  {
    slug: "finance",
    label: "Finance",
    icon: LineChart,
    color: "text-emerald-500/55",
    subItems: [
      { label: "Revenue", slug: "revenue", group: "Revenue" },
      { label: "Transactions", slug: "transactions" },
      { label: "MRR Movement", slug: "mrr-movement" },
      { label: "Subscriptions", slug: "subscriptions" },
      { label: "Customers", slug: "customers" },
      { label: "Cohorts", slug: "cohorts" },
      { label: "Forecasting", slug: "forecasting" },
      { label: "Investor Metrics", slug: "investor-metrics" },
      { label: "Reports", slug: "reports" },
      { label: "Overview", slug: "costs-overview", group: "Costs" },
      { label: "Providers", slug: "costs-providers" },
      { label: "LLM Costs", slug: "costs-llm" },
      { label: "Cost per User", slug: "costs-per-user" },
      { label: "Budgets", slug: "costs-budgets" },
      { label: "Optimization", slug: "costs-optimization" },
      { label: "Invoices", slug: "costs-invoices" },
    ],
  },
  {
    slug: "marketing",
    label: "Marketing",
    icon: Megaphone,
    color: "text-fuchsia-400/55",
    subItems: [
      { label: "Overview", slug: "overview" },
      { label: "Content Studio", slug: "content-studio" },
      { label: "Calendar", slug: "calendar" },
      { label: "Campaigns", slug: "campaigns" },
      { label: "Channels", slug: "channels" },
      { label: "Analytics", slug: "analytics" },
      { label: "Advisor", slug: "advisor" },
    ],
  },
  {
    slug: "code",
    label: "Code",
    icon: Code2,
    color: "text-sky-500/55",
    subItems: [
      { label: "Overview", slug: "overview", group: "Code" },
      { label: "Repositories", slug: "repositories" },
      { label: "Scan Results", slug: "scan-results" },
      { label: "Compare Scans", slug: "compare-scans" },
      { label: "Architecture Map", slug: "architecture-map" },
      { label: "Dependencies", slug: "dependencies" },
      { label: "API Usage", slug: "api-usage" },
      { label: "Database Schema", slug: "database-schema" },
      { label: "Tech Debt", slug: "tech-debt" },
      { label: "Overview", slug: "security-overview", group: "Security" },
      { label: "Risk Score", slug: "security-risk-score" },
      { label: "CVE Alerts", slug: "security-cve-alerts" },
      { label: "Secrets Detection", slug: "security-secrets" },
      { label: "License Audit", slug: "security-license-audit" },
      { label: "Compliance Watch", slug: "security-compliance" },
    ],
  },
  {
    slug: "actions",
    label: "Actions",
    icon: Zap,
    color: "text-slate-400",
    subItems: [
      { label: "Actions Center", slug: "quick-actions" },

      // SaaS Analytics parent + nested tabs (rendered as accordion in the sidebar).
      { label: "SaaS Analytics", slug: "saas-analytics" },
      { label: "All Users",         slug: "users-all",            parent: "saas-analytics" },
      { label: "User 360",          slug: "users-360",            parent: "saas-analytics" },
      { label: "Per-User Analytics", slug: "users-per-user",      parent: "saas-analytics" },
      { label: "Group Analytics",   slug: "users-groups",         parent: "saas-analytics" },
      { label: "Segments",          slug: "users-segments",       parent: "saas-analytics" },
      { label: "Cohorts & LTV",     slug: "users-cohorts",        parent: "saas-analytics" },
      { label: "Journeys",          slug: "users-journeys",       parent: "saas-analytics" },
      { label: "Engagement",        slug: "users-engagement",     parent: "saas-analytics" },
      { label: "Health Scores",     slug: "users-health-scores",  parent: "saas-analytics" },
      { label: "Churn Risk",        slug: "users-churn",          parent: "saas-analytics" },
      { label: "Funnels",           slug: "users-funnels",        parent: "saas-analytics" },
      { label: "App Status",        slug: "health-status",        parent: "saas-analytics" },
      { label: "Uptime",            slug: "health-uptime",        parent: "saas-analytics" },
      { label: "Errors",            slug: "health-errors",        parent: "saas-analytics" },
      { label: "Performance",       slug: "health-performance",   parent: "saas-analytics" },
      { label: "Deployments",       slug: "health-deployments",   parent: "saas-analytics" },
      { label: "Incidents",         slug: "health-incidents",     parent: "saas-analytics" },

      { label: "Approvals", slug: "approvals" },
      { label: "User Management", slug: "user-management" },
      { label: "Billing Operations", slug: "stripe-operations" },
      { label: "Database Console", slug: "database-console" },
      { label: "Email Sender", slug: "email-sender" },
      { label: "Webhooks", slug: "webhooks" },
      { label: "Runbooks", slug: "runbooks" },
      { label: "Audit Log", slug: "audit-log" },
    ],
  },
  {
    slug: "agent",
    label: "RAG Agent",
    icon: Bot,
    color: "text-white",
    subItems: [
      { label: "Agents", slug: "agents" },
    ],
  },
  {
    slug: "ai",
    label: "AI Agent",
    icon: Sparkle,
    color: "text-primary/60",
    subItems: [
      { label: "Insights", slug: "insights" },
      { label: "Reports", slug: "reports" },
      { label: "Workflows", slug: "workflows" },
      { label: "Prompt Templates", slug: "prompt-templates" },
      { label: "Guardrails", slug: "guardrails" },
      { label: "Chat", slug: "chat" },
    ],
  },
  {
    slug: "integrations",
    label: "Integrations",
    icon: Plug,
    color: "text-cyan-500/55",
    subItems: [
      { label: "Connected", slug: "connected" },
      { label: "Catalog", slug: "catalog" },
      { label: "Credentials Vault", slug: "credentials-vault" },
      { label: "API Keys", slug: "api-keys" },
      { label: "Webhooks", slug: "webhooks" },
      { label: "n8n / Make / Zapier", slug: "automation" },
    ],
  },
  {
    slug: "settings",
    label: "Settings",
    icon: Settings,
    color: "text-slate-400",
    subItems: [
      { label: "Profile", slug: "profile" },
      { label: "Workspace", slug: "workspace" },
      { label: "Projects", slug: "projects" },
      { label: "Team", slug: "team" },
      { label: "Billing", slug: "billing" },
      { label: "Notifications", slug: "notifications" },
      { label: "Security", slug: "security" },
      { label: "Data & Privacy", slug: "data-privacy" },
    ],
  },
];

export function findModule(slug: string) {
  return MODULES.find((m) => m.slug === slug);
}
