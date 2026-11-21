import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ArtifactOpenTarget } from "@/features/internal-agents/UiBlocks";
import { useResizableWidth } from "@/hooks/useResizableWidth";

// L'ÉTABLI du tableau de service : ce qui est ouvert, et où.
//
// Deux choses vivent ici parce que deux endroits les lisent — la barre du haut
// qui les montre, et les pages qui les remplissent :
//
//   · les AGENTS OUVERTS, en onglets. Ouvrir un agent l'ajoute ; le fermer le
//     retire. Retenus par navigateur et par tableau : on retrouve ses onglets
//     en revenant, comme dans un éditeur.
//   · le PANNEAU DE DROITE et ses onglets — les réglages de l'agent, ses
//     tâches, un livrable ouvert depuis la conversation… On y ouvre ce qu'on
//     veut garder sous les yeux à côté du travail, sans quitter la page.
//
// Les onglets « agent » du panneau suivent l'agent AFFICHÉ : passer d'un
// onglet d'agent à l'autre change ce que montrent ses réglages, sans rouvrir
// le panneau.

export type PanelKind = "agent-settings" | "tasks" | "evaluation" | "inbox" | "artifact";

export interface PanelTab {
  id: string;
  kind: PanelKind;
  /** Un livrable ouvert depuis une conversation. Jamais persisté : on l'ouvre
   *  exprès, il ne revient pas tout seul à la visite suivante. */
  artifact?: ArtifactOpenTarget;
  title?: string;
}

export const PANEL_MIN = 340;
export const PANEL_MAX = 960;

interface Workbench {
  dashboardId: string;
  /** L'agent affiché dans le contenu, s'il y en a un. */
  activeAgentId: string | null;
  /** La mission affichée, s'il y en a une. */
  activeMissionId: string | null;

  /** Les onglets ouverts de la barre du haut, dans leur ordre : des agents et
   *  des missions, mêlés. Clé `agent:<id>` ou `mission:<id>`. */
  openItems: string[];
  /** Les agents ouverts seulement (le panneau propose ceux-là). */
  openAgents: string[];
  closeItem: (key: string) => void;
  closeAllItems: () => void;
  /** Garde `key` et ferme les autres. */
  closeOtherItems: (key: string) => void;
  /** Ferme les onglets à droite de `key`. */
  closeItemsRight: (key: string) => void;
  /** Glisser-déposer : `key` prend la place de `beforeKey` (ou la fin). */
  moveItem: (key: string, beforeKey: string | null) => void;

  panelOpen: boolean;
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;
  tabs: PanelTab[];
  activeTab: PanelTab | null;
  /** Ouvre (ou réactive) l'onglet de ce type et ouvre le panneau. */
  openTab: (kind: Exclude<PanelKind, "artifact">) => void;
  openArtifact: (target: ArtifactOpenTarget) => void;
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;

  wide: boolean;
  toggleWide: () => void;
  /** La largeur EFFECTIVE du panneau, élargi ou non. */
  panelWidth: number;
  startResize: (e: React.MouseEvent) => void;

  /** La conversation ouverte avec l'agent affiché — les tâches s'y réfèrent. */
  conversationId: string | null;
  setConversationId: (id: string | null) => void;
}

const WorkbenchCtx = createContext<Workbench | null>(null);

/** `null` hors d'un tableau de service : une page qui s'en sert doit savoir
 *  vivre sans (elle retombe alors sur son comportement d'avant). */
export const useWorkbench = () => useContext(WorkbenchCtx);

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* navigation privée */ }
}

const DEFAULT_TABS: PanelTab[] = [
  { id: "agent-settings", kind: "agent-settings" },
  { id: "tasks", kind: "tasks" },
];

export const itemKey = (kind: "agent" | "mission", id: string) => `${kind}:${id}`;
export function parseItem(key: string): { kind: "agent" | "mission"; id: string } {
  const i = key.indexOf(":");
  return { kind: key.slice(0, i) === "mission" ? "mission" : "agent", id: key.slice(i + 1) };
}

/** Les onglets retenus. L'ancienne clé ne gardait que des agents, par leur
 *  seul identifiant : on la reprend une fois, pour ne perdre aucun onglet. */
function readItems(dashboardId: string): string[] {
  const now = readJson<string[] | null>(`sd-open-tabs:${dashboardId}`, null);
  if (now) return now;
  return readJson<string[]>(`sd-open-agents:${dashboardId}`, []).map((id) => itemKey("agent", id));
}

export function WorkbenchProvider({ dashboardId, activeAgentId, activeMissionId, children }: {
  dashboardId: string; activeAgentId: string | null; activeMissionId: string | null; children: ReactNode;
}) {
  const kAgents = `sd-open-tabs:${dashboardId}`;
  const kPanel = `sd-panel:${dashboardId}`;

  const [openItems, setOpenItems] = useState<string[]>(() => readItems(dashboardId));
  const [panel, setPanel] = useState<{ open: boolean; tabs: PanelTab[]; active: string | null; wide: boolean }>(
    () => readJson(kPanel, { open: true, tabs: DEFAULT_TABS, active: "agent-settings", wide: false }),
  );
  const [conversationId, setConversationId] = useState<string | null>(null);
  const { width, startResize } = useResizableWidth("sd-panel-width", 420, PANEL_MIN, PANEL_MAX);

  // Changer de tableau recharge SES onglets : chaque service a son établi.
  useEffect(() => {
    setOpenItems(readItems(dashboardId));
    setPanel(readJson(kPanel, { open: true, tabs: DEFAULT_TABS, active: "agent-settings", wide: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kAgents, kPanel]);

  useEffect(() => { writeJson(kAgents, openItems); }, [kAgents, openItems]);
  useEffect(() => {
    writeJson(kPanel, { ...panel, tabs: panel.tabs.filter((t) => t.kind !== "artifact"),
      active: panel.tabs.find((t) => t.id === panel.active)?.kind === "artifact" ? null : panel.active });
  }, [kPanel, panel]);

  // L'agent ou la mission affichés deviennent un onglet : c'est ce qui rend
  // « ouvrir » visible.
  useEffect(() => {
    if (!activeAgentId) return;
    const k = itemKey("agent", activeAgentId);
    setOpenItems((prev) => (prev.includes(k) ? prev : [...prev, k]));
  }, [activeAgentId]);
  useEffect(() => {
    if (!activeMissionId) return;
    const k = itemKey("mission", activeMissionId);
    setOpenItems((prev) => (prev.includes(k) ? prev : [...prev, k]));
  }, [activeMissionId]);

  const closeItem = useCallback((key: string) => setOpenItems((prev) => prev.filter((x) => x !== key)), []);
  const closeAllItems = useCallback(() => setOpenItems([]), []);
  const closeOtherItems = useCallback((key: string) => setOpenItems((prev) => prev.filter((x) => x === key)), []);
  const closeItemsRight = useCallback((key: string) => setOpenItems((prev) => {
    const i = prev.indexOf(key);
    return i < 0 ? prev : prev.slice(0, i + 1);
  }), []);
  const moveItem = useCallback((key: string, beforeKey: string | null) => setOpenItems((prev) => {
    if (key === beforeKey || !prev.includes(key)) return prev;
    const rest = prev.filter((x) => x !== key);
    const at = beforeKey ? rest.indexOf(beforeKey) : -1;
    return at < 0 ? [...rest, key] : [...rest.slice(0, at), key, ...rest.slice(at)];
  }), []);
  const openAgents = useMemo(
    () => openItems.filter((k) => k.startsWith("agent:")).map((k) => k.slice(6)),
    [openItems],
  );

  const openTab = useCallback((kind: Exclude<PanelKind, "artifact">) => {
    setPanel((p) => {
      const tabs = p.tabs.some((t) => t.kind === kind) ? p.tabs : [...p.tabs, { id: kind, kind }];
      return { ...p, open: true, tabs, active: kind };
    });
  }, []);
  const openArtifact = useCallback((target: ArtifactOpenTarget) => {
    setPanel((p) => {
      const id = `artifact:${target.table}:${target.id ?? ""}`;
      const tabs = p.tabs.some((t) => t.id === id)
        ? p.tabs
        : [...p.tabs.filter((t) => t.kind !== "artifact"), { id, kind: "artifact" as const, artifact: target, title: target.title }];
      return { ...p, open: true, tabs, active: id };
    });
  }, []);
  const activateTab = useCallback((id: string) => setPanel((p) => ({ ...p, active: id, open: true })), []);
  const closeTab = useCallback((id: string) => setPanel((p) => {
    const i = p.tabs.findIndex((t) => t.id === id);
    const tabs = p.tabs.filter((t) => t.id !== id);
    // On rend la main à l'onglet voisin, comme un navigateur ; le dernier
    // fermé referme le panneau.
    const active = p.active === id ? (tabs[Math.max(0, i - 1)]?.id ?? null) : p.active;
    return { ...p, tabs, active, open: tabs.length > 0 && p.open };
  }), []);

  const togglePanel = useCallback(() => setPanel((p) => {
    if (p.open) return { ...p, open: false };
    // Rouvrir un panneau sans onglet n'aurait rien à montrer.
    const tabs = p.tabs.length ? p.tabs : DEFAULT_TABS;
    return { ...p, open: true, tabs, active: p.active && tabs.some((t) => t.id === p.active) ? p.active : tabs[0].id };
  }), []);
  const setPanelOpen = useCallback((open: boolean) => setPanel((p) => ({ ...p, open })), []);
  const toggleWide = useCallback(() => setPanel((p) => ({ ...p, wide: !p.wide })), []);

  const [viewport, setViewport] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => {
    const on = () => setViewport(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  // Élargi : la moitié de l'écran. Jamais au point d'écraser le contenu sous
  // une colonne illisible.
  const panelWidth = panel.wide
    ? Math.round(Math.min(PANEL_MAX + 200, Math.max(width, viewport * 0.5)))
    : Math.min(width, Math.max(PANEL_MIN, viewport - 720));

  const value = useMemo<Workbench>(() => ({
    dashboardId, activeAgentId, activeMissionId,
    openItems, openAgents, closeItem, closeAllItems, closeOtherItems, closeItemsRight, moveItem,
    panelOpen: panel.open && panel.tabs.length > 0,
    togglePanel, setPanelOpen,
    tabs: panel.tabs,
    activeTab: panel.tabs.find((t) => t.id === panel.active) ?? panel.tabs[0] ?? null,
    openTab, openArtifact, activateTab, closeTab,
    wide: panel.wide, toggleWide, panelWidth, startResize,
    conversationId, setConversationId,
  }), [dashboardId, activeAgentId, activeMissionId, openItems, openAgents, closeItem, closeAllItems,
    closeOtherItems, closeItemsRight, moveItem, panel, togglePanel,
    setPanelOpen, openTab, openArtifact, activateTab, closeTab, toggleWide, panelWidth, startResize, conversationId]);

  return <WorkbenchCtx.Provider value={value}>{children}</WorkbenchCtx.Provider>;
}
