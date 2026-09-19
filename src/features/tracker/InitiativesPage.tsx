import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DotsThreeIcon, FlagIcon, PlusIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { DatePicker, formatDate } from "./pickers";
import { Checkbox, Modal, TextAreaField, TextField } from "./ui";
import { InitiativeIllustration } from "./illustrations";
import { EmptyState } from "./ui";
import {
  createInitiative, deleteInitiative, fetchInitiativeProgress, fetchInitiativeProjects,
  fetchInitiatives, fetchProjects, setInitiativeProjects, updateInitiative,
  type PjInitiative, type PjProject,
} from "./model";

/**
 * Les initiatives : le niveau au-dessus du projet.
 *
 * Là où un module regroupe des work items d'un même projet, une initiative
 * regroupe des PROJETS — c'est l'objet du « pourquoi » (un objectif
 * trimestriel, un chantier transverse). Son avancement est toujours calculé à
 * partir des projets qu'elle porte : un pourcentage saisi à la main serait faux
 * dès le lendemain, et personne ne le corrigerait.
 */

const STATUS: { key: PjInitiative["status"]; label: string; color: string }[] = [
  { key: "planned", label: "Planifiée", color: "#3b82f6" },
  { key: "active", label: "Active", color: "#f59e0b" },
  { key: "paused", label: "En pause", color: "#8b5cf6" },
  { key: "completed", label: "Terminée", color: "#16a34a" },
  { key: "cancelled", label: "Annulée", color: "#ef4444" },
];

export function InitiativesPage({
  dashboardId, workspaceId, onOpenProject, onOpenInitiative,
}: {
  dashboardId: string;
  workspaceId: string | null;
  onOpenProject: (id: string) => void;
  onOpenInitiative?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  const { data: initiatives } = useQuery({
    queryKey: ["pj_initiatives", dashboardId],
    queryFn: () => fetchInitiatives(dashboardId),
  });
  const { data: projects } = useQuery({
    queryKey: ["pj_projects", dashboardId],
    queryFn: () => fetchProjects(dashboardId),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_initiatives", dashboardId] });

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex h-header shrink-0 items-center justify-between px-4">
        <div>
          <h2 className="text-14 font-medium">Initiatives</h2>
          <p className="text-11 text-muted-foreground">
            Un objectif qui traverse plusieurs projets.
          </p>
        </div>
        <Button size="sm" className="h-8" onClick={() => setCreating(true)} disabled={!workspaceId}>
          <PlusIcon className="mr-1 h-4 w-4" /> Nouvelle initiative
        </Button>
      </header>

      {!initiatives?.length ? (
        <EmptyState
          illustration={<InitiativeIllustration className="w-full" />}
          title="Aucune initiative"
          hint="Une initiative rassemble plusieurs projets sous un même objectif — « ouvrir le marché allemand » — et donne l'avancement de l'ensemble, que ne dit aucun projet pris isolément."
          action={
            <Button size="sm" onClick={() => setCreating(true)} disabled={!workspaceId}>
              <PlusIcon className="mr-1 h-4 w-4" /> Nouvelle initiative
            </Button>
          }
        />
      ) : (
        <div className="space-y-2 px-4 pb-4">
          {initiatives.map((i) => (
            <InitiativeCard
              key={i.id} initiative={i} projects={projects ?? []}
              workspaceId={workspaceId} onChanged={refresh} onOpenProject={onOpenProject}
              onOpen={onOpenInitiative ? () => onOpenInitiative(i.id) : undefined}
            />
          ))}
        </div>
      )}

      {creating && workspaceId && (
        <InitiativeDialog
          workspaceId={workspaceId} dashboardId={dashboardId}
          onClose={() => setCreating(false)} onSaved={refresh}
        />
      )}
    </div>
  );
}

function InitiativeCard({
  initiative, projects, workspaceId, onChanged, onOpenProject, onOpen,
}: {
  initiative: PjInitiative; projects: PjProject[]; workspaceId: string | null;
  onChanged: () => void; onOpenProject: (id: string) => void;
  /** Ouvre la fiche complète (updates, périmètre, liens). */
  onOpen?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);

  const { data: progress } = useQuery({
    queryKey: ["pj_initiative_progress", initiative.id],
    queryFn: () => fetchInitiativeProgress(initiative.id),
  });
  const { data: linked } = useQuery({
    queryKey: ["pj_initiative_projects", initiative.id],
    queryFn: () => fetchInitiativeProjects(initiative.id),
  });

  const status = STATUS.find((s) => s.key === initiative.status);
  const percent = progress?.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  const members = projects.filter((p) => (linked ?? []).includes(p.id));

  return (
    <article className="rounded-lg border border-border/70 p-3">
      <div className="flex items-start gap-2">
        <FlagIcon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: status?.color }} />
        <button
          type="button"
          onClick={onOpen}
          disabled={!onOpen}
          className="min-w-0 flex-1 text-left disabled:cursor-default"
        >
          <h3 className="truncate text-14 font-medium">{initiative.name}</h3>
          {initiative.description && (
            <p className="truncate pt-0.5 text-11 text-muted-foreground">{initiative.description}</p>
          )}
        </button>
        <span
          className="inline-flex h-5 shrink-0 items-center rounded-full px-2 text-11 font-medium leading-none"
          style={{ background: `${status?.color}22`, color: status?.color }}
        >
          {status?.label}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted">
              <DotsThreeIcon className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setEditing(true)}>Modifier</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setPicking(true)}>Projets rattachés</DropdownMenuItem>
            <DropdownMenuItem
              className="text-red-600"
              onClick={async () => { await deleteInitiative(initiative.id); onChanged(); }}
            >
              Supprimer
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Les chiffres sont écrits, pas seulement tracés : une barre seule ne dit
          pas si « 40 % » porte sur dix items ou sur mille. */}
      <div className="flex items-center gap-3 pt-3 text-11 text-muted-foreground">
        <span>{progress?.projects ?? 0} projet(s)</span>
        <span>{progress?.completed ?? 0}/{progress?.total ?? 0} terminés</span>
        {(progress?.overdue ?? 0) > 0 && (
          <span className="text-amber-600">{progress?.overdue} en retard</span>
        )}
        {initiative.target_date && <span>Échéance {formatDate(initiative.target_date)}</span>}
        <span className="ml-auto tabular-nums">{percent}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-emerald-600" style={{ width: `${percent}%` }} />
      </div>

      {members.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-2.5">
          {members.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onOpenProject(p.id)}
              className="rounded border border-border/60 px-2 py-0.5 text-11 hover:bg-muted"
            >
              <span className="font-mono text-9 text-muted-foreground">{p.identifier}</span>{" "}
              {p.name}
            </button>
          ))}
        </div>
      )}

      {editing && workspaceId && (
        <InitiativeDialog
          workspaceId={workspaceId} dashboardId={initiative.dashboard_id ?? ""}
          initiative={initiative}
          onClose={() => setEditing(false)} onSaved={onChanged}
        />
      )}

      {picking && workspaceId && (
        <ProjectPickerDialog
          initiative={initiative} projects={projects} selected={linked ?? []}
          workspaceId={workspaceId}
          onClose={() => setPicking(false)} onSaved={onChanged}
        />
      )}
    </article>
  );
}

function ProjectPickerDialog({
  initiative, projects, selected, workspaceId, onClose, onSaved,
}: {
  initiative: PjInitiative; projects: PjProject[]; selected: string[];
  workspaceId: string; onClose: () => void; onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [ids, setIds] = useState<string[]>(selected);

  const toggle = (id: string) =>
    setIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = async () => {
    await setInitiativeProjects(initiative.id, workspaceId, ids);
    qc.invalidateQueries({ queryKey: ["pj_initiative_projects", initiative.id] });
    qc.invalidateQueries({ queryKey: ["pj_initiative_progress", initiative.id] });
    onSaved();
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={"Projets rattachés"}
      size="md"
      footer={<>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={submit}>Enregistrer</Button>
        </>}
    >
        {projects.map((p) => (
          <Checkbox
            key={p.id}
            checked={ids.includes(p.id)}
            onChange={() => toggle(p.id)}
            label={
              <span className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 font-mono text-10 text-tertiary">{p.identifier}</span>
                <span className="min-w-0 flex-1 truncate text-13">{p.name}</span>
              </span>
            }
          />
        ))}
        {!projects.length && (
          <p className="px-2 py-3 text-12 text-placeholder">Aucun projet dans ce service.</p>
        )}
    </Modal>
  );
}

function InitiativeDialog({
  workspaceId, dashboardId, initiative, onClose, onSaved,
}: {
  workspaceId: string; dashboardId: string; initiative?: PjInitiative;
  onClose: () => void; onSaved: () => void;
}) {
  const { user } = useAuth();
  const [name, setName] = useState(initiative?.name ?? "");
  const [description, setDescription] = useState(initiative?.description ?? "");
  const [status, setStatus] = useState<PjInitiative["status"]>(initiative?.status ?? "active");
  const [start, setStart] = useState<string | null>(initiative?.start_date ?? null);
  const [target, setTarget] = useState<string | null>(initiative?.target_date ?? null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (initiative) {
        await updateInitiative(initiative.id, {
          name: name.trim(), description, status, start_date: start, target_date: target,
        });
      } else {
        await createInitiative({
          workspaceId, dashboardId, name: name.trim(), description, status,
          start_date: start, target_date: target, createdBy: user?.id ?? null,
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
      title={initiative ? "Modifier l'initiative" : "Nouvelle initiative"}
      size="md"
      footer={<>
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button onClick={submit} disabled={!name.trim() || busy}>
              {initiative ? "Enregistrer" : "Créer"}
            </Button>
        </>}
    >
        <TextField autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom de l'initiative" />
        <TextAreaField
          value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="Quel objectif poursuit-elle ?" className="min-h-[80px]"
        />
        <div className="flex flex-wrap gap-1.5">
          {STATUS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setStatus(s.key)}
              className={cn(
                "rounded border px-2 py-1 text-12 transition-colors",
                status === s.key ? "border-primary/60 bg-primary/10" : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <DatePicker value={start} onChange={setStart} placeholder="Début" />
          <DatePicker value={target} onChange={setTarget} placeholder="Échéance" min={start} />
        </div>
        </Modal>
  );
}
