import { cn } from "@/lib/utils";

// La grammaire de navigation des tableaux de service (ServiceDashboardShell :
// PanelItem, PanelSection), partagée avec l'AI Workforce pour que les deux
// coques parlent la même langue. Posée sur le fond, sans cadre :
//   · une ligne fait 13,5 px, s'arrondit en `rounded-lg`, et s'éclaire au
//     survol d'un gris de barre ;
//   · la ligne ACTIVE porte le violet de marque — un voile, et l'icône en
//     couleur pleine. Un simple gris se confondait avec le survol ;
//   · une section se titre en casse normale, en gris, sans majuscules
//     espacées ni filet : c'est l'air au-dessus qui la sépare.

/** La largeur de la barre latérale principale — dépliée, repliée : celles de
 *  la barre d'un tableau de service. La zone gauche de la barre du haut s'y
 *  aligne. */
export const PRIMARY_WIDTH = { expanded: 264, collapsed: 60 } as const;

export const navItem = (active: boolean, extra?: string) =>
  cn(
    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] transition-colors",
    active
      ? "bg-primary/15 font-medium text-foreground"
      : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
    extra,
  );

export const navIcon = (active: boolean) =>
  cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground");

/** Une ligne de second niveau (conversation, sous-page). */
export const navSubItem = (active: boolean) =>
  cn(
    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-left text-[12.5px] transition-colors",
    active
      ? "bg-primary/15 text-foreground"
      : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
  );

/** Le titre d'une section de la barre. `first` : sans l'air du haut. */
export const navSection = (first = false) =>
  cn("px-2.5 pb-1.5 text-[13px] text-muted-foreground", first ? "pt-1" : "pt-6");

/** Un bouton-icône posé sur le fond (barre du haut, barre repliée). */
export const groundIconButton =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-35";
