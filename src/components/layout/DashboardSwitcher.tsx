import { useNavigate, useParams, useLocation } from "react-router-dom";
import { ChevronDown, Check } from "lucide-react";
import { GearSixIcon } from "@phosphor-icons/react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";
import { DASHBOARDS, dashboardLandingSlug } from "@/lib/navigation";
import { ADMIN_LANDING, isAdminRoute } from "@/lib/admin-navigation";
import { useActiveDashboard } from "./useActiveDashboard";

export function DashboardSwitcher() {
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const active = useActiveDashboard();
  const onAdmin = isAdminRoute(location.pathname);
  const base = workspaceSlug && projectSlug ? `/app/${workspaceSlug}/${projectSlug}` : "/orgs";
  const activeDef = DASHBOARDS.find((d) => d.id === active) ?? DASHBOARDS[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-white transition-colors hover:bg-white/10"
          aria-label="Changer de dashboard"
        >
          <Logo size={24} />
          <span className="truncate text-sm font-semibold">{onAdmin ? "Admin" : activeDef.label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-white/60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 p-1.5">
        {DASHBOARDS.map((d) => {
          const Icon = d.icon;
          const isActive = !onAdmin && d.id === active;
          return (
            <DropdownMenuItem
              key={d.id}
              onSelect={() => navigate(`${base}/${dashboardLandingSlug(d.id)}`)}
              className={cn("flex items-center gap-2.5 rounded-lg px-2 py-2", isActive && "bg-accent")}
            >
              <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white", d.color)}>
                <Icon weight="fill" className="h-[18px] w-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{d.label}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{d.description}</span>
              </span>
              {isActive && <Check className="h-4 w-4 shrink-0 text-primary" />}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator className="my-1.5" />

        <DropdownMenuItem
          onSelect={() => navigate(`${base}/admin/${ADMIN_LANDING}`)}
          className={cn("flex items-center gap-2.5 rounded-lg px-2 py-2", onAdmin && "bg-accent")}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <GearSixIcon weight="fill" className="h-[18px] w-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">Admin</span>
            <span className="block truncate text-[11px] text-muted-foreground">Organisation, accès, facturation, API</span>
          </span>
          {onAdmin && <Check className="h-4 w-4 shrink-0 text-primary" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
