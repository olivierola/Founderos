import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Target, Loader2, Play, Pause, CheckCircle2, XCircle, AlertTriangle,
  FileText, GitBranch, LayoutGrid, ListChecks, Activity, RefreshCw, Users, Plus, Trash2,
  X, Hash, ChevronDown, Check, Sparkles, PencilLine,
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
  advanceMission, assignTaskAgent, createMissionFromForm, createMissionTask, deleteMissionTask,
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
        {mission.objective && <p className="mt-1.5 pl-8 text-xs text-muted-foreground">{mission.objective}</p>}
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
          <DeliverablesTab tasks={tasks ?? []} nameOf={nameOf} live={live} onOpenArtifact={onOpenArtifact} />
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

function MissionActions({ mission, onDone }: { mission: RoomMission; onDone: () => void }) {
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
    </div>
  );
}

function IconAction({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
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
  tasks, nameOf, live, onOpenArtifact,
}: {
  tasks: RoomTask[]; nameOf: Map<string, string>; live: boolean;
  onOpenArtifact?: (a: ArtifactOpenTarget) => void;
}) {
  const runIds = useMemo(() => tasks.map((t) => t.run_id).filter(Boolean) as string[], [tasks]);
  const { data: deliverables } = useQuery({
    queryKey: ["mission_deliverables", runIds.join(",")],
    enabled: runIds.length > 0,
    queryFn: () => fetchMissionDeliverables(runIds),
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
            className="rounded-xl border border-border/60 bg-card p-3 text-left transition-colors hover:border-primary/50"
          >
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{d.kind}</span>
            </div>
            {d.summary && <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{d.summary}</p>}
            <p className="mt-2 text-[10px] text-muted-foreground">
              {task ? `${task.title} · ` : ""}{d.agent_id ? nameOf.get(d.agent_id) ?? "Agent" : "Agent"}
            </p>
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
    <div className="grid gap-3 md:grid-cols-4">
      {KANBAN_COLUMNS.map((col) => {
        const items = tasks.filter((t) => col.statuses.includes(t.status));
        return (
          <div
            key={col.key}
            onDragOver={(e) => { e.preventDefault(); setOverCol(col.key); }}
            onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
            onDrop={() => void drop(col.key)}
            className={cn(
              "flex min-h-[160px] flex-col rounded-xl border bg-muted/20 p-2 transition-colors",
              overCol === col.key ? "border-primary/60 bg-primary/5" : "border-border/60",
            )}
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{col.label}</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">{items.length}</span>
            </div>
            <div className="space-y-2">
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
                <p className="px-1 py-4 text-center text-[11px] text-muted-foreground/70">—</p>
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
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/70 py-2 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" /> Ajouter une tâche
                  </button>
                )
              )}
            </div>
            {busy && overCol === col.key && <Loader2 className="mx-auto mt-2 h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
        );
      })}
    </div>
  );
}

/** Inline card authoring. The brief is what the agent actually receives, so it
 *  is a full textarea, not a one-line title — a card that says only "SEO" gets
 *  an agent that guesses. */
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

  return (
    <div className="space-y-2 rounded-lg border border-primary/40 bg-card p-2.5">
      <Input
        value={title} onChange={(e) => setTitle(e.target.value)} autoFocus
        placeholder="Titre de la tâche" className="h-8 text-xs"
      />
      <textarea
        value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
        placeholder="Consigne complète donnée à l'agent : quoi produire, avec quoi, comment vérifier."
        className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-[11px] outline-none focus:border-primary/60"
      />
      <select
        value={agentId} onChange={(e) => setAgentId(e.target.value)}
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-[11px] outline-none focus:border-primary/60"
      >
        <option value="">Non assignée</option>
        {participants.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">Annuler</button>
        <button
          type="button" disabled={!title.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try { await onSubmit({ title: title.trim(), description: description.trim(), agentId: agentId || null }); }
            finally { setBusy(false); }
          }}
          className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />} Ajouter
        </button>
      </div>
    </div>
  );
}

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
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        "group cursor-grab rounded-lg border border-border/60 bg-card p-2.5 active:cursor-grabbing",
        dragging && "opacity-50",
      )}
    >
      <div className="flex items-start gap-1.5">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="min-w-0 flex-1 text-left">
          <p className="text-xs font-medium leading-snug">{task.title}</p>
        </button>
        {/* Removing a card that never ran is housekeeping; removing one an
            agent already executed would erase the trace, so it is not offered. */}
        {task.status === "todo" && (
          <button
            type="button" title="Supprimer la tâche" onClick={() => void onDelete()}
            className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        {task.agent_id ? (
          <>
            <AgentIdentity url={agentAvatar} seed={agentName ?? "?"} size={18} rounded="rounded-full" />
            <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{agentName ?? "Agent"}</span>
          </>
        ) : (
          <select
            className="min-w-0 flex-1 rounded border border-border/60 bg-background px-1 py-0.5 text-[10px] text-muted-foreground"
            defaultValue=""
            onChange={(e) => e.target.value && void onAssign(e.target.value)}
          >
            <option value="" disabled>Assigner…</option>
            {participants.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <TaskStatusPill status={task.status} />
      </div>

      {blockedBy.length > 0 && (
        <p className="mt-1.5 flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          attend : {blockedBy.map((b) => b.title).join(", ")}
        </p>
      )}

      {expanded && (
        <div className="mt-2 space-y-1.5 border-t border-border/50 pt-2">
          {task.description && <p className="whitespace-pre-wrap text-[11px] text-muted-foreground">{task.description}</p>}
          {task.result_summary && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Résultat</p>
              <p className="whitespace-pre-wrap text-[11px] text-muted-foreground">{task.result_summary}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
