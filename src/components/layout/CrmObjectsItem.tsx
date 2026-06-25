import { useEffect, useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, MoreHorizontal, EyeOff, Trash2, Eye } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { iconByName } from "@/features/crm/crmIcons";
import { ensureSeeded, type CrmObject } from "@/features/crm/objectModel";

export function CrmObjectsItem() {
  const { workspaceSlug = "default", projectSlug = "default" } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const base = `/app/${workspaceSlug}/${projectSlug}/crm/workspace`;
  const [showHidden, setShowHidden] = useState(false);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

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
      return (data ?? []) as (CrmObject & { hidden_in_sidebar?: boolean })[];
    },
  });

  async function toggleHide(obj: CrmObject & { hidden_in_sidebar?: boolean }) {
    const next = !obj.hidden_in_sidebar;
    await supabase.from("crm_objects").update({ hidden_in_sidebar: next }).eq("id", obj.id);
    queryClient.invalidateQueries({ queryKey: ["crm_objects", projectId] });
    setMenuOpen(null);
  }

  async function deleteObject(obj: CrmObject) {
    if (!confirm(`Delete "${obj.label_plural ?? obj.label}" and all its records? This cannot be undone.`)) return;
    await supabase.from("crm_objects").delete().eq("id", obj.id);
    queryClient.invalidateQueries({ queryKey: ["crm_objects", projectId] });
    setMenuOpen(null);
  }

  const visible = (objects ?? []).filter((o) => !o.hidden_in_sidebar);
  const hidden = (objects ?? []).filter((o) => o.hidden_in_sidebar);

  return (
    <div className="space-y-0.5">
      {visible.map((o) => {
        const Icon = iconByName(o.icon);
        return (
          <div key={o.id} className="group relative flex items-center">
            <NavLink
              to={`${base}/${o.slug}`}
              className={({ isActive }) =>
                cn(
                  "flex flex-1 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-sidebar-accent font-medium text-foreground"
                    : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )
              }
            >
              <Icon className={cn("h-4 w-4 shrink-0 opacity-60", o.color)} />
              <span className="truncate">{o.label_plural ?? o.label}</span>
            </NavLink>
            <button onClick={(e) => { e.stopPropagation(); setMenuOpen(menuOpen === o.id ? null : o.id); }}
              className="absolute right-1 hidden rounded p-1 text-muted-foreground hover:text-foreground group-hover:block">
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>

            {menuOpen === o.id && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(null)} />
                <div className="absolute right-0 top-8 z-50 w-40 rounded-lg border border-border bg-card py-1 shadow-xl">
                  <button onClick={() => toggleHide(o)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground">
                    <EyeOff className="h-3.5 w-3.5" /> Hide
                  </button>
                  {!o.is_system && (
                    <button onClick={() => deleteObject(o)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10">
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })}

      <NavLink
        to={`${base}?new=1`}
        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
      >
        <Plus className="h-4 w-4 shrink-0" /> New object
      </NavLink>

      {/* Show/hide hidden objects */}
      {hidden.length > 0 && (
        <div className="pt-2">
          <button onClick={() => setShowHidden(!showHidden)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground">
            <Eye className="h-3 w-3" /> {showHidden ? "Hide" : "Show"} {hidden.length} hidden
          </button>
          {showHidden && hidden.map((o) => {
            const Icon = iconByName(o.icon);
            return (
              <div key={o.id} className="flex items-center gap-2 rounded-md px-3 py-1.5 opacity-50">
                <Icon className={cn("h-4 w-4 shrink-0", o.color)} />
                <span className="flex-1 truncate text-sm">{o.label_plural ?? o.label}</span>
                <button onClick={() => toggleHide(o)} className="rounded p-0.5 text-muted-foreground hover:text-foreground" title="Show">
                  <Eye className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
