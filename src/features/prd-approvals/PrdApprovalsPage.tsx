// Administration → Approbations : les actions soumises à approbation demandées
// par les agents (D6, généralisé par G3).
//
// Une demande naît quand un serveur MCP répond `approval_required`, ou quand
// une règle d'approbation s'applique à un outil interne. Ses approbateurs, son
// quorum et son échéance viennent de la règle (onglet « Règles » ; sans règle :
// le rôle IdP ai-ops-prd-approver, 1 approbateur, 15 minutes). Jamais la
// personne au nom de qui l'agent agissait. Les règles sont tenues côté serveur
// (internal-agent-approve, migrations 0275 et 0281) : cet écran les rend lisibles.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon as Check, XIcon as X, CircleNotchIcon as Loader2, ShieldWarningIcon as Shield, TimerIcon as Timer,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { EmptyState } from "@/components/EmptyState";
import { useToast } from "@/components/ToastProvider";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import { Pill, SectionTitle, type Tone } from "@/features/custom-connectors/ui";
import { ApprovalPoliciesPanel, describeRule } from "./ApprovalPoliciesPanel";

interface McpPayload {
  server_name?: string;
  tool?: string;
  target_cluster?: string;
  params?: unknown;
  params_hash?: string;
  message?: string;
  /** Outil interne (custom_connector). */
  connector_name?: string;
  operation?: string;
  risk?: string;
}

interface ApprovalTrace {
  requester_sub?: string;
  approver_sub?: string;
  token_jti?: string;
  token_expires_at?: string;
}

interface PrdApproval {
  id: string;
  agent_id: string;
  run_id: string | null;
  tool_name: string;
  payload: McpPayload;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "executed" | "failed" | "expired";
  requested_at: string;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  executed_at: string | null;
  expires_at: string | null;
  result: { detail?: string; approval?: ApprovalTrace } | null;
  error_message: string | null;
  action_kind: string;
  quorum: number | null;
  approver_rule: { roles?: string[]; idp_roles?: string[] } | null;
  policy_name: string | null;
  environment: string | null;
}

const ENV_LABEL: Record<string, string> = { development: "développement", staging: "recette", production: "production" };

const STATUS: Record<PrdApproval["status"], { label: string; tone: Tone }> = {
  pending: { label: "En attente", tone: "amber" },
  approved: { label: "Approuvée, en cours", tone: "blue" },
  executed: { label: "Exécutée", tone: "green" },
  failed: { label: "Approuvée, échec", tone: "red" },
  rejected: { label: "Refusée", tone: "muted" },
  expired: { label: "Expirée", tone: "muted" },
};

const qk = (ws: string) => ["prd-approvals", ws] as const;

async function fetchApprovals(workspaceId: string) {
  const { data, error } = await supabase
    .from("internal_agent_approvals")
    .select("id, agent_id, run_id, tool_name, payload, reason, status, requested_at, requested_by, decided_by, decided_at, executed_at, expires_at, result, error_message, action_kind, quorum, approver_rule, policy_name, environment")
    .eq("workspace_id", workspaceId)
    // Les actions en production d'avant G3, et toute demande soumise à une règle.
    .or("action_kind.eq.mcp_tool,quorum.not.is.null")
    .order("requested_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  const rows = (data ?? []) as PrdApproval[];

  const ids = rows.filter((r) => r.quorum != null).map((r) => r.id);
  const { data: voteRows } = ids.length
    ? await supabase.from("internal_agent_approval_votes").select("approval_id, user_id, created_at").in("approval_id", ids).order("created_at")
    : { data: [] };
  const votes = new Map<string, string[]>();
  for (const v of (voteRows ?? []) as Array<{ approval_id: string; user_id: string }>) {
    votes.set(v.approval_id, [...(votes.get(v.approval_id) ?? []), v.user_id]);
  }

  const agentIds = [...new Set(rows.map((r) => r.agent_id))];
  const userIds = [...new Set([
    ...rows.flatMap((r) => [r.requested_by, r.decided_by]),
    ...[...votes.values()].flat(),
  ].filter((v): v is string => !!v))];
  const [{ data: agents }, { data: people }] = await Promise.all([
    agentIds.length ? supabase.from("internal_agents").select("id, name").in("id", agentIds) : Promise.resolve({ data: [] }),
    userIds.length ? supabase.from("profiles").select("id, full_name, email").in("id", userIds) : Promise.resolve({ data: [] }),
  ]);
  const agentName = new Map(((agents ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]));
  const personName = new Map(((people ?? []) as { id: string; full_name: string | null; email: string | null }[])
    .map((p) => [p.id, p.full_name || p.email || p.id.slice(0, 8)]));
  return { rows, agentName, personName, votes };
}

export function PrdApprovalsPage() {
  const { workspaceId, role } = useCurrentContext();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const focusId = params.get("id");
  const [tab, setTab] = useState<"pending" | "history" | "rules">("pending");
  const [env, setEnv] = useState<string>("");
  const now = useNow(15_000);

  const { data, isLoading, error } = useQuery({
    queryKey: qk(workspaceId ?? ""),
    enabled: !!workspaceId,
    queryFn: () => fetchApprovals(workspaceId!),
    refetchInterval: 15_000,
  });

  const isPending = (a: PrdApproval) => a.status === "pending" && !!a.expires_at && Date.parse(a.expires_at) > now;
  const pending = useMemo(() => (data?.rows ?? []).filter(isPending), [data, now]); // eslint-disable-line react-hooks/exhaustive-deps
  const history = useMemo(() => (data?.rows ?? []).filter((a) => !isPending(a)), [data, now]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lien reçu par notification : ouvrir le bon onglet.
  useEffect(() => {
    if (!focusId || !data) return;
    if (history.some((a) => a.id === focusId)) setTab("history");
  }, [focusId, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const byEnv = (a: PrdApproval) => !env || (env === "none" ? !a.environment : a.environment === env);
  const list = (tab === "pending" ? pending : history).filter(byEnv);

  return (
    <div>
      <PageHeader
        title="Approbations"
        description="Les actions soumises à approbation demandées par les agents. Les approbateurs, leur nombre et l'échéance viennent de la règle qui s'applique ; jamais la personne au nom de qui l'agent agit. L'action approuvée est alors exécutée telle quelle."
      />
      <div className="mb-4 flex flex-wrap items-center gap-1 border-b border-border">
        <TabButton active={tab === "pending"} onClick={() => setTab("pending")}>
          En attente {pending.length > 0 && <Pill tone="amber" className="ml-1">{pending.length}</Pill>}
        </TabButton>
        <TabButton active={tab === "history"} onClick={() => setTab("history")}>Historique</TabButton>
        <TabButton active={tab === "rules"} onClick={() => setTab("rules")}>Règles</TabButton>
        {tab !== "rules" && (
          <select value={env} onChange={(e) => setEnv(e.target.value)} className="mb-1 ml-auto h-8 rounded-md border border-border bg-background px-2 text-xs" aria-label="Environnement">
            <option value="">Tous les environnements</option>
            <option value="production">Production</option>
            <option value="staging">Recette</option>
            <option value="development">Développement</option>
            <option value="none">Non précisé</option>
          </select>
        )}
      </div>

      {tab === "rules" ? (
        workspaceId ? <ApprovalPoliciesPanel workspaceId={workspaceId} canEdit={role === "owner" || role === "admin"} /> : null
      ) : isLoading || !workspaceId ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : error ? (
        <p className="text-sm text-red-600">{error instanceof Error ? error.message : String(error)}</p>
      ) : list.length === 0 ? (
        <EmptyState
          icon={Shield}
          title={tab === "pending" ? "Aucune action en attente" : "Aucune demande pour l'instant"}
          description={tab === "pending"
            ? "Quand un agent demande une action soumise à approbation, elle apparaît ici. Les approbateurs sont aussi prévenus par le webhook configuré."
            : "Les demandes décidées, refusées ou expirées s'affichent ici, avec leur résultat."}
        />
      ) : (
        <div className="space-y-3">
          {list.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              live={isPending(a)}
              now={now}
              focused={a.id === focusId}
              isRequester={!!user && a.requested_by === user.id}
              voters={data!.votes.get(a.id) ?? []}
              hasVoted={!!user && (data!.votes.get(a.id) ?? []).includes(user.id)}
              agentName={data!.agentName.get(a.agent_id) ?? "Agent"}
              personName={(id) => (id ? data!.personName.get(id) ?? id.slice(0, 8) : "exécution planifiée")}
              workspaceId={workspaceId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ approval: a, live, now, focused, isRequester, voters, hasVoted, agentName, personName, workspaceId }: {
  approval: PrdApproval;
  live: boolean;
  now: number;
  focused: boolean;
  isRequester: boolean;
  voters: string[];
  hasVoted: boolean;
  agentName: string;
  personName: (id: string | null) => string;
  workspaceId: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<null | "approve" | "reject">(null);
  const p = a.payload ?? {};
  const status = a.status === "pending" && !live ? STATUS.expired : STATUS[a.status];
  const remaining = a.expires_at ? Math.max(0, Date.parse(a.expires_at) - now) : 0;
  const trace = a.result?.approval;

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    try {
      const out = await callEdge<{ ok?: boolean; status?: string; detail?: string }>(
        "internal-agent-approve", { approval_id: a.id, decision, source: "approvals" },
      );
      if (decision === "reject") toast.success(isRequester ? "Demande retirée" : "Action refusée");
      else if (out.status === "pending") toast.success("Approbation enregistrée", out.detail ?? "");
      else if (out.status === "approved") toast.success("Quorum atteint", out.detail ?? "");
      else if (out.ok) toast.success("Action approuvée et exécutée");
      else toast.error("Approuvée, mais l'exécution a échoué", (out.detail ?? "").slice(0, 300));
    } catch (e) {
      toast.error("Décision refusée", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await queryClient.invalidateQueries({ queryKey: qk(workspaceId) });
    }
  }

  return (
    <article className={cn(
      "rounded-xl border bg-card p-4",
      live ? "border-amber-500/40" : "border-border",
      focused && "ring-2 ring-amber-500/50",
    )}>
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold">
          {a.action_kind === "custom_connector" ? `${p.connector_name ?? "outil interne"} · ${p.operation ?? a.tool_name}` : (p.tool ?? a.tool_name)}
        </span>
        {p.target_cluster && <Pill tone={p.target_cluster === "prd" ? "red" : "violet"}>{p.target_cluster}</Pill>}
        {a.environment && <Pill tone={a.environment === "production" ? "red" : "muted"}>{ENV_LABEL[a.environment] ?? a.environment}</Pill>}
        <Pill tone={status.tone}>{status.label}</Pill>
        {a.quorum != null && <Pill tone={voters.length >= a.quorum ? "green" : "amber"}>{voters.length}/{a.quorum}</Pill>}
        {live && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
            <Timer className="h-3.5 w-3.5" /> expire dans {Math.ceil(remaining / 60_000)} min
          </span>
        )}
      </header>

      <dl className="mb-3 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-xs">
        <Row label="Agent">{agentName}</Row>
        <Row label="Au nom de">{personName(a.requested_by)}</Row>
        {a.action_kind === "mcp_tool" && <Row label="Serveur">{p.server_name ?? "?"}</Row>}
        {a.quorum != null && <Row label="Règle">{a.policy_name ?? "règle supprimée"}</Row>}
        <Row label="Approbateurs">{a.quorum != null ? describeRule(a.approver_rule, a.quorum) : "1 approbateur : « ai-ops-prd-approver »"}</Row>
        {voters.length > 0 && <Row label="Ont approuvé">{voters.map((v) => personName(v)).join(", ")}</Row>}
        <Row label="Demandée">{new Date(a.requested_at).toLocaleString("fr-FR")}</Row>
        {a.decided_at && <Row label="Décidée">{`${new Date(a.decided_at).toLocaleString("fr-FR")} par ${personName(a.decided_by)}`}</Row>}
      </dl>

      {(p.message || a.reason) && <p className="mb-2 text-xs text-muted-foreground">{p.message || a.reason}</p>}

      <SectionTitle>Paramètres (tels que le serveur les a lus)</SectionTitle>
      <pre className="mb-3 max-h-48 overflow-auto rounded-lg bg-muted p-2 text-[11px] leading-relaxed">{JSON.stringify(p.params ?? {}, null, 2)}</pre>

      {live ? (
        isRequester ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">Action demandée en votre nom : une autre personne doit l'approuver.</p>
            <button disabled={!!busy} onClick={() => decide("reject")} className={btn("border border-border hover:bg-muted")}>
              {busy === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Retirer la demande
            </button>
          </div>
        ) : hasVoted ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">Vous avez approuvé : il faut encore {Math.max(0, (a.quorum ?? 1) - voters.length)} autre(s) approbateur(s).</p>
            <button disabled={!!busy} onClick={() => decide("reject")} className={btn("border border-border hover:bg-muted")}>
              {busy === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Refuser finalement
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button disabled={!!busy} onClick={() => decide("approve")} className={btn("bg-emerald-600 text-white hover:bg-emerald-700")}>
              {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Approuver
            </button>
            <button disabled={!!busy} onClick={() => decide("reject")} className={btn("border border-border hover:bg-muted")}>
              {busy === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Refuser
            </button>
          </div>
        )
      ) : (
        (a.result?.detail || a.error_message || trace) && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Résultat et trace</summary>
            {(a.error_message || a.result?.detail) && (
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted p-2 text-[11px]">{a.error_message || a.result?.detail}</pre>
            )}
            {trace && (
              <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1">
                <Row label="Demandeur (Keycloak)">{trace.requester_sub ?? "?"}</Row>
                <Row label="Approbateur (Keycloak)">{trace.approver_sub ?? "?"}</Row>
                <Row label="Jeton d'approbation">{trace.token_jti ?? "?"}</Row>
                {trace.token_expires_at && <Row label="Valable jusqu'à">{new Date(trace.token_expires_at).toLocaleString("fr-FR")}</Row>}
                <Row label="Empreinte">{p.params_hash ?? "?"}</Row>
              </dl>
            )}
          </details>
        )
      )}
    </article>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "-mb-px inline-flex items-center border-b-2 px-3 py-2 text-sm",
        active ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

const btn = (extra: string) =>
  cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50", extra);

/** L'heure, rafraîchie régulièrement : pour les échéances affichées. */
function useNow(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return now;
}
