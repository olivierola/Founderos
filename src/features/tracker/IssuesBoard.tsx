import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleNotchIcon as Loader2, PlusIcon as Plus } from "@phosphor-icons/react";
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { downloadCsv, issuesToCsv } from "./exportIssues";
import { BulkActionBar } from "./BulkActionBar";
import { PeekShell, usePeekMode } from "./PeekShell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth-context";
import { FilterBar } from "./FilterBar";
import { IssueDetailPanel, IssuePeekActions, IssuePeekLead } from "./IssueDetail";
import { CreateWorkItemModal } from "./CreateWorkItem";
import { ListLayout } from "./layouts/List";
import { KanbanLayout } from "./layouts/Kanban";
import { SpreadsheetLayout } from "./layouts/Spreadsheet";
import { CalendarLayout } from "./layouts/Calendar";
import { GanttLayout } from "./layouts/Gantt";
import {
  EMPTY_FILTERS, buildBoard, countActiveFilters, loadDisplay, saveDisplay,
  type DisplayFilters, type DisplayProperties, type Filters,
} from "./filters";
import {
  createIssue, fetchCycles, fetchIssueTypes, fetchIssues, fetchLabels, fetchMembers,
  fetchTrackerAgents, fetchWorkingIssueIds,
  fetchModules, fetchStates, rankBetween, setAssignees, setIssueCycle, setIssueModules,
  setLabels, updateIssue,
  type CreateIssueInput, type IssueScope, type Member, type PjIssue, type PjLabel,
  type PjProject, type PjState, type Priority,
} from "./model";
import { AssigneePicker, DatePicker, LabelPicker, PriorityPicker, StatePicker } from "./pickers";
import { TextField } from "./ui";
import { BoardIllustration, SearchIllustration } from "./illustrations";
import { EmptyState } from "./ui";

/**
 * Le board d'un projet : la barre de réglages, le layout choisi, et la fiche en
 * superposition.
 *
 * Il est aussi réutilisé tel quel par un cycle, un module et une vue — c'est le
 * `scope` qui change, pas l'écran. C'est ce qui fait qu'on retrouve exactement
 * les mêmes gestes partout, ce que Plane obtient de la même façon.
 */
export function IssuesBoard({
  project, scope, scopeKey, headerSlot, emptyHint, initialFilters, boardTitle,
  dashboardId, breadcrumb, onOpenAnalytics,
}: {
  project: PjProject;
  scope: IssueScope;
  /** Clé de persistance des réglages d'affichage (projet, cycle, module…). */
  scopeKey: string;
  headerSlot?: React.ReactNode;
  emptyHint?: string;
  /** Les critères d'une vue sauvegardée, appliqués à l'ouverture. */
  initialFilters?: Filters;
  /** Le libellé de la barre : « Work items », ou le nom du cycle ouvert. */
  boardTitle?: string;
  /**
   * Le tableau de service OUVERT. Il prime sur `project.dashboard_id`, qui
   * n'est que celui du rattachement d'origine — et qui peut ne plus
   * correspondre à l'endroit où l'on se trouve.
   */
  dashboardId?: string | null;
  /** Remplace le titre de la barre — voir `FilterBar`. */
  breadcrumb?: React.ReactNode;
  onOpenAnalytics?: () => void;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();

  const initial = useMemo(() => loadDisplay(scopeKey), [scopeKey]);
  // Les critères d'une vue peuvent venir d'un enregistrement plus ancien que le
  // dernier champ ajouté : on complète avec les valeurs vides plutôt que de
  // laisser un `undefined` faire planter `filters.labels.length`.
  const [filters, setFilters] = useState<Filters>(
    initialFilters ? { ...EMPTY_FILTERS, ...initialFilters } : EMPTY_FILTERS,
  );
  const [display, setDisplayState] = useState<DisplayFilters>(initial.display);
  const [properties, setPropertiesState] = useState<DisplayProperties>(initial.properties);
  const [open, setOpen] = useState<PjIssue | null>(null);
  const [creatingIn, setCreatingIn] = useState<string | null>(null);

  const setDisplay = (d: DisplayFilters) => { setDisplayState(d); saveDisplay(scopeKey, d, properties); };
  const setProperties = (p: DisplayProperties) => { setPropertiesState(p); saveDisplay(scopeKey, display, p); };

  const issuesQ = useQuery({
    queryKey: ["pj_issues", scope],
    queryFn: () => fetchIssues(scope),
  });
  const statesQ = useQuery({ queryKey: ["pj_states", project.id], queryFn: () => fetchStates(project.id) });
  const labelsQ = useQuery({ queryKey: ["pj_labels", project.id], queryFn: () => fetchLabels(project.id) });
  const cyclesQ = useQuery({ queryKey: ["pj_cycles", project.id], queryFn: () => fetchCycles(project.id) });
  const modulesQ = useQuery({ queryKey: ["pj_modules", project.id], queryFn: () => fetchModules(project.id) });
  const membersQ = useQuery({
    queryKey: ["pj_members", project.workspace_id],
    queryFn: () => fetchMembers(project.workspace_id),
  });
  const typesQ = useQuery({
    queryKey: ["pj_issue_types", project.id],
    queryFn: () => fetchIssueTypes(project.id),
  });
  const agentsQ = useQuery({
    queryKey: ["pj_tracker_agents", dashboardId ?? project.dashboard_id, project.workspace_id],
    queryFn: () => fetchTrackerAgents(dashboardId ?? project.dashboard_id, project.workspace_id),
  });
  // Relue toutes les 20 s tant qu'au moins un item est en cours de travail, et
  // chaque minute sinon : c'est ce qui fait apparaître le point au démarrage
  // d'un agent planifié, sans que personne ait rien fait.
  const workingQ = useQuery({
    queryKey: ["pj_working_issues", project.id],
    queryFn: () => fetchWorkingIssueIds(project.id),
    refetchInterval: (q) => ((q.state.data?.size ?? 0) > 0 ? 20_000 : 60_000),
  });

  const issueTypes = typesQ.data ?? [];
  const states = statesQ.data ?? [];
  const labels = labelsQ.data ?? [];
  const members = membersQ.data ?? [];
  const cycles = cyclesQ.data ?? [];
  const modules = modulesQ.data ?? [];
  const issues = issuesQ.data ?? [];

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["pj_issues"] });
  }, [qc]);

  const groups = useMemo(
    () => buildBoard({
      issues, filters, display,
      ctx: { states, labels, members, cycles, modules },
    }),
    [issues, filters, display, states, labels, members, cycles, modules],
  );

  /**
   * Ce que le board affiche RÉELLEMENT, après filtres et réglages.
   *
   * On ne peut pas se fier au nombre d'items chargés pour décider de l'état
   * vide : les données peuvent être là et le rendu vide — c'est précisément le
   * cas qui trompe.
   */
  const visibleCount = useMemo(
    () => groups.reduce((n, g) => n + g.issues.length, 0),
    [groups],
  );

  /** Un réglage écarte-t-il des lignes ? Filtres, périmètre, sous-tâches. */
  const hiding = countActiveFilters(filters) > 0
    || display.type !== "all"
    || !display.sub_issue;

  // ── Mutations optimistes ──────────────────────────────────────────────────
  // Le board écrit dans le cache AVANT de partir en base : sur un kanban, voir
  // la carte sauter dans sa colonne un demi-tour de réseau plus tard donne
  // l'impression que le clic n'a pas pris, et fait recliquer.
  const patchIssue = useCallback(async (id: string, patch: Partial<PjIssue>) => {
    qc.setQueriesData<PjIssue[]>({ queryKey: ["pj_issues"] }, (prev) =>
      (prev ?? []).map((i) => (i.id === id ? { ...i, ...patch } : i)));

    const { cycle_id, module_ids, ...columns } = patch;
    if (Object.keys(columns).length) await updateIssue(id, columns, user?.id ?? null);
    if (cycle_id !== undefined) await setIssueCycle(id, project.workspace_id, cycle_id);
    if (module_ids !== undefined) await setIssueModules(id, project.workspace_id, module_ids);
    refresh();
  }, [qc, refresh, user?.id, project.workspace_id]);

  const patchAssignees = useCallback(async (id: string, ids: string[]) => {
    qc.setQueriesData<PjIssue[]>({ queryKey: ["pj_issues"] }, (prev) =>
      (prev ?? []).map((i) => (i.id === id ? { ...i, assignee_ids: ids } : i)));
    await setAssignees(id, project.id, project.workspace_id, ids);
    refresh();
  }, [qc, refresh, project.id, project.workspace_id]);

  const patchLabels = useCallback(async (id: string, ids: string[]) => {
    qc.setQueriesData<PjIssue[]>({ queryKey: ["pj_issues"] }, (prev) =>
      (prev ?? []).map((i) => (i.id === id ? { ...i, label_ids: ids } : i)));
    await setLabels(id, project.id, project.workspace_id, ids);
    refresh();
  }, [qc, refresh, project.id, project.workspace_id]);

  /**
   * Un dépôt de carte fait DEUX choses : il range l'item dans le groupe visé
   * (ce que « déplacer vers En cours » veut dire) et il fixe son rang dans la
   * colonne. Ne faire que la seconde donnerait un kanban où l'on ne peut pas
   * changer d'état à la souris.
   */
  const moveIssue = useCallback(async (
    issueId: string, groupKey: string, beforeId: string | null, afterId: string | null,
  ) => {
    const all = issues;
    const before = beforeId ? all.find((i) => i.id === beforeId) ?? null : null;
    const after = afterId ? all.find((i) => i.id === afterId) ?? null : null;
    const sort_order = rankBetween(before?.sort_order ?? null, after?.sort_order ?? null);

    const patch: Partial<PjIssue> = { sort_order };
    switch (display.group_by) {
      case "state": patch.state_id = groupKey === "__none__" ? null : groupKey; break;
      case "priority": patch.priority = groupKey as Priority; break;
      case "cycle": patch.cycle_id = groupKey === "__none__" ? null : groupKey; break;
      case "target_date": patch.target_date = groupKey === "__none__" ? null : groupKey; break;
      case "assignees":
        if (groupKey !== "__none__") { await patchAssignees(issueId, [groupKey]); }
        break;
      case "labels":
        if (groupKey !== "__none__") { await patchLabels(issueId, [groupKey]); }
        break;
      case "module":
        if (groupKey !== "__none__") patch.module_ids = [groupKey];
        break;
    }
    await patchIssue(issueId, patch);
  }, [issues, display.group_by, patchIssue, patchAssignees, patchLabels]);

  const [peekMode, setPeekMode] = usePeekMode();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // L'ancre de la sélection au clavier : Maj+clic étend depuis la dernière
  // ligne cochée, comme dans un explorateur de fichiers.
  const [anchor, setAnchor] = useState<string | null>(null);

  const ordered = useMemo(() => groups.flatMap((g) => g.issues.map((i) => i.id)), [groups]);

  const toggleSelect = useCallback((issueId: string, shiftKey: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && anchor) {
        const from = ordered.indexOf(anchor);
        const to = ordered.indexOf(issueId);
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          // L'extension AJOUTE toujours : Maj+clic qui décocherait une partie
          // de la sélection existante serait une surprise, pas un raccourci.
          for (let i = lo; i <= hi; i += 1) next.add(ordered[i]);
          return next;
        }
      }
      if (next.has(issueId)) next.delete(issueId); else next.add(issueId);
      return next;
    });
    setAnchor(issueId);
  }, [anchor, ordered]);

  const clearSelection = useCallback(() => { setSelected(new Set()); setAnchor(null); }, []);

  /**
   * La création au fil de la liste. Le groupe où l'on a tapé fixe la valeur
   * correspondante : écrire un titre sous « In Progress » et voir l'item
   * atterrir dans le backlog serait un piège, pas un raccourci.
   */
  const quickCreate = useCallback(async (groupKey: string, title: string) => {
    const seed: Partial<CreateIssueInput> = {};
    switch (display.group_by) {
      case "state": if (groupKey !== "__none__") seed.state_id = groupKey; break;
      case "priority": seed.priority = groupKey as Priority; break;
      case "assignees": if (groupKey !== "__none__") seed.assignee_ids = [groupKey]; break;
      case "labels": if (groupKey !== "__none__") seed.label_ids = [groupKey]; break;
      case "cycle": if (groupKey !== "__none__") seed.cycle_id = groupKey; break;
      case "module": if (groupKey !== "__none__") seed.module_ids = [groupKey]; break;
      case "target_date": if (groupKey !== "__none__") seed.target_date = groupKey; break;
    }
    await createIssue({
      pjProjectId: project.id,
      workspaceId: project.workspace_id,
      name: title,
      // Créé depuis un cycle ou un module, l'item y atterrit directement.
      cycle_id: seed.cycle_id ?? scope.cycleId ?? null,
      module_ids: seed.module_ids ?? (scope.moduleId ? [scope.moduleId] : []),
      createdBy: user?.id ?? null,
      ...seed,
    });
    refresh();
  }, [display.group_by, project.id, project.workspace_id, scope.cycleId, scope.moduleId, user?.id, refresh]);

  const layoutProps = {
    project, groups, issues, states, labels, members, cycles, modules, issueTypes, properties,
    groupBy: display.group_by,
    onOpen: setOpen,
    onPatch: patchIssue,
    onSetAssignees: patchAssignees,
    onSetLabels: patchLabels,
    onMove: moveIssue,
    onCreate: (groupKey: string) => setCreatingIn(groupKey),
    onQuickCreate: quickCreate,
    selected,
    onToggleSelect: toggleSelect,
    agents: agentsQ.data ?? [],
    workingIssueIds: workingQ.data,
  };

  const loading = issuesQ.isLoading || statesQ.isLoading;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <FilterBar
        filters={filters} display={display} properties={properties}
        ctx={{ states, labels, members, cycles, modules, agents: agentsQ.data ?? [] }}
        title={boardTitle ?? "Work items"}
        breadcrumb={breadcrumb}
        // Le compteur porte sur ce qui est AFFICHÉ, filtres appliqués : montrer
        // le total du projet à côté d'une liste filtrée ferait douter du filtre.
        count={groups.reduce((n, g) => n + g.issues.length, 0)}
        onFilters={setFilters} onDisplay={setDisplay} onProperties={setProperties}
        onOpenAnalytics={onOpenAnalytics}
        trailing={
          <>
            {headerSlot}
            {/* L'export porte sur ce qui est AFFICHÉ, filtres compris : on
                filtre, on regarde, on exporte ce qu'on regarde. */}
            <button
              type="button"
              title="Exporter la vue en CSV"
              onClick={() => downloadCsv(
                `${project.identifier}-work-items`,
                issuesToCsv({
                  issues: groups.flatMap((g) => g.issues),
                  project, states, labels, members, cycles, modules,
                }),
              )}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <DownloadSimpleIcon className="h-4 w-4" />
            </button>
            <Button size="sm" className="h-8" onClick={() => setCreatingIn(states[0]?.id ?? "")}>
              <Plus className="mr-1 h-4 w-4" /> Ajouter un work item
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : !visibleCount ? (
          // Deux états DISTINCTS. Un board vide parce que le projet est neuf
          // appelle à créer ; un board vide parce que quelque chose MASQUE
          // appelle à relâcher ce quelque chose. Le même message pour les deux
          // envoie créer un doublon à quelqu'un dont l'item existe déjà.
          //
          // « Quelque chose » ne se limite pas aux filtres : le réglage
          // « Afficher » (Tout / Actifs / Backlog) et le masquage des
          // sous-tâches écartent des lignes tout aussi efficacement, sans
          // apparaître dans le compteur de critères. C'était le piège — un
          // board réglé sur « Actifs » dans un projet dont tout est en backlog
          // paraissait vide, et annonçait « aucun work item » alors qu'ils
          // étaient tous là.
          hiding ? (
            <EmptyState
              illustration={<SearchIllustration className="w-full" />}
              title="Tout est masqué par les réglages"
              hint={
                issues.length
                  ? `${issues.length} work item${issues.length > 1 ? "s" : ""} dans ce périmètre, mais les réglages d'affichage les écartent tous.`
                  : "Les critères en cours excluent tout ce que porte ce périmètre."
              }
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setFilters(EMPTY_FILTERS);
                    setDisplay({ ...display, type: "all", sub_issue: true });
                  }}
                >
                  Tout réafficher
                </Button>
              }
            />
          ) : (
            <EmptyState
              illustration={<BoardIllustration className="w-full" />}
              title="Aucun work item"
              hint={emptyHint ?? "Un work item est l'unité de travail : une tâche, un bug, une demande. Tout le reste — cycles, modules, epics — ne fait que les regrouper."}
              action={
                <Button size="sm" onClick={() => setCreatingIn(states[0]?.id ?? "")}>
                  <Plus className="mr-1 h-4 w-4" /> Créer le premier
                </Button>
              }
            />
          )
        ) : display.layout === "list" ? <ListLayout {...layoutProps} />
          : display.layout === "kanban" ? <KanbanLayout {...layoutProps} />
          : display.layout === "spreadsheet" ? <SpreadsheetLayout {...layoutProps} />
          : display.layout === "calendar" ? <CalendarLayout {...layoutProps} />
          : <GanttLayout {...layoutProps} />}
      </div>

      <BulkActionBar
        selected={[...selected]}
        states={states}
        cycles={cycles}
        project={project}
        dashboardId={dashboardId}
        onClear={clearSelection}
        onDone={refresh}
      />

      {open && (() => {
        // On relit l'item dans le cache à chaque rendu : une modification faite
        // depuis le board (glisser une carte, changer l'état dans la liste) doit
        // se voir dans la fiche ouverte, pas rester figée sur l'instantané du
        // clic.
        const current = issues.find((i) => i.id === open.id) ?? open;
        return (
          <PeekShell
            mode={peekMode}
            onMode={setPeekMode}
            onClose={() => setOpen(null)}
            header={<IssuePeekLead issue={current} project={project} states={states} />}
            actions={
              <IssuePeekActions
                issue={current}
                onClose={() => setOpen(null)}
                onChanged={refresh}
              />
            }
          >
            <IssueDetailPanel
              issue={current}
              project={project} states={states} labels={labels} members={members}
              cycles={cycles} modules={modules}
              dashboardId={dashboardId ?? project.dashboard_id}
              // La fermeture et la référence sont portées par l'enveloppe : deux
              // en-têtes empilés donneraient deux croix et deux titres.
              embedded
              onClose={() => setOpen(null)}
              onChanged={refresh}
              onOpenIssue={setOpen}
            />
          </PeekShell>
        );
      })()}

      {creatingIn !== null && (
        // La création reprend le groupe cliqué comme valeur par défaut :
        // cliquer « + » en tête de la colonne « En cours » puis devoir choisir
        // l'état à la main serait une question dont le geste a déjà donné la
        // réponse. Le cycle et le module du scope suivent la même règle.
        <CreateWorkItemModal
          dashboardId={project.dashboard_id}
          projectId={project.id}
          defaults={{
            stateId: display.group_by === "state" && creatingIn ? creatingIn : null,
            priority: display.group_by === "priority" ? (creatingIn as Priority) : "none",
            cycleId: scope.cycleId ?? null,
            moduleIds: scope.moduleId ? [scope.moduleId] : [],
          }}
          onClose={() => setCreatingIn(null)}
          onCreated={refresh}
        />
      )}
    </div>
  );
}

