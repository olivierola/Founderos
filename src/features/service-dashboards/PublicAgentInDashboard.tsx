import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import {
  ArrowLeftIcon, ChatCircleIcon, BookOpenIcon, PuzzlePieceIcon, ChartBarIcon, CompassIcon,
  GearSixIcon, RobotIcon, StorefrontIcon, type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { FloatingTabBar } from "./FloatingTabBar";
import {
  PublicAgentTabBody, VALID_PUBLIC_AGENT_TABS, type Agent, type PublicAgentTab,
} from "@/features/agent-rag/AgentBuilder";

// A public (customer-facing) agent, configured INSIDE the service dashboard
// that owns it — the same move internal agents made in 0133. The six builder
// tabs are unchanged; what disappeared is the separate module page and its
// secondary sidebar. The active tab rides on ?t=, like the internal agent
// panel, because the dashboard route only has :tab/:sub to spend and both are
// already taken by "public" and the agent id.

const TABS: { key: PublicAgentTab; label: string; icon: PhosphorIcon }[] = [
  { key: "playground", label: "Playground", icon: ChatCircleIcon },
  { key: "knowledge", label: "Knowledge", icon: BookOpenIcon },
  { key: "widget", label: "Widget", icon: PuzzlePieceIcon },
  { key: "analytics", label: "Analytics", icon: ChartBarIcon },
  { key: "onboarding", label: "Onboarding", icon: CompassIcon },
  { key: "ecommerce", label: "E-commerce", icon: StorefrontIcon },
  { key: "settings", label: "Settings", icon: GearSixIcon },
];

export function PublicAgentInDashboard({ dashboardId, agentId }: { dashboardId: string; agentId: string }) {
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const sbase = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;

  const rawTab = params.get("t") || "playground";
  const tab = (VALID_PUBLIC_AGENT_TABS.includes(rawTab as PublicAgentTab) ? rawTab : "playground") as PublicAgentTab;
  const [barHeight, setBarHeight] = useState(48);

  const { data: agent, isLoading } = useQuery({
    queryKey: ["rag_agent", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data } = await supabase.from("rag_agents").select("*").eq("id", agentId).maybeSingle();
      return data as (Agent & { service_dashboard_id: string | null }) | null;
    },
  });

  // Self-healing: an agent whose dashboard was deleted (FK `on delete set null`)
  // arrives here through the redirect resolver. Opening it in a dashboard is
  // what files it there — otherwise it would stay invisible in every roster.
  const orphan = !!agent && !agent.service_dashboard_id;
  useEffect(() => {
    if (!orphan) return;
    void supabase.from("rag_agents").update({ service_dashboard_id: dashboardId }).eq("id", agentId);
  }, [orphan, agentId, dashboardId]);

  if (isLoading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (!agent) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <RobotIcon className="h-7 w-7 text-muted-foreground/50" />
        <div className="text-sm font-medium">Agent introuvable</div>
        <button onClick={() => navigate(`${sbase}/agents`)} className="text-xs text-muted-foreground underline">Retour aux agents</button>
      </div>
    );
  }

  const accent = agent.accent_color || "#001BB7";
  // Onboarding is a feature you switch on in Settings — the tab only exists
  // once it is on, so the strip never offers an empty room. E-commerce is not
  // gated the same way: connecting the store IS what that tab is for, so hiding
  // it until a store exists would hide its own entry point.
  const tabs = TABS.filter((t) => t.key !== "onboarding" || agent.onboarding_enabled);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Same language as the internal agent's pages: nothing solid at the top —
          the identity pill and the tab bar float over the content. */}
      <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start">
        <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-2 py-1 shadow-sm backdrop-blur">
          <button
            onClick={() => navigate(`${sbase}/agents`)}
            title="Retour aux agents"
            className="rounded-full p-0.5 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon className="h-3.5 w-3.5" />
          </button>
          <span className="flex h-5 w-5 items-center justify-center rounded-full" style={{ background: `${accent}26` }}>
            <RobotIcon weight="duotone" className="h-3.5 w-3.5" style={{ color: accent }} />
          </span>
          <span className="max-w-[160px] truncate text-xs font-semibold leading-tight">{agent.name}</span>
          <span
            className={cn("h-1.5 w-1.5 rounded-full", agent.enabled ? "bg-emerald-500" : "bg-muted-foreground/40")}
            title={agent.enabled ? "Agent public en ligne" : "Agent public désactivé"}
          />
        </div>
      </div>

      <FloatingTabBar
        // Only one floating pill here (the identity, on the left), so the bar
        // gets more room than on the internal agent's configuration page.
        className="max-w-[calc(100%-14rem)]"
        sections={tabs}
        active={tab}
        onHeight={setBarHeight}
        onSelect={(k) => setParams((p) => { const n = new URLSearchParams(p); n.set("t", k); return n; }, { replace: true })}
      />

      {/* Offset by the bar's measured height: it wraps to two lines when the
          window is narrow, so a fixed padding would overlap it. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10" style={{ paddingTop: barHeight + 28 }}>
        <PublicAgentTabBody agent={agent} tab={tab} workspaceId={workspaceId} projectId={projectId} />
      </div>
    </div>
  );
}
