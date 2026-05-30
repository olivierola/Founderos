import {
  LayoutDashboard,
  LineChart,
  Users,
  Megaphone,
  Code2,
  Activity,
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
    slug: "users",
    label: "Users",
    icon: Users,
    color: "text-indigo-400/55",
    subItems: [
      { label: "All Users", slug: "all-users" },
      { label: "Segments", slug: "segments" },
      { label: "Cohorts & LTV", slug: "cohorts-ltv" },
      { label: "User 360", slug: "user-360" },
      { label: "Engagement", slug: "engagement" },
      { label: "Health Scores", slug: "health-scores" },
      { label: "Churn Risk", slug: "churn-risk" },
      { label: "Funnels", slug: "funnels" },
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
    slug: "health",
    label: "Health",
    icon: Activity,
    color: "text-teal-500/55",
    subItems: [
      { label: "Status", slug: "status" },
      { label: "Uptime", slug: "uptime" },
      { label: "Errors", slug: "errors" },
      { label: "Performance", slug: "performance" },
      { label: "Deployments", slug: "deployments" },
      { label: "Incidents", slug: "incidents" },
    ],
  },
  {
    slug: "actions",
    label: "Actions",
    icon: Zap,
    color: "text-slate-400",
    subItems: [
      { label: "Actions Center", slug: "quick-actions" },
      { label: "SaaS Analytics", slug: "saas-analytics" },
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
