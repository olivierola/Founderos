import { useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import type { RoomMilestone, RoomTask, TaskStatus } from "./model";

// Milestone timeline — the mission's plan as a graph.
//
// Rows are the mission's MILESTONES (jalons), each followed by the tasks it
// holds; the horizontal axis is real time. A milestone bar is the planned
// window the orchestrator committed to at planning time; a task bar is either
// its real execution window (once it has run) or its slot inside the parent
// milestone (before it has). Dependencies are drawn as connectors between task
// bars, so "what is waiting on what" is visible rather than inferred.
//
// Self-contained on purpose: no timeline library, no new dependency, no drag
// engine. The plan here is authored by the orchestrator and moved by the agents
// that execute it — a human dragging a bar would be editing a schedule nobody
// reads. Rescheduling happens on the kanban, where it means something.

const ROW_H = 34;          // milestone row height (px)
const TASK_H = 28;         // task row height
const MIN_DAY_W = 26;      // px per day at the narrowest zoom
const LABEL_W = 232;       // left column width

type Row =
  | { kind: "milestone"; id: string; ms: RoomMilestone; start: Date; end: Date }
  | { kind: "task"; id: string; task: RoomTask; start: Date; end: Date; milestoneId: string | null };

const STATUS_BAR: Record<TaskStatus, string> = {
  todo: "bg-muted-foreground/25",
  in_progress: "bg-sky-500",
  waiting: "bg-sky-500/40",
  review: "bg-amber-500",
  blocked: "bg-red-500/70",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  skipped: "bg-muted-foreground/30",
};

const MS_BAR: Record<RoomMilestone["status"], string> = {
  pending: "bg-primary/25",
  active: "bg-primary/60",
  done: "bg-emerald-500/60",
  blocked: "bg-red-500/50",
};

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const DAY = 86400000;

function fmtDay(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(d);
}

/**
 * Lay the mission out on a real time axis.
 *
 * A milestone with no dates (a plan written before 0179's estimates, or an
 * import) still has to draw, so it falls back to a one-day slot after the
 * previous one — an approximate bar beats an empty row.
 */
function useLayout(milestones: RoomMilestone[], tasks: RoomTask[]) {
  return useMemo(() => {
    const now = new Date();
    const rows: Row[] = [];
    const byMilestone = new Map<string | null, RoomTask[]>();
    for (const t of tasks) {
      const k = t.milestone_id;
      byMilestone.set(k, [...(byMilestone.get(k) ?? []), t]);
    }

    let cursor = startOfDay(now);
    for (const ms of milestones) {
      const start = ms.starts_at ? new Date(ms.starts_at) : cursor;
      const end = ms.ends_at ? new Date(ms.ends_at) : addDays(start, 1);
      cursor = end;
      rows.push({ kind: "milestone", id: ms.id, ms, start, end });

      const own = byMilestone.get(ms.id) ?? [];
      const span = Math.max(end.getTime() - start.getTime(), DAY);
      own.forEach((task, i) => {
        // Real window once the task has run; otherwise its share of the parent
        // milestone, so the plan reads as a sequence before anything executes.
        const slot = span / own.length;
        const tStart = task.started_at ? new Date(task.started_at) : new Date(start.getTime() + i * slot);
        const tEnd = task.finished_at
          ? new Date(task.finished_at)
          : task.started_at
          ? new Date(Math.max(now.getTime(), tStart.getTime() + slot * 0.4))
          : new Date(tStart.getTime() + slot);
        rows.push({ kind: "task", id: task.id, task, start: tStart, end: tEnd, milestoneId: ms.id });
      });
    }
    // Tasks the orchestrator never attached to a milestone still belong on the
    // board — silently dropping them would hide real work.
    const orphans = byMilestone.get(null) ?? [];
    orphans.forEach((task, i) => {
      const tStart = task.started_at ? new Date(task.started_at) : addDays(cursor, i);
      const tEnd = task.finished_at ? new Date(task.finished_at) : addDays(tStart, 1);
      rows.push({ kind: "task", id: task.id, task, start: tStart, end: tEnd, milestoneId: null });
    });

    const times = rows.flatMap((r) => [r.start.getTime(), r.end.getTime()]);
    const t0 = startOfDay(new Date(Math.min(...times, now.getTime())));
    const t1 = addDays(startOfDay(new Date(Math.max(...times, now.getTime()))), 1);
    const days = Math.max(1, Math.round((t1.getTime() - t0.getTime()) / DAY));
    return { rows, t0, t1, days, now };
  }, [milestones, tasks]);
}

export function MissionTimeline({
  milestones, tasks, agentName, onOpenTask,
}: {
  milestones: RoomMilestone[];
  tasks: RoomTask[];
  agentName: (id: string | null) => string | undefined;
  onOpenTask?: (task: RoomTask) => void;
}) {
  const { rows, t0, days, now } = useLayout(milestones, tasks);
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);

  if (rows.length === 0) {
    return <p className="py-16 text-center text-sm text-muted-foreground">Aucun jalon planifié.</p>;
  }

  const dayW = MIN_DAY_W * zoom;
  const width = days * dayW;
  const x = (d: Date) => ((d.getTime() - t0.getTime()) / DAY) * dayW;

  // Row tops, so the dependency overlay can find any task's bar without a
  // second layout pass.
  const tops: number[] = [];
  let acc = 0;
  for (const r of rows) { tops.push(acc); acc += r.kind === "milestone" ? ROW_H : TASK_H; }
  const totalH = acc;
  const rowIndex = new Map(rows.map((r, i) => [r.id, i]));

  const links = rows.flatMap((r, i) => {
    if (r.kind !== "task") return [];
    return r.task.depends_on.flatMap((depId) => {
      const j = rowIndex.get(depId);
      if (j == null) return [];
      const from = rows[j];
      if (from.kind !== "task") return [];
      return [{
        key: `${depId}->${r.id}`,
        x1: x(from.end), y1: tops[j] + TASK_H / 2,
        x2: x(r.start), y2: tops[i] + TASK_H / 2,
        satisfied: from.task.status === "done" || from.task.status === "skipped",
      }];
    });
  });

  const dayTicks = Array.from({ length: days + 1 }, (_, i) => addDays(t0, i));

  return (
    <div className="rounded-xl border border-border/60 bg-card">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          {milestones.length} jalon(s) · {tasks.length} tâche(s)
        </span>
        <div className="flex items-center gap-1">
          <ZoomButton label="−" onClick={() => setZoom((z) => Math.max(0.6, z - 0.3))} />
          <span className="w-10 text-center text-[11px] tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
          <ZoomButton label="+" onClick={() => setZoom((z) => Math.min(4, z + 0.3))} />
        </div>
      </div>

      <div className="flex">
        {/* Left: the tree of jalons and their tasks */}
        <div className="shrink-0 border-r border-border/60" style={{ width: LABEL_W }}>
          <div className="h-8 border-b border-border/60" />
          {rows.map((r) => (
            <div
              key={r.id}
              className={cn(
                "flex items-center gap-2 border-b border-border/40 px-3",
                r.kind === "task" && "pl-6",
                r.kind === "task" && onOpenTask && "cursor-pointer hover:bg-muted/50",
              )}
              style={{ height: r.kind === "milestone" ? ROW_H : TASK_H }}
              onClick={r.kind === "task" && onOpenTask ? () => onOpenTask(r.task) : undefined}
            >
              {r.kind === "milestone" ? (
                <>
                  <span className="h-2 w-2 shrink-0 rotate-45 rounded-[2px] bg-primary" />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold">{r.ms.title}</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">{r.ms.progress}%</span>
                </>
              ) : (
                <>
                  <AgentIdentity url={null} seed={agentName(r.task.agent_id) ?? "?"} size={16} rounded="rounded-full" />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{r.task.title}</span>
                </>
              )}
            </div>
          ))}
        </div>

        {/* Right: the time axis */}
        <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto">
          <div style={{ width }} className="relative">
            {/* Day header */}
            <div className="sticky top-0 z-10 flex h-8 border-b border-border/60 bg-card">
              {dayTicks.slice(0, -1).map((d, i) => (
                <div
                  key={i}
                  className={cn(
                    "shrink-0 border-r border-border/40 px-1 text-[10px] leading-8 text-muted-foreground",
                    (d.getDay() === 0 || d.getDay() === 6) && "bg-muted/40",
                  )}
                  style={{ width: dayW }}
                >
                  {dayW >= 44 ? fmtDay(d) : d.getDate()}
                </div>
              ))}
            </div>

            <div className="relative" style={{ height: totalH }}>
              {/* Gridlines */}
              {dayTicks.slice(0, -1).map((d, i) => (
                <div
                  key={i}
                  className={cn("absolute top-0 bottom-0 border-r border-border/30", (d.getDay() === 0 || d.getDay() === 6) && "bg-muted/30")}
                  style={{ left: i * dayW, width: dayW }}
                />
              ))}
              {/* Now */}
              <div className="absolute top-0 bottom-0 z-20 w-px bg-red-500/70" style={{ left: x(now) }} />

              {/* Dependency connectors — drawn under the bars so a bar always
                  wins the click, and dashed while unsatisfied so a blocked
                  chain reads at a glance. */}
              <svg className="pointer-events-none absolute inset-0" width={width} height={totalH}>
                {links.map((l) => {
                  const midX = Math.max(l.x1 + 8, l.x2 - 8);
                  return (
                    <path
                      key={l.key}
                      d={`M ${l.x1} ${l.y1} H ${midX} V ${l.y2} H ${l.x2}`}
                      fill="none"
                      strokeWidth={1.25}
                      strokeDasharray={l.satisfied ? undefined : "3 3"}
                      className={l.satisfied ? "stroke-emerald-500/50" : "stroke-muted-foreground/50"}
                    />
                  );
                })}
              </svg>

              {/* Bars */}
              {rows.map((r, i) => {
                const left = x(r.start);
                const w = Math.max(6, x(r.end) - left);
                const top = tops[i];
                if (r.kind === "milestone") {
                  return (
                    <div key={r.id} className="absolute" style={{ left, top: top + 9, width: w, height: 16 }}>
                      <div className={cn("h-full w-full overflow-hidden rounded-md", MS_BAR[r.ms.status])}>
                        <div className="h-full bg-primary/70" style={{ width: `${r.ms.progress}%` }} />
                      </div>
                    </div>
                  );
                }
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={onOpenTask ? () => onOpenTask(r.task) : undefined}
                    title={`${r.task.title} — ${r.task.status}`}
                    className={cn(
                      "absolute rounded-[5px] text-left transition-opacity hover:opacity-80",
                      STATUS_BAR[r.task.status],
                    )}
                    style={{ left, top: top + 8, width: w, height: 12 }}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <Legend />
    </div>
  );
}

function ZoomButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button" onClick={onClick}
      className="h-6 w-6 rounded-md border border-border/60 text-xs text-muted-foreground hover:bg-muted"
    >{label}</button>
  );
}

function Legend() {
  const items: Array<[string, string]> = [
    ["À faire", STATUS_BAR.todo], ["En cours", STATUS_BAR.in_progress],
    ["Bloqué", STATUS_BAR.blocked], ["Terminé", STATUS_BAR.done], ["Échec", STATUS_BAR.failed],
  ];
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border/60 px-3 py-2">
      {items.map(([label, tone]) => (
        <span key={label} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className={cn("h-2 w-4 rounded-sm", tone)} /> {label}
        </span>
      ))}
      <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="h-3 w-px bg-red-500/70" /> aujourd'hui
      </span>
    </div>
  );
}

export function TimelineEmpty({ children }: { children: ReactNode }) {
  return <div className="py-16 text-center text-sm text-muted-foreground">{children}</div>;
}
