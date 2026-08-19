import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft, Users, Loader2, Activity, X, Target, MessageSquare, FileText,
} from "lucide-react";
import { CodeArtifactContext } from "@/components/AgentMarkdown";
import { ChatInput } from "@/components/ui/chat-input";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { AgentIdentity } from "@/components/AgentIdentity";
import { UiBlocks, InterleavedMessage, type UiBlock, type ArtifactOpenTarget } from "@/features/internal-agents/UiBlocks";
import { SubAgentInstances } from "@/features/internal-agents/SubAgentInstances";
import { RunTimeline } from "@/features/internal-agents/RunTimeline";
import { cn } from "@/lib/utils";
import {
  fetchRoomMessages, fetchRoomParticipants, addRoomAgent, removeRoomAgent,
  fetchRoomMissions, MISSION_STATUS_META,
  type RoomMessage, type RoomMission,
} from "./model";
import { SLASH_COMMANDS, sendToRoom } from "./roomCompose";
import { RoomPanel } from "./RoomPanel";
import { MissionsBoard, MissionDetail } from "./RoomMissions";

type RoomParticipant = { id: string; name: string; avatar_url: string | null; is_orchestrator: boolean; accent_color: string | null };

// Split a message into plain-text/@mention segments so a tagged agent's name
// renders in that agent's own accent color (falls back to plain text when the
// name can't be matched to a known participant).
function renderWithMentions(text: string, colorOf: Map<string, string | null>) {
  const names = [...colorOf.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!names.length) return text;
  const re = new RegExp(`@(${names.join("|")})\\b`, "g");
  const out: Array<string | ReactNode> = [];
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const color = colorOf.get(m[1]) ?? undefined;
    out.push(<span key={i++} style={color ? { color } : undefined} className="font-medium">@{m[1]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// --- Slack-style thread helpers: timestamps, day separators, author grouping ---
const dayKey = (iso: string) => new Date(iso).toDateString();
function formatTime(iso: string) {
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
function formatDaySeparator(iso: string) {
  const d = new Date(iso); const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === yest.toDateString()) return "Hier";
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(d);
}
function sameAuthor(a: RoomMessage, b: RoomMessage) {
  if (a.author_kind !== b.author_kind) return false;
  if (a.author_kind === "agent") return a.agent_id === b.agent_id;
  return a.user_id === b.user_id;
}
// Consecutive messages from the same author within 5 min collapse under one header.
function isGrouped(prev: RoomMessage | undefined, m: RoomMessage) {
  if (!prev || prev.author_kind === "system" || m.author_kind === "system") return false;
  if (dayKey(prev.created_at) !== dayKey(m.created_at)) return false;
  if (!sameAuthor(prev, m)) return false;
  return new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60 * 1000;
}

function DaySeparator({ iso }: { iso: string }) {
  return (
    <div className="my-5 flex items-center gap-3">
      <div className="h-px flex-1 bg-border/70" />
      <span className="rounded-full border border-border bg-card px-3 py-0.5 text-xs font-medium text-muted-foreground shadow-sm">
        {formatDaySeparator(iso)}
      </span>
      <div className="h-px flex-1 bg-border/70" />
    </div>
  );
}

function UserAvatar({ name, url }: { name: string; url?: string }) {
  if (url) return <img src={url} alt={name} className="h-9 w-9 rounded-lg object-cover" />;
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-sm font-semibold text-primary">
      {initial}
    </div>
  );
}

export function RoomView({ dashboardId, roomId, workspaceId }: {
  dashboardId: string; roomId: string; workspaceId: string;
}) {
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const me = {
    name: (user?.user_metadata?.full_name as string) || (user?.user_metadata?.name as string) || user?.email?.split("@")[0] || "Vous",
    avatar: user?.user_metadata?.avatar_url as string | undefined,
  };
  const queryClient = useQueryClient();
  const base = `/app/${workspaceSlug}/${projectSlug}/service/${dashboardId}`;
  const scroller = useRef<HTMLDivElement>(null);

  const [sending, setSending] = useState(false);
  // Two views on the same room: the thread, and the missions the assistant is
  // orchestrating in it. `openMission` drills into one.
  const [view, setView] = useState<"thread" | "missions">("thread");
  const [openMission, setOpenMission] = useState<string | null>(null);
  // The right zone (artifacts/graph panel) starts closed — opened on demand.
  const [panelOpen, setPanelOpen] = useState(false);
  const [openArtifact, setOpenArtifact] = useState<ArtifactOpenTarget | null>(null);
  // Click a working agent → floating drawer with its live run (steps + sub-agents
  // + deliverables).
  const [openRun, setOpenRun] = useState<{ runId: string; name?: string; live: boolean } | null>(null);

  const { data: room } = useQuery({
    queryKey: ["service_room", roomId],
    queryFn: async () => {
      const { data } = await supabase.from("service_rooms").select("id, title, project_id").eq("id", roomId).maybeSingle();
      return (data ?? null) as { id: string; title: string; project_id: string } | null;
    },
  });
  const { data: messages } = useQuery({
    queryKey: ["service_room_messages", roomId],
    queryFn: () => fetchRoomMessages(roomId),
    refetchInterval: (q) => ((q.state.data as RoomMessage[] | undefined)?.some((m) => m.status === "thinking") ? 1800 : false),
  });
  const { data: participantIds } = useQuery({ queryKey: ["service_room_parts", roomId], queryFn: () => fetchRoomParticipants(roomId) });
  const { data: missions } = useQuery({
    queryKey: ["room_missions", roomId],
    queryFn: () => fetchRoomMissions(roomId),
    refetchInterval: (q) =>
      (q.state.data as RoomMission[] | undefined)?.some((m) => ["planning", "running"].includes(m.status)) ? 5000 : false,
  });
  const missionById = useMemo(() => new Map((missions ?? []).map((m) => [m.id, m])), [missions]);
  const liveMissions = (missions ?? []).filter((m) => ["planning", "running"].includes(m.status)).length;
  const { data: dashAgents } = useQuery({
    queryKey: ["sd_all_agents", dashboardId],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents")
        .select("id, name, avatar_url, is_orchestrator, accent_color").eq("service_dashboard_id", dashboardId).eq("is_archived", false);
      return (data ?? []) as RoomParticipant[];
    },
  });
  const nameOf = useMemo(() => new Map((dashAgents ?? []).map((a) => [a.id, a.name])), [dashAgents]);
  const colorOf = useMemo(() => new Map((dashAgents ?? []).map((a) => [a.name, a.accent_color])), [dashAgents]);
  const avatarById = useMemo(() => new Map((dashAgents ?? []).map((a) => [a.id, a.avatar_url])), [dashAgents]);
  const participants = (dashAgents ?? []).filter((a) => (participantIds ?? []).includes(a.id));
  const addable = (dashAgents ?? []).filter((a) => !(participantIds ?? []).includes(a.id));

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }, [messages?.length]);

  // Submit from the composer — shared with the Home tab's "start a conversation"
  // input (roomCompose.ts): / expansion, attachments, then the post itself.
  async function sendFrom(raw: string, mentionedIds: string[], files: File[]) {
    if ((!raw.trim() && files.length === 0) || sending || !user || !room) return;
    setSending(true);
    try {
      await sendToRoom(
        { roomId, workspaceId, projectId: room.project_id, userId: user.id },
        raw, mentionedIds, files,
      );
      queryClient.invalidateQueries({ queryKey: ["service_room_messages", roomId] });
    } finally { setSending(false); }
  }

  // Large code blocks in the thread open as a code artifact in the right zone.
  const openCode = (code: string, lang?: string, title?: string) => {
    setOpenArtifact({ table: "code", kind: "code", content: code, language: lang, title: title || "Code" });
    setPanelOpen(true);
  };

  async function invalidateParts() { queryClient.invalidateQueries({ queryKey: ["service_room_parts", roomId] }); }

  return (
    <div className="relative flex h-full min-h-0 bg-background">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex h-14 items-center gap-2 border-b border-border/60 bg-background/70 px-4 backdrop-blur">
          <button onClick={() => navigate(`${base}/home`)} className="rounded-md p-1 text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /></button>
          <span className="text-muted-foreground">#</span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{room?.title ?? "Room"}</span>
          <div className="flex items-center rounded-full bg-muted/60 p-1">
            <ViewTab active={view === "thread"} onClick={() => { setView("thread"); setOpenMission(null); }} icon={MessageSquare} label="Fil" />
            <ViewTab active={view === "missions"} onClick={() => setView("missions")} icon={Target} label="Missions" badge={liveMissions || undefined} />
          </div>
          <button onClick={() => setPanelOpen((v) => !v)} className={cn("flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors", panelOpen ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60")}>
            <Users className="h-4 w-4" /> {participants.length + 1}
          </button>
        </header>

        {view === "missions" ? (
          openMission ? (
            <MissionDetail
              missionId={openMission}
              participants={participants.map((a) => ({ id: a.id, name: a.name, avatar_url: a.avatar_url, accent_color: a.accent_color }))}
              onBack={() => setOpenMission(null)}
              onOpenArtifact={(a) => { setOpenArtifact(a); setPanelOpen(true); }}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <MissionsBoard roomId={roomId} dashboardId={dashboardId} onOpen={(id) => setOpenMission(id)} />
            </div>
          )
        ) : (
        <>
        {/* Thread */}
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <CodeArtifactContext.Provider value={openCode}>
          <div className="mx-auto max-w-3xl px-6 py-6">
            {(messages ?? []).map((m, i) => {
              const prev = i > 0 ? messages![i - 1] : undefined;
              const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
              const grouped = !newDay && isGrouped(prev, m);
              // The badge appears when the mission CHANGES, not on every line:
              // repeating it under each message of the same mission is noise.
              const showMission = Boolean(m.mission_id) && (!prev || prev.mission_id !== m.mission_id);
              return (
                <Fragment key={m.id}>
                  {newDay && <DaySeparator iso={m.created_at} />}
                  <RoomMessageRow
                    m={m} grouped={grouped && !showMission} me={me}
                    name={m.agent_id ? nameOf.get(m.agent_id) : undefined}
                    avatarUrl={m.agent_id ? avatarById.get(m.agent_id) ?? null : null}
                    colorOf={colorOf}
                    mission={m.mission_id ? missionById.get(m.mission_id) ?? null : null}
                    showMissionBadge={showMission}
                    onOpenMission={(id) => { setView("missions"); setOpenMission(id); }}
                    onOpenArtifact={(a) => { setOpenArtifact(a); setPanelOpen(true); }}
                    onOpenRun={(runId, name, live) => setOpenRun({ runId, name, live })}
                  />
                </Fragment>
              );
            })}
            {(messages ?? []).length === 0 && <p className="pt-16 text-center text-sm text-muted-foreground">Écrivez pour lancer la room. Taguez un agent avec @ ou demandez-lui de créer un document, une image…</p>}
          </div>
          </CodeArtifactContext.Provider>
        </div>

        {/* Composer — the shared ChatInput (files/paste/drag + voice dictation). */}
        <div className="px-6 pb-6">
          <div className="mx-auto max-w-3xl">
            <ChatInput
              busy={sending}
              placeholder="Écrivez un message… @ pour taguer, glissez des fichiers, ou dictez"
              mentionAgents={participants.map((a) => ({ id: a.id, name: a.name, accentColor: a.accent_color }))}
              slashCommands={SLASH_COMMANDS.map((c) => ({ key: c.key, label: c.label, color: c.color, icon: c.icon }))}
              onSendMessage={(msg, files, mentionedIds) => { void sendFrom(msg, mentionedIds, files); }}
            />
          </div>
        </div>
        </>
        )}
      </div>

      {/* General / Task / Artifacts panel */}
      {panelOpen && (
        <RoomPanel
          roomId={roomId}
          workspaceId={workspaceId}
          projectId={room?.project_id ?? null}
          participants={participants}
          addable={addable}
          openArtifact={openArtifact}
          onOpenArtifactHandled={() => setOpenArtifact(null)}
          onAdd={async (agentId) => { await addRoomAgent(roomId, agentId); invalidateParts(); }}
          onRemove={async (agentId) => { await removeRoomAgent(roomId, agentId); invalidateParts(); }}
          onClose={() => setPanelOpen(false)}
        />
      )}

      {/* Floating drawer: a working agent's live run (steps + sub-agents + livrables). */}
      {openRun && (
        <RoomRunDrawer
          run={openRun}
          onClose={() => setOpenRun(null)}
          onOpenDeliverable={(t) => { setOpenArtifact(t); setPanelOpen(true); setOpenRun(null); }}
        />
      )}
    </div>
  );
}

// Floating right-side drawer showing ONE agent turn's live activity: its step
// timeline, any parallel sub-agents, and the deliverables it produced. Opened by
// clicking a working agent in the thread.
function RoomRunDrawer({ run, onClose, onOpenDeliverable }: { run: { runId: string; name?: string; live: boolean }; onClose: () => void; onOpenDeliverable: (t: ArtifactOpenTarget) => void }) {
  const { data: deliverables } = useQuery({
    queryKey: ["room_run_deliverables", run.runId],
    refetchInterval: run.live ? 3000 : false,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_deliverables")
        .select("id, name, kind, summary, created_at")
        .eq("run_id", run.runId).order("created_at", { ascending: false });
      return (data ?? []) as Array<{ id: string; name: string; kind: string; summary: string | null; created_at: string }>;
    },
  });
  return (
    <>
      <div className="absolute inset-0 z-40" onClick={onClose} />
      <aside className="absolute right-4 top-4 bottom-4 z-50 flex w-[420px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-border/60 bg-background shadow-2xl ring-1 ring-black/5 animate-in slide-in-from-right-4 fade-in duration-200">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          <Activity className="h-4 w-4 text-primary" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{run.name ?? "Agent"} — activité</span>
          {run.live && <span className="flex items-center gap-1 text-[11px] text-emerald-500"><Loader2 className="h-3 w-3 animate-spin" /> en cours</span>}
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {(deliverables ?? []).length > 0 && (
            <section>
              <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Livrables</h4>
              <div className="space-y-1.5">
                {(deliverables ?? []).map((d) => (
                  <button key={d.id} type="button"
                    onClick={() => onOpenDeliverable({ id: d.id, table: "deliverable", kind: d.kind, title: d.name })}
                    className="block w-full rounded-lg border border-border/60 bg-muted/30 p-2.5 text-left hover:border-primary/50">
                    <div className="flex items-center gap-2">
                      <FileText className="h-3.5 w-3.5 text-primary" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.name}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{d.kind}</span>
                    </div>
                    {d.summary && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{d.summary}</p>}
                  </button>
                ))}
              </div>
            </section>
          )}
          <section>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Sous-agents</h4>
            <SubAgentInstances parentRunId={run.runId} />
          </section>
          <section>
            <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Étapes</h4>
            <RunTimeline runId={run.runId} live={run.live} defaultOpen />
          </section>
        </div>
      </aside>
    </>
  );
}

// Flat, bubble-less Slack-style row: avatar + name + timestamp, then content.
// Consecutive same-author messages group under one header (avatar gutter shows
// the time on hover).
function ViewTab({ active, onClick, icon: Icon, label, badge }: {
  active: boolean; onClick: () => void; icon: typeof Target; label: string; badge?: number;
}) {
  return (
    <button
      type="button" onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
      {badge != null && (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500/20 px-1 text-[10px] text-emerald-600 dark:text-emerald-400">{badge}</span>
      )}
    </button>
  );
}

/** Which mission a turn belongs to, shown once per run of consecutive messages
 *  — the thread stays readable when several missions are live at the same time. */
function MissionBadge({ mission, onOpen }: { mission: RoomMission; onOpen: () => void }) {
  const meta = MISSION_STATUS_META[mission.status];
  return (
    <button
      type="button" onClick={onOpen}
      className="mb-1.5 inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-2 py-0.5 text-[10px] font-medium transition-colors hover:border-primary/50"
      title={mission.objective ?? undefined}
    >
      <Target className="h-3 w-3 text-primary" />
      <span className="max-w-[220px] truncate">{mission.title}</span>
      <span className={cn("rounded-full px-1.5", meta.tone)}>{meta.label}</span>
    </button>
  );
}

function RoomMessageRow({ m, grouped, me, name, avatarUrl, colorOf, mission, showMissionBadge, onOpenMission, onOpenArtifact, onOpenRun }: {
  m: RoomMessage; grouped: boolean; me: { name: string; avatar?: string };
  name?: string; avatarUrl?: string | null; colorOf: Map<string, string | null>;
  mission?: RoomMission | null;
  showMissionBadge?: boolean;
  onOpenMission: (id: string) => void;
  onOpenArtifact: (a: ArtifactOpenTarget) => void;
  onOpenRun: (runId: string, name: string | undefined, live: boolean) => void;
}) {
  if (m.author_kind === "system") {
    return (
      <div className="my-3 text-center text-xs text-muted-foreground">
        {mission && showMissionBadge && (
          <div className="mb-1 flex justify-center"><MissionBadge mission={mission} onOpen={() => onOpenMission(mission.id)} /></div>
        )}
        {m.content}
      </div>
    );
  }
  const isUser = m.author_kind === "user";
  const displayName = isUser ? me.name : (name ?? "Agent");
  const accent = !isUser && name ? colorOf.get(name) : undefined;
  const time = formatTime(m.created_at);

  return (
    <div className={cn("group flex gap-3", grouped ? "mt-1" : "mt-7")}>
      <div className="w-9 shrink-0">
        {grouped ? (
          <span className="hidden select-none pt-1 text-right text-[10px] leading-4 text-muted-foreground/70 group-hover:block">{time}</span>
        ) : isUser ? (
          <UserAvatar name={me.name} url={me.avatar} />
        ) : (
          <AgentIdentity url={avatarUrl} seed={name} size={36} rounded="rounded-full" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {mission && showMissionBadge && (
          <div><MissionBadge mission={mission} onOpen={() => onOpenMission(mission.id)} /></div>
        )}
        {!grouped && (
          <div className="mb-0.5 flex items-baseline gap-2">
            <span className="text-sm font-semibold" style={accent ? { color: accent } : undefined}>{displayName}</span>
            <span className="text-[11px] font-normal text-muted-foreground">{time}</span>
          </div>
        )}
        {m.status === "thinking" ? (
          <button
            type="button"
            onClick={() => m.run_id && onOpenRun(m.run_id, name, true)}
            disabled={!m.run_id}
            className={cn(
              "flex items-center gap-2 py-0.5 text-sm text-muted-foreground",
              m.run_id && "rounded-md transition-colors hover:text-foreground",
            )}
            title={m.run_id ? "Voir l'activité de l'agent" : undefined}
          >
            <Loader2 className="h-4 w-4 animate-spin" /> travaille…
            {m.run_id && <span className="text-[11px] text-primary underline-offset-2 hover:underline">voir l'activité</span>}
          </button>
        ) : isUser ? (
          <>
            {m.content && <div className="chat-prose break-words text-[15px] leading-relaxed text-foreground">{renderWithMentions(m.content, colorOf)}</div>}
            {Array.isArray(m.ui_blocks) && m.ui_blocks.length > 0 && (
              <div className={cn(m.content && "mt-2")}><UiBlocks blocks={m.ui_blocks as unknown as UiBlock[]} onOpenArtifact={onOpenArtifact} /></div>
            )}
          </>
        ) : (
          // Weave ui_blocks at their [[ui:N]] positions (strips the raw tags,
          // renders charts/tables/artifacts inline; leftovers go at the end).
          <InterleavedMessage
            content={m.content ?? ""}
            blocks={Array.isArray(m.ui_blocks) ? (m.ui_blocks as unknown as UiBlock[]) : []}
            onOpenArtifact={onOpenArtifact}
            agentName={name}
          />
        )}
        {m.run_id && m.status !== "thinking" && !isUser && (
          <>
            <button
              type="button"
              onClick={() => onOpenRun(m.run_id!, name, false)}
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <Activity className="h-3 w-3" /> Voir l'activité & les livrables
            </button>
            <SubAgentInstances parentRunId={m.run_id} />
          </>
        )}
      </div>
    </div>
  );
}
