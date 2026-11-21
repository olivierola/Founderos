import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CaretUpDownIcon,
  CheckIcon as Check,
  PlusIcon as Plus,
  CircleNotchIcon as Loader2,
} from "@phosphor-icons/react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DashboardTile } from "@/features/service-dashboards/dashboardIcons";
import { DASHBOARDS, dashboardLandingSlug } from "@/lib/navigation";
import { useActiveDashboard } from "./useActiveDashboard";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAuth } from "@/lib/auth-context";
import { fetchServiceDashboards, createServiceDashboard } from "@/features/service-dashboards/model";

export function DashboardSwitcher() {
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const active = useActiveDashboard();
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

  const ActiveIcon = activeDef.icon;
  return (
    <DropdownMenu>
      {/* Le même sélecteur que dans un tableau de service (DashboardSelector) :
          la tuile du tableau, son nom, et le menu qui mène partout ailleurs. */}
      <DropdownMenuTrigger asChild>
        <button
          className="-ml-1 flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left text-foreground transition-colors hover:bg-muted/60"
          aria-label="Changer de dashboard"
          title={activeDef.label}
        >
          <span className={cn("flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-primary-foreground", activeDef.color)}>
            <ActiveIcon weight="fill" className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 truncate text-[14px] font-semibold tracking-tight">{activeDef.label}</span>
          <CaretUpDownIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="w-64 rounded-2xl p-1.5">
        <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">Dashboards produit</DropdownMenuLabel>
        {DASHBOARDS.map((d) => {
          const Icon = d.icon;
          const isActive = d.id === active;
          return (
            <DropdownMenuItem
              key={d.id}
              onSelect={() => navigate(`${base}/${dashboardLandingSlug(d.id)}`)}
              className={cn("rounded-xl", isActive && "bg-accent")}
            >
              <span className={cn("mr-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-primary-foreground", d.color)}>
                <Icon weight="fill" className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate">{d.label}</span>
              {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
            </DropdownMenuItem>
          );
        })}

        {(services ?? []).length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">Services</DropdownMenuLabel>
            {(services ?? []).map((s) => (
              <DropdownMenuItem key={s.id} onSelect={() => navigate(`${base}/service/${s.id}`)} className="rounded-xl">
                <DashboardTile icon={s.icon} color={s.color} size={24} className="mr-2" />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setCreating(true); }} className="rounded-xl text-primary">
          <Plus className="mr-2 h-4 w-4" /> Nouveau dashboard de service
        </DropdownMenuItem>

      </DropdownMenuContent>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Nouveau dashboard de service</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Un espace dédié à un service, ses collaborateurs, rooms, tâches et un hub Assets, séparé du reste.</p>
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
