// La première minute d'un nouveau compte.
//
// Ce qu'il y avait avant : quatre cartes décoratives, « Welcome to Anduran »,
// « Connect GitHub », « Run first scan », « Generate cockpit » — le vocabulaire
// d'un produit qui n'existe plus — et un bouton « Continue » qui menait à une
// liste d'organisations vide. Rien n'était cliquable, rien n'était enregistré,
// et l'arrivant se retrouvait devant un espace vide sans savoir quoi y mettre.
//
// Celui-ci FAIT les choses. À la fin, le compte a un espace de travail, un
// projet, un contexte d'entreprise que tous les agents liront, un objectif
// écrit, un service et un premier agent qui existe vraiment.
//
// ── Les règles qu'on s'est données ─────────────────────────────────────────
//
//   • Chaque étape enregistre en la quittant. On peut fermer l'onglet à la
//     troisième question sans avoir rien perdu, et reprendre où on en était.
//   • Une seule étape est bloquante — le nom de l'entreprise, parce que tout le
//     reste s'y rattache. Les autres se passent, et la page le dit.
//   • Chaque champ explique à quoi il SERT pour les agents. « Client type » se
//     remplit quand on sait que c'est ce qui décide du ton de tout ce que la
//     workforce écrira.
//   • On ne demande rien qu'on puisse déduire. Le nom du projet, le slug, le
//     service : dérivés du nom de l'entreprise, modifiables plus tard.
//
// À la sortie, le relais est passé au coach dans l'application (voir
// `markCoachPending`) : le parcours pose le décor, la première vraie tâche
// s'apprend dans l'outil, pas dans un tunnel.

import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import {
  ArrowRightIcon as ArrowRight,
  ArrowLeftIcon as ArrowLeft,
  BuildingsIcon as Building2,
  CheckIcon as Check,
  CircleNotchIcon as Loader2,
  RobotIcon as Bot,
  TargetIcon as Target,
  UsersIcon as Users,
  WarningCircleIcon as AlertCircle,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { createWorkspace, createProject, useWorkspaces } from "@/hooks/useWorkspace";
import { saveCompanyProfile, upsertObjective } from "@/features/company/model";
import { createServiceDashboard } from "@/features/service-dashboards/model";
import { instantiateTemplate } from "@/features/internal-agents/instantiateTemplate";
import { AGENT_TEMPLATES } from "@/features/internal-agents/agentTemplates";

/* ── L'état, repris après un rechargement ───────────────────────────────────
   Le parcours écrit en base à chaque étape, mais il a aussi besoin de savoir OÙ
   il en était. Les identifiants créés vivent ici, en local : c'est un brouillon
   de session, pas une donnée du produit. Si le stockage est refusé (navigation
   privée, site data bloqué), le parcours fonctionne quand même — il redémarre
   simplement à l'étape 1, ce qui est le pire cas acceptable. */
const DRAFT_KEY = "anduran.onboarding.draft";
/** Lu par l'application au premier chargement pour armer le coach. */
export const COACH_PENDING_KEY = "anduran.coach.pending";

interface Draft {
  step: number;
  workspaceId?: string;
  workspaceSlug?: string;
  projectId?: string;
  projectSlug?: string;
  dashboardId?: string;
  company: string;
  activity: string;
  icp: string;
  tone: string;
  objective: string;
  templateId?: string;
}

const EMPTY: Draft = { step: 0, company: "", activity: "", icp: "", tone: "", objective: "" };

function readDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY;
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<Draft>) };
  } catch {
    return EMPTY;
  }
}

function writeDraft(d: Draft) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* sans mémoire, on repart de zéro */ }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* rien à nettoyer */ }
}

function markCoachPending() {
  try { localStorage.setItem(COACH_PENDING_KEY, "1"); } catch { /* le coach se proposera plus tard */ }
}

/* ── Les agents proposés en premier ─────────────────────────────────────────
   Pas les dix-huit du catalogue : quatre, qui couvrent les débuts les plus
   fréquents et dont on sait qu'ils rendent quelque chose dès le premier run.
   Le reste du catalogue est à un clic une fois dans l'application. */
const FIRST_AGENTS = ["ai-secretary", "support-resolver", "exec-briefer", "growth-content"];

function firstAgentTemplates() {
  const picked = FIRST_AGENTS
    .map((key) => AGENT_TEMPLATES.find((t) => t.key === key))
    .filter((t): t is (typeof AGENT_TEMPLATES)[number] => !!t);
  // Si les identifiants du catalogue ont bougé, on prend les quatre premiers
  // plutôt que d'afficher une étape vide.
  return picked.length >= 2 ? picked : AGENT_TEMPLATES.slice(0, 4);
}

const STEPS = [
  { key: "company", label: "Votre entreprise", icon: Building2 },
  { key: "audience", label: "À qui vous parlez", icon: Users },
  { key: "objective", label: "Votre objectif", icon: Target },
  { key: "agent", label: "Votre premier agent", icon: Bot },
] as const;

export function OnboardingPage() {
  const navigate = useNavigate();
  const { user, session, loading: authLoading } = useAuth();
  const { data: workspaces, isLoading: wsLoading } = useWorkspaces();

  const [draft, setDraft] = useState<Draft>(() => readDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templates = useMemo(firstAgentTemplates, []);

  useEffect(() => { writeDraft(draft); }, [draft]);

  if (!authLoading && !session) return <Navigate to="/login" replace />;

  /* Un compte qui a DÉJÀ un espace de travail n'est pas un nouvel arrivant : il
     revient (invitation acceptée, second appareil, retour après déconnexion).
     Le renvoyer dans le tunnel lui ferait recréer un espace en double. */
  const hasWorkspace = (workspaces ?? []).length > 0;
  if (!authLoading && !wsLoading && hasWorkspace && !draft.workspaceId) {
    return <Navigate to="/orgs" replace />;
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const go = (step: number) => { setError(null); setDraft((d) => ({ ...d, step })); };

  /** Chaque étape enregistre ce qu'elle porte, puis avance. */
  async function commit(step: number) {
    setBusy(true);
    setError(null);
    try {
      if (step === 0) await commitCompany();
      if (step === 1) await commitAudience();
      if (step === 2) await commitObjective();
      if (step === 3) await commitAgent();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "L'enregistrement a échoué.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function commitCompany() {
    const name = draft.company.trim();
    if (!name) throw new Error("Le nom de l'entreprise est nécessaire — tout le reste s'y rattache.");
    // Idempotent : repasser par cette étape ne recrée pas un espace.
    let { workspaceId, workspaceSlug, projectId, projectSlug } = draft;
    if (!workspaceId) {
      const ws = await createWorkspace(name);
      workspaceId = ws.id;
      workspaceSlug = ws.slug;
    }
    if (!projectId && workspaceId) {
      const proj = await createProject(workspaceId, name);
      projectId = (proj as { id: string }).id;
      projectSlug = (proj as { slug: string }).slug;
    }
    if (workspaceId && projectId) {
      await saveCompanyProfile(projectId, workspaceId, user?.id ?? null, {
        legal_name: name,
        activity: draft.activity.trim() || null,
      });
    }
    set({ workspaceId, workspaceSlug, projectId, projectSlug });
  }

  async function commitAudience() {
    if (!draft.projectId || !draft.workspaceId) return;
    await saveCompanyProfile(draft.projectId, draft.workspaceId, user?.id ?? null, {
      icp: draft.icp.trim() || null,
      tone: draft.tone.trim() || null,
    });
  }

  async function commitObjective() {
    const title = draft.objective.trim();
    if (!title || !draft.projectId || !draft.workspaceId) return;
    await upsertObjective({
      workspace_id: draft.workspaceId,
      project_id: draft.projectId,
      title,
      status: "active",
      priority: 1,
    });
  }

  async function commitAgent() {
    if (!draft.projectId || !draft.workspaceId || !user?.id) return;
    const template = templates.find((t) => t.key === draft.templateId);
    if (!template) return;
    let dashboardId = draft.dashboardId;
    if (!dashboardId) {
      const d = await createServiceDashboard(draft.workspaceId, draft.projectId, user.id, {
        name: draft.company.trim() || "Mon service",
      });
      dashboardId = d?.id;
    }
    if (!dashboardId) throw new Error("Le service n'a pas pu être créé.");
    await instantiateTemplate(template, {
      workspaceId: draft.workspaceId,
      projectId: draft.projectId,
      userId: user.id,
      serviceDashboardId: dashboardId,
    });
    set({ dashboardId });
  }

  async function next() {
    const ok = await commit(draft.step);
    if (!ok) return;
    if (draft.step < STEPS.length - 1) { go(draft.step + 1); return; }
    finish();
  }

  /** Passer une étape n'enregistre rien et n'échoue jamais. */
  function skip() {
    if (draft.step < STEPS.length - 1) { go(draft.step + 1); return; }
    finish();
  }

  function finish() {
    markCoachPending();
    clearDraft();
    if (draft.workspaceSlug && draft.projectSlug) {
      navigate(`/app/${draft.workspaceSlug}/${draft.projectSlug}`, { replace: true });
    } else {
      navigate("/orgs", { replace: true });
    }
  }

  const step = STEPS[draft.step];
  const canAdvance = draft.step !== 0 || draft.company.trim().length > 0;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* ── Progression ───────────────────────────────────────────────────── */}
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-6 py-4">
          {STEPS.map((s, i) => {
            const done = i < draft.step;
            const active = i === draft.step;
            const Icon = s.icon;
            return (
              <div key={s.key} className="flex flex-1 items-center gap-2">
                <div
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] transition-colors",
                    done && "border-primary bg-primary text-primary-foreground",
                    active && !done && "border-primary text-primary",
                    !done && !active && "border-border text-muted-foreground",
                  )}
                >
                  {done ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                </div>
                <span
                  className={cn(
                    "hidden truncate text-xs sm:block",
                    active ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {s.label}
                </span>
                {i < STEPS.length - 1 && <div className="h-px flex-1 bg-border" />}
              </div>
            );
          })}
        </div>
      </header>

      <main className="flex flex-1 items-start justify-center px-6 py-10 sm:py-16">
        <div className="w-full max-w-xl">
          {draft.step === 0 && (
            <StepCompany
              company={draft.company}
              activity={draft.activity}
              onChange={set}
            />
          )}
          {draft.step === 1 && (
            <StepAudience icp={draft.icp} tone={draft.tone} onChange={set} />
          )}
          {draft.step === 2 && (
            <StepObjective objective={draft.objective} onChange={set} />
          )}
          {draft.step === 3 && (
            <StepAgent
              templates={templates}
              selected={draft.templateId}
              onSelect={(id) => set({ templateId: id })}
            />
          )}

          {error && (
            <div
              role="alert"
              className="mt-6 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* ── Navigation ──────────────────────────────────────────────────
              « Passer » est offert partout sauf à la première étape : sans nom
              d'entreprise il n'y a ni espace ni projet où ranger la suite. */}
          <div className="mt-8 flex items-center gap-2">
            {draft.step > 0 && (
              <Button variant="ghost" onClick={() => go(draft.step - 1)} disabled={busy}>
                <ArrowLeft className="mr-1.5 h-4 w-4" /> Retour
              </Button>
            )}
            <div className="flex-1" />
            {draft.step > 0 && (
              <Button variant="ghost" onClick={skip} disabled={busy}>
                Passer
              </Button>
            )}
            <Button onClick={() => void next()} disabled={busy || !canAdvance}>
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {draft.step === STEPS.length - 1 ? "Entrer dans l'application" : "Continuer"}
              {!busy && <ArrowRight className="ml-1.5 h-4 w-4" />}
            </Button>
          </div>

          <p className="mt-5 text-xs text-muted-foreground">
            Tout est enregistré à chaque étape. Vous pouvez fermer cet onglet et reprendre plus tard.
          </p>
        </div>
      </main>
    </div>
  );
}

/* ── Étapes ─────────────────────────────────────────────────────────────────
   Chaque champ porte son « à quoi ça sert ». C'est la différence entre un
   formulaire qu'on remplit et un formulaire qu'on abandonne. */

function Field({
  label, help, children,
}: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="mt-6 block first:mt-0">
      <span className="text-sm font-medium">{label}</span>
      {help && <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{help}</span>}
      <div className="mt-2">{children}</div>
    </label>
  );
}

function StepHead({ title, lead }: { title: string; lead: string }) {
  return (
    <div className="mb-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{lead}</p>
    </div>
  );
}

function StepCompany({
  company, activity, onChange,
}: { company: string; activity: string; onChange: (p: Partial<Draft>) => void }) {
  return (
    <div>
      <StepHead
        title="Commençons par vous"
        lead="Deux réponses, et votre espace de travail existe. Vos agents liront ce contexte avant chaque tâche."
      />
      <Field label="Nom de l'entreprise" help="Il nomme votre espace de travail et votre premier service.">
        <Input
          autoFocus
          value={company}
          onChange={(e) => onChange({ company: e.target.value })}
          placeholder="Le nom sous lequel on vous connaît"
        />
      </Field>
      <Field
        label="Ce que vous faites"
        help="En une phrase. C'est ce qu'un agent lit en premier pour savoir de quoi il parle."
      >
        <Textarea
          rows={3}
          value={activity}
          onChange={(e) => onChange({ activity: e.target.value })}
          placeholder="Nous aidons les cabinets comptables à automatiser la saisie de pièces."
        />
      </Field>
    </div>
  );
}

function StepAudience({
  icp, tone, onChange,
}: { icp: string; tone: string; onChange: (p: Partial<Draft>) => void }) {
  return (
    <div>
      <StepHead
        title="À qui vous parlez"
        lead="Ce sont les deux champs que vos agents utilisent le plus : ils décident du ton, des exemples et des priorités de tout ce qu'ils écriront."
      />
      <Field label="Votre client type" help="À qui vous vendez, précisément. Plus c'est concret, mieux les agents visent.">
        <Textarea
          autoFocus
          rows={3}
          value={icp}
          onChange={(e) => onChange({ icp: e.target.value })}
          placeholder="Des cabinets de 5 à 30 personnes, en France, déjà équipés d'un logiciel comptable."
        />
      </Field>
      <Field label="Votre ton" help="Comment vous vous adressez à eux — vos agents s'y tiendront.">
        <Textarea
          rows={2}
          value={tone}
          onChange={(e) => onChange({ tone: e.target.value })}
          placeholder="Direct et concret, sans jargon, on vouvoie."
        />
      </Field>
    </div>
  );
}

function StepObjective({
  objective, onChange,
}: { objective: string; onChange: (p: Partial<Draft>) => void }) {
  return (
    <div>
      <StepHead
        title="Qu'est-ce qui compte, ce trimestre ?"
        lead="Un seul objectif suffit pour commencer. Il sert à juger si le travail des agents vous rapproche de quelque chose — sans lui, on mesure de l'activité."
      />
      <Field label="Votre objectif" help="Une phrase. Vous le préciserez (métrique, cible, échéance) dans l'onglet Objectifs.">
        <Textarea
          autoFocus
          rows={3}
          value={objective}
          onChange={(e) => onChange({ objective: e.target.value })}
          placeholder="Diviser par deux le temps de réponse aux demandes entrantes."
        />
      </Field>
    </div>
  );
}

function StepAgent({
  templates, selected, onSelect,
}: {
  templates: (typeof AGENT_TEMPLATES);
  selected?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div>
      <StepHead
        title="Qui embauchez-vous en premier ?"
        lead="Il arrive avec ses instructions et ses outils, et vous l'ajustez ensuite. Le reste du catalogue vous attend dans l'application."
      />
      <div className="grid gap-2 sm:grid-cols-2">
        {templates.map((t) => {
          const active = t.key === selected;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onSelect(t.key)}
              aria-pressed={active}
              className={cn(
                "rounded-xl border p-4 text-left transition-colors",
                active
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card hover:bg-secondary/40",
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{t.name}</span>
                {active && <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t.tagline}</p>
            </button>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Rien ne vous tente ? Passez cette étape — l'assistant de votre service peut créer un agent sur
        mesure à partir d'une simple description.
      </p>
    </div>
  );
}
