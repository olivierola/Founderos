import { useEffect } from "react";
import { NavLink, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { iconByName } from "@/features/crm/crmIcons";
import { ensureSeeded, type CrmObject } from "@/features/crm/objectModel";

// Secondary-sidebar entry that lists the project's CRM objects (People,
// Companies, Opportunities, Tasks, Notes, Software + custom). Each links to
// crm/workspace/<slug>. Replaces an in-page object sidebar (no third sidebar).
export function CrmObjectsItem() {
  const { workspaceSlug = "default", projectSlug = "default" } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const base = `/app/${workspaceSlug}/${projectSlug}/crm/workspace`;

  // Seed the default system objects on first visit.
  useEffect(() => {
    if (!workspaceId || !projectId) return;
    let cancelled = false;
    (async () => {
      await ensureSeeded(workspaceId, projectId, user?.id ?? null);
      if (!cancelled) queryClient.invalidateQueries({ queryKey: ["crm_objects", projectId] });
    })();
    return () => { cancelled = true; };
  }, [workspaceId, projectId, user?.id, queryClient]);

  const { data: objects } = useQuery({
    queryKey: ["crm_objects", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("crm_objects").select("*").eq("project_id", projectId!).order("position");
      return (data ?? []) as CrmObject[];
    },
  });

  return (
    <div className="space-y-0.5">
      {(objects ?? []).map((o) => {
        const Icon = iconByName(o.icon);
        return (
          <NavLink
            key={o.id}
            to={`${base}/${o.slug}`}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-sidebar-accent font-medium text-foreground"
                  : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )
            }
          >
            <Icon className={cn("h-4 w-4 shrink-0", o.color)} />
            <span className="truncate">{o.label_plural ?? o.label}</span>
          </NavLink>
        );
      })}
      <NavLink
        to={`${base}?new=1`}
        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
      >
        <Plus className="h-4 w-4 shrink-0" /> New object
      </NavLink>
    </div>
  );
}
