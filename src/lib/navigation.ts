import {
  ShieldHalf,
  Megaphone,
  TerminalSquare,
  AppWindow,
  BrainCircuit,
  Blocks,
  Settings2,
  FileStack,
  UsersRound,
  Handshake,
  LifeBuoy,
  FolderKanban,
  Wallet,
  Truck,
  Shapes,
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
    slug: "assets",
    label: "Assets",
    icon: Shapes,
    color: "text-indigo-400/60",
    subItems: [
      { label: "Asset map", slug: "map" },
    ],
  },
  {
    slug: "actions",
    label: "Admin panel",
    icon: ShieldHalf,
    color: "text-slate-400",
    subItems: [
      // Overview cockpit (the admin tools moved to the Software module).
      { label: "Dashboard", slug: "dashboard", group: "Overview" },
      { label: "Custom Dashboards", slug: "custom-dashboards" },
      { label: "Alerts", slug: "alerts" },
    ],
  },
  {
    slug: "software",
    label: "Software",
    icon: AppWindow,
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
      { label: "Activation",         slug: "activation" },
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

      // ── Admin tools (merged from the former Admin panel) ──
      { label: "Actions Center",     slug: "quick-actions",        group: "Admin" },
      { label: "User Management",    slug: "user-management" },
      { label: "Billing Operations", slug: "stripe-operations" },
      { label: "Database Console",   slug: "database-console" },
      { label: "Email Sender",       slug: "email-sender" },
      { label: "Webhooks",           slug: "webhooks" },
      { label: "Runbooks",           slug: "runbooks" },
      { label: "Audit Log",          slug: "audit-log" },
    ],
  },
  {
    slug: "devops",
    label: "DevOps",
    icon: TerminalSquare,
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
      { label: "Scans & Pentest", slug: "security-scans" },

      // ── Ops (merged from the former Ops module) ──
      { label: "Overview", slug: "ops-overview", group: "Ops" },
      { label: "Servers", slug: "servers" },
      { label: "Deployments", slug: "deployments" },
      { label: "Workflows", slug: "workflows" },
      { label: "Checks", slug: "checks" },
      { label: "Jobs & Audit", slug: "jobs" },
      { label: "Settings", slug: "settings" },

      // ── Testing (agentic E2E) ──
      { label: "E2E Tests", slug: "testing", group: "Testing" },
    ],
  },
  {
    slug: "agent",
    label: "RAG Agent",
    icon: BrainCircuit,
    color: "text-white",
    subItems: [
      { label: "Public agents", slug: "agents", group: "Agents" },
      { label: "Autonomous agents", slug: "internal-agents" },
      { label: "Agent ecosystem", slug: "ecosystem" },
      { label: "Tasks", slug: "tasks" },
      { label: "Onboarding", slug: "onboarding" },

      // ── Centralised knowledge bases ("RAG centers") reusable across agents. ──
      { label: "RAG Center", slug: "knowledge", group: "Knowledge" },

      // ── AI Agent tools (the Assistant "Chat" now lives in the global
      //    top-bar panel, so it's intentionally not listed here; route kept). ──
      { label: "Insights", slug: "insights", group: "AI Agent" },
      { label: "Reports", slug: "reports" },
      { label: "Workflows", slug: "workflows" },
      { label: "Prompt Templates", slug: "prompt-templates" },
      { label: "Guardrails", slug: "guardrails" },
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
    slug: "office",
    label: "Création",
    icon: FileStack,
    color: "text-orange-400/60",
    subItems: [
      { label: "Library", slug: "library", group: "Documents" },
      { label: "Documents", slug: "documents", group: "Documents" },
      { label: "Spreadsheets", slug: "spreadsheets", group: "Documents" },
      { label: "Presentations", slug: "presentations", group: "Documents" },
      { label: "Image studio", slug: "gen-image", group: "Gen AI" },
      { label: "Video studio", slug: "gen-video", group: "Gen AI" },
      { label: "Copywriter", slug: "gen-copy", group: "Gen AI" },
    ],
  },
  {
    slug: "hr",
    label: "RH",
    icon: UsersRound,
    color: "text-teal-400/60",
    subItems: [
      { label: "Overview", slug: "overview" },
      { label: "Employees", slug: "employees" },
      { label: "Org chart", slug: "org-chart" },
      { label: "Leave & absences", slug: "leave" },
      { label: "Recruitment", slug: "recruitment" },
      { label: "Onboarding", slug: "onboarding" },
      { label: "Payroll & docs", slug: "payroll" },
    ],
  },
  {
    slug: "crm",
    label: "CRM",
    icon: Handshake,
    color: "text-emerald-400/60",
    subItems: [
      { label: "Overview", slug: "overview" },
      { label: "Contacts", slug: "contacts" },
      { label: "Pipeline", slug: "pipeline" },
      { label: "Activities", slug: "activities" },
    ],
  },
  {
    slug: "support",
    label: "Support",
    icon: LifeBuoy,
    color: "text-sky-400/60",
    subItems: [
      { label: "Overview", slug: "overview", group: "Inbox" },
      { label: "Tickets", slug: "tickets" },
      { label: "Call center", slug: "calls" },
      { label: "Analytics", slug: "analytics" },

      { label: "Knowledge base", slug: "knowledge-base", group: "Self-service" },
      { label: "Help center portal", slug: "portal" },
      { label: "Macros", slug: "macros" },

      { label: "Channels", slug: "channels", group: "Configuration" },
      { label: "SLA & routing", slug: "sla-routing" },
    ],
  },
  {
    slug: "pm",
    label: "Projets",
    icon: FolderKanban,
    color: "text-amber-400/60",
    subItems: [
      { label: "Boards", slug: "boards", group: "Delivery" },
      { label: "Gantt", slug: "gantt", group: "Delivery" },
      { label: "My tasks", slug: "my-tasks", group: "Delivery" },
      { label: "Timesheets", slug: "timesheets", group: "PSA" },
      { label: "Resourcing", slug: "resourcing", group: "PSA" },
      { label: "Profitability", slug: "profitability", group: "PSA" },
      { label: "Inbox", slug: "inbox", group: "Collaboration" },
      { label: "Whiteboard", slug: "whiteboard", group: "Collaboration" },
      { label: "Simulations", slug: "simulations", group: "Collaboration" },
    ],
  },
  {
    slug: "supply",
    label: "Supply Chain",
    icon: Truck,
    color: "text-orange-400/60",
    subItems: [
      { label: "Control tower", slug: "overview", group: "Visibility" },
      { label: "Inventory", slug: "inventory", group: "Operations" },
      { label: "Sales orders", slug: "sales-orders", group: "Operations" },
      { label: "Returns (RMA)", slug: "returns", group: "Operations" },
      { label: "Purchase orders", slug: "purchase-orders", group: "Procurement" },
      { label: "Suppliers", slug: "suppliers", group: "Procurement" },
      { label: "Shipments", slug: "shipments", group: "Logistics" },
    ],
  },
  {
    slug: "finance-mod",
    label: "Finance",
    icon: Wallet,
    color: "text-lime-400/60",
    subItems: [
      { label: "Overview", slug: "overview", group: "Reporting" },
      { label: "Reporting", slug: "reporting", group: "Reporting" },
      { label: "Budgets", slug: "budgets", group: "Reporting" },
      { label: "Invoices (AR)", slug: "invoices", group: "Receivable" },
      { label: "Bills (AP)", slug: "bills", group: "Payable" },
      { label: "Expenses", slug: "expenses", group: "Payable" },
      { label: "Treasury", slug: "treasury", group: "Cash" },
      { label: "General ledger", slug: "ledger", group: "Accounting" },
    ],
  },
  {
    slug: "integrations",
    label: "Integrations",
    icon: Blocks,
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
    icon: Settings2,
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
