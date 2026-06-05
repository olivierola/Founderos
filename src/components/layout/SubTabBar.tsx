import { NavLink, useLocation, useParams } from "react-router-dom";
import { findModule, groupOfSlug, itemsInGroup } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * Horizontal tab bar for `groupsAsTabs` modules (SaaS Analytics). Renders the
 * tabs for whichever group the active route belongs to. Returns null for any
 * module that doesn't use the groups-as-tabs layout, so it's safe to always
 * mount from the AppShell.
 */
export function SubTabBar() {
  const { workspaceSlug = "default", projectSlug = "default" } = useParams();
  const location = useLocation();

  const segments = location.pathname.split("/").filter(Boolean);
  const appIdx = segments.indexOf("app");
  const moduleSlug = appIdx >= 0 ? segments[appIdx + 3] : undefined;
  const activeSlug = appIdx >= 0 ? segments[appIdx + 4] : undefined;
  const base = `/app/${workspaceSlug}/${projectSlug}`;

  const module = moduleSlug ? findModule(moduleSlug) : undefined;
  if (!module || !module.groupsAsTabs || !activeSlug) return null;

  const group = groupOfSlug(module, activeSlug);
  if (!group) return null;

  const items = itemsInGroup(module, group);
  // A single-tab group (e.g. Overview) doesn't need a tab bar.
  if (items.length <= 1) return null;

  return (
    <div className="border-b border-border bg-background">
      <div className="flex gap-1 overflow-x-auto px-4 sm:px-6 lg:px-12 xl:px-20">
        {items.map((it) => (
          <NavLink
            key={it.slug}
            to={`${base}/${module.slug}/${it.slug}`}
            className={({ isActive }) =>
              cn(
                "relative whitespace-nowrap px-3 py-2.5 text-sm transition-colors",
                isActive
                  ? "font-medium text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-[hsl(var(--primary-soft))]"
                  : "font-normal text-muted-foreground hover:text-foreground",
              )
            }
          >
            {it.label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
