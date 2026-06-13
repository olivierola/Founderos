import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Globe, Loader2, Eye, XCircle, CheckCircle2, Send,
  MessageCircleQuestion, MousePointerClick, Keyboard, ArrowDownUp,
  ListChecks, Bot,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

type RunStatus =
  | "queued" | "planning" | "running" | "needs_input"
  | "passed" | "failed" | "error" | "cancelled";

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
  screenshot_url: string | null;
  status: string;
  created_at: string;
}

const RUN_TONE: Record<RunStatus, { label: string; variant: "success" | "destructive" | "warning" | "secondary" }> = {
  queued: { label: "Queued", variant: "secondary" },
  planning: { label: "Planning", variant: "warning" },
  running: { label: "Running", variant: "warning" },
  needs_input: { label: "Needs input", variant: "warning" },
  passed: { label: "Passed", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  error: { label: "Error", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "secondary" },
};

const STEP_ICON: Record<string, any> = {
  plan: ListChecks, navigate: Globe, click: MousePointerClick, fill: Keyboard,
  select: Keyboard, scroll: ArrowDownUp, press: Keyboard, wait: Loader2,
  assert: CheckCircle2, screenshot: Eye, dom_snapshot: Eye, ask_user: MessageCircleQuestion,
  user_answer: Send, thought: Bot, pass: CheckCircle2, fail: XCircle, error: XCircle, info: Eye,
};

const TERMINAL: RunStatus[] = ["passed", "failed", "error", "cancelled"];

export function OpsTestRunPage() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);

  const run = useQuery({
    queryKey: ["test_run", runId],
    enabled: !!runId,
    refetchInterval: (q) => {
      const s = (q.state.data as TestRun | undefined)?.status;
      return s && TERMINAL.includes(s) ? false : 2000;
    },
    queryFn: async () => {
      const { data } = await supabase.from("test_runs").select("*").eq("id", runId!).maybeSingle();
      return data as TestRun | null;
    },
  });

  const steps = useQuery({
    queryKey: ["test_run_steps", runId],
    enabled: !!runId,
    refetchInterval: () => (run.data && TERMINAL.includes(run.data.status) ? false : 2000),
    queryFn: async () => {
      const { data } = await supabase
        .from("test_run_steps").select("*").eq("run_id", runId!).order("idx", { ascending: true });
      return (data ?? []) as RunStep[];
    },
  });

  useEffect(() => {
    if (timelineRef.current) timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
  }, [steps.data?.length]);

  async function submitAnswer() {
    if (!workspaceId || !projectId || !runId || !answer.trim()) return;
    setSubmitting(true);
    try {
      await callEdge("test-run-orchestrate", {
        workspace_id: workspaceId, project_id: projectId,
        run_id: runId, action: "answer", answer: answer.trim(),
      });
      setAnswer("");
      queryClient.invalidateQueries({ queryKey: ["test_run", runId] });
      queryClient.invalidateQueries({ queryKey: ["test_run_steps", runId] });
    } finally { setSubmitting(false); }
  }

  async function cancelRun() {
    if (!runId) return;
    await supabase.from("test_runs").update({ status: "cancelled" }).eq("id", runId);
    queryClient.invalidateQueries({ queryKey: ["test_run", runId] });
  }

  const r = run.data;
  const tone = r ? RUN_TONE[r.status] : null;
  const live = r && !TERMINAL.includes(r.status);

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="text-muted-foreground">
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <div className="h-5 w-px bg-border" />
          <span className="font-medium">Test run</span>
          {tone && <Badge variant={tone.variant}>{tone.label}</Badge>}
          <a
            href={r?.current_url ?? r?.app_url} target="_blank" rel="noopener noreferrer"
            className="ml-1 inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-primary"
          >
            <Globe className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{r?.current_url ?? r?.app_url ?? "—"}</span>
          </a>
        </div>
        {live && (
          <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={cancelRun}>
            <XCircle className="h-4 w-4" /> Cancel run
          </Button>
        )}
      </div>

      {/* Body: large preview + timeline */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-6 lg:grid-cols-[1.7fr_1fr]">
        {/* Streamed app view — large, rounded. */}
        <div className="flex min-h-0 flex-col">
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-secondary/30 shadow-sm">
            {r?.last_screenshot_url ? (
              <img src={r.last_screenshot_url} alt="App under test" className="h-full w-full object-contain" />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-muted-foreground">
                {r && ["queued", "planning", "running"].includes(r.status) ? (
                  <>
                    <Loader2 className="h-7 w-7 animate-spin" />
                    <span className="text-sm">
                      {r.status === "planning"
                        ? "Preparing the test plan…"
                        : r.status === "queued"
                          ? "Starting the test…"
                          : "Loading the app…"}
                    </span>
                  </>
                ) : (
                  <>
                    <Eye className="h-7 w-7" />
                    <span className="text-sm">No frame captured</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Timeline + ask-for-input */}
        <div className="flex min-h-0 flex-col">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Agent timeline
          </div>
          <div ref={timelineRef} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto rounded-xl border border-border bg-card/40 p-3">
            {(steps.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">The agent is preparing the plan…</p>
            ) : (
              (steps.data ?? []).map((s) => {
                const Icon = STEP_ICON[s.kind] ?? Eye;
                const failed = s.status === "failed" || s.kind === "fail" || s.kind === "error";
                return (
                  <div key={s.id} className={cn(
                    "flex items-start gap-2 rounded-md border p-2 text-xs",
                    failed ? "border-destructive/40 bg-destructive/5" : "border-border",
                  )}>
                    <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", failed ? "text-destructive" : "text-muted-foreground")} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium capitalize">{s.kind.replace("_", " ")}</span>
                        <span className="text-[10px] uppercase text-muted-foreground">{s.actor}</span>
                      </div>
                      {s.label && <p className="text-muted-foreground">{s.label}</p>}
                      {s.kind === "fill" && s.payload?.selector ? (
                        <p className="font-mono text-[10px] text-muted-foreground/80">{String(s.payload.selector)}</p>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {r?.status === "needs_input" && (
            <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-amber-300">
                <MessageCircleQuestion className="h-4 w-4" /> The agent needs your input
              </div>
              <p className="mb-2 text-sm">{r.pending_question}</p>
              <div className="flex gap-2">
                <Input
                  value={answer} onChange={(e) => setAnswer(e.target.value)}
                  placeholder="Your answer…"
                  onKeyDown={(e) => e.key === "Enter" && submitAnswer()}
                />
                <Button size="sm" onClick={submitAnswer} disabled={submitting || !answer.trim()}>
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          )}

          {r?.error_message && (
            <p className="mt-3 rounded-xl border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
              {r.error_message}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
