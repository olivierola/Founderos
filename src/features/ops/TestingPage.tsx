import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FlaskConical, Plus, Play, Loader2, Trash2, Globe, Clock,
} from "lucide-react";
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
export interface TestSuite {
  id: string;
  name: string;
  description: string | null;
  app_url: string;
  created_at: string;
}
export interface TestCase {
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
export type RunStatus =
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

export const ACTIVE_STATUSES: RunStatus[] = ["queued", "planning", "running", "needs_input"];

interface CaseStat {
  status: RunStatus;
  last_at: string;
  runs: number;
  run_id: string;
  plan_len: number;
  step?: number;
}

// Compact relative time, e.g. "2m ago", "3h ago".
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const RUN_TONE: Record<RunStatus, { label: string; variant: "success" | "destructive" | "warning" | "secondary" }> = {
  queued: { label: "Queued", variant: "secondary" },
  planning: { label: "Planning", variant: "warning" },
  running: { label: "Running", variant: "warning" },
  needs_input: { label: "Needs input", variant: "warning" },
  passed: { label: "Passed", variant: "success" },
  failed: { label: "Failed", variant: "destructive" },
  error: { label: "Error", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "secondary" },
};

// The "Tests" tab: author suites & test cases, run them, see recent runs.
export function TestsTab({ onOpenRun }: { onOpenRun: (runId: string) => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [suiteOpen, setSuiteOpen] = useState(false);
  const [caseOpen, setCaseOpen] = useState<{ suiteId: string } | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  const openRun = onOpenRun;

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

  // Per-test run stats: latest run (status + time + live step) and total count.
  // Polls while anything is active so the RUNNING cards update live.
  const runStats = useQuery({
    queryKey: ["test_case_stats", projectId],
    enabled: !!projectId,
    refetchInterval: (q) => {
      const m = q.state.data as Record<string, CaseStat> | undefined;
      const anyActive = m && Object.values(m).some((s) => ACTIVE_STATUSES.includes(s.status));
      return anyActive ? 2500 : false;
    },
    queryFn: async () => {
      const { data } = await supabase
        .from("test_runs")
        .select("id, case_id, status, created_at, plan, pending_question")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(500);
      const rows = (data ?? []) as Array<{ id: string; case_id: string; status: RunStatus; created_at: string; plan: unknown; pending_question: string | null }>;
      const map: Record<string, CaseStat> = {};
      for (const r of rows) {
        const cur = map[r.case_id];
        if (!cur) {
          map[r.case_id] = {
            status: r.status, last_at: r.created_at, runs: 1,
            run_id: r.id,
            plan_len: Array.isArray(r.plan) ? (r.plan as unknown[]).length : 0,
          };
        } else {
          cur.runs += 1;
        }
      }
      // For the latest run of each case, compute the live step index.
      const activeCaseIds = Object.entries(map).filter(([, s]) => ACTIVE_STATUSES.includes(s.status)).map(([, s]) => s.run_id);
      if (activeCaseIds.length) {
        const { data: steps } = await supabase
          .from("test_run_steps")
          .select("run_id, kind")
          .in("run_id", activeCaseIds);
        const stepCount: Record<string, number> = {};
        for (const s of steps ?? []) {
          if (["click", "fill", "select", "navigate", "press", "scroll"].includes((s as { kind: string }).kind)) {
            stepCount[(s as { run_id: string }).run_id] = (stepCount[(s as { run_id: string }).run_id] ?? 0) + 1;
          }
        }
        for (const s of Object.values(map)) {
          if (ACTIVE_STATUSES.includes(s.status)) s.step = stepCount[s.run_id] ?? 0;
        }
      }
      return map;
    },
  });

  async function runCase(tc: TestCase) {
    if (!workspaceId || !projectId) return;
    setStarting(tc.id);
    try {
      const res = await callEdge<{ run_id: string }>("test-run-orchestrate", {
        workspace_id: workspaceId,
        project_id: projectId,
        case_id: tc.id,
        action: "start",
      });
      openRun(res.run_id);
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

  if (!projectId) return null;

  return (
    <div>
      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Describe a scenario in plain language; an AI agent drives a real browser against your app.
        </p>
        <Button size="sm" onClick={() => setSuiteOpen(true)}>
          <Plus className="h-4 w-4" /> New suite
        </Button>
      </div>

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

                <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {(casesBySuite[suite.id] ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">No tests in this suite yet.</p>
                  ) : (
                    (casesBySuite[suite.id] ?? []).map((tc) => (
                      <TestCaseCard
                        key={tc.id}
                        tc={tc}
                        stat={runStats.data?.[tc.id]}
                        starting={starting === tc.id}
                        onRun={() => runCase(tc)}
                        onDelete={() => deleteCase(tc.id)}
                        onOpen={() => { const s = runStats.data?.[tc.id]; if (s?.run_id) openRun(s.run_id); }}
                      />
                    ))
                  )}
                </div>
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
    </div>
  );
}

// ── A single test rendered as a card (status, instruction, live step, meta) ──
function TestCaseCard({
  tc, stat, starting, onRun, onDelete, onOpen,
}: {
  tc: TestCase;
  stat?: CaseStat;
  starting: boolean;
  onRun: () => void;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const status = stat?.status;
  const isActive = status ? ACTIVE_STATUSES.includes(status) : false;
  const tone = status ? RUN_TONE[status] : null;
  const clickable = !!stat?.run_id;

  return (
    <div
      className={cn(
        "group relative flex flex-col rounded-xl border border-border bg-card/40 p-4 transition-colors",
        clickable && "cursor-pointer hover:border-foreground/30",
      )}
      onClick={() => clickable && onOpen()}
    >
      <div className="flex items-start justify-between gap-3">
        <h4 className="font-medium leading-tight">{tc.name}</h4>
        {tone ? (
          <Badge variant={tone.variant} className="shrink-0">{tone.label}</Badge>
        ) : (
          <Badge variant="outline" className="shrink-0">never run</Badge>
        )}
      </div>

      <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">{tc.instructions}</p>

      {/* Live progress when running. */}
      {isActive && (
        <div className="mt-2 flex items-center gap-2 text-sm text-primary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {status === "needs_input"
            ? <span>waiting for input…</span>
            : status === "planning"
              ? <span>planning…</span>
              : <span>step {stat?.step ?? 0}{stat?.plan_len ? ` of ${stat.plan_len}` : ""} · in progress…</span>}
        </div>
      )}

      {/* Meta footer. */}
      <div className="mt-3 flex items-center gap-2 border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
        <Clock className="h-3.5 w-3.5" />
        {stat ? (
          <>
            <span>{stat.runs} run{stat.runs > 1 ? "s" : ""}</span>
            <span>·</span>
            <span>last: {relTime(stat.last_at)}</span>
          </>
        ) : (
          <span>not run yet</span>
        )}
        {/* Hover actions, top-right. */}
        <div
          className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <Button size="sm" variant="outline" disabled={starting} onClick={onRun} className="h-7">
            {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Run
          </Button>
          <Button size="icon" variant="ghost" onClick={onDelete} title="Delete test" className="h-7 w-7">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
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
  // Fixtures as repeatable key/value rows (e.g. email / password / plan).
  const [fixtures, setFixtures] = useState<{ key: string; value: string }[]>([{ key: "", value: "" }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setRow = (i: number, patch: Partial<{ key: string; value: string }>) =>
    setFixtures((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setFixtures((rows) => [...rows, { key: "", value: "" }]);
  const removeRow = (i: number) => setFixtures((rows) => (rows.length === 1 ? rows : rows.filter((_, idx) => idx !== i)));

  async function save() {
    if (!workspaceId || !projectId || !suiteId) return;
    if (!name.trim() || !instructions.trim()) { setError("Name and instructions are required."); return; }
    const parsedFixtures: Record<string, string> = {};
    for (const { key, value } of fixtures) {
      const k = key.trim();
      if (k) parsedFixtures[k] = value;
    }
    setSaving(true); setError(null);
    try {
      const { error } = await supabase.from("test_cases").insert({
        workspace_id: workspaceId, project_id: projectId, suite_id: suiteId,
        name: name.trim(), instructions: instructions.trim(),
        expected_outcome: expected.trim() || null, fixtures: parsedFixtures,
      });
      if (error) throw new Error(error.message);
      setName(""); setInstructions(""); setExpected(""); setFixtures([{ key: "", value: "" }]);
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
          <Field label="Test data (optional) — key / value the agent can use to fill forms">
            <div className="space-y-2">
              {fixtures.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={row.key}
                    onChange={(e) => setRow(i, { key: e.target.value })}
                    placeholder="key (e.g. email)"
                    className="flex-1"
                  />
                  <Input
                    value={row.value}
                    onChange={(e) => setRow(i, { value: e.target.value })}
                    placeholder="value (e.g. test@acme.com)"
                    className="flex-1"
                  />
                  <Button
                    type="button" size="icon" variant="ghost"
                    onClick={() => removeRow(i)}
                    disabled={fixtures.length === 1}
                    title="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="outline" onClick={addRow} className="gap-1.5">
                <Plus className="h-3.5 w-3.5" /> Add field
              </Button>
            </div>
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
