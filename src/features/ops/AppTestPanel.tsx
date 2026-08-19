// AppTestPanel — watch an agent test an app, live, from wherever you talk to it.
//
// The E2E testing module owns the full studio (suites, cases, analytics); this
// is the one screen that mattered next to a conversation: describe what to test,
// give a target URL, and see the frames the agent is looking at as it drives the
// app — plus a line for every action it takes, and a box to steer it mid-run.
//
// It rides the same pipeline as the studio (test_suites → test_cases →
// test-run-orchestrate → the Playwright runner streaming into test_run_steps),
// so a run started here is a first-class run: it shows up in Test runs, keeps
// its report, and can be reopened later.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Globe, Loader2, Eye, XCircle, MonitorPlay, Play, ChevronRight, Send,
  Bot, User as UserIcon, CircleDot, RotateCcw, ExternalLink, MousePointerClick,
  Keyboard, ScrollText, CheckCircle2, AlertTriangle, HelpCircle, Camera,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { RUN_TONE, type RunStatus } from "./TestingPage";
import { ReportArtifactCard, ReportDialog, type RunReport } from "./TestReport";

const TERMINAL: RunStatus[] = ["passed", "failed", "error", "cancelled"];
/** Ad-hoc runs (prompt + URL, no authored test case) land in this suite. */
const AD_HOC_SUITE = "Tests à la demande";

interface PanelRun {
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
interface PanelStep {
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

/** Accept "app.com/login" as readily as a full URL — a target is a target. */
function normalizeTarget(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

const STEP_ICON: Record<string, typeof MousePointerClick> = {
  navigate: Globe, click: MousePointerClick, fill: Keyboard, select: Keyboard,
  press: Keyboard, scroll: ScrollText, screenshot: Camera, assert: CheckCircle2,
  pass: CheckCircle2, fail: AlertTriangle, error: AlertTriangle, ask_user: HelpCircle,
};

export function AppTestPanel({
  workspaceId, projectId, className, onOpenInModule,
}: {
  workspaceId: string | null;
  projectId: string | null;
  className?: string;
  /** Open this run in the full Test runs studio. */
  onOpenInModule?: (runId: string) => void;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const storeKey = `app_test_panel_${projectId ?? "none"}`;
  // The watched run and the last target survive a tab switch (this panel
  // unmounts when you flip to Artifacts and back).
  const [runId, setRunId] = useState<string | null>(() => localStorage.getItem(`${storeKey}_run`));
  const [target, setTarget] = useState(() => localStorage.getItem(`${storeKey}_target`) ?? "");
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [openReport, setOpenReport] = useState<RunReport | null>(null);
  const stream = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (runId) localStorage.setItem(`${storeKey}_run`, runId);
    else localStorage.removeItem(`${storeKey}_run`);
  }, [runId, storeKey]);

  const { data: run, isLoading: runLoading } = useQuery({
    queryKey: ["app_test_run", runId],
    enabled: !!runId,
    refetchInterval: (q) => {
      const s = (q.state.data as PanelRun | null)?.status;
      return s && TERMINAL.includes(s) ? false : 1500;
    },
    queryFn: async () => {
      const { data } = await supabase
        .from("test_runs")
        .select("id, case_id, app_url, status, pending_question, last_screenshot_url, current_url, error_message, created_at")
        .eq("id", runId!)
        .maybeSingle();
      return (data ?? null) as PanelRun | null;
    },
  });

  const live = !!run && !TERMINAL.includes(run.status);

  const { data: steps } = useQuery({
    queryKey: ["app_test_steps", runId],
    enabled: !!runId,
    refetchInterval: live ? 1500 : false,
    queryFn: async () => {
      const { data } = await supabase
        .from("test_run_steps")
        .select("id, idx, actor, kind, label, payload, screenshot_url, status, created_at")
        .eq("run_id", runId!)
        .order("idx", { ascending: true });
      return (data ?? []) as PanelStep[];
    },
  });

  const { data: recent } = useQuery({
    queryKey: ["app_test_recent", projectId],
    enabled: !!projectId && !runId,
    refetchInterval: 8000,
    queryFn: async () => {
      const { data } = await supabase
        .from("test_runs")
        .select("id, status, app_url, created_at, case_id")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(6);
      return (data ?? []) as PanelRun[];
    },
  });

  useEffect(() => {
    if (stream.current) stream.current.scrollTop = stream.current.scrollHeight;
  }, [steps?.length, run?.status]);

  // A remembered run that no longer exists (deleted case/suite) is forgotten.
  useEffect(() => {
    if (runId && !runLoading && run === null) setRunId(null);
  }, [runId, runLoading, run]);

  /** Prompt + target → a real test case in the ad-hoc suite, then a run. */
  async function start() {
    const url = normalizeTarget(target);
    const instructions = prompt.trim();
    if (!url || !instructions || !workspaceId || !projectId) return;
    setStarting(true);
    setError(null);
    try {
      localStorage.setItem(`${storeKey}_target`, url);
      // One ad-hoc suite per target URL, reused across runs, so the studio's
      // suite list stays readable instead of growing one suite per prompt.
      const { data: found } = await supabase
        .from("test_suites").select("id")
        .eq("project_id", projectId).eq("app_url", url).eq("name", AD_HOC_SUITE)
        .limit(1);
      let suiteId = (found ?? [])[0]?.id as string | undefined;
      if (!suiteId) {
        const { data: created, error: sErr } = await supabase
          .from("test_suites")
          .insert({
            workspace_id: workspaceId, project_id: projectId, name: AD_HOC_SUITE,
            description: "Tests lancés depuis une room ou une conversation d'agent.",
            app_url: url, created_by: user?.id ?? null,
          })
          .select("id").single();
        if (sErr) throw sErr;
        suiteId = created!.id as string;
      }
      const { data: tc, error: cErr } = await supabase
        .from("test_cases")
        .insert({
          workspace_id: workspaceId, project_id: projectId, suite_id: suiteId,
          name: instructions.split("\n")[0].slice(0, 60),
          instructions, start_url: url, created_by: user?.id ?? null,
        })
        .select("id").single();
      if (cErr) throw cErr;

      const res = await callEdge<{ run_id: string }>("test-run-orchestrate", {
        workspace_id: workspaceId, project_id: projectId, case_id: tc!.id, action: "start",
      });
      setPrompt("");
      setRunId(res.run_id);
      qc.invalidateQueries({ queryKey: ["app_test_recent", projectId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  /** One box: answers the agent's question when it paused, steers it otherwise. */
  async function send() {
    const text = message.trim();
    if (!text || !runId || !workspaceId || !projectId) return;
    setSending(true);
    setError(null);
    try {
      await callEdge("test-run-orchestrate", {
        workspace_id: workspaceId, project_id: projectId, run_id: runId,
        action: run?.status === "needs_input" ? "answer" : "directive",
        answer: text, directive: text,
      });
      setMessage("");
      qc.invalidateQueries({ queryKey: ["app_test_run", runId] });
      qc.invalidateQueries({ queryKey: ["app_test_steps", runId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  /** Give up on this attempt and run the same test again, fresh. */
  async function relaunch() {
    if (!run || !workspaceId || !projectId) return;
    setStarting(true);
    setError(null);
    try {
      await supabase.from("test_runs")
        .update({ status: "cancelled", finished_at: new Date().toISOString() })
        .eq("id", run.id)
        .in("status", ["queued", "planning", "running", "needs_input"]);
      const res = await callEdge<{ run_id: string }>("test-run-orchestrate", {
        workspace_id: workspaceId, project_id: projectId, case_id: run.case_id, action: "start",
      });
      setRunId(res.run_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!runId) return;
    await supabase.from("test_runs")
      .update({ status: "cancelled", finished_at: new Date().toISOString() })
      .eq("id", runId);
    qc.invalidateQueries({ queryKey: ["app_test_run", runId] });
  }

  // Two ways this stalls, and neither should look like "still loading":
  //   · nobody claimed the run   → no Playwright runner is listening;
  //   · claimed, but no frame    → the runner took it and went quiet (its own
  //     process wedged, or it can't reach storage).
  const age = run ? Date.now() - new Date(run.created_at).getTime() : 0;
  const noRunner = !!run && run.status === "queued" && age > 20000;
  const silentRunner = !!run && !TERMINAL.includes(run.status) && run.status !== "queued"
    && !run.last_screenshot_url && age > 45000;

  // Reopening the panel on a remembered run: hold the frame instead of flashing
  // the start form for one fetch. A run that no longer exists is forgotten.
  if (runId && runLoading) {
    return (
      <div className={cn("flex h-full items-center justify-center", className)}>
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!runId || !run) {
    return (
      <div className={cn("flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4", className)}>
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <MonitorPlay className="h-4 w-4" />
            </span>
            <div>
              <div className="text-sm font-semibold">Tester une app</div>
              <div className="text-[11px] text-muted-foreground">L'agent pilote un vrai navigateur, tu regardes.</div>
            </div>
          </div>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Que doit-il tester ? Ex. : inscris-toi avec un email jetable, vérifie l'email de bienvenue, puis annule l'abonnement."
            className="min-h-[92px] resize-none text-sm"
          />
          <Input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="Cible — app.exemple.com/login"
            className="mt-2 text-sm"
            onKeyDown={(e) => { if (e.key === "Enter") void start(); }}
          />
          <Button
            className="mt-2 w-full"
            disabled={starting || !prompt.trim() || !target.trim() || !workspaceId || !projectId}
            onClick={() => void start()}
          >
            {starting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
            Lancer le test
          </Button>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>

        {(recent ?? []).length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tests récents</div>
            {(recent ?? []).map((r) => (
              <button
                key={r.id}
                onClick={() => setRunId(r.id)}
                className="flex w-full items-center gap-2 rounded-lg border border-border/70 p-2 text-left hover:bg-muted/50"
              >
                <Badge variant={RUN_TONE[r.status].variant} className="shrink-0 text-[10px]">{RUN_TONE[r.status].label}</Badge>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{r.app_url}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const tone = RUN_TONE[run.status];

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {/* Status row */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <Badge variant={tone.variant} className="shrink-0 text-[10px]">{tone.label}</Badge>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-muted-foreground">
          <Globe className="h-3 w-3 shrink-0" />
          <span className="truncate">{run.current_url ?? run.app_url}</span>
        </span>
        {live ? (
          <button onClick={() => void cancel()} title="Arrêter le test" className="shrink-0 text-muted-foreground hover:text-destructive">
            <XCircle className="h-4 w-4" />
          </button>
        ) : (
          <button onClick={() => setRunId(null)} title="Nouveau test" className="shrink-0 text-muted-foreground hover:text-foreground">
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )}
        {onOpenInModule && (
          <button onClick={() => onOpenInModule(run.id)} title="Ouvrir dans Test runs" className="shrink-0 text-muted-foreground hover:text-foreground">
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* What the agent is looking at */}
      <div className="shrink-0 p-3">
        <div className="relative overflow-hidden rounded-xl border border-border bg-white" style={{ aspectRatio: "16 / 10" }}>
          {run.last_screenshot_url ? (
            <a
              href={run.last_screenshot_url} target="_blank" rel="noopener noreferrer" title="Ouvrir la capture"
              className="block h-full w-full"
            >
              <img src={run.last_screenshot_url} alt="App testée" className="h-full w-full object-contain" />
            </a>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
              {["queued", "planning", "running"].includes(run.status) ? (
                <>
                  <Loader2 className="h-6 w-6 animate-spin" />
                  <span className="text-[11px]">
                    {run.status === "planning" ? "Plan de test en préparation…" : run.status === "queued" ? "En attente d'un runner…" : "Chargement de l'app…"}
                  </span>
                </>
              ) : (
                <><Eye className="h-6 w-6" /><span className="text-[11px]">Aucune image capturée</span></>
              )}
            </div>
          )}
        </div>
        {(noRunner || silentRunner) && (
          <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-600 dark:text-amber-400">
            {noRunner
              ? "Personne n'a pris ce test : vérifie qu'un runner est démarré (dossier runner/, npm start)."
              : "Le runner a pris le test mais n'envoie aucune image depuis " + Math.round(age / 1000) + " s — regarde sa console, puis relance."}
            <button
              onClick={() => void relaunch()} disabled={starting}
              className="mt-1.5 flex items-center gap-1 font-medium underline underline-offset-2 hover:no-underline disabled:opacity-50"
            >
              {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
              Relancer ce test
            </button>
          </div>
        )}
        {run.error_message && (
          <p className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-[11px] text-destructive">{run.error_message}</p>
        )}
      </div>

      {/* Every action, as it happens */}
      <div ref={stream} className="scrollbar-slim min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-2">
        {(steps ?? []).length === 0 ? (
          <p className="text-[11px] text-muted-foreground">L'agent se prépare…</p>
        ) : (
          (steps ?? []).map((s) => <StepLine key={s.id} step={s} onOpenReport={setOpenReport} />)
        )}
        {live && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <CircleDot className="h-3 w-3 animate-pulse text-primary" />
            {run.status === "needs_input" ? "Attend ta réponse…" : "L'agent travaille…"}
          </div>
        )}
      </div>

      {/* Steer it: answers the question when paused, gives a directive otherwise */}
      <div className="shrink-0 border-t border-border/60 p-3">
        {run.status === "needs_input" && run.pending_question && (
          <p className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-600 dark:text-amber-400">
            {run.pending_question}
          </p>
        )}
        <div className="flex items-end gap-1.5">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
            }}
            placeholder={
              run.status === "needs_input" ? "Réponds à l'agent…"
                : live ? "Dis-lui quoi faire ensuite…"
                : "Nouvelle instruction — le test reprend."
            }
            className="min-h-[38px] max-h-24 resize-none py-2 text-sm"
          />
          <Button size="sm" className="h-9 w-9 shrink-0 p-0" disabled={sending || !message.trim()} onClick={() => void send()}>
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </Button>
        </div>
        {error && <p className="mt-1.5 text-[11px] text-destructive">{error}</p>}
      </div>

      <ReportDialog report={openReport} open={!!openReport} onOpenChange={(o) => !o && setOpenReport(null)} />
    </div>
  );
}

function StepLine({ step, onOpenReport }: { step: PanelStep; onOpenReport: (r: RunReport) => void }) {
  // A structured report is an artifact, not a log line.
  if (step.kind === "report") {
    const report = (step.payload?.report ?? null) as RunReport | null;
    if (report) return <ReportArtifactCard report={report} onOpen={() => onOpenReport(report)} />;
  }

  if (step.actor === "user") {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[90%] items-start gap-1.5 rounded-xl border border-primary/30 bg-primary/10 px-2.5 py-1.5">
          <span className="text-[12px]">{step.label}</span>
          <UserIcon className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
        </div>
      </div>
    );
  }

  if (step.actor === "agent" && step.kind === "say") {
    return (
      <div className="flex items-start gap-1.5">
        <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="text-[12px] leading-relaxed">{step.label}</span>
      </div>
    );
  }

  const failed = step.kind === "fail" || step.kind === "error" || step.status === "failed";
  const Icon = STEP_ICON[step.kind] ?? CircleDot;
  return (
    <div className="flex items-start gap-1.5">
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", failed ? "text-destructive" : "text-muted-foreground")} />
      <div className={cn("min-w-0 text-[12px]", failed && "text-destructive")}>
        <span className="font-medium capitalize">{step.kind.replace(/_/g, " ")}</span>
        {step.label && <span className="text-muted-foreground"> — {step.label}</span>}
      </div>
    </div>
  );
}
