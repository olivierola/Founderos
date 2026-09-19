import { useMemo, useState } from "react";
import { CaretLeftIcon, CaretRightIcon, PlusIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { AssigneeStack, PriorityIcon, type LayoutProps } from "./shared";
import type { PjIssue } from "../model";

/**
 * Le calendrier : les work items posés sur leur date d'échéance.
 *
 * Il ne montre QUE ce qui a une échéance, et c'est le point. Un calendrier qui
 * répartirait aussi les items sans date — au jour de création, par exemple —
 * donnerait un mois plein où l'on ne distingue plus les vraies échéances. Le
 * compteur des non datés est affiché à part, pour qu'on sache ce qui manque à
 * l'appel plutôt que de le deviner.
 *
 * La semaine commence le lundi : c'est la convention ISO, et c'est celle des
 * cycles de travail que l'écran sert à lire.
 */

const WEEKDAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

export function CalendarLayout(props: LayoutProps) {
  const { groups, states, members, properties, onOpen, onQuickCreate, project } = props;
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));

  const issues = useMemo(() => groups.flatMap((g) => g.issues), [groups]);

  const byDay = useMemo(() => {
    const map = new Map<string, PjIssue[]>();
    for (const issue of issues) {
      if (!issue.target_date) continue;
      const day = issue.target_date.slice(0, 10);
      const list = map.get(day);
      if (list) list.push(issue); else map.set(day, [issue]);
    }
    return map;
  }, [issues]);

  const undated = issues.filter((i) => !i.target_date).length;
  const cells = useMemo(() => monthGrid(cursor), [cursor]);
  const today = new Date().toISOString().slice(0, 10);
  const month = cursor.getMonth();

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pb-3">
        <h3 className="text-14 font-medium capitalize">
          {cursor.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}
        </h3>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setCursor(addMonths(cursor, -1))}
            aria-label="Mois précédent"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <CaretLeftIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setCursor(addMonths(cursor, 1))}
            aria-label="Mois suivant"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <CaretRightIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setCursor(startOfMonth(new Date()))}
            className="ml-1 h-7 rounded-md border border-border px-2 text-12 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Aujourd&apos;hui
          </button>
        </div>

        <div className="flex-1" />

        {undated > 0 && (
          <span className="text-11 text-muted-foreground">
            {undated} sans échéance, non affiché{undated > 1 ? "s" : ""}
          </span>
        )}
      </div>

      <div className="grid shrink-0 grid-cols-7 border-y border-border">
        {WEEKDAYS.map((d) => (
          <div
            key={d}
            className="flex h-11 items-center justify-end border-r border-border/50 px-3 text-12 font-medium text-muted-foreground last:border-r-0"
          >
            {d}
          </div>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-[repeat(auto-fit,minmax(0,1fr))] overflow-y-auto">
        {cells.map((date) => {
          const key = date.toISOString().slice(0, 10);
          const dayIssues = byDay.get(key) ?? [];
          const isToday = key === today;
          // Les jours des mois voisins restent visibles mais en retrait : les
          // masquer casserait la grille de sept colonnes, les afficher au même
          // niveau ferait croire qu'ils appartiennent au mois courant.
          const outside = date.getMonth() !== month;

          return (
            <DayCell
              key={key}
              date={date}
              dayKey={key}
              issues={dayIssues}
              states={states}
              members={members}
              properties={properties}
              isToday={isToday}
              outside={outside}
              onOpen={onOpen}
              onQuickCreate={onQuickCreate}
            />
          );
        })}
      </div>
    </div>
  );
}

function DayCell({
  date, dayKey, issues, states, members, properties, isToday, outside, onOpen, onQuickCreate,
}: {
  date: Date;
  dayKey: string;
  issues: PjIssue[];
  isToday: boolean;
  outside: boolean;
} & Pick<LayoutProps, "states" | "members" | "properties" | "onOpen" | "onQuickCreate">) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  return (
    <div
      className={cn(
        "group/day flex min-h-[120px] flex-col border-b border-r border-border/50 p-1",
        outside && "bg-muted/20",
      )}
    >
      <div className="flex items-center justify-end gap-1 px-1 pb-1">
        <button
          type="button"
          onClick={() => setAdding(true)}
          aria-label="Nouveau work item ce jour"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover/day:opacity-100"
        >
          <PlusIcon className="h-3.5 w-3.5" />
        </button>
        <span className={cn(
          "flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-11 tabular-nums",
          isToday
            ? "bg-primary font-medium text-primary-foreground"
            : outside ? "text-muted-foreground/50" : "text-muted-foreground",
        )}>
          {date.getDate()}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {issues.map((issue) => {
          const state = states.find((s) => s.id === issue.state_id);
          return (
            <button
              key={issue.id}
              type="button"
              onClick={() => onOpen(issue)}
              className="flex w-full items-center gap-1.5 rounded-sm border border-border/50 bg-card px-1 py-1 text-left transition-colors hover:border-border"
            >
              {/* Le liseré porte l'état : sur un bloc d'une ligne, c'est le seul
                  endroit où une couleur tient sans écraser le titre. */}
              <span
                className="h-3.5 w-0.5 shrink-0 rounded-full"
                style={{ background: state?.color ?? "hsl(var(--muted-foreground))" }}
              />
              <span className={cn(
                "min-w-0 flex-1 truncate text-11",
                issue.completed_at && "text-muted-foreground line-through",
              )}>
                {issue.name}
              </span>
              {properties.priority && issue.priority !== "none" && (
                <PriorityIcon priority={issue.priority} className="h-3 w-3" />
              )}
              {properties.assignee && issue.assignee_ids.length > 0 && (
                <AssigneeStack ids={issue.assignee_ids} members={members} max={1} />
              )}
            </button>
          );
        })}

        {adding && (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Enter" && title.trim()) {
                // Le groupe passé est la DATE : créer depuis une case du
                // calendrier doit poser l'échéance de cette case, sinon l'item
                // disparaît de l'écran où on vient de le saisir.
                await onQuickCreate(dayKey, title.trim());
                setTitle("");
              }
              if (e.key === "Escape") { setTitle(""); setAdding(false); }
            }}
            onBlur={() => { if (!title.trim()) setAdding(false); }}
            placeholder="Titre…"
            className="w-full rounded-sm border border-border bg-card px-1 py-1 text-11 outline-none"
          />
        )}
      </div>
    </div>
  );
}

// ── Calendrier ──────────────────────────────────────────────────────────────

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/**
 * Les six semaines d'une grille de mois.
 *
 * Toujours six, jamais cinq : une grille dont la hauteur change d'un mois à
 * l'autre fait sauter tout ce qui l'entoure quand on navigue, ce qui est
 * précisément le geste qu'on répète sur un calendrier.
 */
function monthGrid(cursor: Date): Date[] {
  const first = startOfMonth(cursor);
  // getDay() rend 0 pour dimanche ; on décale pour une semaine qui commence
  // lundi, conformément à l'ISO.
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);

  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}
