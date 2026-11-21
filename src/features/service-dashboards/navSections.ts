import {
  HouseIcon, TrayIcon, NotePencilIcon, RobotIcon, UsersThreeIcon, CubeIcon, KanbanIcon, FlowArrowIcon,
  ChartBarIcon, SquaresFourIcon, GraphIcon, PlugsConnectedIcon, StackIcon, BrainIcon,
  HouseSimpleIcon, BriefcaseIcon, GaugeIcon, PlugIcon,
  GearSixIcon, SlidersIcon, SparkleIcon, ChatsCircleIcon, WarningIcon,
  DesktopTowerIcon, PulseIcon, FolderOpenIcon, ShareNetworkIcon, SlidersHorizontalIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

/**
 * La navigation du tableau de service, en cinq questions (rapport du
 * 18/11/2026) : un RAIL étroit porte les sections, un PANNEAU à côté porte ce
 * qu'il y a dans la section ouverte.
 *
 *   Accueil     qu'est-ce qui m'attend ?
 *   Équipe      qui travaille ?
 *   Travail     sur quoi ?
 *   Pilotage    est-ce que ça marche ?
 *   Ressources  avec quoi ?
 *   Machines    où ?
 *
 * Plus les Paramètres, posés en bas du rail : les réglages du service.
 *
 * Les adresses ne changent pas : chaque page reste à son URL d'origine, c'est
 * sa section qui s'allume.
 */
export type SectionKey = "accueil" | "equipe" | "travail" | "pilotage" | "ressources" | "machines" | "parametres";

export interface SectionItem {
  label: string;
  icon: PhosphorIcon;
  /** Le chemin sous le tableau : « agents », « projects/inbox », « memory/graph »… */
  path: string;
  /** D'autres onglets qui allument cette ligne (la fiche d'un agent allume « Collaborateurs »). */
  alsoTabs?: string[];
  badge?: "inbox";
}

export interface Section { key: SectionKey; label: string; question: string; icon: PhosphorIcon; items: SectionItem[] }

export const SECTIONS: Section[] = [
  {
    key: "accueil", label: "Accueil", question: "Ce qui vous attend", icon: HouseSimpleIcon,
    items: [
      { label: "Accueil", icon: HouseIcon, path: "projects" },
      { label: "À valider", icon: TrayIcon, path: "projects/inbox", badge: "inbox" },
      { label: "Notes", icon: NotePencilIcon, path: "projects/stickies" },
    ],
  },
  {
    key: "equipe", label: "Équipe", question: "Qui travaille", icon: UsersThreeIcon,
    items: [
      { label: "Collaborateurs", icon: RobotIcon, path: "agents", alsoTabs: ["agent", "agent-config", "public"] },
      { label: "Équipes", icon: UsersThreeIcon, path: "teamz" },
      { label: "Espace 3D", icon: CubeIcon, path: "live" },
    ],
  },
  {
    key: "travail", label: "Travail", question: "Sur quoi", icon: BriefcaseIcon,
    items: [
      { label: "Missions", icon: KanbanIcon, path: "projects/all-projects" },
      { label: "Workflows", icon: FlowArrowIcon, path: "workflows" },
    ],
  },
  {
    key: "pilotage", label: "Pilotage", question: "Est-ce que ça marche", icon: GaugeIcon,
    items: [
      { label: "Dashboards", icon: SquaresFourIcon, path: "dashboards" },
      { label: "Analytics", icon: ChartBarIcon, path: "projects/analytics" },
      { label: "Workgraph", icon: GraphIcon, path: "projects/workgraph" },
    ],
  },
  {
    key: "ressources", label: "Ressources", question: "Avec quoi", icon: PlugIcon,
    items: [
      { label: "Connexions", icon: PlugsConnectedIcon, path: "connectors" },
      { label: "Lots", icon: StackIcon, path: "pools" },
      { label: "Connaissances", icon: BrainIcon, path: "memory/graph" },
    ],
  },
  {
    // Les postes où les agents travaillent (0304) : un compte Linux par agent.
    key: "machines", label: "Machines", question: "Où travaillent les agents", icon: DesktopTowerIcon,
    items: [
      { label: "Vue d'ensemble", icon: DesktopTowerIcon, path: "machines" },
      { label: "Activité", icon: PulseIcon, path: "machines/activite" },
      { label: "Fichiers", icon: FolderOpenIcon, path: "machines/fichiers" },
      { label: "Attributions", icon: ShareNetworkIcon, path: "machines/attributions" },
      { label: "Configuration", icon: SlidersHorizontalIcon, path: "machines/configuration" },
    ],
  },
  {
    key: "parametres", label: "Paramètres", question: "Les réglages du service", icon: GearSixIcon,
    items: [
      { label: "Général", icon: SlidersIcon, path: "settings/general" },
      { label: "Navigation", icon: SquaresFourIcon, path: "settings/navigation" },
      { label: "Assistant", icon: SparkleIcon, path: "settings/assistant" },
      { label: "Collaborateurs", icon: RobotIcon, path: "settings/agents" },
      { label: "Équipes", icon: UsersThreeIcon, path: "settings/teams" },
      { label: "Rooms", icon: ChatsCircleIcon, path: "settings/rooms" },
      { label: "Zone de danger", icon: WarningIcon, path: "settings/danger" },
    ],
  },
];

/** Les sections du haut du rail ; les Paramètres vont en bas. */
export const MAIN_SECTIONS = SECTIONS.filter((s) => s.key !== "parametres");
export const SETTINGS_SECTION = SECTIONS.find((s) => s.key === "parametres")!;

const PILOTAGE_VIEWS = new Set(["analytics", "workgraph", "boards"]);
const ACCUEIL_VIEWS = new Set(["inbox", "stickies"]);

/** La section d'une page. `null` : une page hors sections (documentation). */
export function sectionOf(tab: string, sub?: string | null): SectionKey | null {
  switch (tab) {
    case "projects":
      if (!sub || ACCUEIL_VIEWS.has(sub)) return "accueil";
      if (PILOTAGE_VIEWS.has(sub)) return "pilotage";
      return "travail";
    case "agents": case "agent": case "agent-config": case "public": case "teamz": case "live":
      return "equipe";
    case "dashboards":
      return "pilotage";
    case "workflows": case "room":
      return "travail";
    case "connectors": case "pools": case "memory":
      return "ressources";
    case "machines":
      return "machines";
    case "settings":
      return "parametres";
    default:
      return null;
  }
}

/** La ligne allumée : même onglet, et même vue quand le chemin en porte une. */
export function itemActive(item: SectionItem, tab: string, sub?: string | null): boolean {
  const [t, s] = item.path.split("/");
  if (item.alsoTabs?.includes(tab)) return true;
  if (tab !== t) return false;
  if (t === "settings") return (sub || "general") === s;
  if (t === "machines") return (sub ?? "") === (s ?? "");
  if (t === "projects") return s ? sub === s || (s === "analytics" && sub === "boards") : !sub;
  return !s || sub === s || (t === "memory" && !sub);
}

/** La dernière page ouverte dans chaque section : y revenir rouvre celle-là. */
export function lastInSection(dashboardId: string, key: SectionKey): string | null {
  try { return sessionStorage.getItem(`sd-section:${dashboardId}:${key}`); } catch { return null; }
}
export function rememberInSection(dashboardId: string, key: SectionKey, path: string): void {
  try { sessionStorage.setItem(`sd-section:${dashboardId}:${key}`, path); } catch { /* stockage bloqué */ }
}
