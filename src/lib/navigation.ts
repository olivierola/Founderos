import {
  SparkleIcon,
  KanbanIcon,
  AtomIcon,
  HandshakeIcon,
  RobotIcon,
  ScalesIcon,
  PuzzlePieceIcon,
  GearSixIcon,
  GaugeIcon,
  ChartPieIcon,
  BellIcon,
  TableIcon,
  SquaresFourIcon,
  BooksIcon,
  WarningIcon,
  ScrollIcon,
  EyeIcon,
  WalletIcon,
  HardDrivesIcon,
  PulseIcon,
  WarningOctagonIcon,
  GraduationCapIcon,
  CircuitryIcon,
  StackIcon,
  ExamIcon,
  FlaskIcon,
  CubeIcon,
  RocketIcon,
  CoinsIcon,
  BroomIcon,
  TagIcon,
  TestTubeIcon,
  ChartLineUpIcon,
  ShieldStarIcon,
  FadersIcon,
  SealCheckIcon,
  SirenIcon,
  DatabaseIcon,
  ClockCounterClockwiseIcon,
  PlugsConnectedIcon,
  GlobeIcon,
  FlowArrowIcon,
  UserCircleIcon,
  BuildingsIcon,
  UsersThreeIcon,
  ShieldCheckIcon,
  CreditCardIcon,
  LockKeyIcon,
  FingerprintIcon,
  GithubLogoIcon,
  MagicWandIcon,
  MonitorIcon,
  GitPullRequestIcon,
  GitForkIcon,
  TargetIcon,
  FileTextIcon,
  PencilLineIcon,
  type Icon,
} from "@phosphor-icons/react";

export interface SubNavItem {
  label: string;
  slug: string;
  /** Duotone (Phosphor) icon rendered beside the tab label in the SecondarySidebar. */
  icon?: Icon;
  /** Optional section label. When set, the SecondarySidebar renders a divider + label above this item. */
  group?: string;
  /** Optional slug of the parent sub-item; when set, this item is a nested child rendered inside an accordion. */
  parent?: string;
}

/**
 * Product zones — the top-level story the PrimarySidebar tells, top to bottom.
 * RUN = where the AI workforce does the work · CONTROL = the governance/control
 * plane an enterprise buyer (RSSI / Head of AI) signs off on · CONNECT = the
 * hands (integrations) and the workspace/security settings.
 */
export type ZoneId = "run" | "control" | "connect";

export interface Zone {
  id: ZoneId;
  /** Short label rendered above the zone's icons in the rail. */
  label: string;
  /** When true, the rail visually emphasises this zone (the deluxe/control-plane pitch). */
  emphasis?: boolean;
}

export const ZONES: Zone[] = [
  { id: "run", label: "Run" },
  { id: "control", label: "Control", emphasis: true },
  { id: "connect", label: "Connect" },
];

/**
 * Dashboards — the top-level context switch. Every dashboard shares the exact
 * same shell (navbar + two sidebars); only the set of modules shown in the
 * PrimarySidebar changes. Modules tagged "both" appear in every dashboard.
 *
 * "Outils IA" and "Data & Simulations" were retired: the tools they exposed as
 * modules (vibe code, test runs, simulations) are now owned by SPECIALIZED
 * AGENTS — a studio agent drives the same engine and hands back a structured
 * session artifact. Their pages stay routed via HIDDEN_MODULES so deep links
 * and configuration surfaces keep working; they're simply no longer a place you
 * navigate to. The remaining dashboards are "workforce" and the per-service
 * dashboards created by users.
 */
export type DashboardId = "workforce";
export const DEFAULT_DASHBOARD: DashboardId = "workforce";

export interface DashboardDef {
  id: DashboardId;
  label: string;
  description: string;
  icon: Icon;
  /** Tailwind bg class for the icon tile in the switcher. */
  color: string;
}
export const DASHBOARDS: DashboardDef[] = [
  { id: "workforce", label: "AI Workforce", description: "Vos agents IA au travail", icon: RobotIcon, color: "bg-primary" },
];

export interface ModuleNavItem {
  slug: string;
  label: string;
  icon: Icon;
  /** Tailwind text color class for the module icon (soft, per-module hue) */
  color: string;
  subItems: SubNavItem[];
  /** Which product zone this module belongs to in the PrimarySidebar (defaults to "run"). */
  zone?: ZoneId;
  /** Which dashboard this module belongs to (defaults to "workforce"). "both"
   *  shows it in every dashboard (e.g. Integrations, Settings). */
  dashboard?: DashboardId | "both";
  /**
   * When true, the SecondarySidebar renders one entry per `group` (a top-level
   * "section" tab pointing at the group's first item), and a horizontal SubTabBar
   * renders the items inside the active group. Used by SaaS Analytics, where the
   * groups are the primary axis and the pages are tabs within each group.
   */
  groupsAsTabs?: boolean;
}

/** Modules belonging to a zone, optionally filtered to a dashboard. */
export function modulesInZone(id: ZoneId, dashboard?: DashboardId): ModuleNavItem[] {
  return MODULES.filter((m) =>
    (m.zone ?? "run") === id &&
    (!dashboard || (m.dashboard ?? "workforce") === dashboard || m.dashboard === "both"));
}

/** The dashboard a module belongs to ("workforce" by default). */
export function dashboardOfModule(slug: string | undefined): DashboardId | "both" {
  if (!slug) return DEFAULT_DASHBOARD;
  return MODULES.find((m) => m.slug === slug)?.dashboard ?? DEFAULT_DASHBOARD;
}

/** The landing route slug of a dashboard = its first non-shared module. */
export function dashboardLandingSlug(id: DashboardId): string {
  const first = MODULES.find((m) => (m.dashboard ?? "workforce") === id);
  return first?.slug ?? "hq";
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

/** The 3 AI-control-plane modules (share the same page namespace). */
const AIOPS_MODULE_SLUGS = ["governance", "aiops", "finetuning"];
/** Full path to an AI Ops/Governance/Fine-tuning tab, resolving which of the 3
 *  modules owns it — so cross-module links keep working after the split. */
export function aiopsTabPath(ws: string, proj: string, slug: string): string {
  const mod = MODULES.find((m) => AIOPS_MODULE_SLUGS.includes(m.slug) && m.subItems.some((s) => s.slug === slug));
  return `/app/${ws}/${proj}/${mod?.slug ?? "governance"}/${slug}`;
}

export const MODULES: ModuleNavItem[] = [
  // ── Zone RUN — where the AI workforce does the work ──────────────────────
  {
    slug: "hq",
    label: "AI HQ",
    icon: SparkleIcon,
    color: "text-primary",
    zone: "run",
    subItems: [
      { label: "Dashboard", slug: "dashboard", icon: GaugeIcon },
    ],
  },
  {
    slug: "agent",
    label: "AI Workforce",
    icon: RobotIcon,
    color: "text-white",
    zone: "run",
    // Two parts of the same workforce: internal agents (private team workers)
    // and public agents (customer-facing — SAV, e-commerce, onboarding, guides).
    subItems: [
      { label: "Agents internes", slug: "internal-agents", group: "Internes", icon: RobotIcon },
      { label: "Agents publics", slug: "public-agents", group: "Publics", icon: GlobeIcon },
      { label: "Base de connaissances", slug: "collections", group: "Connaissances", icon: BooksIcon },
      { label: "Custom Skills", slug: "skills", group: "Compétences", icon: PuzzlePieceIcon },
      { label: "MCP Servers", slug: "mcp", group: "MCP", icon: PlugsConnectedIcon },
    ],
  },
  {
    slug: "crm",
    label: "CRM",
    icon: HandshakeIcon,
    color: "text-emerald-400/60",
    zone: "run",
    // Projects live inside the CRM as records now (the standalone Projects
    // super-module was retired). Simulations & App Testing moved to the "Outils
    // IA" dashboard as their own modules.
    subItems: [
      // ── Dashboard (on top) ──
      { label: "Overview", slug: "overview", group: "Dashboard", icon: ChartLineUpIcon },
      { label: "Custom Dashboards", slug: "admin-custom-dashboards", icon: ChartPieIcon },
      { label: "Alerts", slug: "admin-alerts", icon: BellIcon },
      // ── CRM (below the dashboard) ──
      { label: "Records", slug: "workspace", group: "CRM", icon: TableIcon },
    ],
  },
  // ── Support & PM supprimés (2026-07-17) après évaluation : tickets, projets,
  // tâches et discussions vivent comme records CRM ; le whiteboard a rejoint
  // Office ; le portail public d'aide (/help/:publicKey) survit. ──
  {
    slug: "office",
    label: "Office",
    icon: FileTextIcon,
    color: "text-violet-400/60",
    zone: "run",
    subItems: [
      { label: "Library", slug: "library", icon: BooksIcon },
      { label: "Documents", slug: "documents", icon: FileTextIcon },
      { label: "Spreadsheets", slug: "spreadsheets", icon: TableIcon },
      { label: "Presentations", slug: "presentations", icon: MonitorIcon },
      { label: "Whiteboard", slug: "whiteboard", icon: PencilLineIcon },
      { label: "Image Studio", slug: "gen-image", icon: MagicWandIcon },
      { label: "Video Studio", slug: "gen-video", icon: MonitorIcon },
      { label: "Copywriter", slug: "gen-copy", icon: ScrollIcon },
    ],
  },
  // Vibe Code, Test runs, Dépôts et Simulations ne sont plus des modules : ils
  // sont pilotés par les agents studio (voir HIDDEN_MODULES en bas de fichier).
  // DevOps reste visible mais rejoint la zone CONTROL du dashboard Workforce —
  // c'est le plan de contrôle infra (serveurs, runners, jobs) dont dépendent le
  // runner de test et les sandbox d'agents.
  {
    slug: "devops",
    label: "DevOps",
    icon: HardDrivesIcon,
    color: "text-cyan-500/55",
    zone: "control",
    subItems: [
      { label: "Overview", slug: "ops-overview", icon: GaugeIcon },
      { label: "Serveurs", slug: "servers", icon: HardDrivesIcon },
      { label: "Workflows", slug: "workflows", icon: FlowArrowIcon },
      { label: "Checks", slug: "checks", icon: SealCheckIcon },
      { label: "Testing", slug: "testing", icon: TestTubeIcon },
      { label: "Jobs", slug: "jobs", icon: StackIcon },
      { label: "Settings", slug: "settings", icon: GearSixIcon },
    ],
  },
  // ── Zone CONTROL — the AI control plane, split into 3 full modules ───────
  // Standard modules: their sub-items render as onglets in the SecondarySidebar.
  {
    slug: "governance",
    label: "AI Governance",
    icon: ScalesIcon,
    color: "text-indigo-400/60",
    zone: "control",
    subItems: [
      { label: "Guardrails", slug: "guardrails", icon: ShieldCheckIcon },
      { label: "Accès agents", slug: "agent-access", icon: FingerprintIcon },
      { label: "Prompts", slug: "prompts", icon: EyeIcon },
      { label: "Dépenses", slug: "costs", icon: WalletIcon },
      { label: "Incidents ops", slug: "ops-incidents", icon: SirenIcon },
      { label: "Security", slug: "ft-security", icon: ShieldStarIcon },
    ],
  },
  {
    slug: "aiops",
    label: "AI Ops",
    icon: PulseIcon,
    color: "text-cyan-500/55",
    zone: "control",
    subItems: [
      { label: "Serveurs", slug: "ops-servers", icon: HardDrivesIcon },
      { label: "Temps réel", slug: "ops-live", icon: PulseIcon },
      { label: "Incidents infra", slug: "ops-infra", icon: WarningOctagonIcon },
      { label: "Modèles", slug: "ops-models", icon: CircuitryIcon },
      { label: "Déploiement", slug: "ft-deployment", icon: RocketIcon },
      { label: "Monitoring", slug: "ft-monitoring", icon: ChartLineUpIcon },
      { label: "Coûts", slug: "ft-costs", icon: CoinsIcon },
    ],
  },
  {
    slug: "finetuning",
    label: "Fine-tuning Studio",
    icon: GraduationCapIcon,
    color: "text-violet-400/60",
    zone: "control",
    subItems: [
      { label: "Overview", slug: "ft-overview", icon: GaugeIcon },
      { label: "Datasets", slug: "ft-datasets", icon: StackIcon },
      { label: "Data Prep", slug: "ft-dataprep", icon: BroomIcon },
      { label: "Labeling", slug: "ft-labeling", icon: TagIcon },
      { label: "Experiments", slug: "ft-experiments", icon: TestTubeIcon },
      { label: "Entraînements", slug: "ops-finetuning", icon: GraduationCapIcon },
      { label: "Évaluation", slug: "ft-evaluation", icon: ExamIcon },
      { label: "Playground", slug: "ft-prompt-tests", icon: FlaskIcon },
      { label: "Registry", slug: "ft-versions", icon: CubeIcon },
      { label: "Settings", slug: "ft-settings", icon: GearSixIcon },
    ],
  },
  // NOTE: the former "Settings" module was folded into the Admin dashboard
  // (single-sidebar area at /admin, reached from the top-left dashboard
  // switcher). Its pages are reused there; old settings/* links redirect.
  // The former "Integrations" module (Connected/Catalog/Credentials Vault/API
  // Keys/Webhooks/Automation) was folded the same way, into a single
  // "Connecteurs" tab — just the app catalog + connect action; the other
  // sub-tabs were dropped, not moved. Old integrations/* links redirect.
];

/**
 * Modules routés mais absents de la nav (PrimarySidebar / dashboards). Un
 * module déplacé ici reste entièrement fonctionnel — deep links, actions CRM,
 * breadcrumbs et SecondarySidebar (findModule le résout, buildModuleRoutes
 * génère ses routes) — il disparaît juste du rail. Vide pour l'instant :
 * support/pm/office/devops ont été re-surfacés dans MODULES le 2026-07-16 le
 * temps que le user décide ce qu'il garde.
 */
/**
 * Routed but absent from every dashboard. These are the surfaces the studio
 * agents replaced: you no longer navigate to "Vibe Code" or "Test runs", you
 * ask the Vibe Coder / QA Pilot agent. Their pages stay reachable by URL
 * because they remain the configuration and inspection surface behind the
 * engines the agents drive — connecting a repository, editing the coding
 * instructions, opening a past run.
 */
export const HIDDEN_MODULES: ModuleNavItem[] = [
  {
    slug: "simulations",
    label: "Simulations",
    icon: AtomIcon,
    color: "text-sky-400/70",
    subItems: [{ label: "Simulations", slug: "workspace", icon: AtomIcon }],
  },
  {
    slug: "test-runs",
    label: "Test runs",
    icon: TestTubeIcon,
    color: "text-rose-400/60",
    subItems: [
      { label: "Tests", slug: "tests", icon: FlaskIcon },
      { label: "Live", slug: "live", icon: MonitorIcon },
      { label: "Analytics", slug: "analytics", icon: ChartLineUpIcon },
      { label: "Reports", slug: "reports", icon: ScrollIcon },
      { label: "Observability", slug: "observability", icon: PulseIcon },
    ],
  },
  {
    slug: "repos",
    label: "Dépôts",
    icon: GithubLogoIcon,
    color: "text-cyan-400/60",
    subItems: [{ label: "Dépôts", slug: "list", icon: GithubLogoIcon }],
  },
  {
    slug: "vibe-code",
    label: "Vibe Code",
    icon: MagicWandIcon,
    color: "text-primary",
    subItems: [
      { label: "Vibe Code", slug: "chat", icon: MagicWandIcon },
      { label: "Artifacts", slug: "artifacts", icon: StackIcon },
      { label: "Pull requests", slug: "pr", icon: GitPullRequestIcon },
      { label: "Fork", slug: "fork", icon: GitForkIcon },
      { label: "Preview", slug: "preview", icon: MonitorIcon },
      { label: "Personnaliser", slug: "customize", icon: FadersIcon },
    ],
  },
];

export function findModule(slug: string) {
  return MODULES.find((m) => m.slug === slug) ?? HIDDEN_MODULES.find((m) => m.slug === slug);
}
