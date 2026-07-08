import { useMemo } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
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
import { useRegisterTopbarTabs, type TopbarTab } from "./TopbarTabs";

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

/** Pre-bind a Phosphor icon to its duotone weight so the Topbar (which only
 *  passes className) still renders the premium two-tone glyph. */
function duotone(I: PhosphorIcon) {
  return function DuotoneTab({ className }: { className?: string }) {
    return <I weight="duotone" className={className} />;
  };
}

/**
 * Tabs for `groupsAsTabs` modules (AI Ops & Governance). The tabs of whichever
 * group (onglet) the active route belongs to are published INTO THE TOPBAR via
 * the TopbarTabs context — nothing renders in the page body. Safe to always
 * mount: it registers null (clearing the navbar) for modules without
 * groups-as-tabs, single-tab groups, or unknown routes.
 */
export function SubTabBar() {
  const { workspaceSlug = "default", projectSlug = "default" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const segments = location.pathname.split("/").filter(Boolean);
  const appIdx = segments.indexOf("app");
  const moduleSlug = appIdx >= 0 ? segments[appIdx + 3] : undefined;
  const activeSlug = appIdx >= 0 ? segments[appIdx + 4] : undefined;
  const base = `/app/${workspaceSlug}/${projectSlug}`;

  const module = moduleSlug ? findModule(moduleSlug) : undefined;
  const group = module?.groupsAsTabs && activeSlug ? groupOfSlug(module, activeSlug) : undefined;

  const tabs = useMemo<TopbarTab[] | null>(() => {
    if (!module || !group) return null;
    const items = itemsInGroup(module, group);
    // A single-tab group (e.g. Vue d'ensemble) needs no tab bar.
    if (items.length <= 1) return null;
    return items.map((it) => ({
      key: it.slug,
      label: it.label,
      icon: it.icon ? duotone(it.icon) : TAB_ICONS[it.slug],
    }));
  }, [module, group]);

  useRegisterTopbarTabs(tabs, activeSlug ?? "", (slug) => {
    if (module) navigate(`${base}/${module.slug}/${slug}`);
  });

  return null;
}
