import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftIcon, ChatCircleIcon, ClockCounterClockwiseIcon, InfoIcon, LightningIcon,
  LinkSimpleIcon, PlusIcon, StackIcon, SuitcaseSimpleIcon, TrashIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { MemberAvatar, formatDate, memberName } from "./pickers";
import { Modal, TextAreaField, TextField } from "./ui";
import {
  HEALTH, addLink, addStatusUpdate, deleteLink, deleteStatusUpdate, fetchInitiativeProgress,
  fetchInitiativeProjects, fetchLinks, fetchMembers, fetchProjects, fetchStatusUpdates,
  setInitiativeProjects, updateInitiative,
  type Health, type PjInitiative, type PjProject, type PjStatusUpdate,
} from "./model";

/**
 * La fiche d'une initiative.
 *
 * Elle est bâtie autour d'une idée : l'avancement (56 %) ne dit PAS si ça va
 * bien. Un chantier peut être aux trois quarts et complètement à la dérive.
 * D'où la colonne de droite — les points d'étape, où quelqu'un déclare la
 * santé et l'explique en une phrase. Le chiffre et le jugement sont côte à
 * côte, et aucun des deux ne prétend remplacer l'autre.
 */
export function InitiativeDetail({
  initiative, workspaceId, onBack, onChanged, onOpenProject,
}: {
  initiative: PjInitiative;
  workspaceId: string | null;
  onBack: () => void;
  onChanged: () => void;
  onOpenProject: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(initiative.name);
  const [description, setDescription] = useState(initiative.description);
  const [picking, setPicking] = useState(false);
  const [linking, setLinking] = useState(false);

  const { data: progress } = useQuery({
    queryKey: ["pj_initiative_progress", initiative.id],
    queryFn: () => fetchInitiativeProgress(initiative.id),
  });
  const { data: linked } = useQuery({
    queryKey: ["pj_initiative_projects", initiative.id],
    queryFn: () => fetchInitiativeProjects(initiative.id),
  });
  const { data: projects } = useQuery({
    queryKey: ["pj_projects", initiative.dashboard_id],
    enabled: !!initiative.dashboard_id,
    queryFn: () => fetchProjects(initiative.dashboard_id!),
  });
  const { data: links } = useQuery({
    queryKey: ["pj_links_initiative", initiative.id],
    queryFn: () => fetchLinks({ initiativeId: initiative.id }),
  });

  const refreshLinks = () => qc.invalidateQueries({ queryKey: ["pj_links_initiative", initiative.id] });
  const members = projects?.length ? (linked ?? []) : [];
  const scopedProjects = (projects ?? []).filter((p) => members.includes(p.id));
  const percent = progress?.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  const health = HEALTH.find((h) => h.key === initiative.health);

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
          <button type="button" onClick={onBack} className="rounded p-1 hover:bg-muted">
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <SuitcaseSimpleIcon className="h-4 w-4 text-muted-foreground" />
          <span className="font-mono text-11 text-muted-foreground">Initiative</span>
          {health && (
            <span
              className="inline-flex h-5 shrink-0 items-center rounded-full px-2 text-11 font-medium leading-none"
              style={{ background: `${health.color}22`, color: health.color }}
            >
              {health.label}
            </span>
          )}
        </header>

        <div className="mx-auto max-w-3xl space-y-5 px-6 py-6">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { if (name.trim() && name !== initiative.name) updateInitiative(initiative.id, { name: name.trim() }).then(onChanged); }}
            className="w-full bg-transparent text-24 font-medium outline-none"
            placeholder="Nom de l'initiative"
          />

          <TextAreaField
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => { if (description !== initiative.description) updateInitiative(initiative.id, { description }).then(onChanged); }}
            placeholder="À quoi sert cette initiative ?"
            autoResize
            mode="transparent"
            className="min-h-[80px] text-14"
          />

          <div className="flex flex-wrap gap-2">
            <ActionButton icon={<LinkSimpleIcon className="h-4 w-4" />} label="Ajouter un lien" onClick={() => setLinking(true)} />
            <ActionButton icon={<SuitcaseSimpleIcon className="h-4 w-4" />} label="Ajouter un projet" onClick={() => setPicking(true)} />
          </div>

          {(links ?? []).length > 0 && (
            <ul className="space-y-1">
              {(links ?? []).map((l) => (
                <li key={l.id} className="flex items-center gap-2 rounded border border-border/50 px-2 py-1.5 text-13">
                  <LinkSimpleIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <a href={l.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:underline">
                    {l.title || l.url}
                  </a>
                  <button
                    type="button"
                    onClick={async () => { await deleteLink(l.id); refreshLinks(); }}
                    className="text-muted-foreground hover:text-red-600"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Le bloc Progress de la capture : une barre, puis les quatre nombres
              qui expliquent d'où sort le pourcentage. Sans eux, « 56 % » ne dit
              ni sur combien d'items, ni combien traînent sans échéance. */}
          <section className="border-t border-border/60 pt-4">
            <div className="flex items-center gap-2 pb-1">
              <h3 className="text-14 font-medium">Avancement</h3>
              <div className="flex-1" />
              <span className="text-14 font-medium tabular-nums">{percent}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-emerald-600" style={{ width: `${percent}%` }} />
            </div>
            <div className="grid grid-cols-2 gap-3 pt-3 sm:grid-cols-4">
              <Metric label="Work items" value={`${progress?.completed ?? 0}/${progress?.total ?? 0}`} />
              <Metric label="Projets" value={String(progress?.projects ?? 0)} />
              <Metric label="En cours" value={String(progress?.started ?? 0)} />
              <Metric label="En retard" value={String(progress?.overdue ?? 0)} tone={(progress?.overdue ?? 0) > 0 ? "warn" : undefined} />
            </div>
          </section>

          <section className="border-t border-border/60 pt-4">
            <div className="flex items-center gap-2 pb-2">
              <h3 className="text-14 font-medium">Périmètre</h3>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setPicking(true)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <PlusIcon className="h-4 w-4" />
              </button>
            </div>
            {!scopedProjects.length ? (
              <p className="text-12 text-placeholder">
                Rattachez des projets : c&apos;est leur avancement cumulé qui donne
                celui de l&apos;initiative.
              </p>
            ) : (
              <ul className="space-y-1">
                {scopedProjects.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => onOpenProject(p.id)}
                      className="flex w-full items-center gap-2 rounded border border-border/60 px-2.5 py-2 text-left hover:bg-muted/50"
                    >
                      <StackIcon className="h-4 w-4 text-muted-foreground" />
                      <span className="font-mono text-10 text-muted-foreground">{p.identifier}</span>
                      <span className="min-w-0 flex-1 truncate text-13">{p.name}</span>
                      {p.health && (() => {
                        const h = HEALTH.find((x) => x.key === p.health);
                        return h ? (
                          <span className="flex items-center gap-1 text-11" style={{ color: h.color }}>
                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: h.color }} />
                            {h.label}
                          </span>
                        ) : null;
                      })()}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <UpdatesPanel initiative={initiative} workspaceId={workspaceId} onChanged={onChanged} />

      {picking && workspaceId && (
        <ProjectScopeDialog
          initiative={initiative} projects={projects ?? []} selected={linked ?? []}
          workspaceId={workspaceId}
          onClose={() => setPicking(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["pj_initiative_projects", initiative.id] });
            qc.invalidateQueries({ queryKey: ["pj_initiative_progress", initiative.id] });
            onChanged();
          }}
        />
      )}

      {linking && workspaceId && (
        <LinkDialog
          workspaceId={workspaceId} initiativeId={initiative.id}
          onClose={() => setLinking(false)} onSaved={refreshLinks}
        />
      )}
    </div>
  );
}

function ActionButton({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-12 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {icon} {label}
    </button>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div>
      <p className="text-11 text-muted-foreground">{label}</p>
      <p className={cn("text-16 font-semibold tabular-nums", tone === "warn" && "text-amber-600")}>{value}</p>
    </div>
  );
}

/**
 * La colonne de droite : les points d'étape.
 *
 * Chacun fige une santé À SA DATE. C'est ce qui permet de relire la trajectoire
 * d'un chantier — « on était on track en janvier, at risk en février, et voilà
 * pourquoi » — là où un simple champ « santé » n'aurait gardé que la dernière
 * valeur, sans son histoire ni sa raison.
 */
function UpdatesPanel({
  initiative, workspaceId, onChanged,
}: { initiative: PjInitiative; workspaceId: string | null; onChanged: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"updates" | "info">("updates");
  const [composing, setComposing] = useState(false);

  const { data: updates } = useQuery({
    queryKey: ["pj_status_updates", initiative.id],
    queryFn: () => fetchStatusUpdates({ initiativeId: initiative.id }),
  });
  const { data: members } = useQuery({
    queryKey: ["pj_members", initiative.workspace_id],
    queryFn: () => fetchMembers(initiative.workspace_id),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pj_status_updates", initiative.id] });
    onChanged();
  };

  return (
    <aside className="hidden w-[360px] shrink-0 flex-col border-l border-border lg:flex">
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <TabIcon active={tab === "updates"} onClick={() => setTab("updates")} icon={<LightningIcon className="h-4 w-4" />} />
        <TabIcon active={tab === "info"} onClick={() => setTab("info")} icon={<InfoIcon className="h-4 w-4" />} />
        <TabIcon active={false} onClick={() => setTab("updates")} icon={<ChatCircleIcon className="h-4 w-4" />} />
        <TabIcon active={false} onClick={() => setTab("updates")} icon={<ClockCounterClockwiseIcon className="h-4 w-4" />} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "info" ? (
          <dl className="space-y-2 text-12">
            <Row label="Statut" value={initiative.status} />
            <Row label="Début" value={initiative.start_date ? formatDate(initiative.start_date) : "—"} />
            <Row label="Échéance" value={initiative.target_date ? formatDate(initiative.target_date) : "—"} />
            <Row
              label="Santé mise à jour"
              value={initiative.health_updated_at ? formatDate(initiative.health_updated_at) : "—"}
            />
          </dl>
        ) : (
          <>
            <div className="flex items-center gap-2 pb-3">
              <h3 className="text-14 font-medium">Points d&apos;étape</h3>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setComposing(true)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <PlusIcon className="h-4 w-4" />
              </button>
            </div>

            {!updates?.length ? (
              <p className="text-12 text-muted-foreground">
                Aucun point d&apos;étape. C&apos;est ici qu&apos;on dit si le chantier va bien,
                ce que le pourcentage ne dit pas.
              </p>
            ) : (
              <ul className="space-y-2">
                {updates.map((u) => (
                  <UpdateCard
                    key={u.id} update={u}
                    author={(members ?? []).find((m) => m.user_id === u.actor_id)}
                    onDelete={async () => { await deleteStatusUpdate(u.id); refresh(); }}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {composing && workspaceId && (
        <UpdateDialog
          workspaceId={workspaceId}
          initiativeId={initiative.id}
          actorId={user?.id ?? null}
          onClose={() => setComposing(false)}
          onSaved={refresh}
        />
      )}
    </aside>
  );
}

function TabIcon({ active, onClick, icon }: { active: boolean; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded-md py-1.5 text-muted-foreground transition-colors hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
    >
      <span className="flex justify-center">{icon}</span>
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function UpdateCard({
  update, author, onDelete,
}: {
  update: PjStatusUpdate;
  author: { user_id: string; full_name: string | null; email: string | null } | undefined;
  onDelete: () => void;
}) {
  const health = HEALTH.find((h) => h.key === update.health);
  return (
    <li className="group rounded-lg border border-border/70 p-3">
      <div className="flex items-start gap-2">
        {/* La pastille de santé porte une couleur ET un libellé : sur trois
            états dont deux chauds, la couleur seule ne suffit pas. */}
        <span
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
          style={{ background: `${health?.color}22` }}
        >
          <span className="h-2 w-2 rounded-full" style={{ background: health?.color }} />
        </span>
        <div className="min-w-0 flex-1">
          {update.title && <p className="truncate text-13 font-medium">{update.title}</p>}
          <p className="flex flex-wrap items-center gap-1.5 text-11">
            <span style={{ color: health?.color }}>{health?.label}</span>
            <span className="text-muted-foreground">{formatDate(update.created_at)}</span>
            <span className="text-muted-foreground">· {memberName(author)}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="opacity-0 transition-opacity group-hover:opacity-100"
        >
          <TrashIcon className="h-3.5 w-3.5 text-muted-foreground hover:text-red-600" />
        </button>
      </div>
      {update.body && (
        <p className="whitespace-pre-wrap pt-2 text-13 leading-relaxed">{update.body}</p>
      )}
    </li>
  );
}

function UpdateDialog({
  workspaceId, initiativeId, projectId, actorId, onClose, onSaved,
}: {
  workspaceId: string; initiativeId?: string; projectId?: string;
  actorId: string | null; onClose: () => void; onSaved: () => void;
}) {
  const [health, setHealth] = useState<Health>("on_track");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await addStatusUpdate({ workspaceId, initiativeId, projectId, health, title, body, actorId });
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
      title={"Nouveau point d&apos;étape"}
      size="md"
      footer={<>
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button onClick={submit} disabled={busy}>Publier</Button>
        </>}
    >
        <div className="flex gap-1.5">
          {HEALTH.map((h) => (
            <button
              key={h.key}
              type="button"
              onClick={() => setHealth(h.key)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-12 transition-colors",
                health === h.key ? "border-current" : "border-border text-muted-foreground hover:bg-muted",
              )}
              style={health === h.key ? { color: h.color, background: `${h.color}15` } : undefined}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: h.color }} />
              {h.label}
            </button>
          ))}
        </div>
        <TextField value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titre" autoFocus />
        <TextAreaField
          value={body} onChange={(e) => setBody(e.target.value)}
          placeholder="Où en est-on, et pourquoi ?" className="min-h-[110px]"
        />
        </Modal>
  );
}

function LinkDialog({
  workspaceId, initiativeId, issueId, onClose, onSaved,
}: {
  workspaceId: string; initiativeId?: string; issueId?: string;
  onClose: () => void; onSaved: () => void;
}) {
  const { user } = useAuth();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    try {
      new URL(url.trim());
    } catch {
      setError("URL invalide.");
      return;
    }
    await addLink({ workspaceId, initiativeId, issueId, url: url.trim(), title: title.trim(), createdBy: user?.id ?? null });
    onSaved();
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={"Ajouter un lien"}
      size="md"
      footer={<>
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button onClick={submit} disabled={!url.trim()}>Ajouter</Button>
        </>}
    >
        <TextField autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        <TextField value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Titre (facultatif)" />
        {error && <p className="text-12 text-red-600">{error}</p>}
        </Modal>
  );
}

function ProjectScopeDialog({
  initiative, projects, selected, workspaceId, onClose, onSaved,
}: {
  initiative: PjInitiative; projects: PjProject[]; selected: string[];
  workspaceId: string; onClose: () => void; onSaved: () => void;
}) {
  const [ids, setIds] = useState<string[]>(selected);
  const toggle = (id: string) =>
    setIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <Modal
      open
      onClose={onClose}
      title={"Projets de l&apos;initiative"}
      size="md"
      footer={<>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button
            onClick={async () => {
              await setInitiativeProjects(initiative.id, workspaceId, ids);
              onSaved();
              onClose();
            }}
          >
            Enregistrer
          </Button>
        </>}
    >
        <div className="max-h-[340px] space-y-1 overflow-y-auto">
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => toggle(p.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left",
                ids.includes(p.id) ? "bg-primary/10" : "hover:bg-muted",
              )}
            >
              <span className="font-mono text-10 text-muted-foreground">{p.identifier}</span>
              <span className="flex-1 truncate text-14">{p.name}</span>
            </button>
          ))}
          {!projects.length && (
            <p className="px-2 py-3 text-12 text-placeholder">
              Aucun projet dans ce service.
            </p>
          )}
        </div>
    </Modal>
  );
}

export { UpdateDialog };
