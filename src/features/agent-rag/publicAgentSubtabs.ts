import {
  PulseIcon as Activity,
  BookOpenIcon as BookOpen,
  CodeIcon as Code2,
  CoinsIcon as Coins,
  GaugeIcon as Gauge,
  LayoutIcon as LayoutPanelTop,
  LayoutIcon as LayoutTemplate,
  CursorClickIcon as MousePointerClick,
  PaletteIcon as Palette,
  PlugIcon as Plug,
  RocketLaunchIcon as Rocket,
  SlidersHorizontalIcon as Settings2,
  SlidersHorizontalIcon as SlidersHorizontal,
  StorefrontIcon as Store,
  TargetIcon as Target,
  TextTIcon as Type,
  UsersIcon as Users,
  WrenchIcon as Wrench,
} from "@phosphor-icons/react";
import type { PublicAgentTab } from "./AgentBuilder";

// Sous-onglets des tabs d'un agent public.
//
// Ils vivaient à l'intérieur de chaque tab, chacun avec sa propre bande : un
// segmented ici, un soulignement là, un troisième ailleurs. Le registre les
// remonte au niveau de la coque, qui en dessine UNE seconde barre sous la
// première — la navigation d'un agent public se lit donc au même endroit, quelle
// que soit la page, et un sous-onglet devient adressable (`?t=…&s=…`).
//
// Conséquence à tenir : un tab listé ici ne dessine plus sa bande lui-même, il
// reçoit `sub` en propriété. Ajouter une entrée sans faire ce changement
// donnerait deux navigations concurrentes sur la même page.

export interface SubtabDef {
  key: string;
  label: string;
  icon: typeof Gauge;
}

export const PUBLIC_AGENT_SUBTABS: Partial<Record<PublicAgentTab, SubtabDef[]>> = {
  widget: [
    { key: "modele", label: "Modèle", icon: LayoutTemplate },
    { key: "apparence", label: "Apparence", icon: Palette },
    { key: "lanceur", label: "Lanceur", icon: MousePointerClick },
    { key: "fenetre", label: "Fenêtre", icon: LayoutPanelTop },
    { key: "contenu", label: "Contenu", icon: Type },
    { key: "avance", label: "Avancé", icon: Settings2 },
    { key: "integration", label: "Intégration", icon: Code2 },
  ],
  analytics: [
    { key: "performance", label: "Performance", icon: Gauge },
    { key: "audience", label: "Audience", icon: Users },
    { key: "tools", label: "Outils", icon: Wrench },
    { key: "llm", label: "Modèles & coûts", icon: Coins },
    { key: "knowledge", label: "Base de connaissances", icon: BookOpen },
  ],
  onboarding: [
    { key: "goals", label: "Objectifs", icon: Target },
    { key: "settings", label: "Réglages", icon: SlidersHorizontal },
    { key: "activation", label: "Activation", icon: Rocket },
  ],
  ecommerce: [
    { key: "servers", label: "Boutique", icon: Store },
    { key: "tools", label: "Outils", icon: Plug },
    { key: "activity", label: "Activité", icon: Activity },
  ],
};

export function subtabsFor(tab: PublicAgentTab): SubtabDef[] | null {
  return PUBLIC_AGENT_SUBTABS[tab] ?? null;
}

/** Le sous-onglet actif : celui de l'URL s'il appartient au tab courant, sinon
 *  le premier. Un `?s=` hérité du tab précédent ne doit pas laisser la page
 *  vide — il désigne juste un sous-onglet qui n'existe pas ici. */
export function resolveSubtab(tab: PublicAgentTab, raw: string | null): string | null {
  const list = subtabsFor(tab);
  if (!list || !list.length) return null;
  return list.some((s) => s.key === raw) ? (raw as string) : list[0].key;
}
