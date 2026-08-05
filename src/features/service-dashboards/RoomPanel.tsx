import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users, ListChecks, Package, X, Plus } from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { AgentIdentity } from "@/components/AgentIdentity";
import { cn } from "@/lib/utils";
import { useResizableWidth } from "@/hooks/useResizableWidth";
import { type ArtifactOpenTarget } from "@/features/internal-agents/UiBlocks";
import { FloatingTabBar } from "./FloatingTabBar";
import { RoomGraph } from "./RoomGraph";
import { RoomArtifacts } from "./RoomArtifacts";
import { MissionsList } from "./ServiceDashboardTabs";

type RoomAgent = { id: string; name: string; avatar_url: string | null; is_orchestrator: boolean; accent_color?: string | null };
type PanelTab = "general" | "task" | "artifacts";

const PANEL_TABS: { key: PanelTab; label: string; icon: typeof Users }[] = [
  { key: "general", label: "General", icon: Users },
  { key: "task", label: "Task", icon: ListChecks },
  { key: "artifacts", label: "Artifacts", icon: Package },
];

/**
 * Room's right panel — General (who's in it, as a graph, + pending-input
 * status) / Task (their missions) / Artifacts (a rich-document gallery,
 * scoped to this room's participants/creations, not the whole dashboard).
 */
export function RoomPanel({
  roomId, workspaceId, projectId, participants, addable, openArtifact, onOpenArtifactHandled, onAdd, onRemove, onClose,
}: {
  roomId: string;
  workspaceId: string;
  projectId: string | null;
  participants: RoomAgent[];
  addable: RoomAgent[];
  /** An artifact clicked from a chat card — forces the Artifacts tab open on it. */
  openArtifact: ArtifactOpenTarget | null;
  onOpenArtifactHandled: () => void;
  onAdd: (agentId: string) => void;
  onRemove: (agentId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<PanelTab>("general");
  const [viewingArtifact, setViewingArtifact] = useState(false);
  const { width, startResize } = useResizableWidth("room_panel_width", 320, 260, 1000);
  const participantIds = participants.map((a) => a.id);
  const nameOf = new Map(participants.map((a) => [a.id, a.name]));

  useEffect(() => {
    if (openArtifact) setTab("artifacts");
  }, [openArtifact]);

  const { data: pending } = useQuery({
    queryKey: ["sd_room_pending", participantIds.join(",")],
    enabled: participantIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_approvals")
        .select("agent_id").eq("status", "pending").in("agent_id", participantIds);
      return (data ?? []).map((r) => r.agent_id as string);
    },
  });

  return (
    <aside className="relative hidden shrink-0 flex-col border-l border-border bg-card/40 lg:flex" style={{ width }}>
      <div
        onMouseDown={startResize}
        className="absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/40"
        title="Glisser pour redimensionner"
      />

      {/* Floating tab switcher — hidden while an artifact editor (which has its
          own header) fills the panel. */}
      {!viewingArtifact && (
        <FloatingTabBar
          sections={PANEL_TABS}
          active={tab}
          onSelect={setTab}
          trailing={
            <button onClick={onClose} className="shrink-0 rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-4 w-4" /></button>
          }
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "general" && (
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-[2]"><RoomGraph participants={participants} pendingAgentIds={pending ?? []} /></div>
            <div className="space-y-1 border-t border-border/60 p-3">
              {participants.map((a) => (
                <div key={a.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted/60">
                  <AgentIdentity url={a.avatar_url} seed={a.name} size={20} rounded="rounded-full" />
                  <span className="min-w-0 flex-1 truncate">{a.name}{a.is_orchestrator ? " · assistant" : ""}</span>
                  {!a.is_orchestrator && (
                    <button onClick={() => onRemove(a.id)} className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"><X className="h-3.5 w-3.5" /></button>
                  )}
                </div>
              ))}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90">
                    <Plus className="h-3.5 w-3.5" /> Add
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center" className="w-52 rounded-xl">
                  {addable.length === 0 ? <div className="px-2 py-2 text-xs text-muted-foreground">Tous les agents sont déjà là.</div> :
                    addable.map((a) => (
                      <DropdownMenuItem key={a.id} className="rounded-lg" onSelect={() => onAdd(a.id)}>
                        <AgentIdentity url={a.avatar_url} seed={a.name} size={16} rounded="rounded-full" className="mr-2" /> {a.name}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}
        {tab === "task" && <div className="pt-14"><MissionsList agentIds={participantIds} nameOf={nameOf} /></div>}
        {tab === "artifacts" && (
          <div className={cn(!viewingArtifact && "pt-14", "h-full")}>
            <RoomArtifacts
              roomId={roomId} workspaceId={workspaceId} projectId={projectId}
              openArtifact={openArtifact} onOpenArtifactHandled={onOpenArtifactHandled}
              onViewingChange={setViewingArtifact}
            />
          </div>
        )}
      </div>
    </aside>
  );
}
