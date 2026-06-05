import { NavLink, useLocation, useParams } from "react-router-dom";
import {
  Activity,
  BarChart3,
  Filter,
  Grid3x3,
  Route as RouteIcon,
  Users,
  UserCircle,
  Boxes,
  Layers,
  Heart,
  TrendingDown,
  DollarSign,
  Receipt,
  Repeat,
  UserPlus,
  Coins,
  Server,
  Gauge,
  AlertTriangle,
  Wallet,
  PiggyBank,
  Cpu,
  FileText,
  LayoutDashboard,
  GitBranch,
  ScanLine,
  GitCompare,
  Network,
  Package,
  Plug,
  Database,
  Bug,
  ShieldAlert,
  KeyRound,
  ScrollText,
  Workflow,
  CheckSquare,
  ListChecks,
  Settings as SettingsIcon,
  Rocket,
  type LucideIcon,
} from "lucide-react";
import { findModule, groupOfSlug, itemsInGroup } from "@/lib/navigation";
import { cn } from "@/lib/utils";

// A small icon per tab slug — keeps the bar visually close to the reference
// design. Unknown slugs fall back to a neutral dot (no icon).
const TAB_ICONS: Record<string, LucideIcon> = {
  // Behavior
  events: Activity,
  growth: BarChart3,
  funnels: Filter,
  retention: Grid3x3,
  "users-journeys": RouteIcon,
  // Users
  "users-all": Users,
  "users-360": UserCircle,
  "users-per-user": UserCircle,
  "users-groups": Boxes,
  "users-segments": Layers,
  "users-engagement": Activity,
  "users-health-scores": Heart,
  "users-churn": TrendingDown,
  // Revenue
  revenue: DollarSign,
  transactions: Receipt,
  "mrr-movement": Repeat,
  subscriptions: Repeat,
  customers: Users,
  cohorts: Grid3x3,
  "users-cohorts": Grid3x3,
  forecasting: TrendingDown,
  "investor-metrics": BarChart3,
  "users-funnels": Filter,
  reports: FileText,
  // Costs
  "costs-overview": Wallet,
  "costs-providers": Server,
  "costs-llm": Cpu,
  "costs-per-user": UserPlus,
  "costs-budgets": PiggyBank,
  "costs-optimization": Coins,
  "costs-invoices": Receipt,
  // App Health
  "health-status": Gauge,
  "health-uptime": Activity,
  "health-errors": AlertTriangle,
  "health-performance": Gauge,
  "health-incidents": AlertTriangle,

  // ── DevOps: Code ──
  overview: LayoutDashboard,
  repositories: GitBranch,
  "scan-results": ScanLine,
  "compare-scans": GitCompare,
  "architecture-map": Network,
  dependencies: Package,
  "api-usage": Plug,
  "database-schema": Database,
  "tech-debt": Bug,
  // ── DevOps: Security ──
  "security-overview": ShieldAlert,
  "security-risk-score": Gauge,
  "security-cve-alerts": AlertTriangle,
  "security-secrets": KeyRound,
  "security-license-audit": ScrollText,
  "security-compliance": FileText,
  // ── DevOps: Ops ──
  "ops-overview": LayoutDashboard,
  servers: Server,
  deployments: Rocket,
  workflows: Workflow,
  checks: CheckSquare,
  jobs: ListChecks,
  settings: SettingsIcon,
};

/**
 * Compact, in-page horizontal tab bar for `groupsAsTabs` modules (SaaS
 * Analytics). Renders the tabs for whichever group the active route belongs to.
 * Left-aligned, with a thin underline under the active tab. Returns null for
 * modules that don't use the groups-as-tabs layout, so it's safe to always mount.
 */
export function SubTabBar() {
  const { workspaceSlug = "default", projectSlug = "default" } = useParams();
  const location = useLocation();

  const segments = location.pathname.split("/").filter(Boolean);
  const appIdx = segments.indexOf("app");
  const moduleSlug = appIdx >= 0 ? segments[appIdx + 3] : undefined;
  const activeSlug = appIdx >= 0 ? segments[appIdx + 4] : undefined;
  const base = `/app/${workspaceSlug}/${projectSlug}`;

  const module = moduleSlug ? findModule(moduleSlug) : undefined;
  if (!module || !module.groupsAsTabs || !activeSlug) return null;

  const group = groupOfSlug(module, activeSlug);
  if (!group) return null;

  const items = itemsInGroup(module, group);
  // A single-tab group (e.g. Overview, Session Replay) needs no tab bar.
  if (items.length <= 1) return null;

  return (
    <div className="mb-5 flex items-center gap-1 overflow-x-auto border-b border-border">
      {items.map((it) => {
        const Icon = TAB_ICONS[it.slug];
        return (
          <NavLink
            key={it.slug}
            to={`${base}/${module.slug}/${it.slug}`}
            className={({ isActive }) =>
              cn(
                "relative inline-flex shrink-0 items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors",
                isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )
            }
          >
            {({ isActive }) => (
              <>
                {Icon && <Icon className="h-4 w-4" />}
                {it.label}
                {isActive && (
                  <span className="absolute -bottom-px left-2 right-2 h-0.5 rounded-t bg-[hsl(var(--primary-soft))]" />
                )}
              </>
            )}
          </NavLink>
        );
      })}
    </div>
  );
}
