// Formations — les parcours d'apprentissage aux outils, et ce qu'ils ont appris
// des gens qui les ont suivis.
//
// Un parcours ne réécrit PAS les procédures : celles-ci existent déjà, apprises
// par démonstration (migration 0202, page agent/skills/record), et portent leurs
// gestes exacts dans steps.json. Ce que le parcours ajoute est ce qu'aucune
// démonstration ne contient : à qui ça s'adresse, dans quel ordre, ce que la
// personne doit savoir faire à la fin.
//
// L'écran qui compte n'est pas la liste des parcours mais celui des BLOCAGES.
// Une étape sur laquelle quatre personnes sur cinq trébuchent n'est pas un
// problème de nouveaux arrivants : c'est une consigne mal écrite, ou un outil
// mal fichu. Sans cette colonne, on reforme les mêmes gens sur la même marche
// pendant des années sans jamais la voir.
//
// Route : agent/training
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleNotchIcon as Loader2,
  PlusIcon as Plus,
  GraduationCapIcon as GraduationCap,
  ArrowLeftIcon as ArrowLeft,
  PuzzlePieceIcon as Puzzle,
  ClockIcon as Clock,
  CheckCircleIcon as CircleCheck,
  WarningCircleIcon as CircleAlert,
  CircleDashedIcon as CircleDashed,
  MagnifyingGlassIcon as Search,
  PlayIcon as Play,
  XIcon as X,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SoftField, SoftInput, SoftTextarea } from "@/components/ui/soft-form";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

interface Program {
  id: string;
  title: string;
  tool_name: string | null;
  tool_url: string | null;
  audience: string | null;
  summary: string | null;
  objectives: string[];
  skill_ids: string[];
  est_minutes: number | null;
  is_published: boolean;
  created_at: string;
}

interface Session {
  id: string;
  program_id: string | null;
  trainee_name: string | null;
  trainee_email: string | null;
  status: string;
  current_step: number;
  total_steps: number | null;
  stuck_count: number;
  duration_ms: number | null;
  summary: string | null;
  started_at: string;
  finished_at: string | null;
}

interface StepLog {
  id: string;
  session_id: string;
  seq: number;
  title: string | null;
  instruction: string | null;
  outcome: string;
  duration_ms: number | null;
  note: string | null;
  url: string | null;
}

interface SkillRow { id: string; name: string; slug: string; description: string | null }

const mins = (ms: number | null) => (ms ? `${Math.max(1, Math.round(ms / 60000))} min` : "—");

const OUTCOME_META: Record<string, { label: string; cls: string }> = {
  done:      { label: "fait",              cls: "text-emerald-500" },
  answered:  { label: "répondu",           cls: "text-emerald-500" },
  stuck:     { label: "bloquée",           cls: "text-amber-500" },
  skipped:   { label: "passée",            cls: "text-muted-foreground" },
  timeout:   { label: "sans réaction",     cls: "text-orange-500" },
  not_found: { label: "repère introuvable", cls: "text-rose-500" },
};

export function TrainingPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Program | "new" | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data: programs, isLoading } = useQuery({
    queryKey: ["training_programs", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase.from("training_programs")
        .select("id, title, tool_name, tool_url, audience, summary, objectives, skill_ids, est_minutes, is_published, created_at")
        .eq("workspace_id", workspaceId!).order("created_at", { ascending: false });
      return (data ?? []) as Program[];
    },
  });

  const { data: sessions } = useQuery({
    queryKey: ["training_sessions", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase.from("training_sessions")
        .select("id, program_id, trainee_name, trainee_email, status, current_step, total_steps, stuck_count, duration_ms, summary, started_at, finished_at")
        .eq("workspace_id", workspaceId!).order("started_at", { ascending: false }).limit(200);
      return (data ?? []) as Session[];
    },
    // Une session est en cours dans le navigateur de quelqu'un d'autre : la
    // page doit avancer toute seule, sinon elle ment dès la deuxième étape.
    refetchInterval: (q) => ((q.state.data as Session[] | undefined)?.some((s) => s.status === "in_progress") ? 5000 : false),
  });

  const byProgram = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const s of sessions ?? []) {
      if (!s.program_id) continue;
      const arr = map.get(s.program_id) ?? [];
      arr.push(s);
      map.set(s.program_id, arr);
    }
    return map;
  }, [sessions]);

  async function save(draft: Partial<Program>, id?: string) {
    if (!workspaceId) return;
    const row = {
      workspace_id: workspaceId,
      project_id: projectId ?? null,
      title: (draft.title ?? "").trim() || "Nouveau parcours",
      tool_name: draft.tool_name || null,
      tool_url: draft.tool_url || null,
      audience: draft.audience || null,
      summary: draft.summary || null,
      objectives: draft.objectives ?? [],
      skill_ids: draft.skill_ids ?? [],
      est_minutes: draft.est_minutes ?? null,
      is_published: draft.is_published ?? false,
    };
    if (id) await supabase.from("training_programs").update({ ...row, updated_at: new Date().toISOString() }).eq("id", id);
    else await supabase.from("training_programs").insert({ ...row, created_by: user?.id ?? null });
    qc.invalidateQueries({ queryKey: ["training_programs", workspaceId] });
    setEditing(null);
  }

  const openProgram = (programs ?? []).find((p) => p.id === openId) ?? null;
  if (openProgram) {
    return (
      <ProgramDetail
        program={openProgram}
        sessions={byProgram.get(openProgram.id) ?? []}
        onBack={() => setOpenId(null)}
        onEdit={() => setEditing(openProgram)}
        editor={editing ? (
          <ProgramDialog
            program={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
            onSave={save}
          />
        ) : null}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto w-full max-w-7xl space-y-4">
        <PageHeader
          title="Formations"
          description="Les parcours qui apprennent vos outils aux nouveaux arrivants — guidés dans l'outil, étape par étape, par un agent qui montre sans faire à leur place."
          actions={<Button size="sm" onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> Nouveau parcours</Button>}
        />

        {isLoading ? (
          <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (programs ?? []).length === 0 ? (
          <EmptyState
            icon={GraduationCap}
            title="Aucun parcours de formation"
            description="Un parcours dit quel outil apprendre, à qui, et dans quel ordre. Il s'appuie sur des procédures déjà démontrées (Skills → Enregistrer une démonstration) : l'agent guide d'après les gestes réels, pas d'après ce qu'il croit savoir de l'outil."
            action={<Button size="sm" onClick={() => setEditing("new")}><Plus className="mr-1.5 h-4 w-4" /> Créer un parcours</Button>}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(programs ?? []).map((p) => (
              <ProgramCard
                key={p.id}
                program={p}
                sessions={byProgram.get(p.id) ?? []}
                onOpen={() => setOpenId(p.id)}
              />
            ))}
          </div>
        )}

        {editing && (
          <ProgramDialog
            program={editing === "new" ? null : editing}
            onClose={() => setEditing(null)}
            onSave={save}
          />
        )}
      </div>
    </div>
  );
}

function ProgramCard({ program, sessions, onOpen }: { program: Program; sessions: Session[]; onOpen: () => void }) {
  const done = sessions.filter((s) => s.status === "done").length;
  const live = sessions.filter((s) => s.status === "in_progress").length;
  return (
    <button
      onClick={onOpen}
      className="group flex flex-col rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/30"
    >
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <GraduationCap className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{program.title}</div>
          <div className="truncate text-xs text-muted-foreground">
            {program.tool_name ?? "Outil non précisé"}{program.audience ? ` · ${program.audience}` : ""}
          </div>
        </div>
        {!program.is_published && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">brouillon</span>
        )}
      </div>

      {program.summary && <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">{program.summary}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><Puzzle className="h-3.5 w-3.5" /> {program.skill_ids.length} procédure{program.skill_ids.length > 1 ? "s" : ""}</span>
        {program.est_minutes ? <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {program.est_minutes} min</span> : null}
        <span className="inline-flex items-center gap-1"><CircleCheck className="h-3.5 w-3.5" /> {done} formé{done > 1 ? "s" : ""}</span>
        {live > 0 && <span className="inline-flex items-center gap-1 text-primary"><Play className="h-3.5 w-3.5" /> {live} en cours</span>}
      </div>
    </button>
  );
}

// ── Le détail d'un parcours ───────────────────────────────────────────────────

function ProgramDetail({ program, sessions, onBack, onEdit, editor }: {
  program: Program; sessions: Session[]; onBack: () => void; onEdit: () => void; editor: React.ReactNode;
}) {
  const [openSession, setOpenSession] = useState<Session | null>(null);

  const { data: skills } = useQuery({
    queryKey: ["training_program_skills", program.id, program.skill_ids.join(",")],
    enabled: program.skill_ids.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("agent_skills")
        .select("id, name, slug, description").in("id", program.skill_ids);
      // L'ordre du parcours est pédagogique — la base rendrait l'ordre d'insertion.
      return program.skill_ids
        .map((id) => (data ?? []).find((s) => s.id === id))
        .filter(Boolean) as SkillRow[];
    },
  });

  const sessionIds = sessions.map((s) => s.id);
  const { data: logs } = useQuery({
    queryKey: ["training_logs", program.id, sessionIds.length],
    enabled: sessionIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("training_step_logs")
        .select("id, session_id, seq, title, instruction, outcome, duration_ms, note, url")
        .in("session_id", sessionIds).order("seq").limit(2000);
      return (data ?? []) as StepLog[];
    },
  });

  // Le tableau des marches qui font trébucher. Regroupé sur le numéro d'étape
  // ET son titre : deux sessions d'un même parcours suivent le même ordre, mais
  // un parcours réécrit entre-temps ne doit pas mélanger l'ancienne étape 4 et
  // la nouvelle.
  const blockers = useMemo(() => {
    const map = new Map<string, { title: string; seen: number; rough: number; stuck: number; timeout: number; notFound: number }>();
    for (const l of logs ?? []) {
      const key = `${l.seq}·${l.title ?? l.instruction ?? ""}`;
      const row = map.get(key) ?? { title: l.title || l.instruction || `Étape ${l.seq}`, seen: 0, rough: 0, stuck: 0, timeout: 0, notFound: 0 };
      row.seen += 1;
      if (l.outcome === "stuck") { row.stuck += 1; row.rough += 1; }
      if (l.outcome === "timeout") { row.timeout += 1; row.rough += 1; }
      if (l.outcome === "not_found") { row.notFound += 1; row.rough += 1; }
      map.set(key, row);
    }
    return [...map.values()].filter((r) => r.rough > 0).sort((a, b) => b.rough - a.rough).slice(0, 8);
  }, [logs]);

  const logsBySession = useMemo(() => {
    const map = new Map<string, StepLog[]>();
    for (const l of logs ?? []) {
      const arr = map.get(l.session_id) ?? [];
      arr.push(l);
      map.set(l.session_id, arr);
    }
    return map;
  }, [logs]);

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Formations</Button>
        </div>

        <PageHeader
          title={program.title}
          description={[program.tool_name, program.audience, program.est_minutes ? `${program.est_minutes} min` : null]
            .filter(Boolean).join(" · ") || undefined}
          actions={<Button size="sm" variant="outline" onClick={onEdit}>Modifier</Button>}
        />

        {program.summary && <p className="max-w-3xl text-sm text-muted-foreground">{program.summary}</p>}

        {program.objectives.length > 0 && (
          <section className="rounded-2xl border border-border bg-card p-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">À la fin, la personne sait</h2>
            <ul className="space-y-1.5">
              {program.objectives.map((o, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  <span>{o}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Procédures suivies</h2>
          {(skills ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucune procédure rattachée. Enregistrez une démonstration (Skills → Enregistrer) : l'agent guidera d'après les
              gestes réels plutôt que d'après ce qu'il croit savoir de l'outil.
            </p>
          ) : (
            <ol className="space-y-2">
              {(skills ?? []).map((s, i) => (
                <li key={s.id} className="flex items-start gap-3 rounded-xl bg-muted/40 px-3 py-2">
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-background text-[11px] font-semibold">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{s.name}</div>
                    {s.description && <div className="line-clamp-2 text-xs text-muted-foreground">{s.description}</div>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        {blockers.length > 0 && (
          <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">Là où les gens trébuchent</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Ces étapes ont bloqué, expiré, ou n'ont pas pu être montrées. C'est la procédure qu'il faut réécrire, pas la personne qu'il faut reformer.
            </p>
            <ul className="space-y-1.5">
              {blockers.map((b, i) => (
                <li key={i} className="flex items-center gap-3 rounded-xl bg-background/60 px-3 py-2 text-sm">
                  <CircleAlert className="h-4 w-4 shrink-0 text-amber-500" />
                  <span className="min-w-0 flex-1 truncate">{b.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {b.rough}/{b.seen} passage{b.seen > 1 ? "s" : ""}
                    {b.notFound > 0 ? ` · ${b.notFound} repère(s) introuvable(s)` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sessions</h2>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Personne n'a encore suivi ce parcours. Demandez au Formateur de lancer une session — la personne active
              « Mode formation » dans l'extension, et le guidage démarre sur son écran.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {sessions.map((s) => {
                const pct = s.total_steps ? Math.min(100, Math.round((s.current_step / s.total_steps) * 100)) : null;
                return (
                  <button
                    key={s.id}
                    onClick={() => setOpenSession(s)}
                    className="flex w-full items-center gap-3 py-2.5 text-left transition-colors hover:bg-accent/30"
                  >
                    <StatusDot status={s.status} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{s.trainee_name || s.trainee_email || "Sans nom"}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(s.started_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                        {" · "}{s.current_step} étape{s.current_step > 1 ? "s" : ""}{pct != null ? ` (${pct}%)` : ""}
                        {s.stuck_count > 0 ? ` · ${s.stuck_count} blocage${s.stuck_count > 1 ? "s" : ""}` : ""}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{mins(s.duration_ms)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {openSession && (
          <SessionDialog
            session={openSession}
            logs={logsBySession.get(openSession.id) ?? []}
            onClose={() => setOpenSession(null)}
          />
        )}
        {editor}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === "done") return <CircleCheck className="h-4 w-4 shrink-0 text-emerald-500" />;
  if (status === "abandoned") return <CircleAlert className="h-4 w-4 shrink-0 text-rose-500" />;
  if (status === "in_progress") return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />;
  return <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function SessionDialog({ session, logs, onClose }: { session: Session; logs: StepLog[]; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{session.trainee_name || session.trainee_email || "Session"}</DialogTitle>
        </DialogHeader>
        <div className="text-xs text-muted-foreground">
          {new Date(session.started_at).toLocaleString("fr-FR")} · {mins(session.duration_ms)} · {session.status}
        </div>
        {session.summary && (
          <p className="rounded-xl bg-muted/50 p-3 text-sm leading-relaxed">{session.summary}</p>
        )}
        <ol className="space-y-1.5">
          {logs.map((l) => {
            const meta = OUTCOME_META[l.outcome] ?? { label: l.outcome, cls: "text-muted-foreground" };
            return (
              <li key={l.id} className="flex items-start gap-3 rounded-xl bg-muted/40 px-3 py-2">
                <span className="mt-0.5 w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{l.seq}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{l.title || l.instruction || "—"}</div>
                  {l.title && l.instruction && <div className="text-xs text-muted-foreground">{l.instruction}</div>}
                  {l.note && <div className="mt-0.5 text-xs italic text-muted-foreground">{l.note}</div>}
                </div>
                <span className={cn("shrink-0 text-[11px] font-medium", meta.cls)}>{meta.label}</span>
              </li>
            );
          })}
          {logs.length === 0 && <li className="text-sm text-muted-foreground">Aucune étape journalisée.</li>}
        </ol>
      </DialogContent>
    </Dialog>
  );
}

// ── Créer / modifier un parcours ──────────────────────────────────────────────

function ProgramDialog({ program, onClose, onSave }: {
  program: Program | null;
  onClose: () => void;
  onSave: (draft: Partial<Program>, id?: string) => Promise<void>;
}) {
  const { workspaceId } = useCurrentContext();
  const [title, setTitle] = useState(program?.title ?? "");
  const [tool, setTool] = useState(program?.tool_name ?? "");
  const [url, setUrl] = useState(program?.tool_url ?? "");
  const [audience, setAudience] = useState(program?.audience ?? "");
  const [summary, setSummary] = useState(program?.summary ?? "");
  const [objectives, setObjectives] = useState((program?.objectives ?? []).join("\n"));
  const [estMinutes, setEstMinutes] = useState(program?.est_minutes ? String(program.est_minutes) : "");
  const [skillIds, setSkillIds] = useState<string[]>(program?.skill_ids ?? []);
  const [published, setPublished] = useState(program?.is_published ?? false);
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);

  // Les procédures apprises par démonstration d'abord : ce sont elles qui
  // portent des gestes ciblables. Le reste du catalogue (891 skills système)
  // n'a rien à faire dans un parcours de formation à un outil.
  const { data: skills } = useQuery({
    queryKey: ["training_skill_picker", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase.from("agent_skills")
        .select("id, name, slug, description, source_recording_id")
        .eq("workspace_id", workspaceId!)
        .order("created_at", { ascending: false }).limit(200);
      return (data ?? []) as Array<SkillRow & { source_recording_id: string | null }>;
    },
  });

  const chosen = (skills ?? []).filter((s) => skillIds.includes(s.id));
  const results = (skills ?? []).filter((s) =>
    !skillIds.includes(s.id)
    && (!q.trim() || `${s.name} ${s.description ?? ""}`.toLowerCase().includes(q.toLowerCase())),
  ).slice(0, 8);

  async function submit() {
    setSaving(true);
    await onSave({
      title,
      tool_name: tool || null,
      tool_url: url || null,
      audience: audience || null,
      summary: summary || null,
      objectives: objectives.split("\n").map((l) => l.trim()).filter(Boolean),
      est_minutes: estMinutes ? Number(estMinutes) : null,
      skill_ids: skillIds,
      is_published: published,
    }, program?.id);
    setSaving(false);
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{program ? "Modifier le parcours" : "Nouveau parcours"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3.5">
          <SoftField label="Titre">
            <SoftInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Créer et qualifier un contact dans HubSpot" />
          </SoftField>

          <div className="grid gap-3.5 sm:grid-cols-2">
            <SoftField label="Outil">
              <SoftInput value={tool} onChange={(e) => setTool(e.target.value)} placeholder="HubSpot" />
            </SoftField>
            <SoftField label="Adresse de l'outil">
              <SoftInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.hubspot.com" />
            </SoftField>
          </div>

          <div className="grid gap-3.5 sm:grid-cols-2">
            <SoftField label="Pour qui">
              <SoftInput value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Nouveaux SDR" />
            </SoftField>
            <SoftField label="Durée estimée (minutes)">
              <SoftInput value={estMinutes} onChange={(e) => setEstMinutes(e.target.value.replace(/\D/g, ""))} placeholder="25" inputMode="numeric" />
            </SoftField>
          </div>

          <SoftField label="En deux phrases">
            <SoftTextarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)}
              placeholder="Ce que la séance couvre, et ce qu'elle ne couvre pas." />
          </SoftField>

          <SoftField label="À la fin, la personne sait — une par ligne">
            <SoftTextarea rows={3} value={objectives} onChange={(e) => setObjectives(e.target.value)}
              placeholder={"Créer un contact sans doublon\nRattacher le contact à la bonne entreprise\nLancer une séquence de relance"} />
          </SoftField>

          <SoftField label="Procédures démontrées à suivre, dans l'ordre">
            <div className="space-y-2">
              {chosen.map((s, i) => (
                <div key={s.id} className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-background text-[11px] font-semibold">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{s.name}</span>
                  <button
                    onClick={() => setSkillIds((prev) => prev.filter((id) => id !== s.id))}
                    className="rounded-md p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                    aria-label={`Retirer ${s.name}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <SoftInput className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher une procédure enregistrée…" />
              </div>
              {q.trim() && (
                <div className="space-y-1">
                  {results.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => { setSkillIds((prev) => [...prev, s.id]); setQ(""); }}
                      className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                    >
                      <Puzzle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      {s.source_recording_id && <span className="shrink-0 text-[10px] text-primary">démontrée</span>}
                    </button>
                  ))}
                  {results.length === 0 && (
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      Aucune procédure. Enregistrez une démonstration depuis Skills → Enregistrer une démonstration.
                    </p>
                  )}
                </div>
              )}
            </div>
          </SoftField>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} className="h-4 w-4 rounded" />
            Parcours prêt à être suivi
          </label>
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Annuler</Button>
          <Button size="sm" onClick={submit} disabled={saving || !title.trim()}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {program ? "Enregistrer" : "Créer le parcours"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
