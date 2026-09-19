import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PlusIcon, RobotIcon, TrashIcon, UserIcon, UsersThreeIcon, WarningCircleIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { loadWorkspaceMembers, memberLabel } from "@/features/internal-agents/shared";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./AgentPicker";
import { PeopleIllustration } from "./illustrations";
import { Badge, EmptyState, Modal, PageHeader, SectionTitle, Select, TextField } from "./ui";
import {
  PROJECT_ROLES, addProjectMember, fetchProjectAgentLoad, fetchProjectAgents,
  fetchProjectMemberLoad, fetchProjectMembers, fetchTrackerAgents, removeProjectMember,
  setProjectAgents, setProjectMemberRole,
  type PjProject, type TrackerAgent,
} from "./model";

/**
 * L'équipage d'un projet : qui y travaille, humain ou machine.
 *
 * Les deux familles sont sur la MÊME page et dans le même vocabulaire, parce
 * que c'est la même question qu'on se pose en arrivant — « qui porte ce
 * projet ? » — et qu'elle ne se scinde pas selon la nature du porteur. Elles
 * restent en revanche dans deux sections distinctes, parce qu'elles ne se
 * règlent pas pareil : à une personne on donne un RANG, à un agent on donne un
 * DROIT D'AGIR.
 *
 * Cette dernière nuance est la seule chose qui compte vraiment ici. Ajouter une
 * personne à un projet ne lui ouvre rien qu'elle n'ait déjà — la sécurité
 * s'appuie sur l'appartenance à l'espace de travail, et le rang ne filtre que
 * l'interface. Ajouter un AGENT, en revanche, lui donne le droit d'écrire dans
 * ce projet : `pj_project_agents` vide veut dire aucun accès, jamais « tous ».
 * D'où l'avertissement sous la section, et d'où le fait qu'on retire un agent
 * d'un clic sans confirmation — révoquer doit toujours être plus facile
 * qu'accorder.
 */

export function CrewPage({
  project, dashboardId,
}: { project: PjProject; dashboardId: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [adding, setAdding] = useState<"member" | "agent" | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["pj_project_members", project.id] });
    qc.invalidateQueries({ queryKey: ["pj_project_agents", project.id] });
  };

  const members = useQuery({
    queryKey: ["pj_project_members", project.id],
    queryFn: () => fetchProjectMembers(project.id),
  });
  const agents = useQuery({
    queryKey: ["pj_project_agents", project.id],
    queryFn: () => fetchProjectAgents(project.id),
  });
  const directory = useQuery({
    queryKey: ["pj_ws_members", project.workspace_id],
    queryFn: () => loadWorkspaceMembers(project.workspace_id),
  });
  const roster = useQuery({
    queryKey: ["pj_tracker_agents", dashboardId, project.workspace_id],
    queryFn: () => fetchTrackerAgents(dashboardId, project.workspace_id),
  });
  const memberLoad = useQuery({
    queryKey: ["pj_project_member_load", project.id],
    queryFn: () => fetchProjectMemberLoad(project.id),
  });
  const agentLoad = useQuery({
    queryKey: ["pj_project_agent_load", project.id],
    queryFn: () => fetchProjectAgentLoad(project.id),
  });

  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: number }) => setProjectMemberRole(id, role),
    onSuccess: invalidate,
  });
  const dropMember = useMutation({
    mutationFn: (id: string) => removeProjectMember(id),
    onSuccess: invalidate,
  });
  const writeAgents = useMutation({
    mutationFn: (entries: Array<{ agent_id: string; role: "contributor" | "observer" }>) =>
      setProjectAgents(project.id, project.workspace_id, entries),
    onSuccess: invalidate,
  });

  const memberRows = members.data ?? [];
  const agentRows = (agents.data ?? []) as Array<{ agent_id: string; role: string }>;
  const rosterById = useMemo(
    () => new Map((roster.data ?? []).map((a) => [a.id, a])),
    [roster.data],
  );

  const empty = !memberRows.length && !agentRows.length;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={<UsersThreeIcon className="h-4 w-4" />}
        title="Équipage"
        subtitle="Qui travaille sur ce projet — et ce que chacun y porte."
        actions={
          <>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setAdding("agent")}>
              <RobotIcon className="h-3.5 w-3.5" /> Agent
            </Button>
            <Button size="sm" className="h-8 gap-1.5" onClick={() => setAdding("member")}>
              <PlusIcon className="h-3.5 w-3.5" /> Personne
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {empty && !members.isLoading && !agents.isLoading ? (
          <EmptyState
            illustration={<PeopleIllustration className="w-full" />}
            title="Personne sur ce projet"
            hint="Ajoutez les personnes qui y travaillent, et les agents autorisés à y agir."
            action={
              <Button size="sm" onClick={() => setAdding("member")}>Ajouter une personne</Button>
            }
            secondaryAction={
              <Button size="sm" variant="outline" onClick={() => setAdding("agent")}>
                Autoriser un agent
              </Button>
            }
          />
        ) : (
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-5">
            <section>
              <SectionTitle>Personnes</SectionTitle>
              {memberRows.length ? (
                <ul className="mt-1.5 overflow-hidden rounded-lg border border-border">
                  {memberRows.map((m) => {
                    const who = (directory.data ?? []).find((d) => d.user_id === m.user_id);
                    const load = memberLoad.data?.get(m.user_id);
                    return (
                      <li
                        key={m.id}
                        className="flex items-center gap-3 border-b border-border/60 px-3 py-2 last:border-b-0"
                      >
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted text-11 font-medium uppercase text-tertiary">
                          {(memberLabel(who, m.user_id)[0] ?? "?").toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-13">
                            {memberLabel(who, m.user_id)}
                            {m.user_id === user?.id && (
                              <span className="ml-1.5 text-11 text-tertiary">(vous)</span>
                            )}
                          </span>
                          {who?.email && who.full_name && (
                            <span className="block truncate text-11 text-tertiary">{who.email}</span>
                          )}
                        </span>

                        <LoadBadge load={load} />

                        <div className="w-32 shrink-0">
                          <Select
                            size="xs"
                            value={String(m.role)}
                            onChange={(v) => setRole.mutate({ id: m.id, role: Number(v) })}
                            options={PROJECT_ROLES.map((r) => ({
                              key: String(r.key), label: r.label, hint: r.hint,
                            }))}
                          />
                        </div>

                        <RemoveButton
                          title="Retirer du projet"
                          onClick={() => dropMember.mutate(m.id)}
                        />
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <EmptyState
                  compact
                  className="mt-1.5"
                  icon={<UserIcon className="h-4 w-4" />}
                  title="Aucune personne"
                  hint="Le projet n'est porté par personne pour l'instant."
                  action={
                    <Button size="sm" variant="outline" onClick={() => setAdding("member")}>
                      Ajouter
                    </Button>
                  }
                />
              )}
            </section>

            <section>
              <SectionTitle>Agents</SectionTitle>
              {agentRows.length ? (
                <ul className="mt-1.5 overflow-hidden rounded-lg border border-border">
                  {agentRows.map((row) => {
                    const a = rosterById.get(row.agent_id);
                    const load = agentLoad.data?.get(row.agent_id);
                    return (
                      <li
                        key={row.agent_id}
                        className="flex items-center gap-3 border-b border-border/60 px-3 py-2 last:border-b-0"
                      >
                        <AgentAvatar agent={a} size={28} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-13">
                            {a?.name ?? "Agent retiré"}
                          </span>
                          <span className="block text-11 text-tertiary">
                            {row.role === "observer"
                              ? "Lit le projet, n'y écrit pas."
                              : "Peut créer et faire avancer du travail ici."}
                          </span>
                        </span>

                        <LoadBadge load={load} />

                        <div className="w-32 shrink-0">
                          <Select
                            size="xs"
                            value={row.role}
                            onChange={(v) => writeAgents.mutate(
                              agentRows.map((r) => ({
                                agent_id: r.agent_id,
                                role: (r.agent_id === row.agent_id ? v : r.role) as "contributor" | "observer",
                              })),
                            )}
                            options={[
                              { key: "contributor", label: "Agit", hint: "Écrit dans le projet" },
                              { key: "observer", label: "Observe", hint: "Lecture seule" },
                            ]}
                          />
                        </div>

                        <RemoveButton
                          title="Révoquer l'accès"
                          onClick={() => writeAgents.mutate(
                            agentRows
                              .filter((r) => r.agent_id !== row.agent_id)
                              .map((r) => ({ agent_id: r.agent_id, role: r.role as "contributor" | "observer" })),
                          )}
                        />
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <EmptyState
                  compact
                  className="mt-1.5"
                  icon={<RobotIcon className="h-4 w-4" />}
                  title="Aucun agent autorisé"
                  hint="Tant que cette liste est vide, aucun agent ne peut agir sur ce projet."
                  action={
                    <Button size="sm" variant="outline" onClick={() => setAdding("agent")}>
                      Autoriser un agent
                    </Button>
                  }
                />
              )}

              {/* L'avertissement est SOUS la liste et non dans la modale : c'est
                  en relisant l'équipage qu'on se demande si un accès est encore
                  justifié, pas au moment où on vient d'en accorder un. */}
              <p className="mt-2 flex items-start gap-1.5 text-11 leading-snug text-tertiary">
                <WarningCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
                Cette liste est un périmètre d&apos;écriture : un agent absent d&apos;ici ne peut
                rien modifier dans le projet, même si on lui assigne un work item.
              </p>
            </section>
          </div>
        )}
      </div>

      {adding === "member" && (
        <AddMemberDialog
          project={project}
          taken={memberRows.map((m) => m.user_id)}
          onClose={() => setAdding(null)}
          onAdded={() => { setAdding(null); invalidate(); }}
        />
      )}

      {adding === "agent" && (
        <AddAgentDialog
          roster={roster.data ?? []}
          taken={agentRows.map((r) => r.agent_id)}
          busy={writeAgents.isPending}
          onClose={() => setAdding(null)}
          onAdd={(id, role) => {
            writeAgents.mutate(
              [
                ...agentRows.map((r) => ({
                  agent_id: r.agent_id, role: r.role as "contributor" | "observer",
                })),
                { agent_id: id, role },
              ],
              { onSuccess: () => setAdding(null) },
            );
          }}
        />
      )}
    </div>
  );
}

/**
 * Ce que quelqu'un porte, en deux nombres.
 *
 * Les ouverts d'abord et en gras : c'est la seule moitié actionnable. Le
 * cumul des terminés n'est là que pour donner l'échelle — sans lui, « 3 en
 * cours » ne dit pas si la personne débute sur le projet ou l'a tenu à bout
 * de bras.
 */
function LoadBadge({ load }: { load?: { open: number; done: number } }) {
  if (!load || (!load.open && !load.done)) {
    return <span className="hidden w-20 shrink-0 text-right text-11 text-placeholder sm:block">—</span>;
  }
  return (
    <span className="hidden w-20 shrink-0 justify-end sm:flex">
      <Badge tone={load.open ? "neutral" : "outline"}>
        <span className="tabular-nums">{load.open}</span>
        <span className="opacity-60">/{load.open + load.done}</span>
      </Badge>
    </span>
  );
}

function RemoveButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-tertiary transition-colors",
        "hover:bg-red-500/10 hover:text-red-600",
      )}
    >
      <TrashIcon className="h-3.5 w-3.5" />
    </button>
  );
}

function AddMemberDialog({
  project, taken, onClose, onAdded,
}: {
  project: PjProject; taken: string[];
  onClose: () => void; onAdded: () => void;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState(15);

  const { data } = useQuery({
    queryKey: ["pj_ws_members", project.workspace_id],
    queryFn: () => loadWorkspaceMembers(project.workspace_id),
  });

  const add = useMutation({
    mutationFn: (userId: string) => addProjectMember({
      pjProjectId: project.id, workspaceId: project.workspace_id, userId, role,
    }),
    onSuccess: onAdded,
  });

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data ?? [])
      .filter((m) => !taken.includes(m.user_id))
      .filter((m) => !q || memberLabel(m).toLowerCase().includes(q));
  }, [data, taken, query]);

  return (
    <Modal
      open
      onClose={onClose}
      title="Ajouter une personne"
      description="Parmi les membres de l'espace de travail."
      busy={add.isPending}
    >
      <div className="flex items-center gap-2">
        <TextField
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Chercher…"
          autoFocus
        />
        <div className="w-32 shrink-0">
          <Select
            value={String(role)}
            onChange={(v) => setRole(Number(v))}
            options={PROJECT_ROLES.map((r) => ({ key: String(r.key), label: r.label, hint: r.hint }))}
          />
        </div>
      </div>

      {add.error && (
        <p className="text-11 text-red-600">{(add.error as Error).message}</p>
      )}

      <div className="max-h-72 overflow-y-auto">
        {candidates.length ? (
          candidates.map((m) => (
            <button
              key={m.user_id}
              type="button"
              disabled={add.isPending}
              onClick={() => add.mutate(m.user_id)}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:opacity-50"
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-muted text-10 font-medium uppercase text-tertiary">
                {(memberLabel(m)[0] ?? "?").toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-12">{memberLabel(m)}</span>
            </button>
          ))
        ) : (
          <p className="px-2 py-6 text-center text-12 text-placeholder">
            {query
              ? "Personne ne correspond."
              : "Tous les membres de l'espace sont déjà sur ce projet."}
          </p>
        )}
      </div>
    </Modal>
  );
}

function AddAgentDialog({
  roster, taken, busy, onClose, onAdd,
}: {
  roster: TrackerAgent[]; taken: string[]; busy: boolean;
  onClose: () => void;
  onAdd: (agentId: string, role: "contributor" | "observer") => void;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<"contributor" | "observer">("contributor");

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return roster
      .filter((a) => !taken.includes(a.id))
      .filter((a) => !q || a.name.toLowerCase().includes(q));
  }, [roster, taken, query]);

  return (
    <Modal
      open
      onClose={onClose}
      title="Autoriser un agent"
      description="Il pourra agir sur ce projet, dans la limite du rôle choisi."
      busy={busy}
    >
      <div className="flex items-center gap-2">
        <TextField
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Chercher un agent…"
          autoFocus
        />
        <div className="w-32 shrink-0">
          <Select
            value={role}
            onChange={(v) => setRole(v as "contributor" | "observer")}
            options={[
              { key: "contributor", label: "Agit", hint: "Écrit dans le projet" },
              { key: "observer", label: "Observe", hint: "Lecture seule" },
            ]}
          />
        </div>
      </div>

      {/* Dit AVANT le choix, parce que c'est une conséquence du geste et non
          un détail de réglage : accorder le périmètre donne aussi l'outil qui
          permet d'en faire quelque chose. */}
      {role === "contributor" && (
        <p className="rounded-md bg-muted/40 px-2.5 py-2 text-11 leading-snug text-tertiary">
          L&apos;agent recevra l&apos;outil de suivi de travail, borné à ce projet.
          Le retirer d&apos;ici lui en retire l&apos;accès aussitôt.
        </p>
      )}

      <div className="max-h-72 overflow-y-auto">
        {candidates.length ? (
          candidates.map((a) => (
            <button
              key={a.id}
              type="button"
              disabled={busy}
              onClick={() => onAdd(a.id, role)}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:opacity-50"
            >
              <AgentAvatar agent={a} size={24} />
              <span className="min-w-0 flex-1 truncate text-12">{a.name}</span>
            </button>
          ))
        ) : (
          <p className="px-2 py-6 text-center text-12 text-placeholder">
            {query
              ? "Aucun agent ne correspond."
              : roster.length
                ? "Tous les agents disponibles sont déjà autorisés."
                : "Aucun agent dans cet espace de travail."}
          </p>
        )}
      </div>
    </Modal>
  );
}
