import { useState, useEffect } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SubNavItem } from "@/lib/navigation";

interface Props {
  /** Path to the parent page (e.g. /app/ws/proj/actions/saas-analytics) */
  parentTo: string;
  parentLabel: string;
  items: SubNavItem[];
  /** Base path for the children (e.g. /app/ws/proj/actions/) */
  childBase: string;
}

/**
 * Inline accordion for nested sub-items in the SecondarySidebar.
 * The parent acts as a NavLink (clickable, shows its own page) and the
 * caret toggles the child list. Auto-opens when the active route is a child.
 */
export function AccordionNavItem({ parentTo, parentLabel, items, childBase }: Props) {
  const { pathname } = useLocation();
  const childActive = items.some((c) => pathname.endsWith(`/${c.slug}`));
  const parentActive = pathname.endsWith(parentTo) || pathname.endsWith(parentTo + "/");
  const [open, setOpen] = useState(childActive || parentActive);

  // Reflect navigation: re-open when entering a child route.
  useEffect(() => {
    if (childActive) setOpen(true);
  }, [childActive]);

  return (
    <div>
      <div className="flex items-center">
        <NavLink
          to={parentTo}
          end
          className={({ isActive }) =>
            cn(
              "flex flex-1 items-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-sidebar-accent text-foreground"
                : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            )
          }
        >
          {parentLabel}
        </NavLink>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
          aria-label={open ? "Collapse" : "Expand"}
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />
        </button>
      </div>

      {open && (
        <div className="ml-2 mt-1 space-y-0.5 border-l border-border/60 pl-2">
          {items.map((c, i) => {
            const prevGroup = i > 0 ? items[i - 1].group : undefined;
            const showDivider = c.group && c.group !== prevGroup;
            const node = (
              <NavLink
                key={c.slug}
                to={`${childBase}${c.slug}`}
                end
                className={({ isActive }) =>
                  cn(
                    "block rounded-md px-2 py-1.5 text-xs transition-colors",
                    isActive
                      ? "bg-sidebar-accent text-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                  )
                }
              >
                {c.label}
              </NavLink>
            );
            if (!showDivider) return node;
            return (
              <div key={c.slug + "-g"}>
                <div
                  className={cn(
                    "px-2 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground",
                    i > 0 && "mt-1 border-t border-border/40 pt-2",
                  )}
                >
                  {c.group}
                </div>
                {node}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
