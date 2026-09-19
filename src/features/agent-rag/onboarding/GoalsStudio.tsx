import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  TargetIcon as Target,
  PlusIcon as Plus,
  SparkleIcon as Sparkles,
  CircleNotchIcon as Loader2,
  ArrowLeftIcon as ArrowLeft,
  RocketLaunchIcon as Rocket,
  MagicWandIcon as Wand2,
  FlaskIcon as FlaskConical,
  ListChecksIcon as ListChecks,
  PathIcon as RouteIcon,
  FlowArrowIcon as Workflow,
  CheckCircleIcon as CheckCircle2,
  PaperPlaneRightIcon as Send,
  CaretRightIcon as ChevronRight,
  PlayCircleIcon as PlayCircle,
  UsersIcon as Users,
  WarningIcon as AlertTriangle,
  XCircleIcon as XCircle,
  SpeakerHighIcon as Volume2,
  SpeakerXIcon as VolumeX,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useToast } from "@/components/ToastProvider";
import { cn } from "@/lib/utils";
import { AgentPicker } from "./AgentPicker";

interface Goal {
  id: string;
  agent_id: string | null;
  name: string;
  objective: string;
  activation_event: string | null;
  segment: Record<string, unknown>;
  constraints: Record<string, unknown>;
  holdout_pct: number;
  status: "draft" | "active" | "paused" | "archived";
  created_at: string;
}
interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  kind: "flow" | "tour" | "checklist";
  version: number;
  variant: string | null;
  lifecycle_status: "draft" | "live" | "archived";
  generation_meta: { rationale?: string | null; source?: string } | null;
}
interface StepRow {
  id: string; flow_id: string; position: number; title: string; body: string | null;
  page_route: string | null; element_selector: string | null; cta_label: string | null;
}

const KIND_META: Record<FlowRow["kind"], { icon: typeof Workflow; label: string; tint: string }> = {
  flow: { icon: Workflow, label: "Flow", tint: "text-sky-400" },
  tour: { icon: RouteIcon, label: "Tour", tint: "text-violet-400" },
  checklist: { icon: ListChecks, label: "Checklist", tint: "text-emerald-400" },
};

const STATUS_TINT: Record<Goal["status"], string> = {
  draft: "text-muted-foreground",
  active: "text-emerald-400",
  paused: "text-amber-400",
  archived: "text-muted-foreground",
};

/* ============================================================ */
/*  Objectives studio — the generative onboarding landing        */
/* ============================================================ */

export function GoalsStudioPage({ agentId: fixedAgentId }: { agentId?: string } = {}) {
  const { projectId } = useCurrentContext();
  const [params, setParams] = useSearchParams();
  const goalId = params.get("goal");
  // When embedded in an agent's builder the agent is fixed (no picker); the
  // stand-alone page lets the user pick via `AgentPicker`.
  const [pickedAgentId, setPickedAgentId] = useState<string | null>(null);
  const agentId = fixedAgentId ?? pickedAgentId;
  const [wizardOpen, setWizardOpen] = useState(false);

  const { data: goals } = useQuery({
    queryKey: ["onb_goals", projectId, agentId],
    enabled: !!projectId,
    queryFn: async () => {
      let q = supabase.from("onboarding_goals")
        .select("id, agent_id, name, objective, activation_event, segment, constraints, holdout_pct, status, created_at")
        .eq("project_id", projectId!).order("created_at", { ascending: false });
      if (agentId) q = q.eq("agent_id", agentId);
      const { data } = await q;
      return (data ?? []) as Goal[];
    },
  });

  if (goalId) {
    return <GoalDetailView goalId={goalId} onBack={() => { const n = new URLSearchParams(params); n.delete("goal"); setParams(n, { replace: true }); }} />;
  }

  return (
    <div>
      <PageHeader
        title="Objectifs d'activation"
        description="Déclarez un objectif — l'agent compose et optimise le parcours d'onboarding qui y mène."
        actions={
          <div className="flex items-center gap-2">
            {!fixedAgentId && projectId && <AgentPicker projectId={projectId} selectedAgentId={agentId} onSelect={setPickedAgentId} />}
            <Button size="sm" onClick={() => setWizardOpen(true)}><Plus className="h-4 w-4" /> Nouvel objectif</Button>
          </div>
        }
      />

      {(goals ?? []).length === 0 ? (
        <EmptyState
          icon={Target}
          title="Aucun objectif"
          description="Un objectif décrit l'aha-moment à atteindre (ex. « créer son 1er projet + inviter un coéquipier »). L'agent génère le parcours."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(goals ?? []).map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => { const n = new URLSearchParams(params); n.set("goal", g.id); setParams(n, { replace: true }); }}
              className="group text-left"
            >
              <Card className="h-full transition-colors hover:border-primary/40">
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-sm font-semibold">
                      <Target className="h-4 w-4 text-emerald-400" /> {g.name}
                    </span>
                    <Badge variant="outline" className={cn("text-[10px] uppercase", STATUS_TINT[g.status])}>{g.status}</Badge>
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{g.objective}</p>
                  <div className="flex flex-wrap items-center gap-1.5 pt-1 text-[10px] text-muted-foreground">
                    {g.activation_event && <Badge variant="outline" className="font-mono text-[10px]">{g.activation_event}</Badge>}
                    <span className="rounded bg-secondary/50 px-1.5 py-0.5">holdout {g.holdout_pct}%</span>
                    <ChevronRight className="ml-auto h-3.5 w-3.5 opacity-0 transition group-hover:opacity-60" />
                  </div>
                </CardContent>
              </Card>
            </button>
          ))}
        </div>
      )}

      {wizardOpen && (
        <CreateGoalDialog agentId={agentId} onClose={() => setWizardOpen(false)} onCreated={(id) => {
          setWizardOpen(false);
          const n = new URLSearchParams(params); n.set("goal", id); setParams(n, { replace: true });
        }} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ */
/*  Create-goal wizard                                          */
/* ------------------------------------------------------------ */

function CreateGoalDialog({ agentId, onClose, onCreated }: { agentId: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const toast = useToast();
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [activationEvent, setActivationEvent] = useState("");
  const [segment, setSegment] = useState("");
  const [appDescription, setAppDescription] = useState("");
  const [holdout, setHoldout] = useState(10);
  const [saving, setSaving] = useState(false);

  // Suggest declared key-action events for the aha-moment.
  const { data: keyEvents } = useQuery({
    queryKey: ["onb_key_events", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("event_definitions")
        .select("event_name, display_name, is_key_action")
        .eq("project_id", projectId!).order("is_key_action", { ascending: false }).limit(30);
      return (data ?? []) as { event_name: string; display_name: string | null; is_key_action: boolean }[];
    },
  });

  async function save() {
    if (!workspaceId || !projectId || !name.trim() || !objective.trim()) return;
    setSaving(true);
    try {
      const roles = segment.split(",").map((s) => s.trim()).filter(Boolean);
      const { data, error } = await supabase.from("onboarding_goals").insert({
        workspace_id: workspaceId, project_id: projectId, agent_id: agentId,
        name: name.trim(), objective: objective.trim(),
        activation_event: activationEvent.trim() || null,
        segment: roles.length ? { roles } : {},
        constraints: appDescription.trim() ? { app_description: appDescription.trim() } : {},
        holdout_pct: Math.max(0, Math.min(90, holdout)),
        status: "draft",
      }).select("id").single();
      if (error) throw error;
      toast.success("Objectif créé");
      onCreated(data.id);
    } catch (e) {
      toast.error("Création impossible : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nouvel objectif d'activation</DialogTitle>
          <DialogDescription>L'agent générera le parcours à partir de cet objectif et de la carte de votre app.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Nom">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Activation nouvel utilisateur" />
          </Field>
          <Field label="Objectif (langage naturel)">
            <Textarea rows={3} value={objective} onChange={(e) => setObjective(e.target.value)}
              placeholder="Amener un nouvel utilisateur à créer son 1er projet ET inviter ≥1 coéquipier, sous 7 jours." />
          </Field>
          <Field label="Aha-moment (event d'activation)" hint="l'event produit qui compte comme activation">
            <Input list="onb-key-events" value={activationEvent} onChange={(e) => setActivationEvent(e.target.value)} placeholder="project.created" />
            <datalist id="onb-key-events">
              {(keyEvents ?? []).map((k) => <option key={k.event_name} value={k.event_name}>{k.display_name ?? k.event_name}</option>)}
            </datalist>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cible (rôles, séparés par ,)">
              <Input value={segment} onChange={(e) => setSegment(e.target.value)} placeholder="admin, owner" />
            </Field>
            <Field label="Holdout %" hint="témoin sans onboarding">
              <Input type="number" min={0} max={90} value={holdout} onChange={(e) => setHoldout(Number(e.target.value))} />
            </Field>
          </div>
          <Field label="Description de l'app (si pas de scan)" hint="fallback quand le repo n'est pas connecté">
            <Textarea rows={2} value={appDescription} onChange={(e) => setAppDescription(e.target.value)}
              placeholder="Optionnel — décrivez les pages/actions clés si aucun scan de code n'existe." />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={save} disabled={saving || !name.trim() || !objective.trim()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />} Créer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-foreground">{label}{hint && <span className="ml-1 font-normal text-muted-foreground">· {hint}</span>}</span>
      {children}
    </label>
  );
}

/* ------------------------------------------------------------ */
/*  Preview — predicted persona run-through (dry-run)          */
/* ------------------------------------------------------------ */

function PreviewPanel({ preview, onClose }: { preview: PreviewResult; onClose: () => void }) {
  const rate = Math.max(0, Math.min(1, preview.predicted_activation_rate ?? 0));
  return (
    <Card className="border-primary/30">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <PlayCircle className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Simulation (dry-run)</span>
          <Badge variant="outline" className="text-[10px]">prédiction, non publié</Badge>
          <button type="button" onClick={onClose} className="ml-auto text-xs text-muted-foreground hover:text-foreground">Fermer</button>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-xs text-muted-foreground">Activation prédite</div>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
            <div className={cn("h-full rounded-full", rate >= 0.5 ? "bg-[hsl(var(--accent-2))]" : "bg-amber-400")} style={{ width: `${rate * 100}%` }} />
          </div>
          <div className="font-stat-number text-sm font-semibold tabular-nums">{(rate * 100).toFixed(0)}%</div>
        </div>

        {preview.summary && <p className="text-xs text-muted-foreground">{preview.summary}</p>}

        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {(preview.personas ?? []).map((p, i) => (
            <div key={i} className="flex items-start gap-2 rounded-md border border-border p-2 text-xs">
              {p.activated
                ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />}
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Users className="h-3 w-3 text-muted-foreground" />
                  <span className="font-medium">{p.name}</span>
                  <span className="text-[10px] text-muted-foreground">{p.archetype}</span>
                </div>
                <div className="text-muted-foreground">
                  {p.activated ? "Activé" : `Abandon${p.drop_step != null ? ` à l'étape ${p.drop_step + 1}` : ""}`} · {p.friction}
                </div>
              </div>
            </div>
          ))}
        </div>

        {(preview.top_friction ?? []).length > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-amber-500">
              <AlertTriangle className="h-3.5 w-3.5" /> Points de friction
            </div>
            <ul className="list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
              {preview.top_friction.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------ */
/*  Goal detail — generated parcours + agent controls          */
/* ------------------------------------------------------------ */

interface PreviewResult {
  personas: { name: string; archetype: string; activated: boolean; drop_step: number | null; friction: string }[];
  predicted_activation_rate: number;
  top_friction: string[];
  summary: string;
}

function GoalDetailView({ goalId, onBack }: { goalId: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<null | "generate" | "revise" | "publish" | "optimize" | "preview">(null);
  const [instruction, setInstruction] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);

  const { data: goal } = useQuery({
    queryKey: ["onb_goal", goalId],
    queryFn: async () => {
      const { data } = await supabase.from("onboarding_goals")
        .select("id, agent_id, name, objective, activation_event, segment, constraints, holdout_pct, status, created_at")
        .eq("id", goalId).maybeSingle();
      return data as Goal | null;
    },
  });

  // Voice is an agent-level capability (Deepgram); surfaced here for convenience.
  const { data: voiceOn } = useQuery({
    queryKey: ["onb_agent_voice", goal?.agent_id],
    enabled: !!goal?.agent_id,
    queryFn: async () => {
      const { data } = await supabase.from("rag_agents")
        .select("onboarding_voice_enabled").eq("id", goal!.agent_id!).maybeSingle();
      return !!(data as { onboarding_voice_enabled?: boolean } | null)?.onboarding_voice_enabled;
    },
  });
  async function toggleVoice() {
    if (!goal?.agent_id) return;
    const { error } = await supabase.from("rag_agents")
      .update({ onboarding_voice_enabled: !voiceOn }).eq("id", goal.agent_id);
    if (error) { toast.error(error.message); return; }
    toast.success(!voiceOn ? "Voix activée (Deepgram)" : "Voix désactivée");
    queryClient.invalidateQueries({ queryKey: ["onb_agent_voice", goal.agent_id] });
  }

  // Co-pilot: the agent may act in the app on the user's behalf (agent-level).
  const { data: copilotOn } = useQuery({
    queryKey: ["onb_agent_copilot", goal?.agent_id],
    enabled: !!goal?.agent_id,
    queryFn: async () => {
      const { data } = await supabase.from("rag_agents")
        .select("onboarding_copilot_enabled").eq("id", goal!.agent_id!).maybeSingle();
      return !!(data as { onboarding_copilot_enabled?: boolean } | null)?.onboarding_copilot_enabled;
    },
  });
  async function toggleCopilot() {
    if (!goal?.agent_id) return;
    const { error } = await supabase.from("rag_agents")
      .update({ onboarding_copilot_enabled: !copilotOn }).eq("id", goal.agent_id);
    if (error) { toast.error(error.message); return; }
    toast.success(!copilotOn ? "Co-pilote activé — l'agent peut agir" : "Co-pilote désactivé");
    queryClient.invalidateQueries({ queryKey: ["onb_agent_copilot", goal.agent_id] });
  }

  const { data: flows } = useQuery({
    queryKey: ["onb_goal_flows", goalId],
    queryFn: async () => {
      const { data } = await supabase.from("rag_onboarding_flows")
        .select("id, name, description, kind, version, variant, lifecycle_status, generation_meta")
        .eq("goal_id", goalId).order("version", { ascending: false }).order("position");
      return (data ?? []) as FlowRow[];
    },
    refetchOnWindowFocus: false,
  });

  // Latest version = the parcours we display (draft if unpublished, else live).
  const latestVersion = useMemo(() => (flows ?? []).reduce((m, f) => Math.max(m, f.version), 0), [flows]);
  const shownFlows = useMemo(() => (flows ?? []).filter((f) => f.version === latestVersion), [flows, latestVersion]);
  const shownLifecycle = shownFlows[0]?.lifecycle_status;
  const rationale = shownFlows[0]?.generation_meta?.rationale;

  const { data: steps } = useQuery({
    queryKey: ["onb_goal_steps", goalId, latestVersion, shownFlows.map((f) => f.id).join(",")],
    enabled: shownFlows.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("rag_onboarding_steps")
        .select("id, flow_id, position, title, body, page_route, element_selector, cta_label")
        .in("flow_id", shownFlows.map((f) => f.id)).order("position");
      return (data ?? []) as StepRow[];
    },
  });

  async function run(action: "generate" | "revise" | "publish" | "optimize") {
    setBusy(action);
    try {
      const payload: Record<string, unknown> = { action, goal_id: goalId };
      if (action === "revise") payload.instruction = instruction.trim();
      if (action === "publish") payload.version = latestVersion;
      const res = await callEdge<{ error?: string; detail?: string; hypothesis?: string }>("onboarding-engine", payload);
      if (res.error) {
        toast.error(res.detail || res.error);
      } else {
        if (action === "generate") toast.success("Parcours généré");
        if (action === "revise") { toast.success("Parcours révisé"); setInstruction(""); }
        if (action === "publish") toast.success("Onboarding publié");
        if (action === "optimize") toast.success("Expérience A/B lancée : " + (res.hypothesis ?? ""));
      }
      if (action === "generate" || action === "revise") setPreview(null); // stale once the parcours changes
      await queryClient.invalidateQueries({ queryKey: ["onb_goal_flows", goalId] });
      await queryClient.invalidateQueries({ queryKey: ["onb_goal", goalId] });
    } catch (e) {
      toast.error("Échec : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }

  async function runPreview() {
    setBusy("preview");
    try {
      const res = await callEdge<{ error?: string; detail?: string } & PreviewResult>(
        "onboarding-engine", { action: "preview", goal_id: goalId },
      );
      if (res.error) toast.error(res.detail || res.error);
      else setPreview(res);
    } catch (e) {
      toast.error("Échec : " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }

  const hasParcours = shownFlows.length > 0;

  return (
    <div>
      <PageHeader
        title={goal?.name ?? "Objectif"}
        description={goal?.objective}
        actions={<Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Objectifs</Button>}
      />

      {/* Meta + agent controls */}
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {goal?.activation_event && <Badge variant="outline" className="font-mono">{goal.activation_event}</Badge>}
            <span className="rounded bg-secondary/50 px-1.5 py-0.5 text-muted-foreground">holdout {goal?.holdout_pct}%</span>
            {goal?.agent_id && (
              <button
                type="button"
                onClick={toggleVoice}
                title="Voix live (Deepgram) — l'agent parle et écoute l'utilisateur"
                className={cn(
                  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
                  voiceOn ? "bg-emerald-500/10 text-emerald-400" : "bg-secondary/50 text-muted-foreground hover:text-foreground",
                )}
              >
                {voiceOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />} Voix
              </button>
            )}
            {goal?.agent_id && (
              <button
                type="button"
                onClick={toggleCopilot}
                title="Co-pilote — l'agent agit à la place de l'utilisateur (clique/remplit/soumet). Jamais d'action destructive."
                className={cn(
                  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
                  copilotOn ? "bg-emerald-500/10 text-emerald-400" : "bg-secondary/50 text-muted-foreground hover:text-foreground",
                )}
              >
                <Wand2 className="h-3.5 w-3.5" /> Co-pilote
              </button>
            )}
            {hasParcours && (
              <Badge variant={shownLifecycle === "live" ? "success" : "outline"}>
                v{latestVersion} · {shownLifecycle}
              </Badge>
            )}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button size="sm" variant={hasParcours ? "outline" : "default"} onClick={() => run("generate")} disabled={busy !== null}>
              {busy === "generate" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {hasParcours ? "Régénérer" : "Générer le parcours"}
            </Button>
            {hasParcours && (
              <Button size="sm" variant="outline" onClick={runPreview} disabled={busy !== null}>
                {busy === "preview" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />} Simuler
              </Button>
            )}
            {hasParcours && shownLifecycle !== "live" && (
              <Button size="sm" onClick={() => run("publish")} disabled={busy !== null}>
                {busy === "publish" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />} Publier
              </Button>
            )}
            {hasParcours && shownLifecycle === "live" && (
              <Button size="sm" variant="outline" onClick={() => run("optimize")} disabled={busy !== null}>
                {busy === "optimize" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />} Optimiser (A/B)
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {!hasParcours ? (
        <EmptyState
          icon={Wand2}
          title="Pas encore de parcours"
          description="Cliquez « Générer le parcours » — l'agent lit la carte de votre app et compose flows, tours et checklist pour atteindre l'objectif."
        />
      ) : (
        <div className="space-y-4">
          {rationale && (
            <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs">
              <span className="font-medium text-foreground">Raisonnement de l'agent : </span>{rationale}
            </div>
          )}

          {preview && <PreviewPanel preview={preview} onClose={() => setPreview(null)} />}

          {/* Generated artefacts */}
          <div className="space-y-3">
            {shownFlows.map((f) => {
              const Meta = KIND_META[f.kind];
              const fSteps = (steps ?? []).filter((s) => s.flow_id === f.id);
              return (
                <Card key={f.id}>
                  <CardContent className="p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <Meta.icon className={cn("h-4 w-4", Meta.tint)} />
                      <span className="text-sm font-semibold">{f.name}</span>
                      <Badge variant="outline" className="text-[10px] uppercase">{Meta.label}</Badge>
                      {f.variant && <Badge variant="outline" className="text-[10px]">variant {f.variant}</Badge>}
                    </div>
                    {f.description && <p className="mb-3 text-xs text-muted-foreground">{f.description}</p>}
                    <ol className="space-y-2">
                      {fSteps.map((s, i) => (
                        <li key={s.id} className="flex gap-2.5 text-sm">
                          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] tabular-nums text-muted-foreground">{i + 1}</span>
                          <div className="min-w-0">
                            <div className="font-medium">{s.title}</div>
                            {s.body && <div className="text-xs text-muted-foreground">{s.body}</div>}
                            <div className="mt-0.5 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                              {s.page_route && <span className="rounded bg-secondary/50 px-1.5 py-0.5 font-mono">{s.page_route}</span>}
                              {s.element_selector && <span className="rounded bg-secondary/50 px-1.5 py-0.5 font-mono">{s.element_selector}</span>}
                              {s.cta_label && <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />{s.cta_label}</span>}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Conversational revision */}
          <Card>
            <CardContent className="p-3">
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => { e.preventDefault(); if (instruction.trim() && busy === null) run("revise"); }}
              >
                <Wand2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Input
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder="Demande une modification… (ex. « enlève l'étape settings », « ajoute une célébration à la fin »)"
                  className="border-0 bg-transparent focus-visible:ring-0"
                />
                <Button type="submit" size="sm" disabled={!instruction.trim() || busy !== null}>
                  {busy === "revise" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
