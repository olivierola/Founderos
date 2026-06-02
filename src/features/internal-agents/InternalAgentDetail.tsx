import { useState, useEffect, useRef, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Bot, Plus, Trash2, Save, Check, FileText, Target,
  Wrench, Users as UsersIcon, BarChart3, Settings as SettingsIcon,
  MessageSquare, Globe, Database, Zap, KeyRound, Play, Clock,
  CheckCircle2, XCircle, AlertCircle, Download,
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

export type InternalAgentTab =
  | "chat"
  | "mission"
  | "instructions"
  | "tools"
  | "members"
  | "analytics"
  | "settings";

const VALID_TABS: InternalAgentTab[] = [
  "chat", "mission", "instructions", "tools", "members", "analytics", "settings",
];

interface InternalAgent {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  description: string | null;
  avatar_emoji: string | null;
  accent_color: string | null;
  persona: string | null;
  instructions: string | null;
  model: string;
  temperature: number;
  chat_enabled: boolean;
  mission_enabled: boolean;
  created_by: string;
  is_archived: boolean;
  created_at: string;
}

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
      {tab === "instructions" && <InstructionsTab agent={agent} />}
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

      // Call the worker edge in "chat" mode. If the function doesn't exist yet,
      // surface a friendly placeholder reply so the UI keeps working.
      try {
        await callEdge("internal-agent-run", {
          agent_id: agent.id,
          mode: "chat",
          conversation_id: cid,
        });
        queryClient.invalidateQueries({ queryKey: ["internal_agent_messages", cid] });
      } catch (e: any) {
        // Worker not deployed yet — leave a placeholder reply locally.
        await supabase.from("internal_agent_messages").insert({
          conversation_id: cid,
          agent_id: agent.id,
          role: "assistant",
          content: `_(Agent worker not yet deployed.)_ I received: "${text}"`,
        });
        queryClient.invalidateQueries({ queryKey: ["internal_agent_messages", cid] });
      }
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

interface Mission {
  id: string;
  agent_id: string;
  title: string;
  brief: string | null;
  acceptance_criteria: string | null;
  expected_deliverables: Array<{ kind: string; name: string; description?: string }>;
  status: "draft" | "active" | "archived";
  created_at: string;
}

interface MissionRun {
  id: string;
  mission_id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  started_at: string | null;
  finished_at: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  action_count: number;
  final_output: string | null;
  error_message: string | null;
  created_at: string;
}

interface Deliverable {
  id: string;
  run_id: string;
  mission_id: string;
  kind: string;
  name: string;
  content: string | null;
  file_url: string | null;
  created_at: string;
}

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
  const [createOpen, setCreateOpen] = useState(false);

  const { data: missions } = useQuery({
    queryKey: ["internal_agent_missions", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_missions")
        .select("id, agent_id, title, brief, acceptance_criteria, expected_deliverables, status, created_at")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: false });
      return (data ?? []) as Mission[];
    },
  });

  // Auto-select first mission once loaded.
  useEffect(() => {
    if (!selectedId && missions && missions.length > 0) setSelectedId(missions[0].id);
  }, [missions, selectedId]);

  const selected = useMemo(
    () => missions?.find((m) => m.id === selectedId) ?? null,
    [missions, selectedId],
  );

  async function createMission(title: string, brief: string) {
    if (!user || !workspaceId || !projectId) return;
    const { data, error } = await supabase
      .from("internal_agent_missions")
      .insert({
        agent_id: agent.id,
        workspace_id: workspaceId,
        project_id: projectId,
        title,
        brief,
        status: "draft",
        created_by: user.id,
      })
      .select("id")
      .single();
    if (error) {
      alert(error.message);
      return;
    }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_missions", agent.id] });
    setCreateOpen(false);
    if (data) setSelectedId(data.id);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm">Missions</CardTitle>
          <Button size="sm" variant="ghost" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </CardHeader>
        <CardContent className="p-2">
          {!missions || missions.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">No missions yet</p>
          ) : (
            <div className="space-y-1">
              {missions.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setSelectedId(m.id)}
                  className={cn(
                    "w-full rounded px-2 py-1.5 text-left text-sm transition-colors",
                    selectedId === m.id
                      ? "bg-foreground/10 text-foreground"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                  )}
                >
                  <div className="truncate font-medium">{m.title}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{m.status}</div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div>
        {!selected ? (
          <EmptyState
            icon={Target}
            title="Pick a mission"
            description="Or create one to give this agent a structured task."
            action={<Button onClick={() => setCreateOpen(true)}><Plus className="mr-1.5 h-3.5 w-3.5" /> New mission</Button>}
          />
        ) : (
          <MissionDetail mission={selected} agent={agent} />
        )}
      </div>

      <CreateMissionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={createMission}
      />
    </div>
  );
}

function CreateMissionDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreate: (title: string, brief: string) => void | Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setTitle(""); setBrief(""); }
  }, [open]);

  async function submit() {
    if (!title.trim()) return;
    setSaving(true);
    try { await onCreate(title.trim(), brief.trim()); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>New mission</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Title</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="e.g. Weekly competitor digest" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Brief</label>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={6}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Describe the task in detail. What inputs, what outputs, what tone, what constraints?"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={submit} disabled={saving || !title.trim()}>
              {saving && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
              Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MissionDetail({ mission, agent }: { mission: Mission; agent: InternalAgent }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(mission.title);
  const [brief, setBrief] = useState(mission.brief ?? "");
  const [acceptance, setAcceptance] = useState(mission.acceptance_criteria ?? "");
  const [deliverables, setDeliverables] = useState(mission.expected_deliverables ?? []);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [launching, setLaunching] = useState(false);

  // Hydrate fields when switching mission.
  useEffect(() => {
    setTitle(mission.title);
    setBrief(mission.brief ?? "");
    setAcceptance(mission.acceptance_criteria ?? "");
    setDeliverables(mission.expected_deliverables ?? []);
  }, [mission.id]);

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
  const [open, setOpen] = useState(false);

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

  const statusIcon = {
    queued: <Clock className="h-3.5 w-3.5 text-muted-foreground" />,
    running: <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />,
    succeeded: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />,
    failed: <XCircle className="h-3.5 w-3.5 text-destructive" />,
    cancelled: <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />,
  }[run.status];

  return (
    <div className="rounded-md border border-border">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-muted/40"
      >
        <div className="flex items-center gap-2 text-sm">
          {statusIcon}
          <span className="font-medium capitalize">{run.status}</span>
          <span className="text-xs text-muted-foreground">{new Date(run.created_at).toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{run.action_count} actions</span>
          <span>${run.cost_usd.toFixed(4)}</span>
        </div>
      </button>
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

function DeliverableItem({ d }: { d: Deliverable }) {
  function download() {
    const blob = new Blob([d.content ?? ""], { type: d.kind === "json" ? "application/json" : "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${d.name}.${d.kind === "markdown" ? "md" : d.kind === "json" ? "json" : "txt"}`;
    a.click();
    URL.revokeObjectURL(url);
  }
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
          <Button size="sm" variant="ghost" onClick={download}><Download className="h-3 w-3" /></Button>
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
// INSTRUCTIONS TAB
// ============================================================================

function InstructionsTab({ agent }: { agent: InternalAgent }) {
  const queryClient = useQueryClient();
  const [persona, setPersona] = useState(agent.persona ?? "");
  const [instructions, setInstructions] = useState(agent.instructions ?? "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function save() {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("internal_agents")
        .update({ persona, instructions, updated_at: new Date().toISOString() })
        .eq("id", agent.id);
      if (error) throw error;
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["internal_agent", agent.id] });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Instructions</CardTitle>
          <div className="flex items-center gap-2">
            {savedAt && Date.now() - savedAt < 4000 && (
              <span className="text-xs text-muted-foreground"><Check className="mr-1 inline h-3 w-3" /> Saved</span>
            )}
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              <span className="ml-1">Save</span>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Persona</label>
          <Input
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            placeholder="e.g. Senior product analyst"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">Short role description used in the system prompt.</p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Detailed instructions</label>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={16}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder={`Detail how the agent should behave.\n\n- Tone & voice\n- Steps to take when receiving a task\n- Constraints / things to avoid\n- Output format`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================================
// TOOLS TAB
// ============================================================================

interface AgentTool {
  id: string;
  agent_id: string;
  kind: "web_search" | "web_fetch" | "db_read" | "edge_function" | "vault_connector" | "custom";
  name: string;
  description: string | null;
  config: Record<string, any>;
  enabled: boolean;
}

const TOOL_CATALOGUE: Array<{ kind: AgentTool["kind"]; label: string; icon: any; description: string }> = [
  { kind: "web_search", label: "Web search", icon: Globe, description: "Search the web for fresh information." },
  { kind: "web_fetch", label: "Fetch URL", icon: Globe, description: "Download and extract text from a URL." },
  { kind: "db_read", label: "Read project DB", icon: Database, description: "Read-only access to selected project tables." },
  { kind: "edge_function", label: "Call edge function", icon: Zap, description: "Invoke an internal edge function." },
  { kind: "vault_connector", label: "Use vault connector", icon: KeyRound, description: "Use a configured external connector (Buffer, Slack, GitHub…)." },
  { kind: "custom", label: "Custom tool", icon: Wrench, description: "Custom tool driven by JSON config." },
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

function ToolConfigEditor({ tool, onSave }: { tool: AgentTool; onSave: (c: Record<string, any>) => void }) {
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
    <div className="mt-2">
      <button
        onClick={() => setOpen(!open)}
        className="text-[11px] text-muted-foreground hover:text-foreground"
      >
        {open ? "Hide config" : "Configure"}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
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
// MEMBERS TAB — per-agent ACL
// ============================================================================

interface AgentMember {
  id: string;
  agent_id: string;
  user_id: string;
  role: "viewer" | "user" | "editor";
  added_at: string;
}

interface WorkspaceMemberRow {
  user_id: string;
  email: string | null;
  full_name: string | null;
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
  { slug: "instructions", label: "Instructions", icon: FileText },
  { slug: "tools", label: "Tools", icon: Wrench },
  { slug: "members", label: "Members", icon: UsersIcon },
  { slug: "analytics", label: "Analytics", icon: BarChart3 },
  { slug: "settings", label: "Settings", icon: SettingsIcon },
];
