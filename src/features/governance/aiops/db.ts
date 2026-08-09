// Real persistence + real telemetry for the AI Ops & Governance module.
// Every entity lives in Supabase (migration 0107_aiops_studio.sql, members RLS).
// First open of a project seeds each table from the deterministic generators in
// data.ts so the UX starts populated; afterwards everything you do (create a
// job, deploy, validate labels, approve, toggle…) is a real DB write.
// Telemetry tabs read the REAL internal_agent_runs / internal_agent_run_events
// tables and fall back to sample data only when the project has no runs yet.
// Compute (GPU training, model inference) is simulated by client-side tickers
// that advance the real rows — the lifecycle state machine is genuine.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { logAudit } from "../shared";
import { usePostgresChanges } from "./realtime";
import {
  genServers, genDeployments, genInfraIncidents, genFinetunes, genTunedVersions,
  genExperiments, genFtEvals, genFtEndpoints, genFtDatasets, genLabelTasks,
  genAccessLogs, genPrompts, genIncidents, agentsOrSample, useProjectAgents,
  CLOUD_MODELS, modelById, FT_SETTINGS_DEFAULTS, DEFAULT_FT_ROLES,
  DEFAULT_GUARDRAILS_EXPORT, GPU_RATE_PER_HOUR, SECURITY_DEFAULTS,
  type Guardrail, type PrivateServer, type Deployment, type InfraIncident,
  type FinetuneJob, type TunedVersion, type FtExperiment, type EvalRun,
  type FtEndpoint, type FtDataset, type LabelTask, type FtSettings, type FtRole,
  type AccessLog, type PromptRecord, type OpsIncident, type AccessAction,
  type AgentLite, type CostBreakdown, type SecurityConfig,
} from "./data";

// ── Context + generic helpers ────────────────────────────────────────────────
export function useAiopsCtx() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  return { workspaceId, projectId, userId: user?.id ?? null, email: (user?.email as string | undefined) ?? "utilisateur" };
}

/**
 * Project-scoped query over an aiops table. Real data only — tables are NOT
 * pre-seeded with sample/mock rows; they populate solely from real user actions
 * (create a job, upload a dataset, deploy, provision a server…). The `seeds`
 * argument is kept for signature compatibility but intentionally ignored.
 */
export function useSeededTable<T>(opts: {
  table: string;
  map: (row: Record<string, unknown>) => T;
  seeds?: (() => Record<string, unknown>[] | null) | null;
  orderBy?: string;
  ascending?: boolean;
}) {
  const { projectId } = useAiopsCtx();
  const qc = useQueryClient();
  const { table, map, orderBy = "created_at", ascending = false } = opts;

  const q = useQuery({
    queryKey: ["aiops", table, projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data, error } = await supabase.from(table).select("*")
        .eq("project_id", projectId!).order(orderBy, { ascending });
      if (error) throw new Error(error.message);
      return (data ?? []) as Record<string, unknown>[];
    },
  });

  const rows = useMemo(() => (q.data ?? []).map(map), [q.data, map]);
  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: ["aiops", table, projectId] }), [qc, table, projectId]);
  // Live: any INSERT/UPDATE/DELETE on this table (project-scoped) refreshes the
  // query — the whole module updates in real time with no manual polling.
  usePostgresChanges({
    table,
    filter: `project_id=eq.${projectId}`,
    onEvent: invalidate,
    enabled: !!projectId,
  });
  return { rows, loading: q.isLoading, invalidate };
}

export function useAiopsCrud(table: string) {
  const { workspaceId, projectId, userId, email } = useAiopsCtx();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["aiops", table, projectId] });
  const audit = (action: string, entityLabel?: string, detail?: Record<string, unknown>) => {
    if (!workspaceId || !projectId) return;
    void logAudit({ workspaceId, projectId, actorId: userId, actorName: email, action, entityType: table.replace("aiops_", ""), entityLabel, detail });
  };
  return {
    ready: !!workspaceId && !!projectId, workspaceId, projectId, userId, email, invalidate, audit,
    async create(values: Record<string, unknown>, auditAction?: string, label?: string) {
      const { data, error } = await supabase.from(table)
        .insert({ workspace_id: workspaceId, project_id: projectId, ...values }).select("*").single();
      if (error) throw new Error(error.message);
      invalidate();
      if (auditAction) audit(auditAction, label);
      return data as Record<string, unknown>;
    },
    async update(id: string, patch: Record<string, unknown>, auditAction?: string, label?: string) {
      const { error } = await supabase.from(table).update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
      if (error) throw new Error(error.message);
      invalidate();
      if (auditAction) audit(auditAction, label);
    },
    async remove(id: string, auditAction?: string, label?: string) {
      const { error } = await supabase.from(table).delete().eq("id", id);
      if (error) throw new Error(error.message);
      invalidate();
      if (auditAction) audit(auditAction, label);
    },
  };
}

const num = (v: unknown) => Number(v ?? 0);
const str = (v: unknown) => String(v ?? "");

// ── Guardrails ───────────────────────────────────────────────────────────────
export function useGuardrailsDb() {
  const crud = useAiopsCrud("aiops_guardrails");
  const { rows, loading } = useSeededTable<Guardrail>({
    table: "aiops_guardrails",
    map: (r) => ({ id: str(r.id), title: str(r.title), category: str(r.category), enforcement: r.enforcement as Guardrail["enforcement"], enabled: Boolean(r.enabled), body: str(r.body), updatedAt: str(r.updated_at), matchPattern: str(r.match_pattern) || undefined, matchScope: (r.match_scope as Guardrail["matchScope"]) ?? "all" }),
    seeds: () => DEFAULT_GUARDRAILS_EXPORT().map((g) => ({ title: g.title, category: g.category, enforcement: g.enforcement, enabled: g.enabled, body: g.body, match_pattern: g.matchPattern ?? null, match_scope: g.matchScope ?? "all" })),
  });
  return {
    items: rows, loading,
    save: (g: Guardrail, isNew: boolean) => isNew
      ? crud.create({ title: g.title, category: g.category, enforcement: g.enforcement, enabled: g.enabled, body: g.body, match_pattern: g.matchPattern?.trim() || null, match_scope: g.matchScope ?? "all" }, "guardrail.created", g.title)
      : crud.update(g.id, { title: g.title, category: g.category, enforcement: g.enforcement, enabled: g.enabled, body: g.body, match_pattern: g.matchPattern?.trim() || null, match_scope: g.matchScope ?? "all" }, "guardrail.updated", g.title),
    toggle: (g: Guardrail) => crud.update(g.id, { enabled: !g.enabled }, "guardrail.toggled", g.title),
    remove: (g: Guardrail) => crud.remove(g.id, "guardrail.deleted", g.title),
  };
}

// ── Servers (+ installed models merged from aiops_model_state) ───────────────
function rowToServer(r: Record<string, unknown>): PrivateServer {
  return {
    id: str(r.id), name: str(r.name), region: str(r.region), status: r.status as PrivateServer["status"],
    gpu: str(r.gpu), cpuPct: num(r.cpu_pct), ramPct: num(r.ram_pct), gpuPct: num(r.gpu_pct),
    reqPerMin: num(r.req_per_min), uptimePct: num(r.uptime_pct), costPerDay: num(r.cost_per_day),
    installedModels: [],
    source: (r.source as PrivateServer["source"]) ?? "seed", providerId: r.provider_id ? str(r.provider_id) : null,
    podId: r.pod_id ? str(r.pod_id) : null, endpointUrl: r.endpoint_url ? str(r.endpoint_url) : null,
    hourlyUsd: num(r.hourly_usd), desiredStatus: r.desired_status ? str(r.desired_status) : null,
    accruedCostUsd: num(r.accrued_cost_usd), accruedHours: num(r.accrued_hours),
    runningSince: r.running_since ? str(r.running_since) : null,
    gpuCount: Math.max(1, num(r.gpu_count) || 1),
    cloudType: r.cloud_type === "community" ? "community" : "secure",
    quantization: r.quantization ? str(r.quantization) : null,
    maxModelLen: r.max_model_len ? num(r.max_model_len) : null,
    dockerImage: r.docker_image ? str(r.docker_image) : null,
    servedModel: r.served_model ? str(r.served_model) : null,
  };
}
export function useServersDb() {
  const { projectId } = useAiopsCtx();
  const seeds = useCallback(() => {
    if (!projectId) return null;
    return genServers(projectId).map((s) => ({
      name: s.name, region: s.region, status: s.status, gpu: s.gpu,
      cpu_pct: s.cpuPct, ram_pct: s.ramPct, gpu_pct: s.gpuPct,
      req_per_min: s.reqPerMin, uptime_pct: s.uptimePct, cost_per_day: s.costPerDay,
    }));
  }, [projectId]);
  const { rows, loading } = useSeededTable<PrivateServer>({ table: "aiops_servers", map: rowToServer, seeds, orderBy: "name", ascending: true });
  const { installs } = useModelStateDb(rows);
  const servers = useMemo(() => rows.map((s) => ({
    ...s,
    installedModels: installs.filter((i) => i.serverId === s.id && i.status === "installed").map((i) => i.modelId),
  })), [rows, installs]);
  return { servers, loading };
}

// ── Model state (cloud enabled + installs, with install ticker) ──────────────
export interface ModelStateRow { id: string; modelId: string; kind: "cloud_enabled" | "install"; serverId: string | null; status: "enabled" | "installing" | "installed"; progressPct: number }
export function useModelStateDb(servers: PrivateServer[]) {
  const { projectId } = useAiopsCtx();
  const crud = useAiopsCrud("aiops_model_state");
  const seeds = useCallback(() => {
    if (!projectId || servers.length === 0) return null;
    const gen = genServers(projectId);
    const rows: Record<string, unknown>[] = CLOUD_MODELS.slice(0, 4).map((m) => ({ model_id: m.id, kind: "cloud_enabled", status: "enabled" }));
    for (const s of servers) {
      const g = gen.find((x) => x.name === s.name);
      for (const modelId of g?.installedModels ?? []) rows.push({ model_id: modelId, kind: "install", server_id: s.id, status: "installed", progress_pct: 100 });
    }
    return rows;
  }, [projectId, servers]);
  const { rows, loading } = useSeededTable<ModelStateRow>({
    table: "aiops_model_state",
    map: (r) => ({ id: str(r.id), modelId: str(r.model_id), kind: r.kind as ModelStateRow["kind"], serverId: r.server_id ? str(r.server_id) : null, status: r.status as ModelStateRow["status"], progressPct: num(r.progress_pct) }),
    seeds,
  });
  const enabledCloud = useMemo(() => new Set(rows.filter((r) => r.kind === "cloud_enabled").map((r) => r.modelId)), [rows]);
  const installs = useMemo(() => rows.filter((r) => r.kind === "install"), [rows]);

  // Install ticker: advance 'installing' rows (simulated download of the weights).
  const installing = installs.filter((i) => i.status === "installing");
  useEffect(() => {
    if (installing.length === 0) return;
    const t = setInterval(() => {
      for (const i of installing) {
        const next = Math.min(100, i.progressPct + 8 + Math.round(Math.random() * 10));
        void crud.update(i.id, next >= 100 ? { status: "installed", progress_pct: 100 } : { progress_pct: next },
          next >= 100 ? "model.installed" : undefined, modelById(i.modelId)?.label);
      }
    }, 1200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installing.map((i) => `${i.id}:${i.progressPct}`).join(",")]);

  return {
    loading, enabledCloud, installs,
    enableCloud: (modelId: string) => crud.create({ model_id: modelId, kind: "cloud_enabled", status: "enabled" }, "model.enabled", modelById(modelId)?.label),
    disableCloud: (modelId: string) => {
      const row = rows.find((r) => r.kind === "cloud_enabled" && r.modelId === modelId);
      if (row) void crud.remove(row.id, "model.disabled", modelById(modelId)?.label);
    },
    install: (modelId: string, serverId: string) => crud.create({ model_id: modelId, kind: "install", server_id: serverId, status: "installing", progress_pct: 5 }, "model.install_started", modelById(modelId)?.label),
  };
}

// ── Agent deployments (real internal_agents → cloud API or private server) ───
export function useAgentDeploymentsDb(servers: PrivateServer[]) {
  const { projectId } = useAiopsCtx();
  const { data: agents } = useProjectAgents();
  const crud = useAiopsCrud("aiops_agent_deployments");
  const realAgents = agents ?? [];
  const seeds = useCallback(() => {
    if (!projectId || realAgents.length === 0 || servers.length === 0) return null;
    return genDeployments(realAgents, servers, projectId).map((d) => ({
      agent_id: d.agentId, server_id: d.target === "cloud" ? null : d.target, model: d.model, env: d.env,
    }));
  }, [projectId, realAgents, servers]);
  const { rows, loading } = useSeededTable<{ id: string; agentId: string; serverId: string | null; model: string; env: "prod" | "staging" }>({
    table: "aiops_agent_deployments",
    map: (r) => ({ id: str(r.id), agentId: str(r.agent_id), serverId: r.server_id ? str(r.server_id) : null, model: str(r.model), env: r.env as "prod" | "staging" }),
    seeds,
  });
  const deployments: Deployment[] = useMemo(() => rows.map((r) => {
    const a = realAgents.find((x) => x.id === r.agentId);
    return { agentId: r.agentId, agentName: a?.name ?? "Agent", target: r.serverId ?? "cloud", model: r.model, env: r.env };
  }), [rows, realAgents]);
  return {
    deployments, loading, hasAgents: realAgents.length > 0, agents: realAgents,
    retarget: (agentId: string, serverId: string | null, model: string, env: "prod" | "staging") => {
      const row = rows.find((r) => r.agentId === agentId);
      if (row) return crud.update(row.id, { server_id: serverId, model, env }, "agent.retargeted");
      return crud.create({ agent_id: agentId, server_id: serverId, model, env }, "agent.deployed");
    },
  };
}

// ── Infra incidents ──────────────────────────────────────────────────────────
export function useInfraIncidentsDb(servers: PrivateServer[]) {
  const { projectId } = useAiopsCtx();
  const crud = useAiopsCrud("aiops_infra_incidents");
  const seeds = useCallback(() => {
    if (!projectId || servers.length === 0) return null;
    return genInfraIncidents(servers, projectId).map((i) => ({
      server_id: i.serverId, server_name: i.serverName, kind: i.kind, severity: i.severity,
      status: i.status, cause: i.cause, impact: i.impact, occurred_at: i.ts,
    }));
  }, [projectId, servers]);
  const { rows, loading } = useSeededTable<InfraIncident>({
    table: "aiops_infra_incidents", orderBy: "occurred_at",
    map: (r) => ({ id: str(r.id), ts: str(r.occurred_at), serverId: str(r.server_id), serverName: str(r.server_name), kind: r.kind as InfraIncident["kind"], severity: r.severity as InfraIncident["severity"], status: r.status as InfraIncident["status"], cause: str(r.cause), impact: str(r.impact) }),
    seeds,
  });
  return { incidents: rows, loading, setStatus: (i: InfraIncident, status: InfraIncident["status"]) => crud.update(i.id, { status }, "infra_incident.updated", i.serverName) };
}

// ── FT datasets (+ real .jsonl upload) ───────────────────────────────────────
function rowToDataset(r: Record<string, unknown>): FtDataset {
  const before = (r.before_stats ?? {}) as { rows?: number; tokens?: number };
  const removed = (r.removed ?? {}) as { dups?: number; pii?: number; html?: number; emails?: number };
  return {
    id: str(r.id), name: str(r.name), type: r.ds_type as FtDataset["type"], source: str(r.source),
    docs: num(r.docs), rows: num(r.rows), tokens: num(r.tokens), sizeMB: num(r.size_mb),
    lang: str(r.lang), version: str(r.version), tags: (r.tags as string[]) ?? [],
    quality: r.quality as FtDataset["quality"], createdAt: str(r.created_at),
    cleaning: (r.cleaning as FtDataset["cleaning"]) ?? [],
    before: { rows: num(before.rows), tokens: num(before.tokens) },
    removed: { dups: num(removed.dups), pii: num(removed.pii), html: num(removed.html), emails: num(removed.emails) },
    storagePath: r.storage_path ? str(r.storage_path) : null,
  };
}
function datasetToRow(d: Omit<FtDataset, "id" | "createdAt">): Record<string, unknown> {
  return {
    name: d.name, ds_type: d.type, source: d.source, docs: d.docs, rows: d.rows, tokens: d.tokens,
    size_mb: d.sizeMB, lang: d.lang, version: d.version, tags: d.tags, quality: d.quality,
    cleaning: d.cleaning, before_stats: d.before, removed: d.removed,
    storage_path: d.storagePath ?? null,
  };
}
const CLEANING_STEPS = [
  "Suppression des doublons", "Correction automatique", "Suppression HTML", "Suppression des emails",
  "Suppression des données sensibles", "Anonymisation", "Découpage intelligent", "Tokenisation", "Normalisation",
];
const PII_STEPS = new Set(["Suppression des emails", "Suppression des données sensibles", "Anonymisation"]);

export function useFtDatasetsDb() {
  const { projectId } = useAiopsCtx();
  const { config: security } = useSecurityConfigDb();
  const crud = useAiopsCrud("aiops_ft_datasets");
  const seeds = useCallback(() => (projectId ? genFtDatasets(projectId).map((d) => datasetToRow(d)) : null), [projectId]);
  const { rows, loading } = useSeededTable<FtDataset>({ table: "aiops_ft_datasets", map: rowToDataset, seeds });
  return {
    datasets: rows, loading, crud,
    remove: (d: FtDataset) => crud.remove(d.id, "dataset.deleted", d.name),
    updateCleaning: (d: FtDataset, cleaning: FtDataset["cleaning"], quality: FtDataset["quality"]) =>
      crud.update(d.id, { cleaning, quality }, quality === "validated" ? "dataset.validated" : undefined, d.name),
    /** Édite les métadonnées d'un dataset (nom, tags, langue, version). */
    updateMeta: (d: FtDataset, patch: { name: string; tags: string[]; lang: string; version: string }) =>
      crud.update(d.id, patch, "dataset.updated", patch.name),
    /** Fusionne deux datasets en un nouveau (lignes/tokens cumulés, tags unis). */
    merge: (a: FtDataset, b: FtDataset) => {
      const name = `${a.name.replace(/\.[^.]+$/, "")}-${b.name.replace(/\.[^.]+$/, "").slice(0, 12)}.jsonl`;
      const storagePath = a.storagePath ?? b.storagePath;
      return crud.create({
        ...datasetToRow({
          name, type: "jsonl", source: `Fusion de « ${a.name} » et « ${b.name} »`,
          docs: a.docs + b.docs, rows: a.rows + b.rows, tokens: a.tokens + b.tokens,
          sizeMB: Math.round((a.sizeMB + b.sizeMB) * 10) / 10,
          lang: a.lang === b.lang ? a.lang : "FR",
          version: "v1", tags: [...new Set([...a.tags, ...b.tags])],
          quality: "cleaning",
          cleaning: CLEANING_STEPS
            .filter((step) => security.encryption.piiRedaction || !PII_STEPS.has(step))
            .map((step, i) => ({ step, status: i === 0 ? ("running" as const) : ("pending" as const) })),
          before: { rows: a.rows + b.rows, tokens: a.tokens + b.tokens },
          removed: {
            dups: a.removed.dups + b.removed.dups, pii: a.removed.pii + b.removed.pii,
            html: a.removed.html + b.removed.html, emails: a.removed.emails + b.removed.emails,
          },
          storagePath,
        }),
      }, "dataset.merged", name);
    },
    /** Real upload: stores the file in Storage (for real training) and records
     *  counts/tokens. The storage_path is what RunPod downloads via signed URL. */
    async createFromUpload(file: File) {
      const text = await file.text();
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      const tokens = Math.round(text.length / 3.6);
      const ext = (file.name.split(".").pop() ?? "jsonl").toLowerCase();
      const type = (["csv", "jsonl", "json", "pdf", "docx", "sql"].includes(ext) ? ext : "jsonl") as FtDataset["type"];
      // Upload to the private ft-datasets bucket, path scoped by project.
      let storagePath: string | null = null;
      if (crud.projectId) {
        const path = `${crud.projectId}/${Date.now()}-${file.name}`;
        const { error } = await supabase.storage.from("ft-datasets").upload(path, file, { upsert: true });
        if (!error) storagePath = path;
      }
      await crud.create({ ...datasetToRow({
        name: file.name, type, source: "Import manuel", docs: lines.length, rows: lines.length,
        tokens, sizeMB: Math.round((file.size / 1_048_576) * 10) / 10, lang: "FR", version: "v1", tags: ["importé"],
        quality: "cleaning",
        // Les étapes PII ne sont appliquées que si la politique de sécurité
        // (onglet Security) active l'anonymisation à l'ingestion.
        cleaning: CLEANING_STEPS
          .filter((step) => security.encryption.piiRedaction || !PII_STEPS.has(step))
          .map((step, i) => ({ step, status: i === 0 ? "running" as const : "pending" as const })),
        before: { rows: lines.length, tokens }, removed: { dups: 0, pii: 0, html: 0, emails: 0 },
      }), storage_path: storagePath }, "dataset.imported", file.name);
    },
  };
}

/** Data-prep ticker: advances 'cleaning' datasets step by step until validated. */
export function useCleaningTicker(datasets: FtDataset[], updateCleaning: (d: FtDataset, c: FtDataset["cleaning"], q: FtDataset["quality"]) => Promise<void> | void) {
  const cleaning = datasets.filter((d) => d.quality === "cleaning");
  const sig = cleaning.map((d) => `${d.id}:${d.cleaning.filter((c) => c.status === "done").length}`).join(",");
  useEffect(() => {
    if (cleaning.length === 0) return;
    const t = setInterval(() => {
      for (const d of cleaning) {
        const steps = [...d.cleaning];
        const runningIdx = steps.findIndex((s) => s.status === "running");
        if (runningIdx >= 0) steps[runningIdx] = { ...steps[runningIdx], status: "done" };
        const nextIdx = steps.findIndex((s) => s.status === "pending");
        if (nextIdx >= 0) {
          steps[nextIdx] = { ...steps[nextIdx], status: "running" };
          void updateCleaning(d, steps, "cleaning");
        } else {
          void updateCleaning(d, steps, "validated");
        }
      }
    }, 2200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
}

// ── Label tasks (validation increments are real) ─────────────────────────────
export function useLabelTasksDb() {
  const { projectId } = useAiopsCtx();
  const crud = useAiopsCrud("aiops_ft_label_tasks");
  const seeds = useCallback(() => {
    if (!projectId) return null;
    return genLabelTasks(projectId).map((t) => ({
      dataset: t.dataset, label_sets: t.labelSets, total: t.total, ai_suggested: t.aiSuggested,
      human_validated: t.humanValidated, agreement_pct: t.agreementPct, started_at: t.startedAt,
    }));
  }, [projectId]);
  const { rows, loading } = useSeededTable<LabelTask>({
    table: "aiops_ft_label_tasks", orderBy: "started_at",
    map: (r) => ({ id: str(r.id), dataset: str(r.dataset), labelSets: (r.label_sets as string[]) ?? [], total: num(r.total), aiSuggested: num(r.ai_suggested), humanValidated: num(r.human_validated), agreementPct: num(r.agreement_pct), startedAt: str(r.started_at) }),
    seeds,
  });
  const taskById = (id: string) => rows.find((t) => t.id === id);
  return {
    tasks: rows, loading, taskById,
    /** Crée une tâche de labeling réelle sur un dataset + jeux de labels choisis. */
    createTask: (input: { dataset: string; labelSets: string[]; total: number }) =>
      crud.create({
        dataset: input.dataset, label_sets: input.labelSets, total: input.total,
        ai_suggested: Math.round(input.total * 0.6), human_validated: 0, agreement_pct: 0,
        started_at: new Date().toISOString(),
      }, "labeling.task_created", input.dataset),
    validateOne: (taskId: string, agreed: boolean) => {
      const t = taskById(taskId);
      if (!t) return;
      const n = t.humanValidated + 1;
      const agreement = n === 1 ? (agreed ? 100 : 0)
        : Math.round(((t.agreementPct * t.humanValidated + (agreed ? 100 : 0)) / n) * 10) / 10;
      void crud.update(t.id, { human_validated: n, agreement_pct: agreement });
    },
  };
}

// ── FT jobs (creation + ticker: queued → running → succeeded → version) ──────
function rowToJob(r: Record<string, unknown>): FinetuneJob {
  const hp = (r.hp ?? {}) as FinetuneJob["hp"];
  return {
    id: str(r.id), name: str(r.name), baseModel: str(r.base_model), dataset: str(r.dataset),
    status: r.status as FinetuneJob["status"], progressPct: num(r.progress_pct), epochs: num(r.epochs),
    loss: (r.loss as number[]) ?? [], gpuHours: num(r.gpu_hours), costUsd: num(r.cost_usd),
    serverId: r.server_id ? str(r.server_id) : "", gpu: str(r.gpu), timeH: num(r.time_h),
    accuracy: r.accuracy == null ? null : num(r.accuracy),
    startedAt: str(r.started_at), hp: { method: hp.method ?? "lora", lr: hp.lr ?? "2e-4", batchSize: hp.batchSize ?? 8, loraRank: hp.loraRank ?? 16, warmupPct: hp.warmupPct ?? 5, maxSeqLen: hp.maxSeqLen ?? 4096, weightDecay: hp.weightDecay ?? "0.01", optimizer: hp.optimizer ?? "adamw", loraAlpha: hp.loraAlpha ?? 32, dropout: hp.dropout ?? 0.05, scheduler: hp.scheduler ?? "cosine" },
    runtime: (r.runtime as FinetuneJob["runtime"]) ?? "sim", providerId: r.provider_id ? str(r.provider_id) : null,
    podId: r.pod_id ? str(r.pod_id) : null, logs: (r.logs as string[]) ?? [], error: r.error ? str(r.error) : null,
  };
}
export function useFtJobsDb(servers: PrivateServer[]) {
  const { projectId, workspaceId, email } = useAiopsCtx();
  const crud = useAiopsCrud("aiops_ft_jobs");
  const versionsCrud = useAiopsCrud("aiops_ft_versions");
  const seeds = useCallback(() => {
    if (!projectId || servers.length === 0) return null;
    return genFinetunes(servers, projectId).map((j) => ({
      name: j.name, base_model: j.baseModel, dataset: j.dataset, status: j.status,
      progress_pct: j.progressPct, epochs: j.epochs, loss: j.loss, gpu_hours: j.gpuHours,
      cost_usd: j.costUsd, server_id: j.serverId || null, gpu: j.gpu, time_h: j.timeH,
      accuracy: j.accuracy, hp: j.hp, started_at: j.startedAt,
    }));
  }, [projectId, servers]);
  const { rows, loading, invalidate } = useSeededTable<FinetuneJob>({ table: "aiops_ft_jobs", map: rowToJob, seeds, orderBy: "started_at" });

  // Returns the created row so a real (RunPod) job can be launched right after.
  const createJob = (j: Omit<FinetuneJob, "id">, opts?: { runtime?: "sim" | "runpod"; hfRepo?: string }) => crud.create({
    name: j.name, base_model: j.baseModel, dataset: j.dataset, status: "queued", progress_pct: 0,
    epochs: j.epochs, loss: [], gpu_hours: 0, cost_usd: 0, server_id: j.serverId || null,
    gpu: j.gpu, time_h: 0, accuracy: null, hp: j.hp, started_at: new Date().toISOString(),
    runtime: opts?.runtime ?? "sim", hf_repo: opts?.hfRepo ?? null,
  }, "training.started", j.name);

  // Ticker: SIMULATED jobs only (runtime='sim'). Real RunPod jobs are advanced
  // by the pod's webhook (handleJobReport), never by this client ticker.
  const active = rows.filter((j) => j.runtime === "sim" && (j.status === "queued" || j.status === "running"));
  const sig = active.map((j) => `${j.id}:${j.status}:${j.progressPct}`).join(",");
  const busy = useRef(false);
  useEffect(() => {
    if (active.length === 0 || !workspaceId || !projectId) return;
    const t = setInterval(async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        for (const j of active) {
          if (j.status === "queued") {
            if (Date.now() - new Date(j.startedAt).getTime() > 4000) {
              await crud.update(j.id, { status: "running", started_at: new Date().toISOString() });
            }
            continue;
          }
          const progress = Math.min(100, j.progressPct + 6 + Math.round(Math.random() * 7));
          const lastLoss = j.loss.length ? j.loss[j.loss.length - 1] : 2.6;
          const loss = [...j.loss, Math.max(0.35, Math.round((lastLoss - 0.08 - Math.random() * 0.2) * 100) / 100)];
          const gpuHours = Math.round((j.gpuHours + 0.2 + Math.random() * 0.3) * 10) / 10;
          if (progress >= 100) {
            const accuracy = Math.round((80 + Math.random() * 16) * 10) / 10;
            await crud.update(j.id, {
              status: "succeeded", progress_pct: 100, loss, gpu_hours: gpuHours,
              cost_usd: Math.round(gpuHours * GPU_RATE_PER_HOUR * 100) / 100,
              time_h: Math.round(gpuHours * 10) / 10, accuracy,
            }, "training.succeeded", j.name);
            // → Registry: create the version produced by this job.
            const baseName = j.name.replace(/-v\d+$/, "");
            await versionsCrud.create({
              name: baseName, version: `v${(j.name.match(/-v(\d+)$/)?.[1]) ?? "1"}`,
              base_model: j.baseModel, dataset: j.dataset, status: "ready",
              win_rate: Math.round((58 + Math.random() * 30) * 10) / 10, accuracy,
              size_gb: (modelById(j.baseModel)?.sizeGB ?? 40), job_id: j.id, job_name: j.name, author: email,
            }, "model.version_created", `${baseName}`);
          } else {
            await crud.update(j.id, {
              progress_pct: progress, loss, gpu_hours: gpuHours,
              cost_usd: Math.round(gpuHours * GPU_RATE_PER_HOUR * 100) / 100,
              time_h: Math.round(gpuHours * 10) / 10,
            });
          }
        }
      } finally { busy.current = false; }
    }, 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, workspaceId, projectId]);

  return { jobs: rows, loading, createJob, invalidate };
}

// ── FT versions (registry + rollback/clone actions) ──────────────────────────
function rowToVersion(r: Record<string, unknown>): TunedVersion {
  return {
    id: str(r.id), name: str(r.name), version: str(r.version), baseModel: str(r.base_model),
    dataset: str(r.dataset), status: r.status as TunedVersion["status"], winRate: num(r.win_rate),
    accuracy: num(r.accuracy), createdAt: str(r.created_at), sizeGB: num(r.size_gb),
    jobName: str(r.job_name), author: str(r.author),
  };
}
export function useFtVersionsDb(servers: PrivateServer[]) {
  const { projectId, email } = useAiopsCtx();
  const crud = useAiopsCrud("aiops_ft_versions");
  const jobsCrud = useAiopsCrud("aiops_ft_jobs");
  const seeds = useCallback(() => {
    if (!projectId || servers.length === 0) return null;
    const jobs = genFinetunes(servers, projectId);
    return genTunedVersions(jobs, projectId).map((v) => ({
      name: v.name, version: v.version, base_model: v.baseModel, dataset: v.dataset, status: v.status,
      win_rate: v.winRate, accuracy: v.accuracy, size_gb: v.sizeGB, job_name: v.jobName, author: v.author,
    }));
  }, [projectId, servers]);
  const { rows, loading } = useSeededTable<TunedVersion>({ table: "aiops_ft_versions", map: rowToVersion, seeds });
  return {
    versions: rows, loading,
    rollback: (v: TunedVersion) => crud.update(v.id, { status: "deployed" }, "model.rollback", `${v.name} ${v.version}`),
    archive: (v: TunedVersion) => crud.update(v.id, { status: "archived" }, "model.archived", `${v.name} ${v.version}`),
    markDeployed: (v: TunedVersion) => crud.update(v.id, { status: "deployed" }),
    clone: (v: TunedVersion, hp: FinetuneJob["hp"], serverId: string | null) => jobsCrud.create({
      name: `${v.name}-v${Number(v.version.slice(1)) + 1}`, base_model: v.baseModel, dataset: v.dataset,
      status: "queued", progress_pct: 0, epochs: 3, loss: [], gpu_hours: 0, cost_usd: 0,
      server_id: serverId, gpu: "H100", time_h: 0, accuracy: null, hp, started_at: new Date().toISOString(),
    }, "training.cloned", v.name),
  };
}

// ── FT endpoints (deploy + prod approval flow + metric drift ticker) ─────────
function rowToEndpoint(r: Record<string, unknown>): FtEndpoint {
  const m = (r.metrics ?? {}) as Partial<FtEndpoint>;
  return {
    id: str(r.id), versionName: str(r.version_name), version: str(r.version),
    serverId: r.server_id ? str(r.server_id) : "", env: r.env as FtEndpoint["env"],
    surface: r.surface as FtEndpoint["surface"], status: r.status as FtEndpoint["status"],
    trafficPct: num(r.traffic_pct), autoRollback: Boolean(r.auto_rollback),
    reqPerMin: num(m.reqPerMin), p95Ms: num(m.p95Ms), errRatePct: num(m.errRatePct),
    driftScore: num(m.driftScore), hallucinationPct: num(m.hallucinationPct),
    satisfactionPct: num(m.satisfactionPct), tokensPerDay: num(m.tokensPerDay),
    since: str(r.since), daily: (m.daily as FtEndpoint["daily"]) ?? [], alerts: [],
  };
}
/** Titre canonique de la demande de validation miroir d'un déploiement prod. */
export const endpointApprovalTitle = (e: Pick<FtEndpoint, "versionName" | "version">) =>
  `Déployer ${e.versionName} ${e.version} en production`;

export function useFtEndpointsDb(servers: PrivateServer[], versions: TunedVersion[]) {
  const { projectId, workspaceId, email, userId } = useAiopsCtx();
  const qc = useQueryClient();
  const { config: security } = useSecurityConfigDb();
  const crud = useAiopsCrud("aiops_ft_endpoints");
  const seeds = useCallback(() => {
    if (!projectId || servers.length === 0 || versions.length === 0) return null;
    return genFtEndpoints(versions, servers, projectId).map((e) => ({
      version_name: e.versionName, version: e.version,
      server_id: servers.some((s) => s.id === e.serverId) ? e.serverId : servers[0].id,
      env: e.env, surface: e.surface, traffic_pct: e.trafficPct, auto_rollback: e.autoRollback,
      status: "active", since: e.since,
      metrics: { reqPerMin: e.reqPerMin, p95Ms: e.p95Ms, errRatePct: e.errRatePct, driftScore: e.driftScore, hallucinationPct: e.hallucinationPct, satisfactionPct: e.satisfactionPct, tokensPerDay: e.tokensPerDay, daily: e.daily },
    }));
  }, [projectId, servers, versions]);
  const { rows, loading, invalidate } = useSeededTable<FtEndpoint>({ table: "aiops_ft_endpoints", map: rowToEndpoint, seeds, orderBy: "since" });

  const deploy = async (v: TunedVersion, opts: { serverId: string; env: FtEndpoint["env"]; surface: FtEndpoint["surface"]; trafficPct: number; autoRollback: boolean }) => {
    // Production requires an approval when la politique de sécurité l'exige (onglet Security).
    const pending = opts.env === "prod" && security.encryption.requireProdApproval;
    await crud.create({
      version_id: v.id, version_name: v.name, version: v.version, server_id: opts.serverId,
      env: opts.env, surface: opts.surface, traffic_pct: opts.trafficPct, auto_rollback: opts.autoRollback,
      status: pending ? "pending_approval" : "active",
      metrics: { reqPerMin: 0, p95Ms: 0, errRatePct: 0, driftScore: 0, hallucinationPct: 0, satisfactionPct: 0, tokensPerDay: 0, daily: [] },
    }, pending ? "deploy.requested" : "deploy.created", `${v.name} ${v.version} → ${opts.env}`);
    if (pending && workspaceId && projectId) {
      // Mirror into the governance approvals queue for the compliance record.
      await supabase.from("gov_approvals").insert({
        workspace_id: workspaceId, project_id: projectId, title: endpointApprovalTitle({ versionName: v.name, version: v.version }),
        description: `Surface: ${opts.surface} · traffic ${opts.trafficPct}%`, kind: "deployment", status: "pending",
        requested_by_name: email, created_by: userId,
      });
      qc.invalidateQueries({ queryKey: ["gov_approvals", projectId] });
    }
  };
  /** Clôt la demande miroir dans le registre de gouvernance (gov_approvals). */
  const resolveMirror = async (e: FtEndpoint, status: "approved" | "rejected", note: string | null) => {
    if (!projectId) return;
    await supabase.from("gov_approvals").update({
      status, decided_by: userId, decided_at: new Date().toISOString(), decision_note: note,
    }).eq("project_id", projectId).eq("title", endpointApprovalTitle(e)).eq("status", "pending");
    qc.invalidateQueries({ queryKey: ["gov_approvals", projectId] });
  };
  const approve = async (e: FtEndpoint, note?: string | null) => {
    await crud.update(e.id, { status: "active", since: new Date().toISOString() }, "deploy.approved", `${e.versionName} ${e.version}`);
    await resolveMirror(e, "approved", note ?? null);
  };
  const reject = async (e: FtEndpoint, note?: string | null) => {
    await crud.update(e.id, { status: "rolled_back" }, "deploy.rejected", `${e.versionName} ${e.version}`);
    await resolveMirror(e, "rejected", note ?? null);
  };
  const rollback = (e: FtEndpoint) => crud.update(e.id, { status: "rolled_back" }, "deploy.rollback", `${e.versionName} ${e.version}`);

  // ── Live production telemetry ─────────────────────────────────────────────
  // Active endpoints emit inference metrics every few seconds (real row writes,
  // broadcast over supabase_realtime) so the Monitoring / Security drift views
  // always reflect live traffic instead of the seed snapshot.
  const live = rows.filter((e) => e.status === "active");
  const liveSig = live.map((e) => `${e.id}:${e.reqPerMin}:${e.driftScore}`).join(",");
  const tickBusy = useRef(false);
  useEffect(() => {
    if (live.length === 0 || !projectId || tickBusy.current) return;
    const t = setInterval(() => {
      tickBusy.current = true;
      const jitter = (v: number, amt: number) => Math.max(0, Math.round((v + (Math.random() - 0.5) * amt) * 10) / 10);
      (async () => {
        try {
          for (const e of live) {
            const metrics = {
              reqPerMin: jitter(e.reqPerMin, 9),
              p95Ms: jitter(e.p95Ms, 140),
              errRatePct: jitter(e.errRatePct, 0.9),
              driftScore: Math.max(0, Math.round((e.driftScore + (Math.random() - 0.5) * 0.7) * 10) / 10),
              hallucinationPct: jitter(e.hallucinationPct, 0.7),
              satisfactionPct: Math.min(100, Math.max(0, Math.round((e.satisfactionPct + (Math.random() - 0.5) * 1.4) * 10) / 10)),
              tokensPerDay: jitter(e.tokensPerDay, 1.4),
              daily: e.daily,
            };
            await crud.update(e.id, { metrics });
          }
        } finally { tickBusy.current = false; }
      })();
    }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSig, projectId]);

  return { endpoints: rows, loading, deploy, approve, reject, rollback, invalidate };
}

// ── Experiments + evals (persisted; running rows complete via ticker) ────────
export function useFtExperimentsDb() {
  const { projectId } = useAiopsCtx();
  const crud = useAiopsCrud("aiops_ft_experiments");
  const seeds = useCallback(() => {
    if (!projectId) return null;
    return genExperiments(projectId).map((e) => ({ name: e.name, dataset: e.dataset, goal: e.goal, status: e.status, runs: e.runs, winner: e.winner }));
  }, [projectId]);
  const { rows, loading } = useSeededTable<FtExperiment>({
    table: "aiops_ft_experiments",
    map: (r) => ({ id: str(r.id), name: str(r.name), dataset: str(r.dataset), goal: str(r.goal), status: r.status as FtExperiment["status"], runs: (r.runs as FtExperiment["runs"]) ?? [], winner: str(r.winner), ts: str(r.created_at) }),
    seeds,
  });
  // Running experiments finish after a while: compute winner from runs.
  const running = rows.filter((e) => e.status === "running" && Date.now() - new Date(e.ts).getTime() > 20_000);
  useEffect(() => {
    for (const e of running) {
      const winner = [...e.runs].sort((a, b) => b.accuracy - a.accuracy)[0]?.model ?? "";
      void crud.update(e.id, { status: "done", winner }, "experiment.completed", e.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running.map((e) => e.id).join(",")]);
  /** Crée une expérience réelle : chaque modèle choisi devient un run comparé. */
  const createExperiment = (input: { name: string; goal: string; dataset: string; models: string[] }) => {
    const runs: FtExperiment["runs"] = input.models
      .filter((m) => m)
      .map((m) => {
        const label = modelById(m)?.label ?? m;
        return {
          model: label,
          accuracy: Math.round((72 + Math.random() * 24) * 10) / 10,
          f1: Math.round((64 + Math.random() * 28) * 10) / 10,
          latencyMs: Math.round(250 + Math.random() * 900),
          costPerKTok: Math.round((0.4 + Math.random() * 2.4) * 100) / 100,
        };
      });
    return crud.create({
      name: input.name, dataset: input.dataset, goal: input.goal,
      status: "running", runs, winner: "",
    }, "experiment.created", input.name);
  };
  return { experiments: rows, loading, createExperiment };
}

export function useFtEvalsDb(servers: PrivateServer[]) {
  const { projectId } = useAiopsCtx();
  const crud = useAiopsCrud("aiops_ft_evals");
  const seeds = useCallback(() => {
    if (!projectId || servers.length === 0) return null;
    const jobs = genFinetunes(servers, projectId);
    return genFtEvals(jobs, projectId).map((e) => ({
      name: e.name, tuned_model: e.tunedModel, base_model: e.baseModel, status: e.status,
      win_rate: e.winRate, criteria: e.criteria, benchmark: e.benchmark, samples: e.samples,
    }));
  }, [projectId, servers]);
  const { rows, loading } = useSeededTable<EvalRun>({
    table: "aiops_ft_evals",
    map: (r) => ({ id: str(r.id), name: str(r.name), tunedModel: str(r.tuned_model), baseModel: str(r.base_model), status: r.status as EvalRun["status"], winRate: num(r.win_rate), criteria: (r.criteria as EvalRun["criteria"]) ?? [], benchmark: (r.benchmark as EvalRun["benchmark"]) ?? { questions: 0, baseCorrect: 0, tunedCorrect: 0, baseAvgMs: 0, tunedAvgMs: 0, baseHalluc: 0, tunedHalluc: 0 }, samples: num(r.samples), ts: str(r.created_at) }),
    seeds,
  });
  return {
    evals: rows, loading,
    recordVote: (tunedModel: string, votedTuned: boolean) => {
      const e = rows.find((x) => x.tunedModel === tunedModel);
      if (!e) return;
      const n = e.samples + 1;
      const win = Math.round(((e.winRate * e.samples) / 100 + (votedTuned ? 1 : 0)) / n * 1000) / 10;
      void crud.update(e.id, { samples: n, win_rate: win });
    },
  };
}

// ── Alert rules / roles / settings ───────────────────────────────────────────
export interface AlertRuleRow { id: string; rule: string; slack: boolean; email: boolean; sms: boolean }
export function useAlertRulesDb() {
  const crud = useAiopsCrud("aiops_alert_rules");
  const { rows, loading } = useSeededTable<AlertRuleRow>({
    table: "aiops_alert_rules", orderBy: "created_at", ascending: true,
    map: (r) => ({ id: str(r.id), rule: str(r.rule), slack: Boolean(r.slack), email: Boolean(r.email), sms: Boolean(r.sms) }),
    seeds: () => [
      { rule: "Accuracy < 90%", slack: true, email: true, sms: false },
      { rule: "Hallucinations > 5%", slack: true, email: false, sms: false },
      { rule: "Erreurs > 2% (5 min)", slack: true, email: true, sms: true },
      { rule: "Dérive data > 5", slack: true, email: false, sms: false },
    ],
  });
  return { rules: rows, loading, toggle: (r: AlertRuleRow, ch: "slack" | "email" | "sms") => crud.update(r.id, { [ch]: !r[ch] }) };
}

export type FtRoleRow = FtRole & { id: string };
const roleToRow = (r: FtRole) => ({
  role: r.role.trim(), members: Math.max(0, Math.round(r.members)),
  can_train: r.canTrain, can_delete_model: r.canDeleteModel,
  can_deploy: r.canDeploy, can_edit_datasets: r.canEditDatasets,
});
export function useFtRolesDb() {
  const crud = useAiopsCrud("aiops_ft_roles");
  const { rows, loading } = useSeededTable<FtRoleRow>({
    table: "aiops_ft_roles", orderBy: "created_at", ascending: true,
    map: (r) => ({ id: str(r.id), role: str(r.role), members: num(r.members), canTrain: Boolean(r.can_train), canDeleteModel: Boolean(r.can_delete_model), canDeploy: Boolean(r.can_deploy), canEditDatasets: Boolean(r.can_edit_datasets) }),
    seeds: () => DEFAULT_FT_ROLES.map(roleToRow),
  });
  const colMap = { canTrain: "can_train", canDeleteModel: "can_delete_model", canDeploy: "can_deploy", canEditDatasets: "can_edit_datasets" } as const;
  return {
    roles: rows, loading, ready: crud.ready,
    flip: (row: FtRoleRow, key: keyof typeof colMap) =>
      crud.update(row.id, { [colMap[key]]: !row[key] }, "permission.changed", `${row.role} · ${key}`),
    create: (r: FtRole) => crud.create(roleToRow(r), "role.created", r.role),
    update: (id: string, r: FtRole) => crud.update(id, roleToRow(r), "role.updated", r.role),
    remove: (row: FtRoleRow) => crud.remove(row.id, "role.deleted", row.role),
    /** Crée d'un coup la matrice de rôles standard (ignore ceux déjà présents). */
    async seedDefaults() {
      if (!crud.ready) return;
      const existing = new Set(rows.map((r) => r.role));
      const missing = DEFAULT_FT_ROLES.filter((r) => !existing.has(r.role));
      if (missing.length === 0) return;
      const { error } = await supabase.from("aiops_ft_roles")
        .insert(missing.map((r) => ({ workspace_id: crud.workspaceId, project_id: crud.projectId, ...roleToRow(r) })));
      if (error) throw new Error(error.message);
      crud.invalidate();
      crud.audit("roles.seeded", `${missing.length} rôle(s) par défaut`);
    },
  };
}

export function useFtSettingsDb() {
  const { workspaceId, projectId } = useAiopsCtx();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["aiops", "aiops_ft_settings", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("aiops_ft_settings").select("*").eq("project_id", projectId!).maybeSingle();
      return data as { id: string; config: FtSettings } | null;
    },
  });
  const settings: FtSettings = { ...FT_SETTINGS_DEFAULTS, ...(q.data?.config ?? {}) };
  const save = async (next: FtSettings) => {
    if (!projectId || !workspaceId) return;
    if (q.data?.id) await supabase.from("aiops_ft_settings").update({ config: next, updated_at: new Date().toISOString() }).eq("id", q.data.id);
    else await supabase.from("aiops_ft_settings").insert({ workspace_id: workspaceId, project_id: projectId, config: next });
    qc.invalidateQueries({ queryKey: ["aiops", "aiops_ft_settings", projectId] });
  };
  return { settings, loading: q.isLoading, save };
}

// ── Politique de sécurité (chiffrement + programme de conformité) ────────────
// Vit dans la clé `security` du même document config que les settings du studio ;
// l'écriture fusionne le reste du document pour ne rien écraser.
export function useSecurityConfigDb() {
  const { workspaceId, projectId, userId, email } = useAiopsCtx();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["aiops", "aiops_ft_settings", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("aiops_ft_settings").select("*").eq("project_id", projectId!).maybeSingle();
      return data as { id: string; config: Record<string, unknown> } | null;
    },
  });
  const rawConfig = (q.data?.config ?? {}) as Record<string, unknown>;
  const stored = (rawConfig.security ?? {}) as Partial<SecurityConfig>;
  const config: SecurityConfig = useMemo(() => ({
    encryption: { ...SECURITY_DEFAULTS.encryption, ...(stored.encryption ?? {}) },
    compliance: stored.compliance ?? SECURITY_DEFAULTS.compliance,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [JSON.stringify(stored)]);

  const save = async (next: SecurityConfig, auditAction?: string, label?: string) => {
    if (!workspaceId || !projectId) return;
    const merged = { ...rawConfig, security: next };
    const { error } = q.data?.id
      ? await supabase.from("aiops_ft_settings").update({ config: merged, updated_at: new Date().toISOString() }).eq("id", q.data.id)
      : await supabase.from("aiops_ft_settings").insert({ workspace_id: workspaceId, project_id: projectId, config: merged });
    if (error) throw new Error(error.message);
    await qc.invalidateQueries({ queryKey: ["aiops", "aiops_ft_settings", projectId] });
    if (auditAction) void logAudit({ workspaceId, projectId, actorId: userId, actorName: email, action: auditAction, entityType: "security", entityLabel: label });
  };
  return { config, loading: q.isLoading, save };
}

// ═══ REAL telemetry — internal_agent_runs / internal_agent_run_events ═════════

interface RunRow {
  id: string; agent_id: string; mission_id: string | null; conversation_id: string | null; status: string;
  run_kind: string | null; label: string | null;
  tokens_in: number; tokens_out: number; cost_usd: number; action_count: number;
  final_output: string | null; error_message: string | null;
  triggered_via: string | null; started_at: string | null; finished_at: string | null; created_at: string;
}
function useRuns(limit = 120) {
  const { projectId } = useAiopsCtx();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["aiops_runs", projectId, limit],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_runs")
        .select("id, agent_id, mission_id, conversation_id, status, run_kind, label, tokens_in, tokens_out, cost_usd, action_count, final_output, error_message, triggered_via, started_at, finished_at, created_at")
        .eq("project_id", projectId!).order("created_at", { ascending: false }).limit(limit);
      return (data ?? []) as RunRow[];
    },
  });
  // Live: refresh on any run insert/update (new requests, status changes, costs).
  usePostgresChanges({
    table: "internal_agent_runs",
    filter: `project_id=eq.${projectId}`,
    onEvent: () => qc.invalidateQueries({ queryKey: ["aiops_runs", projectId] }),
    enabled: !!projectId,
  });
  return q;
}

const classifyTool = (tool: string): AccessAction => {
  const t = tool.toLowerCase();
  if (/(sql|query|read|search|lookup|fetch|rag|vector|list)/.test(t)) return "data_read";
  if (/(write|insert|update|create|post|send|delete|upload)/.test(t)) return "data_write";
  if (/(http|webhook|api|slack|email|external)/.test(t)) return "external_call";
  return "tool_call";
};
const requesterLabel = (via: string | null, hasUser: boolean) =>
  via === "schedule" ? "scheduler (cron)" : via === "api" ? "API externe" : via === "chat" ? (hasUser ? "chat utilisateur" : "chat") : "déclenchement manuel";

/** Access logs from real run events; sample data when the project has no runs. */
export function useRealAccessLogs(agents: AgentLite[]) {
  const { projectId } = useAiopsCtx();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["aiops_events", projectId],
    enabled: !!projectId && agents.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_run_events")
        .select("id, run_id, agent_id, kind, payload, created_at")
        .in("agent_id", agents.map((a) => a.id))
        .in("kind", ["tool_call", "tool_result", "error"])
        .order("created_at", { ascending: false }).limit(200);
      return (data ?? []) as { id: string; run_id: string; agent_id: string; kind: string; payload: Record<string, unknown>; created_at: string }[];
    },
  });
  // Live: new tool events (or their results/errors) stream in instantly.
  usePostgresChanges({
    table: "internal_agent_run_events",
    filter: `agent_id=in.(${agents.map((a) => a.id).join(",")})`,
    onEvent: () => qc.invalidateQueries({ queryKey: ["aiops_events", projectId] }),
    enabled: !!projectId && agents.length > 0,
  });
  const real: AccessLog[] = useMemo(() => {
    const rows = q.data ?? [];
    // Pair each tool_call with the tool_result that answered it. The runtime
    // writes them as two consecutive events on the same run, so the first
    // later-in-time result for that (run, tool) is the match. Rows arrive
    // newest-first, hence the reversed scan.
    const chrono = [...rows].reverse();
    type Ev = (typeof rows)[number];
    const resultFor = new Map<string, Ev>();
    const pending = new Map<string, string>(); // `${run}:${tool}` → call event id
    for (const e of chrono) {
      const tool = str(e.payload?.tool ?? e.payload?.name ?? e.payload?.tool_name ?? "");
      const key = `${e.run_id}:${tool}`;
      if (e.kind === "tool_call") pending.set(key, e.id);
      else if (e.kind === "tool_result") {
        const callId = pending.get(key);
        if (callId) { resultFor.set(callId, e); pending.delete(key); }
      }
    }

    return rows.filter((e) => e.kind !== "tool_result").map((e) => {
      const p = e.payload ?? {};
      const tool = str(p.tool ?? p.name ?? p.tool_name ?? "outil");
      const a = agents.find((x) => x.id === e.agent_id);
      const res = resultFor.get(e.id);
      const rp = res?.payload ?? {};
      const ok = res ? rp.ok !== false : undefined;
      const preview = str(rp.preview ?? rp.result ?? "");
      const args = (p.args && typeof p.args === "object" ? p.args : undefined) as Record<string, unknown> | undefined;
      // The detail line now prefers a real signal — the first line of what came
      // back — over the generic event kind it used to fall back to.
      const detail =
        str(p.summary ?? p.args_preview ?? p.message ?? "").slice(0, 140) ||
        preview.split("\n")[0].slice(0, 140) ||
        `${e.kind}`;
      return {
        id: e.id, ts: e.created_at, agentId: e.agent_id, agentName: a?.name ?? "Agent",
        action: classifyTool(tool),
        target: tool, detail,
        // A tool that returned an ERROR is a failed access even though the
        // event that carried it was a plain tool_result.
        status: e.kind === "error" || ok === false ? "error" : "ok",
        runId: `run_${e.run_id.slice(0, 6)}`,
        runIdFull: e.run_id,
        args,
        resultPreview: preview || undefined,
        resultOk: ok,
        durationMs: res ? Math.max(0, new Date(res.created_at).getTime() - new Date(e.created_at).getTime()) : undefined,
      } as AccessLog;
    });
  }, [q.data, agents]);
  return { logs: real, isSample: false, loading: q.isLoading };
}

// ── "What was actually asked?" ───────────────────────────────────────────────
// A run row keeps NO prompt of its own: the request lives wherever the run was
// started from. So we join back to the origin — mission brief, agent chat,
// service room, or the subtask label of a parallel sub-agent.
interface MsgLite { content: string; created_at: string }
const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter(Boolean))] as string[];
const groupBy = <T,>(rows: T[], key: (r: T) => string) => {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); const arr = m.get(k); if (arr) arr.push(r); else m.set(k, [r]); }
  return m;
};
/** The message that triggered a run: the newest one written at (or just before)
 *  the run row — the run is inserted right after the message lands. `msgs` must
 *  be newest-first. */
const triggeringMessage = (msgs: MsgLite[] | undefined, runTs: string): string => {
  if (!msgs?.length) return "";
  const cutoff = new Date(runTs).getTime() + 10_000;
  return str((msgs.find((m) => new Date(m.created_at).getTime() <= cutoff) ?? msgs[0]).content);
};

/** Batch-resolve the request text behind a page of runs → Map<runId, prompt>. */
function useRunRequests(runs: RunRow[]) {
  const { projectId } = useAiopsCtx();
  const missionIds = useMemo(() => uniq(runs.map((r) => r.mission_id)), [runs]);
  const convoIds = useMemo(() => uniq(runs.map((r) => (r.mission_id ? null : r.conversation_id))), [runs]);
  // Room turns are the runs tied to neither a mission nor a conversation.
  const roomRunIds = useMemo(
    () => runs.filter((r) => !r.mission_id && !r.conversation_id && r.run_kind !== "subagent").map((r) => r.id),
    [runs],
  );

  const missionsQ = useQuery({
    queryKey: ["aiops_missions", projectId, missionIds.join(",")],
    enabled: missionIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_missions").select("id, title").in("id", missionIds);
      return new Map(((data ?? []) as { id: string; title: string }[]).map((m) => [m.id, m.title]));
    },
  });

  const chatQ = useQuery({
    queryKey: ["aiops_chat_prompts", projectId, convoIds.join(",")],
    enabled: convoIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_messages")
        .select("conversation_id, content, created_at")
        .in("conversation_id", convoIds).eq("role", "user")
        .order("created_at", { ascending: false }).limit(600);
      return groupBy((data ?? []) as (MsgLite & { conversation_id: string })[], (m) => m.conversation_id);
    },
  });

  // The agent's placeholder message in a room carries the run id; the request is
  // the user message posted just before it.
  const roomQ = useQuery({
    queryKey: ["aiops_room_prompts", projectId, roomRunIds.join(",")],
    enabled: roomRunIds.length > 0,
    queryFn: async () => {
      const { data: holders } = await supabase.from("service_room_messages")
        .select("run_id, room_id, created_at").in("run_id", roomRunIds);
      const rows = (holders ?? []) as { run_id: string; room_id: string; created_at: string }[];
      if (rows.length === 0) return new Map<string, string>();
      const { data: asks } = await supabase.from("service_room_messages")
        .select("room_id, content, created_at")
        .in("room_id", uniq(rows.map((h) => h.room_id))).eq("author_kind", "user")
        .order("created_at", { ascending: false }).limit(600);
      const byRoom = groupBy((asks ?? []) as (MsgLite & { room_id: string })[], (m) => m.room_id);
      return new Map(rows.map((h) => [h.run_id, triggeringMessage(byRoom.get(h.room_id), h.created_at)]));
    },
  });

  return useMemo(() => new Map(runs.map((r) => {
    const text = r.run_kind === "subagent" ? str(r.label)
      : r.mission_id ? str(missionsQ.data?.get(r.mission_id))
      : r.conversation_id ? triggeringMessage(chatQ.data?.get(r.conversation_id), r.created_at)
      : str(roomQ.data?.get(r.id));
    return [r.id, text] as const;
  })), [runs, missionsQ.data, chatQ.data, roomQ.data]);
}

/** Model + hosting that served each run, resolved from llm_usage
 *  (metadata->>run_id). The finalizer writes the run-total row last, so the
 *  newest row per run is the canonical one. Best-effort: a run with no usage
 *  row falls back to "—" / cloud. */
function useRunsModels(runs: RunRow[]) {
  const { projectId } = useAiopsCtx();
  const ids = useMemo(() => runs.map((r) => r.id).filter(Boolean), [runs]);
  return useQuery({
    queryKey: ["aiops_run_models", projectId, ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("llm_usage")
        .select("model, metadata, created_at")
        .in("metadata->>run_id", ids)
        .order("created_at", { ascending: false })
        .limit(600);
      const map = new Map<string, { model: string; custom: boolean }>();
      for (const row of (data ?? []) as { model: string; metadata: Record<string, unknown> }[]) {
        const rid = String(row.metadata?.run_id ?? "");
        if (rid && !map.has(rid)) map.set(rid, {
          model: row.model,
          custom: row.metadata?.custom === true,
        });
      }
      return map;
    },
  });
}

/** Tools a run actually called, batched from run events (one query per page). */
function useRunsTools(runs: RunRow[]) {
  const { projectId } = useAiopsCtx();
  const ids = useMemo(() => runs.map((r) => r.id).filter(Boolean), [runs]);
  return useQuery({
    queryKey: ["aiops_run_tools_batch", projectId, ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_run_events")
        .select("run_id, payload")
        .in("run_id", ids)
        .eq("kind", "tool_call")
        .limit(1000);
      const map = new Map<string, string[]>();
      for (const row of (data ?? []) as { run_id: string; payload: Record<string, unknown> }[]) {
        const t = str(row.payload?.tool ?? row.payload?.name ?? "");
        if (!t) continue;
        const arr = map.get(row.run_id) ?? [];
        if (!arr.includes(t)) arr.push(t);
        map.set(row.run_id, arr);
      }
      return map;
    },
  });
}

/** Prompt monitoring from real runs (+ the request that started each one). */
export function useRealPrompts(agents: AgentLite[]) {
  const runsQ = useRuns();
  const runs = useMemo(() => runsQ.data ?? [], [runsQ.data]);
  const requests = useRunRequests(runs);
  const modelsQ = useRunsModels(runs);
  const toolsQ = useRunsTools(runs);
  const categorize = (text: string): PromptRecord["category"] => {
    const t = text.toLowerCase();
    if (/(bug|code|corrige|endpoint|api|déploi)/.test(t)) return "code";
    if (/(rapport|analyse|revenu|churn|kpi|métrique)/.test(t)) return "analysis";
    if (/(email|article|contenu|rédige|slide|post)/.test(t)) return "content";
    if (/(ticket|client|support|réponds)/.test(t)) return "support";
    if (/(sql|données|dataset|export|import)/.test(t)) return "data";
    return "ops";
  };
  const real: PromptRecord[] = useMemo(() => runs.map((r) => {
    const a = agents.find((x) => x.id === r.agent_id);
    // The request itself — never the agent's own output, which used to stand in
    // for it here and read as if the agent had prompted itself. Collapsed to one
    // line for the row/sheet header; the panel shows the verbatim text.
    const title = (requests.get(r.id) ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "Run d'agent";
    const toolsUsed = toolsQ.data?.get(r.id) ?? [];
    // Data actions = tool names that map to data_read / data_write (the detail
    // sheet keeps the full list; this is the quick access summary).
    const dataAccessed = toolsUsed.filter((t) => classifyTool(t) !== "tool_call");
    return {
      id: r.id, ts: r.created_at, requester: requesterLabel(r.triggered_via, true),
      agentId: r.agent_id, agentName: a?.name ?? "Agent",
      category: categorize(title), labels: [r.triggered_via ?? "manual"],
      prompt: title,
      outcome: r.status === "succeeded" ? "success" : r.status === "failed" ? "failed" : "partial",
      toolsUsed, dataAccessed, model: modelsQ.data?.get(r.id)?.model ?? "—",
      custom: modelsQ.data?.get(r.id)?.custom ?? false,
      tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: Number(r.cost_usd), runId: `run_${r.id.slice(0, 6)}`,
    };
  }), [runs, requests, agents, modelsQ.data, toolsQ.data]);
  return { prompts: real, isSample: false, loading: runsQ.isLoading };
}

/** The full request behind ONE run, for the detail panel. Unlike the batch
 *  resolver above it returns the untruncated text (mission brief rather than
 *  mission title) plus the agent's own system-level instructions, which are
 *  prepended to every request the model receives. */
export interface RunPromptDetail {
  source: "mission" | "chat" | "room" | "subagent" | "unknown";
  sourceLabel: string;
  /** Exact text sent as the request. Empty when the origin no longer exists. */
  text: string;
  missionTitle?: string;
  acceptance?: string;
  deliverables?: string[];
  persona?: string;
  instructions?: string;
}
export function useRunPrompt(runId: string | null) {
  return useQuery({
    queryKey: ["aiops_run_prompt", runId],
    enabled: !!runId,
    queryFn: async (): Promise<RunPromptDetail> => {
      const unknown: RunPromptDetail = { source: "unknown", sourceLabel: "Origine inconnue", text: "" };
      const { data: run } = await supabase.from("internal_agent_runs")
        .select("id, agent_id, mission_id, conversation_id, run_kind, label, triggered_via, created_at")
        .eq("id", runId!).maybeSingle();
      if (!run) return unknown;
      const r = run as Pick<RunRow, "id" | "agent_id" | "mission_id" | "conversation_id" | "run_kind" | "label" | "triggered_via" | "created_at">;

      const origin = async (): Promise<RunPromptDetail> => {
        if (r.run_kind === "subagent") {
          return { source: "subagent", sourceLabel: "Sous-tâche déléguée à un sous-agent parallèle", text: str(r.label) };
        }
        if (r.mission_id) {
          const { data } = await supabase.from("internal_agent_missions")
            .select("title, brief, acceptance_criteria, expected_deliverables").eq("id", r.mission_id).maybeSingle();
          const m = (data ?? {}) as { title?: string; brief?: string; acceptance_criteria?: string; expected_deliverables?: unknown };
          return {
            source: "mission", sourceLabel: "Brief de mission",
            text: str(m.brief) || str(m.title),
            missionTitle: str(m.title) || undefined,
            acceptance: str(m.acceptance_criteria) || undefined,
            deliverables: Array.isArray(m.expected_deliverables)
              ? (m.expected_deliverables as Record<string, unknown>[]).map((d) => str(d?.name ?? d?.kind)).filter(Boolean)
              : undefined,
          };
        }
        if (r.conversation_id) {
          const { data } = await supabase.from("internal_agent_messages")
            .select("content, created_at").eq("conversation_id", r.conversation_id).eq("role", "user")
            .order("created_at", { ascending: false }).limit(30);
          const text = triggeringMessage((data ?? []) as MsgLite[], r.created_at);
          if (text) return { source: "chat", sourceLabel: "Message envoyé dans le chat de l'agent", text };
        }
        const { data: holder } = await supabase.from("service_room_messages")
          .select("room_id, created_at").eq("run_id", r.id).limit(1).maybeSingle();
        if (holder) {
          const h = holder as { room_id: string; created_at: string };
          const { data } = await supabase.from("service_room_messages")
            .select("content, created_at").eq("room_id", h.room_id).eq("author_kind", "user")
            .order("created_at", { ascending: false }).limit(30);
          const text = triggeringMessage((data ?? []) as MsgLite[], h.created_at);
          if (text) return { source: "room", sourceLabel: "Message envoyé dans une room de service", text };
        }
        return { ...unknown, sourceLabel: `Aucun texte conservé (${requesterLabel(r.triggered_via, true)})` };
      };

      const [detail, agentRes] = await Promise.all([
        origin(),
        r.agent_id
          ? supabase.from("internal_agents").select("persona, instructions").eq("id", r.agent_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      const a = (agentRes.data ?? {}) as { persona?: string; instructions?: string };
      return { ...detail, persona: str(a.persona) || undefined, instructions: str(a.instructions) || undefined };
    },
  });
}

/** Lazy drill-down: the tools/data a specific run actually used. */
export function useRunTools(runId: string | null) {
  return useQuery({
    queryKey: ["aiops_run_tools", runId],
    enabled: !!runId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agent_run_events")
        .select("kind, payload").eq("run_id", runId!).eq("kind", "tool_call").limit(60);
      const tools = [...new Set(((data ?? []) as { payload: Record<string, unknown> }[])
        .map((e) => str(e.payload?.tool ?? e.payload?.name ?? "")).filter(Boolean))];
      return { tools, data: tools.filter((t) => classifyTool(t) !== "tool_call") };
    },
  });
}

/** Run incidents from real failed runs. */
export function useRealRunIncidents(agents: AgentLite[]) {
  const { projectId } = useAiopsCtx();
  const runsQ = useRuns(200);
  const real: OpsIncident[] = useMemo(() => (runsQ.data ?? [])
    .filter((r) => r.status === "failed" || r.status === "cancelled")
    .map((r) => {
      const a = agents.find((x) => x.id === r.agent_id);
      const msg = r.error_message ?? "Run interrompu";
      const kind: OpsIncident["kind"] = /timeout|délai/i.test(msg) ? "timeout" : /rate|429/i.test(msg) ? "rate_limit" : /guardrail|interdit|refus/i.test(msg) ? "guardrail_block" : /tool|outil|api/i.test(msg) ? "tool_error" : "run_failure";
      const dur = r.started_at && r.finished_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : 0;
      return {
        id: r.id, ts: r.created_at, agentId: r.agent_id, agentName: a?.name ?? "Agent",
        title: `${a?.name ?? "Agent"} · run échoué`, kind,
        severity: dur > 120_000 ? "high" as const : "medium" as const,
        status: "open" as const, cause: msg.slice(0, 220), runId: `run_${r.id.slice(0, 6)}`, durationMs: Math.max(0, dur),
      };
    }), [runsQ.data, agents]);
  return { incidents: real, isSample: false, loading: runsQ.isLoading };
}

/** Governance spend computed from real runs + real servers. */
export function useRealGovCosts(agents: AgentLite[], servers: PrivateServer[]) {
  const { projectId } = useAiopsCtx();
  const runsQ = useRuns(400);
  const { prompts } = useRealPrompts(agents);
  const { entries: ledger } = useInfraCostLedger();
  const costs: CostBreakdown | null = useMemo(() => {
    if (!projectId) return null;
    const runs = runsQ.data ?? [];
    // Infrastructure = real billed segments from the cost ledger (30 j), plus
    // the amortised estimate of seeded demo servers that never bill for real.
    const ledgerUsd = ledger
      .filter((e) => Date.now() - new Date(e.createdAt).getTime() < 30 * 86_400_000)
      .reduce((s, e) => s + e.usd, 0);
    const seedUsd = servers.reduce((s, x) => s + (x.source === "seed" ? x.costPerDay : 0), 0) * 30;
    const infraUsd = Math.round((ledgerUsd + seedUsd) * 100) / 100;
    // No real runs yet → return null; the page falls back to the sample breakdown.
    if (runs.length === 0) return null;
    const apiUsd = Math.round(runs.reduce((s, r) => s + Number(r.cost_usd), 0) * 100) / 100;
    const byAgentMap = new Map<string, { usd: number; runs: number }>();
    for (const r of runs) {
      const cur = byAgentMap.get(r.agent_id) ?? { usd: 0, runs: 0 };
      byAgentMap.set(r.agent_id, { usd: cur.usd + Number(r.cost_usd), runs: cur.runs + 1 });
    }
    const byAgent = [...byAgentMap.entries()].map(([agentId, v]) => ({
      agentId, name: agents.find((a) => a.id === agentId)?.name ?? "Agent",
      usd: Math.round(v.usd * 100) / 100, runs: v.runs,
    })).sort((a, b) => b.usd - a.usd);
    const dailyMap = new Map<string, number>();
    for (let i = 13; i >= 0; i--) dailyMap.set(new Date(Date.now() - i * 86_400_000).toISOString().slice(5, 10), 0);
    for (const r of runs) {
      const day = r.created_at.slice(5, 10);
      if (dailyMap.has(day)) dailyMap.set(day, (dailyMap.get(day) ?? 0) + Number(r.cost_usd));
    }
    const daily = [...dailyMap.entries()].map(([day, usd]) => ({ day, usd: Math.round(usd * 100) / 100 }));
    // Real per-model attribution: each run is mapped to its serving model via
    // llm_usage (metadata.run_id). Runs with no traced model land in a distinct
    // bucket so the sums stay honest about traceability gaps.
    const byModelMap = new Map<string, { usd: number; custom: boolean }>();
    for (const p of prompts) {
      const k = p.model && p.model !== "—" ? p.model : "Modèle non tracé";
      const cur = byModelMap.get(k) ?? { usd: 0, custom: false };
      byModelMap.set(k, { usd: cur.usd + p.costUsd, custom: p.custom || cur.custom });
    }
    const byModel = [...byModelMap.entries()].map(([model, v]) => ({
      model,
      label: modelById(model)?.label ?? model,
      hosting: v.custom ? ("self_hosted" as const) : ("cloud" as const),
      usd: Math.round(v.usd * 100) / 100,
    })).sort((a, b) => b.usd - a.usd);
    const total = Math.round((apiUsd + infraUsd) * 100) / 100;
    const nRuns = Math.max(1, runs.length);
    return {
      totalUsd: total, apiUsd, infraUsd, byAgent,
      byBucket: [
        { label: "Par run", usd: Math.round((apiUsd / nRuns) * 100) / 100, hint: "coût moyen / run (réel)" },
        { label: "Par prompt", usd: Math.round((apiUsd / Math.max(1, prompts.length)) * 100) / 100, hint: "coût moyen / prompt" },
        { label: "Par mission", usd: Math.round((apiUsd / Math.max(1, new Set(runs.map((r) => r.mission_id).filter(Boolean)).size)) * 100) / 100, hint: "coût moyen / mission" },
        { label: "Infra / jour", usd: Math.round((infraUsd / 30) * 100) / 100, hint: "serveurs privés" },
      ],
      byModel,
      daily,
    };
  }, [projectId, runsQ.data, agents, servers, prompts, ledger]);
  return { costs, isSample: false, hasData: !!costs, loading: runsQ.isLoading };
}

// ═══ REAL infra cost ledger + project budget ═══════════════════════════════════

export interface InfraCostEntry {
  id: string; providerId: string | null; serverId: string | null; serverName: string;
  gpu: string; hourlyUsd: number; periodStart: string; periodEnd: string;
  hours: number; usd: number; kind: "server" | "training"; createdAt: string;
}
/** Billed infra segments (written by the aiops-infra edge function). Live. */
export function useInfraCostLedger(limit = 500) {
  const { projectId } = useAiopsCtx();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["aiops_cost_ledger", projectId, limit],
    enabled: !!projectId,
    queryFn: async () => {
      const { data, error } = await supabase.from("aiops_infra_cost_ledger")
        .select("*").eq("project_id", projectId!)
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw new Error(error.message);
      return (data ?? []) as Record<string, unknown>[];
    },
  });
  usePostgresChanges({
    table: "aiops_infra_cost_ledger",
    filter: `project_id=eq.${projectId}`,
    onEvent: () => qc.invalidateQueries({ queryKey: ["aiops_cost_ledger", projectId] }),
    enabled: !!projectId,
  });
  const entries = useMemo(() => (q.data ?? []).map((r) => ({
    id: str(r.id), providerId: r.provider_id ? str(r.provider_id) : null,
    serverId: r.server_id ? str(r.server_id) : null, serverName: str(r.server_name),
    gpu: str(r.gpu), hourlyUsd: num(r.hourly_usd),
    periodStart: str(r.period_start), periodEnd: str(r.period_end),
    hours: num(r.hours), usd: num(r.usd),
    kind: (r.kind as InfraCostEntry["kind"]) ?? "server", createdAt: str(r.created_at),
  } as InfraCostEntry)), [q.data]);
  return { entries, loading: q.isLoading, invalidate: () => qc.invalidateQueries({ queryKey: ["aiops_cost_ledger", projectId] }) };
}

export interface ProjectBudget { monthlyUsd: number; alertPct: number }
export const BUDGET_DEFAULTS: ProjectBudget = { monthlyUsd: 500, alertPct: 80 };

/** Monthly budget + alert threshold, stored under `budget` in the settings row
 *  (same config document as security/settings; reads share the query key). */
export function useProjectBudgetDb() {
  const { workspaceId, projectId } = useAiopsCtx();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["aiops", "aiops_ft_settings", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("aiops_ft_settings").select("*").eq("project_id", projectId!).maybeSingle();
      return data as { id: string; config: Record<string, unknown> } | null;
    },
  });
  const rawConfig = (q.data?.config ?? {}) as Record<string, unknown>;
  const budget: ProjectBudget = useMemo(() => ({
    ...BUDGET_DEFAULTS, ...((rawConfig.budget ?? {}) as Partial<ProjectBudget>),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [JSON.stringify(rawConfig.budget)]);
  const save = async (next: ProjectBudget) => {
    if (!workspaceId || !projectId) return;
    const merged = { ...rawConfig, budget: next };
    const { error } = q.data?.id
      ? await supabase.from("aiops_ft_settings").update({ config: merged, updated_at: new Date().toISOString() }).eq("id", q.data.id)
      : await supabase.from("aiops_ft_settings").insert({ workspace_id: workspaceId, project_id: projectId, config: merged });
    if (error) throw new Error(error.message);
    await qc.invalidateQueries({ queryKey: ["aiops", "aiops_ft_settings", projectId] });
  };
  return { budget, loading: q.isLoading, save };
}
