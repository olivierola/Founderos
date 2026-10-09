import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LightningIcon, PlusIcon, TrashIcon, PauseIcon, PlayIcon, ArrowsClockwiseIcon, ScalesIcon,
  CircleNotchIcon as Loader2,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { BrandLogo } from "@/components/BrandLogo";
import { useToast } from "@/components/ToastProvider";
import { useConfirm } from "@/components/ConfirmProvider";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { type InternalAgent } from "@/features/internal-agents/shared";
import { KNOWN_EVENTS } from "@/features/workflows/EventTriggers";
import { formatRelative } from "@/features/tracker/pickers";

/**
 * « Quand… alors » : ce qui met le collaborateur au travail sans qu'on le lui
 * demande (0268).
 *
 * Même registre et même routage que les déclencheurs des workflows (0198) :
 * l'abonnement à l'application, le journal qui évite de traiter deux fois le
 * même événement, le filtre évalué AVANT de lancer quoi que ce soit (par Jev
 * quand il est actif). Ce qui change, c'est la cible : un collaborateur, avec la
 * consigne de ce qu'il doit faire. Chaque déclencheur porte sa propre mission ;
 * chaque événement en lance une exécution, l'événement joint.
 */

/** Events the app emits itself (0268 database triggers) — no subscription. */
export const INTERNAL_EVENTS: { slug: string; label: string; hint: string }[] = [
  { slug: "CRM_RECORD_CREATED", label: "Nouvel enregistrement CRM", hint: "un contact, une entreprise, un deal… créé dans le CRM" },
  { slug: "WORK_ITEM_CREATED", label: "Nouveau work item", hint: "une tâche créée dans le module Travail" },
  { slug: "SUPPORT_TICKET_CREATED", label: "Nouvelle demande client", hint: "une conversation du widget public devenue demande" },
];

export function eventLabel(provider: string, slug: string): string {
  if (provider === "founderos") return INTERNAL_EVENTS.find((e) => e.slug === slug)?.label ?? slug;
  const known = (KNOWN_EVENTS[provider] ?? []).find((e) => e.slug === slug);
  return known?.label ?? slug.replace(/_/g, " ").toLowerCase();
}

interface AgentTrigger {
  id: string; provider: string; event_slug: string; filter: string | null; label: string | null;
  status: "pending" | "active" | "paused" | "error"; status_detail: string | null;
  last_event_at: string | null; hourly_cap: number; mission_id: string | null;
}

interface Delivery {
  id: string; trigger_id: string; outcome: "started" | "filtered" | "skipped" | "failed";
  detail: string | null; received_at: string;
}

const OUTCOME: Record<Delivery["outcome"], { label: string; dot: string }> = {
  started: { label: "lancé", dot: "bg-emerald-500" },
  filtered: { label: "filtré", dot: "bg-muted-foreground/60" },
  skipped: { label: "ignoré", dot: "bg-amber-500" },
  failed: { label: "échec", dot: "bg-red-500" },
};

export function AgentEventTriggers({ agent }: { agent: InternalAgent }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);

  const { data: triggers, isLoading } = useQuery({
    queryKey: ["agent_triggers", agent.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("agent_workflow_triggers")
        .select("id, provider, event_slug, filter, label, status, status_detail, last_event_at, hourly_cap, mission_id")
        .eq("agent_id", agent.id).order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as AgentTrigger[];
    },
  });
  const { data: deliveries } = useQuery({
    queryKey: ["agent_trigger_deliveries", agent.id],
    enabled: (triggers ?? []).length > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const { data } = await supabase.from("workflow_event_deliveries")
        .select("id, trigger_id, outcome, detail, received_at")
        .eq("agent_id", agent.id).order("received_at", { ascending: false }).limit(12);
      return (data ?? []) as Delivery[];
    },
  });
  const { data: connectors } = useQuery({
    queryKey: ["agent_trigger_connectors", agent.project_id],
    queryFn: async () => {
      const { data } = await supabase.from("connectors").select("provider")
        .eq("project_id", agent.project_id).eq("source", "composio").eq("status", "connected");
      return [...new Set(((data ?? []) as Array<{ provider: string }>).map((c) => c.provider))].sort();
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["agent_triggers", agent.id] });
    qc.invalidateQueries({ queryKey: ["agent_trigger_deliveries", agent.id] });
    qc.invalidateQueries({ queryKey: ["agent_tasks", agent.id] });
  };

  async function setPaused(t: AgentTrigger, paused: boolean) {
    const { error } = await supabase.from("agent_workflow_triggers")
      .update({ status: paused ? "paused" : "active", updated_at: new Date().toISOString() }).eq("id", t.id);
    if (error) { toast.error("Changement impossible", error.message); return; }
    // Resuming an app event re-subscribes upstream: the subscription may have
    // lapsed while it was paused.
    if (!paused && t.provider !== "founderos") await callEdge("run-workflow", { action: "sync_trigger", trigger_id: t.id }).catch(() => {});
    invalidate();
  }

  async function remove(t: AgentTrigger) {
    if (!(await confirm({
      title: "Supprimer ce déclencheur ?",
      description: `${agent.name} ne réagira plus à « ${t.label || eventLabel(t.provider, t.event_slug)} ». Sa mission est archivée avec lui.`,
      confirmText: "Supprimer",
    }))) return;
    try {
      await callEdge("run-workflow", { action: "remove_trigger", trigger_id: t.id });
      invalidate();
    } catch (e) {
      toast.error("Suppression impossible", e instanceof Error ? e.message : String(e));
    }
  }

  async function retry(t: AgentTrigger) {
    await callEdge("run-workflow", { action: "sync_trigger", trigger_id: t.id }).catch(() => {});
    invalidate();
  }

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Déclencheurs</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Quand quelque chose se passe, {agent.name} s'y met seul, avec la consigne que vous lui laissez.
          </p>
        </div>
        {!adding && (
          <Button size="sm" className="shrink-0 rounded-full" onClick={() => setAdding(true)}>
            <PlusIcon className="mr-1.5 h-3.5 w-3.5" /> Nouveau déclencheur
          </Button>
        )}
      </div>

      {adding && (
        <AddTriggerForm
          agent={agent}
          connectors={connectors ?? []}
          onCancel={() => setAdding(false)}
          onCreated={() => { setAdding(false); invalidate(); }}
        />
      )}

      {isLoading ? (
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (triggers ?? []).length === 0 && !adding ? (
        <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-12 text-muted-foreground">
          Aucun déclencheur. Par exemple : quand une demande client arrive, la qualifier et proposer une réponse ;
          quand un lead entre dans le CRM, l'enrichir.
        </p>
      ) : (
        <ul className="space-y-2">
          {(triggers ?? []).map((t) => {
            const last = (deliveries ?? []).filter((d) => d.trigger_id === t.id).slice(0, 3);
            return (
              <li key={t.id} className={cn("rounded-xl border bg-card p-3.5", t.status === "error" ? "border-red-500/30" : "border-border/70")}>
                <div className="flex items-start gap-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted">
                    {t.provider === "founderos"
                      ? <LightningIcon weight="fill" className="h-4 w-4 text-amber-500" />
                      : <BrandLogo slug={t.provider} className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-13 font-medium">{t.label || `Quand : ${eventLabel(t.provider, t.event_slug)}`}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-11 text-muted-foreground">
                      <span>{t.provider === "founderos" ? "Application" : t.provider} · {eventLabel(t.provider, t.event_slug)}</span>
                      <span className={cn(
                        "font-medium",
                        t.status === "active" ? "text-emerald-600" : t.status === "error" ? "text-red-600" : "text-amber-600",
                      )}>
                        {t.status === "active" ? "à l'écoute" : t.status === "paused" ? "en pause" : t.status === "error" ? "erreur" : "en attente"}
                      </span>
                      {t.last_event_at && <span>dernier événement {formatRelative(t.last_event_at)}</span>}
                      <span>max {t.hourly_cap}/h</span>
                    </div>
                    {t.filter && (
                      <p className="mt-1.5 text-12 text-muted-foreground"><span className="font-medium text-foreground">Seulement si</span> {t.filter}</p>
                    )}
                    {t.status_detail && <p className="mt-1.5 text-12 text-red-600">{t.status_detail}</p>}
                    {last.length > 0 && (
                      <ul className="mt-2 space-y-0.5">
                        {last.map((d) => (
                          <li key={d.id} className="flex items-start gap-1.5 text-11 text-muted-foreground">
                            <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", OUTCOME[d.outcome].dot)} />
                            <span className="min-w-0 flex-1">
                              <span className="font-medium text-foreground">{OUTCOME[d.outcome].label}</span>
                              {d.detail ? `, ${d.detail}` : ""} · {formatRelative(d.received_at)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {t.status === "error" && (
                      <button type="button" onClick={() => void retry(t)} title="Réessayer l'abonnement" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                        <ArrowsClockwiseIcon className="h-4 w-4" />
                      </button>
                    )}
                    {(t.status === "active" || t.status === "paused") && (
                      <button
                        type="button" onClick={() => void setPaused(t, t.status === "active")}
                        title={t.status === "active" ? "Mettre en pause" : "Reprendre"}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        {t.status === "active" ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
                      </button>
                    )}
                    <button type="button" onClick={() => void remove(t)} title="Supprimer" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive">
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function AddTriggerForm({ agent, connectors, onCancel, onCreated }: {
  agent: InternalAgent; connectors: string[]; onCancel: () => void; onCreated: () => void;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const [source, setSource] = useState<string>("founderos");
  const [event, setEvent] = useState<string>(INTERNAL_EVENTS[0].slug);
  const [customSlug, setCustomSlug] = useState("");
  const [filter, setFilter] = useState("");
  const [instruction, setInstruction] = useState("");
  const [cap, setCap] = useState(20);
  const [saving, setSaving] = useState(false);

  const appEvents = source === "founderos" ? [] : (KNOWN_EVENTS[source] ?? []);
  const slug = source === "founderos" ? event : (event === "__custom" ? customSlug.trim() : event);

  function pickSource(next: string) {
    setSource(next);
    setEvent(next === "founderos" ? INTERNAL_EVENTS[0].slug : (KNOWN_EVENTS[next]?.[0]?.slug ?? "__custom"));
  }

  async function save() {
    if (!slug || !instruction.trim() || !user) return;
    setSaving(true);
    try {
      const label = `Quand : ${eventLabel(source, slug)}`;
      // The mission the trigger runs: one per trigger, reused by every event.
      // Active but unscheduled, so nothing but an event ever starts it.
      const { data: mission, error: mErr } = await supabase.from("internal_agent_missions").insert({
        agent_id: agent.id, workspace_id: agent.workspace_id, project_id: agent.project_id,
        title: label, brief: instruction.trim(), status: "active", board_column: "todo", created_by: user.id,
      }).select("id").single();
      if (mErr || !mission) throw new Error(mErr?.message ?? "Mission impossible à créer");
      const { data: trig, error: tErr } = await supabase.from("agent_workflow_triggers").insert({
        agent_id: agent.id, mission_id: (mission as { id: string }).id,
        workspace_id: agent.workspace_id, project_id: agent.project_id,
        provider: source, event_slug: slug, filter: filter.trim() || null, label,
        hourly_cap: Math.min(500, Math.max(1, cap)), created_by: user.id,
      }).select("id").single();
      if (tErr || !trig) throw new Error(tErr?.message ?? "Déclencheur impossible à créer");
      await callEdge("run-workflow", { action: "sync_trigger", trigger_id: (trig as { id: string }).id });
      toast.success("Déclencheur créé", `${agent.name} réagira à « ${eventLabel(source, slug)} ».`);
      onCreated();
    } catch (e) {
      toast.error("Création impossible", e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const field = "w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-13 focus:outline-none focus:ring-2 focus:ring-ring/20";

  return (
    <div className="mb-4 space-y-3.5 rounded-xl border border-primary/30 bg-primary/[0.03] p-4">
      <div>
        <div className="mb-1.5 text-12 font-medium">Quand</div>
        <div className="flex flex-wrap gap-1.5">
          {["founderos", ...connectors].map((p) => (
            <button
              key={p} type="button" onClick={() => pickSource(p)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-12 transition-colors",
                source === p ? "border-primary/50 bg-primary/10 font-medium" : "border-border hover:bg-muted",
              )}
            >
              {p === "founderos" ? <LightningIcon weight="fill" className="h-3.5 w-3.5 text-amber-500" /> : <BrandLogo slug={p} className="h-3.5 w-3.5" />}
              {p === "founderos" ? "Dans l'application" : p}
            </button>
          ))}
        </div>
        {connectors.length === 0 && (
          <p className="mt-1.5 text-11 text-muted-foreground">Connectez une application (Gmail, Slack, HubSpot…) dans Ressources → Connexions pour réagir à ses événements.</p>
        )}
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <select value={event} onChange={(e) => setEvent(e.target.value)} className={field} aria-label="Événement">
            {source === "founderos"
              ? INTERNAL_EVENTS.map((e) => <option key={e.slug} value={e.slug}>{e.label}</option>)
              : [...appEvents.map((e) => <option key={e.slug} value={e.slug}>{e.label}</option>),
                <option key="__custom" value="__custom">Autre événement (identifiant)…</option>]}
          </select>
          {source !== "founderos" && event === "__custom" && (
            <input value={customSlug} onChange={(e) => setCustomSlug(e.target.value)} placeholder="ex. HUBSPOT_DEAL_STAGE_CHANGED" className={field} />
          )}
          {source === "founderos" && (
            <p className="self-center text-11 text-muted-foreground">{INTERNAL_EVENTS.find((e) => e.slug === event)?.hint}</p>
          )}
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-12 font-medium">
          Seulement si <span className="font-normal text-muted-foreground">(facultatif)</span>
        </div>
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} className={field}
          placeholder="ex. l'expéditeur est un client existant · le deal dépasse 10 000 €"
        />
        <p className="mt-1 flex items-center gap-1 text-11 text-muted-foreground">
          <ScalesIcon className="h-3 w-3" /> Jugé avant de lancer quoi que ce soit, par Jev quand il est actif.
        </p>
      </div>

      <div>
        <div className="mb-1.5 text-12 font-medium">Alors {agent.name} doit</div>
        <textarea
          value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} className={cn(field, "resize-y")}
          placeholder="ex. Qualifier la demande, chercher le client dans le CRM et préparer une réponse à valider."
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-12 text-muted-foreground">
          Au plus
          <input
            type="number" min={1} max={500} value={cap} onChange={(e) => setCap(Number(e.target.value) || 1)}
            className="w-16 rounded-md border border-border bg-background px-2 py-1 text-12"
          />
          exécutions par heure
        </label>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
          <Button size="sm" disabled={saving || !slug || !instruction.trim()} onClick={() => void save()}>
            {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Créer le déclencheur
          </Button>
        </div>
      </div>
    </div>
  );
}
