import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { CheckIcon, CaretDownIcon } from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

/**
 * Onboarding checklist pinned to the foot of the service sidebar. Every item is
 * a real query against this dashboard's own data — nothing is "checked" by
 * clicking it, only by actually doing the thing. The card disappears once the
 * four steps are done.
 */
export function SidebarGetStarted({ dashboardId }: { dashboardId: string }) {
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId } = useCurrentContext();
  const navigate = useNavigate();
  const base = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(`sd-getstarted-${dashboardId}`) !== "0"; } catch { return true; }
  });
  const toggle = () => setOpen((v) => {
    const next = !v;
    try { localStorage.setItem(`sd-getstarted-${dashboardId}`, next ? "1" : "0"); } catch { /* noop */ }
    return next;
  });

  const { data } = useQuery({
    queryKey: ["sd_getstarted", dashboardId, workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data: agents } = await supabase
        .from("internal_agents").select("id, is_orchestrator")
        .eq("service_dashboard_id", dashboardId).eq("is_archived", false);
      const rows = (agents ?? []) as Array<{ id: string; is_orchestrator: boolean }>;
      const agentIds = rows.map((a) => a.id);
      const [rooms, missions, members] = await Promise.all([
        supabase.from("service_rooms").select("id", { count: "exact", head: true }).eq("dashboard_id", dashboardId),
        agentIds.length
          ? supabase.from("internal_agent_missions").select("id", { count: "exact", head: true })
              .in("agent_id", agentIds).not("schedule", "is", null)
          : Promise.resolve({ count: 0 }),
        supabase.from("workspace_members").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId!),
      ]);
      return {
        agents: rows.filter((a) => !a.is_orchestrator).length,
        rooms: rooms.count ?? 0,
        schedules: missions.count ?? 0,
        members: members.count ?? 0,
      };
    },
  });

  const items = [
    { label: "Créez votre premier agent", done: (data?.agents ?? 0) > 0, go: `${base}/agents` },
    { label: "Lancez votre première room", done: (data?.rooms ?? 0) > 0, go: `${base}/home` },
    { label: "Planifiez un travail récurrent", done: (data?.schedules ?? 0) > 0, go: `${base}/schedules` },
    { label: "Invitez vos coéquipiers", done: (data?.members ?? 0) > 1, go: `/app/${workspaceSlug}/${projectSlug}/admin/members` },
  ];
  const done = items.filter((i) => i.done).length;
  if (!data || done === items.length) return null;

  return (
    <div className="mx-2.5 mb-2 rounded-2xl border border-border/60 bg-card/40 p-3">
      <button onClick={toggle} className="flex w-full items-center gap-2 text-left">
        <span className="text-sm font-semibold">Get started</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{done}/{items.length}</span>
        <span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-primary transition-[width]" style={{ width: `${(done / items.length) * 100}%` }} />
        </span>
        <CaretDownIcon className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="mt-2.5 space-y-1.5">
          {items.map((it) => (
            <button
              key={it.label}
              onClick={() => navigate(it.go)}
              className="flex w-full items-center gap-2 text-left text-[13px] transition-colors"
            >
              <span className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                it.done ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
              )}>
                {it.done && <CheckIcon className="h-2.5 w-2.5" strokeWidth={3.5} />}
              </span>
              <span className={cn("min-w-0 flex-1 truncate", it.done ? "text-primary" : "text-foreground")}>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
