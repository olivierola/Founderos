import { useNavigate, useParams } from "react-router-dom";
import {
  GearSixIcon, ListChecksIcon, ChartBarIcon, TrayIcon, PackageIcon, RobotIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { AgentIdentity } from "@/components/AgentIdentity";
import { AgentEvaluationPanel } from "@/features/internal-agents/AgentEvaluationPanel";
import { AgentTasksPanel } from "./AgentTasksPanel";
import { ArtifactViewer } from "./RoomArtifacts";
import { CollaboratorInbox } from "./CollaboratorInbox";
import { AgentSettingsPanel } from "./AgentSettingsPanel";
import { useWorkbench, type PanelKind, type PanelTab } from "./workbench";

// Ce que montre le panneau de droite, onglet par onglet.

export const PANEL_META: Record<PanelKind, { label: string; icon: PhosphorIcon; agentScoped: boolean }> = {
  "agent-settings": { label: "Réglages de l'agent", icon: GearSixIcon, agentScoped: true },
  tasks: { label: "Tâches", icon: ListChecksIcon, agentScoped: true },
  evaluation: { label: "Évaluation", icon: ChartBarIcon, agentScoped: true },
  inbox: { label: "À valider", icon: TrayIcon, agentScoped: false },
  artifact: { label: "Livrable", icon: PackageIcon, agentScoped: false },
};

/** Ce qu'on peut ouvrir depuis le « + » du panneau. */
export const OPENABLE: Exclude<PanelKind, "artifact">[] = ["agent-settings", "tasks", "evaluation", "inbox"];

export function panelTabLabel(t: PanelTab): string {
  if (t.kind === "artifact") return t.title || "Livrable";
  return PANEL_META[t.kind].label;
}

export function WorkbenchPanelBody() {
  const wb = useWorkbench();
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  if (!wb) return null;
  const tab = wb.activeTab;
  if (!tab) return null;
  const sbase = `/app/${workspaceSlug}/${projectSlug}/service/${wb.dashboardId}`;
  const agentId = wb.activeAgentId;

  if (PANEL_META[tab.kind].agentScoped && !agentId) {
    return <NoAgent dashboardId={wb.dashboardId} openAgents={wb.openAgents} onPick={(id) => navigate(`${sbase}/agent/${id}`)} />;
  }

  switch (tab.kind) {
    case "agent-settings":
      return <AgentSettingsPanel agentId={agentId!} dashboardId={wb.dashboardId} />;
    case "tasks":
      return <TasksFor agentId={agentId!} sbase={sbase} conversationId={wb.conversationId} />;
    case "evaluation":
      return (
        <AgentEvaluationPanel
          agentId={agentId!}
          onOpenLearnings={() => navigate(`${sbase}/agent-config/${agentId}?t=instructions`)}
        />
      );
    case "inbox":
      return <div className="h-full overflow-y-auto"><CollaboratorInbox dashboardId={wb.dashboardId} /></div>;
    case "artifact":
      return tab.artifact ? (
        <ArtifactViewer
          key={tab.id}
          target={tab.artifact}
          onBack={() => wb.closeTab(tab.id)}
          dense
        />
      ) : null;
  }
}

function TasksFor({ agentId, sbase, conversationId }: { agentId: string; sbase: string; conversationId: string | null }) {
  const { data: name } = useQuery({
    queryKey: ["sd_agent_name", agentId],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("name").eq("id", agentId).maybeSingle();
      return (data as { name: string } | null)?.name ?? "";
    },
  });
  return <AgentTasksPanel agentId={agentId} agentName={name ?? ""} sbase={sbase} activeConversationId={conversationId} />;
}

/** Un onglet d'agent sans agent affiché : on propose ceux qui sont ouverts,
 *  plutôt qu'un panneau vide qui ne dit pas quoi faire. */
function NoAgent({ dashboardId, openAgents, onPick }: {
  dashboardId: string; openAgents: string[]; onPick: (id: string) => void;
}) {
  const { data: agents } = useQuery({
    queryKey: ["sd_panel_agents", dashboardId],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents")
        .select("id, name, avatar_url, accent_color, is_orchestrator")
        .eq("service_dashboard_id", dashboardId).eq("is_archived", false)
        .order("is_orchestrator", { ascending: false }).order("created_at", { ascending: true });
      return (data ?? []) as Array<{ id: string; name: string; avatar_url: string | null }>;
    },
  });
  const list = (agents ?? []).filter((a) => openAgents.includes(a.id));
  const shown = list.length ? list : (agents ?? []).slice(0, 6);

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <RobotIcon className="h-5 w-5" />
      </span>
      <p className="mt-3 text-[13px] font-medium">Aucun agent affiché</p>
      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
        Ouvrez un agent pour voir ici ses réglages, ses tâches et son évaluation.
      </p>
      {shown.length > 0 && (
        <div className="mt-4 w-full max-w-[260px] space-y-1">
          {shown.map((a) => (
            <button
              key={a.id} type="button" onClick={() => onPick(a.id)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-muted"
            >
              <AgentIdentity url={a.avatar_url} seed={a.name} size={20} rounded="rounded-md" />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
