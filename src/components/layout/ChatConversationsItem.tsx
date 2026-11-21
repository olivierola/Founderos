import { useState } from "react";
import { NavLink, useSearchParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  CaretDownIcon as ChevronDown,
  ChatIcon as MessageSquare,
  PlusIcon as Plus,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { navItem, navSubItem } from "./navStyles";

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
        <NavLink to={to} end className={({ isActive }) => navItem(isActive, "flex-1")}>
          {label}
        </NavLink>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
          aria-label={open ? "Collapse conversations" : "Expand conversations"}
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />
        </button>
      </div>

      {open && (
        <div className="mt-0.5 space-y-0.5 pl-4">
          <button
            type="button"
            onClick={() => navigate(to)}
            className={cn(navSubItem(false), "text-primary hover:text-primary")}
          >
            <Plus className="h-3 w-3" />
            New conversation
          </button>

          {(conversations ?? []).length === 0 ? (
            <p className="px-2.5 py-1.5 text-[11.5px] text-muted-foreground">No conversations yet.</p>
          ) : (
            (conversations ?? []).map((c) => {
              const isActive = activeConvoId === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => navigate(`${to}?c=${c.id}`)}
                  className={navSubItem(isActive)}
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
