import { NavLink, useLocation, useParams } from "react-router-dom";
import { findModule } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export function SecondarySidebar() {
  const { workspaceSlug = "default", projectSlug = "default" } = useParams();
  const location = useLocation();

  // Match the module from the exact path segment: /app/:ws/:proj/<module>/<sub>
  const segments = location.pathname.split("/").filter(Boolean);
  const appIdx = segments.indexOf("app");
  const moduleSlug = appIdx >= 0 ? segments[appIdx + 3] : undefined;
  const module = findModule(moduleSlug ?? "overview");
  if (!module) return null;

  return (
    <aside className="flex h-full w-56 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center border-b border-border px-4">
        <div className="text-base font-semibold text-foreground">{module.label}</div>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        {module.subItems.map((sub) => {
          const to = `/app/${workspaceSlug}/${projectSlug}/${module.slug}/${sub.slug}`;
          return (
            <NavLink
              key={sub.slug}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-foreground"
                    : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )
              }
            >
              {sub.label}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
