// AI Ops & Governance — "AI Governance" onglet.
// Data layer for the Guardrails / Access logs / Prompt monitoring / Costs /
// Incidents tabs. Guardrails persist to localStorage (per project) so they feel
// real without a backend migration; the logs/prompts/costs/incidents are
// deterministically generated mock telemetry, attributed to the project's real
// agents when they exist. Everything is shaped so it can be swapped to Supabase
// (agent-run telemetry) later without touching the pages.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { SEVERITY_META } from "../shared";

export { SEVERITY_META };
export type Tone = "red" | "orange" | "amber" | "emerald" | "blue" | "violet" | "slate" | "cyan";
export interface Meta { label: string; tone: Tone }

// ── Real agents (to attribute the mock telemetry to) ─────────────────────────
export interface AgentLite { id: string; name: string; avatar_emoji: string | null; avatar_url: string | null; accent_color: string | null }
export function useProjectAgents() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["aiops_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents")
        .select("id, name, avatar_emoji, avatar_url, accent_color")
        .eq("project_id", projectId!).order("created_at", { ascending: true });
      return (data ?? []) as AgentLite[];
    },
  });
}

// Fallback roster when the project has no agents yet — keeps the tabs populated.
const SAMPLE_AGENTS: AgentLite[] = [
  { id: "s-ops", name: "Ops Copilot", avatar_emoji: null, avatar_url: null, accent_color: null },
  { id: "s-analyst", name: "Data Analyst", avatar_emoji: null, avatar_url: null, accent_color: null },
  { id: "s-support", name: "Support Agent", avatar_emoji: null, avatar_url: null, accent_color: null },
  { id: "s-growth", name: "Growth Marketer", avatar_emoji: null, avatar_url: null, accent_color: null },
];
export const agentsOrSample = (a: AgentLite[] | undefined) => (a && a.length ? a : SAMPLE_AGENTS);

// ── Deterministic PRNG (stable mock across renders / reloads) ─────────────────
function hashStr(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T,>(r: () => number, arr: T[]) => arr[Math.floor(r() * arr.length)];
const money = (n: number) => Math.round(n * 100) / 100;
const short = () => Math.random().toString(36).slice(2, 8); // ids only, not seeded content
function isoAgo(minutes: number) { return new Date(Date.now() - minutes * 60_000).toISOString(); }

// ── Types ────────────────────────────────────────────────────────────────────
export type AccessAction = "tool_call" | "data_read" | "data_write" | "external_call";
export type AccessStatus = "ok" | "denied" | "error";
export interface AccessLog {
  id: string; ts: string; agentId: string; agentName: string;
  action: AccessAction; target: string; detail: string; status: AccessStatus; runId: string;
  // ── Forensic payload ───────────────────────────────────────────────────────
  // An access log that only says "read_url was called" cannot answer the
  // question the page exists for — WHAT did it read, and what came back. The
  // runtime already records both on the run events; these carry them through.
  /** Arguments the agent passed, as logged (long strings already truncated). */
  args?: Record<string, unknown>;
  /** First ~1k chars of what the tool returned. */
  resultPreview?: string;
  /** Whether the tool itself reported success (from the paired tool_result). */
  resultOk?: boolean;
  /** Full run id, for deep-linking into the run timeline. */
  runIdFull?: string;
  /** Milliseconds between the call and its result, when both were recorded. */
  durationMs?: number;
}

export type PromptCategory = "ops" | "analysis" | "content" | "code" | "support" | "data";
export type Outcome = "success" | "partial" | "failed";
export interface PromptRecord {
  id: string; ts: string; requester: string; agentId: string; agentName: string;
  category: PromptCategory; labels: string[]; prompt: string; outcome: Outcome;
  toolsUsed: string[]; dataAccessed: string[];
  /** Model that served the prompt (see MODEL_CATALOG — cloud or self-hosted). */
  model: string;
  /** Self-hosted endpoint (RunPod / aiops_providers) → priced & flagged custom. */
  custom?: boolean;
  tokensIn: number; tokensOut: number; costUsd: number; runId: string;
}

export type IncidentKind = "run_failure" | "timeout" | "tool_error" | "guardrail_block" | "rate_limit" | "hallucination";
export type OpsStatus = "open" | "investigating" | "resolved";
export interface OpsIncident {
  id: string; ts: string; agentId: string; agentName: string; title: string;
  kind: IncidentKind; severity: keyof typeof SEVERITY_META; status: OpsStatus;
  cause: string; runId: string; durationMs: number;
}

export type Enforcement = "block" | "warn" | "log";
export type GuardrailScope = "prompt" | "tool_call" | "tool_result" | "all";
export interface Guardrail {
  id: string; title: string; category: string; enforcement: Enforcement;
  enabled: boolean; body: string; updatedAt: string;
  /** Regex testé en runtime contre le trafic (vide = guardrail documentaire). */
  matchPattern?: string;
  /** Surface de test : prompt utilisateur, appels d'outils, résultats, ou tout. */
  matchScope?: GuardrailScope;
}

// ── Meta maps (Pill label + tone) ────────────────────────────────────────────
export const ACCESS_ACTION_META: Record<AccessAction, Meta> = {
  tool_call: { label: "Appel outil", tone: "blue" },
  data_read: { label: "Lecture données", tone: "cyan" },
  data_write: { label: "Écriture données", tone: "amber" },
  external_call: { label: "Appel externe", tone: "violet" },
};
export const ACCESS_STATUS_META: Record<AccessStatus, Meta> = {
  ok: { label: "OK", tone: "emerald" }, denied: { label: "Refusé", tone: "red" }, error: { label: "Erreur", tone: "orange" },
};
export const PROMPT_CATEGORY_META: Record<PromptCategory, Meta> = {
  ops: { label: "Opérations", tone: "blue" }, analysis: { label: "Analyse", tone: "violet" },
  content: { label: "Contenu", tone: "cyan" }, code: { label: "Code", tone: "amber" },
  support: { label: "Support", tone: "emerald" }, data: { label: "Données", tone: "slate" },
};
export const OUTCOME_META: Record<Outcome, Meta> = {
  success: { label: "Succès", tone: "emerald" }, partial: { label: "Partiel", tone: "amber" }, failed: { label: "Échec", tone: "red" },
};
export const INCIDENT_KIND_META: Record<IncidentKind, Meta> = {
  run_failure: { label: "Run échoué", tone: "red" }, timeout: { label: "Timeout", tone: "orange" },
  tool_error: { label: "Erreur outil", tone: "amber" }, guardrail_block: { label: "Guardrail", tone: "violet" },
  rate_limit: { label: "Rate limit", tone: "blue" }, hallucination: { label: "Hallucination", tone: "cyan" },
};
export const OPS_STATUS_META: Record<OpsStatus, Meta> = {
  open: { label: "Ouvert", tone: "red" }, investigating: { label: "Investigation", tone: "amber" }, resolved: { label: "Résolu", tone: "emerald" },
};
export const ENFORCEMENT_META: Record<Enforcement, Meta> = {
  block: { label: "Bloquant", tone: "red" }, warn: { label: "Avertissement", tone: "amber" }, log: { label: "Journalisation", tone: "slate" },
};
export const GUARDRAIL_SCOPE_META: Record<GuardrailScope, Meta> = {
  all: { label: "Tout", tone: "blue" },
  prompt: { label: "Prompts", tone: "violet" },
  tool_call: { label: "Appels d'outils", tone: "cyan" },
  tool_result: { label: "Résultats", tone: "amber" },
};

// ── Mock catalogues ──────────────────────────────────────────────────────────
const TOOLS = ["web_search", "sql_query", "send_email", "http_request", "code_exec", "vector_search", "crm_lookup", "file_read", "slack_post", "calendar_create"];
const RESOURCES = ["crm.contacts", "billing.invoices", "analytics.events", "knowledge.docs", "projects.tasks", "support.tickets", "hr.candidates", "supply.orders"];
const REQUESTERS = ["olivier@founderos.ai", "lea@founderos.ai", "marc@founderos.ai", "scheduler (cron)", "webhook:stripe", "api-key: prod-01"];
const LABELS = ["client", "interne", "reporting", "urgent", "automatisé", "sensible", "PII", "finance", "growth"];

// ── Model catalog — cloud APIs vs self-hosted (serveurs propriétaires) ────────
export type Hosting = "cloud" | "self_hosted";
export interface ModelInfo {
  id: string; label: string; family: string; vendor: string; hosting: Hosting;
  ctx: string;
  /** cloud: price per M tokens (in/out) — self-hosted: weights size to install. */
  price?: string; sizeGB?: number;
  /** VRAM FP16 requise pour servir le modèle (self-hosted) — guide le choix de GPU RunPod. */
  vramGb?: number;
  /** Repo HuggingFace réellement servi (vLLM) — guide la location RunPod. */
  hfRepo?: string;
  /** Fenêtre de contexte en tokens — guide --max-model-len de vLLM. */
  maxContextLen?: number;
}
export const HOSTING_META: Record<Hosting, Meta> = {
  cloud: { label: "Cloud", tone: "blue" },
  self_hosted: { label: "Propriétaire", tone: "violet" },
};
export const MODEL_CATALOG: ModelInfo[] = [
  // Cloud APIs
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", family: "Claude", vendor: "Anthropic", hosting: "cloud", ctx: "200k", price: "$5 / $25" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", family: "Claude", vendor: "Anthropic", hosting: "cloud", ctx: "200k", price: "$3 / $15" },
  { id: "gpt-5.2", label: "GPT-5.2", family: "ChatGPT", vendor: "OpenAI", hosting: "cloud", ctx: "256k", price: "$4 / $16" },
  { id: "mistral-large-3", label: "Mistral Large 3", family: "Mistral", vendor: "Mistral AI", hosting: "cloud", ctx: "128k", price: "$2 / $6" },
  { id: "deepseek-v4", label: "DeepSeek V4", family: "DeepSeek", vendor: "DeepSeek", hosting: "cloud", ctx: "128k", price: "$0.3 / $1.1" },
  { id: "qwen3-max", label: "Qwen3 Max", family: "Qwen", vendor: "Alibaba", hosting: "cloud", ctx: "128k", price: "$1.2 / $6" },
  { id: "glm-5", label: "GLM-5", family: "GLM", vendor: "Zhipu AI", hosting: "cloud", ctx: "128k", price: "$0.6 / $2.2" },
  // Self-hosted (installables sur serveurs privés)
  { id: "llama-4-maverick", label: "Llama 4 Maverick", family: "Llama", vendor: "Meta", hosting: "self_hosted", ctx: "128k", sizeGB: 142, vramGb: 142, hfRepo: "meta-llama/Llama-3.3-70B-Instruct", maxContextLen: 131072 },
  { id: "mistral-small-3.2", label: "Mistral Small 3.2", family: "Mistral", vendor: "Mistral AI", hosting: "self_hosted", ctx: "32k", sizeGB: 47, vramGb: 48, hfRepo: "mistralai/Mistral-Small-Instruct-2409", maxContextLen: 32768 },
  { id: "qwen3-32b", label: "Qwen3 32B", family: "Qwen", vendor: "Alibaba", hosting: "self_hosted", ctx: "32k", sizeGB: 65, vramGb: 66, hfRepo: "Qwen/Qwen2.5-32B-Instruct", maxContextLen: 32768 },
  { id: "deepseek-r1-distill", label: "DeepSeek R1 Distill 32B", family: "DeepSeek", vendor: "DeepSeek", hosting: "self_hosted", ctx: "64k", sizeGB: 66, vramGb: 66, hfRepo: "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B", maxContextLen: 65536 },
  { id: "glm-4.5-air", label: "GLM-4.5 Air", family: "GLM", vendor: "Zhipu AI", hosting: "self_hosted", ctx: "32k", sizeGB: 22, vramGb: 24, hfRepo: "THUDM/glm-4-9b-chat", maxContextLen: 32768 },
  { id: "gemma-3-27b", label: "Gemma 3 27B", family: "Gemma", vendor: "Google", hosting: "self_hosted", ctx: "8k", sizeGB: 54, vramGb: 56, hfRepo: "google/gemma-2-27b-it", maxContextLen: 8192 },
];
export const CLOUD_MODELS = MODEL_CATALOG.filter((m) => m.hosting === "cloud");
export const SELF_HOSTED_MODELS = MODEL_CATALOG.filter((m) => m.hosting === "self_hosted");
export const modelById = (id: string) => MODEL_CATALOG.find((m) => m.id === id);
/** HuggingFace repo used to actually serve/fine-tune each self-hosted catalog
 *  model on a RunPod pod (vLLM for serving, axolotl for training). Gated repos
 *  (Llama/Gemma) need an HF token on the provider. */
export const HF_REPO: Record<string, string> = {
  "llama-4-maverick": "meta-llama/Llama-3.3-70B-Instruct",
  "mistral-small-3.2": "mistralai/Mistral-Small-Instruct-2409",
  "qwen3-32b": "Qwen/Qwen2.5-32B-Instruct",
  "deepseek-r1-distill": "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B",
  "glm-4.5-air": "THUDM/glm-4-9b-chat",
  "gemma-3-27b": "google/gemma-2-27b-it",
};
export const hfRepoFor = (modelId: string) => HF_REPO[modelId] ?? "Qwen/Qwen2.5-7B-Instruct";
const PROMPTS = [
  "Résume les tickets support ouverts et propose des réponses",
  "Génère le rapport hebdo de revenus et churn",
  "Analyse les factures impayées et relance les clients",
  "Écris une séquence d'emails d'onboarding",
  "Corrige le bug de pagination sur le endpoint /contacts",
  "Priorise le backlog produit pour le prochain sprint",
  "Qualifie les nouveaux leads entrants du CRM",
  "Prépare les slides de la revue trimestrielle",
  "Vérifie la conformité RGPD des nouveaux data assets",
  "Optimise la requête SQL de la vue analytics",
];
const CAUSES: Record<IncidentKind, string> = {
  run_failure: "Exception non gérée dans l'étape d'exécution de l'outil",
  timeout: "Le modèle a dépassé le budget temps (>120s) sur une longue chaîne d'outils",
  tool_error: "L'API externe a renvoyé 500 (quota fournisseur dépassé)",
  guardrail_block: "Tentative d'écriture sur une donnée restreinte — bloquée par un guardrail",
  rate_limit: "429 du fournisseur LLM — trop de requêtes concurrentes",
  hallucination: "Sortie contredite par la self-verification — relance demandée",
};

// ── Generators (seeded by project) ───────────────────────────────────────────
export function genAccessLogs(agents: AgentLite[], projectId: string, n = 48): AccessLog[] {
  const r = mulberry32(hashStr(projectId + ":logs"));
  const actions: AccessAction[] = ["tool_call", "data_read", "data_write", "external_call"];
  return Array.from({ length: n }, (_, i) => {
    const a = pick(r, agents); const action = pick(r, actions);
    const status: AccessStatus = r() < 0.86 ? "ok" : r() < 0.6 ? "denied" : "error";
    const target = action === "data_read" || action === "data_write" ? pick(r, RESOURCES) : pick(r, TOOLS);
    const detail = action === "data_read" ? `${Math.floor(r() * 400) + 1} lignes lues`
      : action === "data_write" ? `${Math.floor(r() * 40) + 1} lignes écrites`
      : action === "external_call" ? `${pick(r, ["GET", "POST"])} ${pick(r, ["api.stripe.com", "hooks.slack.com", "api.github.com"])}`
      : `${Math.floor(r() * 5) + 1} paramètres`;
    return { id: `log_${i}_${short()}`, ts: isoAgo(Math.floor(r() * 4320)), agentId: a.id, agentName: a.name, action, target, detail, status, runId: `run_${(hashStr(projectId + i) % 9000 + 1000)}` };
  }).sort((x, y) => y.ts.localeCompare(x.ts));
}

export function genPrompts(agents: AgentLite[], projectId: string, n = 30): PromptRecord[] {
  const r = mulberry32(hashStr(projectId + ":prompts"));
  const cats: PromptCategory[] = ["ops", "analysis", "content", "code", "support", "data"];
  return Array.from({ length: n }, (_, i) => {
    const a = pick(r, agents); const outcome: Outcome = r() < 0.72 ? "success" : r() < 0.7 ? "partial" : "failed";
    const nLabels = 1 + Math.floor(r() * 2);
    const tokensIn = 300 + Math.floor(r() * 6000); const tokensOut = 200 + Math.floor(r() * 4000);
    // ~70% of traffic goes to cloud APIs, the rest to self-hosted models.
    const model = r() < 0.7 ? pick(r, CLOUD_MODELS) : pick(r, SELF_HOSTED_MODELS);
    return {
      id: `pr_${i}_${short()}`, ts: isoAgo(Math.floor(r() * 4320)), requester: pick(r, REQUESTERS),
      agentId: a.id, agentName: a.name, category: pick(r, cats),
      labels: Array.from({ length: nLabels }, () => pick(r, LABELS)).filter((v, idx, s) => s.indexOf(v) === idx),
      prompt: pick(r, PROMPTS), outcome,
      toolsUsed: Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(r, TOOLS)).filter((v, idx, s) => s.indexOf(v) === idx),
      dataAccessed: Array.from({ length: Math.floor(r() * 3) }, () => pick(r, RESOURCES)).filter((v, idx, s) => s.indexOf(v) === idx),
      model: model.id,
      // Self-hosted prompts cost near-zero API-side (infra is billed separately).
      tokensIn, tokensOut, costUsd: model.hosting === "self_hosted" ? money(0.001 + r() * 0.004) : money((tokensIn * 3 + tokensOut * 15) / 1_000_000 * (r() < 0.5 ? 5 : 1) + 0.002),
      runId: `run_${(hashStr(projectId + "p" + i) % 9000 + 1000)}`,
    };
  }).sort((x, y) => y.ts.localeCompare(x.ts));
}

export function genIncidents(agents: AgentLite[], projectId: string, n = 14): OpsIncident[] {
  const r = mulberry32(hashStr(projectId + ":incidents"));
  const kinds: IncidentKind[] = ["run_failure", "timeout", "tool_error", "guardrail_block", "rate_limit", "hallucination"];
  const sevs: (keyof typeof SEVERITY_META)[] = ["low", "medium", "high", "critical"];
  return Array.from({ length: n }, (_, i) => {
    const a = pick(r, agents); const kind = pick(r, kinds);
    const status: OpsStatus = r() < 0.4 ? "resolved" : r() < 0.6 ? "investigating" : "open";
    return {
      id: `inc_${i}_${short()}`, ts: isoAgo(Math.floor(r() * 4320)), agentId: a.id, agentName: a.name,
      title: INCIDENT_KIND_META[kind].label + " · " + a.name, kind,
      severity: sevs[Math.min(3, Math.floor(r() * r() * 4))], status,
      cause: CAUSES[kind], runId: `run_${(hashStr(projectId + "i" + i) % 9000 + 1000)}`,
      durationMs: Math.floor(r() * 90_000) + 800,
    };
  }).sort((x, y) => y.ts.localeCompare(x.ts));
}

export interface CostBreakdown {
  totalUsd: number; apiUsd: number; infraUsd: number;
  byAgent: { agentId: string; name: string; usd: number; runs: number }[];
  byBucket: { label: string; usd: number; hint: string }[];
  byModel: { model: string; label: string; hosting: Hosting; usd: number }[];
  daily: { day: string; usd: number }[];
}
export function genCosts(agents: AgentLite[], prompts: PromptRecord[], projectId: string): CostBreakdown {
  const r = mulberry32(hashStr(projectId + ":costs"));
  const apiUsd = money(prompts.reduce((s, p) => s + p.costUsd, 0) + 4 + r() * 20);
  const infraUsd = money(18 + r() * 60);
  const byAgent = agents.map((a) => {
    const ps = prompts.filter((p) => p.agentId === a.id);
    return { agentId: a.id, name: a.name, usd: money(ps.reduce((s, p) => s + p.costUsd, 0) + r() * 3), runs: ps.length + Math.floor(r() * 20) };
  }).sort((x, y) => y.usd - x.usd);
  // Cloud models: share of API spend. Self-hosted models: share of infra spend
  // (amortised serving cost), so the cloud/propriétaire split stays legible.
  const byModel = MODEL_CATALOG
    .map((m) => {
      const used = prompts.filter((p) => p.model === m.id);
      if (used.length === 0) return null;
      const usd = m.hosting === "cloud"
        ? money(used.reduce((s, p) => s + p.costUsd, 0) + r() * 4)
        : money((infraUsd / Math.max(1, prompts.filter((p) => modelById(p.model)?.hosting === "self_hosted").length)) * used.length);
      return { model: m.id, label: m.label, hosting: m.hosting, usd };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((x, y) => y.usd - x.usd);
  const daily = Array.from({ length: 14 }, (_, i) => ({ day: new Date(Date.now() - (13 - i) * 86_400_000).toISOString().slice(5, 10), usd: money(2 + r() * 12) }));
  const total = money(apiUsd + infraUsd);
  const byBucket = [
    { label: "Par run", usd: money(total / Math.max(1, byAgent.reduce((s, a) => s + a.runs, 0))), hint: "coût moyen / run" },
    { label: "Par prompt", usd: money(prompts.length ? apiUsd / prompts.length : 0), hint: "coût moyen / prompt" },
    { label: "Par mission", usd: money(total / (6 + Math.floor(r() * 8))), hint: "coût moyen / mission" },
    { label: "Par session", usd: money(total / (10 + Math.floor(r() * 20))), hint: "coût moyen / session de chat" },
  ];
  return { totalUsd: total, apiUsd, infraUsd, byAgent, byBucket, byModel, daily };
}

// ── Guardrails (localStorage-persisted per project) ──────────────────────────
const GR_KEY = (pid: string) => `aiops.guardrails.${pid}`;
export function loadGuardrails(pid: string): Guardrail[] {
  try { const raw = localStorage.getItem(GR_KEY(pid)); if (raw) return JSON.parse(raw) as Guardrail[]; } catch { /* ignore */ }
  return DEFAULT_GUARDRAILS();
}
export function saveGuardrails(pid: string, list: Guardrail[]) {
  try { localStorage.setItem(GR_KEY(pid), JSON.stringify(list)); } catch { /* ignore */ }
}
export function newGuardrail(): Guardrail {
  return { id: `gr_${short()}`, title: "Nouveau guardrail", category: "Général", enforcement: "warn", enabled: true, updatedAt: new Date().toISOString(), body: "## Règle\n\nDécrivez ici la règle en **markdown**.\n\n- Condition\n- Action attendue\n", matchScope: "all" };
}
/** Exported so the DB layer can seed aiops_guardrails on first use. */
export const DEFAULT_GUARDRAILS_EXPORT = (): Guardrail[] => DEFAULT_GUARDRAILS();
function DEFAULT_GUARDRAILS(): Guardrail[] {
  const now = new Date().toISOString();
  const g = (id: string, title: string, category: string, enforcement: Enforcement, body: string): Guardrail => ({ id, title, category, enforcement, enabled: true, updatedAt: now, body, matchScope: "all" });
  return [
    g("gr_pii", "Protection des données personnelles (PII)", "Données", "block",
      "## Interdiction d'exfiltration de PII\n\nL'agent **ne doit jamais** inclure de données personnelles (emails clients, téléphones, adresses) dans une sortie envoyée hors du système.\n\n- ✅ Autorisé : agréger/anonymiser\n- ⛔ Interdit : copier des lignes brutes `crm.contacts` vers un email externe\n\n> Toute tentative est bloquée et journalisée dans les incidents."),
    g("gr_destructive", "Actions destructrices sous approbation", "Actions", "block",
      "## Écritures & suppressions\n\nLes opérations `data_write` / `delete` sur des ressources **restreintes** requièrent une approbation humaine.\n\n| Ressource | Seuil |\n|---|---|\n| billing.invoices | Toujours |\n| crm.contacts | > 25 lignes |\n\nSinon → **demander confirmation**."),
    g("gr_scope", "Rester dans le périmètre de la mission", "Comportement", "warn",
      "## Périmètre\n\nL'agent reste sur l'objectif de la mission. Toute action hors périmètre déclenche un **avertissement** et une trace.\n\n- Pas d'appels d'outils non liés à la tâche\n- Pas d'accès à des modules non autorisés"),
    g("gr_secrets", "Aucun secret en clair", "Sécurité", "block",
      "## Secrets\n\nInterdiction d'afficher des clés API, tokens ou identifiants dans les réponses ou les logs.\n\n- Masquer : `sk-****`\n- Utiliser le Vault pour toute credential"),
    g("gr_rate", "Limites de débit & budget", "Coûts", "warn",
      "## Budget par run\n\n- Max **50k tokens** / run\n- Max **20 appels d'outils** / run\n- Coût plafond : **$0.50** / run\n\nAu-delà → avertir et suspendre."),
    g("gr_grounding", "Réponses sourcées", "Qualité", "log",
      "## Ancrage\n\nLes affirmations factuelles doivent être **sourcées** (RAG / outil). Les réponses non sourcées sont journalisées pour revue."),
  ];
}

// ── Ops: serveurs privés, déploiements, fine-tuning, incidents infra ─────────
export type ServerStatus = "online" | "degraded" | "offline";
export interface PrivateServer {
  id: string; name: string; region: string; status: ServerStatus;
  gpu: string; cpuPct: number; ramPct: number; gpuPct: number;
  reqPerMin: number; uptimePct: number; costPerDay: number;
  installedModels: string[]; // self-hosted model ids
  // Real infrastructure (null/'seed' for the demo servers).
  source: "seed" | "runpod" | "cloud" | "ovh" | "aws"; providerId: string | null;
  podId: string | null; endpointUrl: string | null; hourlyUsd: number; desiredStatus: string | null;
  // Real cost accounting (ledger-backed — migration 0180).
  accruedCostUsd: number; accruedHours: number; runningSince: string | null;
  // Pod deployment depth (migration 0182).
  gpuCount: number; cloudType: "secure" | "community"; quantization: string | null;
  maxModelLen: number | null; dockerImage: string | null;
  /** Repo HuggingFace servi par le pod (renseigné à la location, auto-détecté sinon). */
  servedModel: string | null;
}
export const SERVER_STATUS_META: Record<ServerStatus, Meta> = {
  online: { label: "En ligne", tone: "emerald" },
  degraded: { label: "Dégradé", tone: "amber" },
  offline: { label: "Hors ligne", tone: "red" },
};

export function genServers(projectId: string): PrivateServer[] {
  const r = mulberry32(hashStr(projectId + ":servers"));
  const defs = [
    { name: "gpu-fr-01", region: "eu-west · Paris", gpu: "2× H100 80GB" },
    { name: "gpu-fr-02", region: "eu-west · Paris", gpu: "1× H100 80GB" },
    { name: "gpu-us-01", region: "us-east · Ashburn", gpu: "4× A100 40GB" },
  ];
  const pool = [...SELF_HOSTED_MODELS];
  return defs.map((d, i) => {
    const status: ServerStatus = i === 1 && r() < 0.5 ? "degraded" : "online";
    const nModels = 1 + Math.floor(r() * 2);
    const installed = Array.from({ length: nModels }, () => pick(r, pool).id).filter((v, idx, s) => s.indexOf(v) === idx);
    return {
      id: `srv_${d.name}`, name: d.name, region: d.region, status, gpu: d.gpu,
      cpuPct: Math.round(15 + r() * 60), ramPct: Math.round(30 + r() * 55),
      gpuPct: Math.round(status === "degraded" ? 82 + r() * 15 : 25 + r() * 55),
      reqPerMin: Math.round(4 + r() * 90), uptimePct: Math.round((99 + r()) * 100) / 100,
      costPerDay: money(14 + r() * 38), installedModels: installed,
      source: "seed", providerId: null, podId: null, endpointUrl: null, hourlyUsd: 0, desiredStatus: null,
      accruedCostUsd: 0, accruedHours: 0, runningSince: null,
      gpuCount: 1, cloudType: "secure", quantization: null, maxModelLen: null, dockerImage: null,
      servedModel: null,
    };
  });
}

export type DeployTarget = "cloud" | string; // "cloud" | serverId
export interface Deployment {
  agentId: string; agentName: string; target: DeployTarget;
  model: string; env: "prod" | "staging";
}
export function genDeployments(agents: AgentLite[], servers: PrivateServer[], projectId: string): Deployment[] {
  const r = mulberry32(hashStr(projectId + ":deploys"));
  return agents.map((a) => {
    const selfHost = r() < 0.4 && servers.length > 0;
    const server = selfHost ? pick(r, servers) : null;
    const model = server
      ? (server.installedModels.length ? pick(r, server.installedModels) : pick(r, SELF_HOSTED_MODELS).id)
      : pick(r, CLOUD_MODELS).id;
    return { agentId: a.id, agentName: a.name, target: server ? server.id : "cloud", model, env: r() < 0.8 ? "prod" as const : "staging" as const };
  });
}

export type FtStatus = "queued" | "running" | "succeeded" | "failed";
export type FtMethod = "lora" | "qlora" | "full" | "peft" | "dpo" | "sft" | "continual";
/** Choix GPU proposés au lancement d'un job. */
export const GPU_OPTIONS = ["A10", "L4", "L40S", "A100", "H100"];
export interface FtHyperparams {
  method: FtMethod; lr: string; batchSize: number; loraRank: number; warmupPct: number; maxSeqLen: number;
  // Avancé
  weightDecay: string; optimizer: "adamw" | "adamw_8bit" | "sgd"; loraAlpha: number; dropout: number; scheduler: "cosine" | "linear" | "constant";
}
export interface FinetuneJob {
  id: string; name: string; baseModel: string; dataset: string;
  status: FtStatus; progressPct: number; epochs: number; loss: number[];
  gpuHours: number; costUsd: number; serverId: string; startedAt: string;
  gpu: string; timeH: number; accuracy: number | null;
  hp: FtHyperparams;
  // Real execution ('sim' = client ticker · 'runpod' = real pod, webhook-driven).
  runtime: "sim" | "runpod"; providerId: string | null; podId: string | null;
  logs: string[]; error: string | null;
}
export const FT_METHOD_META: Record<FtMethod, Meta> = {
  lora: { label: "LoRA", tone: "blue" }, qlora: { label: "QLoRA", tone: "violet" }, full: { label: "Full FT", tone: "orange" },
  peft: { label: "PEFT", tone: "cyan" }, dpo: { label: "DPO", tone: "emerald" }, sft: { label: "SFT", tone: "amber" },
  continual: { label: "Continual", tone: "slate" },
};
export const FT_STATUS_META: Record<FtStatus, Meta> = {
  running: { label: "Running", tone: "emerald" }, queued: { label: "Pending", tone: "amber" },
  succeeded: { label: "Completed", tone: "blue" }, failed: { label: "Failed", tone: "red" },
};
const FT_DATASETS = ["support-conversations.jsonl", "crm-notes-fr.jsonl", "code-reviews.jsonl", "brand-tone-emails.jsonl", "sql-queries-annotées.jsonl"];
export function genFinetunes(servers: PrivateServer[], projectId: string): FinetuneJob[] {
  const r = mulberry32(hashStr(projectId + ":finetunes"));
  const statuses: FtStatus[] = ["succeeded", "running", "queued", "failed", "succeeded"];
  return statuses.map((status, i) => {
    const base = pick(r, SELF_HOSTED_MODELS);
    const epochs = 2 + Math.floor(r() * 3);
    const progress = status === "succeeded" ? 100 : status === "failed" ? Math.round(20 + r() * 60) : status === "running" ? Math.round(15 + r() * 70) : 0;
    const nLoss = Math.max(2, Math.round((progress / 100) * 12));
    let l = 2.4 + r() * 0.8;
    const loss = Array.from({ length: nLoss }, () => { l = Math.max(0.4, l - (0.12 + r() * 0.22)); return Math.round(l * 100) / 100; });
    const gpuHours = Math.round((2 + r() * 30) * 10) / 10;
    const method: FtMethod = r() < 0.55 ? "lora" : r() < 0.7 ? "qlora" : "full";
    const rank = method === "full" ? 0 : pick(r, [8, 16, 32, 64]);
    return {
      id: `ft_${i}_${short()}`, name: `${base.family.toLowerCase()}-${FT_DATASETS[i % FT_DATASETS.length].split(".")[0].slice(0, 14)}-v${i + 1}`,
      baseModel: base.id, dataset: FT_DATASETS[i % FT_DATASETS.length], status,
      progressPct: progress, epochs, loss, gpuHours, costUsd: money(gpuHours * 2.4),
      serverId: servers.length ? pick(r, servers).id : "srv_gpu-fr-01", startedAt: isoAgo(Math.floor(r() * 10080)),
      gpu: pick(r, ["1× H100 80GB", "2× H100 80GB", "4× A100 40GB"]),
      timeH: Math.round(gpuHours / (1 + Math.floor(r() * 3)) * 10) / 10,
      accuracy: status === "succeeded" ? Math.round((78 + r() * 18) * 10) / 10 : null,
      hp: {
        method, lr: pick(r, ["1e-4", "2e-4", "5e-5", "1e-5"]), batchSize: pick(r, [4, 8, 16, 32]),
        loraRank: rank, warmupPct: pick(r, [3, 5, 10]), maxSeqLen: pick(r, [2048, 4096, 8192]),
        weightDecay: pick(r, ["0.01", "0.1", "0"]), optimizer: pick(r, ["adamw", "adamw_8bit", "sgd"] as const),
        loraAlpha: rank === 0 ? 0 : rank * 2, dropout: pick(r, [0, 0.05, 0.1]), scheduler: pick(r, ["cosine", "linear", "constant"] as const),
      },
      runtime: "sim" as const, providerId: null, podId: null, logs: [], error: null,
    };
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export type InfraKind = "gpu_oom" | "disk_full" | "network_latency" | "service_down" | "overheat" | "driver_crash";
export interface InfraIncident {
  id: string; ts: string; serverId: string; serverName: string; kind: InfraKind;
  severity: keyof typeof SEVERITY_META; status: OpsStatus; cause: string; impact: string;
}
export const INFRA_KIND_META: Record<InfraKind, Meta> = {
  gpu_oom: { label: "GPU OOM", tone: "red" }, disk_full: { label: "Disque plein", tone: "orange" },
  network_latency: { label: "Latence réseau", tone: "amber" }, service_down: { label: "Service down", tone: "red" },
  overheat: { label: "Surchauffe", tone: "orange" }, driver_crash: { label: "Crash driver", tone: "violet" },
};
const INFRA_CAUSES: Record<InfraKind, [string, string]> = {
  gpu_oom: ["Batch trop large sur le modèle 32B — VRAM saturée", "Inférences en échec pendant 4 min, retries automatiques"],
  disk_full: ["Checkpoints de fine-tuning non purgés (/var/models)", "Écritures bloquées, jobs en pause"],
  network_latency: ["Pic de latence inter-région (eu-west ↔ us-east)", "P95 des requêtes ×3 pendant 12 min"],
  service_down: ["Le serveur d'inférence vLLM a redémarré (watchdog)", "30 s d'indisponibilité, bascule cloud automatique"],
  overheat: ["Température GPU > 88°C — throttling thermique", "Débit d'inférence réduit de 40%"],
  driver_crash: ["Crash du driver CUDA après mise à jour", "Redémarrage requis, 6 min d'arrêt"],
};
export function genInfraIncidents(servers: PrivateServer[], projectId: string, n = 8): InfraIncident[] {
  const r = mulberry32(hashStr(projectId + ":infra"));
  const kinds: InfraKind[] = ["gpu_oom", "disk_full", "network_latency", "service_down", "overheat", "driver_crash"];
  const sevs: (keyof typeof SEVERITY_META)[] = ["low", "medium", "high", "critical"];
  return Array.from({ length: n }, (_, i) => {
    const s = servers.length ? pick(r, servers) : { id: "srv_gpu-fr-01", name: "gpu-fr-01" };
    const kind = pick(r, kinds);
    const status: OpsStatus = r() < 0.55 ? "resolved" : r() < 0.55 ? "investigating" : "open";
    return {
      id: `inf_${i}_${short()}`, ts: isoAgo(Math.floor(r() * 10080)), serverId: s.id, serverName: s.name,
      kind, severity: sevs[Math.min(3, Math.floor(r() * r() * 4))], status,
      cause: INFRA_CAUSES[kind][0], impact: INFRA_CAUSES[kind][1],
    };
  }).sort((x, y) => y.ts.localeCompare(x.ts));
}

// ═══ Fine-tuning onglet ═══════════════════════════════════════════════════════

// ── Datasets + data cleaning pipeline ────────────────────────────────────────
export type DsQuality = "validated" | "cleaning" | "issues";
export type CleanStepStatus = "done" | "running" | "pending" | "flagged";
export type DsType =
  | "csv" | "jsonl" | "pdf" | "docx" | "word" | "excel" | "json" | "conversations" | "sql" | "api"
  | "sharepoint" | "gdrive" | "notion" | "confluence" | "zendesk" | "salesforce" | "slack" | "teams" | "github" | "crm" | "erp";
export interface CleaningStep { step: string; status: CleanStepStatus; note?: string }
export interface FtDataset {
  id: string; name: string; type: DsType; source: string;
  docs: number; rows: number; tokens: number; sizeMB: number; lang: string;
  version: string; tags: string[];
  quality: DsQuality; createdAt: string;
  cleaning: CleaningStep[];
  /** Avant → nettoyage → après. */
  before: { rows: number; tokens: number };
  removed: { dups: number; pii: number; html: number; emails: number };
  /** Fichier réellement importé (bucket ft-datasets) — prévisualisation + entraînement RunPod. */
  storagePath?: string | null;
}
export const DS_QUALITY_META: Record<DsQuality, Meta> = {
  validated: { label: "Validé", tone: "emerald" }, cleaning: { label: "Nettoyage", tone: "amber" }, issues: { label: "Problèmes", tone: "red" },
};
export const CLEAN_STEP_META: Record<CleanStepStatus, Meta> = {
  done: { label: "Fait", tone: "emerald" }, running: { label: "En cours", tone: "blue" },
  pending: { label: "En attente", tone: "slate" }, flagged: { label: "À revoir", tone: "red" },
};
export const DS_TYPE_META: Record<DsType, Meta> = {
  csv: { label: "CSV", tone: "emerald" }, jsonl: { label: "JSONL", tone: "blue" },
  pdf: { label: "PDF", tone: "red" }, docx: { label: "DOCX", tone: "blue" },
  word: { label: "Word", tone: "blue" }, excel: { label: "Excel", tone: "emerald" }, json: { label: "JSON", tone: "amber" },
  conversations: { label: "Conversations", tone: "violet" }, sql: { label: "SQL", tone: "amber" },
  api: { label: "API", tone: "cyan" }, sharepoint: { label: "SharePoint", tone: "cyan" },
  gdrive: { label: "Google Drive", tone: "emerald" }, notion: { label: "Notion", tone: "slate" },
  confluence: { label: "Confluence", tone: "blue" }, zendesk: { label: "Zendesk", tone: "emerald" },
  salesforce: { label: "Salesforce", tone: "cyan" }, slack: { label: "Slack", tone: "violet" },
  teams: { label: "Teams", tone: "blue" }, github: { label: "GitHub", tone: "slate" },
  crm: { label: "CRM", tone: "orange" }, erp: { label: "ERP", tone: "orange" },
};
/** Mécanique d'import : chaque source passe par ces 6 étapes avant de devenir un dataset. */
export const IMPORT_PIPELINE = ["Upload", "Analyse", "Extraction", "Découpage", "Tokenisation", "Validation"];
/** Les 9 fonctions du pipeline de nettoyage (fusion de l'onglet Data Cleaning). */
export const CLEANING_FUNCTIONS = [
  "Suppression des doublons", "Correction automatique", "Suppression HTML",
  "Suppression des emails", "Suppression des données sensibles", "Anonymisation",
  "Découpage intelligent", "Tokenisation", "Normalisation",
];
const DS_DEFS: { name: string; type: DsType; source: string; lang: string; tags: string[] }[] = [
  { name: "support-conversations", type: "conversations", source: "Support · tickets résolus", lang: "FR", tags: ["support", "ton de marque"] },
  { name: "crm-notes-fr", type: "csv", source: "CRM · notes commerciales", lang: "FR", tags: ["ventes", "PII"] },
  { name: "code-reviews", type: "jsonl", source: "GitHub · reviews internes", lang: "EN", tags: ["code"] },
  { name: "brand-tone-emails", type: "conversations", source: "Gmail · emails envoyés", lang: "FR", tags: ["marketing", "ton de marque"] },
  { name: "sql-queries-annotées", type: "sql", source: "Analytics · requêtes validées", lang: "EN", tags: ["data"] },
  { name: "docs-produit-qa", type: "notion", source: "Notion · base de connaissances", lang: "FR", tags: ["produit", "Q&A"] },
  { name: "contrats-clauses", type: "pdf", source: "Drive · contrats types", lang: "FR", tags: ["légal", "sensible"] },
];
export function genFtDatasets(projectId: string): FtDataset[] {
  const r = mulberry32(hashStr(projectId + ":ftds"));
  return DS_DEFS.map((def, i) => {
    const quality: DsQuality = i === 0 ? "validated" : r() < 0.55 ? "validated" : r() < 0.6 ? "cleaning" : "issues";
    const step = (s: string, st: CleanStepStatus, note?: string): CleaningStep => ({ step: s, status: st, note });
    const all = (st: CleanStepStatus) => CLEANING_FUNCTIONS.map((f) => step(f, st));
    let cleaning: CleaningStep[];
    if (quality === "validated") cleaning = all("done");
    else if (quality === "cleaning") cleaning = CLEANING_FUNCTIONS.map((f, k) => step(f, k < 4 ? "done" : k === 4 ? "running" : "pending"));
    else cleaning = CLEANING_FUNCTIONS.map((f, k) =>
      k === 4 ? step(f, "flagged", `${Math.floor(r() * 40) + 5} identifiants clients détectés — masquage requis`)
      : k === 7 ? step(f, "flagged", `${Math.floor(r() * 20) + 2} documents dépassent la longueur max`)
      : step(f, "done"));
    const rows = 800 + Math.floor(r() * 12000);
    const dups = Math.floor(r() * 1500); const pii = Math.floor(r() * 900);
    const html = Math.floor(r() * 400); const emails = Math.floor(r() * 250);
    const tokens = rows * (300 + Math.floor(r() * 700));
    return {
      id: `ds_${i}_${short()}`, name: `${def.name}.${def.type === "conversations" ? "jsonl" : def.type}`,
      type: def.type, source: def.source, lang: def.lang, tags: def.tags,
      docs: Math.max(1, Math.floor(rows / (3 + Math.floor(r() * 10)))), rows, tokens,
      sizeMB: Math.round((2 + r() * 60) * 10) / 10, version: `v${1 + Math.floor(r() * 3)}`,
      quality, createdAt: isoAgo(Math.floor(r() * 20160)), cleaning,
      before: { rows: rows + dups + Math.floor(r() * 600), tokens: Math.floor(tokens * (1.15 + r() * 0.3)) },
      removed: { dups, pii, html, emails },
    };
  });
}

// ── Évaluation avant / après ─────────────────────────────────────────────────
export interface EvalCriterion {
  label: string; base: number; tuned: number;
  /** true → une valeur plus basse est meilleure (loss, hallucinations, latence, coût). */
  lowerIsBetter?: boolean;
  /** unité d'affichage ("%", "ms", "$/ktok", "" pour score brut). */
  unit?: string;
  /** max de l'échelle pour le rendu des barres (100 par défaut). */
  scale?: number;
}
export interface EvalBenchmark {
  questions: number; baseCorrect: number; tunedCorrect: number;
  baseAvgMs: number; tunedAvgMs: number; baseHalluc: number; tunedHalluc: number;
}
export interface EvalRun {
  id: string; name: string; tunedModel: string; baseModel: string;
  status: "done" | "running"; winRate: number; criteria: EvalCriterion[];
  /** Benchmark automatique : N questions envoyées aux deux modèles → winner. */
  benchmark: EvalBenchmark;
  samples: number; ts: string;
}
export function genFtEvals(jobs: FinetuneJob[], projectId: string): EvalRun[] {
  const r = mulberry32(hashStr(projectId + ":ftevals"));
  return jobs.filter((j) => j.status === "succeeded" || j.status === "running").map((j, i) => {
    const done = j.status === "succeeded";
    const up = (lo: number, hi: number, gain: number): [number, number] => {
      const base = Math.round((lo + r() * (hi - lo)) * 10) / 10;
      return [base, Math.min(99, Math.round((base + 1 + r() * gain) * 10) / 10)];
    };
    const [accB, accT] = up(62, 82, 15);
    const [precB, precT] = up(58, 80, 14);
    const [recB, recT] = up(56, 78, 14);
    const [f1B, f1T] = up(55, 78, 14);
    const [bleuB, bleuT] = up(22, 40, 12);
    const [rougeB, rougeT] = up(30, 48, 12);
    const lossB = Math.round((1.6 + r() * 1.2) * 100) / 100;
    const hallB = Math.round((6 + r() * 10) * 10) / 10;
    const latB = Math.round(900 + r() * 900);
    const costB = Math.round((3 + r() * 8) * 100) / 100;
    const criteria: EvalCriterion[] = [
      { label: "Accuracy", base: accB, tuned: accT, unit: "%" },
      { label: "Precision", base: precB, tuned: precT, unit: "%" },
      { label: "Recall", base: recB, tuned: recT, unit: "%" },
      { label: "Loss (éval)", base: lossB, tuned: Math.round((lossB - 0.25 - r() * 0.5) * 100) / 100, lowerIsBetter: true, unit: "", scale: 3 },
      { label: "F1", base: f1B, tuned: f1T, unit: "%" },
      { label: "BLEU", base: bleuB, tuned: bleuT, unit: "" },
      { label: "ROUGE-L", base: rougeB, tuned: rougeT, unit: "" },
      { label: "Hallucinations", base: hallB, tuned: Math.max(0.4, Math.round((hallB - 2 - r() * 5) * 10) / 10), lowerIsBetter: true, unit: "%", scale: 20 },
      { label: "Latence P50", base: latB, tuned: Math.round(latB * (0.55 + r() * 0.3)), lowerIsBetter: true, unit: "ms", scale: 2000 },
      { label: "Coût / ktok", base: costB, tuned: Math.round(costB * (0.15 + r() * 0.25) * 100) / 100, lowerIsBetter: true, unit: "$", scale: 12 },
    ];
    const baseCorrect = 55 + Math.floor(r() * 20);
    return {
      id: `ev_${i}_${short()}`, name: `eval-${j.name}`, tunedModel: j.name,
      baseModel: j.baseModel, status: done ? "done" as const : "running" as const,
      winRate: Math.round((58 + r() * 30) * 10) / 10,
      benchmark: {
        questions: 100, baseCorrect, tunedCorrect: Math.min(99, baseCorrect + 8 + Math.floor(r() * 18)),
        baseAvgMs: latB, tunedAvgMs: Math.round(latB * (0.55 + r() * 0.3)),
        baseHalluc: Math.round(hallB), tunedHalluc: Math.max(0, Math.round(hallB - 3 - r() * 4)),
      },
      criteria, samples: 120 + Math.floor(r() * 380), ts: isoAgo(Math.floor(r() * 7200)),
    };
  });
}

// ── Versions (registry des modèles affinés) ──────────────────────────────────
export type VersionStatus = "deployed" | "ready" | "archived";
export interface TunedVersion {
  id: string; name: string; version: string; baseModel: string; dataset: string;
  status: VersionStatus; winRate: number; createdAt: string; sizeGB: number; jobName: string;
  author: string; accuracy: number;
}
export const VERSION_STATUS_META: Record<VersionStatus, Meta> = {
  deployed: { label: "En production", tone: "emerald" }, ready: { label: "Prêt", tone: "blue" }, archived: { label: "Archivé", tone: "slate" },
};
export function genTunedVersions(jobs: FinetuneJob[], projectId: string): TunedVersion[] {
  const r = mulberry32(hashStr(projectId + ":ftvers"));
  const succeeded = jobs.filter((j) => j.status === "succeeded");
  const out: TunedVersion[] = [];
  succeeded.forEach((j, i) => {
    const nVers = 1 + Math.floor(r() * 2);
    for (let v = nVers; v >= 1; v--) {
      const status: VersionStatus = v === nVers ? (i === 0 ? "deployed" : r() < 0.5 ? "ready" : "deployed") : "archived";
      out.push({
        id: `tv_${i}_${v}_${short()}`, name: j.name.replace(/-v\d+$/, ""), version: `v${v}`,
        baseModel: j.baseModel, dataset: j.dataset, status,
        winRate: Math.round((55 + r() * 32) * 10) / 10, createdAt: isoAgo(Math.floor(r() * 20160)),
        sizeGB: (modelById(j.baseModel)?.sizeGB ?? 40) + Math.round(r() * 4), jobName: j.name,
        author: pick(r, ["olivier@founderos.ai", "lea@founderos.ai", "marc@founderos.ai"]),
        accuracy: Math.round((76 + r() * 20) * 10) / 10,
      });
    }
  });
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── Déploiement + monitoring prod ────────────────────────────────────────────
export type DeployEnv = "prod" | "staging" | "development" | "testing" | "canary" | "bluegreen" | "ab";
export const DEPLOY_ENV_META: Record<DeployEnv, Meta> = {
  prod: { label: "Production", tone: "emerald" }, staging: { label: "Staging", tone: "blue" },
  development: { label: "Development", tone: "slate" }, testing: { label: "Testing", tone: "slate" },
  canary: { label: "Canary", tone: "amber" }, bluegreen: { label: "Blue/Green", tone: "cyan" }, ab: { label: "A/B Testing", tone: "violet" },
};
/** Où le modèle est exposé une fois déployé. */
export type DeploySurface = "api" | "chatbot" | "slack" | "teams" | "crm" | "web" | "app";
export const DEPLOY_SURFACE_META: Record<DeploySurface, Meta> = {
  api: { label: "API", tone: "cyan" }, chatbot: { label: "Chatbot", tone: "violet" },
  slack: { label: "Slack", tone: "violet" }, teams: { label: "Teams", tone: "blue" },
  crm: { label: "CRM", tone: "orange" }, web: { label: "Site Web", tone: "emerald" }, app: { label: "Application", tone: "slate" },
};
export interface EndpointAlert { rule: string; channel: string; firing: boolean }
export type EndpointStatus = "pending_approval" | "active" | "rolled_back";
export interface FtEndpoint {
  id: string; versionName: string; version: string; serverId: string; env: DeployEnv;
  surface: DeploySurface;
  /** prod deploys start pending_approval until approved in Security. */
  status: EndpointStatus;
  /** part du trafic servie par cette version (canary / A-B / blue-green). */
  trafficPct: number;
  /** rollback automatique si les métriques chutent sous le seuil. */
  autoRollback: boolean;
  reqPerMin: number; p95Ms: number; errRatePct: number; driftScore: number;
  hallucinationPct: number; satisfactionPct: number; tokensPerDay: number;
  since: string; daily: { day: string; req: number }[];
  alerts: EndpointAlert[];
}
export function genFtEndpoints(versions: TunedVersion[], servers: PrivateServer[], projectId: string): FtEndpoint[] {
  const r = mulberry32(hashStr(projectId + ":ftend"));
  return versions.filter((v) => v.status === "deployed").map((v, i) => {
    const env: DeployEnv = i === 0 ? "prod" : pick(r, ["prod", "canary", "ab", "staging", "bluegreen"] as const);
    const hall = Math.round(r() * 60) / 10;
    const drift = Math.round(r() * 40) / 10;
    return {
      id: `ep_${i}_${short()}`, versionName: v.name, version: v.version,
      serverId: servers.length ? pick(r, servers).id : "srv_gpu-fr-01",
      env, surface: pick(r, ["api", "chatbot", "slack", "teams", "crm", "web", "app"] as const),
      status: "active" as const,
      autoRollback: r() < 0.7,
      trafficPct: env === "canary" ? pick(r, [5, 10, 20]) : env === "ab" || env === "bluegreen" ? 50 : 100,
      reqPerMin: Math.round(3 + r() * 60), p95Ms: Math.round(300 + r() * 1600),
      errRatePct: Math.round(r() * 30) / 10, driftScore: drift,
      hallucinationPct: hall, satisfactionPct: Math.round((78 + r() * 20) * 10) / 10,
      tokensPerDay: Math.round(0.4 + r() * 9.6),
      since: isoAgo(Math.floor(r() * 20160)),
      daily: Array.from({ length: 14 }, (_, d) => ({ day: new Date(Date.now() - (13 - d) * 86_400_000).toISOString().slice(5, 10), req: Math.round(200 + r() * 4200) })),
      alerts: [
        { rule: "Hallucinations > 5%", channel: "#ml-alerts (Slack)", firing: hall > 5 },
        { rule: "Dérive > 3", channel: "#ml-alerts (Slack)", firing: drift > 3 },
        { rule: "Erreurs > 2% (5 min)", channel: "#oncall (Slack)", firing: false },
      ],
    };
  });
}

// ── Coûts fine-tuning (historique par catégorie + prévision + estimateur) ────
export const GPU_RATE_PER_HOUR = 2.4; // $ / GPU·h (serveurs privés)
export type FtCostKind = "training" | "inference" | "storage" | "api" | "embeddings";
export const FT_COST_KIND_META: Record<FtCostKind, Meta> = {
  training: { label: "Entraînement", tone: "violet" }, inference: { label: "Inférence", tone: "cyan" },
  storage: { label: "Stockage", tone: "slate" }, api: { label: "API", tone: "blue" },
  embeddings: { label: "Embeddings", tone: "emerald" },
};
export interface FtCostEntry { id: string; label: string; kind: FtCostKind; gpuHours: number; usd: number; ts: string }
export function genFtCosts(jobs: FinetuneJob[], projectId: string): FtCostEntry[] {
  const r = mulberry32(hashStr(projectId + ":ftcost"));
  const training = jobs.filter((j) => j.gpuHours > 0).map((j, i) => ({
    id: `fc_t_${i}`, label: j.name, kind: "training" as const, gpuHours: j.gpuHours, usd: j.costUsd, ts: j.startedAt,
  }));
  const inference = Array.from({ length: 4 }, (_, i) => {
    const h = Math.round((6 + r() * 40) * 10) / 10;
    return { id: `fc_i_${i}`, label: `Serving semaine ${i + 1}`, kind: "inference" as const, gpuHours: h, usd: money(h * GPU_RATE_PER_HOUR), ts: isoAgo((i + 1) * 10080) };
  });
  const storage = Array.from({ length: 2 }, (_, i) => ({
    id: `fc_s_${i}`, label: `Stockage poids & datasets — ${i === 0 ? "ce mois" : "mois dernier"}`, kind: "storage" as const,
    gpuHours: 0, usd: money(4 + r() * 14), ts: isoAgo((i * 4 + 1) * 10080),
  }));
  const api = Array.from({ length: 2 }, (_, i) => ({
    id: `fc_a_${i}`, label: `Évaluations LLM-judge — semaine ${i + 1}`, kind: "api" as const,
    gpuHours: 0, usd: money(2 + r() * 9), ts: isoAgo((i + 1) * 10080 + 1440),
  }));
  const embeddings = Array.from({ length: 2 }, (_, i) => ({
    id: `fc_e_${i}`, label: `Embeddings RAG — semaine ${i + 1}`, kind: "embeddings" as const,
    gpuHours: 0, usd: money(1 + r() * 6), ts: isoAgo((i + 1) * 10080 + 2880),
  }));
  return [...training, ...inference, ...storage, ...api, ...embeddings].sort((a, b) => b.ts.localeCompare(a.ts));
}
/** Prévision mensuelle naïve : total 30 j × tendance (+12%). */
export function forecastMonthly(entries: FtCostEntry[]): { current: number; forecast: number } {
  const current = money(entries.reduce((s, e) => s + e.usd, 0));
  return { current, forecast: money(current * 1.12) };
}
/** Aujourd'hui → fin de mois (projection au rythme courant). */
export function forecastToday(entries: FtCostEntry[]): { today: number; eom: number } {
  const total = entries.reduce((s, e) => s + e.usd, 0);
  const today = money(total / 30);
  const day = new Date().getDate();
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  return { today, eom: money((total / 30) * daysInMonth * (1 + (daysInMonth - day) / 100)) };
}
/** Ventilation par département / agent / utilisateur (parts stables du total). */
export interface CostShare { label: string; usd: number; pct: number }
export function costShares(entries: FtCostEntry[], projectId: string): { byDepartment: CostShare[]; byAgent: CostShare[]; byUser: CostShare[] } {
  const total = entries.reduce((s, e) => s + e.usd, 0);
  const r = mulberry32(hashStr(projectId + ":shares"));
  const split = (labels: string[]): CostShare[] => {
    const w = labels.map(() => 0.5 + r());
    const sum = w.reduce((a, b) => a + b, 0);
    return labels.map((label, i) => ({ label, usd: money((w[i] / sum) * total), pct: Math.round((w[i] / sum) * 100) }))
      .sort((a, b) => b.usd - a.usd);
  };
  return {
    byDepartment: split(["Support", "Ventes", "RH", "Finance", "Produit"]),
    byAgent: split(["Support Agent", "Data Analyst", "Ops Copilot", "Growth Marketer"]),
    byUser: split(["olivier@founderos.ai", "lea@founderos.ai", "marc@founderos.ai", "api-key: prod-01"]),
  };
}

// ── Accès : RBAC par rôle + intégrations ─────────────────────────────────────
export interface FtRole {
  role: string; members: number;
  canTrain: boolean; canDeleteModel: boolean; canDeploy: boolean; canEditDatasets: boolean;
}
export const DEFAULT_FT_ROLES: FtRole[] = [
  { role: "Admin", members: 1, canTrain: true, canDeleteModel: true, canDeploy: true, canEditDatasets: true },
  { role: "ML Engineer", members: 2, canTrain: true, canDeleteModel: false, canDeploy: true, canEditDatasets: true },
  { role: "Developer", members: 3, canTrain: true, canDeleteModel: false, canDeploy: false, canEditDatasets: true },
  { role: "Manager", members: 2, canTrain: false, canDeleteModel: false, canDeploy: false, canEditDatasets: false },
  { role: "Viewer", members: 5, canTrain: false, canDeleteModel: false, canDeploy: false, canEditDatasets: false },
];
export interface FtIntegration { id: string; name: string; description: string; connected: boolean }
export const FT_INTEGRATIONS: FtIntegration[] = [
  { id: "openai", name: "OpenAI", description: "Fine-tuning API managé (GPT)", connected: false },
  { id: "anthropic", name: "Anthropic", description: "APIs Claude — évaluation LLM-judge & serving cloud", connected: true },
  { id: "mistral", name: "Mistral AI", description: "Fine-tuning API + poids ouverts (La Plateforme)", connected: true },
  { id: "meta", name: "Meta", description: "Poids Llama — licences & téléchargement officiel", connected: true },
  { id: "google", name: "Google", description: "Vertex AI — tuning Gemini & Gemma", connected: false },
  { id: "microsoft", name: "Microsoft", description: "Azure AI Foundry — fine-tuning & déploiement", connected: false },
  { id: "aws", name: "Amazon Web Services", description: "Bedrock & SageMaker — training managé", connected: false },
  { id: "huggingface", name: "Hugging Face", description: "Hub de modèles & datasets — push/pull des poids affinés", connected: true },
  { id: "ollama", name: "Ollama", description: "Serving local des modèles affinés (GGUF)", connected: true },
  { id: "nvidia", name: "NVIDIA", description: "NGC / NeMo — conteneurs & pilotes d'entraînement", connected: false },
];

// ── Labeling (datasets supervisés : IA propose → humain valide) ──────────────
export interface LabelSet { name: string; values: string[] }
export const LABEL_SETS: LabelSet[] = [
  { name: "Intent", values: ["Refund", "Shipping", "Complaint", "Technical"] },
  { name: "Sentiment", values: ["Positive", "Neutral", "Negative"] },
  { name: "Priorité", values: ["P1", "P2", "P3"] },
  { name: "Département", values: ["Support", "Ventes", "Finance"] },
];
export interface LabelTask {
  id: string; dataset: string; labelSets: string[];
  total: number; aiSuggested: number; humanValidated: number;
  agreementPct: number; startedAt: string;
}
export interface LabelQueueItem {
  id: string; text: string; suggested: { set: string; value: string; confidence: number }[];
}
export function genLabelTasks(projectId: string): LabelTask[] {
  const r = mulberry32(hashStr(projectId + ":label"));
  const defs = [
    { dataset: "support-conversations.jsonl", labelSets: ["Intent", "Sentiment", "Priorité"] },
    { dataset: "crm-notes-fr.csv", labelSets: ["Département", "Priorité"] },
    { dataset: "brand-tone-emails.jsonl", labelSets: ["Sentiment"] },
  ];
  return defs.map((d, i) => {
    const total = 1500 + Math.floor(r() * 8000);
    const ai = Math.floor(total * (0.6 + r() * 0.4));
    return {
      id: `lt_${i}_${short()}`, dataset: d.dataset, labelSets: d.labelSets,
      total, aiSuggested: ai, humanValidated: Math.floor(ai * (0.3 + r() * 0.6)),
      agreementPct: Math.round((86 + r() * 12) * 10) / 10, startedAt: isoAgo(Math.floor(r() * 10080)),
    };
  });
}
export const LABEL_QUEUE: LabelQueueItem[] = [
  { id: "q1", text: "Bonjour, je n'ai toujours pas reçu ma commande passée il y a 10 jours, c'est inadmissible. Je veux être remboursé.", suggested: [{ set: "Intent", value: "Refund", confidence: 92 }, { set: "Sentiment", value: "Negative", confidence: 97 }, { set: "Priorité", value: "P1", confidence: 81 }] },
  { id: "q2", text: "Merci pour votre aide rapide hier, le problème de connexion est résolu !", suggested: [{ set: "Intent", value: "Technical", confidence: 74 }, { set: "Sentiment", value: "Positive", confidence: 96 }, { set: "Priorité", value: "P3", confidence: 88 }] },
  { id: "q3", text: "Où en est l'expédition de ma commande #4521 ? Le suivi ne fonctionne pas.", suggested: [{ set: "Intent", value: "Shipping", confidence: 95 }, { set: "Sentiment", value: "Neutral", confidence: 72 }, { set: "Priorité", value: "P2", confidence: 79 }] },
];

// ── Experiments (comparer modèles / datasets / paramètres) ───────────────────
export interface ExperimentRun { model: string; accuracy: number; f1: number; latencyMs: number; costPerKTok: number }
export interface FtExperiment {
  id: string; name: string; dataset: string; goal: string;
  status: "done" | "running"; runs: ExperimentRun[]; winner: string; ts: string;
}
export function genExperiments(projectId: string): FtExperiment[] {
  const r = mulberry32(hashStr(projectId + ":exp"));
  const defs = [
    { name: "exp-support-modeles", dataset: "support-conversations.jsonl", goal: "Meilleur modèle support client", models: ["llama-4-maverick", "mistral-small-3.2", "qwen3-32b"] },
    { name: "exp-sql-methodes", dataset: "sql-queries-annotées.jsonl", goal: "LoRA vs QLoRA vs SFT", models: ["deepseek-r1-distill", "deepseek-r1-distill", "deepseek-r1-distill"] },
    { name: "exp-legal-datasets", dataset: "contrats-clauses.pdf", goal: "Impact de la taille du dataset", models: ["glm-4.5-air", "glm-4.5-air"] },
  ];
  return defs.map((d, i) => {
    const runs = d.models.map((m, k) => ({
      model: d.name.includes("methodes") ? `${modelById(m)?.label} · ${["LoRA", "QLoRA", "SFT"][k]}` : d.name.includes("datasets") ? `${modelById(m)?.label} · ${["5k", "15k"][k]} ex.` : (modelById(m)?.label ?? m),
      accuracy: Math.round((72 + r() * 22) * 10) / 10, f1: Math.round((66 + r() * 24) * 10) / 10,
      latencyMs: Math.round(250 + r() * 900), costPerKTok: Math.round((0.4 + r() * 2.4) * 100) / 100,
    }));
    const winner = [...runs].sort((a, b) => b.accuracy - a.accuracy)[0].model;
    return { id: `exp_${i}_${short()}`, name: d.name, dataset: d.dataset, goal: d.goal, status: i === 1 ? "running" as const : "done" as const, runs, winner, ts: isoAgo(Math.floor(r() * 10080)) };
  });
}

// ── Monitoring (drift + alertes multicanales) ────────────────────────────────
export type DriftKind = "model" | "data" | "prompt" | "concept";
export const DRIFT_META: Record<DriftKind, { label: string; desc: string }> = {
  model: { label: "Model Drift", desc: "la qualité des réponses se dégrade dans le temps" },
  data: { label: "Data Drift", desc: "les données de prod s'écartent du dataset d'entraînement" },
  prompt: { label: "Prompt Drift", desc: "les utilisateurs formulent des demandes nouvelles" },
  concept: { label: "Concept Drift", desc: "le sens métier des réponses attendues a changé" },
};
export interface MonitorState {
  tiles: { reqPerMin: number; avgMs: number; errPct: number; hallucPct: number; satisfactionPct: number; costDay: number; gpuPct: number; memPct: number };
  drifts: { kind: DriftKind; score: number; status: "ok" | "warning" | "critical" }[];
  accuracyTrend: number[]; // 14 j
  alertRules: { rule: string; slack: boolean; email: boolean; sms: boolean; firing: boolean }[];
  recommendation: string | null;
}
export function genMonitoring(projectId: string): MonitorState {
  const r = mulberry32(hashStr(projectId + ":monitor"));
  const drift = (kind: DriftKind): MonitorState["drifts"][number] => {
    const score = Math.round(r() * 70) / 10;
    return { kind, score, status: score >= 5 ? "critical" : score >= 3 ? "warning" : "ok" };
  };
  const drifts = (["model", "data", "prompt", "concept"] as DriftKind[]).map(drift);
  let acc = 94 + r() * 3;
  const accuracyTrend = Array.from({ length: 14 }, () => { acc = Math.max(84, acc - r() * 0.9 + 0.25); return Math.round(acc * 10) / 10; });
  const worst = [...drifts].sort((a, b) => b.score - a.score)[0];
  return {
    tiles: {
      reqPerMin: Math.round(8 + r() * 70), avgMs: Math.round(350 + r() * 700),
      errPct: Math.round(r() * 25) / 10, hallucPct: Math.round(r() * 55) / 10,
      satisfactionPct: Math.round((82 + r() * 15) * 10) / 10, costDay: money(6 + r() * 30),
      gpuPct: Math.round(25 + r() * 60), memPct: Math.round(35 + r() * 50),
    },
    drifts, accuracyTrend,
    alertRules: [
      { rule: "Accuracy < 90%", slack: true, email: true, sms: false, firing: accuracyTrend[accuracyTrend.length - 1] < 90 },
      { rule: "Hallucinations > 5%", slack: true, email: false, sms: false, firing: false },
      { rule: "Erreurs > 2% (5 min)", slack: true, email: true, sms: true, firing: false },
      { rule: "Dérive data > 5", slack: true, email: false, sms: false, firing: drifts.find((d) => d.kind === "data")!.score > 5 },
    ],
    recommendation: worst.score >= 3
      ? `${DRIFT_META[worst.kind].label} détecté (score ${worst.score}/10) — ${DRIFT_META[worst.kind].desc}. Recommandation : ré-entraîner avec les données des 30 derniers jours (onglet Entraînements).`
      : null,
  };
}

// ── Security (chiffrement, audit, approbations, conformité) ──────────────────
export interface SecAudit { id: string; actor: string; action: string; target: string; ts: string }
export function genSecAudit(projectId: string): SecAudit[] {
  const r = mulberry32(hashStr(projectId + ":secaudit"));
  const events = [
    ["lea@founderos.ai", "training.started", "llama-support-tone-v2"],
    ["olivier@founderos.ai", "model.deployed", "support-v3 → prod (canary 10%)"],
    ["marc@founderos.ai", "dataset.updated", "crm-notes-fr.csv (anonymisation relancée)"],
    ["lea@founderos.ai", "model.approved", "qwen3-sql-v1"],
    ["system", "rollback.auto", "support-v2 (erreurs > 2%)"],
    ["olivier@founderos.ai", "permission.changed", "Developer → canDeploy: off"],
    ["lea@founderos.ai", "dataset.exported", "support-conversations.jsonl (audit RGPD)"],
  ];
  return events.map((e, i) => ({ id: `sa_${i}`, actor: e[0], action: e[1], target: e[2], ts: isoAgo(Math.floor(r() * 10080)) }));
}
export interface SecApproval { id: string; title: string; requester: string; kind: string; ts: string }
export const SEC_PENDING_APPROVALS: SecApproval[] = [
  { id: "ap1", title: "Déployer legal-clauses-v1 en production", requester: "lea@founderos.ai", kind: "Déploiement", ts: isoAgo(360) },
  { id: "ap2", title: "Supprimer le modèle archivé support-v1", requester: "marc@founderos.ai", kind: "Suppression", ts: isoAgo(2880) },
];
export const COMPLIANCE_ITEMS = [
  { name: "RGPD", status: "conforme", note: "PII anonymisées dans tous les datasets validés ; registre des traitements à jour" },
  { name: "SOC 2 Type II", status: "en cours", note: "audit planifié — contrôles d'accès et journaux en place" },
  { name: "ISO 27001", status: "conforme", note: "chiffrement au repos (AES-256) et en transit (TLS 1.3)" },
];

// ── Politique de sécurité persistée (aiops_ft_settings.config.security) ──────
// Ces réglages ne sont pas décoratifs : `requireProdApproval` conditionne la mise
// en file d'attente d'un déploiement prod, `piiRedaction` conditionne les étapes
// d'anonymisation appliquées aux datasets importés.
export type ComplianceStatus = "conforme" | "en_cours" | "non_conforme" | "non_applicable";
export const COMPLIANCE_STATUS_META = {
  conforme: { label: "Conforme", tone: "emerald" },
  en_cours: { label: "En cours", tone: "amber" },
  non_conforme: { label: "Non conforme", tone: "red" },
  non_applicable: { label: "Non applicable", tone: "slate" },
} as const;

export interface ComplianceFramework {
  id: string; name: string; status: ComplianceStatus; note: string;
  owner: string; lastAuditAt: string | null; nextReviewAt: string | null; evidenceUrl: string;
}
export interface EncryptionPolicy {
  atRest: "aes_256" | "aes_128" | "none";
  keyManagement: "managed" | "kms" | "byok";
  keyRotationDays: number;
  lastKeyRotationAt: string | null;
  tlsMin: "1.3" | "1.2";
  piiRedaction: boolean;
  requireProdApproval: boolean;
}
export interface SecurityConfig { encryption: EncryptionPolicy; compliance: ComplianceFramework[] }

export const AT_REST_LABELS: Record<EncryptionPolicy["atRest"], string> = {
  aes_256: "AES-256", aes_128: "AES-128", none: "Désactivé",
};
export const KEY_MGMT_LABELS: Record<EncryptionPolicy["keyManagement"], string> = {
  managed: "Clés gérées par la plateforme", kms: "KMS du cloud provider", byok: "BYOK — vos propres clés",
};

export const SECURITY_DEFAULTS: SecurityConfig = {
  encryption: {
    atRest: "aes_256", keyManagement: "managed", keyRotationDays: 90,
    lastKeyRotationAt: null, tlsMin: "1.3", piiRedaction: true, requireProdApproval: true,
  },
  compliance: COMPLIANCE_ITEMS.map((c, i): ComplianceFramework => ({
    id: `cf_${i + 1}`, name: c.name,
    status: c.status === "conforme" ? "conforme" : "en_cours",
    note: c.note, owner: "", lastAuditAt: null, nextReviewAt: null, evidenceUrl: "",
  })),
};

export const newComplianceFramework = (): ComplianceFramework => ({
  id: `cf_${Math.random().toString(36).slice(2, 9)}`, name: "", status: "en_cours",
  note: "", owner: "", lastAuditAt: null, nextReviewAt: null, evidenceUrl: "",
});
export const newFtRole = (): FtRole => ({
  role: "", members: 1, canTrain: false, canDeleteModel: false, canDeploy: false, canEditDatasets: false,
});

/** Date de la prochaine rotation de clés attendue (null si jamais tournées). */
export function nextKeyRotation(p: EncryptionPolicy): string | null {
  if (!p.lastKeyRotationAt || p.keyRotationDays <= 0) return null;
  return new Date(new Date(p.lastKeyRotationAt).getTime() + p.keyRotationDays * 86_400_000).toISOString();
}

// ── Settings (configuration globale du studio) ───────────────────────────────
/** Fonctions du pipeline Data Prep (onglet Data Preparation) — persistées dans les settings. */
export const DATA_PREP_FUNCTIONS = [
  "Doublons", "Signatures", "Mails", "Publicités", "Scripts", "HTML",
  "Correction orthographique", "Uniformisation", "Reformulation",
  "Noms", "Emails", "Téléphones", "IBAN", "Cartes bancaires",
  "Langues", "Qualité", "Documents incomplets",
];
export interface FtSettings {
  gpuProvider: string; llmProvider: string; storage: string;
  retentionDays: number; versioning: boolean; backups: string;
  quotaGpuHours: number; quotaParallelJobs: number;
  /** Intégrations connectées (id → booléen). */
  integrations: Record<string, boolean>;
  /** Fonctions Data Prep actives (noms courts des GROUPS). */
  dataPrepEnabled: string[];
}
export const FT_SETTINGS_DEFAULTS: FtSettings = {
  gpuProvider: "self_hosted", llmProvider: "anthropic", storage: "s3",
  retentionDays: 365, versioning: true, backups: "daily",
  quotaGpuHours: 200, quotaParallelJobs: 2,
  integrations: Object.fromEntries(FT_INTEGRATIONS.filter((i) => i.connected).map((i) => [i.id, true])),
  dataPrepEnabled: DATA_PREP_FUNCTIONS,
};
const SETTINGS_KEY = (pid: string) => `aiops.ft.settings.${pid}`;
export function loadFtSettings(pid: string): FtSettings {
  try { const raw = localStorage.getItem(SETTINGS_KEY(pid)); if (raw) return { ...FT_SETTINGS_DEFAULTS, ...JSON.parse(raw) }; } catch { /* ignore */ }
  return FT_SETTINGS_DEFAULTS;
}
export function saveFtSettings(pid: string, s: FtSettings) {
  try { localStorage.setItem(SETTINGS_KEY(pid), JSON.stringify(s)); } catch { /* ignore */ }
}

// ── Small shared formatters ──────────────────────────────────────────────────
export const usd = (n: number) => `$${n.toFixed(2)}`;
export function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "à l'instant";
  const m = Math.floor(s / 60); if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60); if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24); return `il y a ${d} j`;
}
export const fmtDuration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
