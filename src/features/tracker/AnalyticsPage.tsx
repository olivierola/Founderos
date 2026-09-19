import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCategorical, useContextGreys, foldToSlots } from "@/features/crm/overview/vizPalette";
import { cn } from "@/lib/utils";
import { Tabs } from "./ui";
import { PRIORITIES, fetchCycles, fetchIssues, fetchLabels, fetchMembers, fetchStates, type PjIssue, type PjProject, type PjState } from "./model";
import { memberName } from "./pickers";

/**
 * Les statistiques du projet.
 *
 * Toutes les répartitions passent par la palette validée du dépôt
 * (`features/crm/overview/vizPalette`) et respectent ses deux règles : les
 * couleurs sont assignées DANS L'ORDRE DES SLOTS (c'est l'ordre qui garantit la
 * lisibilité en vision déficiente, pas les teintes prises séparément), et
 * chaque segment est étiqueté en clair sous la barre — trois slots passent sous
 * 3:1 en thème clair, la couleur seule ne peut donc jamais porter la valeur.
 */

type Dimension = "state" | "priority" | "assignee" | "label" | "cycle";

const DIMENSIONS: { key: Dimension; label: string }[] = [
  { key: "state", label: "État" },
  { key: "priority", label: "Priorité" },
  { key: "assignee", label: "Assigné" },
  { key: "label", label: "Label" },
  { key: "cycle", label: "Cycle" },
];

export function AnalyticsPage({ project }: { project: PjProject }) {
  const [dimension, setDimension] = useState<Dimension>("state");

  const { data: issues } = useQuery({
    queryKey: ["pj_issues", { pjProjectId: project.id }],
    queryFn: () => fetchIssues({ pjProjectId: project.id }),
  });
  const { data: states } = useQuery({ queryKey: ["pj_states", project.id], queryFn: () => fetchStates(project.id) });
  const { data: labels } = useQuery({ queryKey: ["pj_labels", project.id], queryFn: () => fetchLabels(project.id) });
  const { data: cycles } = useQuery({ queryKey: ["pj_cycles", project.id], queryFn: () => fetchCycles(project.id) });
  const { data: members } = useQuery({
    queryKey: ["pj_members", project.workspace_id],
    queryFn: () => fetchMembers(project.workspace_id),
  });

  const all = issues ?? [];
  const stats = useHeadline(all, states ?? []);

  const distribution = useMemo(() => {
    const counts = new Map<string, number>();
    const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);

    for (const i of all) {
      switch (dimension) {
        case "state":
          bump((states ?? []).find((s) => s.id === i.state_id)?.name ?? "Sans état");
          break;
        case "priority":
          bump(PRIORITIES.find((p) => p.key === i.priority)?.label ?? "Aucune");
          break;
        case "assignee":
          if (!i.assignee_ids.length) bump("Non assigné");
          else for (const a of i.assignee_ids) {
            bump(memberName((members ?? []).find((m) => m.user_id === a), "Inconnu"));
          }
          break;
        case "label":
          if (!i.label_ids.length) bump("Sans label");
          else for (const l of i.label_ids) {
            bump((labels ?? []).find((x) => x.id === l)?.name ?? "Label");
          }
          break;
        case "cycle":
          bump((cycles ?? []).find((c) => c.id === i.cycle_id)?.name ?? "Hors cycle");
          break;
      }
    }
    // foldToSlots empêche qu'une 9e catégorie invente une 9e teinte.
    return foldToSlots([...counts.entries()].map(([label, count]) => ({ label, count })));
  }, [all, dimension, states, labels, members, cycles]);

  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      <div className="grid gap-3 pb-5 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Work items" value={stats.total} />
        <Tile label="Terminés" value={stats.completed} hint={`${stats.percent}% du total`} />
        <Tile label="En cours" value={stats.started} />
        <Tile label="En retard" value={stats.overdue} tone={stats.overdue > 0 ? "warn" : undefined} />
      </div>

      <section className="rounded-lg border border-border/70 p-4">
        <header className="flex flex-wrap items-center justify-between gap-2 pb-4">
          <h3 className="text-14 font-medium">Répartition</h3>
          <Tabs value={dimension} onChange={setDimension} options={DIMENSIONS} />
        </header>

        <Distribution items={distribution} />
      </section>

      <section className="mt-4 rounded-lg border border-border/70 p-4">
        <h3 className="pb-4 text-14 font-medium">Avancement par état</h3>
        <StateBreakdown issues={all} states={states ?? []} />
      </section>
    </div>
  );
}

function useHeadline(issues: PjIssue[], states: PjState[]) {
  return useMemo(() => {
    const groupOf = new Map(states.map((s) => [s.id, s.group]));
    const today = new Date().toISOString().slice(0, 10);
    const completed = issues.filter((i) => groupOf.get(i.state_id ?? "") === "completed").length;
    return {
      total: issues.length,
      completed,
      started: issues.filter((i) => groupOf.get(i.state_id ?? "") === "started").length,
      overdue: issues.filter((i) =>
        i.target_date && !i.completed_at && i.target_date.slice(0, 10) < today).length,
      percent: issues.length ? Math.round((completed / issues.length) * 100) : 0,
    };
  }, [issues, states]);
}

function Tile({
  label, value, hint, tone,
}: { label: string; value: number; hint?: string; tone?: "warn" }) {
  return (
    <div className="rounded-lg border border-border/70 p-3">
      <p className="text-11 text-muted-foreground">{label}</p>
      <p className={cn("pt-1 text-24 font-semibold tabular-nums", tone === "warn" && "text-amber-600")}>
        {value}
      </p>
      {hint && <p className="text-11 text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Une barre empilée + les lignes détaillées dessous.
 *
 * Les lignes ne sont pas une redondance décorative : ce sont ELLES qui portent
 * la valeur, la barre n'étant qu'un aperçu des proportions. C'est la mitigation
 * documentée par la palette pour les slots sous 3:1 en thème clair.
 */
function Distribution({ items }: { items: { label: string; count: number }[] }) {
  const palette = useCategorical();
  const greys = useContextGreys();
  const total = items.reduce((s, i) => s + i.count, 0);

  if (!total) {
    return <p className="py-6 text-center text-14 text-muted-foreground">Aucune donnée.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex h-2.5 overflow-hidden rounded-full" style={{ background: greys.empty }}>
        {items.map((item, index) => (
          <span
            key={item.label}
            style={{ width: `${(item.count / total) * 100}%`, background: palette[index % palette.length] }}
          />
        ))}
      </div>
      <ul className="space-y-1.5">
        {items.map((item, index) => (
          <li key={item.label} className="flex items-center gap-2 text-12">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: palette[index % palette.length] }}
            />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {item.count} · {Math.round((item.count / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StateBreakdown({ issues, states }: { issues: PjIssue[]; states: PjState[] }) {
  const rows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of issues) counts.set(i.state_id ?? "", (counts.get(i.state_id ?? "") ?? 0) + 1);
    return states.map((s) => ({ state: s, count: counts.get(s.id) ?? 0 }));
  }, [issues, states]);

  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <ul className="space-y-2">
      {rows.map(({ state, count }) => (
        <li key={state.id} className="grid grid-cols-[140px_1fr_44px] items-center gap-2 text-12">
          <span className="truncate">{state.name}</span>
          {/* La couleur vient de l'état lui-même, définie par le projet : ce
              n'est pas une série catégorielle, la palette ne s'applique pas. */}
          <span className="h-2 rounded-full bg-muted">
            <span
              className="block h-2 rounded-full"
              style={{ width: `${(count / max) * 100}%`, background: state.color }}
            />
          </span>
          <span className="text-right tabular-nums text-muted-foreground">{count}</span>
        </li>
      ))}
    </ul>
  );
}
