import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircleIcon, ClockIcon, WarningCircleIcon, WrenchIcon, XCircleIcon,
} from "@phosphor-icons/react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { HqAgent } from "@/features/dashboard/hqStats";
import { formatRelative } from "../pickers";
import { decideApproval } from "../model";
import { TRACKER_ACTION_LABEL } from "../IssueMissions";

/**
 * Les widgets EN DIRECT des statistiques d'agents.
 *
 * Le reste de la grille répond à « qu'ont fait les agents ? » — des totaux sur
 * une période. Ces widgets répondent à une autre question, celle qu'on se pose
 * en ouvrant la page au milieu de la journée : « que font-ils MAINTENANT ? ».
 * Qui tourne, sur quoi, depuis combien de temps, quel outil vient de partir,
 * et qui attend qu'on lui réponde.
 *
 * ── Comment « en direct » est tenu ─────────────────────────────────────────
 *
 * Par le temps réel de Supabase sur `internal_agent_runs` et
 * `internal_agent_run_events` (publiées depuis 0104) : chaque événement
 * déclenche une relecture. Les demandes d'autorisation, elles, ne sont pas
 * publiées ; on les relit toutes les dix secondes.
 *
 * Les relectures sont REGROUPÉES : un agent qui enchaîne vingt appels d'outils
 * à la seconde produirait sinon vingt requêtes à la seconde par personne qui
 * regarde la page. On relit au plus une fois par seconde, ce qui reste
 * instantané à l'œil.
 *
 * Et un filet : même sans le temps réel (coupure réseau, onglet réveillé après
 * une veille), tout se relit à intervalle fixe. Un tableau « en direct » figé
 * sans le dire serait pire qu'un tableau qui ne prétend pas l'être.
 */

// ── Les données ─────────────────────────────────────────────────────────────

export interface LiveRun {
  id: string;
  agent_id: string;
  status: "queued" | "running";
  label: string | null;
  run_kind: string | null;
  action_count: number;
  cost_usd: number;
  started_at: string | null;
  created_at: string;
}

export interface LiveEvent {
  id: string;
  run_id: string | null;
  agent_id: string;
  kind: string;
  created_at: string;
  tool: string | null;
  ok: boolean | null;
  message: string | null;
}

export interface LiveApproval {
  id: string;
  agent_id: string | null;
  tool_name: string;
  action_kind: string;
  reason: string | null;
  payload: Record<string, unknown>;
  requested_at: string;
}

export interface FinishedRun {
  id: string;
  agent_id: string;
  status: "succeeded" | "failed" | "cancelled";
  label: string | null;
  run_kind: string | null;
  error_message: string | null;
  finished_at: string | null;
  created_at: string;
}

/** Au-delà, le filtre `in` du temps réel est refusé ; on retombe sur l'intervalle. */
const REALTIME_MAX_IDS = 100;

export function useLiveActivity(agentIds: string[]) {
  const qc = useQueryClient();
  const key = useMemo(() => [...agentIds].sort().join(","), [agentIds]);
  const on = agentIds.length > 0;
  const [connected, setConnected] = useState(false);

  const runs = useQuery({
    queryKey: ["live_runs", key],
    enabled: on,
    refetchInterval: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("internal_agent_runs")
        .select("id, agent_id, status, label, run_kind, action_count, cost_usd, started_at, created_at")
        .in("agent_id", agentIds)
        .in("status", ["queued", "running"])
        .order("created_at", { ascending: true })
        .limit(50);
      if (error) throw new Error(error.message);
      return (data ?? []) as LiveRun[];
    },
  });

  const events = useQuery({
    queryKey: ["live_events", key],
    enabled: on,
    refetchInterval: 15_000,
    queryFn: async () => {
      // Projection légère : un résultat d'outil porte jusqu'à mille caractères
      // d'aperçu, dont on ne lit ici que le nom de l'outil et le verdict.
      const { data, error } = await supabase.from("internal_agent_run_events")
        .select("id, run_id, agent_id, kind, created_at, tool:payload->>tool, ok:payload->ok, message:payload->>message")
        .in("agent_id", agentIds)
        .in("kind", ["tool_call", "tool_result", "tool_error", "status", "error", "plan_step"])
        .order("created_at", { ascending: false })
        .limit(80);
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        run_id: (r.run_id as string | null) ?? null,
        agent_id: String(r.agent_id),
        kind: String(r.kind),
        created_at: String(r.created_at),
        tool: (r.tool as string | null) ?? null,
        ok: r.ok === true || r.ok === "true" ? true : r.ok === false || r.ok === "false" ? false : null,
        message: (r.message as string | null) ?? null,
      })) as LiveEvent[];
    },
  });

  const approvals = useQuery({
    queryKey: ["live_approvals", key],
    enabled: on,
    refetchInterval: 10_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("internal_agent_approvals")
        .select("id, agent_id, tool_name, action_kind, reason, payload, requested_at")
        .in("agent_id", agentIds)
        .eq("status", "pending")
        .order("requested_at", { ascending: true })
        .limit(30);
      if (error) throw new Error(error.message);
      return (data ?? []) as LiveApproval[];
    },
  });

  const recent = useQuery({
    queryKey: ["live_recent", key],
    enabled: on,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("internal_agent_runs")
        .select("id, agent_id, status, label, run_kind, error_message, finished_at, created_at")
        .in("agent_id", agentIds)
        .in("status", ["succeeded", "failed", "cancelled"])
        .order("created_at", { ascending: false })
        .limit(60);
      if (error) throw new Error(error.message);
      return (data ?? []) as FinishedRun[];
    },
  });

  // ── Le temps réel ─────────────────────────────────────────────────────────
  const pending = useRef<Set<string>>(new Set());
  const timer = useRef<number | null>(null);

  // L'effet ne dépend QUE de la clé : le tableau `agentIds` change d'identité
  // à chaque rendu du parent, et l'inscrire dans les dépendances désabonnerait
  // puis réabonnerait le canal en boucle.
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (!ids.length || ids.length > REALTIME_MAX_IDS) { setConnected(false); return; }

    // Les relectures demandées pendant la seconde sont fusionnées en une seule.
    const bump = (...keys: string[]) => {
      keys.forEach((k) => pending.current.add(k));
      if (timer.current !== null) return;
      timer.current = window.setTimeout(() => {
        for (const k of pending.current) qc.invalidateQueries({ queryKey: [k, key] });
        pending.current.clear();
        timer.current = null;
      }, 1000);
    };

    const filter = `agent_id=in.(${ids.join(",")})`;
    const channel = supabase
      .channel(`live-agents-${key.slice(0, 60)}-${Math.random().toString(36).slice(2, 8)}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "internal_agent_run_events", filter },
        () => bump("live_events", "live_runs"))
      .on("postgres_changes", { event: "*", schema: "public", table: "internal_agent_runs", filter },
        () => bump("live_runs", "live_recent", "live_events"))
      .subscribe((status) => setConnected(status === "SUBSCRIBED"));

    return () => {
      if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
      pending.current.clear();
      void supabase.removeChannel(channel);
    };
  }, [key, qc]);

  return {
    connected,
    runs: runs.data ?? [],
    events: events.data ?? [],
    approvals: approvals.data ?? [],
    recent: recent.data ?? [],
    refreshApprovals: () => qc.invalidateQueries({ queryKey: ["live_approvals", key] }),
  };
}

/** Une horloge qui ne bat que quand quelque chose en dépend. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function elapsed(fromIso: string | null, now: number): string {
  if (!fromIso) return "—";
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

// ── L'enveloppe commune ─────────────────────────────────────────────────────

/**
 * L'en-tête d'un widget en direct : le titre, et un voyant qui dit si le direct
 * est réellement branché. Sans lui, un tableau figé par une coupure ressemble
 * trait pour trait à un tableau où il ne se passe rien.
 */
function LiveFrame({
  title, connected, count, children,
}: { title: string; connected: boolean; count?: number; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex items-center gap-2 pb-2">
        <h3 className="truncate text-13 font-medium">{title}</h3>
        {count !== undefined && count > 0 && (
          <span className="rounded bg-muted px-1.5 text-10 font-medium tabular-nums text-muted-foreground">{count}</span>
        )}
        <span className="flex-1" />
        <span
          className="flex shrink-0 items-center gap-1 text-10 font-medium uppercase tracking-wide"
          title={connected ? "Mis à jour en temps réel" : "Relu à intervalle régulier — le temps réel n'est pas connecté"}
        >
          <span className={cn("relative flex h-1.5 w-1.5")}>
            {connected && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-70" />}
            <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", connected ? "bg-emerald-500" : "bg-muted-foreground/50")} />
          </span>
          <span className={connected ? "text-emerald-600" : "text-muted-foreground"}>
            {connected ? "Live" : "Différé"}
          </span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="flex h-full items-center justify-center py-6 text-center text-12 text-muted-foreground">{children}</p>;
}

function AgentDot({ agent }: { agent: HqAgent | undefined }) {
  return (
    <span
      className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-11"
      style={{ background: `${agent?.accent_color ?? "#6b7180"}26` }}
    >
      {agent?.avatar_emoji ?? (agent?.name?.[0]?.toUpperCase() ?? "?")}
    </span>
  );
}

// ── 1. Ce qui tourne ────────────────────────────────────────────────────────

/**
 * Les exécutions en cours et en file, avec leur étape du moment.
 *
 * L'étape est le dernier événement de l'exécution — l'outil appelé, le message
 * d'état. C'est ce qui distingue un agent qui avance d'un agent qui tourne
 * depuis vingt minutes sur le même appel : la durée seule ne le dit pas.
 */
export function LiveRunsWidget({
  runs, events, agentById, connected,
}: {
  runs: LiveRun[];
  events: LiveEvent[];
  agentById: Map<string, HqAgent>;
  connected: boolean;
}) {
  const now = useNow(runs.length > 0);
  const lastByRun = useMemo(() => {
    const m = new Map<string, LiveEvent>();
    for (const e of events) if (e.run_id && !m.has(e.run_id)) m.set(e.run_id, e);
    return m;
  }, [events]);

  const running = runs.filter((r) => r.status === "running");
  const queued = runs.filter((r) => r.status === "queued");

  return (
    <LiveFrame title="En cours" connected={connected} count={runs.length}>
      {!runs.length ? (
        <Empty>Aucun agent ne travaille en ce moment.</Empty>
      ) : (
        <ul className="space-y-1">
          {[...running, ...queued].map((r) => {
            const agent = agentById.get(r.agent_id);
            const last = lastByRun.get(r.id);
            const step = last
              ? last.kind === "tool_call" ? `appelle ${last.tool ?? "un outil"}`
                : last.kind === "tool_result" ? `${last.tool ?? "outil"} ${last.ok === false ? "a échoué" : "a répondu"}`
                : last.message ?? last.kind
              : r.status === "queued" ? "en attente de démarrage" : "démarre…";
            return (
              <li key={r.id} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-muted/40">
                <span className="relative">
                  <AgentDot agent={agent} />
                  {r.status === "running" && (
                    <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-primary ring-2 ring-card" />
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-12 font-medium">
                    {agent?.name ?? "Agent"}
                    <span className="font-normal text-muted-foreground"> · {r.label || r.run_kind || "exécution"}</span>
                  </span>
                  <span className="block truncate text-11 text-muted-foreground">{step}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className={cn(
                    "block text-11 font-medium tabular-nums",
                    r.status === "queued" ? "text-muted-foreground" : "text-foreground",
                  )}>
                    {r.status === "queued" ? "en file" : elapsed(r.started_at ?? r.created_at, now)}
                  </span>
                  {r.action_count > 0 && (
                    <span className="block text-10 tabular-nums text-muted-foreground">{r.action_count} action(s)</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </LiveFrame>
  );
}

// ── 2. Les appels d'outils ──────────────────────────────────────────────────

/**
 * Le fil des appels d'outils, le plus récent en haut.
 *
 * Un appel et son résultat sont DEUX lignes, pas une : c'est l'intervalle entre
 * les deux qui montre un outil lent, et un appel sans résultat qui montre un
 * outil bloqué. Fusionnés, on ne verrait que l'issue, jamais l'attente.
 */
export function LiveToolFeedWidget({
  events, agentById, connected,
}: {
  events: LiveEvent[];
  agentById: Map<string, HqAgent>;
  connected: boolean;
}) {
  const tools = events.filter((e) => e.kind === "tool_call" || e.kind === "tool_result" || e.kind === "tool_error").slice(0, 40);
  // Le fil est neuf pendant quelques secondes : c'est ce qui fait voir ce qui
  // VIENT d'arriver sans devoir comparer deux lectures de mémoire.
  const now = useNow(true);

  return (
    <LiveFrame title="Appels d'outils" connected={connected}>
      {!tools.length ? (
        <Empty>Aucun appel d'outil récent.</Empty>
      ) : (
        <ul>
          {tools.map((e) => {
            const agent = agentById.get(e.agent_id);
            const fresh = now - new Date(e.created_at).getTime() < 8000;
            const failed = e.kind === "tool_error" || (e.kind === "tool_result" && e.ok === false);
            return (
              <li
                key={e.id}
                className={cn(
                  "flex items-center gap-2 border-b border-border/40 py-1.5 last:border-0 transition-colors duration-1000",
                  fresh && "bg-primary/5",
                )}
              >
                <span className="shrink-0">
                  {e.kind === "tool_call"
                    ? <WrenchIcon className="h-3.5 w-3.5 text-muted-foreground" />
                    : failed
                      ? <XCircleIcon weight="fill" className="h-3.5 w-3.5 text-red-600" />
                      : <CheckCircleIcon weight="fill" className="h-3.5 w-3.5 text-emerald-600" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-11">{e.tool ?? "outil"}</span>
                  <span className="block truncate text-10 text-muted-foreground">
                    {agent?.name ?? "Agent"} · {e.kind === "tool_call" ? "appel" : failed ? "échec" : "résultat"}
                  </span>
                </span>
                <span className="shrink-0 text-10 tabular-nums text-muted-foreground">
                  {formatRelative(e.created_at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </LiveFrame>
  );
}

// ── 3. L'état de chaque agent ───────────────────────────────────────────────

type AgentState = "working" | "queued" | "waiting" | "failing" | "idle";

const STATE_META: Record<AgentState, { label: string; dot: string; text: string }> = {
  working: { label: "Travaille", dot: "bg-primary", text: "text-primary" },
  queued: { label: "En file", dot: "bg-sky-400", text: "text-sky-600" },
  waiting: { label: "Attend une validation", dot: "bg-amber-500", text: "text-amber-600" },
  failing: { label: "En échec", dot: "bg-red-500", text: "text-red-600" },
  idle: { label: "Au repos", dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
};

/**
 * Chaque agent, et ce qu'il fait — d'un seul coup d'œil.
 *
 * L'ordre de priorité des états est celui de ce qui demande un geste : un agent
 * qui attend une validation passe AVANT un agent qui travaille, parce que le
 * premier est arrêté faute de nous, et le second n'a besoin de rien.
 * « En échec » ne vaut que pour une dernière exécution ratée dans les
 * vingt-quatre heures : un échec d'il y a trois semaines n'est plus un état.
 */
export function AgentStatesWidget({
  agents, runs, approvals, recent, connected,
}: {
  agents: HqAgent[];
  runs: LiveRun[];
  approvals: LiveApproval[];
  recent: FinishedRun[];
  connected: boolean;
}) {
  const states = useMemo(() => {
    const day = Date.now() - 24 * 3600_000;
    const lastFinished = new Map<string, FinishedRun>();
    for (const r of recent) if (!lastFinished.has(r.agent_id)) lastFinished.set(r.agent_id, r);

    return agents.map((a) => {
      let state: AgentState = "idle";
      if (approvals.some((x) => x.agent_id === a.id)) state = "waiting";
      else if (runs.some((r) => r.agent_id === a.id && r.status === "running")) state = "working";
      else if (runs.some((r) => r.agent_id === a.id && r.status === "queued")) state = "queued";
      else {
        const last = lastFinished.get(a.id);
        if (last?.status === "failed" && new Date(last.finished_at ?? last.created_at).getTime() > day) {
          state = "failing";
        }
      }
      return { agent: a, state };
    }).sort((x, y) => ORDER.indexOf(x.state) - ORDER.indexOf(y.state));
  }, [agents, runs, approvals, recent]);

  const counts = states.reduce<Record<AgentState, number>>(
    (acc, s) => ({ ...acc, [s.state]: acc[s.state] + 1 }),
    { working: 0, queued: 0, waiting: 0, failing: 0, idle: 0 },
  );

  return (
    <LiveFrame title="États des agents" connected={connected}>
      {!agents.length ? (
        <Empty>Aucun agent.</Empty>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-3 gap-y-1 pb-2">
            {ORDER.filter((s) => counts[s] > 0).map((s) => (
              <span key={s} className="flex items-center gap-1 text-11 text-muted-foreground">
                <span className={cn("h-1.5 w-1.5 rounded-full", STATE_META[s].dot)} />
                <span className="tabular-nums font-medium text-foreground">{counts[s]}</span>
                {STATE_META[s].label.toLowerCase()}
              </span>
            ))}
          </div>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5">
            {states.map(({ agent, state }) => (
              <li key={agent.id} className="flex items-center gap-2 rounded-lg border border-border/60 px-2 py-1.5">
                <span className="relative">
                  <AgentDot agent={agent} />
                  <span className={cn(
                    "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-card",
                    STATE_META[state].dot,
                    state === "working" && "animate-pulse",
                  )} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-12">{agent.name}</span>
                  <span className={cn("block truncate text-10", STATE_META[state].text)}>
                    {STATE_META[state].label}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </LiveFrame>
  );
}

const ORDER: AgentState[] = ["waiting", "failing", "working", "queued", "idle"];

// ── 4. Ce qui attend une réponse ────────────────────────────────────────────

function describe(a: LiveApproval): string {
  const action = typeof a.payload?.action === "string" ? a.payload.action : null;
  if (a.action_kind === "tracker_write" && action) return TRACKER_ACTION_LABEL[action] ?? action;
  return action ? `${a.tool_name} · ${action}` : a.tool_name;
}

/**
 * Les autorisations en attente, tranchables sur place.
 *
 * Un agent qui attend est arrêté ; chaque minute le rapproche du délai au bout
 * duquel son exécution est déclarée morte. D'où le chronomètre sur chaque ligne,
 * et les boutons à même la liste plutôt qu'un lien vers la demande.
 */
export function LiveApprovalsWidget({
  approvals, agentById, onDecided,
}: {
  approvals: LiveApproval[];
  agentById: Map<string, HqAgent>;
  onDecided: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(approvals.length > 0);

  const decide = async (id: string, d: "approve" | "reject") => {
    setBusy(id);
    setError(null);
    try {
      await decideApproval(id, d);
      onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <LiveFrame title="À valider" connected={false} count={approvals.length}>
      {!approvals.length ? (
        <Empty>Aucun agent n'attend de réponse.</Empty>
      ) : (
        <ul className="space-y-2">
          {approvals.map((a) => {
            const agent = agentById.get(a.agent_id ?? "");
            const waitedMin = (now - new Date(a.requested_at).getTime()) / 60_000;
            return (
              <li key={a.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2">
                <div className="flex items-start gap-2">
                  <AgentDot agent={agent} />
                  <div className="min-w-0 flex-1">
                    <p className="text-12">
                      <span className="font-medium">{agent?.name ?? "Un agent"}</span> veut {describe(a)}
                    </p>
                    {a.reason && <p className="line-clamp-2 text-11 text-muted-foreground">{a.reason}</p>}
                    {/* Au-delà de vingt minutes, le run approche du délai de trente
                        au bout duquel l'ordonnanceur le déclare mort. */}
                    <p className={cn("text-10 tabular-nums", waitedMin > 20 ? "font-medium text-red-600" : "text-muted-foreground")}>
                      attend depuis {elapsed(a.requested_at, now)}
                    </p>
                  </div>
                </div>
                <div className="mt-1.5 flex justify-end gap-1">
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-11" disabled={busy !== null}
                    onClick={() => void decide(a.id, "reject")}>
                    Refuser
                  </Button>
                  <Button size="sm" className="h-6 px-2 text-11" disabled={busy !== null}
                    onClick={() => void decide(a.id, "approve")}>
                    {busy === a.id ? "…" : "Autoriser"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="pt-1 text-11 text-red-600">{error}</p>}
    </LiveFrame>
  );
}

// ── 5. Ce qui a cassé ───────────────────────────────────────────────────────

/**
 * Les échecs récents : exécutions ratées et outils en erreur, mêlés dans le
 * temps.
 *
 * Mêlés, parce que c'est ainsi qu'on diagnostique : cinq erreurs du même outil
 * juste avant l'échec d'une exécution disent la cause mieux que deux listes
 * séparées qu'il faudrait recouper à la main.
 */
export function RecentErrorsWidget({
  recent, events, agentById, connected,
}: {
  recent: FinishedRun[];
  events: LiveEvent[];
  agentById: Map<string, HqAgent>;
  connected: boolean;
}) {
  const items = useMemo(() => {
    const runFails = recent.filter((r) => r.status === "failed").map((r) => ({
      id: `r-${r.id}`,
      at: r.finished_at ?? r.created_at,
      agentId: r.agent_id,
      title: r.label || r.run_kind || "Exécution",
      detail: r.error_message,
      kind: "run" as const,
    }));
    const toolFails = events
      .filter((e) => e.kind === "tool_error" || e.kind === "error" || (e.kind === "tool_result" && e.ok === false))
      .map((e) => ({
        id: `e-${e.id}`,
        at: e.created_at,
        agentId: e.agent_id,
        title: e.tool ?? (e.kind === "error" ? "Erreur" : "Outil"),
        detail: e.message,
        kind: "tool" as const,
      }));
    return [...runFails, ...toolFails]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 25);
  }, [recent, events]);

  return (
    <LiveFrame title="Erreurs récentes" connected={connected} count={items.length}>
      {!items.length ? (
        <Empty>Aucune erreur récente.</Empty>
      ) : (
        <ul>
          {items.map((it) => {
            const agent = agentById.get(it.agentId);
            return (
              <li key={it.id} className="flex items-start gap-2 border-b border-border/40 py-1.5 last:border-0">
                {it.kind === "run"
                  ? <WarningCircleIcon weight="fill" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
                  : <XCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />}
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-11 font-medium", it.kind === "tool" && "font-mono")}>
                    {it.title}
                  </span>
                  <span className="block truncate text-10 text-muted-foreground">
                    {agent?.name ?? "Agent"}{it.detail ? ` · ${it.detail}` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-10 tabular-nums text-muted-foreground">
                  <ClockIcon className="h-3 w-3" />{formatRelative(it.at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </LiveFrame>
  );
}
