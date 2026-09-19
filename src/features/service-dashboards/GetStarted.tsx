import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  CheckIcon, CaretDownIcon, CaretRightIcon, RobotIcon, PlugsConnectedIcon,
  ChatsCircleIcon, CalendarDotsIcon, UsersThreeIcon, type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { BrandLogo } from "@/components/BrandLogo";
import { cn } from "@/lib/utils";

export interface GetStartedItem {
  key: string;
  label: string;
  icon: PhosphorIcon;
  done: boolean;
  go: string;
  /** Connector slugs drawn as brand logos on the row (Home card only). */
  logos?: string[];
}

/**
 * The dashboard's onboarding checklist, as data. Every item is a real query
 * against this dashboard's own rows — nothing is "checked" by clicking it,
 * only by actually doing the thing — so the sidebar card and the Home card
 * below the composer always agree, off one shared fetch.
 */
export function useGetStarted(dashboardId: string) {
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId } = useCurrentContext();
  const base = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;

  const { data } = useQuery({
    queryKey: ["sd_getstarted", dashboardId, workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data: agents } = await supabase
        .from("internal_agents").select("id, is_orchestrator")
        .eq("service_dashboard_id", dashboardId).eq("is_archived", false);
      const rows = (agents ?? []) as Array<{ id: string; is_orchestrator: boolean }>;
      const agentIds = rows.map((a) => a.id);
      const [rooms, missions, members, connectors] = await Promise.all([
        supabase.from("service_rooms").select("id", { count: "exact", head: true }).eq("dashboard_id", dashboardId),
        agentIds.length
          ? supabase.from("internal_agent_missions").select("id", { count: "exact", head: true })
              .in("agent_id", agentIds).not("schedule", "is", null)
          : Promise.resolve({ count: 0 }),
        supabase.from("workspace_members").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId!),
        supabase.from("connectors").select("id", { count: "exact", head: true })
          .eq("workspace_id", workspaceId!).eq("status", "connected"),
      ]);
      return {
        agents: rows.filter((a) => !a.is_orchestrator).length,
        rooms: rooms.count ?? 0,
        schedules: missions.count ?? 0,
        members: members.count ?? 0,
        connectors: connectors.count ?? 0,
      };
    },
  });

  const items: GetStartedItem[] = [
    { key: "agent", label: "Créez votre premier agent", icon: RobotIcon, done: (data?.agents ?? 0) > 0, go: `${base}/agents/new` },
    {
      key: "connectors", label: "Connectez vos applications", icon: PlugsConnectedIcon,
      done: (data?.connectors ?? 0) > 0, go: `${base}/connectors`,
      logos: ["slack", "notion", "gmail", "google-calendar", "github"],
    },
    { key: "room", label: "Lancez votre première room", icon: ChatsCircleIcon, done: (data?.rooms ?? 0) > 0, go: `${base}/home` },
    { key: "schedule", label: "Planifiez un travail récurrent", icon: CalendarDotsIcon, done: (data?.schedules ?? 0) > 0, go: `${base}/schedules` },
    { key: "members", label: "Invitez vos coéquipiers", icon: UsersThreeIcon, done: (data?.members ?? 0) > 1, go: `/app/${workspaceSlug}/${projectSlug}/admin/members` },
  ];
  const done = items.filter((i) => i.done).length;
  return { items, done, total: items.length, ready: !!data };
}

/** Progress ring — the count as a shape, at the right of the card header. */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 -rotate-90">
      <circle cx="12" cy="12" r={r} fill="none" strokeWidth="2" className="stroke-border" />
      <circle
        cx="12" cy="12" r={r} fill="none" strokeWidth="2" strokeLinecap="round"
        className="stroke-foreground transition-[stroke-dashoffset] duration-500"
        strokeDasharray={c} strokeDashoffset={c * (1 - done / total)}
      />
    </svg>
  );
}

/**
 * The Home card: the same checklist, given room to breathe — one row per step,
 * each a link to the place where that step is actually done.
 *
 * Unlike the sidebar card this one NEVER disappears: it is the second block of
 * the landing page, and a page that loses half its content the day the last box
 * is ticked is a page that breaks. Once everything is done it keeps standing as
 * the five shortcuts it always was, under a title that says so.
 */
export function GetStartedCard({ dashboardId, className }: { dashboardId: string; className?: string }) {
  const navigate = useNavigate();
  const { items, done, total, ready } = useGetStarted(dashboardId);
  const complete = ready && done === total;

  return (
    <div className={cn("overflow-hidden rounded-[22px] border border-border/70", className)}>
      <div className="flex items-center gap-3 px-5 py-4">
        <span className="text-sm font-medium">{complete ? "Votre espace est prêt" : "Configurer votre espace"}</span>
        {/* No count until the queries have answered — "0 / 5" on a fully set-up
            workspace, for the half-second before the data lands, is a lie. */}
        {ready && (
          <>
            <span className="ml-auto text-[13px] tabular-nums text-muted-foreground">{done} / {total}</span>
            <ProgressRing done={done} total={total} />
          </>
        )}
      </div>
      <div className="px-2 pb-2">
        {items.map((it) => (
          <button
            key={it.key}
            onClick={() => navigate(it.go)}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-muted/50"
          >
            <span className={cn(
              "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-dashed",
              it.done ? "border-solid border-foreground bg-foreground text-background" : "border-muted-foreground/50",
            )}>
              {it.done && <CheckIcon className="h-2.5 w-2.5" weight="bold" />}
            </span>
            <span className={cn("min-w-0 flex-1 truncate text-sm", it.done ? "text-muted-foreground" : "text-foreground")}>
              {it.label}
            </span>
            {it.logos && !it.done && (
              <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
                {it.logos.map((slug) => <BrandLogo key={slug} slug={slug} className="h-4 w-4" />)}
              </span>
            )}
            <CaretRightIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Onboarding checklist pinned to the foot of the service sidebar — the compact
 * form of the same data, collapsible and remembered per dashboard. The card
 * disappears once every step is done.
 */
export function SidebarGetStarted({ dashboardId }: { dashboardId: string }) {
  const navigate = useNavigate();
  const { items, done, total, ready } = useGetStarted(dashboardId);
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(`sd-getstarted-${dashboardId}`) !== "0"; } catch { return true; }
  });
  const toggle = () => setOpen((v) => {
    const next = !v;
    try { localStorage.setItem(`sd-getstarted-${dashboardId}`, next ? "1" : "0"); } catch { /* noop */ }
    return next;
  });

  if (!ready || done === total) return null;

  return (
    <div className="mx-2.5 mb-2 rounded-2xl border border-border/60 bg-card/40 p-3">
      <button onClick={toggle} className="flex w-full items-center gap-2 text-left">
        <span className="text-sm font-semibold">Get started</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{done}/{total}</span>
        <span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-primary transition-[width]" style={{ width: `${(done / total) * 100}%` }} />
        </span>
        <CaretDownIcon className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <div className="mt-2.5 space-y-1.5">
          {items.map((it) => (
            <button
              key={it.key}
              onClick={() => navigate(it.go)}
              className="flex w-full items-center gap-2 text-left text-[13px] transition-colors"
            >
              <span className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                it.done ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
              )}>
                {it.done && <CheckIcon className="h-2.5 w-2.5" weight="bold" />}
              </span>
              <span className={cn("min-w-0 flex-1 truncate", it.done ? "text-primary" : "text-foreground")}>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
