import { useState, useEffect, useRef, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Bot, Plus, Trash2, Save, Check, FileText, Target,
  Wrench, Users as UsersIcon, BarChart3, Settings as SettingsIcon,
  MessageSquare, Globe, Database, Zap, KeyRound, Play, Clock,
  CheckCircle2, XCircle, AlertCircle, Download, Package, Pencil,
  CalendarClock, Repeat, UserCircle2, ShieldCheck, Ban, BookOpen,
  ListTree, Gauge,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { ChatComposer } from "@/components/ui/chat-composer";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { InstructionsEditor } from "./InstructionsEditor";
import { DeliverablesHub } from "./DeliverablesHub";
import { MissionWizard, type MissionDraft } from "./MissionWizard";
import {
  type InternalAgent, type Mission, type MissionRun, type Deliverable,
  type WorkspaceMemberRow, type RunEvent, type AgentApproval,
  PRIORITY_META, loadWorkspaceMembers, memberLabel,
  dueDateMeta, downloadDeliverable, relativeDate,
} from "./shared";

export type InternalAgentTab =
  | "chat"
  | "mission"
  | "deliverables"
  | "approvals"
  | "instructions"
  | "tools"
  | "members"
  | "analytics"
  | "settings";

const VALID_TABS: InternalAgentTab[] = [
  "chat", "mission", "deliverables", "approvals", "instructions", "tools", "members", "analytics", "settings",
];

export function InternalAgentDetailPage() {
  const { agentId, tab: tabParam } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const tab: InternalAgentTab = VALID_TABS.includes(tabParam as InternalAgentTab)
    ? (tabParam as InternalAgentTab)
    : "chat";

  const { data: agent, isLoading } = useQuery({
    queryKey: ["internal_agent", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents")
        .select("*")
        .eq("id", agentId!)
        .maybeSingle();
      return data as InternalAgent | null;
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!agent) return <EmptyState icon={Bot} title="Agent not found" />;

  return (
    <div>
      {tab === "chat" && <ChatTab agent={agent} workspaceId={workspaceId} projectId={projectId} />}
      {tab === "mission" && <MissionTab agent={agent} workspaceId={workspaceId} projectId={projectId} />}
      {tab === "deliverables" && <DeliverablesHub agent={agent} />}
      {tab === "approvals" && <ApprovalsTab agent={agent} />}
      {tab === "instructions" && <InstructionsEditor agent={agent} />}
      {tab === "tools" && <ToolsTab agent={agent} />}
      {tab === "members" && <MembersTab agent={agent} />}
      {tab === "analytics" && <AnalyticsTab agent={agent} />}
      {tab === "settings" && <SettingsTab agent={agent} />}
    </div>
  );
}

// ============================================================================
// CHAT TAB — conversation with the agent (uses internal_agent_conversations)
// ============================================================================

interface ChatMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  created_at: string;
}

function ChatTab({
  agent,
  workspaceId,
  projectId,
}: {
  agent: InternalAgent;
  workspaceId: string | null;
  projectId: string | null;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [convoId, setConvoId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const { data: messages } = useQuery({
    queryKey: ["internal_agent_messages", convoId],
    enabled: !!convoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_messages")
        .select("id, conversation_id, role, content, created_at")
        .eq("conversation_id", convoId!)
        .order("created_at", { ascending: true });
      return (data ?? []) as ChatMessage[];
    },
  });

  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [messages?.length]);

  async function handleSend(text: string) {
    if (!user || !workspaceId || !projectId || !text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      let cid = convoId;
      if (!cid) {
        const { data, error } = await supabase
          .from("internal_agent_conversations")
          .insert({
            agent_id: agent.id,
            workspace_id: workspaceId,
            project_id: projectId,
            user_id: user.id,
            title: text.slice(0, 60),
          })
          .select("id")
          .single();
        if (error) throw error;
        cid = data!.id;
        setConvoId(cid);
      }
      const { error: msgErr } = await supabase
        .from("internal_agent_messages")
        .insert({ conversation_id: cid, agent_id: agent.id, role: "user", content: text });
      if (msgErr) throw msgErr;
      setInput("");
      queryClient.invalidateQueries({ queryKey: ["internal_agent_messages", cid] });

      // Call the worker edge in "chat" mode — it runs the agent's tool loop
      // and persists the assistant reply.
      await callEdge("internal-agent-run", {
        agent_id: agent.id,
        mode: "chat",
        conversation_id: cid,
      });
      queryClient.invalidateQueries({ queryKey: ["internal_agent_messages", cid] });
    } catch (e: any) {
      setError(e?.message ?? "Failed to send");
    } finally {
      setSending(false);
    }
  }

  const isEmpty = !messages || messages.length === 0;

  return (
    <div className="flex h-[calc(100vh-12rem)] flex-col">
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-1">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div
              className="mb-3 flex h-12 w-12 items-center justify-center rounded-lg text-xl"
              style={{
                backgroundColor: (agent.accent_color ?? "#2F2FE4") + "22",
                color: agent.accent_color ?? undefined,
              }}
            >
              {agent.avatar_emoji ?? "🤖"}
            </div>
            <h3 className="text-base font-semibold">{agent.name}</h3>
            {agent.description && (
              <p className="mt-1 max-w-md text-sm text-muted-foreground">{agent.description}</p>
            )}
            <p className="mt-4 text-xs text-muted-foreground">Start a conversation below.</p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4 py-4">
            {messages!.map((m) => (
              <ChatBubble key={m.id} msg={m} />
            ))}
            {sending && (
              <div className="flex justify-start">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="bg-background/80 px-1 py-3 backdrop-blur">
        <ChatComposer
          value={input}
          onValueChange={setInput}
          onSubmit={({ message }) => handleSend(message)}
          loading={sending}
          placeholder={`Message ${agent.name}…`}
        />
        {error && <p className="mt-2 text-center text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}

function ChatBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-foreground/10 px-3 py-2 text-sm">{msg.content}</div>
      </div>
    );
  }
  if (msg.role === "tool") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs font-mono text-muted-foreground">
          <Wrench className="mb-1 inline h-3 w-3" /> {msg.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="prose prose-sm max-w-[95%] dark:prose-invert">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
      </div>
    </div>
  );
}

// ============================================================================
// MISSION TAB — give the agent a structured task with deliverables
// ============================================================================

function MissionTab({
  agent,
  workspaceId,
  projectId,
}: {
  agent: InternalAgent;
  workspaceId: string | null;
  projectId: string | null;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | Mission["status"]>("all");

  const { data: missions } = useQuery({
    queryKey: ["internal_agent_missions", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_missions")
        .select("id, agent_id, title, brief, acceptance_criteria, expected_deliverables, status, priority, due_date, assigned_to, tags, schedule, created_at")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: false });
      return (data ?? []) as Mission[];
    },
  });

  const { data: members } = useQuery({
    queryKey: ["ws_members_for_assign", agent.workspace_id],
    enabled: !!agent.workspace_id,
    queryFn: () => loadWorkspaceMembers(agent.workspace_id),
  });
  const memberById = useMemo(() => {
    const m: Record<string, WorkspaceMemberRow> = {};
    (members ?? []).forEach((x) => { m[x.user_id] = x; });
    return m;
  }, [members]);

  // Auto-select first mission once loaded.
  useEffect(() => {
    if (!selectedId && missions && missions.length > 0) setSelectedId(missions[0].id);
  }, [missions, selectedId]);

  const visible = useMemo(
    () => (missions ?? []).filter((m) => statusFilter === "all" || m.status === statusFilter),
    [missions, statusFilter],
  );

  const selected = useMemo(
    () => missions?.find((m) => m.id === selectedId) ?? null,
    [missions, selectedId],
  );

  async function createMission(draft: MissionDraft) {
    if (!user || !workspaceId || !projectId) return;
    const { data, error } = await supabase
      .from("internal_agent_missions")
      .insert({
        agent_id: agent.id,
        workspace_id: workspaceId,
        project_id: projectId,
        title: draft.title,
        brief: draft.brief || null,
        acceptance_criteria: draft.acceptance_criteria || null,
        expected_deliverables: draft.expected_deliverables,
        priority: draft.priority,
        due_date: draft.due_date,
        assigned_to: draft.assigned_to,
        tags: draft.tags,
        schedule: draft.schedule,
        // Scheduled missions become due immediately; the scheduler then bumps
        // next_run_at after each run.
        next_run_at: draft.schedule ? new Date().toISOString() : null,
        status: "active",
        created_by: user.id,
      })
      .select("id")
      .single();
    if (error) {
      alert(error.message);
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_missions", agent.id] });
    setWizardOpen(false);
    if (data) setSelectedId(data.id);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <Card className="flex max-h-[calc(100vh-12rem)] flex-col">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm">Missions</CardTitle>
          <Button size="sm" onClick={() => setWizardOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Assign
          </Button>
        </CardHeader>
        <div className="flex gap-1 px-3 pb-2">
          {(["all", "active", "draft", "archived"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] capitalize transition-colors",
                statusFilter === s ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-foreground/5",
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <CardContent className="min-h-0 flex-1 overflow-y-auto p-2">
          {visible.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">No missions</p>
          ) : (
            <div className="space-y-1">
              {visible.map((m) => (
                <MissionListItem
                  key={m.id}
                  m={m}
                  selected={selectedId === m.id}
                  assignee={m.assigned_to ? memberById[m.assigned_to] : undefined}
                  onClick={() => setSelectedId(m.id)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div>
        {!selected ? (
          <EmptyState
            icon={Target}
            title="Assign a mission"
            description="Give this agent a structured task with a brief, expected deliverables, an owner and a deadline."
            action={<Button onClick={() => setWizardOpen(true)}><Plus className="mr-1.5 h-3.5 w-3.5" /> Assign mission</Button>}
          />
        ) : (
          <MissionDetail mission={selected} agent={agent} members={members ?? []} />
        )}
      </div>

      <MissionWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        workspaceId={workspaceId}
        onSubmit={createMission}
      />
    </div>
  );
}

function MissionListItem({
  m, selected, assignee, onClick,
}: {
  m: Mission;
  selected: boolean;
  assignee?: WorkspaceMemberRow;
  onClick: () => void;
}) {
  const pr = PRIORITY_META[m.priority];
  const due = dueDateMeta(m.due_date);
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full rounded-md px-2.5 py-2 text-left transition-colors",
        selected ? "bg-foreground/10" : "hover:bg-foreground/5",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", pr.dot)} title={pr.label} />
        <span className="truncate text-sm font-medium">{m.title}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        <span className="uppercase tracking-wide">{m.status}</span>
        {m.schedule && (
          <span className="inline-flex items-center gap-0.5"><Repeat className="h-2.5 w-2.5" />{m.schedule}</span>
        )}
        {due && (
          <span className={cn("inline-flex items-center gap-0.5", due.overdue && "text-destructive")}>
            <CalendarClock className="h-2.5 w-2.5" />{due.label}
          </span>
        )}
        {assignee && (
          <span className="inline-flex items-center gap-0.5"><UserCircle2 className="h-2.5 w-2.5" />{memberLabel(assignee)}</span>
        )}
      </div>
      {m.tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {m.tags.slice(0, 3).map((t) => (
            <span key={t} className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{t}</span>
          ))}
        </div>
      )}
    </button>
  );
}

function MissionDetail({
  mission, agent, members,
}: {
  mission: Mission;
  agent: InternalAgent;
  members: WorkspaceMemberRow[];
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(mission.title);
  const [brief, setBrief] = useState(mission.brief ?? "");
  const [acceptance, setAcceptance] = useState(mission.acceptance_criteria ?? "");
  const [deliverables, setDeliverables] = useState(mission.expected_deliverables ?? []);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [launching, setLaunching] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const assignee = mission.assigned_to ? members.find((m) => m.user_id === mission.assigned_to) : undefined;
  const due = dueDateMeta(mission.due_date);
  const pr = PRIORITY_META[mission.priority];

  // Hydrate fields when switching mission.
  useEffect(() => {
    setTitle(mission.title);
    setBrief(mission.brief ?? "");
    setAcceptance(mission.acceptance_criteria ?? "");
    setDeliverables(mission.expected_deliverables ?? []);
  }, [mission.id]);

  async function saveFromWizard(draft: MissionDraft) {
    const { error } = await supabase
      .from("internal_agent_missions")
      .update({
        title: draft.title,
        brief: draft.brief || null,
        acceptance_criteria: draft.acceptance_criteria || null,
        expected_deliverables: draft.expected_deliverables,
        priority: draft.priority,
        due_date: draft.due_date,
        assigned_to: draft.assigned_to,
        tags: draft.tags,
        schedule: draft.schedule,
        next_run_at: draft.schedule ? (mission.next_run_at ?? new Date().toISOString()) : null,
        updated_by: user?.id ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", mission.id);
    if (error) { alert(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_missions", agent.id] });
    setEditOpen(false);
  }

  async function save() {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("internal_agent_missions")
        .update({
          title,
          brief,
          acceptance_criteria: acceptance,
          expected_deliverables: deliverables,
          updated_at: new Date().toISOString(),
        })
        .eq("id", mission.id);
      if (error) throw error;
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["internal_agent_missions", agent.id] });
    } finally {
      setSaving(false);
    }
  }

  async function launchRun() {
    if (!user) return;
    setLaunching(true);
    try {
      const { data, error } = await supabase
        .from("internal_agent_runs")
        .insert({
          mission_id: mission.id,
          agent_id: agent.id,
          workspace_id: agent.workspace_id,
          project_id: agent.project_id,
          status: "queued",
          triggered_by: user.id,
        })
        .select("id")
        .single();
      if (error) throw error;
      // Fire-and-forget worker invocation. Worker writes events/deliverables async.
      try { await callEdge("internal-agent-run", { agent_id: agent.id, mode: "mission", run_id: data!.id }); }
      catch { /* swallow — worker will be picked up on next poll */ }
      queryClient.invalidateQueries({ queryKey: ["internal_agent_runs", mission.id] });
    } finally {
      setLaunching(false);
    }
  }

  const { data: runs } = useQuery({
    queryKey: ["internal_agent_runs", mission.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_runs")
        .select("*")
        .eq("mission_id", mission.id)
        .order("created_at", { ascending: false });
      return (data ?? []) as MissionRun[];
    },
    refetchInterval: (q) => {
      const list = q.state.data as MissionRun[] | undefined;
      const hasLive = list?.some((r) => r.status === "queued" || r.status === "running");
      return hasLive ? 3000 : false;
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <CardTitle className="text-base">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="border-0 px-0 text-base font-semibold focus-visible:ring-0"
              />
            </CardTitle>
            <div className="flex items-center gap-2">
              {savedAt && Date.now() - savedAt < 4000 && (
                <span className="text-xs text-muted-foreground"><Check className="mr-1 inline h-3 w-3" /> Saved</span>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
                <Pencil className="h-3 w-3" /><span className="ml-1">Edit</span>
              </Button>
              <Button size="sm" variant="outline" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                <span className="ml-1">Save</span>
              </Button>
              <Button size="sm" onClick={launchRun} disabled={launching}>
                {launching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                <span className="ml-1">Run mission</span>
              </Button>
            </div>
          </div>
          {/* Assignment metadata strip */}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", pr.color)}>
              <span className={cn("h-2 w-2 rounded-full", pr.dot)} /> {pr.label}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted-foreground">
              <UserCircle2 className="h-3 w-3" /> {assignee ? memberLabel(assignee) : "Unassigned"}
            </span>
            {due && (
              <span className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
                due.overdue ? "border-destructive/40 text-destructive" : "border-border text-muted-foreground",
              )}>
                <CalendarClock className="h-3 w-3" /> {due.label}
              </span>
            )}
            {mission.schedule && (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 capitalize text-muted-foreground"
                title={mission.next_run_at ? `Next run: ${new Date(mission.next_run_at).toLocaleString()}` : undefined}
              >
                <Repeat className="h-3 w-3" /> {mission.schedule}
                {mission.next_run_at && (
                  <span className="normal-case">· next {new Date(mission.next_run_at).toLocaleDateString()}</span>
                )}
              </span>
            )}
            {mission.tags.map((t) => (
              <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{t}</span>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Brief</label>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={7}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Describe the task in detail."
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Acceptance criteria</label>
            <textarea
              value={acceptance}
              onChange={(e) => setAcceptance(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="What counts as done?"
            />
          </div>
          <DeliverablesEditor deliverables={deliverables} onChange={setDeliverables} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Run history</CardTitle>
        </CardHeader>
        <CardContent>
          {!runs || runs.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No runs yet. Click <strong>Run mission</strong> to launch one.</p>
          ) : (
            <div className="space-y-2">
              {runs.map((r) => (
                <RunCard key={r.id} run={r} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <MissionWizard
        open={editOpen}
        onOpenChange={setEditOpen}
        workspaceId={agent.workspace_id}
        initial={{
          title: mission.title,
          brief: mission.brief ?? "",
          acceptance_criteria: mission.acceptance_criteria ?? "",
          expected_deliverables: mission.expected_deliverables ?? [],
          priority: mission.priority,
          due_date: mission.due_date,
          assigned_to: mission.assigned_to,
          tags: mission.tags,
          schedule: mission.schedule,
        }}
        onSubmit={saveFromWizard}
      />
    </div>
  );
}

const DELIVERABLE_KINDS = ["markdown", "json", "file", "url", "code"] as const;

function DeliverablesEditor({
  deliverables,
  onChange,
}: {
  deliverables: Array<{ kind: string; name: string; description?: string }>;
  onChange: (d: Array<{ kind: string; name: string; description?: string }>) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">Expected deliverables</label>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange([...deliverables, { kind: "markdown", name: "Output" }])}
        >
          <Plus className="mr-1 h-3 w-3" /> Add
        </Button>
      </div>
      {deliverables.length === 0 ? (
        <p className="rounded border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          No deliverables specified.
        </p>
      ) : (
        <div className="space-y-2">
          {deliverables.map((d, i) => (
            <div key={i} className="flex items-center gap-2">
              <select
                value={d.kind}
                onChange={(e) => {
                  const next = [...deliverables]; next[i] = { ...d, kind: e.target.value }; onChange(next);
                }}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                {DELIVERABLE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <Input
                value={d.name}
                onChange={(e) => {
                  const next = [...deliverables]; next[i] = { ...d, name: e.target.value }; onChange(next);
                }}
                placeholder="Name"
                className="h-7 flex-1"
              />
              <Button size="sm" variant="ghost" onClick={() => onChange(deliverables.filter((_, j) => j !== i))}>
                <Trash2 className="h-3 w-3 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RunCard({ run }: { run: MissionRun }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const isLive = run.status === "queued" || run.status === "running";

  const { data: deliverables } = useQuery({
    queryKey: ["internal_agent_deliverables", run.id],
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_deliverables")
        .select("*")
        .eq("run_id", run.id)
        .order("created_at", { ascending: true });
      return (data ?? []) as Deliverable[];
    },
  });

  // Live activity timeline: every tool call/result the agent performs lands in
  // internal_agent_run_events; poll while the run is in flight.
  const { data: events } = useQuery({
    queryKey: ["internal_agent_run_events", run.id],
    enabled: open || isLive,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_run_events")
        .select("*")
        .eq("run_id", run.id)
        .order("created_at", { ascending: true })
        .limit(200);
      return (data ?? []) as RunEvent[];
    },
    refetchInterval: isLive ? 2500 : false,
  });

  async function cancelRun() {
    if (!confirm("Cancel this run? The agent stops before its next action.")) return;
    await supabase
      .from("internal_agent_runs")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("id", run.id)
      .in("status", ["queued", "running"]);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_runs", run.mission_id] });
  }

  const statusIcon = {
    queued: <Clock className="h-3.5 w-3.5 text-muted-foreground" />,
    running: <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />,
    succeeded: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />,
    failed: <XCircle className="h-3.5 w-3.5 text-destructive" />,
    cancelled: <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />,
  }[run.status];

  return (
    <div className="rounded-md border border-border">
      <div className="flex w-full items-center justify-between px-3 py-2 hover:bg-muted/40">
        <button onClick={() => setOpen(!open)} className="flex flex-1 items-center gap-2 text-left text-sm">
          {statusIcon}
          <span className="font-medium capitalize">{run.status}</span>
          {run.triggered_via === "schedule" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <Repeat className="h-2.5 w-2.5" /> scheduled
            </span>
          )}
          <span className="text-xs text-muted-foreground">{new Date(run.created_at).toLocaleString()}</span>
        </button>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{run.action_count} actions</span>
          <span>${run.cost_usd.toFixed(4)}</span>
          {isLive && (
            <Button size="sm" variant="ghost" onClick={cancelRun} title="Cancel run">
              <Ban className="h-3 w-3 text-destructive" />
            </Button>
          )}
        </div>
      </div>
      {(open || isLive) && events && events.length > 0 && (
        <div className="border-t border-border px-3 py-2">
          <div className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <ListTree className="h-3 w-3" /> Activity
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {events.map((ev) => <RunEventLine key={ev.id} ev={ev} />)}
          </div>
        </div>
      )}
      {open && (
        <div className="border-t border-border px-3 py-3 text-sm">
          {run.error_message && (
            <div className="mb-3 rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {run.error_message}
            </div>
          )}
          {run.final_output && (
            <div className="prose prose-sm mb-3 max-w-none dark:prose-invert">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{run.final_output}</ReactMarkdown>
            </div>
          )}
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Deliverables</div>
            {!deliverables || deliverables.length === 0 ? (
              <p className="text-xs italic text-muted-foreground">No deliverables produced.</p>
            ) : (
              deliverables.map((d) => <DeliverableItem key={d.id} d={d} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RunEventLine({ ev }: { ev: RunEvent }) {
  const meta: Record<RunEvent["kind"], { icon: any; cls: string; text: string }> = {
    tool_call: { icon: Wrench, cls: "text-sky-600", text: `${ev.payload?.tool ?? "tool"}(${summarizeArgs(ev.payload?.args)})` },
    tool_result: {
      icon: ev.payload?.ok === false ? XCircle : CheckCircle2,
      cls: ev.payload?.ok === false ? "text-destructive" : "text-emerald-600",
      text: String(ev.payload?.preview ?? "").slice(0, 140) || "(empty result)",
    },
    llm_call: { icon: Zap, cls: "text-violet-500", text: `LLM ${ev.payload?.model ?? ""} · ${(ev.tokens_in + ev.tokens_out).toLocaleString()} tokens` },
    status: { icon: AlertCircle, cls: "text-muted-foreground", text: String(ev.payload?.message ?? "status") },
    log: { icon: FileText, cls: "text-muted-foreground", text: String(ev.payload?.message ?? "log") },
    error: { icon: XCircle, cls: "text-destructive", text: String(ev.payload?.error ?? "error") },
  };
  const m = meta[ev.kind] ?? meta.log;
  const Icon = m.icon;
  return (
    <div className="flex items-start gap-1.5 text-[11px]">
      <Icon className={cn("mt-0.5 h-3 w-3 shrink-0", m.cls)} />
      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={m.text}>{m.text}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground/60">
        {new Date(ev.created_at).toLocaleTimeString()}
      </span>
    </div>
  );
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const s = JSON.stringify(args);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

function DeliverableItem({ d }: { d: Deliverable }) {
  return (
    <div className="rounded border border-border bg-muted/30 p-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium">{d.name}</span>
          <Badge variant="outline" className="text-[10px]">{d.kind}</Badge>
        </div>
        {d.file_url ? (
          <a href={d.file_url} target="_blank" rel="noreferrer">
            <Button size="sm" variant="ghost"><Download className="h-3 w-3" /></Button>
          </a>
        ) : d.content ? (
          <Button size="sm" variant="ghost" onClick={() => downloadDeliverable(d)}><Download className="h-3 w-3" /></Button>
        ) : null}
      </div>
      {d.content && d.kind === "markdown" && (
        <div className="prose prose-sm mt-2 max-w-none dark:prose-invert">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{d.content}</ReactMarkdown>
        </div>
      )}
      {d.content && d.kind !== "markdown" && (
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-background/60 p-2 text-[11px]">{d.content}</pre>
      )}
    </div>
  );
}

// ============================================================================
// TOOLS TAB
// ============================================================================

interface AgentTool {
  id: string;
  agent_id: string;
  kind: "web_search" | "web_fetch" | "db_read" | "rag_search" | "edge_function" | "vault_connector" | "custom";
  name: string;
  description: string | null;
  config: Record<string, any>;
  enabled: boolean;
  requires_approval: boolean;
}

const TOOL_CATALOGUE: Array<{ kind: AgentTool["kind"]; label: string; icon: any; description: string }> = [
  { kind: "web_search", label: "Web search", icon: Globe, description: "Search the web for fresh information." },
  { kind: "web_fetch", label: "Fetch URL", icon: Globe, description: "Download and extract text from a URL." },
  { kind: "db_read", label: "Read project DB", icon: Database, description: "Read-only access to selected project tables." },
  { kind: "rag_search", label: "Knowledge search", icon: BookOpen, description: "Semantic search over the project's indexed knowledge base." },
  { kind: "edge_function", label: "Call edge function", icon: Zap, description: "Invoke an internal edge function." },
  { kind: "vault_connector", label: "Connector inventory", icon: KeyRound, description: "List connected integrations (provider, status — no secrets)." },
  { kind: "custom", label: "Custom webhook tool", icon: Wrench, description: "Call an external webhook with model-provided arguments." },
];

function ToolsTab({ agent }: { agent: InternalAgent }) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);

  const { data: tools } = useQuery({
    queryKey: ["internal_agent_tools", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_tools")
        .select("*")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: true });
      return (data ?? []) as AgentTool[];
    },
  });

  async function addTool(kind: AgentTool["kind"], name: string) {
    const def = TOOL_CATALOGUE.find((t) => t.kind === kind)!;
    const { error } = await supabase.from("internal_agent_tools").insert({
      agent_id: agent.id,
      kind,
      name: name || def.label,
      description: def.description,
      config: {},
      // Action tools start approval-gated — safe by default; owners can relax it.
      requires_approval: kind === "edge_function" || kind === "custom",
    });
    if (error) { alert(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
    setAddOpen(false);
  }

  async function toggle(tool: AgentTool) {
    await supabase.from("internal_agent_tools").update({ enabled: !tool.enabled }).eq("id", tool.id);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
  }

  async function remove(id: string) {
    if (!confirm("Remove this tool?")) return;
    await supabase.from("internal_agent_tools").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
  }

  async function updateConfig(id: string, config: Record<string, any>) {
    await supabase.from("internal_agent_tools").update({ config }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
  }

  async function toggleApproval(tool: AgentTool) {
    await supabase
      .from("internal_agent_tools")
      .update({ requires_approval: !tool.requires_approval })
      .eq("id", tool.id);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Tools</CardTitle>
          <p className="text-xs text-muted-foreground">Grant capabilities to this agent.</p>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add tool</Button>
      </CardHeader>
      <CardContent>
        {!tools || tools.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No tools yet. Add one to give this agent capabilities.</p>
        ) : (
          <div className="space-y-2">
            {tools.map((t) => {
              const def = TOOL_CATALOGUE.find((d) => d.kind === t.kind);
              const Icon = def?.icon ?? Wrench;
              return (
                <div key={t.id} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="text-sm font-medium">{t.name}</div>
                        <div className="text-[11px] text-muted-foreground">{def?.description ?? t.description}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {(t.kind === "edge_function" || t.kind === "custom") && (
                        <button
                          onClick={() => toggleApproval(t)}
                          title="When on, the agent's calls to this tool wait for human approval before executing."
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                            t.requires_approval ? "bg-amber-500/15 text-amber-600" : "bg-muted text-muted-foreground",
                          )}
                        >
                          <ShieldCheck className="h-2.5 w-2.5" />
                          {t.requires_approval ? "Approval required" : "Auto-execute"}
                        </button>
                      )}
                      <button
                        onClick={() => toggle(t)}
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[10px] font-medium",
                          t.enabled ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground",
                        )}
                      >
                        {t.enabled ? "Enabled" : "Disabled"}
                      </button>
                      <Button size="sm" variant="ghost" onClick={() => remove(t.id)}>
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    </div>
                  </div>
                  <ToolConfigEditor tool={t} onSave={(c) => updateConfig(t.id, c)} />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add a tool</DialogTitle></DialogHeader>
          <div className="grid grid-cols-1 gap-2">
            {TOOL_CATALOGUE.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.kind}
                  onClick={() => addTool(t.kind, t.label)}
                  className="flex items-start gap-3 rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/40"
                >
                  <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
                  <div>
                    <div className="text-sm font-medium">{t.label}</div>
                    <div className="text-xs text-muted-foreground">{t.description}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// Structured configuration per tool kind. Kinds without options (web_search,
// web_fetch, rag_search, vault_connector) show nothing; the rest get focused
// fields, with the raw JSON always available as an escape hatch.
function ToolConfigEditor({ tool, onSave }: { tool: AgentTool; onSave: (c: Record<string, any>) => void }) {
  const [open, setOpen] = useState(false);
  const hasConfig = tool.kind === "db_read" || tool.kind === "edge_function" || tool.kind === "custom";
  if (!hasConfig) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen(!open)}
        className="text-[11px] text-muted-foreground hover:text-foreground"
      >
        {open ? "Hide config" : "Configure"}
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          {tool.kind === "db_read" && <DbReadConfig tool={tool} onSave={onSave} />}
          {tool.kind === "edge_function" && <EdgeFunctionConfig tool={tool} onSave={onSave} />}
          {tool.kind === "custom" && <CustomToolConfig tool={tool} onSave={onSave} />}
          <RawJsonConfig tool={tool} onSave={onSave} />
        </div>
      )}
    </div>
  );
}

function DbReadConfig({ tool, onSave }: { tool: AgentTool; onSave: (c: Record<string, any>) => void }) {
  const [tables, setTables] = useState(
    Array.isArray(tool.config?.tables) ? (tool.config.tables as string[]).join(", ") : "",
  );
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
        Allowed tables (comma-separated — the agent can only read these, scoped to this project)
      </label>
      <div className="flex gap-2">
        <Input
          value={tables}
          onChange={(e) => setTables(e.target.value)}
          placeholder="product_events, deals, marketing_posts"
          className="h-7 flex-1 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onSave({
              ...tool.config,
              tables: tables.split(",").map((t) => t.trim()).filter((t) => /^[a-zA-Z0-9_]+$/.test(t)),
            })
          }
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function EdgeFunctionConfig({ tool, onSave }: { tool: AgentTool; onSave: (c: Record<string, any>) => void }) {
  const [slug, setSlug] = useState(typeof tool.config?.slug === "string" ? tool.config.slug : "");
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
        Function slug (the agent gets one tool that POSTs to this function)
      </label>
      <div className="flex gap-2">
        <Input
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="send-notification"
          className="h-7 flex-1 font-mono text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!/^[a-z0-9-]+$/.test(slug)}
          onClick={() => onSave({ ...tool.config, slug })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function CustomToolConfig({ tool, onSave }: { tool: AgentTool; onSave: (c: Record<string, any>) => void }) {
  const [url, setUrl] = useState(typeof tool.config?.webhook_url === "string" ? tool.config.webhook_url : "");
  const [method, setMethod] = useState(typeof tool.config?.method === "string" ? tool.config.method : "POST");
  return (
    <div className="space-y-2">
      <label className="block text-[11px] font-medium text-muted-foreground">
        Webhook URL (called with the agent's JSON arguments)
      </label>
      <div className="flex gap-2">
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
        >
          {["POST", "GET", "PUT", "PATCH"].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hooks.example.com/agent"
          className="h-7 flex-1 font-mono text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!/^https?:\/\//.test(url)}
          onClick={() => onSave({ ...tool.config, webhook_url: url, method })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function RawJsonConfig({ tool, onSave }: { tool: AgentTool; onSave: (c: Record<string, any>) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(JSON.stringify(tool.config ?? {}, null, 2));
  const [err, setErr] = useState<string | null>(null);

  function save() {
    try {
      const parsed = JSON.parse(text);
      onSave(parsed);
      setErr(null);
      setOpen(false);
    } catch (e: any) {
      setErr("Invalid JSON: " + e.message);
    }
  }

  return (
    <div>
      <button onClick={() => setOpen(!open)} className="text-[10px] text-muted-foreground/70 hover:text-foreground">
        {open ? "Hide advanced (raw JSON)" : "Advanced (raw JSON)"}
      </button>
      {open && (
        <div className="mt-1 space-y-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            className="w-full rounded border border-input bg-background px-2 py-1.5 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {err && <p className="text-[11px] text-destructive">{err}</p>}
          <Button size="sm" variant="outline" onClick={save}>Save config</Button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// APPROVALS TAB — human-in-the-loop queue for sensitive agent actions
// ============================================================================

function ApprovalsTab({ agent }: { agent: InternalAgent }) {
  const queryClient = useQueryClient();
  const [deciding, setDeciding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: approvals } = useQuery({
    queryKey: ["internal_agent_approvals", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_approvals")
        .select("*")
        .eq("agent_id", agent.id)
        .order("requested_at", { ascending: false })
        .limit(100);
      return (data ?? []) as AgentApproval[];
    },
    refetchInterval: (q) => ((q.state.data as AgentApproval[] | undefined)?.some((a) => a.status === "pending") ? 5000 : false),
  });

  async function decide(approval: AgentApproval, decision: "approve" | "reject") {
    setDeciding(approval.id);
    setError(null);
    try {
      await callEdge("internal-agent-approve", { approval_id: approval.id, decision });
      queryClient.invalidateQueries({ queryKey: ["internal_agent_approvals", agent.id] });
    } catch (e: any) {
      setError(e?.message ?? "Decision failed");
    } finally {
      setDeciding(null);
    }
  }

  const pending = (approvals ?? []).filter((a) => a.status === "pending");
  const decided = (approvals ?? []).filter((a) => a.status !== "pending");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-amber-500" /> Pending approvals
            {pending.length > 0 && <Badge className="bg-amber-500/15 text-amber-600">{pending.length}</Badge>}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Actions the agent wants to perform that are gated behind human review. Approving executes them immediately.
          </p>
        </CardHeader>
        <CardContent>
          {error && <div className="mb-3 rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{error}</div>}
          {pending.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">Nothing waiting for approval.</p>
          ) : (
            <div className="space-y-2">
              {pending.map((a) => (
                <ApprovalCard key={a.id} approval={a} deciding={deciding === a.id} onDecide={decide} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {decided.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">History</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {decided.map((a) => (
                <ApprovalCard key={a.id} approval={a} deciding={false} onDecide={decide} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const APPROVAL_STATUS_META: Record<AgentApproval["status"], { label: string; cls: string }> = {
  pending: { label: "Pending", cls: "bg-amber-500/15 text-amber-600" },
  approved: { label: "Approved", cls: "bg-sky-500/15 text-sky-600" },
  rejected: { label: "Rejected", cls: "bg-muted text-muted-foreground" },
  executed: { label: "Executed", cls: "bg-emerald-500/15 text-emerald-600" },
  failed: { label: "Failed", cls: "bg-destructive/15 text-destructive" },
};

function ApprovalCard({
  approval, deciding, onDecide,
}: {
  approval: AgentApproval;
  deciding: boolean;
  onDecide: (a: AgentApproval, d: "approve" | "reject") => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = APPROVAL_STATUS_META[approval.status];
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <button onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium", meta.cls)}>{meta.label}</span>
          <span className="truncate font-mono text-xs">{approval.tool_name}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{relativeDate(approval.requested_at)}</span>
        </button>
        {approval.status === "pending" && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="outline" disabled={deciding} onClick={() => onDecide(approval, "reject")}>
              <XCircle className="mr-1 h-3 w-3 text-destructive" /> Reject
            </Button>
            <Button size="sm" disabled={deciding} onClick={() => onDecide(approval, "approve")}>
              {deciding ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
              Approve & run
            </Button>
          </div>
        )}
      </div>
      {approval.reason && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          <span className="font-medium">Agent's justification:</span> {approval.reason}
        </p>
      )}
      {open && (
        <div className="mt-2 space-y-2">
          <div>
            <div className="text-[10px] font-medium uppercase text-muted-foreground">Action ({approval.action_kind})</div>
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/40 p-2 text-[11px]">
              {JSON.stringify(approval.payload, null, 2)}
            </pre>
          </div>
          {approval.result?.detail && (
            <div>
              <div className="text-[10px] font-medium uppercase text-muted-foreground">Result</div>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/40 p-2 text-[11px]">{String(approval.result.detail)}</pre>
            </div>
          )}
          {approval.error_message && (
            <div className="rounded bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{approval.error_message}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// MEMBERS TAB — per-agent ACL
// ============================================================================

interface AgentMember {
  id: string;
  agent_id: string;
  user_id: string;
  role: "viewer" | "user" | "editor";
  added_at: string;
}


function MembersTab({ agent }: { agent: InternalAgent }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isOwner = user?.id === agent.created_by;

  const { data: members } = useQuery({
    queryKey: ["internal_agent_members", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_members")
        .select("id, agent_id, user_id, role, added_at")
        .eq("agent_id", agent.id);
      return (data ?? []) as AgentMember[];
    },
  });

  // Workspace members not yet on the agent (candidates to invite).
  const { data: candidates } = useQuery({
    queryKey: ["internal_agent_candidates", agent.id, agent.workspace_id, (members ?? []).length],
    enabled: !!agent.workspace_id,
    queryFn: async () => {
      const { data: wm } = await supabase
        .from("workspace_members")
        .select("user_id, profiles:profiles!workspace_members_user_id_fkey(email, full_name)")
        .eq("workspace_id", agent.workspace_id);
      const taken = new Set([agent.created_by, ...(members ?? []).map((m) => m.user_id)]);
      return (wm ?? [])
        .filter((m: any) => !taken.has(m.user_id))
        .map((m: any) => ({
          user_id: m.user_id,
          email: m.profiles?.email ?? null,
          full_name: m.profiles?.full_name ?? null,
        })) as WorkspaceMemberRow[];
    },
  });

  async function addMember(userId: string, role: AgentMember["role"]) {
    if (!user) return;
    const { error } = await supabase
      .from("internal_agent_members")
      .insert({ agent_id: agent.id, user_id: userId, role, added_by: user.id });
    if (error) { alert(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_members", agent.id] });
    queryClient.invalidateQueries({ queryKey: ["internal_agent_candidates", agent.id] });
  }

  async function changeRole(id: string, role: AgentMember["role"]) {
    await supabase.from("internal_agent_members").update({ role }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_members", agent.id] });
  }

  async function removeMember(id: string) {
    if (!confirm("Remove this member?")) return;
    await supabase.from("internal_agent_members").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_members", agent.id] });
    queryClient.invalidateQueries({ queryKey: ["internal_agent_candidates", agent.id] });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Members with access</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded border border-border bg-muted/30 px-3 py-2">
              <div className="text-sm">
                <span className="font-medium">Creator</span>
                <span className="ml-2 text-xs text-muted-foreground">{agent.created_by.slice(0, 8)}…</span>
              </div>
              <Badge variant="outline" className="text-[10px]">Owner</Badge>
            </div>
            {(members ?? []).length === 0 && (
              <p className="py-2 text-center text-xs text-muted-foreground">No additional members.</p>
            )}
            {(members ?? []).map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded border border-border px-3 py-2">
                <div className="text-sm">{m.user_id.slice(0, 8)}…</div>
                <div className="flex items-center gap-2">
                  <select
                    value={m.role}
                    disabled={!isOwner}
                    onChange={(e) => changeRole(m.id, e.target.value as AgentMember["role"])}
                    className="rounded border border-input bg-background px-1.5 py-0.5 text-xs"
                  >
                    <option value="viewer">viewer</option>
                    <option value="user">user</option>
                    <option value="editor">editor</option>
                  </select>
                  {isOwner && (
                    <Button size="sm" variant="ghost" onClick={() => removeMember(m.id)}>
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {isOwner && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Invite from workspace</CardTitle></CardHeader>
          <CardContent>
            {!candidates || candidates.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No more members to add.</p>
            ) : (
              <div className="space-y-2">
                {candidates.map((c) => (
                  <div key={c.user_id} className="flex items-center justify-between rounded border border-border px-3 py-2">
                    <div className="text-sm">
                      {c.full_name ?? c.email ?? c.user_id.slice(0, 8) + "…"}
                      {c.email && c.full_name && <span className="ml-2 text-xs text-muted-foreground">{c.email}</span>}
                    </div>
                    <Button size="sm" variant="outline" onClick={() => addMember(c.user_id, "user")}>
                      <Plus className="mr-1 h-3 w-3" /> Add
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ============================================================================
// ANALYTICS TAB — costs, actions, runs
// ============================================================================

function AnalyticsTab({ agent }: { agent: InternalAgent }) {
  const { data: runs } = useQuery({
    queryKey: ["internal_agent_runs_all", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_runs")
        .select("id, status, tokens_in, tokens_out, cost_usd, action_count, started_at, finished_at, created_at")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: false })
        .limit(200);
      return (data ?? []) as Array<{
        id: string; status: MissionRun["status"]; tokens_in: number; tokens_out: number;
        cost_usd: number; action_count: number; started_at: string | null; finished_at: string | null; created_at: string;
      }>;
    },
  });

  const { data: msgStats } = useQuery({
    queryKey: ["internal_agent_msg_stats", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_messages")
        .select("tokens_in, tokens_out, cost_usd")
        .eq("agent_id", agent.id);
      return (data ?? []) as Array<{ tokens_in: number; tokens_out: number; cost_usd: number }>;
    },
  });

  const totals = useMemo(() => {
    const r = runs ?? [];
    const m = msgStats ?? [];
    const totalRuns = r.length;
    const succeeded = r.filter((x) => x.status === "succeeded").length;
    const failed = r.filter((x) => x.status === "failed").length;
    const runCost = r.reduce((s, x) => s + Number(x.cost_usd ?? 0), 0);
    const chatCost = m.reduce((s, x) => s + Number(x.cost_usd ?? 0), 0);
    const totalCost = runCost + chatCost;
    const totalTokens = r.reduce((s, x) => s + x.tokens_in + x.tokens_out, 0)
      + m.reduce((s, x) => s + x.tokens_in + x.tokens_out, 0);
    const totalActions = r.reduce((s, x) => s + (x.action_count ?? 0), 0);
    return { totalRuns, succeeded, failed, totalCost, totalTokens, totalActions, runCost, chatCost };
  }, [runs, msgStats]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total runs" value={totals.totalRuns.toString()} hint={`${totals.succeeded} succeeded · ${totals.failed} failed`} />
        <Stat label="Total cost" value={`$${totals.totalCost.toFixed(4)}`} hint={`Missions $${totals.runCost.toFixed(4)} · Chat $${totals.chatCost.toFixed(4)}`} />
        <Stat label="Tokens used" value={totals.totalTokens.toLocaleString()} hint="In + out (all modes)" />
        <Stat label="Tool calls" value={totals.totalActions.toString()} hint="Across all runs" />
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Recent runs</CardTitle></CardHeader>
        <CardContent>
          {!runs || runs.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">No runs recorded.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="px-2 py-1.5 text-left font-medium">Status</th>
                    <th className="px-2 py-1.5 text-left font-medium">Started</th>
                    <th className="px-2 py-1.5 text-right font-medium">Duration</th>
                    <th className="px-2 py-1.5 text-right font-medium">Tokens</th>
                    <th className="px-2 py-1.5 text-right font-medium">Actions</th>
                    <th className="px-2 py-1.5 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => {
                    const dur = r.started_at && r.finished_at
                      ? Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)
                      : null;
                    return (
                      <tr key={r.id} className="border-b border-border/40 last:border-0">
                        <td className="px-2 py-1.5">
                          <Badge variant="outline" className="text-[10px] capitalize">{r.status}</Badge>
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-right text-muted-foreground">{dur != null ? `${dur}s` : "—"}</td>
                        <td className="px-2 py-1.5 text-right">{(r.tokens_in + r.tokens_out).toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-right">{r.action_count}</td>
                        <td className="px-2 py-1.5 text-right font-mono">${Number(r.cost_usd ?? 0).toFixed(4)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-xl font-semibold">{value}</div>
        {hint && <div className="mt-1 text-[10px] text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// SETTINGS TAB
// ============================================================================

function SettingsTab({ agent }: { agent: InternalAgent }) {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const isOwner = user?.id === agent.created_by;

  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [model, setModel] = useState(agent.model);
  const [temperature, setTemperature] = useState(agent.temperature);
  const [chatEnabled, setChatEnabled] = useState(agent.chat_enabled);
  const [missionEnabled, setMissionEnabled] = useState(agent.mission_enabled);
  const [maxSteps, setMaxSteps] = useState(agent.max_steps ?? 8);
  const [maxCost, setMaxCost] = useState(agent.max_run_cost_usd ?? 0.5);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function save() {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("internal_agents")
        .update({
          name,
          description,
          model,
          temperature,
          chat_enabled: chatEnabled,
          mission_enabled: missionEnabled,
          max_steps: Math.min(Math.max(Math.round(maxSteps) || 8, 1), 30),
          max_run_cost_usd: Math.max(Number(maxCost) || 0.5, 0),
          updated_at: new Date().toISOString(),
        })
        .eq("id", agent.id);
      if (error) throw error;
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["internal_agent", agent.id] });
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    if (!confirm("Archive this agent? Members will lose access. You can restore it later from the database.")) return;
    await supabase.from("internal_agents").update({ is_archived: true }).eq("id", agent.id);
    queryClient.invalidateQueries({ queryKey: ["internal_agents"] });
    navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal-agents`);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Settings</CardTitle>
            <div className="flex items-center gap-2">
              {savedAt && Date.now() - savedAt < 4000 && (
                <span className="text-xs text-muted-foreground"><Check className="mr-1 inline h-3 w-3" /> Saved</span>
              )}
              <Button size="sm" onClick={save} disabled={saving || !isOwner}>
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                <span className="ml-1">Save</span>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} disabled={!isOwner} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={!isOwner}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                <option value="groq">Groq (Llama 3.1)</option>
                <option value="deepseek">DeepSeek</option>
                <option value="gpt-4">GPT-4</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Temperature ({temperature})</label>
              <input
                type="range" min={0} max={1} step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
                disabled={!isOwner}
                className="w-full"
              />
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <label className="flex items-center gap-2 rounded border border-border p-3 text-sm">
              <input
                type="checkbox"
                checked={chatEnabled}
                onChange={(e) => setChatEnabled(e.target.checked)}
                disabled={!isOwner}
              />
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              Chat mode
            </label>
            <label className="flex items-center gap-2 rounded border border-border p-3 text-sm">
              <input
                type="checkbox"
                checked={missionEnabled}
                onChange={(e) => setMissionEnabled(e.target.checked)}
                disabled={!isOwner}
              />
              <Target className="h-4 w-4 text-muted-foreground" />
              Mission mode
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Gauge className="h-4 w-4 text-muted-foreground" /> Autonomy budget
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Hard limits applied to every run. The agent stops when it reaches the step budget; runs exceeding the
            cost budget are flagged in the timeline.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Max steps per run (tool-call rounds, 1–30)
              </label>
              <Input
                type="number" min={1} max={30}
                value={maxSteps}
                onChange={(e) => setMaxSteps(Number(e.target.value))}
                disabled={!isOwner}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Max cost per run (USD)
              </label>
              <Input
                type="number" min={0} step={0.05}
                value={maxCost}
                onChange={(e) => setMaxCost(Number(e.target.value))}
                disabled={!isOwner}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {isOwner && (
        <Card>
          <CardHeader><CardTitle className="text-sm text-destructive">Danger zone</CardTitle></CardHeader>
          <CardContent>
            <Button variant="outline" onClick={archive} className="text-destructive">
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Archive agent
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Re-export tab metadata so the sidebar can show the same labels/icons.
export const INTERNAL_AGENT_TABS: { slug: InternalAgentTab; label: string; icon: any }[] = [
  { slug: "chat", label: "Chat", icon: MessageSquare },
  { slug: "mission", label: "Missions", icon: Target },
  { slug: "deliverables", label: "Deliverables", icon: Package },
  { slug: "approvals", label: "Approvals", icon: ShieldCheck },
  { slug: "instructions", label: "Instructions", icon: FileText },
  { slug: "tools", label: "Tools", icon: Wrench },
  { slug: "members", label: "Members", icon: UsersIcon },
  { slug: "analytics", label: "Analytics", icon: BarChart3 },
  { slug: "settings", label: "Settings", icon: SettingsIcon },
];
