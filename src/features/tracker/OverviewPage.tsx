import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ImageIcon, InfoIcon, LightningIcon, PulseIcon, SidebarSimpleIcon, XIcon,
} from "@phosphor-icons/react";
import { COVERS, resolveCover } from "@/features/artifacts/covers";
import { useCategorical } from "@/features/crm/overview/vizPalette";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { IssueKey, MemberAvatar, PriorityIcon, StateIcon, formatDate, formatRelative, memberName } from "./pickers";
import { useProgress, ProgressBar } from "./CyclesPage";
import { LogoPicker } from "./LogoPicker";
import { PageEditor } from "./PageEditor";
import { EmptyState } from "./ui";
import {
  cyclePhase, fetchCycles, fetchIssues, fetchMembers, fetchModules, fetchStates,
  fetchStatusUpdates, updateProject, type PjProject,
} from "./model";

/**
 * L'Overview d'un projet : un DOCUMENT, pas un tableau de bord.
 *
 * C'est le changement de nature qui compte ici. Une page d'arrivée sur un
 * projet doit d'abord répondre à « qu'est-ce que c'est » — ce qu'on y fait, ce
 * qui est décidé, ce qui est hors périmètre. Aucune de ces réponses ne tient
 * dans un compteur ; elles se rédigent. D'où la couverture, le titre et
 * l'éditeur riche, qui donnent au projet une page qu'on peut vraiment lire.
 *
 * Les chiffres n'ont pas disparu : ils sont passés dans le panneau de droite,
 * qui répond à « où en est-on ». Les mettre au centre revenait à dire que
 * l'avancement est plus important que le sujet, ce qui n'est vrai que pour qui
 * connaît déjà le projet.
 */
export function OverviewPage({ project, onOpenIssue }: {
  project: PjProject;
  onOpenIssue?: (issueId: string) => void;
}) {
  const qc = useQueryClient();
  const [panel, setPanel] = useState(true);
  const [name, setName] = useState(project.name);

  const refreshProject = () => qc.invalidateQueries({ queryKey: ["pj_projects"] });

  const saveDoc = (rich: unknown[], text: string) => {
    // On écrit les DEUX : l'arbre pour l'éditeur, le texte pour la recherche et
    // les cartes de la liste des projets, qui ne savent pas lire un arbre.
    updateProject(project.id, {
      description_rich: rich,
      description: text,
    });
  };

  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <ProjectCover project={project} onChanged={refreshProject} />

        <div className="mx-auto max-w-3xl px-6 pb-24">
          {/* Le logo chevauche la couverture : c'est ce qui rattache l'en-tête
              au corps, là où deux blocs empilés se liraient comme deux pages
              collées l'une sous l'autre. */}
          <div className="-mt-7 pb-4">
            <span className="inline-flex h-14 w-14 items-center justify-center rounded-lg border border-border bg-card shadow-raised-200">
              <LogoPicker
                value={project.logo_props}
                fallback={project.identifier}
                size={30}
                onChange={async (logo) => {
                  await updateProject(project.id, { logo_props: logo });
                  refreshProject();
                }}
              />
            </span>
          </div>

          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={async () => {
              if (!name.trim() || name === project.name) { setName(project.name); return; }
              await updateProject(project.id, { name: name.trim() });
              refreshProject();
            }}
            className="w-full bg-transparent pb-4 text-24 font-semibold outline-none placeholder:text-placeholder"
            placeholder="Nom du projet"
          />

          <PageEditor
            // Remonter le projet remonte un arbre différent : sans clé, Plate
            // garderait en mémoire le document du projet précédent.
            key={project.id}
            value={project.description_rich ?? project.description ?? null}
            onSave={saveDoc}
            placeholder="Décrivez ce projet : ce qu'il couvre, ce qui est décidé, ce qui n'en fait pas partie…"
            workspaceId={project.workspace_id}
            projectId={project.project_id}
          />
        </div>
      </div>

      {panel && (
        <ProjectPanel
          project={project}
          onOpenIssue={onOpenIssue}
          onClose={() => setPanel(false)}
        />
      )}

      {!panel && (
        <button
          type="button"
          title="Ouvrir le panneau"
          onClick={() => setPanel(true)}
          className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-md bg-black/30 text-white backdrop-blur-sm hover:bg-black/50"
        >
          <SidebarSimpleIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/**
 * La couverture.
 *
 * Elle est DESSINÉE (le catalogue des artefacts) et non chargée : une image
 * distante fait sauter la page au moment où elle arrive, et un projet ouvert
 * hors ligne se retrouverait avec un bandeau vide. Sans choix explicite, la
 * couverture dérive de l'identifiant — dans une liste de projets, quinze
 * bandeaux identiques ne servent à rien.
 */
function ProjectCover({ project, onChanged }: { project: PjProject; onChanged: () => void }) {
  const cover = resolveCover(project.cover_image ?? undefined, project.id);

  return (
    <div className="group relative h-[200px] w-full overflow-hidden">
      <div className={cn("absolute inset-0", cover.className)} style={cover.style}>
        {cover.art}
      </div>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="absolute right-3 top-3 flex h-7 items-center gap-1.5 rounded-md bg-black/40 px-2.5 text-12 font-medium text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/60 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <ImageIcon className="h-3.5 w-3.5" />
            Changer la couverture
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-2" align="end">
          <div className="grid grid-cols-3 gap-1.5">
            {COVERS.map((c) => (
              <button
                key={c.key}
                type="button"
                title={c.label}
                onClick={async () => {
                  await updateProject(project.id, { cover_image: c.key });
                  onChanged();
                }}
                className={cn(
                  "relative h-12 overflow-hidden rounded-md border transition-colors",
                  c.key === project.cover_image ? "border-primary" : "border-border hover:border-foreground/30",
                )}
              >
                <span className={cn("absolute inset-0", c.className)} style={c.style}>{c.art}</span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

const PANEL_TABS = [
  { key: "info", label: "Informations", icon: InfoIcon },
  { key: "updates", label: "Mises à jour", icon: LightningIcon },
  { key: "pulse", label: "Avancement", icon: PulseIcon },
] as const;

type PanelTab = (typeof PANEL_TABS)[number]["key"];

/**
 * Le panneau de droite.
 *
 * Ses trois onglets ne sont pas trois vues du même contenu : ce sont trois
 * questions différentes — « qui et quand » (informations), « qu'est-ce qui a
 * été dit » (mises à jour), « où en est-on » (avancement). Les empiler dans une
 * seule colonne obligerait à faire défiler pour atteindre celle qu'on cherche,
 * alors qu'on n'en veut qu'une à la fois.
 */
function ProjectPanel({
  project, onOpenIssue, onClose,
}: {
  project: PjProject;
  onOpenIssue?: (issueId: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<PanelTab>("info");

  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-center gap-1 border-b border-border p-2">
        <nav className="flex flex-1 items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
          {PANEL_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              title={t.label}
              onClick={() => setTab(t.key)}
              className={cn(
                "flex h-6 flex-1 items-center justify-center rounded-md transition-all",
                t.key === tab
                  ? "border border-border bg-card text-foreground shadow-raised-100"
                  : "border border-transparent text-tertiary hover:text-foreground",
              )}
            >
              <t.icon className="h-4 w-4" />
            </button>
          ))}
        </nav>
        <button
          type="button"
          title="Fermer le panneau"
          onClick={onClose}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "info" && <InfoTab project={project} />}
        {tab === "updates" && <UpdatesTab project={project} />}
        {tab === "pulse" && <PulseTab project={project} onOpenIssue={onOpenIssue} />}
      </div>
    </aside>
  );
}

const HEALTH_LABEL: Record<string, { label: string; className: string }> = {
  on_track: { label: "Sur les rails", className: "bg-emerald-500/15 text-emerald-600" },
  at_risk: { label: "À risque", className: "bg-amber-500/15 text-amber-600" },
  off_track: { label: "Dérive", className: "bg-red-500/15 text-red-600" },
};

function InfoTab({ project }: { project: PjProject }) {
  const { data: members } = useQuery({
    queryKey: ["pj_members", project.workspace_id],
    queryFn: () => fetchMembers(project.workspace_id),
  });

  const lead = (members ?? []).find((m) => m.user_id === project.lead_id) ?? null;
  const health = project.health ? HEALTH_LABEL[project.health] : null;

  return (
    <dl className="space-y-3">
      <Row label="Préfixe">
        <span className="font-mono text-12 uppercase">{project.identifier}</span>
      </Row>
      <Row label="Santé">
        {health
          ? (
            <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-11 font-medium", health.className)}>
              {health.label}
            </span>
          )
          // « Personne ne s'est prononcé » n'est PAS « sur les rails » : afficher
          // le vert par défaut ferait passer un projet non suivi pour un projet
          // sain, ce qui est exactement l'inverse de ce qu'il faut savoir.
          : <span className="text-12 text-placeholder">Non renseignée</span>}
      </Row>
      <Row label="Responsable">
        {lead
          ? (
            <span className="flex items-center gap-1.5 text-12">
              <MemberAvatar member={lead} /> {memberName(lead)}
            </span>
          )
          : <span className="text-12 text-placeholder">Sans responsable</span>}
      </Row>
      <Row label="Début">
        <span className="text-12">{project.start_date ? formatDate(project.start_date) : "—"}</span>
      </Row>
      <Row label="Échéance">
        <span className="text-12">{project.target_date ? formatDate(project.target_date) : "—"}</span>
      </Row>
      <Row label="Visibilité">
        <span className="text-12">{project.network === 2 ? "Tout le service" : "Sur invitation"}</span>
      </Row>
      <Row label="Membres">
        <span className="text-12">{members?.length ?? 0}</span>
      </Row>
    </dl>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 pt-0.5 text-12 text-tertiary">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function UpdatesTab({ project }: { project: PjProject }) {
  const { data: updates } = useQuery({
    queryKey: ["pj_status_updates", project.id],
    queryFn: () => fetchStatusUpdates({ projectId: project.id }),
  });

  if (!updates?.length) {
    return (
      <EmptyState
        compact
        icon={<LightningIcon className="h-4 w-4" />}
        title="Aucune mise à jour"
        hint="Une mise à jour dit où en est le projet, en une phrase, à une date."
      />
    );
  }

  return (
    <ul className="space-y-3">
      {updates.map((u) => {
        const health = HEALTH_LABEL[u.health];
        return (
          <li key={u.id} className="rounded-lg border border-border p-2.5">
            <div className="flex items-center gap-2 pb-1">
              {health && (
                <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-11 font-medium", health.className)}>
                  {health.label}
                </span>
              )}
              <span className="ml-auto shrink-0 text-11 text-placeholder">
                {formatRelative(u.created_at)}
              </span>
            </div>
            {u.title && <p className="text-13 font-medium">{u.title}</p>}
            {u.body && <p className="whitespace-pre-line pt-0.5 text-12 text-secondary">{u.body}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * L'avancement : ce que la page montrait au centre avant de devenir un
 * document. Rien n'est perdu, tout est simplement passé du côté des réponses
 * qu'on va chercher plutôt que de celles qu'on reçoit en arrivant.
 */
function PulseTab({ project, onOpenIssue }: {
  project: PjProject;
  onOpenIssue?: (issueId: string) => void;
}) {
  const { data: issues } = useQuery({
    queryKey: ["pj_issues", { pjProjectId: project.id }],
    queryFn: () => fetchIssues({ pjProjectId: project.id }),
  });
  const { data: states } = useQuery({ queryKey: ["pj_states", project.id], queryFn: () => fetchStates(project.id) });
  const { data: cycles } = useQuery({ queryKey: ["pj_cycles", project.id], queryFn: () => fetchCycles(project.id) });
  const { data: modules } = useQuery({ queryKey: ["pj_modules", project.id], queryFn: () => fetchModules(project.id) });
  const { data: members } = useQuery({
    queryKey: ["pj_members", project.workspace_id],
    queryFn: () => fetchMembers(project.workspace_id),
  });

  const all = issues ?? [];
  const stats = useProgress(all, states ?? []);
  const palette = useCategorical();

  const current = (cycles ?? []).find((c) => cyclePhase(c) === "current") ?? null;
  const today = new Date().toISOString().slice(0, 10);

  const overdue = useMemo(
    () => all.filter((i) => i.target_date && !i.completed_at && i.target_date.slice(0, 10) < today),
    [all, today],
  );

  const byAssignee = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of all) {
      if (i.completed_at) continue;
      if (!i.assignee_ids.length) counts.set("__none__", (counts.get("__none__") ?? 0) + 1);
      else for (const a of i.assignee_ids) counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [all]);

  return (
    <div className="space-y-5">
      <section>
        <ProgressBar stats={stats} />
        <div className="grid grid-cols-2 gap-2 pt-3">
          <Stat label="Work items" value={stats.total} />
          <Stat label="En cours" value={stats.started} />
          <Stat label="Terminés" value={stats.completed} />
          <Stat label="En retard" value={overdue.length} tone={overdue.length ? "warn" : undefined} />
        </div>
      </section>

      <section>
        <h3 className="pb-1.5 text-12 font-semibold text-tertiary">Cycle en cours</h3>
        {!current ? (
          <p className="text-12 text-placeholder">Aucun cycle en cours.</p>
        ) : (
          <>
            <p className="text-13">{current.name}</p>
            <p className="pb-1 text-11 text-placeholder">
              {formatDate(current.start_date)} → {formatDate(current.end_date)}
            </p>
            <CycleProgress projectId={project.id} cycleId={current.id} />
          </>
        )}
      </section>

      <section>
        <h3 className="pb-1.5 text-12 font-semibold text-tertiary">Charge par personne</h3>
        {!byAssignee.length ? (
          <p className="text-12 text-placeholder">Rien d&apos;ouvert.</p>
        ) : (
          <ul className="space-y-1.5">
            {byAssignee.map(([id, count], index) => {
              const member = (members ?? []).find((m) => m.user_id === id);
              const max = byAssignee[0][1];
              return (
                <li key={id} className="flex items-center gap-2 text-12">
                  {id === "__none__"
                    ? <span className="h-5 w-5 shrink-0 rounded-full bg-muted" />
                    : <MemberAvatar member={member} />}
                  <span className="min-w-0 flex-1 truncate">
                    {id === "__none__" ? "Non assigné" : memberName(member)}
                  </span>
                  <span className="h-1.5 w-12 shrink-0 rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full"
                      style={{ width: `${(count / max) * 100}%`, background: palette[index % palette.length] }}
                    />
                  </span>
                  <span className="w-5 shrink-0 text-right tabular-nums text-tertiary">{count}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {overdue.length > 0 && (
        <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2.5">
          <h3 className="pb-1.5 text-12 font-semibold text-amber-700 dark:text-amber-500">
            En retard ({overdue.length})
          </h3>
          <ul className="space-y-1">
            {overdue.slice(0, 6).map((i) => {
              const s = (states ?? []).find((x) => x.id === i.state_id);
              return (
                <li key={i.id}>
                  <button
                    type="button"
                    onClick={() => onOpenIssue?.(i.id)}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-12 hover:bg-muted/50"
                  >
                    {s && <StateIcon group={s.group} color={s.color} className="h-3.5 w-3.5" />}
                    <IssueKey identifier={project.identifier} sequenceId={i.sequence_id} />
                    <span className="min-w-0 flex-1 truncate">{i.name}</span>
                    <PriorityIcon priority={i.priority} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {(modules ?? []).length > 0 && (
        <section>
          <h3 className="pb-1.5 text-12 font-semibold text-tertiary">Modules</h3>
          <div className="space-y-2">
            {(modules ?? []).slice(0, 6).map((m) => {
              const scoped = all.filter((i) => i.module_ids.includes(m.id));
              const done = scoped.filter((i) => i.completed_at).length;
              const pct = scoped.length ? Math.round((done / scoped.length) * 100) : 0;
              return (
                <div key={m.id}>
                  <p className="truncate text-12">{m.name}</p>
                  <p className="pb-1 text-11 text-placeholder">
                    {done}/{scoped.length} terminés · {pct}%
                  </p>
                  <span className="block h-1.5 rounded-full bg-muted">
                    <span className="block h-full rounded-full bg-emerald-600" style={{ width: `${pct}%` }} />
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function CycleProgress({ projectId, cycleId }: { projectId: string; cycleId: string }) {
  const { data: issues } = useQuery({
    queryKey: ["pj_issues", { pjProjectId: projectId, cycleId }],
    queryFn: () => fetchIssues({ pjProjectId: projectId, cycleId }),
  });
  const { data: states } = useQuery({ queryKey: ["pj_states", projectId], queryFn: () => fetchStates(projectId) });
  const stats = useProgress(issues ?? [], states ?? []);
  return <ProgressBar stats={stats} />;
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warn" }) {
  return (
    <div>
      <p className="text-11 text-tertiary">{label}</p>
      <p className={cn("text-18 font-semibold tabular-nums", tone === "warn" && "text-amber-600")}>
        {value}
      </p>
    </div>
  );
}
