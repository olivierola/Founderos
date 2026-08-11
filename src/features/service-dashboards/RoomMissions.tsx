import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Target, Loader2, Play, Pause, CheckCircle2, XCircle, AlertTriangle,
  FileText, GitBranch, LayoutGrid, ListChecks, Activity, RefreshCw, Users, Plus, Trash2,
  X, Hash, ChevronDown, Check, Sparkles, PencilLine, Calendar, GripVertical,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { AgentIdentity } from "@/components/AgentIdentity";
import { RunTimeline } from "@/features/internal-agents/RunTimeline";
import { type ArtifactOpenTarget } from "@/features/internal-agents/UiBlocks";
import { cn } from "@/lib/utils";
import { MissionTimeline } from "./MissionTimeline";
import {
  fetchRoomMissions, fetchDashboardMissions, fetchMission, fetchMissionMilestones, fetchMissionTasks,
  fetchMissionEvents, fetchMissionDeliverables, setTaskStatus, setMissionStatus,
  advanceMission, assignTaskAgent, createMissionFromForm, createMissionTask, deleteMissionTask, deleteMission,
  fetchRooms, createRoom,
  KANBAN_COLUMNS, MISSION_STATUS_META,
  type RoomMission, type RoomTask, type TaskStatus, type RoomMilestone,
} from "./model";

type Participant = { id: string; name: string; avatar_url: string | null; accent_color: string | null };

// ─────────────────────────────────────────────────────────────────────────────
// Board — every mission of the room, as cards
// ─────────────────────────────────────────────────────────────────────────────

export function MissionsBoard({ roomId, dashboardId, onOpen }: {
  roomId: string; dashboardId: string; onOpen: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const { data: missions, isLoading } = useQuery({
    queryKey: ["room_missions", roomId],
    queryFn: () => fetchRoomMissions(roomId),
    // A mission moves on its own (agents finish, the frontier advances), so the
    // board polls while anything is live and goes quiet once nothing is.
    refetchInterval: (q) =>
      (q.state.data as RoomMission[] | undefined)?.some((m) => ["planning", "running"].includes(m.status)) ? 4000 : false,
  });

  // presetRoomId is set, so the panel never needs to create a room — hence no
  // dashboard name / workspace ids to hand it.
  const dialog = (
    <NewMissionPanel
      dashboardId={dashboardId} dashboardName=""
      workspaceId={null} projectId={null} presetRoomId={roomId}
      open={creating} onOpenChange={setCreating}
      onCreated={(id) => { qc.invalidateQueries({ queryKey: ["room_missions", roomId] }); onOpen(id); }}
    />
  );

  if (isLoading) {
    return <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (!missions?.length) {
    return (
      <div className="mx-auto max-w-md py-20 text-center">
        {dialog}
        <Target className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm font-medium">Aucune mission dans cette room</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Demandez à l'assistant un travail qui demande plusieurs compétences — il le découpe en jalons et tâches,
          les répartit entre les agents, et pilote l'exécution ici. Ou créez-en une directement.
        </p>
        <Button className="mt-5" onClick={() => setCreating(true)}>
          <Plus className="mr-1.5 h-4 w-4" /> Nouvelle mission
        </Button>
      </div>
    );
  }
  return (
    <>
      {dialog}
      <div className="mb-3 flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Nouvelle mission
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {missions.map((m) => <MissionCard key={m.id} mission={m} onOpen={() => onOpen(m.id)} />)}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Creating a mission by hand
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A mission normally starts in conversation, but it must also be creatable
 * outright — planning work is not always a chat.
 *
 * Two modes, and the distinction matters: "auto" hands the brief to the room's
 * assistant, which decomposes and staffs it exactly as it would in the thread;
 * "empty" creates the shell for someone who already knows the plan and wants to
 * author the cards themselves. A mission always belongs to a room (that is
 * where its agents talk and its reports land), so the form picks one — or
 * creates one when the service has none yet.
 */
export function NewMissionPanel({
  dashboardId, dashboardName, workspaceId, projectId, presetRoomId, open, onOpenChange, onCreated,
}: {
  dashboardId: string;
  dashboardName: string;
  workspaceId: string | null;
  projectId: string | null;
  /** Opened from inside a room → that room is the only sensible target. */
  presetRoomId?: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (missionId: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [mode, setMode] = useState<"auto" | "empty">("auto");
  // null = untouched (defaults to the most recent room); "" = the person
  // explicitly asked for a dedicated room. Collapsing the two into "" made
  // "Créer une room dédiée" silently fall back to the first existing room.
  const [roomId, setRoomId] = useState<string | null>(presetRoomId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: rooms } = useQuery({
    queryKey: ["service_rooms", dashboardId],
    enabled: open && !presetRoomId,
    queryFn: () => fetchRooms(dashboardId),
  });
  const targetRoom = presetRoomId ?? (roomId === null ? ((rooms ?? [])[0]?.id ?? "") : roomId);

  async function submit() {
    if (!title.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      // No room yet? Make one rather than blocking the person on a concept
      // they haven't met — the mission needs a home, they don't need to know.
      let room = targetRoom;
      if (!room) {
        if (!workspaceId || !projectId) throw new Error("Espace de travail introuvable.");
        const { data: auth } = await supabase.auth.getUser();
        room = (await createRoom({ id: dashboardId, name: dashboardName }, workspaceId, projectId, auth.user?.id ?? null, title.trim().slice(0, 60))) ?? "";
        if (!room) throw new Error("Impossible de créer une room pour cette mission.");
      }
      const id = await createMissionFromForm({ roomId: room, title: title.trim(), objective: objective.trim(), mode });
      if (!id) throw new Error("La mission n'a pas pu être créée.");
      setTitle(""); setObjective("");
      onOpenChange(false);
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur inconnue");
    } finally { setBusy(false); }
  }

  // Esc closes, like every other floating surface in the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onOpenChange(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onOpenChange]);

  if (!open) return null;

  const roomLabel = (rooms ?? []).find((r) => r.id === targetRoom)?.title ?? null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px]" onClick={() => !busy && onOpenChange(false)} />
      <aside className="fixed right-4 top-4 bottom-4 z-50 flex w-[560px] max-w-[94vw] flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl ring-1 ring-black/5 animate-in slide-in-from-right-4 fade-in duration-200">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 px-5">
          <Target className="h-4 w-4 text-primary" />
          <span className="min-w-0 flex-1 text-sm font-semibold">Nouvelle mission</span>
          <button
            onClick={() => onOpenChange(false)} disabled={busy}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
          ><X className="h-4 w-4" /></button>
        </header>

        {/* The whole body is the document: a title line and the brief, nothing
            else competing for attention. The brief is what the planner and
            then the agents actually read, so it gets the room to be written
            properly rather than a four-line box. */}
        <div className="flex min-h-0 flex-1 flex-col px-5 pt-5">
          <input
            value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
            placeholder="Titre de la mission"
            className="w-full shrink-0 border-none bg-transparent text-[22px] font-semibold leading-tight tracking-tight outline-none placeholder:text-muted-foreground/50"
          />
          <div className="my-4 h-px shrink-0 bg-border/60" />
          <textarea
            value={objective} onChange={(e) => setObjective(e.target.value)}
            placeholder={
              "Décrivez la mission en détail.\n\n" +
              "· Ce qu'il faut obtenir, concrètement\n" +
              "· Les contraintes, les sources, le périmètre\n" +
              "· À quoi on reconnaît que c'est fait\n\n" +
              "Plus c'est précis, mieux l'assistant découpe et répartit."
            }
            className="min-h-0 w-full flex-1 resize-none border-none bg-transparent pb-5 text-sm leading-relaxed outline-none placeholder:whitespace-pre-line placeholder:text-muted-foreground/50"
          />
        </div>

        <footer className="shrink-0 border-t border-border/60 px-5 py-3">
          {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            {!presetRoomId && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-3 py-1.5 text-xs font-medium transition-colors hover:border-border">
                    <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="max-w-[140px] truncate">{roomLabel ?? "Nouvelle room"}</span>
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" side="top" className="w-60 rounded-xl">
                  <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Où la mission se déroule</DropdownMenuLabel>
                  {(rooms ?? []).map((r) => (
                    <DropdownMenuItem key={r.id} className="rounded-lg" onSelect={() => setRoomId(r.id)}>
                      <Hash className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{r.title}</span>
                      {targetRoom === r.id && <Check className="ml-2 h-3.5 w-3.5 text-primary" />}
                    </DropdownMenuItem>
                  ))}
                  {(rooms ?? []).length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem className="rounded-lg" onSelect={() => setRoomId("")}>
                    <Plus className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
                    <span className="min-w-0 flex-1">Créer une room dédiée</span>
                    {targetRoom === "" && <Check className="ml-2 h-3.5 w-3.5 text-primary" />}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Who writes the plan. Two states, so a toggle — a pair of cards
                for a binary choice was more furniture than decision. */}
            <div className="flex items-center rounded-full border border-border/70 bg-card p-0.5">
              <ModePill
                active={mode === "auto"} onClick={() => setMode("auto")} icon={Sparkles} label="Assistant"
                title="L'assistant découpe en jalons et tâches, répartit entre les agents (en en créant si besoin) et démarre."
              />
              <ModePill
                active={mode === "empty"} onClick={() => setMode("empty")} icon={PencilLine} label="Manuel"
                title="Mission vide : vous ajoutez les tâches et les assignez vous-même depuis le kanban."
              />
            </div>

            <div className="flex-1" />
            <Button onClick={() => void submit()} disabled={!title.trim() || busy}>
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Créer
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {mode === "auto"
              ? "L'assistant planifie la mission et lance les tâches prêtes dès la création."
              : "La mission est créée vide — vous ajoutez les tâches depuis le kanban."}
          </p>
        </footer>
      </aside>
    </>
  );
}

function ModePill({ active, onClick, icon: Icon, label, title }: {
  active: boolean; onClick: () => void; icon: typeof Sparkles; label: string; title: string;
}) {
  return (
    <button
      type="button" onClick={onClick} title={title}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard-level Missions tab — every mission of the service, all rooms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The service's mission board. Rooms are where missions are BORN (someone asks
 * for something), but a mission outlives the conversation that started it and
 * usually matters to people who were not in that room — so its home is the
 * dashboard, with the originating room named on each card.
 */
export function DashboardMissionsTab({ dashboardId, dashboardName, workspaceId, projectId }: {
  dashboardId: string; dashboardName: string; workspaceId: string | null; projectId: string | null;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: missions, isLoading } = useQuery({
    queryKey: ["dashboard_missions", dashboardId],
    queryFn: () => fetchDashboardMissions(dashboardId),
    refetchInterval: (q) =>
      (q.state.data as RoomMission[] | undefined)?.some((m) => ["planning", "running"].includes(m.status)) ? 5000 : false,
  });
  const { data: agents } = useQuery({
    queryKey: ["sd_all_agents", dashboardId],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents")
        .select("id, name, avatar_url, accent_color").eq("service_dashboard_id", dashboardId).eq("is_archived", false);
      return (data ?? []) as Participant[];
    },
  });
  const roomIds = useMemo(() => [...new Set((missions ?? []).map((m) => m.room_id))], [missions]);
  const { data: rooms } = useQuery({
    queryKey: ["mission_rooms", roomIds.join(",")],
    enabled: roomIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("service_rooms").select("id, title").in("id", roomIds);
      return (data ?? []) as Array<{ id: string; title: string }>;
    },
  });
  const roomTitle = useMemo(() => new Map((rooms ?? []).map((r) => [r.id, r.title])), [rooms]);

  if (open) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <MissionDetail missionId={open} participants={agents ?? []} onBack={() => setOpen(null)} />
      </div>
    );
  }

  const groups: Array<{ label: string; items: RoomMission[] }> = [
    { label: "En cours", items: (missions ?? []).filter((m) => ["planning", "running"].includes(m.status)) },
    { label: "À reprendre", items: (missions ?? []).filter((m) => ["paused", "blocked", "failed"].includes(m.status)) },
    { label: "Terminées", items: (missions ?? []).filter((m) => ["done", "cancelled"].includes(m.status)) },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="mx-auto w-full max-w-[1100px] px-6 py-8">
      <header className="mb-6 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">Missions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Le travail collectif orchestré par l'assistant : jalons, tâches réparties entre agents, livrables.
          </p>
        </div>
        <Button onClick={() => setCreating(true)} className="shrink-0">
          <Plus className="mr-1.5 h-4 w-4" /> Nouvelle mission
        </Button>
      </header>

      <NewMissionPanel
        dashboardId={dashboardId} dashboardName={dashboardName}
        workspaceId={workspaceId} projectId={projectId}
        open={creating} onOpenChange={setCreating}
        onCreated={(id) => { qc.invalidateQueries({ queryKey: ["dashboard_missions", dashboardId] }); setOpen(id); }}
      />

      {isLoading && <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}

      {!isLoading && groups.length === 0 && (
        <div className="mx-auto max-w-md py-20 text-center">
          <Target className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium">Aucune mission</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Créez-en une ici, ou demandez à l'assistant dans une room un travail qui demande plusieurs compétences :
            il le découpe en jalons et tâches, les répartit entre les agents, et pilote l'exécution.
          </p>
          <Button className="mt-5" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Nouvelle mission
          </Button>
        </div>
      )}

      <div className="space-y-7">
        {groups.map((g) => (
          <section key={g.label}>
            <h2 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {g.label} · {g.items.length}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {g.items.map((m) => (
                <MissionCard key={m.id} mission={m} room={roomTitle.get(m.room_id)} onOpen={() => setOpen(m.id)} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function MissionCard({ mission, room, onOpen }: { mission: RoomMission; room?: string; onOpen: () => void }) {
  const { data: tasks } = useQuery({
    queryKey: ["mission_tasks", mission.id],
    queryFn: () => fetchMissionTasks(mission.id),
    refetchInterval: ["planning", "running"].includes(mission.status) ? 5000 : false,
  });
  const meta = MISSION_STATUS_META[mission.status];
  const agents = [...new Set((tasks ?? []).map((t) => t.agent_id).filter(Boolean))] as string[];
  const live = (tasks ?? []).filter((t) => t.status === "in_progress");

  return (
    <button
      type="button" onClick={onOpen}
      className="group flex flex-col rounded-xl border border-border/60 bg-card p-4 text-left transition-colors hover:border-primary/50"
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{mission.title}</span>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium", meta.tone)}>{meta.label}</span>
      </div>
      {room && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">#{room}</p>}
      {mission.objective && <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{mission.objective}</p>}

      <div className="mt-3">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-all", mission.status === "failed" || mission.status === "blocked" ? "bg-red-500" : "bg-primary")}
            style={{ width: `${mission.progress}%` }}
          />
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{(tasks ?? []).filter((t) => t.status === "done").length}/{(tasks ?? []).length} tâches</span>
          <span className="tabular-nums">{mission.progress}%</span>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <MiniAgents ids={agents} />
        {live.length > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-emerald-500">
            <Loader2 className="h-3 w-3 animate-spin" /> {live.length} en cours
          </span>
        )}
      </div>
    </button>
  );
}

function MiniAgents({ ids }: { ids: string[] }) {
  const { data: agents } = useQuery({
    queryKey: ["mini_agents", ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("id, name, avatar_url").in("id", ids);
      return (data ?? []) as Array<{ id: string; name: string; avatar_url: string | null }>;
    },
  });
  if (!ids.length) return <span className="text-[11px] text-muted-foreground">Non assignée</span>;
  return (
    <div className="flex -space-x-1.5">
      {(agents ?? []).slice(0, 5).map((a) => (
        <span key={a.id} title={a.name} className="rounded-full ring-2 ring-card">
          <AgentIdentity url={a.avatar_url} seed={a.name} size={20} rounded="rounded-full" />
        </span>
      ))}
      {ids.length > 5 && <span className="pl-2.5 text-[11px] text-muted-foreground">+{ids.length - 5}</span>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail — Planification / Exécution / Livrables / Kanban
// ─────────────────────────────────────────────────────────────────────────────

type DetailTab = "plan" | "run" | "deliverables" | "kanban";
const DETAIL_TABS: Array<{ key: DetailTab; label: string; icon: typeof GitBranch }> = [
  { key: "plan", label: "Planification", icon: GitBranch },
  { key: "run", label: "Exécution", icon: Activity },
  { key: "deliverables", label: "Livrables", icon: FileText },
  { key: "kanban", label: "Kanban", icon: LayoutGrid },
];

export function MissionDetail({
  missionId, participants, onBack, onOpenArtifact,
}: {
  missionId: string;
  participants: Participant[];
  onBack: () => void;
  onOpenArtifact?: (a: ArtifactOpenTarget) => void;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<DetailTab>("plan");

  const { data: mission } = useQuery({ queryKey: ["mission", missionId], queryFn: () => fetchMission(missionId) });
  const live = mission ? ["planning", "running"].includes(mission.status) : false;
  const { data: milestones } = useQuery({
    queryKey: ["mission_milestones", missionId], queryFn: () => fetchMissionMilestones(missionId),
    refetchInterval: live ? 5000 : false,
  });
  const { data: tasks } = useQuery({
    queryKey: ["mission_tasks", missionId], queryFn: () => fetchMissionTasks(missionId),
    refetchInterval: live ? 4000 : false,
  });

  // The mission's cast: agents actually assigned to it, resolved once here so
  // every tab names them the same way.
  const agentIds = useMemo(() => [...new Set((tasks ?? []).map((t) => t.agent_id).filter(Boolean))] as string[], [tasks]);
  const { data: castRows } = useQuery({
    queryKey: ["mission_cast", agentIds.join(",")],
    enabled: agentIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("id, name, avatar_url, accent_color").in("id", agentIds);
      return (data ?? []) as Participant[];
    },
  });
  const cast = castRows ?? [];
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of [...participants, ...cast]) m.set(a.id, a.name);
    return m;
  }, [participants, cast]);
  const avatarOf = useMemo(() => new Map([...participants, ...cast].map((a) => [a.id, a.avatar_url])), [participants, cast]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["mission", missionId] });
    qc.invalidateQueries({ queryKey: ["mission_tasks", missionId] });
    qc.invalidateQueries({ queryKey: ["mission_milestones", missionId] });
    qc.invalidateQueries({ queryKey: ["mission_events", missionId] });
  };

  if (!mission) {
    return <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  const meta = MISSION_STATUS_META[mission.status];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="rounded-md p-1 text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /></button>
          <Target className="h-4 w-4 text-primary" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{mission.title}</span>
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", meta.tone)}>{meta.label}</span>
          <MissionActions mission={mission} onDone={refresh} />
        </div>
        {mission.objective && <MissionObjective text={mission.objective} />}
        <StalledNotice mission={mission} tasks={tasks ?? []} onDone={refresh} />
        <div className="mt-2 flex items-center gap-3 pl-8">
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${mission.progress}%` }} />
          </div>
          <span className="text-[11px] tabular-nums text-muted-foreground">{mission.progress}%</span>
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Users className="h-3 w-3" /> {cast.length} agent(s)
          </span>
        </div>
      </header>

      <nav className="flex gap-1 border-b border-border/60 px-4">
        {DETAIL_TABS.map((t) => (
          <button
            key={t.key} type="button" onClick={() => setTab(t.key)}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors",
              tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <t.icon className="h-3.5 w-3.5" /> {t.label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "plan" && (
          <div className="space-y-4">
            {mission.plan_rationale && (
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
                <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Pourquoi ce découpage</h4>
                <p className="text-xs text-muted-foreground">{mission.plan_rationale}</p>
              </div>
            )}
            <MissionTimeline
              milestones={milestones ?? []} tasks={tasks ?? []}
              agentName={(id) => (id ? nameOf.get(id) : undefined)}
            />
          </div>
        )}

        {tab === "run" && <ExecutionTab missionId={missionId} tasks={tasks ?? []} nameOf={nameOf} avatarOf={avatarOf} live={live} />}

        {tab === "deliverables" && (
          <DeliverablesTab missionId={missionId} tasks={tasks ?? []} nameOf={nameOf} live={live} onOpenArtifact={onOpenArtifact} />
        )}

        {tab === "kanban" && (
          <KanbanTab
            tasks={tasks ?? []} missionId={missionId} nameOf={nameOf} avatarOf={avatarOf}
            milestones={milestones ?? []}
            participants={participants.length ? participants : cast} onChanged={refresh}
          />
        )}
      </div>
    </div>
  );
}

/** The objective is a full brief — often twenty lines. Shown as two lines with
 *  a toggle: the header is navigation chrome, not the place to read a spec, and
 *  a long one pushed the tabs and the whole board off the screen. */
function MissionObjective({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 180;
  return (
    <div className="mt-1.5 pl-8">
      <p className={cn("whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground", !open && "line-clamp-2")}>
        {text}
      </p>
      {long && (
        <button
          type="button" onClick={() => setOpen((v) => !v)}
          className="mt-0.5 text-[11px] font-medium text-primary hover:underline"
        >
          {open ? "Réduire" : "Voir le brief complet"}
        </button>
      )}
    </div>
  );
}

/** A mission is "à l'arrêt" when it claims to be running but its in-flight card
 *  hasn't moved for a long while — the shape a killed worker leaves behind. The
 *  server-side watchdog picks these up within two minutes; this is the human's
 *  own handle on it, and it says plainly that nothing is running rather than
 *  leaving the progress bar to imply otherwise. */
const STALL_AFTER_MS = 12 * 60 * 1000;

function StalledNotice({ mission, tasks, onDone }: {
  mission: RoomMission; tasks: RoomTask[]; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!["planning", "running"].includes(mission.status)) return null;

  const inflight = tasks.filter((t) => ["in_progress", "waiting", "review"].includes(t.status));
  const open = tasks.filter((t) => !["done", "skipped", "failed"].includes(t.status));
  if (open.length === 0) return null;
  // Nothing claimed at all, or everything claimed long ago and still silent.
  const freshest = inflight.reduce<number>((acc, t) => Math.max(acc, t.started_at ? +new Date(t.started_at) : 0), 0);
  const stalled = inflight.length === 0
    ? +new Date(mission.updated_at) < Date.now() - STALL_AFTER_MS
    : freshest < Date.now() - STALL_AFTER_MS;
  if (!stalled) return null;

  return (
    <div className="ml-8 mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      <span className="min-w-0 flex-1 text-[11px] text-amber-700 dark:text-amber-300">
        Mission à l'arrêt — plus aucun run actif{inflight.length > 0 ? ` sur « ${inflight[0].title} »` : ""}.
        Relancez : l'orchestrateur clôture les tâches mortes et replanifie.
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try { await advanceMission(mission.id); onDone(); } finally { setBusy(false); }
        }}
        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/20 px-2 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-500/30 disabled:opacity-60 dark:text-amber-200"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Relancer
      </button>
    </div>
  );
}

function MissionActions({ mission, onDone, onDeleted }: { mission: RoomMission; onDone: () => void; onDeleted?: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); onDone(); } finally { setBusy(false); }
  };
  const canPause = ["planning", "running"].includes(mission.status);
  const canResume = ["paused", "blocked"].includes(mission.status);
  return (
    <div className="flex items-center gap-1">
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      {canPause && (
        <IconAction title="Mettre en pause" onClick={() => run(() => setMissionStatus(mission.id, "paused"))}>
          <Pause className="h-3.5 w-3.5" />
        </IconAction>
      )}
      {canResume && (
        <IconAction title="Reprendre" onClick={() => run(async () => { await setMissionStatus(mission.id, "running"); await advanceMission(mission.id); })}>
          <Play className="h-3.5 w-3.5" />
        </IconAction>
      )}
      {["running", "planning", "blocked"].includes(mission.status) && (
        <IconAction title="Relancer les tâches prêtes" onClick={() => run(() => advanceMission(mission.id))}>
          <RefreshCw className="h-3.5 w-3.5" />
        </IconAction>
      )}
      {/* Deleting a mission takes its milestones, tasks and events with it
          (all FK on delete cascade) — hence the explicit confirmation. Its
          deliverables survive: they belong to the runs, not to the plan. */}
      <IconAction
        title="Supprimer la mission"
        danger
        onClick={() => {
          if (!confirm(`Supprimer la mission « ${mission.title} » ? Ses jalons, tâches et historique seront effacés. Les livrables déjà produits sont conservés.`)) return;
          void run(async () => { await deleteMission(mission.id); onDeleted?.(); });
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </IconAction>
    </div>
  );
}

function IconAction({ title, onClick, children, danger }: { title: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className={cn("rounded-md p-1.5 text-muted-foreground transition-colors",
        danger ? "hover:bg-destructive/10 hover:text-destructive" : "hover:bg-muted hover:text-foreground")}>
      {children}
    </button>
  );
}

// ── Exécution ────────────────────────────────────────────────────────────────

const EVENT_ICON: Record<string, typeof CheckCircle2> = {
  routed: GitBranch, planned: ListChecks, dispatched: Play, waiting: Loader2,
  completed: CheckCircle2, failed: XCircle, replanned: RefreshCw,
  memorised: FileText, agent_created: Users, finished: CheckCircle2, note: Activity,
};

function ExecutionTab({
  missionId, tasks, nameOf, avatarOf, live,
}: {
  missionId: string; tasks: RoomTask[];
  nameOf: Map<string, string>; avatarOf: Map<string, string | null>; live: boolean;
}) {
  const [openRun, setOpenRun] = useState<string | null>(null);
  const { data: events } = useQuery({
    queryKey: ["mission_events", missionId],
    queryFn: () => fetchMissionEvents(missionId),
    refetchInterval: live ? 4000 : false,
  });

  return (
    <div className="space-y-5">
      <section>
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Décisions de l'orchestrateur</h4>
        <ol className="space-y-1.5">
          {(events ?? []).map((e) => {
            const Icon = EVENT_ICON[e.kind] ?? Activity;
            return (
              <li key={e.id} className="flex gap-2.5 rounded-lg border border-border/50 bg-card px-3 py-2">
                <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", e.kind === "failed" ? "text-red-500" : e.kind === "completed" || e.kind === "finished" ? "text-emerald-500" : "text-muted-foreground")} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs">{e.message}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }).format(new Date(e.created_at))}
                    {e.agent_id && nameOf.get(e.agent_id) ? ` · ${nameOf.get(e.agent_id)}` : ""}
                  </p>
                </div>
              </li>
            );
          })}
          {(events ?? []).length === 0 && <p className="text-xs text-muted-foreground">Aucune décision enregistrée.</p>}
        </ol>
      </section>

      <section>
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Runs des agents</h4>
        <div className="space-y-2">
          {tasks.filter((t) => t.run_id).map((t) => (
            <div key={t.id} className="rounded-lg border border-border/60 bg-card">
              <button
                type="button" onClick={() => setOpenRun(openRun === t.id ? null : t.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                <AgentIdentity url={t.agent_id ? avatarOf.get(t.agent_id) ?? null : null} seed={t.agent_id ? nameOf.get(t.agent_id) : "?"} size={20} rounded="rounded-full" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{t.title}</span>
                <TaskStatusPill status={t.status} />
              </button>
              {openRun === t.id && t.run_id && (
                <div className="border-t border-border/60 px-3 py-2">
                  <RunTimeline runId={t.run_id} live={t.status === "in_progress"} defaultOpen />
                </div>
              )}
            </div>
          ))}
          {tasks.every((t) => !t.run_id) && <p className="text-xs text-muted-foreground">Aucun run lancé pour l'instant.</p>}
        </div>
      </section>
    </div>
  );
}

// ── Livrables ────────────────────────────────────────────────────────────────

function DeliverablesTab({
  missionId, tasks, nameOf, live, onOpenArtifact,
}: {
  missionId: string; tasks: RoomTask[]; nameOf: Map<string, string>; live: boolean;
  onOpenArtifact?: (a: ArtifactOpenTarget) => void;
}) {
  const taskRunIds = useMemo(() => tasks.map((t) => t.run_id).filter(Boolean) as string[], [tasks]);

  // The mission's runs are NOT only its tasks'. The closing report is written by
  // the orchestrator in a turn attached to the mission but to no task — so a tab
  // built from task run ids hid exactly the document the human came for, and
  // showed "aucun livrable" on a mission at 100%. Take the run ids from the
  // mission's room messages too.
  const { data: runIds } = useQuery({
    queryKey: ["mission_run_ids", missionId, taskRunIds.join(",")],
    refetchInterval: live ? 5000 : false,
    queryFn: async () => {
      const { data } = await supabase.from("service_room_messages")
        .select("run_id").eq("mission_id", missionId).not("run_id", "is", null);
      const fromMessages = (data ?? []).map((m) => (m as { run_id: string }).run_id);
      return [...new Set([...taskRunIds, ...fromMessages])];
    },
  });

  const { data: deliverables } = useQuery({
    queryKey: ["mission_deliverables", (runIds ?? []).join(",")],
    enabled: (runIds ?? []).length > 0,
    queryFn: () => fetchMissionDeliverables(runIds ?? []),
    refetchInterval: live ? 5000 : false,
  });
  const taskOfRun = useMemo(() => new Map(tasks.filter((t) => t.run_id).map((t) => [t.run_id!, t])), [tasks]);

  if (!deliverables?.length) {
    return <p className="py-16 text-center text-sm text-muted-foreground">Aucun livrable produit pour l'instant.</p>;
  }
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      {deliverables.map((d) => {
        const task = taskOfRun.get(d.run_id);
        return (
          <button
            key={d.id} type="button"
            onClick={() => onOpenArtifact?.({ id: d.id, table: "deliverable", kind: d.kind, title: d.name })}
            className="group overflow-hidden rounded-xl border border-border/60 bg-card text-left transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md"
          >
            {/* Coloured plate, like the thread's card — a report is the mission's
                headline output, not a list row. */}
            <div className={cn(
              "flex items-center gap-2 border-b border-border/50 px-3 py-2.5",
              d.kind === "report" ? "bg-indigo-500/10" : "bg-muted/40",
            )}>
              <span className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                d.kind === "report" ? "bg-indigo-500/15 text-indigo-500" : "bg-background text-muted-foreground",
              )}>
                <FileText className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{d.name}</span>
              <span className="shrink-0 rounded bg-background/70 px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">{d.kind}</span>
            </div>
            <div className="px-3 py-2.5">
              {d.summary && <p className="line-clamp-2 text-xs text-muted-foreground">{d.summary}</p>}
              <p className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="truncate">{task ? task.title : "Compte rendu de mission"}</span>
                <span>·</span>
                <span className="shrink-0">{d.agent_id ? nameOf.get(d.agent_id) ?? "Agent" : "Agent"}</span>
                <span className="ml-auto shrink-0 font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">Ouvrir →</span>
              </p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Kanban ───────────────────────────────────────────────────────────────────

function TaskStatusPill({ status }: { status: TaskStatus }) {
  const tone: Record<TaskStatus, string> = {
    todo: "bg-muted text-muted-foreground",
    in_progress: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    waiting: "bg-sky-500/10 text-sky-600/80 dark:text-sky-400/80",
    review: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    blocked: "bg-red-500/15 text-red-600 dark:text-red-400",
    done: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    failed: "bg-red-500/15 text-red-600 dark:text-red-400",
    skipped: "bg-muted text-muted-foreground",
  };
  const label: Record<TaskStatus, string> = {
    todo: "à faire", in_progress: "en cours", waiting: "en attente", review: "revue",
    blocked: "bloqué", done: "terminé", failed: "échec", skipped: "ignoré",
  };
  return <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium", tone[status])}>{label[status]}</span>;
}

/**
 * The board is a real control surface, not a mirror: the orchestrator moves
 * cards as agents finish, and a human dropping a card back into "À faire" makes
 * it eligible for dispatch again on the next frontier pass. That is why every
 * drop calls `advanceMission` — a move nobody acts on would be a lie.
 */
function KanbanTab({
  tasks, missionId, nameOf, avatarOf, milestones, participants, onChanged,
}: {
  tasks: RoomTask[]; missionId: string;
  nameOf: Map<string, string>; avatarOf: Map<string, string | null>;
  milestones: RoomMilestone[];
  participants: Participant[]; onChanged: () => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const drop = async (colKey: string) => {
    const id = dragId;
    setDragId(null); setOverCol(null);
    if (!id) return;
    const col = KANBAN_COLUMNS.find((c) => c.key === colKey);
    const task = tasks.find((t) => t.id === id);
    if (!col || !task || col.statuses.includes(task.status)) return;
    setBusy(true);
    try {
      await setTaskStatus(id, col.statuses[0]);
      // Moving a card back into the ready pool is an instruction: ask the
      // orchestrator to re-evaluate what can start now.
      if (col.key === "todo") await advanceMission(missionId);
      onChanged();
    } finally { setBusy(false); }
  };

  return (
    // Columns are open lanes, not boxed panels: the drop target is the lane
    // itself, highlighted only while a card hovers it.
    <div className="flex items-start gap-5 overflow-x-auto pb-2">
      {KANBAN_COLUMNS.map((col) => {
        const items = tasks.filter((t) => col.statuses.includes(t.status));
        return (
          <div
            key={col.key}
            onDragOver={(e) => { e.preventDefault(); setOverCol(col.key); }}
            onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
            onDrop={() => void drop(col.key)}
            className="flex w-full min-w-[280px] max-w-[320px] flex-col"
          >
            <div className="mb-3 flex items-center justify-between px-1">
              <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
                {col.label}
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                  {items.length}
                </span>
              </h3>
              {busy && overCol === col.key && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </div>
            <div className={cn(
              "flex flex-col gap-3 rounded-2xl transition-colors",
              overCol === col.key && "bg-primary/5 ring-2 ring-primary/30",
            )}>
              {items.map((t) => (
                <KanbanCard
                  key={t.id} task={t}
                  agentName={t.agent_id ? nameOf.get(t.agent_id) : undefined}
                  agentAvatar={t.agent_id ? avatarOf.get(t.agent_id) ?? null : null}
                  participants={participants}
                  dragging={dragId === t.id}
                  onDragStart={() => setDragId(t.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null); }}
                  onAssign={async (agentId) => { await assignTaskAgent(t.id, agentId); onChanged(); }}
                  onDelete={async () => { await deleteMissionTask(t.id); onChanged(); }}
                  blockedBy={t.depends_on
                    .map((d) => tasks.find((x) => x.id === d))
                    .filter((d): d is RoomTask => Boolean(d) && d!.status !== "done" && d!.status !== "skipped")}
                />
              ))}
              {items.length === 0 && !(col.key === "todo" && adding) && (
                <div className="flex h-24 items-center justify-center rounded-2xl border-2 border-dashed border-border/60 text-sm text-muted-foreground/70">
                  Déposez une carte ici
                </div>
              )}

              {/* Authoring lives in "À faire" only: a card created straight into
                  "En cours" would claim work no agent was ever handed. */}
              {col.key === "todo" && (
                adding ? (
                  <NewTaskForm
                    participants={participants}
                    onCancel={() => setAdding(false)}
                    onSubmit={async (input) => {
                      await createMissionTask(missionId, {
                        ...input,
                        milestoneId: milestones[0]?.id ?? null,
                        position: tasks.length,
                      });
                      setAdding(false);
                      onChanged();
                    }}
                  />
                ) : (
                  <button
                    type="button" onClick={() => setAdding(true)}
                    className="mt-1 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border/60 py-3 text-sm font-semibold text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                  >
                    <Plus className="h-4 w-4" /> Ajouter une tâche
                  </button>
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Inline card authoring. The brief is what the agent actually receives, so it
 *  is a full textarea, not a one-line title — a card that says only "SEO" gets
 *  an agent that guesses. */
/**
 * Assignee picker.
 *
 * A native <select> hands the list to the OS: no avatars, no theming, and with
 * fifteen agents whose names repeat ("Vibe Coder", "Vibe Coder 2") the reader
 * cannot tell them apart. The app's own menu shows each agent's face next to
 * its name, which is how they are recognised everywhere else.
 */
function AgentPicker({ participants, value, onChange, placeholder = "Assigner…" }: {
  participants: Participant[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const current = participants.find((p) => p.id === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="flex min-w-0 max-w-[170px] items-center gap-1.5 rounded-lg border border-border/60 bg-background px-2 py-1 text-xs text-foreground transition-colors hover:border-border"
        >
          {current
            ? <AgentIdentity url={current.avatar_url} seed={current.name} size={18} rounded="rounded-full" className="shrink-0" />
            : <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <span className={cn("min-w-0 flex-1 truncate text-left", !current && "text-muted-foreground")}>
            {current?.name ?? placeholder}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto rounded-xl" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">Assigner à</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange("")} className="gap-2 text-muted-foreground">
          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-border">
            <Users className="h-3 w-3" />
          </span>
          Non assignée
          {!current && <Check className="ml-auto h-3.5 w-3.5" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {participants.map((p) => (
          <DropdownMenuItem key={p.id} onSelect={() => onChange(p.id)} className="gap-2">
            <AgentIdentity url={p.avatar_url} seed={p.name} size={24} rounded="rounded-full" className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {p.id === value && <Check className="h-3.5 w-3.5 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The inline "new task" composer.
 *
 * Built to look like the card it will become — same 2xl radius, same padding,
 * same footer rule — so adding a task reads as writing a card rather than
 * filling a form. The title is the only required field and it is styled as the
 * card's own heading; everything else is optional and visually secondary.
 */
function NewTaskForm({
  participants, onSubmit, onCancel,
}: {
  participants: Participant[];
  onSubmit: (input: { title: string; description: string; agentId: string | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState<string>(participants[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const assignee = participants.find((p) => p.id === agentId);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try { await onSubmit({ title: title.trim(), description: description.trim(), agentId: agentId || null }); }
    finally { setBusy(false); }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border-2 border-primary/50 bg-card shadow-md ring-4 ring-primary/5"
      // Enter submits from anywhere in the composer, Esc cancels — a card is a
      // one-line thought most of the time and should not need the mouse.
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (e.target as HTMLElement).tagName !== "TEXTAREA")) {
          e.preventDefault(); void submit();
        }
      }}
    >
      <div className="flex flex-col gap-3 p-4">
        <input
          value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
          placeholder="Que faut-il faire ?"
          className="w-full bg-transparent text-[15px] font-bold leading-snug text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground/60"
        />
        <textarea
          value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
          placeholder="Consigne donnée à l'agent : quoi produire, avec quoi, comment vérifier."
          className="w-full resize-none bg-transparent text-sm leading-relaxed text-muted-foreground outline-none placeholder:text-muted-foreground/50"
        />

        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
          {/* Assignee picker wearing the avatar it will put on the card. */}
          <AgentPicker participants={participants} value={agentId} onChange={setAgentId} placeholder="Non assignée" />

          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button" onClick={onCancel}
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Annuler
            </button>
            <button
              type="button" disabled={!title.trim() || busy} onClick={() => void submit()}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Ajouter
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * One task card of the board.
 *
 * Laid out like the reference: a chip row on top, the title and description in
 * the body, and a footer separated by a rule carrying the meta on the left and
 * the people on the right.
 *
 * The reference's `tags`/`priority` do not exist on a room task, and inventing
 * them would be decoration. What IS real is derived instead: the chip row shows
 * the task's own state, and "priority" is what the board actually cares about —
 * whether the card is blocked. The overlapping avatars are the assignee plus the
 * agents this card is waiting on, which is the honest answer to "who is on it".
 */
function KanbanCard({
  task, agentName, agentAvatar, participants, dragging, onDragStart, onDragEnd, onAssign, onDelete, blockedBy,
}: {
  task: RoomTask;
  agentName?: string; agentAvatar: string | null;
  participants: Participant[];
  dragging: boolean;
  onDragStart: () => void; onDragEnd: () => void;
  onAssign: (agentId: string) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  blockedBy: RoomTask[];
}) {
  const [expanded, setExpanded] = useState(false);
  const done = task.status === "done" || task.status === "skipped";
  const deps = task.depends_on?.length ?? 0;
  const when = task.finished_at ?? task.started_at;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "group relative flex w-full cursor-grab flex-col overflow-visible rounded-2xl border border-border/70 bg-card shadow-sm transition-all duration-200 hover:shadow-md active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      <div className="flex flex-col gap-4 p-4">
        {/* Header: state chips + delete */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <TaskStatusPill status={task.status} />
            {blockedBy.length > 0 && (
              <span className="rounded-md bg-amber-500/10 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                Bloqué
              </span>
            )}
          </div>
          {/* Removing a card that never ran is housekeeping; removing one an
              agent already executed would erase the trace, so it is not offered. */}
          {task.status === "todo" && (
            <button
              type="button" title="Supprimer la tâche" onClick={() => void onDelete()}
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Body */}
        <button type="button" onClick={() => setExpanded((v) => !v)} className="flex flex-col gap-1.5 text-left">
          <h4 className="text-[15px] font-bold leading-snug text-foreground">{task.title}</h4>
          {task.description && !expanded && (
            <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">{task.description}</p>
          )}
        </button>

        {expanded && (
          <div className="space-y-1.5 rounded-xl bg-muted/40 p-3">
            {task.description && <p className="whitespace-pre-wrap text-xs text-muted-foreground">{task.description}</p>}
            {task.result_summary && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Résultat</p>
                <p className="whitespace-pre-wrap text-xs text-muted-foreground">{task.result_summary}</p>
              </div>
            )}
            {blockedBy.length > 0 && (
              <p className="flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                attend : {blockedBy.map((b) => b.title).join(", ")}
              </p>
            )}
          </div>
        )}

        {/* Footer: meta on the left, people on the right */}
        <div className="mt-1 flex items-center justify-between border-t border-border/60 pt-3">
          <div className="flex items-center gap-3.5 text-xs font-medium text-muted-foreground">
            {when && (
              <span className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground/70" />
                {new Date(when).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}
              </span>
            )}
            {deps > 0 && (
              <span className="flex items-center gap-1.5" title="Dépendances résolues">
                <CheckCircle2 className={cn("h-3.5 w-3.5", blockedBy.length === 0 ? "text-emerald-500" : "text-muted-foreground/70")} />
                {deps - blockedBy.length}/{deps}
              </span>
            )}
            {task.result_summary && (
              <span className="flex items-center gap-1.5" title="Résultat disponible">
                <FileText className="h-3.5 w-3.5 text-muted-foreground/70" />
                1
              </span>
            )}
          </div>

          {/* Assignee, then the agents this card waits on — overlapping. */}
          {task.agent_id ? (
            <div className="ml-4 flex shrink-0 items-center -space-x-2">
              <AgentIdentity url={agentAvatar} seed={agentName ?? "?"} size={28} rounded="rounded-full"
                className="ring-2 ring-card" />
              {blockedBy.slice(0, 2).map((b) => (
                <span key={b.id} className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-2 ring-card"
                  title={`en attente de « ${b.title} »`}>
                  {b.title.slice(0, 1).toUpperCase()}
                </span>
              ))}
            </div>
          ) : (
            <div className="ml-4 shrink-0" onClick={(e) => e.stopPropagation()}>
              <AgentPicker participants={participants} value="" onChange={(id) => id && void onAssign(id)} />
            </div>
          )}
        </div>
      </div>

      {/* Drag affordance, like the reference's grip */}
      <span aria-hidden className="pointer-events-none absolute -left-3 top-1/2 -translate-y-1/2 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100">
        <GripVertical className="h-4 w-4" />
      </span>
      {done && <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-t-2xl bg-emerald-500/60" />}
    </div>
  );
}
