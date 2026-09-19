import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Responsive, WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import {
  ArrowLeftIcon, ChartBarIcon, CheckIcon, DotsSixVerticalIcon, DotsThreeIcon,
  MagnifyingGlassIcon, PlusIcon, SlidersHorizontalIcon, SquaresFourIcon, TrashIcon, XIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCategorical } from "@/features/crm/overview/vizPalette";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { ProjectLogo } from "./LogoPicker";
import { Burndown } from "./Burndown";
import { IssueKey, PriorityIcon, StateIcon, formatDate } from "./pickers";
import { EmptyState, Modal, PageHeader, TextField } from "./ui";
import { DashboardIllustration } from "./illustrations";
import { Select } from "./ui";
import {
  createDashboard, createWidget, deleteDashboard, deleteWidget, fetchAnalytics,
  fetchCycles, fetchDashboards, fetchIssues, fetchProjects, fetchStates, fetchWidgets,
  renameDashboard, saveWidgetLayout, updateWidget,
  type AnalyticsRow, type PjDashboard, type PjProject, type PjWidget, type WidgetKind,
} from "./model";

/**
 * Les tableaux de bord composables.
 *
 * Chaque widget stocke une QUESTION (quel projet, quelle dimension) et non un
 * résultat : c'est ce qui lui permet de rester juste sans qu'aucun travail de
 * fond ne le rafraîchisse, et de ne jamais afficher un chiffre d'hier avec
 * l'assurance d'aujourd'hui.
 *
 * La grille ne se réorganise qu'en mode ÉDITION. Un canevas où tout bouge en
 * permanence rend le défilement hasardeux — on veut faire défiler et on déplace
 * une carte — et transforme chaque lecture en risque de casser la disposition
 * de quelqu'un d'autre.
 */

const ResponsiveGrid = WidthProvider(Responsive);

const COLS = 12;
const ROW_H = 64;

const WIDGET_KINDS: { key: WidgetKind; label: string; hint: string; w: number; h: number }[] = [
  { key: "count", label: "Compteur", hint: "Le nombre de work items", w: 3, h: 2 },
  { key: "overdue", label: "En retard", hint: "Ce qui a dépassé son échéance", w: 3, h: 2 },
  { key: "progress", label: "Avancement", hint: "Répartition par groupe d'état", w: 4, h: 4 },
  { key: "distribution", label: "Répartition", hint: "Par état ou par priorité", w: 4, h: 4 },
  { key: "issue_list", label: "Liste", hint: "Les derniers work items", w: 6, h: 5 },
  { key: "burndown", label: "Burndown", hint: "La courbe du cycle en cours", w: 6, h: 4 },
];

export function DashboardsPage({
  dashboardId, workspaceId,
}: { dashboardId: string; workspaceId: string | null }) {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: boards } = useQuery({
    queryKey: ["pj_dashboards", dashboardId],
    queryFn: () => fetchDashboards(dashboardId),
  });
  const { data: projects } = useQuery({
    queryKey: ["pj_projects", dashboardId],
    queryFn: () => fetchProjects(dashboardId),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_dashboards", dashboardId] });
  const current = (boards ?? []).find((d) => d.id === openId) ?? null;

  if (current) {
    return (
      <DashboardCanvas
        board={current}
        projects={projects ?? []}
        onBack={() => setOpenId(null)}
        onRenamed={refresh}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={<SquaresFourIcon className="h-4 w-4" />}
        title="Tableaux de bord"
        subtitle="Les indicateurs qui comptent pour ce service"
        actions={
          <Button
            size="sm" className="h-8 gap-1.5"
            onClick={() => setCreating(true)} disabled={!workspaceId}
          >
            <PlusIcon className="h-4 w-4" /> Nouveau tableau de bord
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {!boards?.length ? (
          <EmptyState
            illustration={<DashboardIllustration className="w-full" />}
            title="Aucun tableau de bord"
            hint="Un tableau de bord assemble des widgets — compteurs, répartitions, listes — pour répondre d'un coup d'œil à une question qu'on se pose souvent."
            action={
              <Button size="sm" onClick={() => setCreating(true)} disabled={!workspaceId}>
                Créer un tableau de bord
              </Button>
            }
          />
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {boards.map((d) => (
              <BoardCard key={d.id} board={d} onOpen={() => setOpenId(d.id)} onChanged={refresh} />
            ))}
          </div>
        )}
      </div>

      {creating && workspaceId && (
        <CreateDashboardDialog
          workspaceId={workspaceId}
          dashboardId={dashboardId}
          projects={projects ?? []}
          onClose={() => setCreating(false)}
          onCreated={(id) => { refresh(); setOpenId(id); }}
        />
      )}
    </div>
  );
}

/**
 * La création d'un tableau de bord.
 *
 * Trois décisions et pas une de plus : son nom, les projets qu'il regarde, et
 * qui peut le voir. Le contenu vient après — on ne sait pas encore quels
 * widgets on veut au moment où l'on crée la page, et demander de choisir
 * maintenant reviendrait à faire deviner.
 */
function CreateDashboardDialog({
  workspaceId, dashboardId, projects, onClose, onCreated,
}: {
  workspaceId: string;
  dashboardId: string;
  projects: PjProject[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>(projects.map((p) => p.id));
  const [access, setAccess] = useState<0 | 1>(1);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const created = await createDashboard({
        workspaceId, dashboardId, name: name.trim(), ownedBy: user?.id ?? null, access,
      });
      onCreated(created.id);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Nouveau tableau de bord"
      size="lg"
      busy={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button onClick={submit} disabled={!name.trim() || busy}>
            Créer le tableau de bord
          </Button>
        </>
      }
    >
      <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-12 text-secondary">Nommez votre tableau de bord</span>
            <TextField
              autoFocus value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="Ex. « Suivi hebdomadaire »"
            />
          </label>

          <div>
            <span className="mb-1.5 block text-12 text-secondary">Projets observés</span>
            <ProjectMultiPicker projects={projects} value={picked} onChange={setPicked} />
          </div>

          <fieldset>
            <legend className="mb-2 text-12 text-secondary">Visibilité</legend>
            <div className="space-y-2">
              <AccessOption
                active={access === 1} onSelect={() => setAccess(1)}
                label="Partagé"
                hint="Tout le monde dans l'espace peut le consulter."
              />
              <AccessOption
                active={access === 0} onSelect={() => setAccess(0)}
                label="Privé"
                hint="Vous seul pouvez le consulter."
              />
            </div>
          </fieldset>

      </div>
    </Modal>
  );
}

/** Un choix de visibilité. Le libellé ET son explication : « privé » tout seul
 *  laisse deviner si cela veut dire invisible ou seulement non modifiable. */
function AccessOption({
  active, onSelect, label, hint,
}: { active: boolean; onSelect: () => void; label: string; hint: string }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-start gap-2.5 text-left"
    >
      <span className={cn(
        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
        active ? "border-primary" : "border-border",
      )}>
        {active && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-13 font-medium">{label}</span>
        <span className="block text-11 text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

function ProjectMultiPicker({
  projects, value, onChange,
}: { projects: PjProject[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const shown = projects.filter((p) =>
    !query.trim() || p.name.toLowerCase().includes(query.toLowerCase()));

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  const label = value.length === projects.length
    ? "Tous les projets"
    : value.length === 0
      ? "Aucun projet"
      : value.length === 1
        ? projects.find((p) => p.id === value[0])?.name ?? "1 projet"
        : `${value.length} projets`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 w-full items-center gap-2 rounded-md border border-border px-3 text-left text-13 hover:bg-muted"
        >
          {value.length === 1 && (
            <ProjectLogo
              logo={projects.find((p) => p.id === value[0])?.logo_props}
              fallback={projects.find((p) => p.id === value[0])?.identifier}
              size={14}
            />
          )}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <DotsThreeIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>

      <PopoverContent className="w-72 p-0" align="start">
        <div className="border-b border-border p-2">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <TextField
              autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher un projet…" className="h-8 pl-8 text-12"
            />
          </div>
        </div>
        <div className="max-h-56 overflow-y-auto p-1">
          {shown.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => toggle(p.id)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-13 hover:bg-muted"
            >
              <ProjectLogo logo={p.logo_props} fallback={p.identifier} size={14} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {value.includes(p.id) && <CheckIcon className="h-3.5 w-3.5 shrink-0" />}
            </button>
          ))}
          {!shown.length && (
            <p className="px-2 py-3 text-12 text-muted-foreground">Aucun projet.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BoardCard({
  board, onOpen, onChanged,
}: { board: PjDashboard; onOpen: () => void; onChanged: () => void }) {
  const { data: widgets } = useQuery({
    queryKey: ["pj_widgets", board.id],
    queryFn: () => fetchWidgets(board.id),
  });

  return (
    <article className="group rounded-lg border border-border/70 bg-card p-3 shadow-raised-100 transition-colors hover:border-border">
      <div className="flex items-center gap-2">
        <ChartBarIcon className="h-4 w-4 text-muted-foreground" />
        <button
          type="button" onClick={onOpen}
          className="min-w-0 flex-1 truncate text-left text-13 font-medium hover:underline"
        >
          {board.name}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100">
              <DotsThreeIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onOpen}>Ouvrir</DropdownMenuItem>
            <DropdownMenuItem
              className="text-red-600"
              onClick={async () => { await deleteDashboard(board.id); onChanged(); }}
            >
              Supprimer
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="pt-1 text-11 text-muted-foreground">
        {widgets?.length ?? 0} widget{(widgets?.length ?? 0) > 1 ? "s" : ""}
        {board.access === 0 ? " · privé" : ""}
      </p>
    </article>
  );
}

// ── Le canevas ──────────────────────────────────────────────────────────────

function DashboardCanvas({
  board, projects, onBack, onRenamed,
}: {
  board: PjDashboard;
  projects: PjProject[];
  onBack: () => void;
  onRenamed: () => void;
}) {
  const qc = useQueryClient();
  const [organise, setOrganise] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState(board.name);
  // Le widget en cours de réglage. Un seul à la fois : deux barres ouvertes
  // obligeraient à deviner laquelle pilote quelle carte.
  const [editing, setEditing] = useState<string | null>(null);

  const { data: widgets } = useQuery({
    queryKey: ["pj_widgets", board.id],
    queryFn: () => fetchWidgets(board.id),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_widgets", board.id] });

  // Les analytics servent TOUS les widgets de chiffres : une requête pour le
  // tableau entier, au lieu d'une par carte.
  const { data: analytics } = useQuery({
    queryKey: ["pj_analytics", board.dashboard_id],
    enabled: !!board.dashboard_id,
    queryFn: () => fetchAnalytics(board.dashboard_id!),
  });

  const layout: Layout[] = useMemo(
    () => (widgets ?? []).map((w) => ({ i: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: 2, minH: 2 })),
    [widgets],
  );

  const persist = async (next: Layout[]) => {
    await saveWidgetLayout(next.map((l) => ({ id: l.i, x: l.x, y: l.y, w: l.w, h: l.h })));
    refresh();
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={
          <button type="button" onClick={onBack} className="rounded p-0.5 hover:bg-muted">
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
        }
        title={
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              if (title.trim() && title !== board.name) {
                renameDashboard(board.id, title.trim()).then(onRenamed);
              }
            }}
            className="w-full min-w-0 bg-transparent text-14 font-medium outline-none"
          />
        }
        actions={
          <>
            {/* Le mode organisation est explicite : hors de lui la grille est
                figée, et on peut faire défiler sans déplacer la carte d'un
                collègue par mégarde. */}
            <Button
              size="sm" variant={organise ? "default" : "outline"}
              className="h-8 gap-1.5 text-12"
              onClick={() => setOrganise((v) => !v)}
            >
              {organise ? <CheckIcon className="h-4 w-4" /> : <DotsSixVerticalIcon className="h-4 w-4" />}
              {organise ? "Terminer" : "Organiser"}
            </Button>
            <Button size="sm" className="h-8 gap-1.5" onClick={() => setAdding(true)}>
              <PlusIcon className="h-4 w-4" /> Widget
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!widgets?.length ? (
          <EmptyState
            illustration={<DashboardIllustration className="w-full" />}
            title="Tableau de bord vide"
            hint="Ajoutez un widget : un compteur pour surveiller un volume, une répartition pour voir où le travail s'accumule, une liste pour garder l'essentiel sous les yeux."
            action={<Button size="sm" onClick={() => setAdding(true)}>Ajouter un widget</Button>}
          />
        ) : (
          <ResponsiveGrid
            className="layout"
            layouts={{ lg: layout, md: layout, sm: layout, xs: layout, xxs: layout }}
            breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
            cols={{ lg: COLS, md: COLS, sm: 6, xs: 4, xxs: 2 }}
            rowHeight={ROW_H}
            margin={[12, 12]}
            isDraggable={organise}
            isResizable={organise}
            draggableHandle=".drag-handle"
            onLayoutChange={(l) => { if (organise) persist(l); }}
          >
            {widgets.map((w) => (
              <div key={w.id}>
                <WidgetCard
                  widget={w}
                  organise={organise}
                  selected={editing === w.id}
                  project={projects.find((p) => p.id === w.config.projectId) ?? null}
                  analytics={(analytics ?? []).find((a) => a.pj_project_id === w.config.projectId) ?? null}
                  onSelect={() => setEditing(editing === w.id ? null : w.id)}
                  onRemove={async () => { await deleteWidget(w.id); refresh(); }}
                />
              </div>
            ))}
          </ResponsiveGrid>
        )}
      </div>

      {editing && (
        <WidgetInspector
          widget={(widgets ?? []).find((w) => w.id === editing) ?? null}
          projects={projects}
          onClose={() => setEditing(null)}
          onChanged={refresh}
        />
      )}
      </div>

      {adding && (
        <AddWidgetDialog
          board={board} projects={projects} existing={widgets ?? []}
          onClose={() => setAdding(false)} onAdded={refresh}
        />
      )}
    </div>
  );
}

function WidgetCard({
  widget, project, analytics, organise, selected, onSelect, onRemove,
}: {
  widget: PjWidget;
  project: PjProject | null;
  analytics: AnalyticsRow | null;
  organise: boolean;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <article className={cn(
      "flex h-full flex-col overflow-hidden rounded-lg border bg-card p-3 shadow-raised-100",
      selected ? "border-primary ring-1 ring-primary/30"
        : organise ? "border-primary/40" : "border-border/70",
    )}>
      <header className="flex items-center gap-2 pb-2">
        {organise && (
          <span className="drag-handle cursor-move text-muted-foreground">
            <DotsSixVerticalIcon className="h-4 w-4" />
          </span>
        )}
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 truncate text-left text-12 font-medium hover:underline"
        >
          {widget.title}
        </button>
        {project && <ProjectLogo logo={project.logo_props} fallback={project.identifier} size={13} />}
        {organise && (
          <button
            type="button" onClick={onRemove}
            className="rounded p-0.5 text-muted-foreground hover:text-red-600"
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!project ? (
          // Un widget dont le projet a été supprimé le DIT, plutôt que
          // d'afficher un zéro qu'on prendrait pour une vraie mesure.
          <p className="text-12 text-muted-foreground">Projet introuvable.</p>
        ) : (
          <WidgetBody widget={widget} project={project} analytics={analytics} />
        )}
      </div>
    </article>
  );
}

function WidgetBody({
  widget, project, analytics,
}: { widget: PjWidget; project: PjProject; analytics: AnalyticsRow | null }) {
  const palette = useCategorical();
  const needsIssues = widget.kind === "issue_list"
    || widget.kind === "distribution" || widget.kind === "progress";

  const { data: issues } = useQuery({
    queryKey: ["pj_issues", { pjProjectId: project.id }],
    queryFn: () => fetchIssues({ pjProjectId: project.id }),
    enabled: needsIssues,
  });
  const { data: states } = useQuery({
    queryKey: ["pj_states", project.id],
    queryFn: () => fetchStates(project.id),
    enabled: needsIssues,
  });
  const { data: cycles } = useQuery({
    queryKey: ["pj_cycles", project.id],
    queryFn: () => fetchCycles(project.id),
    enabled: widget.kind === "burndown",
  });

  switch (widget.kind) {
    case "count":
      return (
        <p className="text-32 font-semibold leading-none tabular-nums">
          {analytics?.issues ?? 0}
        </p>
      );

    case "overdue":
      return (
        <p className={cn(
          "text-32 font-semibold leading-none tabular-nums",
          (analytics?.overdue ?? 0) > 0 && "text-amber-600",
        )}>
          {analytics?.overdue ?? 0}
        </p>
      );

    case "progress": {
      const groupOf = new Map((states ?? []).map((s) => [s.id, s.group]));
      const count = (g: string) => (issues ?? []).filter((i) => groupOf.get(i.state_id ?? "") === g).length;
      const total = issues?.length ?? 0;
      const segments = [
        { key: "completed", label: "Terminés", value: count("completed"), color: "#3e9b4f" },
        { key: "started", label: "En cours", value: count("started"), color: "#eda100" },
        { key: "unstarted", label: "À faire", value: count("unstarted"), color: "#6b7180" },
        { key: "backlog", label: "Backlog", value: count("backlog"), color: "#8b8f99" },
      ];
      return (
        <div className="space-y-2">
          <div className="flex h-2 overflow-hidden rounded-full bg-muted">
            {total > 0 && segments.map((s) => s.value > 0 && (
              <span key={s.key} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />
            ))}
          </div>
          {/* Chaque segment est étiqueté : la couleur seule ne porte jamais la
              valeur, conformément à la palette validée du dépôt. */}
          <ul className="space-y-0.5">
            {segments.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5 text-11">
                <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
                <span className="flex-1">{s.label}</span>
                <span className="tabular-nums text-muted-foreground">{s.value}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    }

    case "distribution": {
      const dimension = widget.config.dimension ?? "state";
      const counts = new Map<string, number>();
      for (const i of issues ?? []) {
        const key = dimension === "priority"
          ? i.priority
          : (states ?? []).find((s) => s.id === i.state_id)?.name ?? "Sans état";
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
      const max = Math.max(1, ...rows.map((r) => r[1]));
      return (
        <ul className="space-y-1">
          {rows.map(([label, n], index) => (
            <li key={label} className="flex items-center gap-2 text-11">
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="h-1.5 w-16 rounded-full bg-muted">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${(n / max) * 100}%`, background: palette[index % palette.length] }}
                />
              </span>
              <span className="w-6 text-right tabular-nums text-muted-foreground">{n}</span>
            </li>
          ))}
          {!rows.length && <li className="text-11 text-muted-foreground">Aucune donnée.</li>}
        </ul>
      );
    }

    case "issue_list": {
      const rows = (issues ?? []).slice(0, widget.config.limit ?? 8);
      return (
        <ul className="space-y-1">
          {rows.map((i) => {
            const s = (states ?? []).find((x) => x.id === i.state_id);
            return (
              <li key={i.id} className="flex items-center gap-1.5 text-11">
                {s && <StateIcon group={s.group} color={s.color} className="h-3 w-3" />}
                <IssueKey identifier={project.identifier} sequenceId={i.sequence_id} className="text-10" />
                <span className="min-w-0 flex-1 truncate">{i.name}</span>
                <PriorityIcon priority={i.priority} className="h-3 w-3" />
                {i.target_date && (
                  <span className="text-muted-foreground">{formatDate(i.target_date)}</span>
                )}
              </li>
            );
          })}
          {!rows.length && <li className="text-11 text-muted-foreground">Aucun work item.</li>}
        </ul>
      );
    }

    case "burndown": {
      const today = new Date().toISOString().slice(0, 10);
      const cycle = (cycles ?? []).find((c) =>
        c.start_date && c.end_date && today >= c.start_date && today <= c.end_date);
      if (!cycle) return <p className="text-12 text-muted-foreground">Aucun cycle en cours.</p>;
      return <Burndown cycle={cycle} />;
    }
  }
}

function AddWidgetDialog({
  board, projects, existing, onClose, onAdded,
}: {
  board: PjDashboard;
  projects: PjProject[];
  existing: PjWidget[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [kind, setKind] = useState<WidgetKind>("count");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [dimension, setDimension] = useState("state");
  const [title, setTitle] = useState("");

  const meta = WIDGET_KINDS.find((k) => k.key === kind)!;

  const submit = async () => {
    if (!projectId) return;
    const project = projects.find((p) => p.id === projectId);
    // La nouvelle carte se pose SOUS les existantes : l'insérer en haut
    // décalerait tout ce que l'utilisateur a rangé.
    const y = existing.reduce((max, w) => Math.max(max, w.y + w.h), 0);
    await createWidget({
      pjDashboardId: board.id,
      workspaceId: board.workspace_id,
      kind,
      title: title.trim() || `${meta.label} · ${project?.name ?? ""}`,
      config: { projectId, dimension },
      x: 0, y, w: meta.w, h: meta.h,
    });
    onAdded();
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={"Ajouter un widget"}
      size="md"
      footer={<>
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button onClick={submit} disabled={!projectId}>Ajouter</Button>
        </>}
    >
        <div className="grid grid-cols-2 gap-1.5">
          {WIDGET_KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              onClick={() => setKind(k.key)}
              className={cn(
                "rounded-md border p-2 text-left text-12 transition-colors",
                kind === k.key ? "border-primary/60 bg-primary/5" : "border-border hover:bg-muted",
              )}
            >
              <span className="block font-medium">{k.label}</span>
              <span className="block text-10 text-muted-foreground">{k.hint}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="shrink-0 text-11 text-tertiary">Projet</span>
          <Select
            className="flex-1"
            value={projectId}
            onChange={setProjectId}
            options={projects.map((p) => ({ key: p.id, label: p.name }))}
          />
        </div>

        {kind === "distribution" && (
          <div className="flex items-center justify-between gap-2">
            <span className="shrink-0 text-11 text-tertiary">Dimension</span>
            <Select
              className="flex-1"
              value={dimension}
              onChange={setDimension}
              options={[
              { key: "state", label: "État" },
              { key: "priority", label: "Priorité" },
            ]}
            />
          </div>
        )}

        <TextField
          value={title} onChange={(e) => setTitle(e.target.value)}
          placeholder="Titre (facultatif)" className="h-8 text-13"
        />
        </Modal>
  );
}

/**
 * La barre de configuration d'un widget.
 *
 * Elle règle la QUESTION que pose la carte — son titre, son projet, sa
 * dimension, sa profondeur — et se met à jour à chaque changement plutôt qu'à
 * la validation d'un formulaire. Sur un réglage dont on juge l'effet à l'œil
 * (« est-ce que six lignes suffisent ? »), un bouton « Enregistrer » oblige à
 * un aller-retour pour chaque essai.
 *
 * Elle occupe une colonne à droite et non une modale : régler un widget se fait
 * EN LE REGARDANT, et une fenêtre par-dessus cacherait précisément ce qu'on
 * essaie d'ajuster.
 */
function WidgetInspector({
  widget, projects, onClose, onChanged,
}: {
  widget: PjWidget | null;
  projects: PjProject[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState(widget?.title ?? "");

  if (!widget) return null;

  const meta = WIDGET_KINDS.find((k) => k.key === widget.kind);

  const patch = async (next: Partial<PjWidget>) => {
    await updateWidget(widget.id, next);
    onChanged();
  };

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-border">
      <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-3">
        <SlidersHorizontalIcon className="h-4 w-4 text-muted-foreground" />
        <h3 className="min-w-0 flex-1 truncate text-13 font-medium">Réglages du widget</h3>
        <button
          type="button" onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        <div>
          <span className="mb-1.5 block text-11 text-secondary">Type</span>
          <p className="rounded-md border border-border/70 px-2.5 py-1.5 text-12">
            {meta?.label}
            <span className="block text-10 text-muted-foreground">{meta?.hint}</span>
          </p>
        </div>

        <label className="block">
          <span className="mb-1.5 block text-11 text-secondary">Titre</span>
          <TextField
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { if (title.trim() && title !== widget.title) patch({ title: title.trim() }); }}
            className="h-8 text-13"
          />
        </label>

        <div>
          <span className="mb-1.5 block text-11 text-secondary">Projet</span>
          <Select
            value={widget.config.projectId ?? null}
            onChange={(v) => patch({ config: { ...widget.config, projectId: v } })}
            options={projects.map((p) => ({ key: p.id, label: p.name }))}
            placeholder="Choisir un projet"
          />
        </div>

        {widget.kind === "distribution" && (
          <div>
            <span className="mb-1.5 block text-11 text-secondary">Dimension</span>
            <Select
              value={widget.config.dimension ?? "state"}
              onChange={(v) => patch({ config: { ...widget.config, dimension: v } })}
              options={[
                { key: "state", label: "État" },
                { key: "priority", label: "Priorité" },
              ]}
            />
          </div>
        )}

        {widget.kind === "issue_list" && (
          <label className="block">
            <span className="mb-1.5 block text-11 text-secondary">
              Lignes affichées · {widget.config.limit ?? 8}
            </span>
            <input
              type="range" min={3} max={20} step={1}
              value={widget.config.limit ?? 8}
              onChange={(e) => patch({ config: { ...widget.config, limit: Number(e.target.value) } })}
              className="w-full accent-primary"
            />
            <span className="mt-1 block text-10 text-muted-foreground">
              Au-delà d&apos;une vingtaine, la carte devient une liste qu&apos;on fait défiler —
              c&apos;est le rôle du board, pas d&apos;un widget.
            </span>
          </label>
        )}

        <div>
          <span className="mb-1.5 block text-11 text-secondary">Taille</span>
          <div className="flex items-center gap-2">
            <SizeField
              label="Largeur" value={widget.w} min={2} max={12}
              onChange={(w) => patch({ w })}
            />
            <SizeField
              label="Hauteur" value={widget.h} min={2} max={12}
              onChange={(h) => patch({ h })}
            />
          </div>
          <span className="mt-1 block text-10 text-muted-foreground">
            Se règle aussi à la souris, en mode Organiser.
          </span>
        </div>
      </div>
    </aside>
  );
}

function SizeField({
  label, value, min, max, onChange,
}: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="flex-1">
      <span className="mb-1 block text-10 text-muted-foreground">{label}</span>
      <input
        type="number" min={min} max={max} value={value}
        onChange={(e) => {
          // On borne à la saisie : react-grid-layout accepte une largeur de 40
          // sans broncher et la carte sort de la grille sans message.
          const n = Math.max(min, Math.min(max, Number(e.target.value) || min));
          onChange(n);
        }}
        className="h-8 w-full rounded-md border border-border bg-background px-2 text-12 tabular-nums"
      />
    </label>
  );
}
