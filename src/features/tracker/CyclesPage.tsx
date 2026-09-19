import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowsClockwiseIcon, CalendarBlankIcon, CaretDownIcon, CaretRightIcon,
  DotsThreeIcon, MagnifyingGlassIcon, PlusIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { IssuesBoard } from "./IssuesBoard";
import { DatePicker, MemberAvatar, formatDate } from "./pickers";
import { EmptyState, Modal, Tabs, TextAreaField, TextField } from "./ui";
import { CycleIllustration } from "./illustrations";
import { ProgressRing } from "./cycles/ProgressRing";
import { CycleBreakdown, type CycleStats } from "./cycles/CycleBreakdown";
import { CycleChart, type ChartMode, type CyclePoint } from "./cycles/CycleChart";
import { CycleStatsPanel } from "./cycles/CycleStats";
import { TransferIssues } from "./cycles/TransferIssues";
import { archiveCycle } from "./model";
import { AddExistingIssues } from "./cycles/AddExisting";
import {
  createCycle, cyclePhase, deleteCycle, fetchCycles, fetchIssues, fetchLabels,
  fetchMembers, fetchStates, updateCycle,
  type PjCycle, type PjIssue, type PjLabel, type PjProject, type PjState,
} from "./model";

/**
 * Les cycles : les itérations bornées dans le temps.
 *
 * Un cycle n'est pas un dossier — c'est une PROMESSE datée. D'où l'écran :
 * trois onglets qui correspondent aux trois moments d'une promesse (à venir,
 * en cours, tenue ou non), et le cycle actif déplié par défaut avec sa courbe.
 *
 * Le cycle actif est le seul qu'on ouvre en grand parce que c'est le seul sur
 * lequel on peut encore agir. Les à-venir n'ont rien à montrer, les terminés
 * n'ont plus rien à corriger.
 */

type Tab = "active" | "upcoming" | "completed";

const TABS: { key: Tab; label: string }[] = [
  { key: "active", label: "Actifs" },
  { key: "upcoming", label: "À venir" },
  { key: "completed", label: "Terminés" },
];

export function CyclesPage({ project }: { project: PjProject }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("active");
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  const { data: cycles } = useQuery({
    queryKey: ["pj_cycles", project.id],
    queryFn: () => fetchCycles(project.id),
  });
  const { data: states } = useQuery({
    queryKey: ["pj_states", project.id],
    queryFn: () => fetchStates(project.id),
  });
  const { data: members } = useQuery({
    queryKey: ["pj_members", project.workspace_id],
    queryFn: () => fetchMembers(project.workspace_id),
  });
  const { data: labels } = useQuery({
    queryKey: ["pj_labels", project.id],
    queryFn: () => fetchLabels(project.id),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_cycles", project.id] });

  const grouped = useMemo(() => {
    const list = (cycles ?? []).filter((c) =>
      !query.trim() || c.name.toLowerCase().includes(query.toLowerCase()));
    return {
      active: list.filter((c) => cyclePhase(c) === "current"),
      upcoming: list.filter((c) => cyclePhase(c) === "upcoming" || cyclePhase(c) === "draft"),
      completed: list.filter((c) => cyclePhase(c) === "completed"),
    };
  }, [cycles, query]);

  const shown = grouped[tab];

  return (
    <div className="flex h-full flex-col">
      {/* Onglets soulignés et non segmentés : ce sont trois MOMENTS d'un même
          objet, pas trois filtres interchangeables, et le soulignement dit
          mieux « on est ici dans une chronologie ». */}
      <div className="flex h-header shrink-0 items-center gap-1 border-b border-border px-4">
        <Tabs
          value={tab} onChange={setTab}
          options={TABS.map((t) => ({ ...t, count: grouped[t.key].length }))}
        />

        <div className="flex-1" />

        {searching || query ? (
          <div className="relative w-52">
            <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <TextField
              autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
              onBlur={() => { if (!query) setSearching(false); }}
              placeholder="Rechercher un cycle…" className="h-8 pl-8 text-13"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setSearching(true)}
            title="Rechercher"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <MagnifyingGlassIcon className="h-4 w-4" />
          </button>
        )}

        <Button size="sm" className="h-8 gap-1.5" onClick={() => setCreating(true)}>
          <PlusIcon className="h-4 w-4" /> Ajouter un cycle
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!shown.length ? (
          <EmptyState
            illustration={<CycleIllustration className="w-full" />}
            title={
              tab === "active" ? "Aucun cycle en cours"
                : tab === "upcoming" ? "Aucun cycle à venir"
                : "Aucun cycle terminé"
            }
            hint="Un cycle borne une itération dans le temps : on y met ce qu'on s'engage à livrer d'ici sa date de fin."
            action={
              tab !== "completed"
                ? <Button size="sm" onClick={() => setCreating(true)}>Créer un cycle</Button>
                : undefined
            }
          />
        ) : (
          shown.map((cycle) => (
            <CycleRow
              key={cycle.id}
              cycle={cycle}
              project={project}
              states={states ?? []}
              members={members ?? []}
              labels={labels ?? []}
              defaultOpen={tab === "active"}
              onChanged={refresh}
            />
          ))
        )}
      </div>

      {creating && (
        <CycleDialog project={project} onClose={() => setCreating(false)} onSaved={refresh} />
      )}
    </div>
  );
}

function CycleRow({
  cycle, project, states, members, labels, defaultOpen, onChanged,
}: {
  cycle: PjCycle;
  project: PjProject;
  states: PjState[];
  members: Awaited<ReturnType<typeof fetchMembers>>;
  labels: PjLabel[];
  defaultOpen: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [mode, setMode] = useState<ChartMode>("build-up");
  const [editing, setEditing] = useState(false);
  const [board, setBoard] = useState(false);
  const [adding, setAdding] = useState(false);

  const { data: issues } = useQuery({
    queryKey: ["pj_issues", { pjProjectId: project.id, cycleId: cycle.id }],
    queryFn: () => fetchIssues({ pjProjectId: project.id, cycleId: cycle.id }),
  });

  const stats = useCycleStats(issues ?? [], states, cycle);
  const points = useCyclePoints(issues ?? [], cycle);
  const owner = members.find((m) => m.user_id === cycle.owned_by);

  const percent = stats.scope ? Math.round((stats.done / stats.scope) * 100) : 0;
  const delta = stats.done - stats.idealDone;

  return (
    <section className="border-b border-border last:border-0">
      <header className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted"
          aria-label={open ? "Replier" : "Déplier"}
        >
          {open ? <CaretDownIcon className="h-4 w-4" /> : <CaretRightIcon className="h-4 w-4" />}
        </button>

        <ProgressRing
          percent={percent}
          tone={delta > 0 ? "ahead" : delta < 0 ? "behind" : "neutral"}
        />

        <button
          type="button"
          onClick={() => setBoard((v) => !v)}
          className="min-w-0 flex-1 text-left"
        >
          <h3 className="truncate text-14 font-medium hover:underline">{cycle.name}</h3>
          {cycle.description && (
            <p className="truncate text-11 text-muted-foreground">{cycle.description}</p>
          )}
        </button>

        <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-md border border-border/70 px-2 text-11 leading-none text-muted-foreground">
          <CalendarBlankIcon className="h-3 w-3" />
          {formatDate(cycle.start_date)} – {formatDate(cycle.end_date)}
        </span>

        {/* Verser du backlog dans le cycle : c'est le geste de la
            planification, et il n'existait nulle part — on ne pouvait que créer
            des items DANS le cycle, donc réécrire ce qui existait déjà. */}
        <button
          type="button"
          onClick={() => setAdding(true)}
          title="Ajouter des work items existants"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-11 font-medium text-secondary hover:bg-muted hover:text-foreground"
        >
          <PlusIcon className="h-3.5 w-3.5" /> Ajouter des work items
        </button>

        <TransferIssues
          cycle={cycle}
          issues={issues ?? []}
          projectId={project.id}
          workspaceId={project.workspace_id}
          onDone={onChanged}
        />

        {owner && <MemberAvatar member={owner} />}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted">
              <DotsThreeIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setBoard((v) => !v)}>
              {board ? "Masquer les work items" : "Voir les work items"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setAdding(true)}>
              Ajouter des work items existants
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setEditing(true)}>Modifier</DropdownMenuItem>
            {/* Archiver plutôt que supprimer : un cycle passé porte le bilan
                d'une itération, et le détruire efface ce qu'on a livré à cette
                période — l'information qu'on vient justement chercher un an
                plus tard. */}
            <DropdownMenuItem onClick={async () => { await archiveCycle(cycle.id); onChanged(); }}>
              Archiver
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-red-600"
              onClick={async () => { await deleteCycle(cycle.id); onChanged(); }}
            >
              Supprimer
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {adding && (
        <AddExistingIssues
          project={project}
          target={{ kind: "cycle", id: cycle.id, name: cycle.name }}
          onClose={() => setAdding(false)}
          onDone={onChanged}
        />
      )}

      {open && (
        <div className="grid gap-6 border-t border-border/50 px-4 py-4 lg:grid-cols-[300px_1fr_300px]">
          <CycleBreakdown stats={stats} />

          <div className="min-w-0">
            <div className="flex items-center gap-2 pb-3">
              <Popover>
                <PopoverTrigger asChild>
                  <button className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-12 hover:bg-muted">
                    {mode === "build-up" ? "Cumul" : "Reste à faire"}
                    <CaretDownIcon className="h-3 w-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-56 p-1" align="start">
                  <ModeOption
                    active={mode === "build-up"} onSelect={() => setMode("build-up")}
                    label="Cumul" hint="Ce qui est terminé s'accumule."
                  />
                  <ModeOption
                    active={mode === "burn-down"} onSelect={() => setMode("burn-down")}
                    label="Reste à faire" hint="Ce qui manque s'épuise vers zéro."
                  />
                </PopoverContent>
              </Popover>
              <span className="text-12 text-muted-foreground">pour les work items</span>
            </div>

            {cycle.start_date && cycle.end_date ? (
              <CycleChart
                points={points}
                scope={stats.scope}
                mode={mode}
                startDate={cycle.start_date}
                endDate={cycle.end_date}
              />
            ) : (
              <p className="py-10 text-center text-12 text-muted-foreground">
                La courbe demande une date de début et une date de fin.
              </p>
            )}
          </div>

          {/* La troisième colonne répond à « qui » et « quoi », là où les deux
              premières répondent à « combien » et « quand ». */}
          <CycleStatsPanel
            issues={issues ?? []}
            states={states}
            members={members}
            labels={labels}
          />
        </div>
      )}

      {board && (
        <div className="h-[560px] border-t border-border">
          <IssuesBoard
            project={project}
            scope={{ pjProjectId: project.id, cycleId: cycle.id }}
            scopeKey={`cycle-${cycle.id}`}
            boardTitle={cycle.name}
            emptyHint="Aucun work item dans ce cycle."
          />
        </div>
      )}

      {editing && (
        <CycleDialog
          project={project} cycle={cycle}
          onClose={() => setEditing(false)} onSaved={onChanged}
        />
      )}
    </section>
  );
}

function ModeOption({
  active, onSelect, label, hint,
}: { active: boolean; onSelect: () => void; label: string; hint: string }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col items-start rounded px-2 py-1.5 text-left",
        active ? "bg-muted" : "hover:bg-muted",
      )}
    >
      <span className={cn("text-12", active && "font-medium")}>{label}</span>
      <span className="text-10 text-muted-foreground">{hint}</span>
    </button>
  );
}

/**
 * Les chiffres d'un cycle, l'idéal du jour compris.
 *
 * L'idéal est linéaire : à mi-parcours, la moitié du périmètre. C'est une
 * convention grossière et c'est voulu — toute autre courbe (montée lente puis
 * accélération) supposerait de connaître la façon de travailler de l'équipe, et
 * donnerait un repère qui a l'air savant sans être plus juste.
 */
function useCycleStats(issues: PjIssue[], states: PjState[], cycle: PjCycle): CycleStats {
  return useMemo(() => {
    const groupOf = new Map(states.map((s) => [s.id, s.group]));
    const count = (g: string) => issues.filter((i) => groupOf.get(i.state_id ?? "") === g).length;

    const cancelled = count("cancelled");
    // Les annulés sortent du périmètre : les y laisser ferait baisser le
    // pourcentage à chaque décision de NE PAS faire quelque chose, ce qui est
    // exactement l'inverse de ce qui s'est passé.
    const scope = issues.length - cancelled;
    const done = count("completed");

    let idealDone = 0;
    if (cycle.start_date && cycle.end_date && scope > 0) {
      const start = new Date(`${cycle.start_date}T00:00:00`).getTime();
      const end = new Date(`${cycle.end_date}T00:00:00`).getTime();
      const now = Date.now();
      const ratio = end > start ? (now - start) / (end - start) : 1;
      idealDone = Math.round(scope * Math.max(0, Math.min(1, ratio)));
    }

    return {
      scope,
      done,
      started: count("started"),
      unstarted: count("unstarted"),
      backlog: count("backlog"),
      cancelled,
      idealDone,
    };
  }, [issues, states, cycle]);
}

/** Le cumul terminé jour après jour, reconstruit depuis `completed_at`. Pas de
 *  compteur quotidien : il supposerait un travail de fond qui ne rate jamais
 *  une exécution, et une seule journée manquée laisserait un trou définitif. */
function useCyclePoints(issues: PjIssue[], cycle: PjCycle): CyclePoint[] {
  return useMemo(() => {
    if (!cycle.start_date || !cycle.end_date) return [];

    const days: CyclePoint[] = [];
    const cursor = new Date(`${cycle.start_date}T00:00:00`);
    const end = new Date(`${cycle.end_date}T00:00:00`);

    while (cursor <= end) {
      const day = cursor.toISOString().slice(0, 10);
      days.push({
        day,
        done: issues.filter((i) => i.completed_at && i.completed_at.slice(0, 10) <= day).length,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    return days;
  }, [issues, cycle]);
}

function CycleDialog({
  project, cycle, onClose, onSaved,
}: {
  project: PjProject; cycle?: PjCycle;
  onClose: () => void; onSaved: () => void;
}) {
  const { user } = useAuth();
  const [name, setName] = useState(cycle?.name ?? "");
  const [description, setDescription] = useState(cycle?.description ?? "");
  const [start, setStart] = useState<string | null>(cycle?.start_date ?? null);
  const [end, setEnd] = useState<string | null>(cycle?.end_date ?? null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (cycle) {
        await updateCycle(cycle.id, {
          name: name.trim(), description, start_date: start, end_date: end,
        });
      } else {
        await createCycle({
          pjProjectId: project.id, workspaceId: project.workspace_id,
          name: name.trim(), description,
          start_date: start, end_date: end, createdBy: user?.id ?? null,
        });
      }
      onSaved();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={cycle ? "Modifier le cycle" : "Nouveau cycle"}
      size="md"
      footer={<>
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button onClick={submit} disabled={!name.trim() || busy}>
              {cycle ? "Enregistrer" : "Créer"}
            </Button>
        </>}
    >
        <TextField
          autoFocus value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Nom du cycle (ex. « Sprint 12 »)"
        />
        <TextAreaField
          value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="Ce qu'on s'engage à livrer" className="min-h-[70px]"
        />
        <div className="flex gap-2">
          <DatePicker value={start} onChange={setStart} placeholder="Début" />
          <DatePicker value={end} onChange={setEnd} placeholder="Fin" min={start} />
        </div>
        <p className="text-11 text-muted-foreground">
          Sans dates, le cycle existe mais n&apos;a ni courbe ni rythme de référence.
        </p>
        </Modal>
  );
}

// ── Réutilisés par Modules et Overview ──────────────────────────────────────

/**
 * L'avancement d'un lot d'items par groupe d'état.
 *
 * Le pourcentage porte sur les items TERMINÉS rapportés au total : c'est le
 * seul dénominateur que tout le monde lit pareil. Compter en points
 * d'estimation donnerait un chiffre plus juste sur le papier, mais faux dès
 * qu'un projet n'estime pas tout — et personne n'estime tout.
 */
export function useProgress(issues: PjIssue[], states: PjState[]) {
  return useMemo(() => {
    const groupOf = new Map(states.map((s) => [s.id, s.group]));
    const total = issues.length;
    const count = (g: string) => issues.filter((i) => groupOf.get(i.state_id ?? "") === g).length;
    return {
      total,
      backlog: count("backlog"),
      unstarted: count("unstarted"),
      started: count("started"),
      completed: count("completed"),
      cancelled: count("cancelled"),
      percent: total ? Math.round((count("completed") / total) * 100) : 0,
    };
  }, [issues, states]);
}

export function ProgressBar({ stats }: { stats: ReturnType<typeof useProgress> }) {
  // Couleurs des groupes d'état (0225) : backlog et « à faire » restent gris
  // pour que seuls « en cours » et « terminé » attirent l'œil.
  const segments = [
    { key: "completed", value: stats.completed, color: "#3e9b4f" },
    { key: "started", value: stats.started, color: "#eda100" },
    { key: "unstarted", value: stats.unstarted, color: "#6b7180" },
    { key: "backlog", value: stats.backlog, color: "#8b8f99" },
    { key: "cancelled", value: stats.cancelled, color: "#8c8fa4" },
  ];
  return (
    <div className="pt-3">
      <div className="flex items-center justify-between pb-1 text-11 text-muted-foreground">
        <span>{stats.completed}/{stats.total} terminés</span>
        <span className="tabular-nums">{stats.percent}%</span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        {stats.total > 0 && segments.map((s) => (
          s.value > 0 && (
            <span
              key={s.key}
              style={{ width: `${(s.value / stats.total) * 100}%`, background: s.color }}
              title={`${s.value}`}
            />
          )
        ))}
      </div>
    </div>
  );
}
