import { NavLink, useParams, useNavigate, useLocation } from "react-router-dom";
import { Boxes, LogOut } from "lucide-react";
import { MODULES } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth-context";

export function PrimarySidebar() {
  const { workspaceSlug = "default", projectSlug = "default" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, signOut } = useAuth();
  const initial = user?.email?.[0]?.toUpperCase() ?? "?";

  // Active module = the 4th segment of /app/:ws/:proj/<module>/...
  const segs = location.pathname.split("/").filter(Boolean);
  const appIdx = segs.indexOf("app");
  const activeModule = appIdx >= 0 ? segs[appIdx + 3] : undefined;

  return (
    <TooltipProvider delayDuration={100}>
      <aside data-primary-sidebar className="flex h-full w-16 flex-col items-center justify-between border-r border-border bg-sidebar">
        <div className="flex w-full flex-col items-center">
          <div className="flex h-14 w-full items-center justify-center border-b border-border">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => navigate(`/orgs/${workspaceSlug}/projects`)}
                  className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-80"
                >
                  <Boxes className="h-5 w-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Switch project</TooltipContent>
            </Tooltip>
          </div>
          <nav className="flex flex-col gap-1 pt-3">
            {MODULES.map((mod) => {
              const Icon = mod.icon;
              const to = `/app/${workspaceSlug}/${projectSlug}/${mod.slug}`;
              const isActive = activeModule === mod.slug;
              return (
                <Tooltip key={mod.slug}>
                  <TooltipTrigger asChild>
                    <NavLink
                      to={to}
                      className={cn(
                        "relative flex h-10 w-10 items-center justify-center rounded-md transition-colors",
                        isActive
                          ? "bg-secondary opacity-100 ring-1 ring-border"
                          : "opacity-60 hover:bg-sidebar-accent/40 hover:opacity-90",
                      )}
                    >
                      <Icon className={cn("h-[18px] w-[18px]", mod.color)} strokeWidth={1.5} />
                    </NavLink>
                  </TooltipTrigger>
                  <TooltipContent side="right">{mod.label}</TooltipContent>
                </Tooltip>
              );
            })}
          </nav>
        </div>
        <div className="flex flex-col items-center gap-2 pb-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => signOut()}
                className="flex h-10 w-10 items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Sign out</TooltipContent>
          </Tooltip>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-sm font-medium">
            {initial}
          </div>
        </div>
      </aside>
    </TooltipProvider>
  );
}
