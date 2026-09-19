import { useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CaretDownIcon as ChevronDown,
  CheckIcon as Check,
  PlusIcon as Plus,
  CubeIcon as Boxes,
  CircleNotchIcon as Loader2,
} from "@phosphor-icons/react";
import { GearSixIcon } from "@phosphor-icons/react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";
import { DASHBOARDS, dashboardLandingSlug } from "@/lib/navigation";
import { ADMIN_LANDING, isAdminRoute } from "@/lib/admin-navigation";
import { useActiveDashboard } from "./useActiveDashboard";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAuth } from "@/lib/auth-context";
import { fetchServiceDashboards, createServiceDashboard } from "@/features/service-dashboards/model";

export function DashboardSwitcher() {
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const active = useActiveDashboard();
  const onAdmin = isAdminRoute(location.pathname);
  const base = workspaceSlug && projectSlug ? `/app/${workspaceSlug}/${projectSlug}` : "/orgs";
  const activeDef = DASHBOARDS.find((d) => d.id === active) ?? DASHBOARDS[0];
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const { data: services } = useQuery({
    queryKey: ["service_dashboards", projectId],
    enabled: !!projectId,
    queryFn: () => fetchServiceDashboards(projectId!),
  });

  async function createService() {
    if (!name.trim() || !workspaceId || !projectId) return;
    setSaving(true);
    try {
      const d = await createServiceDashboard(workspaceId, projectId, user?.id ?? null, { name });
      queryClient.invalidateQueries({ queryKey: ["service_dashboards", projectId] });
      setCreating(false); setName("");
      if (d) navigate(`${base}/service/${d.id}`);
    } finally { setSaving(false); }
  }

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

        {(services ?? []).length > 0 && (
          <>
            <DropdownMenuSeparator className="my-1.5" />
            <DropdownMenuLabel className="px-2 text-[10px] uppercase text-muted-foreground">Services</DropdownMenuLabel>
            {(services ?? []).map((s) => (
              <DropdownMenuItem key={s.id} onSelect={() => navigate(`${base}/service/${s.id}`)}
                className="flex items-center gap-2.5 rounded-lg px-2 py-2">
                <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white", s.color)}><Boxes className="h-[18px] w-[18px]" /></span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{s.name}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setCreating(true); }} className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-indigo-500">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-dashed border-indigo-400/50"><Plus className="h-[18px] w-[18px]" /></span>
          <span className="text-sm font-semibold">Nouveau dashboard de service</span>
        </DropdownMenuItem>

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

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Nouveau dashboard de service</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Un espace dédié à un service — ses agents, rooms, tâches et un hub Assets — séparé du reste.</p>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createService()} placeholder="ex. Marketing, Support, Finance…" />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCreating(false)}>Annuler</Button>
              <Button onClick={createService} disabled={!name.trim() || saving}>{saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Créer</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </DropdownMenu>
  );
}
