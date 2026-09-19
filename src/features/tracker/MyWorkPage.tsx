import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UserIcon, WarningIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { IssueKey, PriorityIcon, StateIcon, formatDate } from "./pickers";
import { Tabs } from "./ui";
import { DoneIllustration } from "./illustrations";
import { fetchMyWork, type MyWorkRow } from "./model";
import { EmptyState } from "./ui";

/**
 * « Votre travail » : ce qui m'est assigné, tous projets confondus.
 *
 * L'agrégat descend en base (`pj_my_work`, migration 0223) parce que la
 * question traverse les projets : la poser côté client obligerait à charger
 * tous les projets puis tous leurs items pour n'en garder qu'une poignée.
 *
 * L'ordre vient du serveur et n'est pas alphabétique : ce qui a déjà glissé
 * d'abord, puis ce qui va glisser, puis le reste par priorité. C'est l'ordre
 * dans lequel on veut lire sa propre liste.
 */

const TABS: { key: string; label: string }[] = [
  { key: "open", label: "En cours" },
  { key: "overdue", label: "En retard" },
  { key: "done", label: "Terminés" },
];

export function MyWorkPage({
  dashboardId, onOpenProject,
}: { dashboardId: string; onOpenProject: (id: string) => void }) {
  const [tab, setTab] = useState("open");

  const { data: rows, isLoading } = useQuery({
    queryKey: ["pj_my_work", dashboardId],
    queryFn: () => fetchMyWork(dashboardId),
  });

  const today = new Date().toISOString().slice(0, 10);
  const all = rows ?? [];

  const buckets = useMemo(() => {
    const open = all.filter((r) => r.state_group !== "completed" && r.state_group !== "cancelled");
    return {
      open,
      overdue: open.filter((r) => r.target_date && r.target_date.slice(0, 10) < today),
      done: all.filter((r) => r.state_group === "completed"),
    };
  }, [all, today]);

  const shown = buckets[tab as keyof typeof buckets] ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
        <UserIcon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-14 font-medium">Votre travail</h2>
        <Tabs
          className="ml-3"
          value={tab} onChange={setTab}
          options={TABS.map((t) => ({ ...t, count: buckets[t.key as keyof typeof buckets].length }))}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-4xl">
          {isLoading ? (
            <p className="py-10 text-center text-14 text-muted-foreground">Chargement…</p>
          ) : !shown.length ? (
            <EmptyState
              illustration={<DoneIllustration className="w-full" />}
              title={tab === "overdue"
                ? "Rien n'est en retard"
                : "Aucun work item ne vous est assigné"}
              hint={tab === "overdue"
                ? "Les work items dont l'échéance est passée apparaîtront ici, les plus anciens en premier."
                : "Ce dont vous êtes responsable se retrouve ici, tous projets confondus, sans avoir à ouvrir chaque board."}
            />
          ) : (
            <ul className="rounded-lg border border-border/70">
              {shown.map((r) => (
                <Row key={r.issue_id} row={r} today={today} onOpen={() => onOpenProject(r.pj_project_id)} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ row, today, onOpen }: { row: MyWorkRow; today: string; onOpen: () => void }) {
  const late = row.target_date && !row.completed_at && row.target_date.slice(0, 10) < today;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2 border-b border-border/40 px-3 py-2 text-left last:border-0 hover:bg-muted/50"
      >
        {row.state_group && <StateIcon group={row.state_group} color={row.state_color ?? undefined} />}
        <IssueKey identifier={row.identifier} sequenceId={row.sequence_id} />
        <span className={cn("min-w-0 flex-1 truncate text-13", row.completed_at && "text-muted-foreground")}>
          {row.name}
        </span>
        <span className="shrink-0 text-11 text-muted-foreground">{row.project_name}</span>
        <PriorityIcon priority={row.priority} />
        {row.target_date && (
          <span className={cn(
            "flex shrink-0 items-center gap-1 text-11",
            late ? "text-red-600" : "text-muted-foreground",
          )}>
            {late && <WarningIcon className="h-3 w-3" />}
            {formatDate(row.target_date)}
          </span>
        )}
      </button>
    </li>
  );
}
