import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Globe, Loader2, Eye, XCircle, Send, MonitorPlay, Play, ChevronRight,
  Bot, User as UserIcon, CircleDot,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { RUN_TONE, type RunStatus, type TestCase, type TestSuite } from "./TestingPage";

const TERMINAL: RunStatus[] = ["passed", "failed", "error", "cancelled"];

interface TestRun {
  id: string;
  case_id: string;
  app_url: string;
  status: RunStatus;
  pending_question: string | null;
  last_screenshot_url: string | null;
  current_url: string | null;
  error_message: string | null;
  created_at: string;
}
interface RunStep {
  id: string;
  idx: number;
  actor: "agent" | "runner" | "user" | "system";
  kind: string;
  label: string | null;
  payload: Record<string, unknown>;
  status?: string;
  created_at: string;
}

export function LiveTab({
  runId, onSelectRun, onCreateInTests,
}: { runId: string | null; onSelectRun: (id: string) => void; onCreateInTests: () => void }) {
  if (!runId) {
    return <StartScreen onSelectRun={onSelectRun} onCreateInTests={onCreateInTests} />;
  }
  return <LiveRun runId={runId} />;
}

// ── Empty state: pick a test to start, or open a recent run ──────────────────
function StartScreen({
  onSelectRun, onCreateInTests,
}: { onSelectRun: (id: string) => void; onCreateInTests: () => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState<string | null>(null);

  const cases = useQuery({
    queryKey: ["test_cases", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("test_cases").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as TestCase[];
    },
  });
  const suites = useQuery({
    queryKey: ["test_suites", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("test_suites").select("id, name, app_url").eq("project_id", projectId!);
      return (data ?? []) as Pick<TestSuite, "id" | "name" | "app_url">[];
    },
  });
  const recent = useQuery({
    queryKey: ["test_runs_recent", projectId],
    enabled: !!projectId,
    refetchInterval: 5000,
    queryFn: async () => {
      const { data } = await supabase
        .from("test_runs").select("id, status, app_url, created_at, case_id")
        .eq("project_id", projectId!).order("created_at", { ascending: false }).limit(8);
      return (data ?? []) as TestRun[];
    },
  });

  const suiteName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of suites.data ?? []) m[s.id] = s.name;
    return m;
  }, [suites.data]);

  async function start(tc: TestCase) {
    if (!workspaceId || !projectId) return;
    setStarting(tc.id);
    try {
      const res = await callEdge<{ run_id: string }>("test-run-orchestrate", {
        workspace_id: workspaceId, project_id: projectId, case_id: tc.id, action: "start",
      });
      queryClient.invalidateQueries({ queryKey: ["test_runs_recent", projectId] });
      onSelectRun(res.run_id);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setStarting(null); }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col items-center justify-center gap-8 px-6 py-10">
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <MonitorPlay className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-semibold">Start a test</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Launch a test to watch the agent drive your app live, and steer it from the chat.
        </p>
      </div>

      {(cases.data ?? []).length === 0 ? (
        <div className="text-center">
          <p className="mb-3 text-sm text-muted-foreground">No tests yet.</p>
          <Button onClick={onCreateInTests}><Play className="h-4 w-4" /> Create your first test</Button>
        </div>
      ) : (
        <div className="w-full space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Run a test</div>
          {(cases.data ?? []).slice(0, 6).map((tc) => (
            <div key={tc.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{tc.name}</div>
                <div className="truncate text-xs text-muted-foreground">{suiteName[tc.suite_id] ?? ""}</div>
              </div>
              <Button size="sm" disabled={starting === tc.id} onClick={() => start(tc)}>
                {starting === tc.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Run
              </Button>
            </div>
          ))}
        </div>
      )}

      {(recent.data ?? []).length > 0 && (
        <div className="w-full space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent runs</div>
          {(recent.data ?? []).map((r) => {
            const tone = RUN_TONE[r.status];
            return (
              <button
                key={r.id} onClick={() => onSelectRun(r.id)}
                className="flex w-full items-center gap-3 rounded-lg border border-border p-2.5 text-left hover:bg-secondary"
              >
                <Badge variant={tone.variant}>{tone.label}</Badge>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{r.app_url}</span>
                <span className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── The live run: app preview fixed left, agent chat full-height right ───────
function LiveRun({ runId }: { runId: string }) {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  const run = useQuery({
    queryKey: ["test_run", runId],
    enabled: !!runId,
    refetchInterval: (q) => {
      const s = (q.state.data as TestRun | undefined)?.status;
      return s && TERMINAL.includes(s) ? false : 1500;
    },
    queryFn: async () => {
      const { data } = await supabase.from("test_runs").select("*").eq("id", runId).maybeSingle();
      return data as TestRun | null;
    },
  });

  const steps = useQuery({
    queryKey: ["test_run_steps", runId],
    enabled: !!runId,
    refetchInterval: () => (run.data && TERMINAL.includes(run.data.status) ? false : 1500),
    queryFn: async () => {
      const { data } = await supabase
        .from("test_run_steps").select("*").eq("run_id", runId).order("idx", { ascending: true });
      return (data ?? []) as RunStep[];
    },
  });

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [steps.data?.length, run.data?.status]);

  const r = run.data;
  const tone = r ? RUN_TONE[r.status] : null;
  const live = r && !TERMINAL.includes(r.status);

  // One input box: when the run is paused it answers the question; otherwise it
  // sends a live directive the agent will follow on its next step.
  async function send() {
    const text = message.trim();
    if (!text || !workspaceId || !projectId) return;
    setSending(true);
    try {
      await callEdge("test-run-orchestrate", {
        workspace_id: workspaceId, project_id: projectId, run_id: runId,
        action: r?.status === "needs_input" ? "answer" : "directive",
        answer: text, directive: text,
      });
      setMessage("");
      queryClient.invalidateQueries({ queryKey: ["test_run", runId] });
      queryClient.invalidateQueries({ queryKey: ["test_run_steps", runId] });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally { setSending(false); }
  }

  async function cancelRun() {
    await supabase.from("test_runs").update({ status: "cancelled" }).eq("id", runId);
    queryClient.invalidateQueries({ queryKey: ["test_run", runId] });
  }

  return (
    <div className="flex h-full min-h-0">
      {/* LEFT: app preview, fixed (does not scroll with chat). */}
      <div className="flex min-w-0 flex-1 flex-col bg-black/20">
        <div className="flex items-center gap-3 border-b border-border px-4 py-2">
          {tone && <Badge variant={tone.variant}>{tone.label}</Badge>}
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Globe className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{r?.current_url ?? r?.app_url ?? "—"}</span>
          </div>
          {live && (
            <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground hover:text-destructive" onClick={cancelRun}>
              <XCircle className="h-4 w-4" /> Cancel
            </Button>
          )}
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <div className="relative max-h-full w-full overflow-hidden rounded-xl border border-border bg-secondary/20">
            {r?.last_screenshot_url ? (
              <img src={r.last_screenshot_url} alt="App under test" className="block max-h-[calc(100vh-12rem)] w-full object-contain" />
            ) : (
              <div className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-3 text-muted-foreground">
                {r && ["queued", "planning", "running"].includes(r.status) ? (
                  <>
                    <Loader2 className="h-7 w-7 animate-spin" />
                    <span className="text-sm">
                      {r.status === "planning" ? "Preparing the test plan…" : r.status === "queued" ? "Starting the test…" : "Loading the app…"}
                    </span>
                  </>
                ) : (
                  <><Eye className="h-7 w-7" /><span className="text-sm">No frame captured</span></>
                )}
              </div>
            )}
            <div className="e2e-inner-halo pointer-events-none absolute inset-0 rounded-xl" />
          </div>
        </div>
      </div>

      {/* RIGHT: agent chat, full height. */}
      <div className="flex w-[380px] shrink-0 flex-col border-l border-border bg-background">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-medium">
          <Bot className="h-4 w-4 text-primary" /> Test agent
        </div>

        <div ref={chatRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {(steps.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">The agent is getting ready…</p>
          ) : (
            (steps.data ?? []).map((s) => <ChatStep key={s.id} step={s} />)
          )}
          {live && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <CircleDot className="h-3.5 w-3.5 animate-pulse text-primary" />
              {r?.status === "needs_input" ? "Waiting for your reply…" : "Agent is working…"}
            </div>
          )}
        </div>

        {/* Composer: answers a question, or sends a directive mid-run. */}
        <div className="border-t border-border p-3">
          {r?.status === "needs_input" && r.pending_question && (
            <p className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-300">
              {r.pending_question}
            </p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              rows={2}
              placeholder={r?.status === "needs_input" ? "Answer the agent…" : "Tell the agent what to do…"}
              disabled={!live && r?.status !== "needs_input"}
              className="flex-1 resize-none rounded-md border border-border bg-background p-2 text-sm disabled:opacity-50"
            />
            <Button size="icon" onClick={send} disabled={sending || !message.trim()}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
          {!live && r && (
            <p className="mt-2 text-center text-[11px] text-muted-foreground">
              This run is {RUN_TONE[r.status].label.toLowerCase()}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatStep({ step }: { step: RunStep }) {
  const isUser = step.actor === "user";
  const isAgent = step.actor === "agent";
  const failed = step.kind === "fail" || step.kind === "error" || step.status === "failed";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[85%] items-start gap-2 rounded-2xl border border-primary/30 bg-primary/10 px-3 py-2">
          <span className="text-sm">{step.label}</span>
          <UserIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        </div>
      </div>
    );
  }

  // Agent / runner / system → left-aligned compact line.
  return (
    <div className="flex items-start gap-2">
      <div className={cn(
        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px]",
        isAgent ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground",
      )}>
        {isAgent ? <Bot className="h-3 w-3" /> : "•"}
      </div>
      <div className="min-w-0">
        <div className={cn("text-sm", failed && "text-destructive")}>
          <span className="font-medium capitalize">{step.kind.replace("_", " ")}</span>
          {step.label ? <span className="text-muted-foreground"> — {step.label}</span> : null}
        </div>
      </div>
    </div>
  );
}
