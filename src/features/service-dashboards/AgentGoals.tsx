import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  TargetIcon, PlusIcon, TrendUpIcon, TrendDownIcon, EqualsIcon, CircleNotchIcon as Loader2,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ToastProvider";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { type InternalAgent } from "@/features/internal-agents/shared";
import { formatRelative } from "@/features/tracker/pickers";
import { firstOccurrenceLocal, toAlignment, type Cadenced } from "./scheduleCadence";

/**
 * Objectifs permanents : un résultat à tenir, pas une tâche à finir (0269).
 *
 * Un objectif de l'entreprise (company_objectives) porté par ce collaborateur,
 * avec une VEILLE : une cadence et une consigne. À chaque passage, il mesure avec
 * ses outils et enregistre la mesure ; c'est le code qui dit si l'objectif est
 * tenu, et un écart arrive dans « À valider » pendant que le collaborateur agit
 * dans les limites de son autonomie.
 */

type WatchCadence = "hourly" | "daily" | "weekly";

interface Goal {
  id: string; title: string; detail: string | null; metric: string | null; unit: string | null;
  target_value: number | null; current_value: number | null; direction: "increase" | "decrease" | "maintain";
  status: string; measured_at: string | null; measured_by: string | null; measured_note: string | null;
  watch_cadence: WatchCadence | null; watch_mission_id: string | null; watch_instructions: string | null;
}

const CADENCE_LABEL: Record<WatchCadence, string> = { hourly: "Chaque heure", daily: "Chaque jour", weekly: "Chaque semaine" };
const DIRECTION_META = {
  increase: { label: "au moins", icon: TrendUpIcon },
  decrease: { label: "au plus", icon: TrendDownIcon },
  maintain: { label: "autour de", icon: EqualsIcon },
} as const;

/** The watch mission's brief: what to measure, how to record it, what to do. */
function watchBrief(g: Pick<Goal, "id" | "title" | "metric" | "unit" | "target_value" | "direction" | "watch_instructions">): string {
  const unit = g.unit ? ` ${g.unit}` : "";
  const target = g.target_value != null ? `${DIRECTION_META[g.direction].label} ${g.target_value}${unit}` : "(cible non chiffrée)";
  return [
    `Objectif permanent : ${g.title}.`,
    `Mesure : ${g.metric ?? "la valeur de l'objectif"}, cible ${target}.`,
    g.watch_instructions ? `\nConsigne de l'équipe :\n${g.watch_instructions}` : "",
    "",
    "À chaque passage :",
    "1. Mesure la valeur actuelle avec tes outils (sources réelles uniquement, jamais une estimation).",
    `2. Enregistre-la : company_objectives(action="measure", objective_id="${g.id}", value=<nombre>, note=<d'où vient le chiffre>).`,
    "3. Si l'outil répond ÉCART : agis pour ramener l'objectif dans les limites de ton autonomie, ou dépose les actions nécessaires avec propose_mission.",
    "4. Si l'outil répond TENU : termine en une phrase, sans livrable.",
  ].filter((l) => l !== "").join("\n");
}

function scheduleFor(cadence: WatchCadence) {
  // Daily and weekly watches land at 8:00 local on a weekday morning: a gap is
  // read when the day starts, not at midnight.
  const sel: Cadenced = { cadence, minute: cadence === "hourly" ? 5 : 0, hour: 8, dow: 1, dom: 1 };
  const occ = firstOccurrenceLocal(sel);
  return { schedule: cadence, ...toAlignment(sel, occ), next_run_at: occ.toISOString() };
}

export function AgentGoals({ agent }: { agent: InternalAgent }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const [adding, setAdding] = useState(false);

  const { data: goals, isLoading } = useQuery({
    queryKey: ["agent_goals", agent.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("company_objectives")
        .select("id, title, detail, metric, unit, target_value, current_value, direction, status, measured_at, measured_by, measured_note, watch_cadence, watch_mission_id, watch_instructions")
        .eq("owner_agent_id", agent.id).in("status", ["active", "at_risk", "draft"])
        .order("priority", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as Goal[];
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["agent_goals", agent.id] });
    qc.invalidateQueries({ queryKey: ["agent_tasks", agent.id] });
    qc.invalidateQueries({ queryKey: ["sd_inbox"] });
  };

  /** Turn the watch on, change its cadence, or turn it off. */
  async function setWatch(g: Goal, cadence: WatchCadence | null) {
    try {
      let missionId = g.watch_mission_id;
      if (cadence) {
        const fields = {
          title: `Veille : ${g.title}`, brief: watchBrief(g), status: "active" as const,
          ...scheduleFor(cadence), updated_at: new Date().toISOString(),
        };
        if (missionId) {
          const { error } = await supabase.from("internal_agent_missions").update(fields).eq("id", missionId);
          if (error) throw new Error(error.message);
        } else {
          const { data, error } = await supabase.from("internal_agent_missions").insert({
            ...fields, agent_id: agent.id, workspace_id: agent.workspace_id, project_id: agent.project_id,
            board_column: "todo", created_by: user?.id ?? null,
          }).select("id").single();
          if (error || !data) throw new Error(error?.message ?? "Mission impossible à créer");
          missionId = (data as { id: string }).id;
        }
      } else if (missionId) {
        const { error } = await supabase.from("internal_agent_missions").update({ status: "archived", updated_at: new Date().toISOString() }).eq("id", missionId);
        if (error) throw new Error(error.message);
        missionId = null;
      }
      const { error } = await supabase.from("company_objectives")
        .update({ watch_cadence: cadence, watch_mission_id: missionId, updated_at: new Date().toISOString() }).eq("id", g.id);
      if (error) throw new Error(error.message);
      invalidate();
      toast.success(cadence ? `Veille : ${CADENCE_LABEL[cadence].toLowerCase()}` : "Veille arrêtée", g.title);
    } catch (e) {
      toast.error("Changement impossible", e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Objectifs permanents</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Un résultat que {agent.name} doit tenir. Il le mesure à la cadence choisie et agit quand il décroche.
          </p>
        </div>
        {!adding && (
          <Button size="sm" variant="outline" className="shrink-0 rounded-full" onClick={() => setAdding(true)}>
            <PlusIcon className="mr-1.5 h-3.5 w-3.5" /> Nouvel objectif
          </Button>
        )}
      </div>

      {adding && <AddGoalForm agent={agent} onCancel={() => setAdding(false)} onCreated={() => { setAdding(false); invalidate(); }} />}

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (goals ?? []).length === 0 && !adding ? (
        <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-12 text-muted-foreground">
          Aucun objectif porté par {agent.name}. Par exemple : au moins 20 leads qualifiés dans le pipeline, au plus 4 h de délai de réponse au support.
        </p>
      ) : (
        <ul className="space-y-2">
          {(goals ?? []).map((g) => {
            const D = DIRECTION_META[g.direction] ?? DIRECTION_META.increase;
            const unit = g.unit ? ` ${g.unit}` : "";
            const state = g.measured_at == null ? "never" : g.status === "at_risk" ? "off" : "on";
            const pct = g.target_value && g.current_value != null && g.direction !== "decrease"
              ? Math.max(0, Math.min(100, Math.round((g.current_value / g.target_value) * 100))) : null;
            return (
              <li key={g.id} className={cn("rounded-xl border bg-card p-3.5", state === "off" ? "border-amber-500/40" : "border-border/70")}>
                <div className="flex items-start gap-3">
                  <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", state === "off" ? "bg-amber-500/10 text-amber-600" : state === "on" ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground")}>
                    <TargetIcon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-13 font-medium">{g.title}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-12 text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <D.icon className="h-3.5 w-3.5" />
                        {g.metric ?? "Valeur"} {D.label} {g.target_value ?? "?"}{unit}
                      </span>
                      <span className={cn("font-medium", state === "off" ? "text-amber-700 dark:text-amber-400" : state === "on" ? "text-emerald-700 dark:text-emerald-400" : "")}>
                        {state === "never" ? "jamais mesuré" : `${g.current_value}${unit} · ${state === "off" ? "en écart" : "tenu"}`}
                      </span>
                      {g.measured_at && <span>mesuré {formatRelative(g.measured_at)}{g.measured_by === "agent" ? " par le collaborateur" : ""}</span>}
                    </div>
                    {pct != null && (
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className={cn("h-full rounded-full", state === "off" ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${pct}%` }} />
                      </div>
                    )}
                    {g.measured_note && <p className="mt-1.5 line-clamp-2 text-11 text-muted-foreground">{g.measured_note}</p>}
                  </div>
                  <select
                    value={g.watch_cadence ?? ""} onChange={(e) => void setWatch(g, (e.target.value || null) as WatchCadence | null)}
                    aria-label="Cadence de veille"
                    className="shrink-0 rounded-lg border border-border bg-background px-2 py-1 text-12"
                  >
                    <option value="">Pas de veille</option>
                    {(Object.keys(CADENCE_LABEL) as WatchCadence[]).map((c) => <option key={c} value={c}>{CADENCE_LABEL[c]}</option>)}
                  </select>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function AddGoalForm({ agent, onCancel, onCreated }: { agent: InternalAgent; onCancel: () => void; onCreated: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [title, setTitle] = useState("");
  const [metric, setMetric] = useState("");
  const [unit, setUnit] = useState("");
  const [target, setTarget] = useState("");
  const [direction, setDirection] = useState<Goal["direction"]>("increase");
  const [instructions, setInstructions] = useState("");
  const [cadence, setCadence] = useState<WatchCadence | "">("daily");
  const [saving, setSaving] = useState(false);
  const field = "w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-13 focus:outline-none focus:ring-2 focus:ring-ring/20";
  const targetNum = Number(target.replace(",", "."));

  async function save() {
    if (!title.trim() || !metric.trim() || !Number.isFinite(targetNum) || target.trim() === "") return;
    setSaving(true);
    try {
      const { data: obj, error } = await supabase.from("company_objectives").insert({
        workspace_id: agent.workspace_id, project_id: agent.project_id,
        title: title.trim(), metric: metric.trim(), unit: unit.trim() || null,
        target_value: targetNum, direction, status: "active", priority: 3,
        owner_agent_id: agent.id,
        owner_dashboard_id: (agent as { service_dashboard_id?: string | null }).service_dashboard_id ?? null,
        watch_instructions: instructions.trim() || null, created_by: user?.id ?? null,
      }).select("id").single();
      if (error || !obj) throw new Error(error?.message ?? "Objectif impossible à créer");
      const id = (obj as { id: string }).id;
      if (cadence) {
        const goal = { id, title: title.trim(), metric: metric.trim(), unit: unit.trim() || null, target_value: targetNum, direction, watch_instructions: instructions.trim() || null };
        const { data: m, error: mErr } = await supabase.from("internal_agent_missions").insert({
          agent_id: agent.id, workspace_id: agent.workspace_id, project_id: agent.project_id,
          title: `Veille : ${goal.title}`, brief: watchBrief(goal), status: "active", board_column: "todo",
          ...scheduleFor(cadence), created_by: user?.id ?? null,
        }).select("id").single();
        if (mErr || !m) throw new Error(mErr?.message ?? "Veille impossible à créer");
        await supabase.from("company_objectives").update({ watch_cadence: cadence, watch_mission_id: (m as { id: string }).id }).eq("id", id);
      }
      toast.success("Objectif créé", cadence ? `${agent.name} le mesurera ${CADENCE_LABEL[cadence].toLowerCase()}.` : undefined);
      onCreated();
    } catch (e) {
      toast.error("Création impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 space-y-3 rounded-xl border border-primary/30 bg-primary/[0.03] p-4">
      <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} placeholder="L'objectif, en une phrase (ex. Un pipeline toujours alimenté)" />
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_110px_90px]">
        <input value={metric} onChange={(e) => setMetric(e.target.value)} className={field} placeholder="Ce qu'on mesure (ex. leads qualifiés ouverts)" />
        <select value={direction} onChange={(e) => setDirection(e.target.value as Goal["direction"])} className={field} aria-label="Sens">
          <option value="increase">au moins</option>
          <option value="decrease">au plus</option>
          <option value="maintain">autour de</option>
        </select>
        <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" className={field} placeholder="Cible" />
        <input value={unit} onChange={(e) => setUnit(e.target.value)} className={field} placeholder="Unité" />
      </div>
      <textarea
        value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={2} className={cn(field, "resize-y")}
        placeholder="Comment le mesurer et quoi faire en cas d'écart (ex. compter les deals au stade « qualifié » dans le CRM ; si moins de 20, relancer les leads froids)"
      />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-12 text-muted-foreground">
          Veille
          <select value={cadence} onChange={(e) => setCadence(e.target.value as WatchCadence | "")} className="rounded-md border border-border bg-background px-2 py-1 text-12">
            <option value="">aucune</option>
            {(Object.keys(CADENCE_LABEL) as WatchCadence[]).map((c) => <option key={c} value={c}>{CADENCE_LABEL[c].toLowerCase()}</option>)}
          </select>
        </label>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
          <Button size="sm" disabled={saving || !title.trim() || !metric.trim() || target.trim() === "" || !Number.isFinite(targetNum)} onClick={() => void save()}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Créer l'objectif
          </Button>
        </div>
      </div>
    </div>
  );
}
