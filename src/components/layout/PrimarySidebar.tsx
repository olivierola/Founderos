import { NavLink, useParams, useLocation } from "react-router-dom";
import { ChevronRight, HelpCircle } from "lucide-react";
import { ZONES, modulesInZone, type ModuleNavItem } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useShellNav } from "./AppShell";
import { useAssistant } from "@/lib/assistant-context";
import { useActiveDashboard } from "./useActiveDashboard";
import { UsageMeter } from "./UsageMeter";

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
      return (
        <Tooltip key={mod.slug}>
          <TooltipTrigger asChild>
            <NavLink
              to={to}
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
                isActive
                  ? "bg-sidebar-accent text-foreground"
                  : "text-foreground/55 hover:bg-sidebar-accent/60 hover:text-foreground",
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
      <NavLink
        key={mod.slug}
        to={to}
        className={cn(
          "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
          isActive
            ? "bg-sidebar-accent font-medium text-foreground"
            : "text-foreground/80 hover:bg-sidebar-accent/60 hover:text-foreground",
        )}
      >
        <Icon
          className={cn("h-[18px] w-[18px] shrink-0", isActive ? "text-foreground" : "text-foreground/70")}
          weight={isActive ? "fill" : "regular"}
        />
        <span className="min-w-0 flex-1 truncate">{mod.label}</span>
        {hasChildren && (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
        )}
      </NavLink>
    );
  };

  return (
    <TooltipProvider delayDuration={100}>
      <aside
        data-primary-sidebar
        className={cn(
          "flex h-full flex-col overflow-hidden border-r border-border bg-sidebar transition-[width] duration-200",
          expanded ? "w-64" : "w-16",
        )}
      >
        {/* Nav — sections (zones) with grey labels + item pills, no dividers.
            The expand control now lives on the logo (hover) in the navbar. */}
        <nav className={cn("scrollbar-slim flex-1 overflow-y-auto", expanded ? "px-3 py-3" : "px-2 py-3")}>
          {ZONES.map((zone, zi) => {
            const mods = modulesInZone(zone.id, activeDashboard);
            if (mods.length === 0) return null;
            return (
              <div
                key={zone.id}
                className={cn(
                  "flex flex-col",
                  expanded ? "gap-0.5" : "items-center gap-1",
                  zi > 0 && (expanded ? "mt-4" : "mt-2"),
                )}
              >
                {/* Section label — skipped for the first (primary) zone and when
                    collapsed, exactly like the reference. */}
                {expanded && zi > 0 && (
                  <div className="px-3 pb-1 pt-1 text-xs font-medium text-muted-foreground">{zone.label}</div>
                )}
                {mods.map(renderModule)}
              </div>
            );
          })}
        </nav>

        {/* Bottom — usage meter + help & resources (account lives in the navbar now). */}
        <div className={cn("mt-auto shrink-0", expanded ? "px-3 pb-3 pt-1" : "px-2 pb-3 pt-1")}>
          <div className={cn(expanded ? "mb-2" : "mb-2 flex justify-center")}>
            <UsageMeter percent={1} resetDays={20} expanded={expanded} />
          </div>
          {expanded ? (
            <button
              onClick={() => assistant.toggle()}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
            >
              <HelpCircle className="h-[18px] w-[18px] shrink-0 text-foreground/70" />
              <span className="min-w-0 flex-1 truncate text-left">Aide et ressources</span>
            </button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => assistant.toggle()}
                  className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg text-foreground/55 transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
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
