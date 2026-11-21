import { NavLink, useParams, useLocation } from "react-router-dom";
import { CaretRightIcon as ChevronRight, QuestionIcon as HelpCircle } from "@phosphor-icons/react";
import { ZONES, modulesInZone, type ModuleNavItem } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useShellNav } from "./AppShell";
import { useAssistant } from "@/lib/assistant-context";
import { useActiveDashboard } from "./useActiveDashboard";
import { UsageMeter } from "./UsageMeter";
import { navIcon, navItem, navSection, PRIMARY_WIDTH } from "./navStyles";

export function PrimarySidebar() {
  const { workspaceSlug = "default", projectSlug = "default" } = useParams();
  const location = useLocation();
  const assistant = useAssistant();
  const activeDashboard = useActiveDashboard();
  // Expand/collapse is shared shell state, driven from the logo (hover) in the
  // navbar; here we only read the width.
  const { primaryExpanded: expanded } = useShellNav();

  // Active module = the 4th segment of /app/:ws/:proj/<module>/...
  const segs = location.pathname.split("/").filter(Boolean);
  const appIdx = segs.indexOf("app");
  const activeModule = appIdx >= 0 ? segs[appIdx + 3] : undefined;

  const renderModule = (mod: ModuleNavItem) => {
    const Icon = mod.icon;
    const to = `/app/${workspaceSlug}/${projectSlug}/${mod.slug}`;
    const isActive = activeModule === mod.slug;
    const hasChildren = mod.subItems.length > 1;

    if (!expanded) {
      // Repliée : la même bande d'icônes que la barre repliée d'un service
      // (CollapsedNav) — carrés de 40 px, arrondis en rounded-xl.
      return (
        <Tooltip key={mod.slug}>
          <TooltipTrigger asChild>
            <NavLink
              to={to}
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors",
                isActive
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="h-[18px] w-[18px]" weight={isActive ? "fill" : "regular"} />
            </NavLink>
          </TooltipTrigger>
          <TooltipContent side="right">{mod.label}</TooltipContent>
        </Tooltip>
      );
    }

    return (
      <NavLink key={mod.slug} to={to} className={navItem(isActive, "group")}>
        <Icon className={navIcon(isActive)} weight={isActive ? "fill" : "regular"} />
        <span className="min-w-0 flex-1 truncate">{mod.label}</span>
        {hasChildren && (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
        )}
      </NavLink>
    );
  };

  return (
    <TooltipProvider delayDuration={100}>
      <aside
        data-primary-sidebar
        // Ni fond ni bordure : comme la barre d'un tableau de service, elle est
        // posée sur le fond de la coque, et seul le contenu a une surface.
        className="flex h-full shrink-0 flex-col overflow-hidden transition-[width] duration-200"
        style={{ width: expanded ? PRIMARY_WIDTH.expanded : PRIMARY_WIDTH.collapsed }}
      >
        {/* Nav — les zones, titrées en gris sans filet. Le dépliage vit sur la
            marque (survol), dans la barre du haut. */}
        <nav className={cn("scrollbar-hide flex-1 overflow-y-auto pb-2", expanded ? "px-2 pt-1" : "flex flex-col items-center pt-1")}>
          {ZONES.map((zone, zi) => {
            const mods = modulesInZone(zone.id, activeDashboard);
            if (mods.length === 0) return null;
            return (
              <div
                key={zone.id}
                className={cn(
                  "flex flex-col",
                  expanded ? "gap-0.5" : "items-center gap-1",
                  !expanded && zi > 0 && "mt-1 border-t border-sidebar-border/60 pt-2",
                )}
              >
                {/* Section label — skipped for the first (primary) zone and when
                    collapsed, exactly like a service's sidebar. */}
                {expanded && zi > 0 && <div className={navSection()}>{zone.label}</div>}
                {mods.map(renderModule)}
              </div>
            );
          })}
        </nav>

        {/* Bottom — usage meter + help & resources (account lives in the navbar now). */}
        <div className={cn("mt-auto shrink-0", expanded ? "border-t border-border/60 px-2 pb-2 pt-2" : "flex flex-col items-center pb-3 pt-1")}>
          <div className={cn(expanded ? "mb-1.5" : "mb-2 flex justify-center")}>
            <UsageMeter expanded={expanded} />
          </div>
          {expanded ? (
            <button onClick={() => assistant.toggle()} className={navItem(false)}>
              <HelpCircle className={navIcon(false)} />
              <span className="min-w-0 flex-1 truncate text-left">Aide et ressources</span>
            </button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => assistant.toggle()}
                  className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
                  aria-label="Aide et ressources"
                >
                  <HelpCircle className="h-[18px] w-[18px]" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Aide et ressources</TooltipContent>
            </Tooltip>
          )}
        </div>
      </aside>
    </TooltipProvider>
  );
}
