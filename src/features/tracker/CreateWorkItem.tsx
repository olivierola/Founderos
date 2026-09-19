import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
import { CaretDownIcon, CaretRightIcon, CheckIcon, TreeStructureIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { ProjectLogo } from "./LogoPicker";
import { TextAreaField } from "./ui";
import {
  AssigneePicker, CyclePicker, DatePicker, IssueKey, LabelPicker, ModulePicker,
  PriorityPicker, StatePicker,
} from "./pickers";
import {
  createIssue, fetchCycles, fetchIssueTypes, fetchIssues, fetchLabels, fetchMembers,
  fetchModules, fetchProject, fetchProjects, fetchStates,
  type PjIssue, type PjProject, type Priority,
} from "./model";

/**
 * La modale « Create new work item » de Plane.
 *
 * Sa particularité, et ce qui la rend utilisable depuis n'importe où (la
 * sidebar, un board, un cycle), c'est qu'elle porte SON choix de projet : on
 * n'a pas besoin d'être déjà dans le bon projet pour noter une tâche. C'est ce
 * qui fait la différence entre « je note maintenant » et « je note plus tard,
 * quand j'aurai navigué » — et plus tard, on oublie.
 *
 * Les propriétés sont une rangée de pastilles sous la description, jamais un
 * formulaire en colonnes : la saisie normale, c'est un titre et Entrée. Tout le
 * reste est facultatif, et doit en avoir l'air.
 */
export function CreateWorkItemModal({
  dashboardId,
  projectId,
  defaults,
  onClose,
  onCreated,
}: {
  /**
   * Le tableau de service : c'est lui qui borne la liste des projets. Un projet
   * hérité d'avant les dashboards n'en a pas — d'où le `null`, qui laisse
   * quand même ouvrir la modale sur ce projet-là.
   */
  dashboardId: string | null;
  /** Le projet pré-choisi. Absent, la modale demande lequel. */
  projectId?: string | null;
  defaults?: {
    stateId?: string | null;
    priority?: Priority;
    cycleId?: string | null;
    moduleIds?: string[];
    parentId?: string | null;
    isEpic?: boolean;
  };
  onClose: () => void;
  onCreated: (issue: PjIssue) => void;
}) {
  const { user } = useAuth();

  const { data: list } = useQuery({
    queryKey: ["pj_projects", dashboardId],
    queryFn: () => fetchProjects(dashboardId as string),
    enabled: !!dashboardId,
  });

  // Le projet ouvert est chargé à part : sans tableau de service, il n'y a pas
  // de liste où le trouver, et la modale doit malgré tout savoir sur quoi elle
  // écrit.
  const { data: pinned } = useQuery({
    queryKey: ["pj_project", projectId],
    queryFn: () => fetchProject(projectId as string),
    enabled: !!projectId,
  });

  const projects = useMemo(() => {
    const all = list ?? [];
    if (pinned && !all.some((p) => p.id === pinned.id)) return [pinned, ...all];
    return all;
  }, [list, pinned]);

  const [pid, setPid] = useState<string | null>(projectId ?? null);
  // Un seul projet dans le service : le demander serait une question dont la
  // réponse est déjà connue.
  useEffect(() => {
    if (!pid && projects.length === 1) setPid(projects[0].id);
  }, [pid, projects]);

  const project = projects.find((p) => p.id === pid) ?? null;

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className="max-w-2xl gap-0 overflow-hidden p-0"
      >
        <div className="px-5 pt-5">
          <h2 className="text-lg font-medium">Créer un work item</h2>
          <div className="flex items-center gap-1.5 pt-3">
            <ProjectPicker
              projects={projects}
              value={pid}
              onChange={setPid}
            />
            {project && (
              <>
                <CaretRightIcon className="h-3.5 w-3.5 text-placeholder" />
                <TypePicker projectId={project.id} />
              </>
            )}
          </div>
        </div>

        {project ? (
          <CreateForm
            key={project.id}
            project={project}
            defaults={defaults}
            createdBy={user?.id ?? null}
            onClose={onClose}
            onCreated={onCreated}
          />
        ) : (
          <p className="px-5 py-10 text-center text-12 text-tertiary">
            Choisissez un projet pour continuer.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ProjectPicker({
  projects, value, onChange,
}: { projects: PjProject[]; value: string | null; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const current = projects.find((p) => p.id === value) ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-12 hover:bg-muted"
        >
          {current
            ? <ProjectLogo logo={current.logo_props} fallback={current.identifier} size={14} />
            : null}
          <span className="max-w-[160px] truncate">{current?.name ?? "Projet"}</span>
          <CaretDownIcon className="h-3 w-3 text-tertiary" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Chercher un projet…" />
          <CommandList>
            <CommandEmpty>Aucun projet.</CommandEmpty>
            <CommandGroup>
              {projects.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`${p.identifier} ${p.name}`}
                  onSelect={() => { onChange(p.id); setOpen(false); }}
                >
                  <ProjectLogo logo={p.logo_props} fallback={p.identifier} size={14} />
                  <span className="flex-1 truncate">{p.name}</span>
                  {p.id === value && <CheckIcon className="h-3.5 w-3.5" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Le type de work item, quand le projet en définit. */
function TypePicker({ projectId }: { projectId: string }) {
  const { data: types } = useQuery({
    queryKey: ["pj_issue_types", projectId],
    queryFn: () => fetchIssueTypes(projectId),
  });
  const list = types ?? [];
  const [value, setValue] = useState<string | null>(null);
  const current = list.find((t) => t.id === value) ?? list.find((t) => t.is_default) ?? null;

  // Sans types déclarés, on garde la pastille muette de Plane plutôt que de
  // faire disparaître un repère de la barre selon le projet ouvert.
  if (!list.length) {
    return (
      <span className="flex h-7 w-8 items-center justify-center rounded-md border border-border text-tertiary">
        <TreeStructureIcon className="h-3.5 w-3.5" />
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Type de work item"
          className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-12 hover:bg-muted"
        >
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: current?.color ?? "hsl(var(--muted-foreground))" }}
          />
          <span className="max-w-[120px] truncate">{current?.name ?? "Type"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-1" align="start">
        {list.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setValue(t.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-12",
              t.id === current?.id ? "bg-muted" : "hover:bg-muted",
            )}
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />
            <span className="flex-1 truncate">{t.name}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function CreateForm({
  project, defaults, createdBy, onClose, onCreated,
}: {
  project: PjProject;
  defaults?: {
    stateId?: string | null;
    priority?: Priority;
    cycleId?: string | null;
    moduleIds?: string[];
    parentId?: string | null;
    isEpic?: boolean;
  };
  createdBy: string | null;
  onClose: () => void;
  onCreated: (issue: PjIssue) => void;
}) {
  const statesQ = useQuery({ queryKey: ["pj_states", project.id], queryFn: () => fetchStates(project.id) });
  const labelsQ = useQuery({ queryKey: ["pj_labels", project.id], queryFn: () => fetchLabels(project.id) });
  const cyclesQ = useQuery({ queryKey: ["pj_cycles", project.id], queryFn: () => fetchCycles(project.id) });
  const modulesQ = useQuery({ queryKey: ["pj_modules", project.id], queryFn: () => fetchModules(project.id) });
  const membersQ = useQuery({
    queryKey: ["pj_members", project.workspace_id],
    queryFn: () => fetchMembers(project.workspace_id),
  });

  const states = statesQ.data ?? [];
  const labels = labelsQ.data ?? [];
  const cycles = cyclesQ.data ?? [];
  const modules = modulesQ.data ?? [];
  const members = membersQ.data ?? [];

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [stateId, setStateId] = useState<string | null>(defaults?.stateId ?? null);
  const [priority, setPriority] = useState<Priority>(defaults?.priority ?? "none");
  const [assignees, setAssignees] = useState<string[]>([]);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [start, setStart] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [cycleId, setCycleId] = useState<string | null>(defaults?.cycleId ?? null);
  const [moduleIds, setModuleIds] = useState<string[]>(defaults?.moduleIds ?? []);
  const [parentId, setParentId] = useState<string | null>(defaults?.parentId ?? null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * L'échec de l'enregistrement, montré à l'endroit où on l'a provoqué.
   *
   * Sans lui, un `try/finally` sans `catch` laissait l'erreur remonter dans le
   * vide : la modale restait ouverte, le bouton redevenait actif, et rien ne
   * disait que l'écriture avait échoué. C'est la pire des pannes — elle
   * ressemble à un clic qui n'a pas pris, on recommence, et on recommence.
   */
  const [error, setError] = useState<string | null>(null);

  // L'état par défaut du projet n'est connu qu'une fois les états chargés.
  useEffect(() => {
    if (stateId === null && states.length) {
      setStateId(states.find((s) => s.is_default)?.id ?? states[0].id);
    }
  }, [states, stateId]);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const issue = await createIssue({
        pjProjectId: project.id,
        workspaceId: project.workspace_id,
        name: name.trim(),
        description_text: description,
        description_html: description,
        state_id: stateId,
        priority,
        assignee_ids: assignees,
        label_ids: labelIds,
        start_date: start,
        target_date: target,
        cycle_id: cycleId,
        module_ids: moduleIds,
        parent_id: parentId,
        is_epic: defaults?.isEpic ?? false,
        createdBy,
      });
      onCreated(issue);

      if (more) {
        // « Créer plus » garde les propriétés et vide le contenu : on est en
        // train de saisir une liste, et re-choisir le cycle et l'assigné à
        // chaque ligne rendrait la saisie en rafale plus lente que l'aller-
        // retour qu'on cherche justement à éviter.
        setName("");
        setDescription("");
        setParentId(null);
      } else {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="space-y-3 px-5 pt-4">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // Entrée enregistre depuis le titre : c'est le geste de la saisie
            // rapide, celui pour lequel la modale existe.
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder="Titre"
          className="h-10 w-full rounded-md border border-border bg-muted/30 px-3 text-14 outline-none placeholder:text-placeholder focus:border-primary/50"
        />

        <TextAreaField
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Cliquez pour ajouter une description"
          autoResize
          className="min-h-[140px]"
        />

        <div className="flex flex-wrap gap-1.5 pb-1">
          <StatePicker states={states} value={stateId} onChange={setStateId} />
          <PriorityPicker value={priority} onChange={setPriority} />
          <AssigneePicker members={members} value={assignees} onChange={setAssignees} />
          <LabelPicker labels={labels} value={labelIds} onChange={setLabelIds} />
          <DatePicker value={start} onChange={setStart} placeholder="Date de début" />
          <DatePicker value={target} onChange={setTarget} placeholder="Échéance" min={start} />
          <CyclePicker cycles={cycles} value={cycleId} onChange={setCycleId} />
          <ModulePicker modules={modules} value={moduleIds} onChange={setModuleIds} />
          <ParentPicker
            project={project}
            value={parentId}
            onChange={setParentId}
          />
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3 border-t border-border px-5 py-3">
        {error && (
          <p className="min-w-0 flex-1 truncate text-11 text-destructive" title={error}>
            {error}
          </p>
        )}
        {!error && <div className="flex-1" />}
        {/* L'interrupteur « créer plus » avant les boutons : c'est un réglage de
            ce que fera Enregistrer, pas une action de plus. */}
        <label className="flex cursor-pointer select-none items-center gap-2 text-12 text-secondary">
          <span
            role="switch"
            aria-checked={more}
            onClick={() => setMore((v) => !v)}
            className={cn(
              "relative h-4 w-7 shrink-0 rounded-full transition-colors",
              more ? "bg-primary" : "bg-muted-foreground/40",
            )}
          >
            <span className={cn(
              "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all",
              more ? "left-3.5" : "left-0.5",
            )} />
          </span>
          Créer plus
        </label>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Abandonner</Button>
        <Button size="sm" onClick={submit} disabled={!name.trim() || busy}>
          {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Enregistrer
        </Button>
      </div>
    </>
  );
}

/** Le rattachement à un parent, cherché parmi les work items du projet. */
function ParentPicker({
  project, value, onChange,
}: { project: PjProject; value: string | null; onChange: (id: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const { data: issues } = useQuery({
    queryKey: ["pj_issues", { pjProjectId: project.id }],
    queryFn: () => fetchIssues({ pjProjectId: project.id }),
    // Ouverte seulement : sur un projet de mille items, charger la liste pour
    // une pastille qu'on ne clique presque jamais coûte plus que ça ne sert.
    enabled: open || !!value,
  });

  const parent = useMemo(
    () => (issues ?? []).find((i) => i.id === value) ?? null,
    [issues, value],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-7 max-w-[220px] items-center gap-1.5 rounded-md border px-2 text-12",
            value ? "border-primary/40 bg-primary/5" : "border-border hover:bg-muted",
          )}
        >
          <TreeStructureIcon className="h-3.5 w-3.5 shrink-0 text-tertiary" />
          {parent
            ? <span className="truncate">{project.identifier}-{parent.sequence_id}</span>
            : <span>Parent</span>}
          {value && (
            <span
              role="button"
              title="Détacher"
              onClick={(e) => { e.stopPropagation(); onChange(null); }}
              className="shrink-0 rounded hover:bg-muted"
            >
              <XIcon className="h-3 w-3" />
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Chercher un work item…" />
          <CommandList>
            <CommandEmpty>Aucun work item.</CommandEmpty>
            <CommandGroup>
              {(issues ?? []).slice(0, 100).map((i) => (
                <CommandItem
                  key={i.id}
                  value={`${project.identifier}-${i.sequence_id} ${i.name}`}
                  onSelect={() => { onChange(i.id); setOpen(false); }}
                >
                  <IssueKey identifier={project.identifier} sequenceId={i.sequence_id} />
                  <span className="flex-1 truncate">{i.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
