import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  EyeIcon, LightbulbIcon, HandshakeIcon, RocketLaunchIcon, ShieldCheckIcon, ScalesIcon,
  CheckCircleIcon, WarningIcon, ProhibitIcon, TrashIcon, SealCheckIcon,
  CircleNotchIcon as Loader2,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ToastProvider";
import { useConfirm } from "@/components/ConfirmProvider";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { type InternalAgent } from "@/features/internal-agents/shared";
import { formatRelative } from "@/features/tracker/pickers";
import { actionLabel } from "./CollaboratorInbox";

/**
 * « Autonomie » : ce que le collaborateur peut faire seul.
 *
 * Le niveau ne décide rien tout seul : PolicyGuard note le risque de chaque
 * action avec Jev (0 lecture → 3 irréversible), confronte la note à la grille de
 * l'équipe, puis applique le niveau (0266). Cette page montre donc les trois
 * choses à la fois — le niveau, ce que la grille de l'équipe en fait concrètement,
 * et l'état du jugement Jev dont dépendent « Autonome » et la confiance acquise.
 */

export type AutonomyLevel = "observer" | "propose" | "assisted" | "autonomous";

export const AUTONOMY_META: Record<AutonomyLevel, { label: string; short: string; icon: PhosphorIcon; desc: string }> = {
  observer: {
    label: "Observateur", short: "Observe", icon: EyeIcon,
    desc: "Lit, analyse et rédige des livrables. N'écrit jamais dans vos outils connectés (CRM, e-mail, intégrations, suivi).",
  },
  propose: {
    label: "Proposer", short: "Propose", icon: LightbulbIcon,
    desc: "Prépare chaque action et vous la soumet. Rien ne part dans vos outils sans votre validation.",
  },
  assisted: {
    label: "Assisté", short: "Assisté", icon: HandshakeIcon,
    desc: "Agit seul sur ce qui ne change rien, demande pour les écritures. La confiance acquise lève la demande, action par action.",
  },
  autonomous: {
    label: "Autonome", short: "Autonome", icon: RocketLaunchIcon,
    desc: "Agit seul sous le plafond de risque de l'équipe. Une action irréversible ou engageante demande toujours une personne.",
  },
};

const LEVEL_ORDER: AutonomyLevel[] = ["observer", "propose", "assisted", "autonomous"];

const RISK_LABEL = ["Lecture", "Écriture interne", "Visible par un tiers", "Irréversible"];
const RISK_HINT = [
  "lister, chercher, lire",
  "brouillon, statut, note interne",
  "e-mail à un client, publication",
  "paiement, suppression, accès",
];

interface EnvPolicy { approve_at: number | null; block_at: number | null }
interface TeamPolicy { interactive: EnvPolicy; autonomous: EnvPolicy; autopilot_ceiling: number }
// Miroir de DEFAULT_TEAM_POLICY (supabase/functions/_shared/policyguard.ts).
const DEFAULT_POLICY: TeamPolicy = {
  interactive: { approve_at: 2, block_at: null },
  autonomous: { approve_at: 2, block_at: null },
  autopilot_ceiling: 3,
};

function normEnv(raw: unknown, d: EnvPolicy): EnvPolicy {
  const r = (raw ?? {}) as Partial<EnvPolicy>;
  const lvl = (v: unknown, fb: number | null) => (v === null ? null : [0, 1, 2, 3].includes(Number(v)) ? Number(v) : fb);
  return { approve_at: lvl(r.approve_at, d.approve_at), block_at: lvl(r.block_at, d.block_at) };
}
function normPolicy(raw: unknown): TeamPolicy {
  const r = (raw ?? {}) as Partial<TeamPolicy>;
  const c = Number(r.autopilot_ceiling);
  return {
    interactive: normEnv(r.interactive, DEFAULT_POLICY.interactive),
    autonomous: normEnv(r.autonomous, DEFAULT_POLICY.autonomous),
    autopilot_ceiling: [0, 1, 2, 3, 4].includes(c) ? c : DEFAULT_POLICY.autopilot_ceiling,
  };
}

type Outcome = "alone" | "ask" | "trust" | "block";

/** What happens to an action of `risk` for this level — the same order of
 *  rules as policyGate, read for a person instead of executed. */
function outcomeFor(level: AutonomyLevel, risk: number, env: EnvPolicy, ceiling: number, jevOn: boolean): Outcome {
  if (risk === 0) return "alone";
  if (level === "observer") return "block";
  if (env.block_at != null && risk >= env.block_at) return "block";
  if (level === "propose") return "ask";
  const autonomous = level === "autonomous" && jevOn;
  if (autonomous) return risk < ceiling ? "alone" : "ask";
  // Assisted (and autonomous without Jev): known writes ask; a trust grant
  // lifts the ask under the ceiling, only when Jev judges.
  return jevOn && risk < ceiling ? "trust" : "ask";
}

const OUTCOME_META: Record<Outcome, { label: string; icon: PhosphorIcon; tone: string }> = {
  alone: { label: "Seul", icon: CheckCircleIcon, tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  trust: { label: "Demande, sauf confiance", icon: SealCheckIcon, tone: "bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  ask: { label: "Demande", icon: WarningIcon, tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  block: { label: "Refusé", icon: ProhibitIcon, tone: "bg-red-500/10 text-red-700 dark:text-red-400" },
};

export function AgentAutonomyTab({ agent }: { agent: InternalAgent & { autonomy_level?: string | null } }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const adminBase = `/app/${workspaceSlug}/${projectSlug}/admin`;
  const level = (LEVEL_ORDER.includes(agent.autonomy_level as AutonomyLevel) ? agent.autonomy_level : "assisted") as AutonomyLevel;
  const dashboardId = (agent as { service_dashboard_id?: string | null }).service_dashboard_id ?? null;

  // Jev's risk judgement: « Autonome » and earned trust only act when it is on.
  const { data: jevMode } = useQuery({
    queryKey: ["typesafe_policy_guard_mode", agent.workspace_id],
    queryFn: async () => {
      const { data } = await supabase.from("typesafe_settings").select("features").eq("workspace_id", agent.workspace_id).maybeSingle();
      const f = ((data as { features?: Record<string, { mode?: string }> } | null)?.features ?? {}).policy_guard;
      return (f?.mode ?? "off") as "off" | "shadow" | "on";
    },
  });
  const jevOn = jevMode === "on";

  // Jev stays actionable from here: off, shadow or on, written exactly like the
  // « Jugement rapide » screen (one jsonb per workspace, owners/admins only).
  // Taking effect needs no deploy — the edge caches the setting 60 s at most.
  async function setJevMode(mode: "off" | "shadow" | "on") {
    if (mode === jevMode) return;
    const { data } = await supabase.from("typesafe_settings").select("features").eq("workspace_id", agent.workspace_id).maybeSingle();
    const features = ((data as { features?: Record<string, { mode?: string; threshold?: number }> } | null)?.features ?? {});
    const prev = features.policy_guard ?? {};
    const { error } = await supabase.from("typesafe_settings").upsert({
      workspace_id: agent.workspace_id,
      features: { ...features, policy_guard: { threshold: 0.5, ...prev, mode } },
      updated_at: new Date().toISOString(),
    }, { onConflict: "workspace_id" });
    if (error) {
      toast.error("Réglage non enregistré", "Seuls les propriétaires et administrateurs de l'espace peuvent changer Jev.");
      return;
    }
    qc.invalidateQueries({ queryKey: ["typesafe_policy_guard_mode", agent.workspace_id] });
    qc.invalidateQueries({ queryKey: ["typesafe_settings", agent.workspace_id] });
    toast.success(
      mode === "on" ? "Jev actif" : mode === "shadow" ? "Jev en observation" : "Jev éteint",
      "Pris en compte par les collaborateurs dans la minute, pour tout l'espace.",
    );
  }

  const { data: policy } = useQuery({
    queryKey: ["policyguard_policy", agent.project_id, dashboardId],
    queryFn: async () => {
      const { data } = await supabase.from("policyguard_policies").select("service_dashboard_id, policy").eq("project_id", agent.project_id);
      const rows = (data ?? []) as Array<{ service_dashboard_id: string | null; policy: unknown }>;
      const team = dashboardId ? rows.find((r) => r.service_dashboard_id === dashboardId) : null;
      const project = rows.find((r) => r.service_dashboard_id === null);
      return { policy: normPolicy((team ?? project)?.policy), source: team ? "équipe" : project ? "projet" : "défaut" };
    },
  });
  const grid = policy?.policy ?? DEFAULT_POLICY;

  const { data: grants } = useQuery({
    queryKey: ["agent_trust_grants", agent.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("agent_trust_grants")
        .select("id, scope, tool, action, approvals_seen, created_at").eq("agent_id", agent.id)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ id: string; scope: string; tool: string; action: string; approvals_seen: number; created_at: string }>;
    },
  });
  const { data: candidates } = useQuery({
    queryKey: ["agent_trust_candidates", dashboardId, agent.id],
    enabled: !!dashboardId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("agent_trust_candidates", { p_dashboard: dashboardId });
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<{ agent_id: string; scope: string; tool: string; action: string; approved: number; last_at: string }>)
        .filter((c) => c.agent_id === agent.id);
    },
  });
  const { data: decisions } = useQuery({
    queryKey: ["policy_decisions_agent", agent.id],
    queryFn: async () => {
      const { data } = await supabase.from("policy_decisions")
        .select("id, tool, action, risk_level, applied_decision, decision, reason, mode, environment, created_at")
        .eq("agent_id", agent.id).order("created_at", { ascending: false }).limit(15);
      return (data ?? []) as Array<{ id: number; tool: string; action: string; risk_level: number; applied_decision: string;
        decision: string; reason: string | null; mode: string; environment: string; created_at: string }>;
    },
  });

  async function setLevel(next: AutonomyLevel) {
    if (next === level) return;
    if (next === "autonomous" && !(await confirm({
      title: `Rendre ${agent.name} autonome ?`,
      description: jevOn
        ? "Il agira seul sur tout ce qui reste sous le plafond de risque de l'équipe. Une action irréversible ou engageante demandera toujours une personne."
        : "Le jugement de risque Jev (PolicyGuard) n'est pas actif : tant qu'il ne l'est pas, le collaborateur continuera de demander comme en mode assisté.",
      confirmText: "Rendre autonome",
      destructive: false,
    }))) return;
    const { error } = await supabase.from("internal_agents").update({ autonomy_level: next }).eq("id", agent.id);
    if (error) { toast.error("Changement impossible", error.message); return; }
    qc.invalidateQueries({ queryKey: ["sd_agent_full", agent.id] });
    qc.invalidateQueries({ queryKey: ["sd_agents"] });
    qc.invalidateQueries({ queryKey: ["sd_inbox"] });
    toast.success(`${agent.name} : ${AUTONOMY_META[next].label}`);
  }

  async function grant(c: { scope: string; tool: string; action: string; approved: number }) {
    const { error } = await supabase.from("agent_trust_grants").insert({
      agent_id: agent.id, scope: c.scope, tool: c.tool, action: c.action, approvals_seen: c.approved,
    });
    if (error) { toast.error("Impossible d'accorder la confiance", error.message); return; }
    qc.invalidateQueries({ queryKey: ["agent_trust_grants", agent.id] });
    qc.invalidateQueries({ queryKey: ["agent_trust_candidates"] });
    qc.invalidateQueries({ queryKey: ["sd_inbox"] });
    toast.success("Confiance accordée", actionLabel(c.tool, c.action));
  }

  async function revoke(g: { id: string; tool: string; action: string }) {
    const { error } = await supabase.from("agent_trust_grants").delete().eq("id", g.id);
    if (error) { toast.error("Retrait impossible", error.message); return; }
    qc.invalidateQueries({ queryKey: ["agent_trust_grants", agent.id] });
    qc.invalidateQueries({ queryKey: ["agent_trust_candidates"] });
    toast.info("Confiance retirée", `${actionLabel(g.tool, g.action)} redemandera une validation.`);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <header>
        <h2 className="text-xl font-semibold tracking-tight">Ce que {agent.name} peut faire seul</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Chaque action qui touche vos outils reçoit une note de risque, de la simple lecture à l'irréversible.
          Le niveau choisi ici décide, avec la grille de l'équipe, ce qui passe seul, ce qui vous est demandé et ce qui est refusé.
        </p>
      </header>

      {/* The judgement everything rests on. */}
      <div className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3",
        jevOn ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5",
      )}>
        <ScalesIcon className={cn("mt-0.5 h-5 w-5 shrink-0", jevOn ? "text-emerald-600" : "text-amber-600")} />
        <div className="min-w-0 flex-1 text-sm">
          <div className="font-medium">
            Jugement du risque par Jev (PolicyGuard) : {jevMode === "on" ? "actif" : jevMode === "shadow" ? "en observation" : "éteint"}
          </div>
          <p className="mt-0.5 text-muted-foreground">
            {jevOn
              ? "Les niveaux s'appliquent entièrement : Autonome et la confiance acquise s'appuient sur la note de risque de chaque action."
              : jevMode === "shadow"
                ? "Jev note chaque action et le journal montre ce qu'il aurait décidé, sans rien changer. Observateur et Proposer s'appliquent déjà ; Autonome et la confiance acquise attendent le mode actif."
                : "Observateur et Proposer s'appliquent déjà. Autonome et la confiance acquise attendent ce jugement : sans lui, le collaborateur demande comme en mode assisté."}
          </p>
          {/* Off / shadow / on, for the whole workspace — reversible at any time. */}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-border bg-background p-0.5" role="radiogroup" aria-label="Mode de Jev pour PolicyGuard">
              {([["off", "Éteint"], ["shadow", "Observation"], ["on", "Actif"]] as const).map(([m, label]) => (
                <button
                  key={m} type="button" role="radio" aria-checked={jevMode === m}
                  onClick={() => void setJevMode(m)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-12 transition-colors",
                    jevMode === m ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => navigate(`${adminBase}/gov-typesafe`)} className="text-12 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              Tous les usages de Jev
            </button>
            <button type="button" onClick={() => navigate(`${adminBase}/gov-policyguard`)} className="text-12 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              Grille de l'équipe
            </button>
          </div>
        </div>
      </div>

      {/* The four levels. */}
      <section>
        <h3 className="mb-3 text-sm font-semibold">Niveau d'autonomie</h3>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {LEVEL_ORDER.map((l) => {
            const m = AUTONOMY_META[l];
            const on = l === level;
            return (
              <button
                key={l} type="button" onClick={() => void setLevel(l)}
                className={cn(
                  "flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors",
                  on ? "border-primary/50 bg-primary/5 ring-2 ring-primary/15" : "border-border/70 hover:border-border hover:bg-muted/40",
                )}
              >
                <span className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg", on ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>
                  <m.icon weight={on ? "fill" : "regular"} className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {m.label}
                    {l === "assisted" && <span className="text-[11px] font-normal text-muted-foreground">par défaut</span>}
                    {l === "autonomous" && !jevOn && <span className="text-[11px] font-normal text-amber-600">attend Jev</span>}
                  </span>
                  <span className="mt-0.5 block text-12 leading-snug text-muted-foreground">{m.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* What it means concretely, with the team's real grid. */}
      <section>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold">Concrètement, pour {AUTONOMY_META[level].label.toLowerCase()}</h3>
          <span className="text-11 text-muted-foreground">grille : {policy?.source ?? "défaut"}</span>
        </div>
        <div className="overflow-hidden rounded-xl border border-border/70">
          <table className="w-full text-12">
            <thead className="bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-normal">Risque de l'action</th>
                <th className="px-3 py-2 font-normal">En conversation</th>
                <th className="px-3 py-2 font-normal">En mission</th>
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3].map((risk) => (
                <tr key={risk} className="border-t border-border/60">
                  <td className="px-3 py-2">
                    <div className="font-medium">{RISK_LABEL[risk]}</div>
                    <div className="text-11 text-muted-foreground">{RISK_HINT[risk]}</div>
                  </td>
                  {(["interactive", "autonomous"] as const).map((env) => {
                    const o = OUTCOME_META[outcomeFor(level, risk, grid[env], grid.autopilot_ceiling, jevOn)];
                    return (
                      <td key={env} className="px-3 py-2">
                        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium", o.tone)}>
                          <o.icon weight="fill" className="h-3 w-3" /> {o.label}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Earned trust, one action type at a time. */}
      <section>
        <h3 className="text-sm font-semibold">Confiance acquise</h3>
        <p className="mb-3 mt-1 text-12 text-muted-foreground">
          Quand vous avez validé au moins trois fois le même type d'action en 60 jours sans jamais refuser, il peut passer seul.
          Jamais pour une action irréversible, et seulement en mode assisté.
        </p>
        {(candidates ?? []).length > 0 && (
          <ul className="mb-3 space-y-2">
            {(candidates ?? []).map((c) => (
              <li key={c.scope} className="flex items-center gap-3 rounded-xl border border-sky-500/30 bg-sky-500/5 px-3.5 py-2.5">
                <SealCheckIcon className="h-4 w-4 shrink-0 text-sky-600" />
                <div className="min-w-0 flex-1 text-13">
                  <div className="font-medium">{actionLabel(c.tool, c.action)}</div>
                  <div className="text-11 text-muted-foreground">Validé {c.approved} fois sans refus, la dernière {formatRelative(c.last_at)}</div>
                </div>
                <Button size="sm" className="h-7 text-12" disabled={level !== "assisted"} onClick={() => void grant(c)}>
                  Accorder
                </Button>
              </li>
            ))}
          </ul>
        )}
        {(grants ?? []).length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 px-4 py-5 text-center text-12 text-muted-foreground">
            Aucune confiance accordée pour l'instant.
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
            {(grants ?? []).map((g) => (
              <li key={g.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <ShieldCheckIcon className="h-4 w-4 shrink-0 text-emerald-600" />
                <div className="min-w-0 flex-1 text-13">
                  <div className="font-medium">{actionLabel(g.tool, g.action)}</div>
                  <div className="text-11 text-muted-foreground">
                    Accordée {formatRelative(g.created_at)}{g.approvals_seen ? ` après ${g.approvals_seen} validations` : ""}
                  </div>
                </div>
                <button
                  type="button" onClick={() => void revoke(g)} title="Retirer la confiance"
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                >
                  <TrashIcon className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* What PolicyGuard actually decided for this collaborator. */}
      <section>
        <h3 className="mb-3 text-sm font-semibold">Dernières décisions</h3>
        {decisions === undefined ? (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : decisions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 px-4 py-5 text-center text-12 text-muted-foreground">
            Aucune action sensible jugée pour l'instant. Les lectures évidentes ne sont pas journalisées.
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
            {decisions.map((d) => {
              const o = d.applied_decision === "allow" ? OUTCOME_META.alone : d.applied_decision === "block" ? OUTCOME_META.block : OUTCOME_META.ask;
              return (
                <li key={d.id} className="flex items-start gap-3 px-3.5 py-2.5">
                  <span className={cn("mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-11 font-medium", o.tone)}>
                    <o.icon weight="fill" className="h-3 w-3" />
                    {d.applied_decision === "allow" ? "Passée" : d.applied_decision === "block" ? "Refusée" : "Demandée"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-13">{actionLabel(d.tool, d.action)}</div>
                    <div className="text-11 text-muted-foreground">
                      {RISK_LABEL[d.risk_level] ?? "?"} · {d.environment === "interactive" ? "en conversation" : "en mission"}
                      {d.reason ? ` · ${d.reason}` : ""}
                      {d.mode === "shadow" && d.decision !== d.applied_decision ? ` · Jev aurait : ${d.decision === "allow" ? "laissé passer" : d.decision === "block" ? "refusé" : "demandé"}` : ""}
                    </div>
                  </div>
                  <span className="shrink-0 text-11 text-muted-foreground">{formatRelative(d.created_at)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
