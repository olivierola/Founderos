import { useState } from "react";
import { NavLink, useSearchParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, MessageSquare, Plus } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface Conversation {
  id: string;
  title: string | null;
  updated_at: string;
}

interface Props {
  to: string;
  label: string;
}

export function ChatConversationsItem({ to, label }: Props) {
  const [open, setOpen] = useState(true);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const activeConvoId = searchParams.get("c");
  const { projectId } = useCurrentContext();

  const { data: conversations } = useQuery({
    queryKey: ["sidebar_ai_conversations", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_conversations")
        .select("id, title, updated_at")
        .eq("project_id", projectId!)
        .order("updated_at", { ascending: false })
        .limit(30);
      return (data ?? []) as Conversation[];
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
          aria-label={open ? "Collapse conversations" : "Expand conversations"}
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />
        </button>
      </div>

      {open && (
        <div className="ml-2 mt-1 space-y-0.5 border-l border-border/60 pl-2">
          <button
            type="button"
            onClick={() => navigate(to)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            New conversation
          </button>

          {(conversations ?? []).length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">No conversations yet.</p>
          ) : (
            (conversations ?? []).map((c) => {
              const isActive = activeConvoId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => navigate(`${to}?c=${c.id}`)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    isActive
                      ? "bg-sidebar-accent text-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                  )}
                >
                  <MessageSquare className="h-3 w-3 shrink-0 opacity-70" />
                  <span className="truncate">{c.title ?? "Untitled"}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
