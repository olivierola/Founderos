import { useState } from "react";
import { NavLink, useSearchParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Hash, Lock, Plus } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface Channel { id: string; name: string; is_private: boolean; is_default: boolean }

interface Props { to: string; label: string }

// Secondary-sidebar entry that lists the project's inbox channels under the
// "Inbox" item. Selecting a channel navigates to pm/inbox?channel=<id>.
export function InboxChannelsItem({ to, label }: Props) {
  const [open, setOpen] = useState(true);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const activeChannel = searchParams.get("channel");
  const { projectId } = useCurrentContext();

  const { data: channels } = useQuery({
    queryKey: ["sidebar_pm_channels", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("project_channels")
        .select("id, name, is_private, is_default")
        .eq("project_id", projectId!)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: true });
      return (data ?? []) as Channel[];
    },
  });

  return (
    <div>
      <div className="flex items-center">
        <NavLink
          to={to}
          end
          className={({ isActive }) =>
            cn(
              "flex flex-1 items-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-sidebar-accent text-foreground"
                : "font-normal text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            )
          }
        >
          {label}
        </NavLink>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
          aria-label={open ? "Collapse channels" : "Expand channels"}
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />
        </button>
      </div>

      {open && (
        <div className="ml-2 mt-1 space-y-0.5 border-l border-border/60 pl-2">
          <button
            type="button"
            onClick={() => navigate(`${to}?new=1`)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
          >
            <Plus className="h-3 w-3" /> New channel
          </button>

          {(channels ?? []).length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">No channels yet.</p>
          ) : (
            (channels ?? []).map((c) => {
              const isActive = activeChannel === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => navigate(`${to}?channel=${c.id}`)}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    isActive
                      ? "bg-sidebar-accent text-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                  )}
                >
                  {c.is_private ? <Lock className="h-3 w-3 shrink-0 opacity-70" /> : <Hash className="h-3 w-3 shrink-0 opacity-70" />}
                  <span className="truncate">{c.name}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
