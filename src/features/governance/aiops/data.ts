// AI Ops & Governance — types, catalogues et barèmes du module.
//
// Ce fichier ne FABRIQUE plus rien. Il ne contient que ce qui est vrai
// indépendamment d'un client : la forme des objets, les libellés d'affichage,
// le catalogue de modèles et ses prix, les barèmes GPU, et les jeux de départ
// qu'on PROPOSE d'installer (guardrails recommandés, matrice de rôles).
//
// Les données, elles, viennent de db.ts : les tables aiops_* pour ce que
// l'équipe crée, internal_agent_runs / _run_events pour la télémétrie. Un
// projet neuf s'ouvre vide, et c'est voulu — un tableau de bord pré-rempli de
// chiffres inventés est un tableau de bord dont on n'apprend jamais à se
// méfier.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { SEVERITY_META } from "../shared";

export { SEVERITY_META };
export type Tone = "red" | "orange" | "amber" | "emerald" | "blue" | "violet" | "slate" | "cyan";
export interface Meta { label: string; tone: Tone }

// ── Les agents réels du projet (à qui la télémétrie est attribuée) ──────────
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

const money = (n: number) => Math.round(n * 100) / 100;
const short = () => Math.random().toString(36).slice(2, 8);

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



export interface CostBreakdown {
  totalUsd: number; apiUsd: number; infraUsd: number;
  byAgent: { agentId: string; name: string; usd: number; runs: number }[];
  byBucket: { label: string; usd: number; hint: string }[];
  byModel: { model: string; label: string; hosting: Hosting; usd: number }[];
  daily: { day: string; usd: number }[];
}

// ── Guardrails (localStorage-persisted per project) ──────────────────────────
const GR_KEY = (pid: string) => `aiops.guardrails.${pid}`;
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


export type DeployTarget = "cloud" | string; // "cloud" | serverId
export interface Deployment {
  agentId: string; agentName: string; target: DeployTarget;
  model: string; env: "prod" | "staging";
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
const DS_DEFS: { name: string; type: DsType; source: string; lang: string; tags: string[] }[] = [
  { name: "support-conversations", type: "conversations", source: "Support · tickets résolus", lang: "FR", tags: ["support", "ton de marque"] },
  { name: "crm-notes-fr", type: "csv", source: "CRM · notes commerciales", lang: "FR", tags: ["ventes", "PII"] },
  { name: "code-reviews", type: "jsonl", source: "GitHub · reviews internes", lang: "EN", tags: ["code"] },
  { name: "brand-tone-emails", type: "conversations", source: "Gmail · emails envoyés", lang: "FR", tags: ["marketing", "ton de marque"] },
  { name: "sql-queries-annotées", type: "sql", source: "Analytics · requêtes validées", lang: "EN", tags: ["data"] },
  { name: "docs-produit-qa", type: "notion", source: "Notion · base de connaissances", lang: "FR", tags: ["produit", "Q&A"] },
  { name: "contrats-clauses", type: "pdf", source: "Drive · contrats types", lang: "FR", tags: ["légal", "sensible"] },
];

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

// ── Coûts fine-tuning (historique par catégorie + prévision + estimateur) ────
export const GPU_RATE_PER_HOUR = 2.4; // $ / GPU·h (serveurs privés)
export type FtCostKind = "training" | "inference" | "storage" | "api" | "embeddings";
export const FT_COST_KIND_META: Record<FtCostKind, Meta> = {
  training: { label: "Entraînement", tone: "violet" }, inference: { label: "Inférence", tone: "cyan" },
  storage: { label: "Stockage", tone: "slate" }, api: { label: "API", tone: "blue" },
  embeddings: { label: "Embeddings", tone: "emerald" },
};
export interface FtCostEntry { id: string; label: string; kind: FtCostKind; gpuHours: number; usd: number; ts: string }
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
/** Ventilation d'un ensemble de lignes de coût, par poste réellement facturé.
 *  Il n'y a pas de découpe par département ni par utilisateur : le ledger ne
 *  porte pas cette information, et l'inventer donnerait une répartition qui a
 *  l'air d'un fait sans en être un. */
export interface CostShare { label: string; usd: number; pct: number }
export function costShares(entries: FtCostEntry[]): CostShare[] {
  const total = entries.reduce((s, e) => s + e.usd, 0);
  if (total <= 0) return [];
  const byLabel = new Map<string, number>();
  for (const e of entries) byLabel.set(e.label, (byLabel.get(e.label) ?? 0) + e.usd);
  return [...byLabel.entries()]
    .map(([label, sum]) => ({ label, usd: money(sum), pct: Math.round((sum / total) * 100) }))
    .sort((a, b) => b.usd - a.usd);
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

// ── Security (chiffrement, audit, approbations, conformité) ──────────────────
export interface SecAudit { id: string; actor: string; action: string; target: string; ts: string }
export interface SecApproval { id: string; title: string; requester: string; kind: string; ts: string }

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
  // Aucun référentiel pré-déclaré. Un statut de conformité est une AFFIRMATION
  // — livrer un projet qui annonce « RGPD : conforme » avant le moindre audit
  // fait porter au client une allégation qu'il n'a pas faite. L'équipe ajoute
  // ses référentiels et en assume le statut (voir COMMON_FRAMEWORKS, proposés
  // en un clic mais créés à « non applicable »).
  compliance: [],
};

/** Les référentiels qu'on propose d'ajouter d'un clic. Le NOM est un fait ;
 *  le statut reste à « non applicable » tant que personne ne l'a établi. */
export const COMMON_FRAMEWORKS = ["RGPD", "SOC 2 Type II", "ISO 27001", "EU AI Act"];

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
