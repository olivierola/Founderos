import { NavLink, useParams } from "react-router-dom";
import { ArrowLeftIcon as ArrowLeft } from "@phosphor-icons/react";
import { ADMIN_SECTIONS } from "@/lib/admin-navigation";
import { dashboardLandingSlug } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * The Admin dashboard's single sidebar. Replaces the two-column product shell
 * (Primary + Secondary) whenever the route is under /admin. Sections render as
 * coral, square-bulleted labels with plain-text item pills below — matching the
 * admin mockup.
 */
export function AdminSidebar() {
  const { workspaceSlug = "default", projectSlug = "default" } = useParams();
  const base = `/app/${workspaceSlug}/${projectSlug}`;

  return (
    <aside className="flex h-full w-64 flex-col border-r border-border bg-sidebar">
      {/* Header — title + a way back to the product. */}
      <div className="flex h-14 items-center justify-between border-b border-border px-4">
        <span className="text-base font-semibold text-foreground">Administration</span>
        <NavLink
          to={`${base}/${dashboardLandingSlug("workforce")}`}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
          title="Retour à l'app"
          aria-label="Retour à l'app"
        >
          <ArrowLeft className="h-4 w-4" />
        </NavLink>
      </div>

      <nav className="scrollbar-slim flex-1 overflow-y-auto px-2.5 py-3">
        {ADMIN_SECTIONS.map((section, si) => (
          <div key={section.label} className={cn("flex flex-col", si > 0 && "mt-5")}>
            {/* Section label — coral square bullet + uppercase coral text. */}
            <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-1">
              <span className="h-2.5 w-2.5 shrink-0 rounded-[3px] bg-primary" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-primary">
                {section.label}
              </span>
            </div>

            {section.items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.slug}
                  to={`${base}/admin/${item.slug}`}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[15px] transition-colors",
                      isActive
                        ? "bg-sidebar-accent font-medium text-foreground"
                        : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon
                        weight={isActive ? "fill" : "duotone"}
                        className={cn("h-[18px] w-[18px] shrink-0", isActive ? "text-primary" : "text-muted-foreground")}
                      />
                      <span className="truncate">{item.label}</span>
                    </>
                  )}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
