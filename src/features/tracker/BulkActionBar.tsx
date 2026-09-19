import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { useAuth } from "@/lib/auth-context";
import { AgentAvatar } from "./AgentPicker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StateIcon, PriorityIcon } from "./pickers";
import {
  PRIORITIES, archiveIssue, bulkAssignAgent, bulkUpdate, deleteIssue,
  fetchProjectAgents, fetchTrackerAgents,
  type PjCycle, type PjProject, type PjState, type Priority,
} from "./model";

/**
 * La barre d'actions en lot, qui apparaît dès qu'une ligne est cochée.
 *
 * Elle passe par `pj_bulk_update` (une seule transaction) et non par N appels :
 * cinquante écritures séparées laisseraient la moitié de la sélection à
 * l'ancien état si le réseau lâche au milieu — et personne ne saurait
 * laquelle.
 *
 * Elle flotte en bas de l'écran plutôt que de pousser le contenu : la
 * sélection se fait EN LISANT la liste, et décaler les lignes au moment où l'on
 * coche ferait perdre la place où l'on en était.
 */
export function BulkActionBar({
  selected, states, cycles, onClear, onDone, project, dashboardId,
}: {
  selected: string[];
  states: PjState[];
  cycles: PjCycle[];
  onClear: () => void;
  onDone: () => void;
  /** Le projet, pour proposer SES agents autorisés en écriture. */
  project: PjProject;
  dashboardId?: string | null;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);

  // Seuls les agents qui ont le DROIT d'agir sur ce projet. Confier un lot à un
  // agent observateur ou hors périmètre ne produirait qu'une file d'items qu'il
  // ne peut pas toucher — l'assignation dirait « c'est à lui », le périmètre
  // dirait « il n'a pas le droit ».
  const { data: roster } = useQuery({
    queryKey: ["pj_tracker_agents", dashboardId ?? project.dashboard_id, project.workspace_id],
    enabled: selected.length > 0,
    queryFn: () => fetchTrackerAgents(dashboardId ?? project.dashboard_id, project.workspace_id),
  });
  const { data: scope } = useQuery({
    queryKey: ["pj_project_agents", project.id],
    enabled: selected.length > 0,
    queryFn: () => fetchProjectAgents(project.id),
  });
  const writable = useMemo(() => {
    const ids = new Set((scope ?? []).filter((a) => a.role !== "observer").map((a) => a.agent_id));
    return (roster ?? []).filter((a) => ids.has(a.id));
  }, [roster, scope]);

  if (!selected.length) return null;

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      qc.invalidateQueries({ queryKey: ["pj_issues"] });
      onDone();
      onClear();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-background/95 px-2.5 py-1.5 shadow-lg backdrop-blur">
        <span className="px-1.5 text-13 font-medium tabular-nums">
          {selected.length} sélectionné{selected.length > 1 ? "s" : ""}
        </span>

        <span className="h-4 w-px bg-border" />

        {writable.length > 0 && (
          <BulkMenu label="Agent">
            {writable.map((a) => (
              <DropdownMenuItem
                key={a.id}
                onClick={() => run(async () => {
                  await bulkAssignAgent({
                    issueIds: selected, agentId: a.id,
                    workspaceId: project.workspace_id, assignedBy: user?.id ?? null,
                  });
                  qc.invalidateQueries({ queryKey: ["pj_project_agent_load", project.id] });
                })}
              >
                <AgentAvatar agent={a} size={18} /> {a.name}
              </DropdownMenuItem>
            ))}
          </BulkMenu>
        )}

        <BulkMenu label="État">
          {states.map((s) => (
            <DropdownMenuItem
              key={s.id}
              onClick={() => run(() => bulkUpdate({ issueIds: selected, state_id: s.id }))}
            >
              <StateIcon group={s.group} color={s.color} /> {s.name}
            </DropdownMenuItem>
          ))}
        </BulkMenu>

        <BulkMenu label="Priorité">
          {PRIORITIES.map((p) => (
            <DropdownMenuItem
              key={p.key}
              onClick={() => run(() => bulkUpdate({ issueIds: selected, priority: p.key as Priority }))}
            >
              <PriorityIcon priority={p.key as Priority} /> {p.label}
            </DropdownMenuItem>
          ))}
        </BulkMenu>

        {cycles.length > 0 && (
          <BulkMenu label="Cycle">
            {cycles.map((c) => (
              <DropdownMenuItem
                key={c.id}
                onClick={() => run(() => bulkUpdate({ issueIds: selected, cycle_id: c.id }))}
              >
                {c.name}
              </DropdownMenuItem>
            ))}
          </BulkMenu>
        )}

        <span className="h-4 w-px bg-border" />

        <button
          type="button"
          title="Archiver"
          disabled={busy}
          onClick={() => run(async () => {
            // En série : l'archivage n'a pas d'équivalent en lot côté base, et
            // paralléliser cinquante requêtes sature la connexion.
            for (const id of selected) await archiveIssue(id, true);
          })}
          className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArchiveIcon className="h-4 w-4" />
        </button>

        <button
          type="button"
          title="Supprimer"
          disabled={busy}
          onClick={() => {
            // Confirmation explicite : contrairement à l'archivage, la
            // suppression emporte le journal et les commentaires.
            if (!window.confirm(`Supprimer définitivement ${selected.length} work item(s) ? Le journal et les commentaires seront perdus.`)) return;
            run(async () => { for (const id of selected) await deleteIssue(id); });
          }}
          className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-red-600"
        >
          <TrashIcon className="h-4 w-4" />
        </button>

        <span className="h-4 w-px bg-border" />

        <button
          type="button"
          onClick={onClear}
          title="Annuler la sélection"
          className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function BulkMenu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 rounded-full px-2.5 text-12">
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="max-h-72 overflow-y-auto">
        <DropdownMenuLabel className="text-11">{label}</DropdownMenuLabel>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
