import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CaretDownIcon, CaretUpIcon, CheckCircleIcon, ClockIcon, EnvelopeSimpleIcon,
  LightningIcon, ListChecksIcon, PlusIcon, TrayIcon, XCircleIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Modal, Tabs, TextAreaField, TextField } from "./ui";
import { useAuth } from "@/lib/auth-context";
import { EmptyState } from "./ui";
import {
  AssigneePicker, AssigneeStack, DatePicker, IssueKey, PriorityPicker, StateIcon,
  StatePicker, formatDate,
} from "./pickers";
import {
  INTAKE_SOURCES, createIntakeItem, fetchIntake, fetchIssues, fetchLabels, fetchMembers,
  fetchStates, setAssignees, setIntakeStatus, updateIssue,
  type PjIntakeItem, type PjIssue, type PjProject,
} from "./model";

/**
 * L'intake : la file d'entrée des demandes, en vue scindée.
 *
 * Le principe repris de Plane : ce qui arrive ici n'est PAS encore du travail
 * du projet. Tant qu'une demande n'est pas acceptée, elle ne compte dans aucun
 * board, aucun cycle, aucune statistique — sinon la file d'entrée pollue tous
 * les chiffres avec des choses que personne n'a décidé de faire.
 *
 * D'où la vue scindée plutôt qu'une liste avec panneau flottant : trier une
 * file, c'est lire une demande, décider, passer à la suivante. La liste doit
 * rester sous les yeux pendant qu'on lit, et les flèches ↑↓ doivent enchaîner
 * sans repasser par elle.
 */

const STATUS: { key: PjIntakeItem["status"]; label: string; tone: string }[] = [
  { key: -2, label: "En attente", tone: "bg-amber-500/15 text-amber-600" },
  { key: 1, label: "Accepté", tone: "bg-emerald-500/15 text-emerald-600" },
  { key: -1, label: "Refusé", tone: "bg-red-500/15 text-red-600" },
  { key: 0, label: "En veille", tone: "bg-blue-500/15 text-blue-600" },
  { key: 2, label: "Doublon", tone: "bg-muted text-muted-foreground" },
];

const SOURCE_ICONS: Record<string, typeof EnvelopeSimpleIcon> = {
  "in-app": LightningIcon,
  email: EnvelopeSimpleIcon,
  forms: ListChecksIcon,
};

export function IntakePage({ project }: { project: PjProject }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"open" | "closed">("open");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: intake } = useQuery({
    queryKey: ["pj_intake", project.id],
    queryFn: () => fetchIntake(project.id),
  });
  const { data: issues } = useQuery({
    queryKey: ["pj_issues_all", project.id],
    queryFn: () => fetchIssues({ pjProjectId: project.id, includeDrafts: true }),
  });
  const { data: states } = useQuery({
    queryKey: ["pj_states", project.id],
    queryFn: () => fetchStates(project.id),
  });
  const { data: members } = useQuery({
    queryKey: ["pj_members", project.workspace_id],
    queryFn: () => fetchMembers(project.workspace_id),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pj_intake", project.id] });
    qc.invalidateQueries({ queryKey: ["pj_issues_all", project.id] });
    qc.invalidateQueries({ queryKey: ["pj_issues"] });
  };

  // « Ouvert » = en attente ou en veille. Une demande en veille reste à traiter,
  // elle a seulement été repoussée ; la ranger avec les refus la ferait oublier.
  const rows = useMemo(() => {
    const list = (intake ?? []).filter((i) => (tab === "open" ? i.status === -2 || i.status === 0 : i.status !== -2 && i.status !== 0));
    return list.map((item) => ({
      item,
      issue: (issues ?? []).find((x) => x.id === item.issue_id) ?? null,
    })).filter((r) => r.issue);
  }, [intake, issues, tab]);

  const index = rows.findIndex((r) => r.item.issue_id === selectedId);
  const current = index >= 0 ? rows[index] : rows[0] ?? null;

  const step = (delta: number) => {
    const next = rows[(index < 0 ? 0 : index) + delta];
    if (next) setSelectedId(next.item.issue_id);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
        <TrayIcon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-14 font-medium">Intake</h2>
        <div className="flex-1" />
        <Button size="sm" className="h-8" onClick={() => setCreating(true)}>
          <PlusIcon className="mr-1 h-4 w-4" /> Ajouter une demande
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-[380px] shrink-0 flex-col border-r border-border">
          <div className="flex items-center gap-1 border-b border-border px-3 py-2">
            <Tabs
              value={tab} onChange={setTab}
              options={[
                { key: "open" as const, label: "Ouvertes" },
                { key: "closed" as const, label: "Traitées" },
              ]}
            />
            <span className="ml-1 text-11 text-muted-foreground">{rows.length}</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {!rows.length ? (
              // Compact : cette liste est une colonne étroite à côté du détail,
              // et une illustration pleine taille y déborderait.
              <EmptyState
                compact
                className="m-3 border-dashed"
                icon={<TrayIcon className="h-4 w-4" />}
                title={tab === "open" ? "Rien à trier" : "Aucune demande traitée"}
                hint={tab === "open"
                  ? "Les demandes arrivées de l'extérieur atterrissent ici avant d'entrer dans un board."
                  : "Ce qui a été accepté ou refusé se retrouve ici, avec la décision."}
              />
            ) : (
              rows.map(({ item, issue }) => {
                const SourceIcon = SOURCE_ICONS[item.source] ?? LightningIcon;
                const active = current?.item.issue_id === item.issue_id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.issue_id)}
                    className={cn(
                      "flex w-full flex-col items-start gap-1 border-b border-border/40 px-3 py-2.5 text-left",
                      active ? "bg-muted" : "hover:bg-muted/50",
                    )}
                  >
                    <div className="flex w-full items-center gap-2">
                      <IssueKey identifier={project.identifier} sequenceId={issue!.sequence_id} />
                      <div className="flex-1" />
                      {/* La source est une information de tri : une demande
                          arrivée par formulaire et une remontée par mail ne se
                          traitent pas de la même façon. */}
                      <span className="flex shrink-0 items-center gap-1 rounded-md border border-border/70 px-1.5 py-0.5 text-10 text-muted-foreground">
                        <SourceIcon className="h-3 w-3" />
                        {INTAKE_SOURCES.find((s) => s.key === item.source)?.label ?? item.source}
                      </span>
                    </div>
                    <span className="line-clamp-2 w-full text-13">{issue!.name}</span>
                    <span className="text-11 text-muted-foreground">
                      {formatDate(item.created_at)}
                      {item.status === 0 && item.snoozed_till
                        ? ` · en veille jusqu'au ${formatDate(item.snoozed_till)}`
                        : ""}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {!current ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-14 text-muted-foreground">Sélectionnez une demande.</p>
          </div>
        ) : (
          <IntakeDetail
            key={current.item.id}
            project={project}
            item={current.item}
            issue={current.issue!}
            states={states ?? []}
            members={members ?? []}
            canPrev={index > 0}
            canNext={index >= 0 && index < rows.length - 1}
            onStep={step}
            onChanged={refresh}
          />
        )}
      </div>

      {creating && (
        <NewIntakeDialog project={project} onClose={() => setCreating(false)} onCreated={refresh} />
      )}
    </div>
  );
}

function IntakeDetail({
  project, item, issue, states, members, canPrev, canNext, onStep, onChanged,
}: {
  project: PjProject;
  item: PjIntakeItem;
  issue: PjIssue;
  states: ReturnType<typeof Object> extends never ? never : Awaited<ReturnType<typeof fetchStates>>;
  members: Awaited<ReturnType<typeof fetchMembers>>;
  canPrev: boolean; canNext: boolean;
  onStep: (delta: number) => void;
  onChanged: () => void;
}) {
  const status = STATUS.find((s) => s.key === item.status);

  const accept = async () => {
    // Accepter, c'est faire entrer la demande dans le projet : elle prend
    // l'état par défaut et devient un work item comme les autres.
    const fallback = states.find((s) => s.is_default) ?? states[0];
    if (fallback) await updateIssue(issue.id, { state_id: fallback.id }, null);
    await setIntakeStatus(item.id, 1);
    onChanged();
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
        <IssueKey identifier={project.identifier} sequenceId={issue.sequence_id} />
        <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-11 font-medium leading-none", status?.tone)}>
          {status?.label}
        </span>
        <div className="flex-1" />
        {/* Les flèches enchaînent sans repasser par la liste : trier une file,
            c'est décider puis passer à la suivante, pas revenir en arrière. */}
        <button
          type="button" disabled={!canPrev} onClick={() => onStep(-1)}
          className="rounded border border-border p-1 text-muted-foreground disabled:opacity-40 hover:bg-muted"
        >
          <CaretUpIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button" disabled={!canNext} onClick={() => onStep(1)}
          className="rounded border border-border p-1 text-muted-foreground disabled:opacity-40 hover:bg-muted"
        >
          <CaretDownIcon className="h-3.5 w-3.5" />
        </button>

        {item.status === -2 && (
          <>
            <Button size="sm" className="h-7 gap-1 text-12" onClick={accept}>
              <CheckCircleIcon className="h-3.5 w-3.5" /> Accepter
            </Button>
            <Button
              size="sm" variant="outline" className="h-7 gap-1 text-12"
              onClick={async () => { await setIntakeStatus(item.id, -1); onChanged(); }}
            >
              <XCircleIcon className="h-3.5 w-3.5" /> Refuser
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="rounded border border-border p-1.5 text-muted-foreground hover:bg-muted">
                  <ClockIcon className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {[3, 7, 14, 30].map((d) => (
                  <DropdownMenuItem
                    key={d}
                    onClick={async () => {
                      const till = new Date();
                      till.setDate(till.getDate() + d);
                      await setIntakeStatus(item.id, 0, till.toISOString());
                      onChanged();
                    }}
                  >
                    Repousser de {d} jours
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem onClick={async () => { await setIntakeStatus(item.id, 2); onChanged(); }}>
                  Marquer comme doublon
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
        {item.status !== -2 && (
          <Button
            size="sm" variant="outline" className="h-7 text-12"
            onClick={async () => { await setIntakeStatus(item.id, -2); onChanged(); }}
          >
            Remettre en attente
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-2xl space-y-5">
          <h1 className="text-xl font-medium">{issue.name}</h1>

          {issue.description_html ? (
            <div
              className="prose prose-sm max-w-none dark:prose-invert"
              dangerouslySetInnerHTML={{ __html: issue.description_html }}
            />
          ) : (
            <p className="text-14 text-muted-foreground">Aucune description.</p>
          )}

          <section className="border-t border-border/60 pt-4">
            <h3 className="pb-2 text-14 font-medium">Propriétés</h3>
            <dl className="space-y-2">
              <Prop label="État">
                <StatePicker
                  states={states} value={issue.state_id}
                  onChange={(id) => updateIssue(issue.id, { state_id: id }, null).then(onChanged)}
                />
              </Prop>
              <Prop label="Priorité">
                <PriorityPicker
                  value={issue.priority}
                  onChange={(p) => updateIssue(issue.id, { priority: p }, null).then(onChanged)}
                />
              </Prop>
              <Prop label="Assignés">
                <AssigneePicker
                  members={members} value={issue.assignee_ids}
                  onChange={(ids) =>
                    setAssignees(issue.id, project.id, project.workspace_id, ids).then(onChanged)}
                />
              </Prop>
              <Prop label="Échéance">
                <DatePicker
                  value={issue.target_date}
                  onChange={(d) => updateIssue(issue.id, { target_date: d }, null).then(onChanged)}
                  placeholder="Aucune"
                />
              </Prop>
              <Prop label="Source">
                <span className="text-13 text-muted-foreground">
                  {INTAKE_SOURCES.find((s) => s.key === item.source)?.label ?? item.source}
                </span>
              </Prop>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <dt className="w-28 shrink-0 text-12 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

/**
 * Créer une demande à la main : le cas du support qui reçoit un appel et le
 * consigne. Elle entre dans la file au même titre qu'une demande arrivée par
 * formulaire — c'est bien le point de l'intake, avoir UNE file quelle que soit
 * la porte d'entrée.
 */
function NewIntakeDialog({
  project, onClose, onCreated,
}: { project: PjProject; onClose: () => void; onCreated: () => void }) {
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("in-app");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await createIntakeItem({
        pjProjectId: project.id, workspaceId: project.workspace_id,
        name: name.trim(), description_html: description, source,
        createdBy: user?.id ?? null,
      });
      onCreated();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={"Nouvelle demande"}
      size="lg"
      footer={<>
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button onClick={submit} disabled={!name.trim() || busy}>Créer</Button>
        </>}
    >
        <TextField autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Que demande-t-on ?" />
        <TextAreaField
          value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="Contexte, contact, échéance annoncée…" className="min-h-[120px]"
        />
        <div className="flex flex-wrap gap-1.5">
          {INTAKE_SOURCES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSource(s.key)}
              className={cn(
                "rounded border px-2 py-1 text-12 transition-colors",
                source === s.key ? "border-primary/60 bg-primary/10" : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        </Modal>
  );
}
