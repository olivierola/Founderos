// Workflow engine — trigger a playbook, and hand it to an agent.
//
// A workflow is NOT a graph the backend walks node by node. Blocks are
// assembled on a canvas, compiled into a `workflow.md`, and when the trigger
// fires the service's ASSISTANT reads that playbook and executes it, deciding
// for itself who does what — exactly as it does for a request typed in a room.
//
// So this module is two things and nothing more:
//   1. the schedule — cron parsing, and re-arming next_run_at
//   2. startWorkflowRun — trigger → an agent run carrying the playbook
//
// It does NOT compile the document. That lives in the editor
// (src/features/workflows/compile.ts), which always saves both faces of a
// workflow together. A second compiler here would have to stay byte-identical
// to the first through every change to the block vocabulary — a divergence
// scheduled in advance, whose failure mode is a playbook silently missing its
// delegations and its scoped context.
//
// Everything else an execution needs — the tool loop, the checklist, the
// success contract, deliverables, cost, resumption across ticks — is the agent
// runtime that already exists. Duplicating any of it here would produce a
// second, worse copy that disagrees with the first within the minute.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { callAi, safeParseJson, type ChatMessage } from "./ai.ts";
import { classifyTier, modelForTier, resolveProvider, cheapProvider } from "./model-router.ts";
import { buildInternalToolset, type AgentToolRow, type InternalToolContext } from "./internal-agent-tools.ts";
import { compileSystemPrompt, type SectionInput } from "./prompt-compiler.ts";

type Admin = SupabaseClient;
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export interface WfNode {
  id: string;
  type: string;
  position?: { x: number; y: number };
  data: Record<string, unknown>;
}
export interface WfEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}
export interface WfGraph { nodes: WfNode[]; edges: WfEdge[] }

export const normalizeGraph = (g: unknown): WfGraph => {
  const raw = (g ?? {}) as Partial<WfGraph>;
  return {
    nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
    edges: Array.isArray(raw.edges) ? raw.edges : [],
  };
};

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

/**
 * Next occurrence of a 5-field cron expression, strictly after `from`, in UTC.
 *
 * Deliberately minimal — `*`, `a`, `a,b`, `a-b` and `*​/n`. That is the whole
 * vocabulary the editor offers, and a full cron implementation would be a
 * dependency to audit for a feature nobody asked for. Returns null on anything
 * it does not understand: a null next_run_at means "never fires on its own",
 * which is far better than a wrong date.
 */
export function nextCronRun(expr: string, from: Date = new Date()): Date | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const parse = (f: string, min: number, max: number): number[] | null => {
    const out = new Set<number>();
    for (const part of f.split(",")) {
      const [range, stepRaw] = part.split("/");
      const step = stepRaw ? Number(stepRaw) : 1;
      if (!Number.isFinite(step) || step < 1) return null;
      let lo = min, hi = max;
      if (range !== "*") {
        const [a, b] = range.split("-");
        lo = Number(a); hi = b === undefined ? Number(a) : Number(b);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) return null;
      }
      for (let v = lo; v <= hi; v += step) out.add(v);
    }
    return out.size ? [...out].sort((a, b) => a - b) : null;
  };

  const minutes = parse(fields[0], 0, 59);
  const hours = parse(fields[1], 0, 23);
  const doms = parse(fields[2], 1, 31);
  const months = parse(fields[3], 1, 12);
  const dowsRaw = parse(fields[4], 0, 7); // cron accepts 0 and 7 for Sunday
  if (!minutes || !hours || !doms || !months || !dowsRaw) return null;
  const dows = [...new Set(dowsRaw.map((d) => (d === 7 ? 0 : d)))];

  const anyDom = fields[2] === "*";
  const anyDow = fields[4] === "*";

  const d = new Date(from);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1); // strictly after

  // Two years of minutes is the ceiling: no valid expression is sparser than
  // once a year, and an invalid one must terminate rather than spin.
  for (let i = 0; i < 366 * 2 * 24 * 60; i++) {
    if (
      months.includes(d.getUTCMonth() + 1) &&
      hours.includes(d.getUTCHours()) &&
      minutes.includes(d.getUTCMinutes()) &&
      // Standard cron: when BOTH day fields are restricted, either may match.
      (anyDom && anyDow ? true
        : anyDom ? dows.includes(d.getUTCDay())
        : anyDow ? doms.includes(d.getUTCDate())
        : doms.includes(d.getUTCDate()) || dows.includes(d.getUTCDay()))
    ) return d;
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  return null;
}

/** The cron expression the graph's trigger carries, if it is a scheduled one. */
export function scheduleOf(graph: WfGraph): string | null {
  const t = graph.nodes.find((n) => n.type === "trigger" && n.data?.mode === "schedule");
  return str(t?.data?.schedule).trim() || null;
}

/** Re-derive `schedule` / `next_run_at` from the blocks. The columns are a
 *  denormalised copy of what the trigger block says, and a copy that is never
 *  refreshed is a lie the scheduler acts on. */
export async function syncWorkflowSchedule(admin: Admin, workflowId: string): Promise<void> {
  const { data } = await admin.from("agent_workflows").select("status, blocks").eq("id", workflowId).maybeSingle();
  if (!data) return;
  const row = data as { status: string; blocks: unknown };
  const expr = scheduleOf(normalizeGraph(row.blocks));
  const next = row.status === "active" && expr ? nextCronRun(expr) : null;
  await admin.from("agent_workflows")
    .update({ schedule: expr, next_run_at: next ? next.toISOString() : null })
    .eq("id", workflowId);
}

// ---------------------------------------------------------------------------
// Execution — hand the playbook to the assistant
// ---------------------------------------------------------------------------

interface WorkflowRow {
  id: string; workspace_id: string; project_id: string;
  service_dashboard_id: string | null;
  name: string; description: string | null; status: string;
  blocks: WfGraph; document: string;
}

export async function startWorkflowRun(admin: Admin, opts: {
  workflowId: string;
  trigger: string;
  payload?: Record<string, unknown>;
  triggeredBy?: string | null;
}): Promise<{ runId: string } | { error: string; status: number }> {
  const { data: wfRow } = await admin.from("agent_workflows")
    .select("id, workspace_id, project_id, service_dashboard_id, name, description, status, blocks, document")
    .eq("id", opts.workflowId).maybeSingle();
  if (!wfRow) return { error: "Workflow introuvable", status: 404 };
  const wf = { ...(wfRow as WorkflowRow), blocks: normalizeGraph((wfRow as WorkflowRow).blocks) };

  // The stored document IS the playbook — the editor compiles it and saves both
  // faces together. An empty one means the workflow was never authored, and
  // running a procedure that says nothing is worse than refusing to.
  const playbook = wf.document?.trim();
  if (!playbook || wf.blocks.nodes.filter((n) => n.type !== "trigger").length === 0) {
    return { error: "Ce workflow est vide — ouvrez-le et ajoutez au moins un bloc avant de le lancer.", status: 400 };
  }

  // The executor is the service's assistant: it already knows how to read a
  // request and decide who does what, and it holds the delegation tools.
  const assistant = await findAssistant(admin, wf);
  if (!assistant) {
    return { error: "Aucun assistant trouvé pour ce service — créez-en un avant d'activer le workflow.", status: 400 };
  }

  const { data: runRow, error } = await admin.from("agent_workflow_runs").insert({
    workflow_id: wf.id, workspace_id: wf.workspace_id, project_id: wf.project_id,
    agent_id: assistant.id, status: "running",
    trigger: opts.trigger, trigger_payload: opts.payload ?? {},
    document: playbook, triggered_by: opts.triggeredBy ?? null,
  }).select("id").single();
  if (error || !runRow) return { error: error?.message ?? "Création du run impossible", status: 500 };
  const runId = (runRow as { id: string }).id;

  const agentRunId = await dispatchPlaybook(admin, wf, assistant, playbook, runId, opts.trigger);
  if (!agentRunId) {
    await admin.from("agent_workflow_runs").update({
      status: "failed", error_message: "Lancement de l'assistant impossible.",
      finished_at: new Date().toISOString(),
    }).eq("id", runId);
    return { error: "Lancement de l'assistant impossible", status: 500 };
  }

  await admin.from("agent_workflow_runs").update({ agent_run_id: agentRunId }).eq("id", runId);
  await admin.from("agent_workflows").update({ last_run_at: new Date().toISOString() }).eq("id", wf.id);
  // Re-arm: the cron cleared next_run_at before firing so a slow start could
  // not double-launch. This is what puts the next occurrence back.
  await syncWorkflowSchedule(admin, wf.id).catch(() => {});
  return { runId };
}

interface AssistantRow {
  id: string; name: string; persona: string | null; instructions: string | null;
  model: string | null; temperature: number | null; created_by: string | null;
  service_dashboard_id: string | null;
}

/** The service's orchestrator, or — failing that — any agent of the service.
 *  A workflow whose service has one agent should still run. */
async function findAssistant(admin: Admin, wf: WorkflowRow): Promise<AssistantRow | null> {
  const cols = "id, name, persona, instructions, model, temperature, created_by, service_dashboard_id";
  if (wf.service_dashboard_id) {
    const { data: orch } = await admin.from("internal_agents").select(cols)
      .eq("service_dashboard_id", wf.service_dashboard_id)
      .eq("is_orchestrator", true).eq("is_archived", false).limit(1).maybeSingle();
    if (orch) return orch as AssistantRow;
    const { data: any1 } = await admin.from("internal_agents").select(cols)
      .eq("service_dashboard_id", wf.service_dashboard_id).eq("is_archived", false).limit(1).maybeSingle();
    if (any1) return any1 as AssistantRow;
  }
  const { data: fallback } = await admin.from("internal_agents").select(cols)
    .eq("project_id", wf.project_id).eq("is_orchestrator", true).eq("is_archived", false).limit(1).maybeSingle();
  return (fallback ?? null) as AssistantRow | null;
}

/** Start the assistant on the playbook, on the durable tick engine — so a
 *  workflow that takes an hour survives the edge wall-clock like any other run. */
async function dispatchPlaybook(
  admin: Admin, wf: WorkflowRow, a: AssistantRow, playbook: string, wfRunId: string, trigger: string,
): Promise<string | null> {
  const { data: toolRows } = await admin.from("internal_agent_tools")
    .select("id, kind, name, description, config, enabled, requires_approval").eq("agent_id", a.id);

  const { data: tr } = await admin.from("internal_agent_runs").insert({
    agent_id: a.id, workspace_id: wf.workspace_id, project_id: wf.project_id,
    run_kind: "primary", status: "running", started_at: new Date().toISOString(),
    triggered_by: a.created_by ?? null,
  }).select("id").single();
  const agentRunId = (tr as { id: string } | null)?.id ?? null;
  if (!agentRunId) return null;

  const ctxStub = {
    admin, workspaceId: wf.workspace_id, projectId: wf.project_id,
    agentId: a.id, agentName: a.name,
    collaborationEnabled: true, autopilot: true, runId: agentRunId,
    missionMode: true, delegationDepth: 0,
    serviceDashboardId: a.service_dashboard_id ?? wf.service_dashboard_id,
    userId: a.created_by ?? null,
    createDeliverable: async () => {},
    requestApproval: async () => "approval-skipped-in-workflow",
    logEvent: async () => {},
    isCancelled: async () => false,
  } as unknown as InternalToolContext;
  const { capabilitySummary } = buildInternalToolset((toolRows ?? []) as AgentToolRow[], ctxStub);

  const sections: SectionInput[] = [
    {
      id: "identity",
      body: `You are ${a.name}${a.persona ? ` — ${a.persona}` : ""}, the assistant of this service. You are executing an automated workflow.`,
    },
  ];
  if (a.instructions) sections.push({ id: "instructions", body: `Your instructions:\n${a.instructions}` });
  sections.push({
    id: "doctrine",
    body: [
      "## Tu exécutes un mode opératoire",
      "Le document ci-dessous est la PROCÉDURE à suivre. Tu en es responsable de bout en bout.",
      "- Lis-la en entier AVANT d'agir, puis pose ta checklist avec update_todos.",
      "- TU DÉCIDES QUI FAIT QUOI : fais toi-même ce qui est de ton ressort, et délègue le reste à l'agent le mieux placé (list_team_agents, delegate_mission, spawn_parallel_agents). Crée un agent (create_agent) si aucun ne convient et que la procédure l'exige.",
      "- **CONFIER À** : quand une étape nomme un délégataire, cette étape lui revient — ne la fais pas à sa place.",
      "- **CONTEXTE À FOURNIR** : c'est le point le plus important. Quand une étape liste un contexte, transmets-le INTÉGRALEMENT et TEL QUEL à l'agent en même temps que la consigne — recopie les notes dans son brief, et nomme-lui les collections à consulter avec rag_search. Un agent qui reçoit la tâche sans son contexte échouera, et ce contexte n'existe QUE pour cette étape : ne le diffuse pas aux autres.",
      "- Un bloc « Contexte pour la suite » vaut à partir de son emplacement et jusqu'à la fin de la branche où il se trouve — pas avant, pas ailleurs.",
      "- **ENTRÉES** : vérifie-les AVANT d'agir. Une entrée obligatoire absente du déclenchement se demande avec ask_user tout de suite — la découvrir au milieu du travail oblige à jeter ce qui a déjà été fait.",
      "- **OUTILS À UTILISER** : la section n'ouvre pas de droits, elle en impose l'usage. Un outil marqué obligatoire doit réellement être appelé — répondre de mémoire là où la procédure dit d'aller chercher est une faute, pas un raccourci.",
      "- **PASSATION** : le brief part au(x) destinataire(s) nommé(s), avec « Ce qui doit revenir » recopié tel quel dans leur consigne. En mode parallèle, spawn_parallel_agents (une sous-tâche par destinataire) ; sinon delegate_mission, l'un après l'autre, en attendant chaque retour. Vérifie le retour contre le contrat avant d'enchaîner ; s'il ne correspond pas, redemande plutôt que de rattraper toi-même.",
      "- **À MÉMORISER** : en fin de run, et seulement si le run a produit un fait durable, enregistre-le avec save_memory — une fois, dans la portée indiquée. Un compte rendu du run n'est pas un fait durable.",
      "- Un livrable au format JSON accompagné d'un schéma doit respecter ce schéma au caractère près : il sera lu par un programme, pas par une personne.",
      "- Les règles s'appliquent à TOUTES les étapes, pas seulement à celle où elles sont écrites.",
      "- Une BOUCLE se répète jusqu'à sa condition de sortie, sans jamais dépasser le plafond d'itérations écrit. Au plafond, arrête-toi et dis que la boucle n'a pas convergé. Sur un « pour chaque » de plus d'une dizaine d'éléments, parallélise avec spawn_parallel_agents.",
      "- Une étape « Validation humaine » est un vrai point d'arrêt : demande avec ask_user et n'enchaîne qu'une fois la réponse obtenue.",
      "- Produis chaque livrable attendu avec create_deliverable avant de conclure.",
      "- Personne ne regarde en direct : ne pose de question que là où la procédure le prévoit ; partout ailleurs, décide et avance.",
      `- Déclenchement de ce run : ${trigger}.`,
    ].join("\n"),
  });
  sections.push({ id: "toolbox", body: `Your tools (full schemas are provided separately):\n${capabilitySummary}` });

  const messages: ChatMessage[] = [
    { role: "system", content: compileSystemPrompt(sections).system },
    {
      role: "user",
      content: `Exécute ce mode opératoire maintenant.\n\n---\n\n${playbook}`,
    },
  ];

  const provider = resolveProvider(a.model);
  await admin.from("internal_agent_run_state").upsert({
    run_id: agentRunId,
    mode: "chat",
    agent_id: a.id,
    conversation_id: null,
    mission_id: null,
    messages,
    round: 0,
    max_rounds: 400,
    provider,
    model: modelForTier(classifyTier(playbook, { mode: "mission" }), provider),
    processing_until: null,
    last_input_at: new Date().toISOString(),
    // The tick engine closes the workflow run when this one finishes.
    meta: { workflow_run: { id: wfRunId } },
  });
  await admin.rpc("agent_tick_enqueue", { p_run_id: agentRunId });
  return agentRunId;
}

/** The assistant's run ended — close the workflow run alongside it. */
export async function completeWorkflowRun(admin: Admin, opts: {
  workflowRunId: string; ok: boolean; error?: string;
}): Promise<void> {
  const { data } = await admin.from("agent_workflow_runs")
    .select("id, status").eq("id", opts.workflowRunId).maybeSingle();
  if (!data || (data as { status: string }).status !== "running") return; // already closed
  await admin.from("agent_workflow_runs").update({
    status: opts.ok ? "succeeded" : "failed",
    error_message: opts.ok ? null : (opts.error ?? "").slice(0, 500) || "Run interrompu.",
    finished_at: new Date().toISOString(),
  }).eq("id", opts.workflowRunId);
}

// ---------------------------------------------------------------------------
// Event triggers (migration 0198)
// ---------------------------------------------------------------------------

/**
 * Subscribe (or re-subscribe) a trigger row with the connector backend.
 *
 * Best-effort by design: a subscription that cannot be created upstream leaves
 * the row in `error` with the reason, instead of failing the whole save. The
 * person editing the workflow still has their trigger written down, and the
 * status tells them exactly what to fix — which is more useful than an
 * exception that loses their work.
 */
export async function syncEventTrigger(admin: Admin, triggerId: string): Promise<void> {
  const { data } = await admin.from("agent_workflow_triggers")
    .select("id, workspace_id, project_id, provider, event_slug, config, status, external_id")
    .eq("id", triggerId).maybeSingle();
  if (!data) return;
  const t = data as {
    id: string; workspace_id: string; project_id: string;
    provider: string; event_slug: string; config: Record<string, unknown>;
    status: string; external_id: string | null;
  };

  const fail = (detail: string) =>
    admin.from("agent_workflow_triggers")
      .update({ status: "error", status_detail: detail.slice(0, 400), updated_at: new Date().toISOString() })
      .eq("id", t.id);

  const apiKey = Deno.env.get("COMPOSIO_API_KEY");
  if (!apiKey) { await fail("COMPOSIO_API_KEY n'est pas configurée sur le backend."); return; }

  // The event arrives on the account the workspace connected — so the
  // subscription has to be created ON that account, not on the app in general.
  const { data: conn } = await admin.from("connectors")
    .select("composio_connected_account_id")
    .eq("workspace_id", t.workspace_id).eq("project_id", t.project_id)
    .eq("provider", t.provider).eq("source", "composio").eq("status", "connected")
    .limit(1).maybeSingle();
  const account = (conn as { composio_connected_account_id?: string } | null)?.composio_connected_account_id;
  if (!account) { await fail(`« ${t.provider} » n'est pas connecté via Composio dans ce projet.`); return; }

  try {
    const res = await fetch("https://backend.composio.dev/api/v3/trigger_instances", {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        connectedAccountId: account,
        triggerName: t.event_slug,
        triggerConfig: t.config ?? {},
      }),
    });
    const text = await res.text();
    if (!res.ok) { await fail(`Composio a refusé l'abonnement (HTTP ${res.status}) : ${text.slice(0, 200)}`); return; }
    let externalId: string | null = null;
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      externalId = String(j.triggerId ?? j.id ?? j.nanoId ?? "") || null;
    } catch { /* an accepted subscription with an unreadable id still works */ }

    await admin.from("agent_workflow_triggers").update({
      status: "active", status_detail: null,
      external_id: externalId ?? t.external_id,
      updated_at: new Date().toISOString(),
    }).eq("id", t.id);
  } catch (e) {
    await fail(`Abonnement impossible : ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Drop the upstream subscription. Failing here must not block the delete —
 *  an orphan subscription upstream is noise; a row we cannot remove is a bug. */
export async function removeEventTrigger(admin: Admin, triggerId: string): Promise<void> {
  const { data } = await admin.from("agent_workflow_triggers")
    .select("external_id").eq("id", triggerId).maybeSingle();
  const externalId = (data as { external_id?: string | null } | null)?.external_id;
  const apiKey = Deno.env.get("COMPOSIO_API_KEY");
  if (externalId && apiKey) {
    await fetch(`https://backend.composio.dev/api/v3/trigger_instances/manage/${externalId}`, {
      method: "DELETE", headers: { "x-api-key": apiKey },
    }).catch(() => {});
  }
  await admin.from("agent_workflow_triggers").delete().eq("id", triggerId);
}

/**
 * Route one inbound event from a connected tool to every workflow listening for
 * it.
 *
 * Three things happen here, in this order, and the order is the design:
 *
 *   1. DEDUPLICATE. Webhooks are at-least-once — a provider that does not see
 *      our 200 in time WILL resend. The unique index on
 *      (trigger_id, external_event_id) is the guard: losing the insert race
 *      means someone else already handled this event, so we stop.
 *   2. FILTER. A plain-language condition is evaluated on the payload BEFORE
 *      anything starts. Firing a whole workflow to discover the mail was a
 *      newsletter is the expensive way to answer that question.
 *   3. START, and record the outcome either way — a delivery that was filtered
 *      out is exactly what you need to see when a workflow "didn't fire".
 */
export async function routeWorkflowEvent(admin: Admin, opts: {
  provider: string;
  eventSlug: string;
  /** The provider's own id for this event — the deduplication key. */
  externalEventId: string;
  payload: Record<string, unknown>;
  /** Composio's trigger instance id, when the callback carries one. */
  externalTriggerId?: string | null;
}): Promise<{ matched: number; started: number }> {
  const provider = opts.provider.trim().toLowerCase();
  const slug = opts.eventSlug.trim();
  if (!provider || !slug) return { matched: 0, started: 0 };

  let q = admin.from("agent_workflow_triggers")
    .select("id, workflow_id, workspace_id, project_id, filter, status")
    .eq("provider", provider).eq("event_slug", slug).eq("status", "active");
  // When the callback names the subscription, trust it over the (provider,
  // event) pair: two workspaces can listen to the same event of the same app.
  if (opts.externalTriggerId) q = q.eq("external_id", opts.externalTriggerId);
  const { data: rows } = await q;
  const triggers = (rows ?? []) as Array<{
    id: string; workflow_id: string; workspace_id: string; project_id: string;
    filter: string | null; status: string;
  }>;
  if (triggers.length === 0) return { matched: 0, started: 0 };

  let started = 0;
  for (const t of triggers) {
    // 1 — claim this delivery. A duplicate loses here and goes no further.
    const { data: claim, error: claimErr } = await admin.from("workflow_event_deliveries").insert({
      trigger_id: t.id, workflow_id: t.workflow_id, workspace_id: t.workspace_id,
      external_event_id: opts.externalEventId, payload: opts.payload, outcome: "started",
    }).select("id").single();
    if (claimErr || !claim) continue; // already delivered, or unwritable
    const deliveryId = (claim as { id: string }).id;

    const close = (outcome: string, detail?: string, runId?: string) =>
      admin.from("workflow_event_deliveries")
        .update({ outcome, detail: detail?.slice(0, 500) ?? null, run_id: runId ?? null })
        .eq("id", deliveryId);

    // The workflow must still want to run.
    const { data: wf } = await admin.from("agent_workflows")
      .select("status").eq("id", t.workflow_id).maybeSingle();
    const status = (wf as { status?: string } | null)?.status;
    if (status !== "active") {
      await close("skipped", `Workflow ${status ?? "introuvable"} — non déclenché.`);
      continue;
    }

    // 2 — filter.
    if (t.filter?.trim()) {
      const verdict = await eventMatchesFilter(t.filter, opts.payload);
      if (!verdict.pass) {
        await close("filtered", verdict.reason);
        continue;
      }
    }

    // 3 — start.
    const res = await startWorkflowRun(admin, {
      workflowId: t.workflow_id,
      trigger: `${provider}:${slug}`,
      payload: { trigger: "event", provider, event: slug, data: opts.payload },
      triggeredBy: null,
    });
    if ("error" in res) await close("failed", res.error);
    else { await close("started", undefined, res.runId); started++; }
  }

  await admin.from("agent_workflow_triggers")
    .update({ last_event_at: new Date().toISOString() })
    .in("id", triggers.map((t) => t.id));

  return { matched: triggers.length, started };
}

/**
 * Does this event satisfy the trigger's condition? Written in plain language on
 * the trigger ("l'expéditeur est un client", "le message mentionne une
 * facture"), so this is a classification call — cheap by design, because it
 * runs on EVERY event, including the ones that turn out not to matter.
 *
 * An unevaluable filter PASSES: dropping a real event because a classifier was
 * unreachable is silent data loss, and a workflow that runs once too often is
 * the recoverable failure.
 */
async function eventMatchesFilter(
  filter: string, payload: Record<string, unknown>,
): Promise<{ pass: boolean; reason?: string }> {
  try {
    const res = await callAi({
      task: "classification",
      provider: cheapProvider(),
      jsonMode: true,
      maxTokens: 200,
      temperature: 0,
      systemPrompt:
        "Tu décides si un ÉVÉNEMENT satisfait une condition de déclenchement. " +
        'Réponds UNIQUEMENT par du JSON strict : {"match": true|false, "reason": "une phrase"}. ' +
        "Juge uniquement sur ce que contient réellement l'événement — une supposition est un NON.",
      userPrompt: `CONDITION : ${filter.slice(0, 500)}\n\nÉVÉNEMENT :\n${JSON.stringify(payload).slice(0, 6000)}`,
    });
    const parsed = safeParseJson<{ match?: boolean; reason?: string }>(res.content);
    if (parsed?.match === true) return { pass: true };
    return { pass: false, reason: parsed?.reason ?? "La condition n'est pas satisfaite." };
  } catch {
    return { pass: true, reason: "Filtre non évaluable — déclenché par défaut." };
  }
}
