import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircleIcon, ClipboardTextIcon, ClockIcon, FileTextIcon, PlayIcon, RobotIcon,
  WarningCircleIcon, XCircleIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./AgentPicker";
import { formatRelative } from "./pickers";
import { Modal, Select, Switch, TextAreaField, TextField } from "./ui";
import {
  assignMission, decideApproval, fetchIssueApprovals, fetchIssueDeliverables, fetchIssueMissions,
  fetchProjectAgents, fetchTrackerAgents, type IssueApproval, type TrackerAgent,
  type PjIssue, type PjProject,
} from "./model";

/**
 * Confier un work item à un agent, et suivre ce qu'il en fait.
 *
 * C'est le geste qui sépare « un agent est assigné » de « un agent travaille ».
 * L'assignation, seule, est une étiquette : elle dit à qui revient le sujet,
 * elle ne déclenche rien. La MISSION est exécutable — elle porte un brief, des
 * critères d'acceptation, et elle crée un run.
 *
 * Les critères d'acceptation ne sont pas une politesse de formulaire. Ils sont
 * ce à quoi le livrable sera comparé dans l'onglet Livrables ; sans eux, on se
 * retrouve avec un résultat qu'on ne peut que croire sur parole. D'où le fait
 * qu'on les pré-remplisse à partir de la description plutôt que de laisser le
 * champ vide : un champ vide dans une modale se saute, un champ pré-rempli se
 * corrige.
 */

export function IssueMissions({
  issue, project, dashboardId, onPatch,
}: {
  issue: PjIssue; project: PjProject; dashboardId?: string | null;
  /** Écrit le brief et l'armement sur l'item. */
  onPatch: (p: Partial<PjIssue>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState<{ name: string; kind: string; content: string | null; file_url: string | null } | null>(null);
  const qc = useQueryClient();

  const { data: missions } = useQuery({
    queryKey: ["pj_issue_missions", issue.id],
    queryFn: () => fetchIssueMissions(issue.id),
    // Relue toutes les 5 s TANT QU'UN AGENT TRAVAILLE, et plus du tout ensuite.
    // Sans ça, on lance un agent, on lit « En file », et la ligne reste figée
    // jusqu'au prochain rechargement : on croit l'agent en panne alors qu'il a
    // fini depuis dix minutes.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((m) => m.run_status === "queued" || m.run_status === "running")
        ? 5000 : false,
  });

  const missionIds = (missions ?? []).map((m) => m.id);
  const working = (missions ?? []).some((m) => m.run_status === "queued" || m.run_status === "running");

  const { data: approvals } = useQuery({
    queryKey: ["pj_issue_approvals", issue.id, missionIds.join(",")],
    enabled: missionIds.length > 0,
    queryFn: () => fetchIssueApprovals(missionIds),
    // Une demande naît PENDANT le run : on la guette tant qu'un agent travaille.
    refetchInterval: working ? 5000 : false,
  });
  const { data: deliverables } = useQuery({
    queryKey: ["pj_issue_deliverables", issue.id, missionIds.join(",")],
    enabled: missionIds.length > 0,
    queryFn: () => fetchIssueDeliverables(missionIds),
  });

  const { data: agents } = useQuery({
    queryKey: ["pj_tracker_agents", dashboardId, project.workspace_id],
    queryFn: () => fetchTrackerAgents(dashboardId ?? null, project.workspace_id),
  });

  const rows = missions ?? [];

  // Le disjoncteur de la file autonome (0244) : trois échecs d'affilée et
  // l'ordonnanceur cesse de relancer l'item. On le lit ici sur les mêmes
  // données — chaque démarrage automatique crée une mission, triées de la plus
  // récente à la plus ancienne. Seuls les runs TERMINÉS comptent, comme en base :
  // une mission en cours ou annulée n'est ni un succès ni un échec.
  const finished = rows.filter((m) => m.run_status === "succeeded" || m.run_status === "failed");
  const stalled = finished.length >= 3 && finished.slice(0, 3).every((m) => m.run_status === "failed");

  return (
    <div className="space-y-5">
      {/* EN TÊTE de la fiche agent, avant le brief : c'est la seule chose ici
          qui attend quelqu'un. Un agent bloqué sur une autorisation ne fait
          plus rien tant qu'on n'a pas tranché, et chaque minute d'attente se
          rapproche du délai au bout duquel son run est déclaré mort. */}
      {(approvals ?? []).length > 0 && (
        <PendingApprovals
          approvals={approvals ?? []}
          agents={agents ?? []}
          onDecided={() => {
            qc.invalidateQueries({ queryKey: ["pj_issue_approvals", issue.id] });
            qc.invalidateQueries({ queryKey: ["pj_issue_missions", issue.id] });
          }}
        />
      )}

      <AgentBrief issue={issue} onPatch={onPatch} stalled={stalled} />

    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <RobotIcon className="h-4 w-4 text-muted-foreground" />
        <span className="text-12 font-medium">Missions</span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-11" onClick={() => setOpen(true)}>
          <PlayIcon className="h-3 w-3" /> Confier à un agent
        </Button>
      </div>

      {rows.length ? (
        <ul className="overflow-hidden rounded-md border border-border">
          {rows.map((m) => {
            const agent = (agents ?? []).find((a) => a.id === m.agent_id);
            const produced = (deliverables ?? []).filter((d) => d.mission_id === m.id);
            return (
              <li key={m.id} className="border-b border-border/60 last:border-b-0">
                <div className="flex items-center gap-2.5 px-2.5 py-2">
                  <AgentAvatar agent={agent} size={22} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-12">{m.title}</span>
                    <span className="block truncate text-10 text-tertiary">
                      {agent?.name ?? "Agent retiré"} · {formatRelative(m.created_at)}
                    </span>
                  </span>
                  <RunState status={m.run_status} />
                </div>
                {produced.length > 0 && (
                  <ul className="space-y-0.5 px-2.5 pb-2 pl-10">
                    {produced.map((d) => (
                      <li key={d.id}>
                        <button
                          type="button"
                          onClick={() => setReading(d)}
                          className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-11 hover:bg-muted"
                        >
                          <FileTextIcon className="h-3.5 w-3.5 shrink-0 text-tertiary" />
                          <span className="min-w-0 flex-1 truncate">{d.name}</span>
                          <span className="shrink-0 rounded bg-muted px-1 text-10 text-tertiary">{d.kind}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-11 leading-snug text-tertiary">
          Aucune mission. Confier ce work item à un agent lui donne un brief
          exécutable&nbsp;; ce qu&apos;il produira reviendra s&apos;accrocher ici.
        </p>
      )}

      {reading && (
        <Modal
          open
          onClose={() => setReading(null)}
          title={reading.name}
          description={`Livrable · ${reading.kind}`}
          size="lg"
        >
          {reading.file_url ? (
            <a
              href={reading.file_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-12 hover:bg-muted"
            >
              Ouvrir le fichier
            </a>
          ) : (
            // Le contenu brut, en chasse fixe : c'est ce qu'on vient CONTRÔLER,
            // et un rendu « joli » masquerait ce qui a réellement été produit.
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-11 leading-relaxed">
              {reading.content || "Ce livrable n'a pas de contenu."}
            </pre>
          )}
        </Modal>
      )}

      {open && (
        <MissionDialog
          issue={issue}
          project={project}
          dashboardId={dashboardId}
          onClose={() => setOpen(false)}
          onLaunched={() => {
            setOpen(false);
            qc.invalidateQueries({ queryKey: ["pj_issue_missions", issue.id] });
            qc.invalidateQueries({ queryKey: ["pj_project_deliverables", project.id] });
          }}
        />
      )}
    </section>
    </div>
  );
}

/**
 * Le travail à faire, et le droit de s'y mettre seul.
 *
 * Deux réglages qui vont ensemble et n'ont de sens qu'ensemble : armer un item
 * sans brief lance un agent avec un titre pour toute consigne — c'est d'ailleurs
 * pour cela que la file de l'ordonnanceur (0242) écarte les items sans brief
 * plutôt que de les lancer à vide.
 *
 * Le champ est SÉPARÉ de la description parce que les deux textes n'ont pas le
 * même destinataire. La description raconte à l'équipe d'où vient le sujet ; le
 * travail à faire dit à la machine ce qu'elle doit produire. Les fondre en un
 * seul champ obligerait à écrire l'un dans la langue de l'autre.
 */
function AgentBrief({
  issue, onPatch, stalled,
}: {
  issue: PjIssue;
  onPatch: (p: Partial<PjIssue>) => void;
  /** Trois échecs d'affilée : l'ordonnanceur a cessé de relancer l'item. */
  stalled: boolean;
}) {
  const [brief, setBrief] = useState(issue.agent_brief ?? "");

  useEffect(() => { setBrief(issue.agent_brief ?? ""); }, [issue.id, issue.agent_brief]);

  const armed = !!issue.agent_autorun;
  const ready = !!brief.trim();

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <ClipboardTextIcon className="h-4 w-4 text-muted-foreground" />
        <span className="text-12 font-medium">Travail à faire</span>
        <span className="text-11 text-tertiary">pour l&apos;agent</span>
      </div>

      <TextAreaField
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        onBlur={() => {
          if (brief !== (issue.agent_brief ?? "")) onPatch({ agent_brief: brief });
        }}
        placeholder="Ce que l'agent doit produire, et à quoi on reconnaîtra que c'est fait."
        autoResize
        className="min-h-[80px] text-13"
      />

      {/* L'interrupteur SOUS le champ : on arme après avoir écrit, jamais
          l'inverse. Le placer au-dessus inviterait à le basculer d'abord, sur
          un item qui n'a encore rien à faire faire. */}
      <div className={cn(
        "flex items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors",
        armed ? "border-primary/30 bg-primary/8" : "border-border",
      )}>
        <Switch
          checked={armed}
          disabled={!ready && !armed}
          onChange={(v) => onPatch({ agent_autorun: v })}
          label="Laisser l'agent démarrer seul"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-12 font-medium">Travail autonome</span>
          <span className="block text-11 leading-snug text-tertiary">
            {!ready && !armed
              ? "Écrivez d'abord le travail à faire : sans lui, l'agent n'aurait que le titre."
              : armed
                ? "L'agent assigné s'en saisira au prochain passage de l'ordonnanceur, et passera l'item en cours."
                // Une date de début suffit à planifier le départ (0250) : le dire
                // ici, sans quoi on armerait par précaution un item qui l'était
                // déjà par sa date.
                : issue.start_date
                  ? `L'agent assigné démarrera seul le ${new Date(issue.start_date).toLocaleDateString("fr-FR")}, date de début de l'item.`
                  : "L'agent démarrera à la date de début de l'item, s'il en a une — ou quand on le lance depuis « Confier à un agent »."}
          </span>
        </span>
      </div>

      {/* Le cas où l'item a l'air armé et ne fait plus rien. Sans ce message,
          on regarde un interrupteur allumé et on attend — or l'ordonnanceur a
          arrêté exprès, pour ne pas dépenser sans fin sur une tâche que l'agent
          ne sait pas mener. Le remède est presque toujours le brief. */}
      {armed && stalled && (
        <p className="flex items-start gap-1.5 rounded-md border border-red-500/25 bg-red-500/8 px-3 py-2 text-11 leading-snug text-red-700 dark:text-red-400">
          <WarningCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            <strong className="font-medium">En pause après trois échecs d&apos;affilée.</strong>{" "}
            L&apos;agent ne relancera plus seul. Précisez le travail à faire, puis relancez-le
            depuis « Confier à un agent » : un succès réarme le démarrage automatique.
          </span>
        </p>
      )}

      {armed && (
        <p className="flex items-start gap-1.5 text-11 leading-snug text-tertiary">
          <WarningCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          Il faut aussi qu&apos;un agent soit <strong className="font-medium text-foreground">assigné</strong> à
          cet item et <strong className="font-medium text-foreground">autorisé en écriture</strong> sur le projet
          (onglet Équipage). Sans les deux, rien ne démarre. Un item dont la date de début
          n&apos;est pas encore arrivée attend cette date.
        </p>
      )}
    </section>
  );
}


/**
 * Ce qu'une action d'outil veut dire, en français.
 *
 * « tracker_write · update_work_item » est exact et illisible. La personne qui
 * tranche doit comprendre ce qu'elle autorise en une ligne ; sinon elle apprend
 * à cliquer « Autoriser » sans lire, ce qui est exactement le réflexe qu'une
 * validation humaine est censée empêcher.
 */
export const TRACKER_ACTION_LABEL: Record<string, string> = {
  create_work_item: "créer un work item",
  update_work_item: "modifier un work item",
  comment: "commenter",
  assign_self: "s'assigner un work item",
  unassign_self: "se retirer d'un work item",
  break_down: "découper un work item en sous-tâches",
  plan_work_item: "planifier un work item (cycle, modules, dates)",
  create_cycle: "créer un cycle",
  create_module: "créer un module",
};

function describeApproval(a: IssueApproval): { what: string; detail: string | null } {
  const action = typeof a.payload?.action === "string" ? a.payload.action : null;
  if (a.action_kind === "tracker_write" && action) {
    const params = (a.payload?.params ?? {}) as Record<string, unknown>;
    // Le détail le plus parlant de chaque action : le nom de ce qu'on crée, le
    // corps de ce qu'on écrit, les champs de ce qu'on modifie.
    const detail = typeof params.name === "string" ? `« ${params.name} »`
      : typeof params.body === "string" ? `« ${String(params.body).slice(0, 160)} »`
      : Array.isArray(params.titles) ? `${params.titles.length} sous-tâche(s)`
      : Object.keys(params).filter((k) => k !== "issue_id" && k !== "project_id").join(", ") || null;
    return { what: TRACKER_ACTION_LABEL[action] ?? action, detail };
  }
  return { what: a.tool_name, detail: null };
}

function PendingApprovals({
  approvals, agents, onDecided,
}: {
  approvals: IssueApproval[];
  agents: TrackerAgent[];
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (id: string, decision: "approve" | "reject") => {
    setBusy(id);
    setError(null);
    try {
      await decideApproval(id, decision);
      onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-2 rounded-lg border border-amber-500/35 bg-amber-500/8 p-3">
      <div className="flex items-center gap-2">
        <WarningCircleIcon className="h-4 w-4 text-amber-600" />
        <span className="text-12 font-medium">
          {approvals.length === 1
            ? "Un agent attend votre autorisation"
            : `${approvals.length} actions attendent votre autorisation`}
        </span>
      </div>

      <ul className="space-y-2">
        {approvals.map((a) => {
          const agent = agents.find((x) => x.id === a.agent_id);
          const { what, detail } = describeApproval(a);
          return (
            <li key={a.id} className="rounded-md border border-border bg-card p-2.5">
              <div className="flex items-start gap-2">
                <AgentAvatar agent={agent} size={20} />
                <div className="min-w-0 flex-1">
                  <p className="text-12">
                    <span className="font-medium">{agent?.name ?? "Un agent"}</span>
                    {" veut "}{what}
                    {detail && <span className="text-tertiary"> — {detail}</span>}
                  </p>
                  {a.reason && (
                    <p className="mt-0.5 text-11 leading-snug text-tertiary">Pourquoi : {a.reason}</p>
                  )}
                  <p className="mt-0.5 text-10 text-placeholder">demandé {formatRelative(a.requested_at)}</p>
                </div>
              </div>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button
                  size="sm" variant="ghost" className="h-7 text-11"
                  disabled={busy !== null}
                  onClick={() => void decide(a.id, "reject")}
                >
                  Refuser
                </Button>
                <Button
                  size="sm" className="h-7 text-11"
                  disabled={busy !== null}
                  onClick={() => void decide(a.id, "approve")}
                >
                  {busy === a.id ? "…" : "Autoriser"}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {error && <p className="text-11 text-red-600">{error}</p>}
    </section>
  );
}

/** L'état de la dernière tentative, en un mot et une couleur. */
function RunState({ status }: { status: string | null }) {
  const meta = status === "succeeded"
    ? { label: "Abouti", Icon: CheckCircleIcon, className: "bg-emerald-500/15 text-emerald-600" }
    : status === "failed"
      ? { label: "Échoué", Icon: XCircleIcon, className: "bg-red-500/15 text-red-600" }
      : status === "running"
        ? { label: "En cours", Icon: ClockIcon, className: "bg-amber-500/15 text-amber-600" }
        : status === "queued"
          ? { label: "En file", Icon: ClockIcon, className: "bg-muted text-tertiary" }
          : { label: "Sans run", Icon: WarningCircleIcon, className: "bg-muted text-tertiary" };

  return (
    <span className={cn(
      "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-10 font-medium",
      meta.className,
    )}>
      <meta.Icon className="h-3 w-3" /> {meta.label}
    </span>
  );
}

function MissionDialog({
  issue, project, dashboardId, onClose, onLaunched,
}: {
  issue: PjIssue; project: PjProject; dashboardId?: string | null;
  onClose: () => void; onLaunched: () => void;
}) {
  const { user } = useAuth();
  const [agentId, setAgentId] = useState<string | null>(null);
  const [title, setTitle] = useState(issue.name);
  const [brief, setBrief] = useState(issue.description_text ?? "");
  const [criteria, setCriteria] = useState("");

  const { data: roster } = useQuery({
    queryKey: ["pj_tracker_agents", dashboardId, project.workspace_id],
    queryFn: () => fetchTrackerAgents(dashboardId ?? null, project.workspace_id),
  });

  // Le PÉRIMÈTRE du projet, pas seulement le roster : un agent absent de
  // `pj_project_agents` n'a pas le droit d'écrire ici, et le laisser choisir
  // reviendrait à lancer un run qui échouera sur chaque outil.
  const { data: allowed } = useQuery({
    queryKey: ["pj_project_agents", project.id],
    queryFn: () => fetchProjectAgents(project.id),
  });

  const allowedIds = new Set(
    (allowed ?? []).filter((a) => a.role !== "observer").map((a) => a.agent_id),
  );
  const candidates = (roster ?? []).filter((a) => allowedIds.has(a.id));

  // Un seul agent autorisé : il est choisi d'office. Faire choisir dans une
  // liste à une entrée est un clic qui n'apprend rien.
  useEffect(() => {
    if (!agentId && candidates.length === 1) setAgentId(candidates[0].id);
  }, [agentId, candidates]);

  const launch = useMutation({
    mutationFn: () => assignMission({
      agentId: agentId!,
      issue,
      project,
      title: title.trim() || issue.name,
      brief: brief.trim(),
      acceptanceCriteria: criteria.trim(),
      createdBy: user?.id ?? null,
    }),
    onSuccess: onLaunched,
  });

  const ready = !!agentId && !!title.trim() && !!brief.trim();

  return (
    <Modal
      open
      onClose={onClose}
      title="Confier à un agent"
      description="L'agent démarre aussitôt et rend son travail sur ce work item."
      busy={launch.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={launch.isPending}>Annuler</Button>
          <Button onClick={() => launch.mutate()} disabled={!ready || launch.isPending}>
            {launch.isPending ? "Lancement…" : "Lancer"}
          </Button>
        </>
      }
    >
      {candidates.length ? (
        <>
          <Field label="Agent">
            <Select
              value={agentId}
              onChange={setAgentId}
              placeholder="Choisir un agent…"
              options={candidates.map((a) => ({ key: a.id, label: a.name }))}
            />
          </Field>

          <Field label="Mission">
            <TextField
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ce qu'il y a à faire, en une ligne"
            />
          </Field>

          <Field label="Brief">
            <TextAreaField
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Le contexte, les contraintes, ce qui a déjà été tenté…"
              autoResize
              className="min-h-[100px]"
            />
          </Field>

          <Field
            label="Critères d'acceptation"
            hint="Ce à quoi on reconnaîtra que c'est fait. C'est ce qui rendra le livrable vérifiable."
          >
            <TextAreaField
              value={criteria}
              onChange={(e) => setCriteria(e.target.value)}
              placeholder="Une ligne par critère"
              autoResize
              className="min-h-[70px]"
            />
          </Field>

          {launch.error && (
            <p className="text-11 text-red-600">{(launch.error as Error).message}</p>
          )}
        </>
      ) : (
        // Pas un message d'erreur mais une CAUSE et un remède : la liste vide
        // vient presque toujours d'un périmètre non accordé, pas d'un espace
        // sans agents.
        <p className="rounded-md bg-muted/40 px-3 py-3 text-12 leading-relaxed text-tertiary">
          Aucun agent n&apos;est autorisé à agir sur ce projet. Ouvrez l&apos;onglet
          <strong className="font-medium text-foreground"> Équipage</strong> pour en
          autoriser un — un agent seulement observateur ne peut pas recevoir de mission.
        </p>
      )}
    </Modal>
  );
}

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-11 font-medium text-tertiary">{label}</span>
      {children}
      {hint && <span className="block text-10 leading-snug text-placeholder">{hint}</span>}
    </label>
  );
}
