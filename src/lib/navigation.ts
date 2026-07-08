import {
  SparkleIcon,
  KanbanIcon,
  AtomIcon,
  HandshakeIcon,
  RobotIcon,
  BugIcon,
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
  StorefrontIcon,
  VaultIcon,
  KeyIcon,
  BroadcastIcon,
  FlowArrowIcon,
  UserCircleIcon,
  BuildingsIcon,
  UsersThreeIcon,
  ShieldCheckIcon,
  CreditCardIcon,
  LockKeyIcon,
  FingerprintIcon,
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

export interface ModuleNavItem {
  slug: string;
  label: string;
  icon: Icon;
  /** Tailwind text color class for the module icon (soft, per-module hue) */
  color: string;
  subItems: SubNavItem[];
  /** Which product zone this module belongs to in the PrimarySidebar (defaults to "run"). */
  zone?: ZoneId;
  /**
   * When true, the SecondarySidebar renders one entry per `group` (a top-level
   * "section" tab pointing at the group's first item), and a horizontal SubTabBar
   * renders the items inside the active group. Used by SaaS Analytics, where the
   * groups are the primary axis and the pages are tabs within each group.
   */
  groupsAsTabs?: boolean;
}

/** Modules belonging to a zone, in declaration order (defaults to "run"). */
export function modulesInZone(id: ZoneId): ModuleNavItem[] {
  return MODULES.filter((m) => (m.zone ?? "run") === id);
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
    subItems: [
      { label: "Agents", slug: "internal-agents", icon: RobotIcon },
    ],
  },
  {
    slug: "crm",
    label: "CRM",
    icon: HandshakeIcon,
    color: "text-emerald-400/60",
    zone: "run",
    // Projects live inside the CRM as records now (the standalone Projects
    // super-module was retired); App Testing & Simulations were folded in too.
    subItems: [
      // ── Dashboard (on top) ──
      { label: "Dashboard", slug: "admin-dashboard", group: "Dashboard", icon: GaugeIcon },
      { label: "Custom Dashboards", slug: "admin-custom-dashboards", icon: ChartPieIcon },
      { label: "Alerts", slug: "admin-alerts", icon: BellIcon },
      // ── CRM (below the dashboard) ──
      { label: "Records", slug: "workspace", group: "CRM", icon: TableIcon },
      // ── Simulations & tests (folded in from the retired modules) ──
      { label: "App Testing", slug: "testing", group: "Simulations & tests", icon: BugIcon },
      { label: "Simulations", slug: "simulations", icon: AtomIcon },
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
  // ── Zone CONNECT — the hands (integrations) + workspace & security ───────
  {
    slug: "integrations",
    label: "Integrations",
    icon: PuzzlePieceIcon,
    color: "text-cyan-500/55",
    zone: "connect",
    subItems: [
      { label: "Connected", slug: "connected", icon: PlugsConnectedIcon },
      { label: "Catalog", slug: "catalog", icon: StorefrontIcon },
      { label: "Credentials Vault", slug: "credentials-vault", icon: VaultIcon },
      { label: "API Keys", slug: "api-keys", icon: KeyIcon },
      { label: "Webhooks", slug: "webhooks", icon: BroadcastIcon },
      { label: "n8n / Make / Zapier", slug: "automation", icon: FlowArrowIcon },
    ],
  },
  {
    slug: "settings",
    label: "Settings",
    icon: GearSixIcon,
    color: "text-slate-400",
    zone: "connect",
    subItems: [
      { label: "Profile", slug: "profile", icon: UserCircleIcon },
      { label: "Workspace", slug: "workspace", icon: BuildingsIcon },
      { label: "Projects", slug: "projects", icon: KanbanIcon },
      { label: "Team", slug: "team", icon: UsersThreeIcon },
      { label: "Roles & permissions", slug: "roles", icon: ShieldCheckIcon },
      { label: "Billing", slug: "billing", icon: CreditCardIcon },
      { label: "Notifications", slug: "notifications", icon: BellIcon },
      { label: "Security", slug: "security", icon: LockKeyIcon },
      { label: "Data & Privacy", slug: "data-privacy", icon: FingerprintIcon },
    ],
  },
];

export function findModule(slug: string) {
  return MODULES.find((m) => m.slug === slug);
}
