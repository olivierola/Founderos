// Structured artifact produced by the Vibe Code studio agent
// (create_deliverable kind="coding_session"). A coding session is not a wall
// of prose: it's a goal, a plan, the files it touched with their diffs, the
// commands it ran, and the PR it opened. This renders that as a session view —
// the same role BlockRenderer plays for a report document.
import { useMemo, useState } from "react";
import {
  GitPullRequestIcon as GitPullRequest,
  ArrowSquareOutIcon as ExternalLink,
  CheckCircleIcon as CheckCircle2,
  XCircleIcon as XCircle,
  MinusCircleIcon as MinusCircle,
  WarningIcon as AlertTriangle,
  FilePlusIcon as FilePlus2,
  FileMinusIcon as FileMinus2,
  NotePencilIcon as FilePen,
  TerminalIcon as Terminal,
  CaretRightIcon as ChevronRight,
  ArrowRightIcon as ArrowRight,
  RocketLaunchIcon as Rocket,
} from "@phosphor-icons/react";
import { CodeBlock } from "@/components/AgentMarkdown";
import { cn } from "@/lib/utils";

// ---- session document types -----------------------------------------------

interface PlanStep { step: string; status?: "done" | "skipped" | "failed"; detail?: string }
interface TouchedFile {
  path: string;
  change?: "added" | "modified" | "deleted";
  language?: string;
  summary?: string;
  diff?: string;
}
interface RanCommand { cmd: string; result?: string; ok?: boolean }
interface PullRequestRef { url?: string; number?: number; title?: string; state?: string }

export interface CodingSessionDoc {
  title?: string;
  goal?: string;
  repository?: string;
  branch?: string;
  status?: "shipped" | "staged" | "failed" | "partial";
  summary?: string;
  plan?: PlanStep[];
  files?: TouchedFile[];
  commands?: RanCommand[];
  pull_request?: PullRequestRef;
  preview_url?: string;
  risks?: string[];
  next_steps?: string[];
}

/**
 * Parse a deliverable's content as a coding session. Mirrors tryParseReport:
 * returns null unless the payload really looks like one, so a mis-typed
 * deliverable falls through to the generic renderers instead of rendering an
 * empty shell.
 */
export function tryParseCodingSession(content: string | null | undefined): CodingSessionDoc | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as CodingSessionDoc;
    if (!parsed || typeof parsed !== "object") return null;
    // A session is identified by its shape, not by the stored kind — agents
    // sometimes save it under "json".
    const hasSessionShape =
      Array.isArray(parsed.files) || Array.isArray(parsed.plan) || !!parsed.pull_request || !!parsed.repository;
    if (!hasSessionShape) return null;
    return parsed;
  } catch {
    return null;
  }
}

const STATUS_TONE: Record<string, { label: string; className: string }> = {
  shipped: { label: "PR ouverte", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300" },
  staged: { label: "Diff en attente", className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300" },
  partial: { label: "Partiel", className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300" },
  failed: { label: "Échec", className: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300" },
};

const CHANGE_META: Record<string, { icon: typeof FilePen; className: string; label: string }> = {
  added: { icon: FilePlus2, className: "text-emerald-500", label: "ajouté" },
  modified: { icon: FilePen, className: "text-sky-500", label: "modifié" },
  deleted: { icon: FileMinus2, className: "text-rose-500", label: "supprimé" },
};

const STEP_ICON = {
  done: { icon: CheckCircle2, className: "text-emerald-500" },
  failed: { icon: XCircle, className: "text-rose-500" },
  skipped: { icon: MinusCircle, className: "text-muted-foreground" },
};

// Count added/removed lines so each file shows a real diffstat.
function diffStat(diff: string | undefined): { plus: number; minus: number } | null {
  if (!diff) return null;
  let plus = 0, minus = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) plus++;
    else if (line.startsWith("-") && !line.startsWith("---")) minus++;
  }
  return plus || minus ? { plus, minus } : null;
}

function FileEntry({ file }: { file: TouchedFile }) {
  const [open, setOpen] = useState(false);
  const meta = CHANGE_META[file.change ?? "modified"] ?? CHANGE_META.modified;
  const Icon = meta.icon;
  const stat = useMemo(() => diffStat(file.diff), [file.diff]);

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <button
        type="button"
        onClick={() => file.diff && setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2.5 text-left",
          file.diff ? "cursor-pointer hover:bg-muted/50" : "cursor-default",
        )}
      >
        <Icon className={cn("h-4 w-4 shrink-0", meta.className)} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs">{file.path}</div>
          {file.summary && <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{file.summary}</div>}
        </div>
        {stat && (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-emerald-500">+{stat.plus}</span>{" "}
            <span className="text-rose-500">−{stat.minus}</span>
          </span>
        )}
        {file.diff && (
          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        )}
      </button>
      {open && file.diff && (
        <div className="border-t border-border">
          <CodeBlock lang={file.diff.includes("@@") ? "diff" : (file.language || "text")} code={file.diff} title={file.path} />
        </div>
      )}
    </div>
  );
}

export function CodingSession({ session }: { session: CodingSessionDoc }) {
  const status = session.status ?? (session.pull_request?.url ? "shipped" : "staged");
  const tone = STATUS_TONE[status] ?? STATUS_TONE.staged;
  const files = session.files ?? [];
  const plan = session.plan ?? [];
  const commands = session.commands ?? [];

  return (
    <div className="space-y-6">
      {/* Header — what shipped, where. */}
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("rounded-full border px-2 py-0.5 font-mono text-[10px]", tone.className)}>{tone.label}</span>
          {session.repository && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {session.repository}{session.branch ? ` · ${session.branch}` : ""}
            </span>
          )}
        </div>
        <h2 className="text-xl font-semibold leading-tight">{session.title || "Session de codage"}</h2>
        {session.goal && (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {session.goal}
          </p>
        )}
      </header>

      {session.summary && <p className="text-sm leading-relaxed">{session.summary}</p>}

      {/* PR + preview — the two links a reviewer actually clicks. */}
      {(session.pull_request?.url || session.preview_url) && (
        <div className="flex flex-wrap gap-2">
          {session.pull_request?.url && (
            <a
              href={session.pull_request.url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm transition-colors hover:border-primary/40"
            >
              <GitPullRequest className="h-4 w-4 text-violet-500" />
              <span className="font-medium">
                {session.pull_request.title || `Pull request #${session.pull_request.number ?? ""}`}
              </span>
              {session.pull_request.state && (
                <span className="font-mono text-[10px] text-muted-foreground">{session.pull_request.state}</span>
              )}
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            </a>
          )}
          {session.preview_url && (
            <a
              href={session.preview_url} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm transition-colors hover:border-primary/40"
            >
              <Rocket className="h-4 w-4 text-sky-500" />
              <span className="font-medium">Preview</span>
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            </a>
          )}
        </div>
      )}

      {/* Plan — what it set out to do, and how each step ended. */}
      {plan.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Plan</h3>
          <ol className="space-y-1.5">
            {plan.map((s, i) => {
              const meta = STEP_ICON[s.status ?? "done"] ?? STEP_ICON.done;
              const Icon = meta.icon;
              return (
                <li key={i} className="flex items-start gap-2.5 text-sm">
                  <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", meta.className)} />
                  <span className="min-w-0">
                    {s.step}
                    {s.detail && <span className="block text-xs text-muted-foreground">{s.detail}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {/* Files — the heart of the artifact. */}
      {files.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Fichiers · {files.length}
          </h3>
          <div className="space-y-1.5">
            {files.map((f, i) => <FileEntry key={`${f.path}-${i}`} file={f} />)}
          </div>
        </section>
      )}

      {commands.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Commandes</h3>
          <div className="space-y-1.5">
            {commands.map((c, i) => (
              <div key={i} className="rounded-xl border border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <code className="min-w-0 flex-1 truncate font-mono text-xs">{c.cmd}</code>
                  {c.ok === false
                    ? <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
                    : c.ok === true ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" /> : null}
                </div>
                {c.result && (
                  <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                    {c.result}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {(session.risks?.length || session.next_steps?.length) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {!!session.risks?.length && (
            <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" /> À vérifier
              </h3>
              <ul className="mt-2 space-y-1 text-xs leading-relaxed">
                {session.risks.map((r, i) => <li key={i}>· {r}</li>)}
              </ul>
            </section>
          )}
          {!!session.next_steps?.length && (
            <section className="rounded-xl border border-border p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Suite</h3>
              <ul className="mt-2 space-y-1 text-xs leading-relaxed">
                {session.next_steps.map((s, i) => <li key={i}>· {s}</li>)}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
