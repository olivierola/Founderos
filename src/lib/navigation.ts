import {
  LayoutDashboard,
  Rocket,
  Braces,
  Brain,
  MessageSquareText,
  Plug2,
  Cog,
  BarChart3,
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
  /** When true, the PrimarySidebar pushes this module to a separate bottom group. */
  pinBottom?: boolean;
  /**
   * When true, the SecondarySidebar renders one entry per `group` (a top-level
   * "section" tab pointing at the group's first item), and a horizontal SubTabBar
   * renders the items inside the active group. Used by SaaS Analytics, where the
   * groups are the primary axis and the pages are tabs within each group.
   */
  groupsAsTabs?: boolean;
}

/** Ordered, de-duplicated list of group labels for a module (skips ungrouped items). */
export function moduleGroups(module: ModuleNavItem): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of module.subItems) {
    if (s.group && !seen.has(s.group)) {
      seen.add(s.group);
      out.push(s.group);
    }
  }
  return out;
}

/** The group a given sub-slug belongs to (carrying forward the last seen group). */
export function groupOfSlug(module: ModuleNavItem, slug: string): string | undefined {
  let current: string | undefined;
  for (const s of module.subItems) {
    if (s.group) current = s.group;
    if (s.slug === slug) return current;
  }
  return undefined;
}

/** All sub-items belonging to a group (items inherit the last declared group). */
export function itemsInGroup(module: ModuleNavItem, group: string): SubNavItem[] {
  const out: SubNavItem[] = [];
  let current: string | undefined;
  for (const s of module.subItems) {
    if (s.group) current = s.group;
    if (current === group) out.push(s);
  }
  return out;
}

export const MODULES: ModuleNavItem[] = [
  {
    slug: "actions",
    label: "Admin panel",
    icon: LayoutDashboard,
    color: "text-slate-400",
    subItems: [
      // Kept from the former Overview module.
      { label: "Dashboard", slug: "dashboard", group: "Overview" },
      { label: "Custom Dashboards", slug: "custom-dashboards" },
      { label: "Alerts", slug: "alerts" },

      // Admin tools.
      { label: "Actions Center", slug: "quick-actions", group: "Admin" },
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
    slug: "saas-analytics",
    label: "SaaS Analytics",
    icon: BarChart3,
    color: "text-violet-400/60",
    // The `group` is the primary nav axis (rendered as sidebar sections); the
    // items within each group are the horizontal tabs.
    groupsAsTabs: true,
    subItems: [
      // Overview and Session Replay are single-tab groups.
      { label: "Overview", slug: "overview", group: "Overview" },
      { label: "Session Replay", slug: "session-replay", group: "Session Replay" },

      { label: "Events",             slug: "events",               group: "Behavior" },
      { label: "Growth",             slug: "growth" },
      { label: "Funnels",            slug: "funnels" },
      { label: "Cohorts & Retention", slug: "retention" },
      { label: "Journeys",           slug: "users-journeys" },

      { label: "All Users",          slug: "users-all",            group: "Users" },
      { label: "User 360",           slug: "users-360" },
      { label: "Per-User Analytics", slug: "users-per-user" },
      { label: "Group Analytics",    slug: "users-groups" },
      { label: "Segments",           slug: "users-segments" },
      { label: "Engagement",         slug: "users-engagement" },
      { label: "Health Scores",      slug: "users-health-scores" },
      { label: "Churn Risk",         slug: "users-churn" },

      // ── merged from the former Finance module ──
      { label: "Revenue",            slug: "revenue",              group: "Revenue" },
      { label: "Transactions",       slug: "transactions" },
      { label: "MRR Movement",       slug: "mrr-movement" },
      { label: "Subscriptions",      slug: "subscriptions" },
      { label: "Customers",          slug: "customers" },
      { label: "Cohorts",            slug: "cohorts" },
      { label: "LTV by cohort",      slug: "users-cohorts" },
      { label: "Forecasting",        slug: "forecasting" },
      { label: "Investor Metrics",   slug: "investor-metrics" },
      { label: "Billing funnel",     slug: "users-funnels" },
      { label: "Reports",            slug: "reports" },

      { label: "Overview",           slug: "costs-overview",       group: "Costs" },
      { label: "Providers",          slug: "costs-providers" },
      { label: "LLM Costs",          slug: "costs-llm" },
      { label: "Cost per User",      slug: "costs-per-user" },
      { label: "Budgets",            slug: "costs-budgets" },
      { label: "Optimization",       slug: "costs-optimization" },
      { label: "Invoices",           slug: "costs-invoices" },

      { label: "App Status",         slug: "health-status",        group: "App Health" },
      { label: "Uptime",             slug: "health-uptime" },
      { label: "Errors",             slug: "health-errors" },
      { label: "Performance",        slug: "health-performance" },
      { label: "Incidents",          slug: "health-incidents" },
    ],
  },
  {
    slug: "devops",
    label: "DevOps",
    icon: Braces,
    color: "text-sky-500/55",
    // Code, Security and Ops are sidebar sections; their pages are tabs.
    groupsAsTabs: true,
    subItems: [
      // ── Code ──
      { label: "Overview", slug: "overview", group: "Code" },
      { label: "Repositories", slug: "repositories" },
      { label: "Scan Results", slug: "scan-results" },
      { label: "Compare Scans", slug: "compare-scans" },
      { label: "Architecture Map", slug: "architecture-map" },
      { label: "Dependencies", slug: "dependencies" },
      { label: "API Usage", slug: "api-usage" },
      { label: "Database Schema", slug: "database-schema" },
      { label: "Tech Debt", slug: "tech-debt" },

      // ── Security ──
      { label: "Overview", slug: "security-overview", group: "Security" },
      { label: "Risk Score", slug: "security-risk-score" },
      { label: "CVE Alerts", slug: "security-cve-alerts" },
      { label: "Secrets Detection", slug: "security-secrets" },
      { label: "License Audit", slug: "security-license-audit" },
      { label: "Compliance Watch", slug: "security-compliance" },

      // ── Ops (merged from the former Ops module) ──
      { label: "Overview", slug: "ops-overview", group: "Ops" },
      { label: "Servers", slug: "servers" },
      { label: "Deployments", slug: "deployments" },
      { label: "Workflows", slug: "workflows" },
      { label: "Checks", slug: "checks" },
      { label: "Jobs & Audit", slug: "jobs" },
      { label: "Settings", slug: "settings" },
    ],
  },
  {
    slug: "agent",
    label: "RAG Agent",
    icon: MessageSquareText,
    color: "text-white",
    subItems: [
      { label: "Agents", slug: "agents" },
      // Internal agents hidden for the first release — the AI Assistant ("AI Agent → Chat")
      // serves as the internal agent. Route is still registered so deep links work.
      // { label: "Internal agents", slug: "internal-agents" },
      { label: "Onboarding", slug: "onboarding" },
    ],
  },
  {
    slug: "ai",
    label: "AI Agent",
    icon: Brain,
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
    slug: "marketing",
    label: "Marketing",
    icon: Rocket,
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
    slug: "integrations",
    label: "Integrations",
    icon: Plug2,
    color: "text-cyan-500/55",
    pinBottom: true,
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
    icon: Cog,
    color: "text-slate-400",
    pinBottom: true,
    subItems: [
      { label: "Profile", slug: "profile" },
      { label: "Workspace", slug: "workspace" },
      { label: "Projects", slug: "projects" },
      { label: "Team", slug: "team" },
      { label: "Roles & permissions", slug: "roles" },
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
