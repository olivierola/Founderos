import { useState, useEffect } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { CaretDownIcon as ChevronDown } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { SubNavItem } from "@/lib/navigation";
import { navItem, navSubItem } from "./navStyles";

interface Props {
  /** Path to the parent page (e.g. /app/ws/proj/<module>/<parent-slug>) */
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
        <NavLink to={parentTo} end className={({ isActive }) => navItem(isActive, "flex-1")}>
          {parentLabel}
        </NavLink>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
          aria-label={open ? "Collapse" : "Expand"}
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />
        </button>
      </div>

      {open && (
        // Le retrait aligne les sous-pages sous leur parent, sans filet — la
        // barre d'un service fait de même sous un projet ouvert.
        <div className="mt-0.5 space-y-0.5 pl-4">
          {items.map((c, i) => {
            const prevGroup = i > 0 ? items[i - 1].group : undefined;
            const showDivider = c.group && c.group !== prevGroup;
            const node = (
              <NavLink key={c.slug} to={`${childBase}${c.slug}`} end className={({ isActive }) => navSubItem(isActive)}>
                <span className="truncate">{c.label}</span>
              </NavLink>
            );
            if (!showDivider) return node;
            return (
              <div key={c.slug + "-g"}>
                <div className="px-2.5 pb-1 pt-2.5 text-[12px] text-muted-foreground">{c.group}</div>
                {node}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
