import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon, CircleNotchIcon as Loader2, PaperPlaneTiltIcon, PlusIcon, RocketLaunchIcon, ArrowClockwiseIcon,
  TrashIcon, LightbulbIcon, SwordIcon, ChatCircleDotsIcon, ListChecksIcon, UsersThreeIcon, FlagIcon, QuestionIcon,
  NotePencilIcon, ArrowRightIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { AgentIdentity } from "@/components/AgentIdentity";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useTeams } from "@/features/service-dashboards/live/teams";
import { TextAreaField, TextField } from "./ui";
import { BriefInput } from "./SmartTextarea";
import {
  answerMissionQuestion, fetchMissionDiscussion, fetchMissionQuestions, fetchProject, missionAction, updateProject,
  type MissionDeliverable, type MissionDiscussionEntry, type PjProject, type PlanningStatus,
} from "./model";

// Le CADRAGE d'une mission : l'humain dit ce qu'il veut, l'équipe d'agents
// s'en empare (0295). Cette page montre la concertation telle qu'elle a lieu —
// chaque prise de parole est celle d'un vrai agent — et les trois gestes qui
// restent à l'humain : répondre aux questions, donner le feu vert, relancer.

interface LiteAgent { id: string; name: string; avatar_url: string | null; avatar_style: "avatar" | "orb" | null }

const STAGES: Array<{ key: string; label: string }> = [
  { key: "scoping", label: "Cadrage" },
  { key: "questions", label: "Questions" },
  { key: "plan", label: "Plan" },
  { key: "team", label: "Répartition" },
  { key: "run", label: "Exécution" },
];

function stageIndex(status: PlanningStatus, step: string | null): number {
  const s = (step ?? "").replace(/@run$/, "");
  if (status === "scoping") return 0;
  if (status === "questions") return 1;
  if (status === "planning") return s.startsWith("team") || s === "done" ? 3 : 2;
  if (status === "planned" || status === "executing") return 4;
  return -1;
}

const KIND_META: Record<MissionDiscussionEntry["kind"], { label: string; icon: typeof LightbulbIcon; tone: string }> = {
  analysis: { label: "Analyse", icon: LightbulbIcon, tone: "text-amber-500" },
  challenge: { label: "Challenge", icon: SwordIcon, tone: "text-rose-500" },
  proposal: { label: "Proposition", icon: LightbulbIcon, tone: "text-amber-500" },
  question: { label: "Questions", icon: QuestionIcon, tone: "text-sky-500" },
  answer: { label: "Réponses", icon: ChatCircleDotsIcon, tone: "text-emerald-500" },
  plan: { label: "Plan", icon: ListChecksIcon, tone: "text-violet-500" },
  assignment: { label: "Répartition", icon: UsersThreeIcon, tone: "text-teal-500" },
  decision: { label: "Décision", icon: FlagIcon, tone: "text-primary" },
  note: { label: "Note", icon: NotePencilIcon, tone: "text-muted-foreground" },
};

/** Un markdown minimal — paragraphes, listes, gras — pour la parole des agents. */
function Prose({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  const inline = (s: string): ReactNode[] => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i} className="font-semibold text-foreground">{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>);
  return (
    <div className="space-y-2 text-13 leading-relaxed text-foreground/90">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        const items = lines.filter((l) => /^\s*[-·•]\s+/.test(l));
        const head = lines.filter((l) => !/^\s*[-·•]\s+/.test(l));
        return (
          <div key={i}>
            {head.length > 0 && <p className="whitespace-pre-line">{inline(head.join("\n"))}</p>}
            {items.length > 0 && (
              <ul className="mt-1 space-y-0.5 pl-4">
                {items.map((l, k) => (
                  <li key={k} className={cn("list-disc marker:text-muted-foreground", /^\s{2,}/.test(l) && "ml-4 list-[circle]")}>
                    {inline(l.replace(/^\s*[-·•]\s+/, ""))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MissionKickoff({ project: initial, dashboardId, onChanged }: {
  project: PjProject; dashboardId: string; onChanged: () => void;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { teams } = useTeams(dashboardId);

  const { data: fresh } = useQuery({
    queryKey: ["pj_project_live", initial.id],
    queryFn: () => fetchProject(initial.id),
    refetchInterval: (q) => {
      const st = (q.state.data as PjProject | null | undefined)?.planning_status ?? initial.planning_status;
      return st === "scoping" || st === "planning" ? 4000 : st === "executing" ? 20000 : false;
    },
  });
  const project = fresh ?? initial;
  const status = (project.planning_status ?? "none") as PlanningStatus;
  const active = status === "scoping" || status === "planning";

  const { data: thread } = useQuery({
    queryKey: ["pj_mission_discussion", project.id],
    queryFn: () => fetchMissionDiscussion(project.id),
    enabled: status !== "none",
    refetchInterval: active ? 4000 : false,
  });
  const { data: questions } = useQuery({
    queryKey: ["pj_mission_questions", project.id],
    queryFn: () => fetchMissionQuestions(project.id),
    enabled: status !== "none",
    refetchInterval: active ? 6000 : false,
  });
  const { data: agents } = useQuery({
    queryKey: ["kickoff_agents", dashboardId],
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents").select("id, name, avatar_url, avatar_style")
        .eq("service_dashboard_id", dashboardId).eq("is_archived", false);
      return (data ?? []) as LiteAgent[];
    },
  });
  const { data: items } = useQuery({
    queryKey: ["kickoff_items", project.id],
    enabled: status === "planning" || status === "planned" || status === "executing",
    refetchInterval: active ? 6000 : status === "executing" ? 20000 : false,
    queryFn: async () => {
      const { data } = await supabase.from("pj_issues")
        .select("id, sequence_id, name, parent_id, team_id, completed_at, estimate_hours, target_date, pj_issue_agents(agent_id)")
        .eq("pj_project_id", project.id).is("archived_at", null).order("sequence_id");
      return (data ?? []) as Array<{ id: string; sequence_id: number; name: string; parent_id: string | null; team_id: string | null; completed_at: string | null; estimate_hours: number | null; target_date: string | null; pj_issue_agents: Array<{ agent_id: string }> }>;
    },
  });

  const agentOf = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);
  const lead = project.planning_lead_agent_id ? agentOf.get(project.planning_lead_agent_id) : null;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["pj_project_live", project.id] });
    void qc.invalidateQueries({ queryKey: ["pj_mission_discussion", project.id] });
    void qc.invalidateQueries({ queryKey: ["pj_mission_questions", project.id] });
    void qc.invalidateQueries({ queryKey: ["kickoff_items", project.id] });
    onChanged();
  };

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); refresh(); } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/failed to fetch|404|not found|unauthorized/i.test(msg)
        ? "Le service de cadrage n'est pas encore déployé (migration 0295 et fonction internal-agent-a2a)."
        : msg);
    } finally { setBusy(null); }
  };

  const stepText = (() => {
    const s = (project.planning_step ?? "").replace(/@run$/, "");
    const who = lead?.name ?? "Le pilote";
    if (s === "lead") return `${who} lit le brief et prépare son analyse…`;
    if (s.startsWith("review")) return "Les responsables d'équipe challengent l'analyse…";
    if (s === "consolidate") return `${who} consolide le cadrage et tranche…`;
    if (s === "plan") return `${who} découpe la mission en work items et fixe le calendrier…`;
    if (s.startsWith("team")) {
      const order = [...new Set((items ?? []).filter((i) => !i.parent_id && i.team_id).map((i) => i.team_id!))];
      const t = teams.find((x) => x.id === order[Number(s.split(":")[1]) || 0]);
      return `${t ? `L'équipe ${t.name}` : "Les équipes"} affine ses items et répartit le travail…`;
    }
    if (s === "done") return "Finalisation du plan…";
    return "L'équipe se concerte…";
  })();

  const stage = stageIndex(status, project.planning_step);
  const leaves = (items ?? []).filter((i) => !(items ?? []).some((c) => c.parent_id === i.id));
  const done = leaves.filter((i) => i.completed_at).length;
  const crewIds = new Set(leaves.flatMap((i) => i.pj_issue_agents.map((a) => a.agent_id)));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 px-6 py-6">
        {/* ── Où en est l'équipe ── */}
        {status !== "none" && (
          <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-border bg-card px-3 py-2.5">
            {STAGES.map((s, i) => (
              <Fragment key={s.key}>
                {i > 0 && <span className={cn("h-px w-6 shrink-0", i <= stage ? "bg-primary/60" : "bg-border")} />}
                <span className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-12 font-medium",
                  i < stage ? "text-foreground" : i === stage ? "bg-primary/10 text-primary" : "text-muted-foreground",
                )}>
                  <span className={cn(
                    "flex h-4 w-4 items-center justify-center rounded-full text-[10px]",
                    i < stage ? "bg-primary text-primary-foreground" : i === stage ? "ring-1 ring-primary" : "ring-1 ring-border",
                  )}>
                    {i < stage ? <CheckIcon className="h-2.5 w-2.5" weight="bold" /> : i + 1}
                  </span>
                  {s.label}
                </span>
              </Fragment>
            ))}
            <div className="flex-1" />
            {lead && (
              <span className="flex shrink-0 items-center gap-1.5 text-12 text-muted-foreground">
                <AgentIdentity style={lead.avatar_style ?? "orb"} url={lead.avatar_url} seed={lead.name} size={18} rounded="rounded-md" />
                Piloté par <span className="font-medium text-foreground">{lead.name}</span>
              </span>
            )}
          </div>
        )}

        {status === "none" && (
          <BriefForm project={project} teams={teams} busy={busy === "kickoff"}
            onSubmit={(patch) => act("kickoff", async () => {
              await updateProject(project.id, patch);
              await missionAction(project.id, "mission_kickoff");
            })} />
        )}

        {active && (
          <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
            <p className="text-13">{stepText}</p>
          </div>
        )}

        {status === "failed" && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3">
            <p className="min-w-0 flex-1 text-13 text-red-600">
              Le cadrage s'est arrêté : {(project.planning_error ?? "").replace(/^\[[^\]]+\]\s*/, "") || "erreur inconnue"}
            </p>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act("retry", () => missionAction(project.id, "mission_retry"))}>
              {busy === "retry" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ArrowClockwiseIcon className="mr-1 h-3.5 w-3.5" />} Relancer
            </Button>
          </div>
        )}

        {status === "questions" && (
          <QuestionsCard
            questions={(questions ?? []).filter((q) => q.status === "open")}
            asker={lead}
            busy={busy}
            onSubmit={(answers, skipRest) => act("answers", async () => {
              for (const [id, a] of Object.entries(answers)) if (a.trim()) await answerMissionQuestion(id, a.trim(), user?.id ?? null);
              await missionAction(project.id, "mission_resume", { skip: skipRest });
            })}
          />
        )}

        {status === "planned" && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
            <RocketLaunchIcon className="h-5 w-5 shrink-0 text-emerald-600" />
            <p className="min-w-0 flex-1 text-13">
              <span className="font-medium">Le plan est prêt</span> — {leaves.length} tâche(s), {crewIds.size} agent(s) mobilisé(s).
              Chaque agent démarrera dès que ses dépendances seront terminées.
            </p>
            <Button size="sm" disabled={!!busy} onClick={() => act("launch", () => missionAction(project.id, "mission_launch"))}>
              {busy === "launch" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RocketLaunchIcon className="mr-1 h-3.5 w-3.5" />} Lancer l'exécution
            </Button>
          </div>
        )}

        {status === "executing" && leaves.length > 0 && (
          <div className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="flex items-center justify-between text-13">
              <span className="font-medium">En exécution</span>
              <span className="tabular-nums text-muted-foreground">{done} / {leaves.length} tâches terminées</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(done / Math.max(1, leaves.length)) * 100}%` }} />
            </div>
          </div>
        )}

        {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-12 text-red-600">{error}</p>}

        {status !== "none" && (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
            {/* ── La concertation ── */}
            <section className="space-y-3">
              <h3 className="text-12 font-semibold uppercase tracking-wide text-muted-foreground">La concertation de l'équipe</h3>
              {!(thread ?? []).length && (
                <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-13 text-muted-foreground">
                  L'équipe prend connaissance du brief…
                </p>
              )}
              {(thread ?? []).map((e) => {
                const a = e.agent_id ? agentOf.get(e.agent_id) : null;
                const M = KIND_META[e.kind] ?? KIND_META.note;
                return (
                  <article key={e.id} className="flex gap-3 rounded-xl border border-border bg-card p-3.5">
                    {a ? (
                      <AgentIdentity style={a.avatar_style ?? "orb"} url={a.avatar_url} seed={a.name} size={32} rounded="rounded-lg" />
                    ) : (
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-12 font-semibold text-muted-foreground">
                        {e.author_user ? "Vous" : "·"}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-center gap-2 text-12">
                        <span className="font-semibold">{a?.name ?? (e.author_user ? "Vous" : "Système")}</span>
                        <span className={cn("flex items-center gap-1", M.tone)}><M.icon className="h-3 w-3" weight="fill" />{M.label}</span>
                        <span className="ml-auto text-11 text-muted-foreground">
                          {new Date(e.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <Prose text={e.content} />
                    </div>
                  </article>
                );
              })}
            </section>

            {/* ── Le brief, et ce que l'équipe en a fait ── */}
            <aside className="space-y-3">
              <SideCard title="Le brief">
                <p className="whitespace-pre-line text-12 leading-relaxed text-muted-foreground">{project.brief || project.description || "—"}</p>
                {(project.deliverables ?? []).length > 0 && (
                  <>
                    <p className="mt-3 text-11 font-semibold uppercase tracking-wide text-muted-foreground">Livrables attendus</p>
                    <ul className="mt-1 space-y-1">
                      {(project.deliverables ?? []).map((d, i) => (
                        <li key={i} className="flex gap-1.5 text-12"><ArrowRightIcon className="mt-0.5 h-3 w-3 shrink-0 text-primary" />{d.title}</li>
                      ))}
                    </ul>
                  </>
                )}
              </SideCard>
              {project.planning_summary && (
                <SideCard title="La mission, reformulée par l'équipe">
                  <Prose text={project.planning_summary} />
                </SideCard>
              )}
              {(items ?? []).length > 0 && (
                <SideCard title="Le plan">
                  <div className="space-y-3">
                    {[...new Set((items ?? []).filter((i) => !i.parent_id).map((i) => i.team_id ?? ""))].map((tid) => {
                      const team = teams.find((t) => t.id === tid);
                      return (
                        <div key={tid}>
                          <p className="mb-1 flex items-center gap-1.5 text-11 font-semibold">
                            <span className="h-2 w-2 rounded-[3px]" style={{ background: team?.color ?? "#9aa3b2" }} />
                            {team?.name ?? "Le service"}
                          </p>
                          <ul className="space-y-1">
                            {(items ?? []).filter((i) => !i.parent_id && (i.team_id ?? "") === tid).map((i) => {
                              const children = (items ?? []).filter((c) => c.parent_id === i.id);
                              return (
                                <li key={i.id} className="text-12">
                                  <ItemLine item={i} ident={project.identifier} agentOf={agentOf} />
                                  {children.length > 0 && (
                                    <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-border pl-2">
                                      {children.map((c) => <li key={c.id}><ItemLine item={c} ident={project.identifier} agentOf={agentOf} small /></li>)}
                                    </ul>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                </SideCard>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

function SideCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <p className="mb-2 text-12 font-semibold">{title}</p>
      {children}
    </div>
  );
}

function ItemLine({ item, ident, agentOf, small }: {
  item: { sequence_id: number; name: string; completed_at: string | null; estimate_hours: number | null; pj_issue_agents: Array<{ agent_id: string }> };
  ident: string; agentOf: Map<string, LiteAgent>; small?: boolean;
}) {
  const who = item.pj_issue_agents.map((a) => agentOf.get(a.agent_id)).filter(Boolean) as LiteAgent[];
  return (
    <span className={cn("flex items-center gap-1.5", small && "text-11")}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", item.completed_at ? "bg-emerald-500" : "bg-muted-foreground/40")} />
      <span className="shrink-0 font-mono text-10 text-muted-foreground">{ident}-{item.sequence_id}</span>
      <span className={cn("min-w-0 flex-1 truncate", item.completed_at && "text-muted-foreground line-through")}>{item.name}</span>
      {item.estimate_hours != null && <span className="shrink-0 text-10 tabular-nums text-muted-foreground">{item.estimate_hours} h</span>}
      {who.slice(0, 2).map((a) => (
        <span key={a.id} title={a.name} className="shrink-0">
          <AgentIdentity style={a.avatar_style ?? "orb"} url={a.avatar_url} seed={a.name} size={16} rounded="rounded" />
        </span>
      ))}
    </span>
  );
}

/** Ce que l'humain confie à l'équipe : le brief, les livrables, les équipes. */
function BriefForm({ project, teams, busy, onSubmit }: {
  project: PjProject;
  teams: Array<{ id: string; name: string; color: string; agent_ids: string[] }>;
  busy: boolean;
  onSubmit: (patch: Partial<PjProject>) => void;
}) {
  const [brief, setBrief] = useState(project.brief ?? project.description ?? "");
  const [deliv, setDeliv] = useState<MissionDeliverable[]>(project.deliverables?.length ? project.deliverables : [{ title: "" }]);
  const [picked, setPicked] = useState<string[]>(project.planning_teams ?? []);
  const [autostart, setAutostart] = useState(!!project.planning_autostart);
  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div>
        <h3 className="text-15 font-semibold">Confier la mission à l'équipe</h3>
        <p className="mt-0.5 text-12 text-muted-foreground">
          Les agents liront le brief, se concerteront, vous poseront leurs questions, puis découperont la mission, fixeront les délais et se répartiront le travail.
        </p>
      </div>
      <MissionFields brief={brief} setBrief={setBrief} deliv={deliv} setDeliv={setDeliv}
        teams={teams} picked={picked} setPicked={setPicked} autostart={autostart} setAutostart={setAutostart} />
      <div className="flex justify-end">
        <Button disabled={busy || !brief.trim()} onClick={() => onSubmit({
          brief: brief.trim(), deliverables: deliv.filter((d) => d.title.trim()), planning_teams: picked, planning_autostart: autostart,
        })}>
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <PaperPlaneTiltIcon className="mr-1 h-4 w-4" />} Confier à l'équipe
        </Button>
      </div>
    </div>
  );
}

/** Les champs d'une mission confiée : réutilisés à la création et ici. */
export function MissionFields({ brief, setBrief, deliv, setDeliv, teams, picked, setPicked, autostart, setAutostart }: {
  brief: string; setBrief: (v: string) => void;
  deliv: MissionDeliverable[]; setDeliv: (v: MissionDeliverable[]) => void;
  teams: Array<{ id: string; name: string; color: string; agent_ids: string[] }>;
  picked: string[]; setPicked: (v: string[]) => void;
  autostart: boolean; setAutostart: (v: boolean) => void;
}) {
  return (
    <div className="space-y-4">
      <BriefInput value={brief} onChange={setBrief} />
      <DeliverablesField deliv={deliv} setDeliv={setDeliv} />
      <TeamsPicker teams={teams} picked={picked} setPicked={setPicked} />
      <label className="flex items-center gap-2 text-12">
        <input type="checkbox" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} className="h-3.5 w-3.5 accent-[hsl(var(--primary))]" />
        Lancer l'exécution dès que le plan est prêt, sans attendre mon feu vert
      </label>
    </div>
  );
}

/** Les livrables attendus : une ligne chacun. */
export function DeliverablesField({ deliv, setDeliv }: {
  deliv: MissionDeliverable[]; setDeliv: (v: MissionDeliverable[]) => void;
}) {
  return (
      <div>
        <label className="mb-1 block text-12 font-medium">Livrables attendus</label>
        <div className="space-y-1.5">
          {deliv.map((d, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <TextField
                value={d.title} placeholder={i === 0 ? "Ex. Un rapport d'analyse concurrentielle de 10 pages" : "Un autre livrable…"}
                onChange={(e) => setDeliv(deliv.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))}
                className="flex-1"
              />
              {deliv.length > 1 && (
                <button type="button" aria-label="Retirer" onClick={() => setDeliv(deliv.filter((_, k) => k !== i))}
                  className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                  <TrashIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
          <button type="button" onClick={() => setDeliv([...deliv, { title: "" }])}
            className="flex items-center gap-1 rounded px-1 py-0.5 text-12 text-muted-foreground hover:text-foreground">
            <PlusIcon className="h-3 w-3" /> Ajouter un livrable
          </button>
        </div>
      </div>
  );
}

/** Les équipes mobilisées. Une équipe sans agent n'a rien à apporter : elle
 *  n'est pas proposée. Aucune choisie = tout le service. */
export function TeamsPicker({ teams, picked, setPicked }: {
  teams: Array<{ id: string; name: string; color: string; agent_ids: string[] }>;
  picked: string[]; setPicked: (v: string[]) => void;
}) {
  const staffed = teams.filter((t) => t.agent_ids.length > 0);
  if (!staffed.length) return null;
  return (
        <div>
          <label className="mb-1 block text-12 font-medium">Équipes <span className="font-normal text-muted-foreground">· aucune choisie = tout le service</span></label>
          <div className="flex flex-wrap gap-1.5">
            {staffed.map((t) => {
              const on = picked.includes(t.id);
              return (
                <button key={t.id} type="button"
                  onClick={() => setPicked(on ? picked.filter((x) => x !== t.id) : [...picked, t.id])}
                  className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-12 transition-colors",
                    on ? "border-transparent bg-foreground text-background" : "border-border hover:bg-muted")}>
                  <span className="h-2 w-2 rounded-[3px]" style={{ background: t.color }} />
                  {t.name}
                  <span className={cn("tabular-nums", on ? "text-background/70" : "text-muted-foreground")}>{t.agent_ids.length}</span>
                </button>
              );
            })}
          </div>
        </div>
  );
}

function QuestionsCard({ questions, asker, busy, onSubmit }: {
  questions: Array<{ id: string; question: string; why: string | null; suggestion: string | null }>;
  asker: LiteAgent | null | undefined;
  busy: string | null;
  onSubmit: (answers: Record<string, string>, skipRest: boolean) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const filled = questions.filter((q) => (answers[q.id] ?? "").trim()).length;
  return (
    <div className="space-y-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-4">
      <div className="flex items-center gap-2">
        {asker && <AgentIdentity style={asker.avatar_style ?? "orb"} url={asker.avatar_url} seed={asker.name} size={22} rounded="rounded-md" />}
        <p className="text-13">
          <span className="font-medium">{asker?.name ?? "L'équipe"}</span> a besoin de vous avant de planifier.
          <span className="text-muted-foreground"> Une réponse suggérée accompagne chaque question.</span>
        </p>
      </div>
      {questions.map((q, i) => (
        <div key={q.id} className="rounded-lg border border-border bg-card p-3">
          <p className="text-13 font-medium">{i + 1}. {q.question}</p>
          {q.why && <p className="mt-0.5 text-12 text-muted-foreground">{q.why}</p>}
          <TextAreaField
            value={answers[q.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
            placeholder="Votre réponse…" className="mt-2 min-h-[56px]"
          />
          {q.suggestion && (
            <button type="button" onClick={() => setAnswers({ ...answers, [q.id]: q.suggestion! })}
              className="mt-1.5 flex items-start gap-1.5 rounded-md px-1.5 py-1 text-left text-12 text-muted-foreground hover:bg-muted hover:text-foreground">
              <LightbulbIcon className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" weight="fill" />
              <span>Suggestion : {q.suggestion} <span className="text-primary">— la retenir</span></span>
            </button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => onSubmit({}, true)}>Continuer sans répondre</Button>
        <Button size="sm" disabled={!!busy || filled === 0} onClick={() => onSubmit(answers, filled < questions.length)}>
          {busy === "answers" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <PaperPlaneTiltIcon className="mr-1 h-3.5 w-3.5" />}
          Envoyer {filled < questions.length && filled > 0 ? `(${filled}/${questions.length})` : "mes réponses"}
        </Button>
      </div>
    </div>
  );
}
