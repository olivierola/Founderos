import { useState, useEffect, useRef, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Bot, Plus, Trash2, Save, Check, FileText, Target,
  Wrench, Users as UsersIcon, BarChart3, Settings as SettingsIcon,
  MessageSquare, Globe, Database, Zap, KeyRound, Play, Clock,
  CheckCircle2, XCircle, AlertCircle, Download, Package, Pencil,
  CalendarClock, Repeat, UserCircle2, ShieldCheck, Ban, BookOpen,
  ListTree, Gauge, Brain, Pin, PinOff, ArrowLeft, ChevronDown, History,
  Network, MessagesSquare, Send, ArrowRight, Plug, AlertTriangle, Search,
  X, FileCode, TerminalSquare, BrainCircuit,
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
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/EmptyState";
import { ChatComposer } from "@/components/ui/chat-composer";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { InstructionsEditor } from "./InstructionsEditor";
import { CONNECTOR_ACTION_GROUPS, connectorActionProvider } from "./connectorActionProviders";
import { ConnectorDialog } from "@/features/integrations/ConnectorDialog";
import { findProvider } from "@/lib/providers";
import { Settings2 } from "lucide-react";
import { DeliverablesHub } from "./DeliverablesHub";
import { AgentPlanning, type PlanStep, type PlanStepStatus } from "@/components/ui/ai-planning";
import { MissionWizard, type MissionDraft } from "./MissionWizard";
import {
  type InternalAgent, type Mission, type MissionRun, type Deliverable,
  type WorkspaceMemberRow, type RunEvent,
  type AgentConversation, type AgentMemory, type MemoryKind, type BoardColumn,
  type A2AMessage,
  PRIORITY_META, MEMORY_KIND_META, BOARD_COLUMNS, loadWorkspaceMembers, memberLabel,
  dueDateMeta, downloadDeliverable, relativeDate,
} from "./shared";

export type InternalAgentTab =
  | "chat"
  | "mission"
  | "deliverables"
  | "artifacts"
  | "skills"
  | "memory"
  | "collaboration"
  | "instructions"
  | "analytics"
  | "settings";

const VALID_TABS: InternalAgentTab[] = [
  "chat", "mission", "deliverables", "artifacts", "skills", "memory", "collaboration", "instructions", "analytics", "settings",
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
      {tab === "artifacts" && <AgentArtifactsTab agentId={agent.id} />}
      {tab === "skills" && <SkillsTab agentId={agent.id} />}
      {tab === "memory" && <MemoryTab agent={agent} />}
      {tab === "collaboration" && <CollaborationTab agent={agent} />}
      {tab === "instructions" && <InstructionsEditor agent={agent} />}
      {tab === "analytics" && <AnalyticsTab agent={agent} />}
      {tab === "settings" && <SettingsTab agent={agent} />}
    </div>
  );
}

// Reusable agent tab body — lets other surfaces (e.g. the CRM record view)
// embed the real agent tabs (Chat / Missions / Deliverables / …) by agent id,
// without leaving their module. Loads the agent then renders the chosen tab.
export function AgentTabContent({ agentId, tab }: { agentId: string; tab: InternalAgentTab }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { data: agent, isLoading } = useQuery({
    queryKey: ["internal_agent", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("*").eq("id", agentId).maybeSingle();
      return data as InternalAgent | null;
    },
  });
  if (isLoading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!agent) return <EmptyState icon={Bot} title="Agent not found" />;
  return (
    <>
      {tab === "chat" && <ChatTab agent={agent} workspaceId={workspaceId} projectId={projectId} />}
      {tab === "mission" && <MissionTab agent={agent} workspaceId={workspaceId} projectId={projectId} />}
      {tab === "deliverables" && <DeliverablesHub agent={agent} />}
      {tab === "artifacts" && <AgentArtifactsTab agentId={agent.id} />}
      {tab === "skills" && <SkillsTab agentId={agent.id} />}
      {tab === "memory" && <MemoryTab agent={agent} />}
      {tab === "collaboration" && <CollaborationTab agent={agent} />}
      {tab === "instructions" && <InstructionsEditor agent={agent} />}
      {tab === "analytics" && <AnalyticsTab agent={agent} />}
      {tab === "settings" && <SettingsTab agent={agent} />}
    </>
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
  tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
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
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  function openDeliverable(id: string) {
    navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal/${agent.id}/deliverables?d=${id}`);
  }
  const [convoId, setConvoId] = useState<string | null>(null);
  // null convoId + started=false → resume the latest session; once the user
  // clicks "New session" we stay on the blank state until they send.
  const [startedFresh, setStartedFresh] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const { data: conversations } = useQuery({
    queryKey: ["internal_agent_conversations", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_conversations")
        .select("id, agent_id, title, user_id, created_at, updated_at")
        .eq("agent_id", agent.id)
        .order("updated_at", { ascending: false })
        .limit(50);
      return (data ?? []) as AgentConversation[];
    },
  });

  // Resume the most recent session by default.
  useEffect(() => {
    if (!convoId && !startedFresh && conversations && conversations.length > 0) {
      setConvoId(conversations[0].id);
    }
  }, [conversations, convoId, startedFresh]);

  async function deleteConversation(id: string) {
    if (!confirm("Delete this session and its messages?")) return;
    await supabase.from("internal_agent_conversations").delete().eq("id", id);
    if (convoId === id) { setConvoId(null); setStartedFresh(true); }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_conversations", agent.id] });
  }

  const { data: messages } = useQuery({
    queryKey: ["internal_agent_messages", convoId],
    enabled: !!convoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_messages")
        .select("id, conversation_id, role, content, tool_calls, tokens_in, tokens_out, cost_usd, created_at")
        .eq("conversation_id", convoId!)
        .order("created_at", { ascending: true });
      return (data ?? []) as ChatMessage[];
    },
  });

  // Deliverables this agent produced during this chat session — rendered as
  // artifact cards under the matching assistant message.
  const { data: convoDeliverables } = useQuery({
    queryKey: ["internal_agent_convo_deliverables", convoId],
    enabled: !!convoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_deliverables")
        .select("id, kind, name, summary, created_at")
        .eq("conversation_id", convoId!)
        .order("created_at", { ascending: true });
      return (data ?? []) as Array<{ id: string; kind: string; name: string; summary: string | null; created_at: string }>;
    },
  });

  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [messages?.length]);

  async function handleSend(text: string) {
    if (!user || !workspaceId || !projectId || !text.trim() || sending) return;
    if (!agent?.id) { setError("Agent is still loading — please retry in a moment."); return; }
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
      queryClient.invalidateQueries({ queryKey: ["internal_agent_conversations", agent.id] });
      queryClient.invalidateQueries({ queryKey: ["internal_agent_convo_deliverables", cid] });
    } catch (e: any) {
      setError(e?.message ?? "Failed to send");
    } finally {
      setSending(false);
    }
  }

  const isEmpty = !messages || messages.length === 0;
  const currentConvo = conversations?.find((c) => c.id === convoId) ?? null;

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      {/* Floating session switcher */}
      <div className="flex items-center justify-between px-1 pb-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="max-w-[320px]">
              <History className="mr-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {currentConvo ? (currentConvo.title || "Untitled session") : "New session"}
              </span>
              <ChevronDown className="ml-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuItem
              onClick={() => { setConvoId(null); setStartedFresh(true); setError(null); }}
            >
              <Plus className="mr-2 h-3.5 w-3.5" /> New session
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">
              Recent sessions
            </DropdownMenuLabel>
            {!conversations || conversations.length === 0 ? (
              <div className="px-2 py-3 text-center text-[11px] text-muted-foreground">No sessions yet.</div>
            ) : (
              <div className="max-h-72 overflow-y-auto">
                {conversations.map((c) => (
                  <DropdownMenuItem
                    key={c.id}
                    className={cn("group flex items-center gap-2", convoId === c.id && "bg-foreground/5")}
                    onClick={() => { setConvoId(c.id); setStartedFresh(false); setError(null); }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{c.title || "Untitled session"}</div>
                      <div className="text-[10px] text-muted-foreground">{relativeDate(c.updated_at)}</div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteConversation(c.id); }}
                      className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                      title="Delete session"
                    >
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </button>
                  </DropdownMenuItem>
                ))}
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {currentConvo && (
          <span className="text-[10px] text-muted-foreground">{relativeDate(currentConvo.updated_at)}</span>
        )}
      </div>

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
            {messages!.map((m, i) => {
              // Attach all session artifacts to the last assistant message.
              const isLastAssistant =
                m.role === "assistant" &&
                !messages!.slice(i + 1).some((x) => x.role === "assistant");
              return (
                <ChatBubble
                  key={m.id}
                  msg={m}
                  artifacts={isLastAssistant ? (convoDeliverables ?? []) : []}
                  onOpenArtifact={openDeliverable}
                />
              );
            })}
            {sending && <LiveRunEvents agentId={agent.id} />}
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

// Live run events — shows tool calls, LLM reasoning, and errors in real-time
// while the agent is working, using the AgentPlanning timeline component.
function LiveRunEvents({ agentId }: { agentId: string }) {
  const { data } = useQuery({
    queryKey: ["live_run_events", agentId],
    refetchInterval: 700,
    queryFn: async () => {
      // Find the latest run for this agent (running, queued, OR just completed in last 30s)
      const { data: runs } = await supabase
        .from("internal_agent_runs")
        .select("id, status, started_at, created_at")
        .eq("agent_id", agentId)
        .order("created_at", { ascending: false })
        .limit(1);
      const run = runs?.[0];
      if (!run) return { events: [], status: "idle", runId: null };
      // Only show if running/queued or completed within last 30s
      if (run.status !== "running" && run.status !== "queued") {
        const age = Date.now() - new Date(run.created_at).getTime();
        if (age > 30000) return { events: [], status: "idle", runId: null };
      }
      const { data: events } = await supabase
        .from("internal_agent_run_events")
        .select("id, kind, summary, payload, created_at")
        .eq("run_id", run.id)
        .order("created_at", { ascending: true })
        .limit(50);
      return { events: events ?? [], status: run.status, runId: run.id };
    },
  });

  const events = (data?.events ?? []) as any[];
  const status = data?.status ?? "idle";
  const isWorking = status === "running" || status === "queued";

  const steps: PlanStep[] = [];

  // Pair tool_call events with their following tool_result.
  const resultByTool: Record<string, any> = {};
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.kind === "tool_result") {
      const t = ev.payload?.tool ?? "";
      resultByTool[`${t}_${i}`] = ev;
    }
  }

  // Compute elapsed time (delta) between an event and its result for "took Xs" display.
  const elapsed = (fromIso: string, toIso?: string): string => {
    if (!toIso) return "";
    const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
    if (ms < 0) return "";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const payload = ev.payload ?? {};
    const ts = new Date(ev.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    if (ev.kind === "tool_call") {
      const tool = payload.tool ?? payload.name ?? "tool";
      const args = payload.args ?? payload.arguments ?? {};
      // Find the matching result (next tool_result with same tool name)
      let resultEv: any = null;
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].kind === "tool_result" && (events[j].payload?.tool ?? "") === tool) { resultEv = events[j]; break; }
        if (events[j].kind === "tool_call") break;
      }
      const summary = toolSummary(tool, args);
      const icon = toolIcon(tool);
      const isLast = !resultEv && i >= events.length - 2;
      const took = elapsed(ev.created_at, resultEv?.created_at);
      steps.push({
        id: ev.id,
        title: summary,
        status: isLast && isWorking ? "active" : "success",
        icon,
        duration: took || ts,
        defaultExpanded: false,
        content: (
          <div className="space-y-1.5 mt-1">
            {Object.keys(args).length > 0 && (
              <div className="font-mono text-[11px] rounded-md bg-zinc-950 border border-border/50 p-2.5 text-zinc-400 max-h-40 overflow-y-auto whitespace-pre-wrap">
                <span className="text-zinc-500">args:</span> {(typeof args === "string" ? args : JSON.stringify(args, null, 2)).slice(0, 2000)}
              </div>
            )}
            {resultEv && (
              <div className="font-mono text-[11px] rounded-md bg-zinc-950 border border-emerald-500/20 p-2.5 text-emerald-300/90 max-h-48 overflow-y-auto whitespace-pre-wrap">
                <span className="text-emerald-500/70">result:</span> {String(resultEv.payload?.result ?? resultEv.payload?.preview ?? "(empty)").slice(0, 2000)}
              </div>
            )}
          </div>
        ),
      });
    } else if (ev.kind === "error") {
      steps.push({
        id: ev.id, title: `Error: ${payload.message ?? payload.error ?? "unknown"}`,
        status: "error", icon: <AlertTriangle className="w-3.5 h-3.5" />, duration: ts, defaultExpanded: true,
        content: <div className="font-mono text-[11px] mt-1 p-2.5 rounded-md bg-rose-500/10 border border-rose-500/20 text-rose-400">{String(payload.message ?? payload.error ?? "Unknown error").slice(0, 800)}</div>,
      });
    } else if (ev.kind === "llm_call") {
      steps.push({
        id: ev.id, title: `Reasoning (${payload.model ?? "LLM"}, ${payload.rounds ?? "?"} rounds)`,
        status: "success", icon: <BrainCircuit className="w-3.5 h-3.5" />, duration: ts,
      });
    } else if (ev.kind === "browser_navigate") {
      steps.push({ id: ev.id, title: `Navigate → ${payload.url ?? ""}`, status: "success", icon: <Globe className="w-3.5 h-3.5" />, duration: ts });
    } else if (ev.kind === "browser_screenshot") {
      steps.push({ id: ev.id, title: `Screenshot: ${payload.url ?? "page"}`, status: "success", icon: <Globe className="w-3.5 h-3.5" />, duration: ts });
    } else if (ev.kind === "status" || ev.kind === "log") {
      // Skip generic status to reduce noise (but keep first one)
      if (i === 0) steps.push({ id: ev.id, title: payload.message ?? "Started", status: "success", icon: <Check className="w-3.5 h-3.5" />, duration: ts });
    }
    // tool_result events are folded into their tool_call above — skip standalone
  }

  // Leading/trailing "thinking" step while working.
  if (steps.length === 0) {
    steps.push({
      id: "thinking", title: "Agent is thinking…", status: "active" as PlanStepStatus,
      icon: <BrainCircuit className="w-3.5 h-3.5" />, defaultExpanded: true,
      content: <div className="font-mono text-[11px] flex items-center gap-2 text-blue-400"><Loader2 className="w-3 h-3 animate-spin" />Analyzing your request…</div>,
    });
  } else if (isWorking && steps[steps.length - 1].status !== "active") {
    steps.push({ id: "next", title: "Processing next step…", status: "active" as PlanStepStatus, icon: <BrainCircuit className="w-3.5 h-3.5" /> });
  }

  return <AgentPlanning live={isWorking} title={isWorking ? "Agent is working" : `Agent completed · ${steps.filter((s) => s.id !== "next").length} steps`} steps={steps} />;
}

// Human-readable summary for a tool call.
function toolSummary(tool: string, args: any): string {
  const a = args ?? {};
  switch (tool) {
    case "shell_exec": return `$ ${String(a.command ?? "").slice(0, 70)}`;
    case "python_exec": return `Python: ${String(a.code ?? "").replace(/\n/g, " ").slice(0, 55)}…`;
    case "nodejs_exec": return `Node: ${String(a.code ?? "").replace(/\n/g, " ").slice(0, 55)}…`;
    case "jupyter_exec": return `Jupyter: ${String(a.code ?? "").replace(/\n/g, " ").slice(0, 55)}…`;
    case "file_write": return `Write → ${String(a.file ?? "").slice(0, 50)}`;
    case "file_read": return `Read ← ${String(a.file ?? "").slice(0, 50)}`;
    case "file_edit": return `Edit ${String(a.file ?? "").slice(0, 45)}`;
    case "list_files": return `List ${String(a.path ?? "/home/gem").slice(0, 45)}`;
    case "file_search": return `Search ${a.grep ? `"${String(a.grep).slice(0, 30)}"` : String(a.glob ?? "")}`;
    case "sandbox_browser": return `Browser: ${a.action}${a.url ? ` → ${String(a.url).slice(0, 40)}` : a.selector ? ` ${String(a.selector).slice(0, 30)}` : ""}`;
    case "sandbox_env": return `Env: ${a.action}`;
    case "browse_web": return a.url ? `Browse → ${String(a.url).slice(0, 50)}` : `Browser: ${a.action ?? ""}`;
    case "http_get": return `GET ${String(a.url ?? "").slice(0, 55)}`;
    case "web_search": return `Search: "${String(a.query ?? "").slice(0, 45)}"`;
    case "deep_research": return `Research: "${String(a.query ?? "").slice(0, 45)}"`;
    case "create_deliverable": return `Create: ${String(a.name ?? "deliverable")}`;
    case "create_task": return `Task: ${String(a.title ?? "")}`;
    case "create_mission": return `Mission: ${String(a.title ?? "")}`;
    case "save_memory": return `Remember: ${String(a.content ?? "").slice(0, 40)}…`;
    case "search_memory": return `Recall: "${String(a.query ?? "").slice(0, 40)}"`;
    case "send_email": return `Email → ${String(a.to ?? "")}`;
    default: return tool.replace(/_/g, " ");
  }
}

function toolIcon(tool: string): React.ReactNode {
  if (tool.includes("browser") || tool === "browse_web" || tool === "http_get") return <Globe className="w-3.5 h-3.5" />;
  if (tool.includes("search") || tool === "deep_research") return <Search className="w-3.5 h-3.5" />;
  if (tool.includes("file") || tool === "list_files") return <FileText className="w-3.5 h-3.5" />;
  if (tool.includes("python") || tool.includes("nodejs") || tool.includes("shell") || tool.includes("jupyter")) return <TerminalSquare className="w-3.5 h-3.5" />;
  if (tool === "create_deliverable") return <Package className="w-3.5 h-3.5" />;
  if (tool.includes("memory")) return <Brain className="w-3.5 h-3.5" />;
  return <TerminalSquare className="w-3.5 h-3.5" />;
}

interface ChatArtifact { id: string; kind: string; name: string; summary: string | null }

function ChatBubble({
  msg, artifacts = [], onOpenArtifact,
}: {
  msg: ChatMessage;
  artifacts?: ChatArtifact[];
  onOpenArtifact?: (id: string) => void;
}) {
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
  const toolCalls = msg.tool_calls ?? [];

  // Build rich tool call steps for AgentPlanning
  const toolSteps: PlanStep[] = toolCalls.map((tc, i) => {
    const name = tc.name;
    const args = tc.args ?? {};
    const argsStr = JSON.stringify(args, null, 2);

    // Icon based on tool type
    let icon: React.ReactNode = <TerminalSquare className="w-3.5 h-3.5" />;
    if (name.includes("browser") || name === "browse_web") icon = <Globe className="w-3.5 h-3.5" />;
    else if (name.includes("search") || name === "deep_research") icon = <Search className="w-3.5 h-3.5" />;
    else if (name.includes("file") || name === "list_files") icon = <FileText className="w-3.5 h-3.5" />;
    else if (name.includes("python") || name.includes("nodejs") || name === "shell_exec" || name === "jupyter_exec") icon = <TerminalSquare className="w-3.5 h-3.5" />;
    else if (name === "create_deliverable") icon = <Package className="w-3.5 h-3.5" />;
    else if (name === "save_memory" || name === "search_memory") icon = <Brain className="w-3.5 h-3.5" />;
    else if (name === "send_email") icon = <Globe className="w-3.5 h-3.5" />;
    else if (name === "http_get") icon = <Globe className="w-3.5 h-3.5" />;

    // Build a human-readable summary
    let summary = name;
    if (name === "http_get" && args.url) summary = `GET ${String(args.url).slice(0, 60)}`;
    else if (name === "browse_web" && args.url) summary = `Navigate → ${String(args.url).slice(0, 60)}`;
    else if (name === "browse_web" && args.action) summary = `Browser: ${args.action} ${args.selector ? `on ${String(args.selector).slice(0, 30)}` : ""}`;
    else if (name === "web_search") summary = `Search: "${String(args.query ?? "").slice(0, 50)}"`;
    else if (name === "deep_research") summary = `Research: "${String(args.query ?? "").slice(0, 50)}"`;
    else if (name === "file_write") summary = `Write file: ${String(args.path ?? "").slice(0, 40)}`;
    else if (name === "file_read") summary = `Read file: ${String(args.path ?? "").slice(0, 40)}`;
    else if (name === "shell_exec") summary = `$ ${String(args.command ?? "").slice(0, 60)}`;
    else if (name === "python_exec") summary = `Python: ${String(args.code ?? "").slice(0, 50)}…`;
    else if (name === "nodejs_exec") summary = `Node: ${String(args.code ?? "").slice(0, 50)}…`;
    else if (name === "jupyter_exec") summary = `Jupyter: ${String(args.code ?? "").slice(0, 50)}…`;
    else if (name === "create_deliverable") summary = `Create: ${String(args.name ?? "deliverable")}`;
    else if (name === "create_task") summary = `Task: ${String(args.title ?? "")}`;
    else if (name === "save_memory") summary = `Remember: ${String(args.content ?? "").slice(0, 40)}…`;
    else if (name === "sandbox_browser_action") summary = `Browser ${String(args.action ?? "")}`;
    else if (name === "mcp_call_tool") summary = `MCP: ${String(args.tool_name ?? "")}`;

    return {
      id: String(i),
      title: summary,
      status: "success" as PlanStepStatus,
      icon,
      content: argsStr.length > 5 ? (
        <div className="font-mono text-[11px] mt-1 rounded-md bg-zinc-950 border border-border/50 p-2.5 text-zinc-400 max-h-48 overflow-y-auto whitespace-pre-wrap">
          {argsStr.slice(0, 3000)}
        </div>
      ) : undefined,
    };
  });

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[95%]">
        {/* Tool calls timeline */}
        {toolSteps.length > 0 && (
          <AgentPlanning
            title={`${toolSteps.length} tool${toolSteps.length > 1 ? "s" : ""} used · ${msg.tokens_in ?? 0} tokens in · ${msg.tokens_out ?? 0} out${msg.cost_usd ? ` · $${msg.cost_usd.toFixed(4)}` : ""}`}
            steps={toolSteps}
          />
        )}
        {/* Message content */}
        <div className="prose prose-sm dark:prose-invert">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
        </div>
        {artifacts.length > 0 && (
          <div className="mt-3 space-y-2">
            {artifacts.map((a) => (
              <ArtifactCard key={a.id} artifact={a} onOpen={() => onOpenArtifact?.(a.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// A clickable card representing a deliverable the agent produced in chat.
function ArtifactCard({ artifact, onOpen }: { artifact: ChatArtifact; onOpen: () => void }) {
  const Icon =
    artifact.kind === "report" ? BarChart3
    : artifact.kind === "json" ? Database
    : artifact.kind === "code" ? FileText
    : artifact.kind === "url" ? Globe
    : FileText;
  const label = artifact.kind === "report" ? "Structured report" : artifact.kind;
  return (
    <button
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-600 text-white">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{artifact.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {artifact.summary || label}
        </div>
      </div>
      <span className="flex items-center gap-1 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
        Open <ArrowRight className="h-3.5 w-3.5" />
      </span>
    </button>
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
  const [dragOverCol, setDragOverCol] = useState<BoardColumn | null>(null);

  const { data: missions } = useQuery({
    queryKey: ["internal_agent_missions", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_missions")
        .select("id, agent_id, title, brief, acceptance_criteria, expected_deliverables, status, priority, due_date, assigned_to, tags, schedule, board_column, last_run_at, next_run_at, created_at")
        .eq("agent_id", agent.id)
        .neq("status", "archived")
        .order("updated_at", { ascending: false });
      return (data ?? []) as Mission[];
    },
    // The agent moves cards itself (move_mission + worker auto-moves):
    // refresh the board while any of its missions is being worked on.
    refetchInterval: (q) =>
      (q.state.data as Mission[] | undefined)?.some((m) => m.board_column === "in_progress") ? 4000 : false,
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

  const selected = useMemo(
    () => missions?.find((m) => m.id === selectedId) ?? null,
    [missions, selectedId],
  );

  async function moveMission(missionId: string, column: BoardColumn) {
    // Optimistic: snap the card into place before the round-trip.
    queryClient.setQueryData(["internal_agent_missions", agent.id], (old: Mission[] | undefined) =>
      (old ?? []).map((m) => (m.id === missionId ? { ...m, board_column: column } : m)));
    await supabase
      .from("internal_agent_missions")
      .update({ board_column: column, updated_at: new Date().toISOString() })
      .eq("id", missionId);
    queryClient.invalidateQueries({ queryKey: ["internal_agent_missions", agent.id] });
  }

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

  // Inline detail (no side-by-side): selecting a card swaps the board out.
  if (selected) {
    return (
      <div className="space-y-3">
        <Button size="sm" variant="ghost" onClick={() => setSelectedId(null)}>
          <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Board
        </Button>
        <MissionDetail mission={selected} agent={agent} members={members ?? []} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Drag cards between columns — the agent moves them too as it works (running → In progress, output ready → Review).
        </p>
        <Button size="sm" onClick={() => setWizardOpen(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Assign mission
        </Button>
      </div>

      {(!missions || missions.length === 0) ? (
        <EmptyState
          icon={Target}
          title="Assign a mission"
          description="Give this agent a structured task with a brief, expected deliverables, an owner and a deadline."
          action={<Button onClick={() => setWizardOpen(true)}><Plus className="mr-1.5 h-3.5 w-3.5" /> Assign mission</Button>}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {BOARD_COLUMNS.map((col) => {
            const cards = (missions ?? []).filter((m) => (m.board_column ?? "todo") === col.key);
            return (
              <div
                key={col.key}
                onDragOver={(e) => { e.preventDefault(); setDragOverCol(col.key); }}
                onDragLeave={() => setDragOverCol((c) => (c === col.key ? null : c))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverCol(null);
                  const id = e.dataTransfer.getData("text/mission-id");
                  if (id) moveMission(id, col.key);
                }}
                className={cn(
                  "flex min-h-[280px] flex-col rounded-lg border bg-muted/20 transition-colors",
                  dragOverCol === col.key ? "border-primary/60 bg-primary/5" : "border-border",
                )}
              >
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <span className={cn("h-2 w-2 rounded-full", col.accent)} />
                  <span className="text-xs font-semibold">{col.label}</span>
                  <span className="ml-auto rounded-full bg-foreground/10 px-1.5 text-[10px] text-muted-foreground">{cards.length}</span>
                </div>
                <div className="flex-1 space-y-2 px-2 pb-2">
                  {cards.map((m) => (
                    <KanbanCard
                      key={m.id}
                      m={m}
                      assignee={m.assigned_to ? memberById[m.assigned_to] : undefined}
                      onOpen={() => setSelectedId(m.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <MissionWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        workspaceId={workspaceId}
        onSubmit={createMission}
      />
    </div>
  );
}

function KanbanCard({
  m, assignee, onOpen,
}: {
  m: Mission;
  assignee?: WorkspaceMemberRow;
  onOpen: () => void;
}) {
  const pr = PRIORITY_META[m.priority];
  const due = dueDateMeta(m.due_date);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/mission-id", m.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onOpen}
      className="cursor-grab rounded-md border border-border bg-background p-2.5 shadow-sm transition-colors hover:border-foreground/30 active:cursor-grabbing"
    >
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", pr.dot)} title={pr.label} />
        <span className="truncate text-xs font-medium">{m.title}</span>
        {m.board_column === "in_progress" && (
          <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin text-amber-500" />
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        {m.schedule && (
          <span className="inline-flex items-center gap-0.5"><Repeat className="h-2.5 w-2.5" />{m.schedule}</span>
        )}
        {due && (
          <span className={cn("inline-flex items-center gap-0.5", due.overdue && "text-destructive")}>
            <CalendarClock className="h-2.5 w-2.5" />{due.label}
          </span>
        )}
        {assignee && (
          <span className="inline-flex items-center gap-0.5">
            <UserCircle2 className="h-2.5 w-2.5" />{memberLabel(assignee)}
          </span>
        )}
      </div>
    </div>
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
  kind: "web_search" | "web_fetch" | "db_read" | "rag_search" | "edge_function" | "vault_connector" | "connector_action" | "security_scan" | "custom";
  name: string;
  description: string | null;
  config: Record<string, any>;
  enabled: boolean;
  requires_approval: boolean;
}

const TOOL_CATALOGUE: Array<{ kind: AgentTool["kind"]; label: string; icon: any; description: string }> = [
  { kind: "web_search", label: "Web search", icon: Globe, description: "Search the web for fresh information." },
  { kind: "web_fetch", label: "Fetch URL", icon: Globe, description: "Download and extract text from a URL." },
  { kind: "rag_search", label: "Knowledge search", icon: BookOpen, description: "Semantic search over the project's indexed/ingested knowledge base." },
  { kind: "edge_function", label: "Internal action", icon: Zap, description: "Invoke an internal FounderOS function (notifications, email, marketing…)." },
  { kind: "vault_connector", label: "Connector inventory", icon: KeyRound, description: "List connected integrations (provider, status — no secrets)." },
  { kind: "connector_action", label: "Integration", icon: Plug, description: "Read data from a connected integration (CRM, HR, data lake) via its official API." },
  { kind: "security_scan", label: "Security scan", icon: ShieldCheck, description: "Run a consented security scan against a registered target." },
  { kind: "custom", label: "Custom webhook tool", icon: Wrench, description: "Call an external webhook with model-provided arguments." },
];

// Curated internal connections the agent can be granted as edge_function
// tools — pre-configured slug + description, one click to add.
const EDGE_FUNCTION_CATALOGUE: Array<{ slug: string; label: string; description: string }> = [
  { slug: "send-notification", label: "Send notification", description: "Send an in-app notification to the team." },
  { slug: "send-email", label: "Send email", description: "Send a transactional email." },
  { slug: "send-bulk-email", label: "Send bulk email", description: "Send an email campaign to a list of recipients." },
  { slug: "marketing-generate", label: "Generate marketing content", description: "Draft marketing copy/visuals with the marketing engine." },
  { slug: "marketing-publish", label: "Publish marketing post", description: "Publish a post through the connected marketing channels." },
  { slug: "run-workflow", label: "Run ops workflow", description: "Trigger an automation workflow." },
  { slug: "analytics-query", label: "Analytics query", description: "Run a product-analytics query on tracked events." },
  { slug: "calculate-metrics", label: "Recompute metrics", description: "Recalculate the project metrics snapshot." },
  { slug: "daily-briefing", label: "Daily briefing", description: "Generate the project's daily briefing." },
];

function ToolsTab({ agent }: { agent: InternalAgent }) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  // Second step of the add dialog: pick a concrete connection from the catalogue.
  const [addStep, setAddStep] = useState<"kinds" | "edge_function" | "vault_connector">("kinds");
  // Provider slug whose project-level credentials we're (re)configuring.
  const [configureSlug, setConfigureSlug] = useState<string | null>(null);

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

  // Live connections of the project, surfaced in the picker + integrations section.
  const { data: connectors } = useQuery({
    queryKey: ["project_connectors_for_tools", agent.project_id],
    queryFn: async () => {
      const { data } = await supabase
        .from("connectors")
        .select("provider, status")
        .eq("project_id", agent.project_id);
      return (data ?? []) as Array<{ provider: string; status: string }>;
    },
  });
  const connectedSet = new Set((connectors ?? []).filter((c) => c.status === "connected").map((c) => c.provider));

  // Integrations = connector_action tools. Toggle one per provider slug.
  const integrationSlugs = new Set(
    (tools ?? [])
      .filter((t) => t.kind === "connector_action")
      .map((t) => String(t.config?.provider ?? "")),
  );

  async function toggleIntegration(slug: string) {
    const existing = (tools ?? []).find(
      (t) => t.kind === "connector_action" && String(t.config?.provider ?? "") === slug,
    );
    if (existing) {
      await supabase.from("internal_agent_tools").delete().eq("id", existing.id);
      queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
      return;
    }
    const p = connectorActionProvider(slug);
    const { error } = await supabase.from("internal_agent_tools").insert({
      agent_id: agent.id,
      kind: "connector_action",
      name: p ? `Use ${p.name}` : `Use ${slug}`,
      description: p?.description ?? null,
      config: { provider: slug },
      requires_approval: false,
    });
    if (error) { alert(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
    // If the integration isn't connected yet, open the config panel so the user
    // can drop in the credentials (reused project-wide afterwards).
    if (!connectedSet.has(slug)) setConfigureSlug(slug);
  }

  function closeAdd() {
    setAddOpen(false);
    setAddStep("kinds");
  }

  async function addTool(
    kind: AgentTool["kind"],
    name: string,
    overrides?: { description?: string; config?: Record<string, any> },
  ) {
    const def = TOOL_CATALOGUE.find((t) => t.kind === kind)!;
    const { error } = await supabase.from("internal_agent_tools").insert({
      agent_id: agent.id,
      kind,
      name: name || def.label,
      description: overrides?.description ?? def.description,
      config: overrides?.config ?? {},
      // Action tools start approval-gated — safe by default; owners can relax it.
      requires_approval: kind === "edge_function" || kind === "custom",
    });
    if (error) { alert(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["internal_agent_tools", agent.id] });
    closeAdd();
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
    <div className="flex flex-col">
      <div className="order-2 mt-8 flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Wrench className="h-4 w-4 text-muted-foreground" /> Generic tools</h3>
          <p className="text-xs text-muted-foreground">Capabilities not tied to a specific app — web search, knowledge, internal actions.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Add tool</Button>
      </div>
      <div className="order-2 mt-4">
        {(() => {
          const builtinTools = (tools ?? []).filter((t) => t.kind !== "connector_action");
          return builtinTools.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No tools yet. Add one to give this agent capabilities.</p>
        ) : (
          <div className="space-y-2">
            {builtinTools.map((t) => {
              const def = TOOL_CATALOGUE.find((d) => d.kind === t.kind);
              const Icon = def?.icon ?? Wrench;
              const configIssue = toolConfigIssue(t);
              return (
                <div key={t.id} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {t.name}
                          {configIssue && t.enabled && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600"
                              title={configIssue}
                            >
                              <AlertCircle className="h-2.5 w-2.5" /> Needs configuration
                            </span>
                          )}
                        </div>
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
          );
        })()}
      </div>

      {/* Integrations — connector_action data sources (CRM / HR / data lakes). */}
      <div className="order-1">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Plug className="h-4 w-4 text-muted-foreground" /> Integrations</h3>
          <p className="text-xs text-muted-foreground">
            Add an integration and the agent gets its tools. Already-connected integrations are reused — no keys to
            re-enter. Click the gear to (re)configure an integration's credentials for this project.
          </p>
        </div>
        <div className="mt-4 space-y-5">
          {CONNECTOR_ACTION_GROUPS.map((group) => (
            <div key={group.label} className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase text-muted-foreground">{group.label}</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.slugs.map((slug) => {
                  const p = connectorActionProvider(slug);
                  if (!p) return null;
                  const on = integrationSlugs.has(slug);
                  const connected = connectedSet.has(slug);
                  const Icon = p.icon;
                  return (
                    <div
                      key={slug}
                      className={cn(
                        "flex items-start gap-2.5 rounded-lg border p-2.5 transition-colors",
                        on ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30",
                      )}
                    >
                      <button onClick={() => toggleIntegration(slug)} className="flex min-w-0 flex-1 items-start gap-2.5 text-left">
                        <div className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md", on ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground")}>
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{p.name}</span>
                            {on && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                          </div>
                          <p className="line-clamp-2 text-[11px] text-muted-foreground">{p.description}</p>
                          <div className="mt-1">
                            {connected ? (
                              <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                                <ShieldCheck className="h-3 w-3" /> Connected · reused
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                                <AlertTriangle className="h-3 w-3" /> Not connected — click gear to set up
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                      <button
                        onClick={() => setConfigureSlug(slug)}
                        title={connected ? "Reconfigure credentials" : "Configure credentials"}
                        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Configure / connect an integration's project-level credentials. */}
      <ConnectorDialog
        open={!!configureSlug}
        onOpenChange={(o) => { if (!o) setConfigureSlug(null); }}
        provider={configureSlug ? findProvider(configureSlug) ?? null : null}
        workspaceId={agent.workspace_id}
        projectId={agent.project_id}
        onConnected={() => {
          setConfigureSlug(null);
          queryClient.invalidateQueries({ queryKey: ["project_connectors_for_tools", agent.project_id] });
        }}
      />

      <Dialog open={addOpen} onOpenChange={(o) => { if (!o) closeAdd(); else setAddOpen(true); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {addStep !== "kinds" && (
                <button onClick={() => setAddStep("kinds")} className="text-muted-foreground hover:text-foreground">
                  <ArrowLeft className="h-4 w-4" />
                </button>
              )}
              {addStep === "kinds" ? "Add a tool" : addStep === "edge_function" ? "Pick an internal action" : "Pick a connector"}
            </DialogTitle>
          </DialogHeader>

          {addStep === "kinds" && (
            <div className="grid grid-cols-1 gap-2">
              {/* connector_action is managed in the Integrations section below. */}
              {TOOL_CATALOGUE.filter((t) => t.kind !== "connector_action").map((t) => {
                const Icon = t.icon;
                const hasCatalogue = t.kind === "edge_function" || t.kind === "vault_connector";
                return (
                  <button
                    key={t.kind}
                    onClick={() => (hasCatalogue ? setAddStep(t.kind as "edge_function" | "vault_connector") : addTool(t.kind, t.label))}
                    className="flex items-start gap-3 rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/40"
                  >
                    <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    <div className="flex-1">
                      <div className="text-sm font-medium">{t.label}</div>
                      <div className="text-xs text-muted-foreground">{t.description}</div>
                    </div>
                    {hasCatalogue && <ChevronDown className="mt-1 h-3.5 w-3.5 -rotate-90 text-muted-foreground" />}
                  </button>
                );
              })}
            </div>
          )}

          {addStep === "edge_function" && (
            <div className="max-h-[55vh] space-y-2 overflow-y-auto">
              {EDGE_FUNCTION_CATALOGUE.map((fn) => (
                <button
                  key={fn.slug}
                  onClick={() => addTool("edge_function", fn.label, { description: fn.description, config: { slug: fn.slug } })}
                  className="flex w-full items-start gap-3 rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/40"
                >
                  <Zap className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div>
                    <div className="text-sm font-medium">{fn.label}</div>
                    <div className="text-xs text-muted-foreground">{fn.description}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">{fn.slug}</div>
                  </div>
                </button>
              ))}
              <button
                onClick={() => addTool("edge_function", "Internal action")}
                className="w-full rounded-md border border-dashed border-border p-3 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40"
              >
                Other function… (add empty, then set the slug in Configure)
              </button>
              <p className="px-1 text-[10px] text-muted-foreground">
                Added actions are approval-gated by default — the agent's calls wait for a human until you switch them to auto-execute.
              </p>
            </div>
          )}

          {addStep === "vault_connector" && (
            <div className="space-y-2">
              {(connectors ?? []).length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  No connectors on this project yet. Connect one in Integrations first.
                </p>
              ) : (
                (connectors ?? []).map((c) => (
                  <button
                    key={c.provider}
                    onClick={() =>
                      addTool("vault_connector", `Connector: ${c.provider}`, {
                        description: `Visibility on the ${c.provider} connection (status, permissions — no secrets).`,
                        config: { provider: c.provider },
                      })
                    }
                    className="flex w-full items-center gap-3 rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/40"
                  >
                    <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="flex-1">
                      <div className="text-sm font-medium capitalize">{c.provider}</div>
                      <div className="text-xs text-muted-foreground">status: {c.status}</div>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// A tool whose required config is missing is silently skipped by the worker —
// surface that in the UI so the user knows why the agent can't use it.
function toolConfigIssue(t: AgentTool): string | null {
  if (t.kind === "db_read") {
    const tables = Array.isArray(t.config?.tables) ? t.config.tables : [];
    if (tables.length === 0) return "No tables allowed yet — the agent can't read anything. Configure the table allowlist.";
  }
  if (t.kind === "edge_function" && !/^[a-z0-9-]+$/.test(String(t.config?.slug ?? ""))) {
    return "No function slug configured — the worker skips this tool. Set the slug.";
  }
  if (t.kind === "custom" && !/^https?:\/\//.test(String(t.config?.webhook_url ?? ""))) {
    return "No webhook URL configured — the worker skips this tool. Set the URL.";
  }
  return null;
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
// MEMORY TAB — the agent's persistent cross-session knowledge store
// ============================================================================

const MEMORY_KINDS: MemoryKind[] = ["fact", "preference", "learning", "context"];

function MemoryTab({ agent }: { agent: InternalAgent }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [kindFilter, setKindFilter] = useState<MemoryKind | "all">("all");
  const [search, setSearch] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newKind, setNewKind] = useState<MemoryKind>("fact");
  const [newImportance, setNewImportance] = useState(3);
  const [adding, setAdding] = useState(false);

  const { data: memories } = useQuery({
    queryKey: ["internal_agent_memories", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_memories")
        .select("*")
        .eq("agent_id", agent.id)
        .order("is_pinned", { ascending: false })
        .order("importance", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(300);
      return (data ?? []) as AgentMemory[];
    },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["internal_agent_memories", agent.id] });

  async function addMemory() {
    const content = newContent.trim();
    if (!content || !user) return;
    setAdding(true);
    try {
      const { error } = await supabase.from("internal_agent_memories").insert({
        agent_id: agent.id,
        workspace_id: agent.workspace_id,
        project_id: agent.project_id,
        kind: newKind,
        content: content.slice(0, 600),
        importance: newImportance,
        source: "user",
        created_by: user.id,
      });
      if (error) { alert(error.message); return; }
      setNewContent("");
      invalidate();
    } finally {
      setAdding(false);
    }
  }

  async function togglePin(m: AgentMemory) {
    await supabase
      .from("internal_agent_memories")
      .update({ is_pinned: !m.is_pinned, updated_at: new Date().toISOString() })
      .eq("id", m.id);
    invalidate();
  }

  async function removeMemory(id: string) {
    if (!confirm("Forget this memory? The agent will no longer see it.")) return;
    await supabase.from("internal_agent_memories").delete().eq("id", id);
    invalidate();
  }

  const visible = (memories ?? []).filter((m) => {
    if (kindFilter !== "all" && m.kind !== kindFilter) return false;
    if (search && !m.content.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const pinnedCount = (memories ?? []).filter((m) => m.is_pinned).length;

  return (
    <div className="space-y-4">
      {/* Header — the memory wall is the agent's own knowledge store. */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Brain className="h-4 w-4 text-muted-foreground" /> Memory
            <Badge variant="outline" className="text-[10px]">{memories?.length ?? 0} / 300</Badge>
            {pinnedCount > 0 && <Badge className="bg-amber-500/15 text-[10px] text-amber-600">{pinnedCount} pinned</Badge>}
          </h2>
          <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">
            Durable knowledge {agent.name} builds itself as it works (save_memory) and carries into every session.
            Pinned cards are always injected into its prompt. You can add or forget cards too.
          </p>
        </div>
      </div>

      {/* Add a memory card */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addMemory(); }}
          placeholder="Teach the agent something durable… (e.g. 'Our ICP is B2B agencies of 5-50 people')"
          className="h-8 min-w-[260px] flex-1 text-sm"
        />
        <select
          value={newKind}
          onChange={(e) => setNewKind(e.target.value as MemoryKind)}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
        >
          {MEMORY_KINDS.map((k) => (
            <option key={k} value={k}>{MEMORY_KIND_META[k].emoji} {MEMORY_KIND_META[k].label}</option>
          ))}
        </select>
        <select
          value={newImportance}
          onChange={(e) => setNewImportance(Number(e.target.value))}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          title="Importance (drives prompt priority)"
        >
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>★ {n}</option>)}
        </select>
        <Button size="sm" onClick={addMemory} disabled={adding || !newContent.trim()}>
          {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          <span className="ml-1">Add</span>
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {(["all", ...MEMORY_KINDS] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKindFilter(k as MemoryKind | "all")}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] capitalize transition-colors",
                kindFilter === k ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:bg-foreground/5",
              )}
            >
              {k}
            </button>
          ))}
        </div>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search memories…"
          className="h-7 max-w-[200px] text-xs"
        />
      </div>

      {/* Card grid */}
      {visible.length === 0 ? (
        <EmptyState
          icon={Brain}
          title={memories && memories.length > 0 ? "No memories match the filters" : "No memories yet"}
          description={
            memories && memories.length > 0
              ? "Try a different filter or search term."
              : "The agent saves memories as it works, or you can add one above."
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((m) => (
            <MemoryCard
              key={m.id}
              m={m}
              onTogglePin={() => togglePin(m)}
              onRemove={() => removeMemory(m.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// A single memory the agent built (or the team added), shown as a card.
function MemoryCard({
  m, onTogglePin, onRemove,
}: {
  m: AgentMemory;
  onTogglePin: () => void;
  onRemove: () => void;
}) {
  const meta = MEMORY_KIND_META[m.kind];
  return (
    <div
      className={cn(
        "group relative flex flex-col rounded-xl border bg-card/40 p-3 transition-colors hover:border-foreground/30",
        m.is_pinned ? "border-amber-500/40 ring-1 ring-amber-500/20" : "border-border",
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium", meta.cls)}>
          {meta.emoji} {meta.label}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {m.is_pinned && <Pin className="h-3 w-3 text-amber-500 group-hover:hidden" />}
          <button
            onClick={onTogglePin}
            title={m.is_pinned ? "Unpin" : "Pin (always in prompt)"}
            className="opacity-0 transition-opacity group-hover:opacity-100"
          >
            {m.is_pinned
              ? <PinOff className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
              : <Pin className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />}
          </button>
          <button
            onClick={onRemove}
            title="Forget"
            className="opacity-0 transition-opacity group-hover:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </button>
        </div>
      </div>
      <p className="flex-1 text-sm leading-relaxed">{m.content}</p>
      <div className="mt-3 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span title="Importance" className="text-amber-500">{"★".repeat(m.importance)}</span>
        <span className="inline-flex items-center gap-1">
          {m.source === "agent" ? <><Bot className="h-2.5 w-2.5" /> saved by agent</> : <><UserCircle2 className="h-2.5 w-2.5" /> added by team</>}
        </span>
        <span className="ml-auto">{relativeDate(m.updated_at)}</span>
      </div>
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
    <div className="space-y-1">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><UsersIcon className="h-4 w-4 text-muted-foreground" /> Members</h3>
      <p className="text-xs text-muted-foreground">Who on your team can see and use this agent.</p>

      <div className="grid gap-6 pt-3 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-[11px] font-medium uppercase text-muted-foreground">Members with access</div>
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
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
              <div key={m.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
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
        </div>

        {isOwner && (
          <div>
            <div className="mb-2 text-[11px] font-medium uppercase text-muted-foreground">Invite from workspace</div>
            {!candidates || candidates.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No more members to add.</p>
            ) : (
              <div className="space-y-2">
                {candidates.map((c) => (
                  <div key={c.user_id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
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
          </div>
        )}
      </div>
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
  // Collaboration profile.
  const [role, setRole] = useState(agent.role ?? "");
  const [skills, setSkills] = useState<string[]>(agent.skills ?? []);
  const [skillInput, setSkillInput] = useState("");
  const [collabEnabled, setCollabEnabled] = useState(agent.collaboration_enabled ?? true);
  const [sandboxMode, setSandboxMode] = useState<"cloud" | "sandbox">(agent.sandbox_mode ?? "cloud");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [section, setSection] = useState<SettingsSectionKey>("general");

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
          role: role.trim() || null,
          skills,
          collaboration_enabled: collabEnabled,
          sandbox_mode: sandboxMode,
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
    <div className="mx-auto max-w-4xl">
      {/* Header + Save — flush on the background. */}
      <div className="flex items-center justify-between pb-3">
        <h2 className="text-lg font-semibold">Settings</h2>
        <div className="flex items-center gap-2">
          {savedAt && Date.now() - savedAt < 4000 && (
            <span className="text-xs text-muted-foreground"><Check className="mr-1 inline h-3 w-3" /> Saved</span>
          )}
          {section !== "tools" && section !== "members" && section !== "danger" && (
            <Button size="sm" onClick={save} disabled={saving || !isOwner}>
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
              <span className="ml-1">Save</span>
            </Button>
          )}
        </div>
      </div>

      {/* Sub-tab bar */}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {SETTINGS_SECTIONS.filter((s) => s.key !== "danger" || isOwner).map((s) => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
              section === s.key
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
              s.key === "danger" && "text-destructive hover:text-destructive",
            )}
          >
            <s.icon className="h-3.5 w-3.5" /> {s.label}
          </button>
        ))}
      </div>

      {/* General */}
      {section === "general" && (
      <SettingsSection>
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
              <option value="deepseek">DeepSeek</option>
              <option value="groq">Groq (Llama 3.1)</option>
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
              className="mt-2 w-full"
            />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <ToggleRow
            icon={MessageSquare} label="Chat mode"
            checked={chatEnabled} onChange={setChatEnabled} disabled={!isOwner}
          />
          <ToggleRow
            icon={Target} label="Mission mode"
            checked={missionEnabled} onChange={setMissionEnabled} disabled={!isOwner}
          />
        </div>
      </SettingsSection>
      )}

      {/* Autonomy budget */}
      {section === "autonomy" && (
      <SettingsSection
        title="Autonomy budget" icon={Gauge}
        description="Hard limits applied to every run. The agent stops when it reaches the step budget; runs exceeding the cost budget are flagged in the timeline."
      >
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
      </SettingsSection>
      )}

      {/* Infrastructure — sandbox mode */}
      {section === "infrastructure" && (
      <SettingsSection
        title="Execution Environment" icon={Database}
        description="Choose how this agent runs its missions. Cloud mode uses serverless edge functions (fast, stateless). Sandbox mode gives the agent a dedicated Docker container with terminal, browser, filesystem, and code execution."
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setSandboxMode("cloud")}
              className={cn("rounded-xl border p-4 text-left transition-all",
                sandboxMode === "cloud" ? "border-primary ring-1 ring-primary/30 bg-primary/5" : "border-border hover:border-primary/40")}>
              <div className="flex items-center gap-2 mb-2">
                <Zap className="h-4 w-4 text-amber-500" />
                <span className="text-sm font-semibold">Cloud</span>
                {sandboxMode === "cloud" && <Badge variant="outline" className="text-[9px] py-0 ml-auto">Active</Badge>}
              </div>
              <p className="text-[11px] text-muted-foreground">Serverless edge functions. Fast cold start, stateless, pay-per-use. Best for chat, research, and simple missions.</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">web_search</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">deep_research</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">db_read</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">browse_web</span>
              </div>
            </button>

            <button onClick={() => setSandboxMode("sandbox")}
              className={cn("rounded-xl border p-4 text-left transition-all",
                sandboxMode === "sandbox" ? "border-primary ring-1 ring-primary/30 bg-primary/5" : "border-border hover:border-primary/40")}>
              <div className="flex items-center gap-2 mb-2">
                <TerminalSquare className="h-4 w-4 text-emerald-500" />
                <span className="text-sm font-semibold">Sandbox</span>
                {sandboxMode === "sandbox" && <Badge variant="outline" className="text-[9px] py-0 ml-auto">Active</Badge>}
              </div>
              <p className="text-[11px] text-muted-foreground">Dedicated Docker container with terminal, browser, filesystem, VSCode, Jupyter. Persistent between steps. Best for code, analysis, testing.</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">execute_code</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">file_read/write</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">browser</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">terminal</span>
                <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">jupyter</span>
              </div>
            </button>
          </div>

          {sandboxMode === "sandbox" && (
            <div className="rounded-lg border border-border bg-secondary/20 p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                <span className="font-medium">Sandbox requires Docker running on the runner host.</span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                The runner will spin up an AIO Sandbox container (ghcr.io/agent-infra/sandbox) for each mission.
                The container provides a full Linux environment with Python, Node.js, shell, browser, and file access.
                It is destroyed after the mission completes.
              </p>
              {agent.sandbox_url && (
                <div className="flex items-center gap-2 text-xs">
                  <Globe className="h-3 w-3 text-muted-foreground" />
                  <span className="font-mono text-[10px] text-muted-foreground">{agent.sandbox_url}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </SettingsSection>
      )}

      {/* Collaboration profile */}
      {section === "collaboration" && (
      <SettingsSection
        title="Collaboration" icon={Network}
        description="Role and skills help teammate agents decide when to message or delegate to this one."
      >
        <ToggleRow
          icon={Network}
          label="Allow this agent to collaborate with other agents (message, delegate, share knowledge)"
          checked={collabEnabled} onChange={setCollabEnabled} disabled={!isOwner}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Role</label>
            <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Research analyst" disabled={!isOwner} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Skills</label>
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5">
              {skills.map((s) => (
                <span key={s} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
                  {s}
                  {isOwner && <button onClick={() => setSkills(skills.filter((x) => x !== s))} className="text-muted-foreground hover:text-foreground">×</button>}
                </span>
              ))}
              {isOwner && (
                <input
                  value={skillInput}
                  onChange={(e) => setSkillInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const s = skillInput.trim().toLowerCase();
                      if (s && !skills.includes(s)) setSkills([...skills, s]);
                      setSkillInput("");
                    }
                  }}
                  placeholder="add skill…"
                  className="min-w-[80px] flex-1 bg-transparent text-xs focus:outline-none"
                />
              )}
            </div>
          </div>
        </div>
      </SettingsSection>
      )}

      {/* Tools — merged in from the former Tools tab. */}
      {section === "tools" && (
        <div className="py-6">
          <ToolsTab agent={agent} />
        </div>
      )}

      {/* Members — merged in from the former Members tab. */}
      {section === "members" && (
        <div className="py-6">
          <MembersTab agent={agent} />
        </div>
      )}

      {/* Danger zone */}
      {section === "danger" && isOwner && (
        <SettingsSection title="Danger zone" icon={Trash2} titleClassName="text-destructive"
          description="Archiving removes the agent from your team. You can restore it later from the database.">
          <Button variant="outline" onClick={archive} className="text-destructive">
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Archive agent
          </Button>
        </SettingsSection>
      )}
    </div>
  );
}

type SettingsSectionKey = "general" | "autonomy" | "infrastructure" | "collaboration" | "tools" | "members" | "danger";

const SETTINGS_SECTIONS: { key: SettingsSectionKey; label: string; icon: any }[] = [
  { key: "general", label: "General", icon: SettingsIcon },
  { key: "autonomy", label: "Autonomy", icon: Gauge },
  { key: "infrastructure", label: "Infrastructure", icon: Database },
  { key: "collaboration", label: "Collaboration", icon: Network },
  { key: "tools", label: "Tools & integrations", icon: Wrench },
  { key: "members", label: "Members", icon: UsersIcon },
  { key: "danger", label: "Danger zone", icon: Trash2 },
];

// A section of settings laid directly on the page background (no card). Optional
// title + description sit above the content.
function SettingsSection({
  title, icon: Icon, description, titleClassName, children,
}: {
  title?: string;
  icon?: any;
  description?: string;
  titleClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-5 py-6">
      {(title || description) && (
        <div className="space-y-1">
          {title && (
            <h3 className={cn("flex items-center gap-2 text-sm font-semibold", titleClassName)}>
              {Icon && <Icon className="h-4 w-4 text-muted-foreground" />} {title}
            </h3>
          )}
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

// A borderless checkbox row used inside settings sections.
function ToggleRow({
  icon: Icon, label, checked, onChange, disabled,
}: {
  icon?: any;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="h-4 w-4 accent-primary"
      />
      {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      {label}
    </label>
  );
}

// ============================================================================
// COLLABORATION TAB — this agent's inter-agent (A2A) messages + peers
// ============================================================================

function CollaborationTab({ agent }: { agent: InternalAgent }) {
  const { data: peers } = useQuery({
    queryKey: ["agent_peers", agent.project_id, agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents")
        .select("id, name, avatar_emoji, role, skills")
        .eq("project_id", agent.project_id)
        .eq("is_archived", false)
        .eq("collaboration_enabled", true)
        .neq("id", agent.id);
      return (data ?? []) as Array<{ id: string; name: string; avatar_emoji: string | null; role: string | null; skills: string[] }>;
    },
  });

  const { data: messages } = useQuery({
    queryKey: ["agent_a2a", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_a2a_messages")
        .select("id, thread_id, from_agent, to_agent, content, status, reply_to, created_at")
        .or(`from_agent.eq.${agent.id},to_agent.eq.${agent.id}`)
        .order("created_at", { ascending: false })
        .limit(50);
      return (data ?? []) as A2AMessage[];
    },
    refetchInterval: 5000,
  });

  const peerName = (id: string) =>
    id === agent.id ? agent.name : (peers ?? []).find((p) => p.id === id)?.name ?? id.slice(0, 6);

  if (!agent.collaboration_enabled) {
    return (
      <EmptyState
        icon={Network}
        title="Collaboration is disabled"
        description="Enable collaboration in Settings so this agent can message, delegate to and learn from teammate agents."
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <Card className="flex max-h-[calc(100vh-14rem)] flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm"><MessagesSquare className="h-4 w-4" /> Agent-to-agent messages</CardTitle>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto">
          {!messages || messages.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No messages yet. This agent will message or delegate to peers autonomously when a task fits their skills.
            </p>
          ) : (
            <div className="space-y-2">
              {messages.map((m) => {
                const outgoing = m.from_agent === agent.id;
                return (
                  <div key={m.id} className={cn("rounded-md border p-2.5", outgoing ? "border-primary/30 bg-primary/5" : "border-border")}>
                    <div className="mb-1 flex items-center gap-1.5 text-xs">
                      <span className="font-medium">{peerName(m.from_agent)}</span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <span className="font-medium">{peerName(m.to_agent)}</span>
                      <Badge variant="outline" className="ml-auto text-[10px]">{m.status}</Badge>
                      <span className="text-[10px] text-muted-foreground">{relativeDate(m.created_at)}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-xs leading-relaxed">{m.content}</p>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Teammates</CardTitle></CardHeader>
        <CardContent>
          {!peers || peers.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">No other collaborating agents on this project.</p>
          ) : (
            <div className="space-y-2">
              {peers.map((p) => (
                <div key={p.id} className="rounded-md border border-border p-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-base">{p.avatar_emoji ?? "🤖"}</span>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{p.name}</div>
                      {p.role && <div className="truncate text-[10px] text-muted-foreground">{p.role}</div>}
                    </div>
                  </div>
                  {p.skills?.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {p.skills.slice(0, 5).map((s) => <Badge key={s} variant="outline" className="text-[9px]">{s}</Badge>)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Skills tab: toggle skills on/off per agent ──────────────────────────────
type SkillRow = { id: string; name: string; slug: string; description: string | null; category: string | null; icon: string; required_tools: string[]; config: any; is_system: boolean; system_prompt_extension: string | null };

function SkillsTab({ agentId }: { agentId: string }) {
  const { workspaceId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<SkillRow | null>(null);

  const { data: allSkills } = useQuery({
    queryKey: ["agent_skills_all"],
    queryFn: async () => {
      const { data } = await supabase.from("agent_skills").select("*")
        .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`).order("category, name");
      return (data ?? []) as SkillRow[];
    },
  });

  const { data: activations } = useQuery({
    queryKey: ["agent_skill_activations", agentId],
    queryFn: async () => {
      const { data } = await supabase.from("agent_skill_activations").select("skill_id").eq("agent_id", agentId);
      return new Set((data ?? []).map((a: any) => a.skill_id));
    },
  });

  const activeSet = activations ?? new Set<string>();

  async function toggle(skillId: string) {
    if (activeSet.has(skillId)) {
      await supabase.from("agent_skill_activations").delete().eq("agent_id", agentId).eq("skill_id", skillId);
    } else {
      await supabase.from("agent_skill_activations").insert({ agent_id: agentId, skill_id: skillId });
    }
    queryClient.invalidateQueries({ queryKey: ["agent_skill_activations", agentId] });
  }

  const skillsList = allSkills ?? [];
  const categories = [...new Set(skillsList.map((s) => s.category || "other"))];
  const currentCat = activeCat ?? categories[0] ?? "other";

  const filtered = skillsList.filter((s) => {
    if ((s.category || "other") !== currentCat) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q) || s.slug.includes(q);
    }
    return true;
  });

  const activatedCount = skillsList.filter((s) => activeSet.has(s.id)).length;
  const tags = (s: SkillRow) => Array.isArray(s.config?.tags) ? s.config.tags as string[] : [];

  const CAT_LABELS: Record<string, string> = {
    cybersecurity: "Cybersecurity", "data-analytics": "Data Analytics", general: "General",
    research: "Research", browser: "Browser", code: "Code", data: "Data",
    communication: "Communication", security: "Security", hr: "HR", other: "Other",
  };

  const CAT_COLORS: Record<string, string> = {
    cybersecurity: "#ef4444", "data-analytics": "#3b82f6", general: "#8b5cf6",
    research: "#10b981", browser: "#f59e0b", code: "#6366f1", data: "#0ea5e9",
    communication: "#ec4899", security: "#dc2626", hr: "#14b8a6", other: "#6b7280",
  };

  return (
    <div className="flex h-full">
      {/* ── Main: tabs + grid ── */}
      <div className="flex min-w-0 flex-1 flex-col px-6 py-4 lg:px-10">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold">Agent Skills</h3>
            <p className="text-xs text-muted-foreground">{activatedCount} active · {skillsList.length} available</p>
          </div>
          <div className="relative w-56">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search skills…" className="h-8 pl-8 text-xs" />
          </div>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto border-b border-border mb-3 pb-px">
          {categories.map((cat) => {
            const count = skillsList.filter((s) => (s.category || "other") === cat).length;
            const activeInCat = skillsList.filter((s) => (s.category || "other") === cat && activeSet.has(s.id)).length;
            return (
              <button key={cat} onClick={() => { setActiveCat(cat); setSelected(null); }}
                className={cn("flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-xs transition-colors",
                  cat === currentCat ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
                {CAT_LABELS[cat] ?? cat}
                <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[9px] tabular-nums">{count}</span>
                {activeInCat > 0 && <span className="rounded-full bg-primary/20 text-primary px-1.5 py-0.5 text-[9px] tabular-nums">{activeInCat}</span>}
              </button>
            );
          })}
        </div>

        {/* Card grid */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {filtered.length === 0 && <p className="py-8 text-center text-xs text-muted-foreground">No skills found{search ? ` for "${search}"` : ""}.</p>}
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((s) => {
              const isActive = activeSet.has(s.id);
              const isSelected = selected?.id === s.id;
              const color = CAT_COLORS[s.category || "other"] ?? "#6b7280";
              return (
                <div key={s.id} onClick={() => setSelected(s)}
                  className={cn("group cursor-pointer rounded-xl border p-3 transition-all hover:-translate-y-0.5 hover:shadow-md",
                    isSelected ? "border-primary ring-1 ring-primary/30" : isActive ? "border-primary/40 bg-primary/5" : "border-border")}>
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="text-xs font-semibold leading-tight line-clamp-2 flex-1">{s.name}</h4>
                    <button onClick={(e) => { e.stopPropagation(); toggle(s.id); }}
                      className={cn("flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors", isActive ? "bg-primary" : "bg-secondary")}>
                      <span className={cn("block h-4 w-4 rounded-full bg-white transition-transform", isActive && "translate-x-4")} />
                    </button>
                  </div>
                  {s.description && <p className="mt-1 text-[10px] text-muted-foreground line-clamp-2">{s.description}</p>}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {tags(s).slice(0, 3).map((t) => (
                      <span key={t} className="rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">{t}</span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Right sidebar overlay: skill detail ── */}
      {selected && (
        <>
        <div className="fixed inset-0 z-50 bg-black/30" onClick={() => setSelected(null)} />
        <aside className="fixed inset-y-0 right-0 z-50 flex w-96 flex-col border-l border-border bg-card shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold truncate">{selected.name}</h3>
            <button onClick={() => setSelected(null)} className="rounded p-1 text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 px-4 py-4 space-y-4">
            {/* Toggle */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">{activeSet.has(selected.id) ? "Active" : "Inactive"}</span>
              <button onClick={() => toggle(selected.id)}
                className={cn("flex h-6 w-11 items-center rounded-full p-0.5 transition-colors", activeSet.has(selected.id) ? "bg-primary" : "bg-secondary")}>
                <span className={cn("block h-5 w-5 rounded-full bg-white transition-transform", activeSet.has(selected.id) && "translate-x-5")} />
              </button>
            </div>

            {/* Description */}
            {selected.description && (
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Description</div>
                <p className="text-xs text-foreground/80 leading-relaxed">{selected.description}</p>
              </div>
            )}

            {/* Tags */}
            {tags(selected).length > 0 && (
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tags</div>
                <div className="flex flex-wrap gap-1">
                  {tags(selected).map((t) => (
                    <span key={t} className="rounded-md bg-secondary px-2 py-0.5 text-[10px] text-foreground/70">{t}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Required tools */}
            <div>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Required Tools</div>
              <div className="space-y-1">
                {(selected.required_tools ?? []).map((t) => (
                  <div key={t} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
                    <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs font-mono">{t}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Scripts */}
            {Array.isArray(selected.config?.scripts) && selected.config.scripts.length > 0 && (
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Scripts ({selected.config.scripts.length})</div>
                <div className="space-y-1.5">
                  {selected.config.scripts.map((sc: any, i: number) => (
                    <details key={i} className="rounded-md border border-border">
                      <summary className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-secondary/30">
                        <FileCode className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="font-mono">{sc.name}</span>
                      </summary>
                      <pre className="bg-zinc-950 px-3 py-2 text-[10px] text-zinc-300 font-mono overflow-x-auto max-h-48 overflow-y-auto">{sc.content}</pre>
                    </details>
                  ))}
                </div>
              </div>
            )}

            {/* References */}
            {Array.isArray(selected.config?.references) && selected.config.references.length > 0 && (
              <div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">References ({selected.config.references.length})</div>
                <div className="space-y-1.5">
                  {selected.config.references.map((ref: any, i: number) => (
                    <details key={i} className="rounded-md border border-border">
                      <summary className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-secondary/30">
                        <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span>{ref.name}</span>
                      </summary>
                      <div className="px-3 py-2 text-[10px] text-muted-foreground whitespace-pre-wrap max-h-48 overflow-y-auto">{ref.content}</div>
                    </details>
                  ))}
                </div>
              </div>
            )}

            {/* System prompt extension */}
            {selected.system_prompt_extension && (
              <details className="rounded-md border border-border">
                <summary className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer hover:bg-secondary/30">
                  <Brain className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Prompt Extension</span>
                </summary>
                <div className="px-3 py-2 text-[10px] text-muted-foreground whitespace-pre-wrap max-h-64 overflow-y-auto">{selected.system_prompt_extension}</div>
              </details>
            )}

            {/* Metadata */}
            <div className="border-t border-border pt-3 space-y-1 text-[10px] text-muted-foreground">
              <div>Slug: <span className="font-mono text-foreground/70">{selected.slug}</span></div>
              <div>Category: <span className="text-foreground/70">{CAT_LABELS[selected.category || "other"] ?? selected.category}</span></div>
              {selected.is_system && <div className="text-primary font-medium">System skill</div>}
            </div>
          </div>
        </aside>
        </>
      )}
    </div>
  );
}

// ── Agent Artifacts tab: live run activity + deliverables ────────────────────
function AgentArtifactsTab({ agentId }: { agentId: string }) {
  const { projectId } = useCurrentContext();

  const { data } = useQuery({
    queryKey: ["agent_artifacts_runs", agentId],
    enabled: !!agentId,
    queryFn: async () => {
      const { data: runs } = await supabase.from("internal_agent_runs")
        .select("id, mission_id, status, created_at, finished_at")
        .eq("agent_id", agentId).order("created_at", { ascending: false }).limit(10);
      const runIds = (runs ?? []).map((r: any) => r.id);
      const { data: events } = runIds.length
        ? await supabase.from("internal_agent_run_events")
            .select("id, run_id, kind, summary, created_at")
            .in("run_id", runIds).order("created_at", { ascending: true }).limit(100)
        : { data: [] };
      const { data: deliverables } = await supabase.from("internal_agent_deliverables")
        .select("id, run_id, kind, title, body, created_at")
        .eq("agent_id", agentId).order("created_at", { ascending: false }).limit(20);
      return { runs: runs ?? [], events: events ?? [], deliverables: deliverables ?? [] };
    },
    refetchInterval: 5000,
  });

  const runs = data?.runs ?? [];
  const events = data?.events ?? [];
  const deliverables = data?.deliverables ?? [];

  const planningCards = runs.slice(0, 5).map((run: any) => {
    const runEvents = events.filter((e: any) => e.run_id === run.id);
    const steps: PlanStep[] = runEvents.map((ev: any, i: number): PlanStep => ({
      id: ev.id,
      title: ev.summary || ev.kind,
      status: i === runEvents.length - 1 && run.status === "running" ? "active" :
              ev.kind === "error" ? "error" : "success",
      duration: new Date(ev.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    }));
    if (run.status === "running" && steps.length === 0) {
      steps.push({ id: "init", title: "Initializing…", status: "active" });
    }
    return { runId: run.id, status: run.status, steps };
  });

  return (
    <div className="space-y-6 px-6 py-6 lg:px-10">
      <h3 className="text-sm font-semibold">Agent Activity & Artifacts</h3>

      {/* Live runs */}
      {planningCards.filter((r) => r.status === "running").map((r) => (
        <AgentPlanning key={r.runId} title="Agent is working" steps={r.steps} />
      ))}

      {/* Recent completed runs */}
      {planningCards.filter((r) => r.status !== "running").slice(0, 3).map((r) => (
        <AgentPlanning key={r.runId} title={`Run ${r.status}`} steps={r.steps} />
      ))}

      {/* Deliverables */}
      {deliverables.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Deliverables</h4>
          <div className="space-y-1.5">
            {deliverables.map((d: any) => (
              <div key={d.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{d.title}</span>
                  <Badge variant="outline" className="text-[9px]">{d.kind}</Badge>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {new Date(d.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                {d.body && <p className="mt-1.5 text-xs text-muted-foreground line-clamp-3">{d.body}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {runs.length === 0 && deliverables.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">No activity yet. Assign a mission to this agent to see its work here.</p>
      )}
    </div>
  );
}

// Re-export tab metadata so the sidebar can show the same labels/icons.
export const INTERNAL_AGENT_TABS: { slug: InternalAgentTab; label: string; icon: any }[] = [
  { slug: "chat", label: "Chat", icon: MessageSquare },
  { slug: "mission", label: "Missions", icon: Target },
  { slug: "deliverables", label: "Deliverables", icon: Package },
  { slug: "artifacts", label: "Artifacts", icon: Package },
  { slug: "skills", label: "Skills", icon: Zap },
  { slug: "memory", label: "Memory", icon: Brain },
  { slug: "collaboration", label: "Collaboration", icon: Network },
  { slug: "instructions", label: "Instructions", icon: FileText },
  { slug: "analytics", label: "Analytics", icon: BarChart3 },
  { slug: "settings", label: "Settings", icon: SettingsIcon },
];
