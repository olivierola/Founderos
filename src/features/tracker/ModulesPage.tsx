import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, DotsThreeIcon, PlusIcon, StackIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { IssuesBoard } from "./IssuesBoard";
import { EmptyState, Modal, PageHeader, TextAreaField, TextField } from "./ui";
import { ModuleIllustration } from "./illustrations";
import { ProgressBar, useProgress } from "./CyclesPage";
import { DatePicker, MemberAvatar, formatDate, memberName } from "./pickers";
import { archiveModule } from "./model";
import { AddExistingIssues } from "./cycles/AddExisting";
import {
  createModule, deleteModule, fetchIssues, fetchMembers, fetchModules, fetchStates,
  updateModule, type PjModule, type PjProject,
} from "./model";

/**
 * Les modules : les chantiers du projet.
 *
 * Différence avec un cycle, et c'est tout ce qu'il faut retenir : un cycle est
 * borné dans le TEMPS (une itération), un module est borné par un PÉRIMÈTRE
 * (une fonctionnalité). D'où un statut saisi ici — un chantier peut être en
 * pause sans qu'aucune date ne le dise.
 */

/**
 * Les six statuts, dans la palette de 0225 — et surtout dans son principe :
 * ce qui n'a pas commencé ou ne bouge plus reste GRIS. Sur une grille de vingt
 * modules, colorer le backlog et les chantiers annulés noie les deux seuls
 * statuts qui appellent une action.
 *
 * Les mêmes valeurs sont reprises dans l'onglet Modules d'Analytics : deux
 * tables de couleurs pour un même statut finiraient par diverger.
 */
const MODULE_STATUS: { key: PjModule["status"]; label: string; color: string }[] = [
  { key: "backlog", label: "Backlog", color: "#8b8f99" },
  { key: "planned", label: "Planifié", color: "#4b7fd6" },
  { key: "in-progress", label: "En cours", color: "#eda100" },
  { key: "paused", label: "En pause", color: "#8c8fa4" },
  { key: "completed", label: "Terminé", color: "#3e9b4f" },
  { key: "cancelled", label: "Annulé", color: "#8c8fa4" },
];

export function ModulesPage({ project }: { project: PjProject }) {
  const qc = useQueryClient();
  const [openModule, setOpenModule] = useState<PjModule | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: modules } = useQuery({
    queryKey: ["pj_modules", project.id],
    queryFn: () => fetchModules(project.id),
  });
  const { data: states } = useQuery({
    queryKey: ["pj_states", project.id],
    queryFn: () => fetchStates(project.id),
  });
  const { data: allIssues } = useQuery({
    queryKey: ["pj_issues", { pjProjectId: project.id }],
    queryFn: () => fetchIssues({ pjProjectId: project.id }),
  });
  const { data: members } = useQuery({
    queryKey: ["pj_members", project.workspace_id],
    queryFn: () => fetchMembers(project.workspace_id),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_modules", project.id] });

  if (openModule) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          icon={
            <button type="button" onClick={() => setOpenModule(null)} className="rounded p-0.5 hover:bg-muted">
              <ArrowLeftIcon className="h-4 w-4" />
            </button>
          }
          title={openModule.name}
          subtitle={[
            MODULE_STATUS.find((s) => s.key === openModule.status)?.label,
            openModule.target_date ? `échéance ${formatDate(openModule.target_date)}` : null,
          ].filter(Boolean).join(" · ")}
        />
        <div className="min-h-0 flex-1">
          <IssuesBoard
            project={project}
            scope={{ pjProjectId: project.id, moduleId: openModule.id }}
            scopeKey={`module-${openModule.id}`}
            emptyHint="Ce module ne contient encore aucun work item."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={<StackIcon className="h-4 w-4" />}
        title="Modules"
        subtitle="Des chantiers qui regroupent du travail"
        actions={
          <Button size="sm" className="h-8 gap-1.5" onClick={() => setCreating(true)}>
            <PlusIcon className="h-4 w-4" /> Nouveau module
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
      {!modules?.length ? (
        <EmptyState
          illustration={<ModuleIllustration className="w-full" />}
          title="Aucun module"
          hint="Un module regroupe le travail d'un chantier — contrairement au cycle, il n'est pas borné par des dates mais par ce qu'il y a à livrer."
          action={<Button size="sm" onClick={() => setCreating(true)}>Créer un module</Button>}
        />
      ) : (
        <div className="grid gap-2 px-4 pb-4 md:grid-cols-2 xl:grid-cols-3">
          {modules.map((m) => {
            const issues = (allIssues ?? []).filter((i) => i.module_ids.includes(m.id));
            const status = MODULE_STATUS.find((s) => s.key === m.status);
            const lead = (members ?? []).find((x) => x.user_id === m.lead_id);
            return (
              <article key={m.id} className="rounded-lg border border-border/70 bg-card p-3 shadow-raised-100 transition-colors hover:border-border">
                <div className="flex items-start gap-2">
                  <button type="button" onClick={() => setOpenModule(m)} className="min-w-0 flex-1 text-left">
                    <h3 className="truncate text-14 font-medium">{m.name}</h3>
                    {m.description && (
                      <p className="truncate pt-0.5 text-11 text-muted-foreground">{m.description}</p>
                    )}
                  </button>
                  <span
                    className="inline-flex h-5 shrink-0 items-center rounded-full px-2 text-11 font-medium leading-none"
                    style={{ background: `${status?.color}22`, color: status?.color }}
                  >
                    {status?.label}
                  </span>
                  <ModuleMenu module={m} project={project} onChanged={refresh} />
                </div>

                <div className="flex items-center gap-2 pt-2 text-11 text-muted-foreground">
                  {lead && (
                    <span className="flex items-center gap-1">
                      <MemberAvatar member={lead} size={16} /> {memberName(lead)}
                    </span>
                  )}
                  {m.target_date && <span>Échéance {formatDate(m.target_date)}</span>}
                </div>

                <ModuleProgress issues={issues} states={states ?? []} />
              </article>
            );
          })}
        </div>
      )}
      </div>

      {creating && (
        <ModuleDialog project={project} onClose={() => setCreating(false)} onSaved={refresh} />
      )}
    </div>
  );
}

function ModuleProgress({
  issues, states,
}: { issues: Parameters<typeof useProgress>[0]; states: Parameters<typeof useProgress>[1] }) {
  const stats = useProgress(issues, states);
  return <ProgressBar stats={stats} />;
}

function ModuleMenu({
  module, project, onChanged,
}: { module: PjModule; project: PjProject; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted">
            <DotsThreeIcon className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setAdding(true)}>
            Ajouter des work items existants
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setEditing(true)}>Modifier</DropdownMenuItem>
          {/* Archiver détache le module des listes sans toucher aux work items
              qu'il regroupait ; supprimer, lui, dénoue tous ces rattachements. */}
          <DropdownMenuItem onClick={async () => { await archiveModule(module.id); onChanged(); }}>
            Archiver
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-red-600"
            onClick={async () => { await deleteModule(module.id); onChanged(); }}
          >
            Supprimer
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {editing && (
        <ModuleDialog
          project={project} module={module}
          onClose={() => setEditing(false)} onSaved={onChanged}
        />
      )}
      {adding && (
        <AddExistingIssues
          project={project}
          target={{ kind: "module", id: module.id, name: module.name }}
          onClose={() => setAdding(false)}
          onDone={onChanged}
        />
      )}
    </>
  );
}

function ModuleDialog({
  project, module, onClose, onSaved,
}: { project: PjProject; module?: PjModule; onClose: () => void; onSaved: () => void }) {
  const { user } = useAuth();
  const [name, setName] = useState(module?.name ?? "");
  const [description, setDescription] = useState(module?.description ?? "");
  const [status, setStatus] = useState<PjModule["status"]>(module?.status ?? "planned");
  const [start, setStart] = useState<string | null>(module?.start_date ?? null);
  const [target, setTarget] = useState<string | null>(module?.target_date ?? null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (module) {
        await updateModule(module.id, {
          name: name.trim(), description, status, start_date: start, target_date: target,
        });
      } else {
        await createModule({
          pjProjectId: project.id, workspaceId: project.workspace_id,
          name: name.trim(), description, status, start_date: start, target_date: target,
          createdBy: user?.id ?? null,
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
      title={module ? "Modifier le module" : "Nouveau module"}
      size="md"
      footer={<>
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button onClick={submit} disabled={!name.trim() || busy}>
              {module ? "Enregistrer" : "Créer"}
            </Button>
        </>}
    >
        <TextField autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du module" />
        <TextAreaField
          value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="Périmètre du chantier…" className="min-h-[80px]"
        />
        <div className="flex flex-wrap gap-1.5">
          {MODULE_STATUS.map((s) => (
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
