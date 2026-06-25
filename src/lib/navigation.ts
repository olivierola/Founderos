import {
  TerminalSquare,
  AppWindow,
  BrainCircuit,
  Blocks,
  Settings2,
  FileStack,
  Handshake,
  LifeBuoy,
  FolderKanban,
  Wallet,
  Truck,
  Shapes,
  LayoutDashboard,
  FlaskConical,
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
    slug: "hq",
    label: "AI HQ",
    icon: LayoutDashboard,
    color: "text-primary",
    subItems: [
      { label: "Dashboard", slug: "dashboard" },
    ],
  },
  {
    slug: "projects",
    label: "Projects",
    icon: FolderKanban,
    color: "text-amber-400/60",
    subItems: [
      { label: "All projects", slug: "all" },
    ],
  },
  {
    slug: "simulations",
    label: "Simulations",
    icon: FlaskConical,
    color: "text-violet-400/60",
    subItems: [
      { label: "Simulations", slug: "list" },
    ],
  },
  {
    slug: "crm",
    label: "CRM",
    icon: Handshake,
    color: "text-emerald-400/60",
    subItems: [
      { label: "Records", slug: "workspace", group: "CRM" },
      { label: "Dashboard", slug: "admin-dashboard", group: "Admin" },
      { label: "Custom Dashboards", slug: "admin-custom-dashboards" },
      { label: "Alerts", slug: "admin-alerts" },
    ],
  },
  {
    slug: "agent",
    label: "AI Workforce",
    icon: BrainCircuit,
    color: "text-white",
    subItems: [
      { label: "Agents", slug: "internal-agents" },
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
