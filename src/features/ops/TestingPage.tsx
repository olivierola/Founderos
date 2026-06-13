import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FlaskConical, Plus, Play, Loader2, Trash2, Globe, ChevronRight,
  CheckCircle2, XCircle, MessageCircleQuestion, MousePointerClick,
  Keyboard, ArrowDownUp, Eye, Send, ListChecks, Bot, AlertTriangle,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

// ── Types (mirror the 0042 migration) ───────────────────────────────────────
interface TestSuite {
  id: string;
  name: string;
  description: string | null;
  app_url: string;
  created_at: string;
}
interface TestCase {
  id: string;
  suite_id: string;
  name: string;
  instructions: string;
  expected_outcome: string | null;
  fixtures: Record<string, unknown>;
  start_url: string | null;
  enabled: boolean;
  created_at: string;
}
type RunStatus =
  | "queued" | "planning" | "running" | "needs_input"
  | "passed" | "failed" | "error" | "cancelled";
interface TestRun {
  id: string;
  case_id: string;
  app_url: string;
  status: RunStatus;
  plan: Array<{ intent: string }> | unknown;
  pending_question: string | null;
  last_screenshot_url: string | null;
  current_url: string | null;
  error_message: string | null;
  created_at: string;
}
interface RunStep {
  id: string;
  run_id: string;
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

export function OpsTestingPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [suiteOpen, setSuiteOpen] = useState(false);
  const [caseOpen, setCaseOpen] = useState<{ suiteId: string } | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  const suites = useQuery({
    queryKey: ["test_suites", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("test_suites").select("*")
        .eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as TestSuite[];
    },
  });

  const cases = useQuery({
    queryKey: ["test_cases", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("test_cases").select("*")
        .eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as TestCase[];
    },
  });

  const casesBySuite = useMemo(() => {
    const m: Record<string, TestCase[]> = {};
    for (const c of cases.data ?? []) (m[c.suite_id] ??= []).push(c);
    return m;
  }, [cases.data]);

  async function runCase(tc: TestCase, suite: TestSuite) {
    if (!workspaceId || !projectId) return;
    setStarting(tc.id);
    try {
      const res = await callEdge<{ run_id: string }>("test-run-orchestrate", {
        workspace_id: workspaceId,
        project_id: projectId,
        case_id: tc.id,
        action: "start",
      });
      setActiveRunId(res.run_id);
      queryClient.invalidateQueries({ queryKey: ["test_runs", projectId] });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(null);
    }
  }

  async function deleteSuite(id: string) {
    if (!confirm("Delete this suite and all its tests?")) return;
    await supabase.from("test_suites").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["test_suites", projectId] });
    queryClient.invalidateQueries({ queryKey: ["test_cases", projectId] });
  }
  async function deleteCase(id: string) {
    await supabase.from("test_cases").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["test_cases", projectId] });
  }

  if (!projectId) return <PageHeader title="Testing" />;

  return (
    <div>
      <PageHeader
        title="Testing"
        description="Agentic end-to-end testing. Describe a scenario in plain language; an AI agent drives a real browser (Playwright) against your app, fills forms, scrolls and asserts — pausing to ask you when it needs info."
        actions={
          <Button size="sm" onClick={() => setSuiteOpen(true)}>
            <Plus className="h-4 w-4" /> New suite
          </Button>
        }
      />

      <RunnerHint projectId={projectId} />

      {suites.isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : (suites.data ?? []).length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="No test suites yet"
          description="Create a suite pointing at your app URL, then add tests described in plain language."
        />
      ) : (
        <div className="space-y-4">
          {(suites.data ?? []).map((suite) => (
            <Card key={suite.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FlaskConical className="h-4 w-4 text-primary" />
                      <span className="font-medium">{suite.name}</span>
                    </div>
                    <a
                      href={suite.app_url} target="_blank" rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                    >
                      <Globe className="h-3 w-3" /> {suite.app_url}
                    </a>
                    {suite.description && <p className="mt-1 text-xs text-muted-foreground">{suite.description}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => setCaseOpen({ suiteId: suite.id })}>
                      <Plus className="h-3.5 w-3.5" /> Test
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => deleteSuite(suite.id)} title="Delete suite">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  {(casesBySuite[suite.id] ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">No tests in this suite yet.</p>
                  ) : (
                    (casesBySuite[suite.id] ?? []).map((tc) => (
                      <div key={tc.id} className="flex items-start gap-3 rounded-md border border-border p-2.5">
                        <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium">{tc.name}</div>
                          <p className="line-clamp-2 text-xs text-muted-foreground">{tc.instructions}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button size="sm" disabled={starting === tc.id} onClick={() => runCase(tc, suite)}>
                            {starting === tc.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                            Run
                          </Button>
                          <Button size="icon" variant="ghost" onClick={() => deleteCase(tc.id)} title="Delete test">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <RecentRuns suiteId={suite.id} projectId={projectId} onOpen={setActiveRunId} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <SuiteDialog
        open={suiteOpen} onOpenChange={setSuiteOpen}
        workspaceId={workspaceId} projectId={projectId}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ["test_suites", projectId] })}
      />
      <CaseDialog
        open={!!caseOpen} onOpenChange={(o) => !o && setCaseOpen(null)}
        suiteId={caseOpen?.suiteId ?? null}
        workspaceId={workspaceId} projectId={projectId}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ["test_cases", projectId] })}
      />

      <RunViewer
        runId={activeRunId}
        onClose={() => setActiveRunId(null)}
        workspaceId={workspaceId}
        projectId={projectId}
      />
    </div>
  );
}

// ── Runner connectivity hint ────────────────────────────────────────────────
function RunnerHint({ projectId }: { projectId: string }) {
  const { data } = useQuery({
    queryKey: ["ops_settings_runner", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_settings").select("runner_token_hash").eq("project_id", projectId).maybeSingle();
      return data;
    },
  });
  if (data?.runner_token_hash) return null;
  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        No test runner is registered yet. Runs will queue until a Playwright runner connects.
        Register a runner in <strong>DevOps → Settings</strong> — the same runner token drives Ops jobs and E2E tests.
      </span>
    </div>
  );
}

// ── Recent runs strip per suite ─────────────────────────────────────────────
function RecentRuns({ suiteId, projectId, onOpen }: { suiteId: string; projectId: string; onOpen: (id: string) => void }) {
  const { data } = useQuery({
    queryKey: ["test_runs", projectId, suiteId],
    enabled: !!projectId,
    refetchInterval: 5000,
    queryFn: async () => {
      const { data } = await supabase
        .from("test_runs").select("id, case_id, status, current_url, created_at, app_url, error_message, plan, pending_question, last_screenshot_url")
        .eq("suite_id", suiteId).order("created_at", { ascending: false }).limit(5);
      return (data ?? []) as TestRun[];
    },
  });
  if (!data || data.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
      {data.map((r) => {
        const tone = RUN_TONE[r.status];
        return (
          <button
            key={r.id} onClick={() => onOpen(r.id)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-secondary"
          >
            <Badge variant={tone.variant}>{tone.label}</Badge>
            <span className="text-muted-foreground">{new Date(r.created_at).toLocaleTimeString()}</span>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          </button>
        );
      })}
    </div>
  );
}

// ── Create suite dialog ─────────────────────────────────────────────────────
function SuiteDialog({
  open, onOpenChange, workspaceId, projectId, onSaved,
}: { open: boolean; onOpenChange: (o: boolean) => void; workspaceId: string | null; projectId: string | null; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [appUrl, setAppUrl] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!workspaceId || !projectId) return;
    if (!name.trim() || !appUrl.trim()) { setError("Name and app URL are required."); return; }
    let url = appUrl.trim();
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    setSaving(true); setError(null);
    try {
      const { error } = await supabase.from("test_suites").insert({
        workspace_id: workspaceId, project_id: projectId,
        name: name.trim(), app_url: url, description: description.trim() || null,
      });
      if (error) throw new Error(error.message);
      setName(""); setAppUrl(""); setDescription("");
      onOpenChange(false); onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>New test suite</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field label="Suite name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Checkout flow" /></Field>
          <Field label="Application URL">
            <Input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://app.example.com" />
          </Field>
          <Field label="Description (optional)">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this suite covers" />
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Create</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Create test case dialog ─────────────────────────────────────────────────
function CaseDialog({
  open, onOpenChange, suiteId, workspaceId, projectId, onSaved,
}: { open: boolean; onOpenChange: (o: boolean) => void; suiteId: string | null; workspaceId: string | null; projectId: string | null; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [expected, setExpected] = useState("");
  const [fixtures, setFixtures] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!workspaceId || !projectId || !suiteId) return;
    if (!name.trim() || !instructions.trim()) { setError("Name and instructions are required."); return; }
    let parsedFixtures: Record<string, unknown> = {};
    if (fixtures.trim()) {
      try { parsedFixtures = JSON.parse(fixtures); }
      catch { setError("Fixtures must be valid JSON (or leave it empty)."); return; }
    }
    setSaving(true); setError(null);
    try {
      const { error } = await supabase.from("test_cases").insert({
        workspace_id: workspaceId, project_id: projectId, suite_id: suiteId,
        name: name.trim(), instructions: instructions.trim(),
        expected_outcome: expected.trim() || null, fixtures: parsedFixtures,
      });
      if (error) throw new Error(error.message);
      setName(""); setInstructions(""); setExpected(""); setFixtures("");
      onOpenChange(false); onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>New test</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field label="Test name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sign up with email" /></Field>
          <Field label="What should the agent do? (plain language)">
            <textarea
              value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={5}
              className="w-full rounded-md border border-border bg-background p-2.5 text-sm"
              placeholder={"Open the app, click 'Sign up', fill the form with a new email and a strong password, submit, and confirm you land on the onboarding screen."}
            />
          </Field>
          <Field label="Expected outcome (optional)">
            <Input value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="Onboarding screen is visible" />
          </Field>
          <Field label="Fixtures — known data as JSON (optional)">
            <Input value={fixtures} onChange={(e) => setFixtures(e.target.value)} placeholder='{ "email": "test+e2e@acme.com", "plan": "pro" }' />
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Add test</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

// ── Live run viewer: streamed app view + step timeline + ask-for-input ──────
const STEP_ICON: Record<string, any> = {
  plan: ListChecks, navigate: Globe, click: MousePointerClick, fill: Keyboard,
  select: Keyboard, scroll: ArrowDownUp, press: Keyboard, wait: Loader2,
  assert: CheckCircle2, screenshot: Eye, dom_snapshot: Eye, ask_user: MessageCircleQuestion,
  user_answer: Send, thought: Bot, pass: CheckCircle2, fail: XCircle, error: XCircle, info: Eye,
};

function RunViewer({
  runId, onClose, workspaceId, projectId,
}: { runId: string | null; onClose: () => void; workspaceId: string | null; projectId: string | null }) {
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);

  const run = useQuery({
    queryKey: ["test_run", runId],
    enabled: !!runId,
    refetchInterval: (q) => {
      const s = (q.state.data as TestRun | undefined)?.status;
      return s && ["passed", "failed", "error", "cancelled"].includes(s) ? false : 2000;
    },
    queryFn: async () => {
      const { data } = await supabase.from("test_runs").select("*").eq("id", runId!).maybeSingle();
      return data as TestRun | null;
    },
  });

  const steps = useQuery({
    queryKey: ["test_run_steps", runId],
    enabled: !!runId,
    refetchInterval: (q) => {
      const s = run.data?.status;
      return s && ["passed", "failed", "error", "cancelled"].includes(s) ? false : 2000;
    },
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

  return (
    <Dialog open={!!runId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Test run {tone && <Badge variant={tone.variant}>{tone.label}</Badge>}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-[1.4fr_1fr]">
          {/* Streamed app view: the runner streams screenshots of the
              Playwright-controlled browser. Cross-origin apps can't be a real
              controllable iframe, so we render the latest captured frame. */}
          <div className="flex flex-col">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Globe className="h-3.5 w-3.5" />
              <span className="truncate">{r?.current_url ?? r?.app_url ?? "—"}</span>
            </div>
            <div className="relative aspect-[4/3] overflow-hidden rounded-lg border border-border bg-secondary/40">
              {r?.last_screenshot_url ? (
                <img src={r.last_screenshot_url} alt="App under test" className="h-full w-full object-contain" />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                  {r && ["queued", "planning", "running"].includes(r.status) ? (
                    <>
                      <Loader2 className="h-6 w-6 animate-spin" />
                      <span className="text-xs">Waiting for the runner to load the app…</span>
                    </>
                  ) : (
                    <>
                      <Eye className="h-6 w-6" />
                      <span className="text-xs">No frame captured yet</span>
                    </>
                  )}
                </div>
              )}
            </div>
            {r && ["queued", "planning", "running", "needs_input"].includes(r.status) && (
              <Button size="sm" variant="ghost" className="mt-2 self-start text-muted-foreground" onClick={cancelRun}>
                <XCircle className="h-3.5 w-3.5" /> Cancel run
              </Button>
            )}
          </div>

          {/* Step timeline */}
          <div className="flex max-h-[60vh] flex-col">
            <div ref={timelineRef} className="flex-1 space-y-1.5 overflow-y-auto pr-1">
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

            {/* Ask-for-input panel */}
            {r?.status === "needs_input" && (
              <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
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
              <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                {r.error_message}
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
