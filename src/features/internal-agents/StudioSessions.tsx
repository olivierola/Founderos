// Structured artifacts produced by the Testing and Simulations studio agents
// (create_deliverable kind="test_session" / "simulation_session"). Same idea as
// CodingSession: the agent's output IS the artifact, not a prose recap — a
// verdict you can act on, backed by the cases it ran or the reactions it saw.
import { useMemo } from "react";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import {
  CheckCircle2, XCircle, MinusCircle, AlertTriangle, Bug, Gauge, Users,
  MessageSquareQuote, ExternalLink, Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCategorical } from "@/features/crm/overview/vizPalette";

// ── test_session ────────────────────────────────────────────────────────────

interface TestCaseResult {
  name: string;
  status?: "passed" | "failed" | "skipped" | "blocked";
  duration_s?: number;
  failure?: string;
  screenshot_url?: string;
  steps?: string[];
}
interface Defect {
  title: string;
  severity?: "critical" | "major" | "minor";
  detail?: string;
  case?: string;
}
export interface TestSessionDoc {
  title?: string;
  app_url?: string;
  verdict?: "passed" | "failed" | "flaky" | "blocked";
  summary?: string;
  cases?: TestCaseResult[];
  defects?: Defect[];
  coverage?: string[];
  next_steps?: string[];
}

// ── simulation_session ──────────────────────────────────────────────────────

interface SentimentRound { round: number; positive?: number; neutral?: number; negative?: number }
interface Cohort { name: string; size?: number; stance?: "adopt" | "wait" | "reject"; why?: string }
interface Signal { quote: string; cohort?: string; tone?: "positive" | "neutral" | "negative" }
export interface SimulationSessionDoc {
  title?: string;
  question?: string;
  population?: number;
  rounds?: number;
  verdict?: string;
  confidence?: "high" | "medium" | "low";
  summary?: string;
  sentiment?: SentimentRound[];
  cohorts?: Cohort[];
  signals?: Signal[];
  risks?: string[];
  next_steps?: string[];
}

function parseJsonDoc<T>(content: string | null | undefined, isShape: (v: any) => boolean): T | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && isShape(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}

/** Identified by shape, so a session saved under kind "json" still renders. */
export function tryParseTestSession(content: string | null | undefined): TestSessionDoc | null {
  return parseJsonDoc<TestSessionDoc>(content, (v) => Array.isArray(v.cases) || (!!v.verdict && Array.isArray(v.defects)));
}
export function tryParseSimulationSession(content: string | null | undefined): SimulationSessionDoc | null {
  return parseJsonDoc<SimulationSessionDoc>(content, (v) => Array.isArray(v.cohorts) || Array.isArray(v.sentiment) || Array.isArray(v.signals));
}

const VERDICT_TONE: Record<string, string> = {
  passed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  failed: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300",
  flaky: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  blocked: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300",
};

const CASE_ICON = {
  passed: { icon: CheckCircle2, className: "text-emerald-500" },
  failed: { icon: XCircle, className: "text-rose-500" },
  skipped: { icon: MinusCircle, className: "text-muted-foreground" },
  blocked: { icon: AlertTriangle, className: "text-amber-500" },
};

const SEVERITY_TONE: Record<string, string> = {
  critical: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300",
  major: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  minor: "border-border bg-muted text-muted-foreground",
};

function StatTile({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 text-2xl font-semibold tabular-nums", tone)}>{value}</div>
    </div>
  );
}

export function TestSession({ session }: { session: TestSessionDoc }) {
  const cases = session.cases ?? [];
  const defects = session.defects ?? [];
  const counts = useMemo(() => {
    const c = { passed: 0, failed: 0, skipped: 0, blocked: 0 };
    for (const t of cases) c[t.status ?? "passed"] = (c[t.status ?? "passed"] ?? 0) + 1;
    return c;
  }, [cases]);
  const verdict = session.verdict ?? (counts.failed ? "failed" : "passed");

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase", VERDICT_TONE[verdict] ?? VERDICT_TONE.blocked)}>
            {verdict}
          </span>
          {session.app_url && (
            <a href={session.app_url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground">
              {session.app_url} <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <h2 className="text-xl font-semibold leading-tight">{session.title || "Session de test"}</h2>
      </header>

      {session.summary && <p className="text-sm leading-relaxed">{session.summary}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Réussis" value={counts.passed} tone="text-emerald-500" />
        <StatTile label="Échoués" value={counts.failed} tone={counts.failed ? "text-rose-500" : undefined} />
        <StatTile label="Bloqués" value={counts.blocked + counts.skipped} />
        <StatTile label="Défauts" value={defects.length} tone={defects.length ? "text-amber-500" : undefined} />
      </div>

      {cases.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Scénarios · {cases.length}</h3>
          <div className="space-y-1.5">
            {cases.map((c, i) => {
              const meta = CASE_ICON[c.status ?? "passed"] ?? CASE_ICON.passed;
              const Icon = meta.icon;
              return (
                <div key={i} className="rounded-xl border border-border px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <Icon className={cn("h-4 w-4 shrink-0", meta.className)} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                    {typeof c.duration_s === "number" && (
                      <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-muted-foreground">
                        <Clock className="h-3 w-3" /> {c.duration_s}s
                      </span>
                    )}
                  </div>
                  {c.failure && (
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-rose-500/5 p-2 font-mono text-[11px] text-rose-600 dark:text-rose-300">
                      {c.failure}
                    </pre>
                  )}
                  {!!c.steps?.length && (
                    <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
                      {c.steps.slice(0, 12).map((s, j) => <li key={j}>· {s}</li>)}
                    </ul>
                  )}
                  {c.screenshot_url && (
                    <a href={c.screenshot_url} target="_blank" rel="noopener noreferrer"
                      className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                      Capture <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {defects.length > 0 && (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Bug className="h-3.5 w-3.5" /> Défauts
          </h3>
          <div className="space-y-1.5">
            {defects.map((d, i) => (
              <div key={i} className="rounded-xl border border-border p-3">
                <div className="flex items-center gap-2">
                  <span className={cn("rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase", SEVERITY_TONE[d.severity ?? "minor"])}>
                    {d.severity ?? "minor"}
                  </span>
                  <span className="min-w-0 flex-1 text-sm font-medium">{d.title}</span>
                  {d.case && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{d.case}</span>}
                </div>
                {d.detail && <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{d.detail}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      <CoverageAndNext coverage={session.coverage} coverageLabel="Couvert par cette session" next={session.next_steps} />
    </div>
  );
}

const STANCE_TONE: Record<string, string> = {
  adopt: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  wait: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  reject: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300",
};
const TONE_BAR: Record<string, string> = {
  positive: "border-l-emerald-500", neutral: "border-l-border", negative: "border-l-rose-500",
};

export function SimulationSession({ session }: { session: SimulationSessionDoc }) {
  const sentiment = session.sentiment ?? [];
  const cohorts = session.cohorts ?? [];
  const signals = session.signals ?? [];
  // Validated palette — the legacy CHART_COLORS fail colourblind checks.
  const colors = useCategorical();

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          {typeof session.population === "number" && (
            <span className="inline-flex items-center gap-1 font-mono"><Users className="h-3 w-3" /> {session.population} personas</span>
          )}
          {typeof session.rounds === "number" && <span className="font-mono">{session.rounds} tours</span>}
          {session.confidence && (
            <span className="inline-flex items-center gap-1 font-mono uppercase">
              <Gauge className="h-3 w-3" /> confiance {session.confidence}
            </span>
          )}
        </div>
        <h2 className="text-xl font-semibold leading-tight">{session.title || "Simulation"}</h2>
        {session.question && <p className="text-sm text-muted-foreground">{session.question}</p>}
      </header>

      {session.verdict && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Verdict</div>
          <p className="mt-1 text-sm font-medium leading-relaxed">{session.verdict}</p>
        </div>
      )}

      {session.summary && <p className="text-sm leading-relaxed">{session.summary}</p>}

      {sentiment.length > 1 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sentiment par tour</h3>
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={sentiment} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                <XAxis dataKey="round" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
                <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" />
                <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                <Area type="monotone" dataKey="positive" stackId="1" stroke={colors[0]} fill={colors[0]} fillOpacity={0.5} />
                <Area type="monotone" dataKey="neutral" stackId="1" stroke={colors[1]} fill={colors[1]} fillOpacity={0.5} />
                <Area type="monotone" dataKey="negative" stackId="1" stroke={colors[2]} fill={colors[2]} fillOpacity={0.5} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      {cohorts.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cohortes</h3>
          <div className="space-y-1.5">
            {cohorts.map((c, i) => (
              <div key={i} className="flex items-start gap-2.5 rounded-xl border border-border px-3 py-2.5">
                <span className={cn("shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase", STANCE_TONE[c.stance ?? "wait"])}>
                  {c.stance ?? "wait"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {c.name}
                    {typeof c.size === "number" && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">×{c.size}</span>}
                  </div>
                  {c.why && <p className="mt-0.5 text-xs text-muted-foreground">{c.why}</p>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {signals.length > 0 && (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <MessageSquareQuote className="h-3.5 w-3.5" /> Ce qu'ils ont dit
          </h3>
          <div className="space-y-1.5">
            {signals.map((s, i) => (
              <blockquote key={i} className={cn("border-l-2 py-1 pl-3", TONE_BAR[s.tone ?? "neutral"])}>
                <p className="text-sm italic leading-relaxed">« {s.quote} »</p>
                {s.cohort && <cite className="text-[11px] not-italic text-muted-foreground">— {s.cohort}</cite>}
              </blockquote>
            ))}
          </div>
        </section>
      )}

      <CoverageAndNext coverage={session.risks} coverageLabel="Ce qui invaliderait la prédiction" next={session.next_steps} warn />
    </div>
  );
}

function CoverageAndNext({
  coverage, coverageLabel, next, warn,
}: {
  coverage?: string[];
  coverageLabel: string;
  next?: string[];
  warn?: boolean;
}) {
  if (!coverage?.length && !next?.length) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {!!coverage?.length && (
        <section className={cn("rounded-xl border p-3", warn ? "border-amber-500/30 bg-amber-500/5" : "border-border")}>
          <h3 className={cn(
            "flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider",
            warn ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
          )}>
            {warn && <AlertTriangle className="h-3.5 w-3.5" />} {coverageLabel}
          </h3>
          <ul className="mt-2 space-y-1 text-xs leading-relaxed">
            {coverage.map((c, i) => <li key={i}>· {c}</li>)}
          </ul>
        </section>
      )}
      {!!next?.length && (
        <section className="rounded-xl border border-border p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Suite</h3>
          <ul className="mt-2 space-y-1 text-xs leading-relaxed">
            {next.map((s, i) => <li key={i}>· {s}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
