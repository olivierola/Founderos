// Le moteur d'AUTOMATISATION : exécuter, sans modèle.
//
// C'est l'exact opposé de workflow-engine.ts, et c'est voulu. Une PROCÉDURE est
// un texte qu'un agent lit et interprète ; une AUTOMATISATION est une suite
// d'appels que ce module exécute lui-même. Là-bas on paie du raisonnement pour
// gagner de la souplesse ; ici on refuse le raisonnement pour gagner la seule
// chose qui compte quand rien n'est à juger : la certitude que deux exécutions
// des mêmes entrées produisent exactement la même chose.
//
// Ce qui en découle, et qui explique tout le reste de ce fichier :
//
//   • Aucun appel LLM. Pas un seul, y compris pour les conditions — un modèle
//     à qui on demande « est-ce que l'expéditeur est un client ? » répond
//     parfois non à la même donnée, et une automatisation qui hésite n'est plus
//     une automatisation.
//   • Aucune évaluation de code. Les gabarits sont résolus par chemin
//     (`trigger.from`), les conditions par un opérateur nommé. `eval` sur une
//     expression écrite dans un éditeur partagé serait une exécution de code
//     arbitraire côté serveur.
//   • Un journal par étape. Une procédure raconte ce qu'elle a fait dans le
//     rapport de l'agent ; une automatisation ne raconte rien. Sans trace, un
//     échec se résume à « failed » et personne ne peut dire laquelle des six
//     actions a cassé, ni avec quels arguments.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  cleanArgs, codeToolOf, flowEdges, outputVarOf,
  type WfGraph, type WfNode,
} from "./workflow-doc.ts";

type Admin = SupabaseClient;
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Les blocs qu'une automatisation sait exécuter. Tout le reste appartient à
 *  une procédure : une « étape » est une consigne rédigée, et une consigne
 *  rédigée n'a de sens que pour quelqu'un qui la lit. */
export const AUTOMATION_KINDS = ["trigger", "tool", "decision", "handoff"] as const;

export const isAutomationBlock = (kind: string | undefined): boolean =>
  AUTOMATION_KINDS.includes((kind ?? "") as typeof AUTOMATION_KINDS[number]);

// ── Gabarits ─────────────────────────────────────────────────────────────────

/**
 * Résoudre un chemin dans le contexte du run : `trigger.from`,
 * `steps.tool-a1.data.0.id`.
 *
 * Volontairement pauvre — pas d'expressions, pas d'opérateurs, pas de fonctions.
 * Un langage de gabarit qui sait faire des calculs finit toujours par avoir
 * besoin d'un interpréteur, et un interpréteur dans un champ de formulaire est
 * une porte ouverte sur le serveur.
 */
function readPath(ctx: Record<string, unknown>, path: string): unknown {
  let cur: unknown = ctx;
  // `items[0].id` et `items.0.id` désignent la même chose : le gabarit
  // acceptait les crochets, la lecture ne les comprenait pas — et rendait
  // undefined sans rien dire.
  const parts = normalizePath(path).split(".").filter(Boolean);
  for (const part of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(part);
      cur = Number.isInteger(i) ? cur[i] : undefined;
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
    } else return undefined;
  }
  return cur;
}

/** `{{ a.b[0] }}` → `a.b.0`. Les accolades sont tolérées : dans le champ
 *  « donnée » d'une condition, on écrit naturellement `{{trigger.from}}`, et
 *  la condition échouait alors toujours, faute de trouver un champ de ce nom. */
export function normalizePath(path: string): string {
  return String(path ?? "")
    .trim()
    .replace(/^\{\{\s*/, "").replace(/\s*\}\}$/, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/\[["']?([^\]"']+)["']?\]/g, ".$1")
    .replace(/^\./, "");
}

const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_.\[\]-]+)\s*\}\}/g;

/**
 * Remplacer les gabarits d'une valeur.
 *
 * Une chaîne qui n'est QUE `{{chemin}}` rend la valeur brute — un nombre reste
 * un nombre, un objet reste un objet. Sinon on interpole du texte. Sans cette
 * distinction, `{{steps.x.items}}` passé comme paramètre d'une API arriverait
 * en `"[object Object]"`.
 */
export function resolveTemplates(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = value.trim().match(/^\{\{\s*([a-zA-Z0-9_.\[\]-]+)\s*\}\}$/);
    if (whole) return readPath(ctx, whole[1]);
    return value.replace(TEMPLATE_RE, (_m, p) => {
      const v = readPath(ctx, p);
      return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveTemplates(v, ctx);
    return out;
  }
  return value;
}

// ── Conditions ───────────────────────────────────────────────────────────────

export interface AutomationTest {
  left: string;
  op: "equals" | "not_equals" | "contains" | "not_contains" | "exists" | "empty" | "gt" | "lt";
  right?: string;
}

export const TEST_OPS: Array<{ id: AutomationTest["op"]; label: string; needsRight: boolean }> = [
  { id: "equals", label: "est égal à", needsRight: true },
  { id: "not_equals", label: "est différent de", needsRight: true },
  { id: "contains", label: "contient", needsRight: true },
  { id: "not_contains", label: "ne contient pas", needsRight: true },
  { id: "gt", label: "est supérieur à", needsRight: true },
  { id: "lt", label: "est inférieur à", needsRight: true },
  { id: "exists", label: "existe", needsRight: false },
  { id: "empty", label: "est vide", needsRight: false },
];

/** Vrai / faux, sans jugement. Les comparaisons de texte sont insensibles à la
 *  casse : « ACME » et « acme » qui divergeraient produiraient un filtre qui
 *  marche un jour sur deux, ce qui est pire qu'un filtre qui ne marche pas. */
export function evaluateTest(test: AutomationTest | null | undefined, ctx: Record<string, unknown>): boolean {
  if (!test?.left) return false;
  const left = readPath(ctx, test.left);
  const right = resolveTemplates(test.right ?? "", ctx);

  const num = (v: unknown) => Number(typeof v === "string" ? v.trim().replace(",", ".") : v);
  const bothNumeric = (a: unknown, b: unknown) =>
    [a, b].every((v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) && Number.isFinite(num(v)));
  const text = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).toLowerCase();

  switch (test.op) {
    case "exists": return left != null && left !== "" && !(Array.isArray(left) && left.length === 0);
    case "empty": return left == null || left === "" || (Array.isArray(left) && left.length === 0);
    // « 10 » et « 10.0 » sont égaux ; comparés comme du texte, ils ne l'étaient pas.
    case "equals": return bothNumeric(left, right) ? num(left) === num(right) : text(left) === text(right);
    case "not_equals": return bothNumeric(left, right) ? num(left) !== num(right) : text(left) !== text(right);
    case "contains": return text(left).includes(text(right));
    case "not_contains": return !text(left).includes(text(right));
    case "gt": return Number.isFinite(num(left)) && Number.isFinite(num(right)) && num(left) > num(right);
    case "lt": return Number.isFinite(num(left)) && Number.isFinite(num(right)) && num(left) < num(right);
    default: return false;
  }
}

/** Les tests d'une décision. `tests` (plusieurs conditions) prime ; `test`
 *  (une seule) reste lu pour tout ce qui a été écrit avant. */
export function testsOf(d: Record<string, unknown>): AutomationTest[] {
  const many = Array.isArray(d.tests) ? (d.tests as AutomationTest[]) : [];
  const list = many.length ? many : d.test ? [d.test as AutomationTest] : [];
  return list.filter((t) => t && String(t.left ?? "").trim() && String(t.op ?? "").trim());
}

/** Toutes (par défaut) ou au moins une. Une décision sans test valide est
 *  FAUSSE : partir sur la branche « si oui » d'une condition vide serait agir
 *  sur rien. */
export function evaluateDecision(d: Record<string, unknown>, ctx: Record<string, unknown>): boolean {
  const tests = testsOf(d);
  if (tests.length === 0) return false;
  return d.match === "any"
    ? tests.some((t) => evaluateTest(t, ctx))
    : tests.every((t) => evaluateTest(t, ctx));
}

// ── La chaîne ────────────────────────────────────────────────────────────────

const outFrom = (g: WfGraph, id: string, handle: string | null): string | null => {
  const e = flowEdges(g.edges).find((x) => x.source === id && (x.sourceHandle ?? null) === handle);
  return e ? e.target : null;
};

// ── Exécution ────────────────────────────────────────────────────────────────

export interface AutomationResult {
  status: "succeeded" | "failed" | "stopped";
  steps: number;
  error?: string;
}

interface RunCtx {
  admin: Admin;
  runId: string;
  workflowId: string;
  workspaceId: string;
  projectId: string;
  /** Le contexte de données : `trigger` et `steps`. */
  data: Record<string, unknown>;
  position: number;
}

/** Ce qu'on garde d'une réponse d'API. Un listing complet dans un journal
 *  remplit la base sans rien apprendre de plus qu'un extrait. */
const CAP = 4000;
const clip = (v: unknown): unknown => {
  const s = JSON.stringify(v ?? null);
  return s && s.length > CAP ? { truncated: true, preview: s.slice(0, CAP) } : v ?? null;
};

async function logStep(
  rc: RunCtx, node: WfNode, status: string,
  input: unknown, output: unknown, error?: string,
): Promise<void> {
  await rc.admin.from("agent_workflow_run_steps").insert({
    run_id: rc.runId, workflow_id: rc.workflowId, workspace_id: rc.workspaceId,
    position: rc.position, block_id: node.id, block_kind: node.type ?? "",
    label: str((node.data ?? {}).label).slice(0, 200) || null,
    status,
    input: clip(input) ?? {},
    output: output === undefined ? null : clip(output),
    error_message: error?.slice(0, 800) ?? null,
    finished_at: new Date().toISOString(),
  }).then(() => {}, () => {});
}

// ── Fiabilité ────────────────────────────────────────────────────────────────

/** Une panne passagère : réseau, délai, quota (429), serveur (5xx). Seules
 *  celles-là méritent un nouvel essai — rejouer une 400 ou un « champ requis »
 *  redonnerait exactement la même erreur, et rejouer une écriture refusée pour
 *  une raison métier pourrait la faire passer deux fois. */
export class TransientError extends Error {}

export function isTransient(e: unknown): boolean {
  if (e instanceof TransientError) return true;
  const name = (e as { name?: string } | null)?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /\b(429|502|503|504)\b|timed? ?out|ECONNRESET|ECONNREFUSED|network|fetch failed|connection (reset|closed)/i.test(msg);
}

/** Nombre de nouveaux essais d'un bloc : `data.retries` (0-3), 2 par défaut. */
export function retriesOf(d: Record<string, unknown>): number {
  const n = Number(d.retries);
  return Number.isFinite(n) ? Math.max(0, Math.min(3, Math.round(n))) : 2;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Refusé AVANT exécution : quota (429) ou service indisponible (503). Seul
 *  cas où rejouer une ÉCRITURE est sûr — après un délai dépassé ou une 502,
 *  le mail est peut-être parti, et le rejouer l'enverrait deux fois. */
export function isRejectedBeforeRun(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return e instanceof TransientError && /\b(429|503)\b/.test(msg);
}

/** Réessayer une panne passagère avec un recul exponentiel (1 s, 3 s, 9 s). */
export async function withRetries<T>(
  fn: () => Promise<T>,
  retries: number,
  opts: {
    canRetry?: (e: unknown) => boolean;
    onRetry?: (attempt: number, e: unknown) => void;
    delay?: (attempt: number) => number;
  } = {},
): Promise<T> {
  const canRetry = opts.canRetry ?? isTransient;
  const delay = opts.delay ?? ((a: number) => 1000 * 3 ** (a - 1));
  const onRetry = opts.onRetry;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries || !canRetry(e)) throw e;
      onRetry?.(attempt + 1, e);
      await sleep(delay(attempt + 1));
    }
  }
}

/** Délai maximal d'un appel d'action, et d'une exécution de code. */
const ACTION_TIMEOUT_MS = 45_000;
const CODE_TIMEOUT_MS = 90_000;
/** Une automatisation tourne EN LIGNE dans une fonction edge : passé ce
 *  budget, on s'arrête proprement entre deux étapes plutôt que d'être tué au
 *  milieu d'une écriture par le couperet de la plateforme. */
const RUN_BUDGET_MS = 130_000;

/** Appeler l'action d'un connecteur. Le routage dépend de la SOURCE du
 *  connecteur : une app branchée en interne passe par `connector-action` (clé
 *  déchiffrée côté serveur), une app branchée via Composio par `composio-action`.
 *  Se tromper de porte donne « provider inconnu » alors que l'app est connectée. */
async function callAction(
  rc: RunCtx, provider: string, action: string, params: Record<string, unknown>,
): Promise<unknown> {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) throw new Error("Runtime non configuré (SUPABASE_URL / SERVICE_ROLE_KEY).");

  const { data: conn } = await rc.admin.from("connectors")
    .select("source").eq("project_id", rc.projectId).eq("provider", provider).maybeSingle();
  const composio = (conn as { source?: string } | null)?.source === "composio";

  const fn = composio ? "composio-action" : "connector-action";
  const body = composio
    ? { workspace_id: rc.workspaceId, project_id: rc.projectId, toolkit: provider, tool_slug: action, arguments: params }
    : { workspace_id: rc.workspaceId, project_id: rc.projectId, provider, action, params };

  const res = await fetch(`${base}/functions/v1/${fn}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!res.ok || (json && typeof json.error === "string")) {
    const msg = str(json?.error) || `HTTP ${res.status}`;
    throw res.status === 429 || res.status >= 500 ? new TransientError(`${msg} (HTTP ${res.status})`) : new Error(msg);
  }
  return json?.result ?? json?.data ?? json;
}

/**
 * Exécuter du code dans le sandbox du projet.
 *
 * Même porte que celle des agents (`POST <sandbox>/v1/code/execute`), et pas
 * une seconde : le sandbox est un service, pas une capacité de l'agent, et un
 * deuxième chemin d'appel divergerait au premier changement de contrat.
 *
 * `stateful: false`, contrairement aux agents. Un agent enchaîne des cellules
 * dans un même raisonnement et veut garder ses variables ; une automatisation
 * doit rendre le même résultat à chaque exécution, et un noyau qui se souvient
 * du run précédent est précisément ce qui l'en empêcherait.
 */
async function runCode(rc: RunCtx, language: string, code: string): Promise<unknown> {
  const { data } = await rc.admin.from("app_config").select("value").eq("key", "sandbox_url").maybeSingle();
  const base = str((data as { value?: string } | null)?.value).replace(/\/$/, "");
  if (!base) throw new Error("Aucun sandbox configuré : impossible d'exécuter du code.");

  const res = await fetch(`${base}/v1/code/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Évite la page d'avertissement des tunnels ngrok gratuits, qui renvoie
      // du HTML là où on attend du JSON.
      "ngrok-skip-browser-warning": "true",
      "User-Agent": "Anduran-Automation/1.0",
    },
    body: JSON.stringify({ language, code, stateful: false }),
    signal: AbortSignal.timeout(CODE_TIMEOUT_MS),
  });
  const text = await res.text();
  if (text.trimStart().startsWith("<")) {
    // Le tunnel ngrok gratuit sert une page HTML le temps de se reconnecter :
    // c'est passager par nature.
    throw new TransientError("Sandbox injoignable : une page HTML est revenue au lieu du résultat.");
  }
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = `Sandbox (${res.status}) : ${text.slice(0, 300)}`;
    throw res.status === 429 || res.status >= 500 ? new TransientError(msg) : new Error(msg);
  }

  const stderr = str(json.stderr).trim();
  const status = str(json.status).toLowerCase();
  // Un script qui échoue doit ARRÊTER la chaîne. Rendre sa trace comme un
  // résultat ordinaire ferait continuer les étapes suivantes sur une valeur
  // qui n'existe pas.
  if (status === "error" || (stderr && !str(json.stdout).trim())) {
    throw new Error(stderr.slice(0, 500) || "le code a échoué");
  }
  // `result` quand le sandbox sait typer la dernière expression, sinon stdout.
  return json.result ?? (str(json.stdout).trim() || null);
}

/**
 * Exécuter l'automatisation, du déclencheur jusqu'au bout de la chaîne.
 *
 * La marche suit les arêtes de flux, une étape à la fois. Une condition fausse
 * emprunte la branche « sinon » ; si elle n'existe pas, le run S'ARRÊTE et le
 * dit — c'est un résultat, pas une panne, et le confondre avec un échec ferait
 * sonner l'alerte chaque fois qu'un filtre fait son travail.
 */
export async function runAutomation(admin: Admin, opts: {
  runId: string;
  workflow: { id: string; workspace_id: string; project_id: string; blocks: WfGraph };
  payload: Record<string, unknown>;
}): Promise<AutomationResult> {
  const g = opts.workflow.blocks;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const rc: RunCtx = {
    admin, runId: opts.runId,
    workflowId: opts.workflow.id,
    workspaceId: opts.workflow.workspace_id,
    projectId: opts.workflow.project_id,
    data: { trigger: opts.payload ?? {}, steps: {} },
    position: 0,
  };

  const trigger = g.nodes.find((n) => n.type === "trigger");
  let cursor = trigger ? outFrom(g, trigger.id, null) : null;
  // Garde-fou : une automatisation dont la chaîne reboucle tournerait sans fin
  // et consommerait le quota d'appels de l'app connectée avant qu'on s'en rende
  // compte. 100 étapes est très au-delà de ce qu'une automatisation légitime
  // enchaîne, et très en deçà de ce qui fait mal.
  const MAX = 100;
  const started = Date.now();
  /** Étapes en échec que leur bloc demandait d'ignorer (`on_error: continue`). */
  const tolerated: string[] = [];
  const finish = (status: AutomationResult["status"]): AutomationResult => ({
    status, steps: rc.position,
    ...(tolerated.length ? { error: `${tolerated.length} étape(s) en échec ignorée(s) : ${tolerated.join(", ")}` } : {}),
  });

  while (cursor && rc.position < MAX) {
    const node = byId.get(cursor);
    if (!node) break;
    if (Date.now() - started > RUN_BUDGET_MS) {
      return {
        status: "failed", steps: rc.position,
        error: `Délai dépassé après ${rc.position} étape(s) : une automatisation doit tenir en ~2 minutes. Ce qui reste (à partir de « ${str((node.data ?? {}).label) || node.type} ») relève d'une procédure confiée à un agent.`,
      };
    }
    rc.position += 1;
    const d = (node.data ?? {}) as Record<string, unknown>;

    try {
      if (node.type === "decision") {
        const tests = testsOf(d);
        const pass = evaluateDecision(d, rc.data);
        // Le journal montre chaque test ET la valeur lue : « faux » sans la
        // valeur ne dit pas si la donnée manquait ou ne correspondait pas.
        await logStep(rc, node, "succeeded",
          { tests, match: d.match === "any" ? "any" : "all" },
          { result: pass, checks: tests.map((t) => ({ left: t.left, value: clip(readPath(rc.data, t.left)), pass: evaluateTest(t, rc.data) })) });
        const next = outFrom(g, node.id, pass ? "true" : "false");
        if (!next) {
          // Pas de suite sur cette branche : la chaîne se termine ici.
          return finish(pass ? "succeeded" : "stopped");
        }
        cursor = next;
        continue;
      }

      if (node.type === "tool") {
        const lang = codeToolOf(d);
        let result: unknown;
        let input: Record<string, unknown>;
        let attempts = 1;
        const retries = retriesOf(d);
        const onRetry = (n: number) => { attempts = n + 1; };

        if (lang && str(d.code).trim()) {
          // Les gabarits sont résolus DANS le code avant exécution : c'est ce
          // qui permet d'écrire `total = {{deals.total}}` et d'obtenir la
          // valeur du pas précédent, sans exposer d'interpréteur.
          const code = str(resolveTemplates(str(d.code), rc.data));
          // Un script sans état se rejoue sans risque : même entrée, même sortie.
          result = await withRetries(() => runCode(rc, lang.language, code), retries, { onRetry });
          input = { language: lang.language, code };
        } else {
          const provider = str(d.provider).trim();
          const action = str(d.action).trim();
          if (!provider || !action) {
            throw new Error("Bloc incomplet : choisissez une action d'application, ou écrivez du code.");
          }
          // `cleanArgs` d'abord : une paire à moitié écrite dans l'éditeur ne
          // doit pas partir dans un appel d'API sous forme de clé vide.
          const params = (resolveTemplates(cleanArgs(d.args), rc.data) ?? {}) as Record<string, unknown>;
          // Une LECTURE se rejoue sur toute panne passagère ; une ÉCRITURE
          // seulement si elle a été refusée avant d'être exécutée.
          const { isWriteAction } = await import("./internal-agent-tools.ts");
          const write = isWriteAction(action);
          result = await withRetries(() => callAction(rc, provider, action, params), retries, {
            onRetry, canRetry: write ? isRejectedBeforeRun : isTransient,
          });
          input = { provider, action, params };
        }

        // Le résultat est rangé DEUX fois : sous l'id du bloc (toujours) et
        // sous son nom de variable (s'il en a un). Le premier garantit qu'on
        // peut toujours y faire référence ; le second est celui qu'on écrit.
        (rc.data.steps as Record<string, unknown>)[node.id] = result;
        const v = outputVarOf(d);
        if (v) rc.data[v] = result;

        await logStep(rc, node, "succeeded", { ...input, ...(v ? { variable: v } : {}), ...(attempts > 1 ? { attempts } : {}) }, result);
        cursor = outFrom(g, node.id, null);
        continue;
      }

      if (node.type === "handoff") {
        // Le point de sortie vers le jugement. Une automatisation qui a besoin
        // d'apprécier quelque chose passe la main ici, avec ce qu'elle a
        // récolté — et s'arrête là : attendre le retour d'un agent demanderait
        // de suspendre puis reprendre le run, ce que ce moteur ne fait pas.
        const agentIds = Array.isArray(d.agent_ids) ? (d.agent_ids as unknown[]).map(String).filter(Boolean) : [];
        if (agentIds.length === 0) throw new Error("Aucun agent choisi pour la passation.");
        const brief = str(resolveTemplates(str(d.body) || str(d.expects), rc.data));
        const missionIds: string[] = [];
        for (const agentId of agentIds) {
          const { data: mission } = await admin.from("internal_agent_missions").insert({
            agent_id: agentId, workspace_id: rc.workspaceId, project_id: rc.projectId,
            title: str(d.label).slice(0, 160) || "Tâche d'une automatisation",
            brief: [brief, "", "## Données de l'automatisation", "```json",
              JSON.stringify(rc.data, null, 2).slice(0, 6000), "```"].join("\n"),
            status: "active", board_column: "todo", priority: "high",
          }).select("id").single();
          const missionId = (mission as { id: string } | null)?.id;
          if (!missionId) continue;
          missionIds.push(missionId);
          const { data: run } = await admin.from("internal_agent_runs").insert({
            mission_id: missionId, agent_id: agentId,
            workspace_id: rc.workspaceId, project_id: rc.projectId,
            status: "queued", triggered_via: "api",
          }).select("id").single();
          const runId = (run as { id: string } | null)?.id;
          const base = Deno.env.get("SUPABASE_URL");
          const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
          if (runId && base && key) {
            // Attendu : la fonction rend la main dès le run mis en file. Un
            // fetch lâché sans attente pouvait ne jamais partir si l'automatisation
            // se terminait avant — la mission restait « en file » pour toujours.
            await fetch(`${base}/functions/v1/internal-agent-run`, {
              method: "POST",
              headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
              body: JSON.stringify({ agent_id: agentId, mode: "mission", run_id: runId }),
              signal: AbortSignal.timeout(20_000),
            }).catch(() => {});
          }
        }
        await logStep(rc, node, "succeeded", { agents: agentIds }, { missions: missionIds });
        return finish("succeeded");
      }

      // Un bloc de procédure dans une automatisation : on ne devine pas ce
      // qu'il voulait dire, on le saute en le disant. L'éditeur ne les propose
      // pas, mais une automatisation convertie depuis une procédure en porte.
      await logStep(rc, node, "skipped", {}, null,
        `Bloc « ${node.type} » ignoré : une automatisation n'exécute que des actions, des conditions et des passations.`);
      cursor = outFrom(g, node.id, null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await logStep(rc, node, "failed", (node.data ?? {}) as Record<string, unknown>, null, msg);
      // `on_error: continue` — l'étape était accessoire (une notification,
      // un journal) : on range l'erreur à sa place et la chaîne continue. Les
      // étapes suivantes peuvent la tester avec `{{steps.<id>.error}}`.
      if (node.type === "tool" && d.on_error === "continue") {
        const failed = { error: msg };
        (rc.data.steps as Record<string, unknown>)[node.id] = failed;
        const v = outputVarOf(d);
        if (v) rc.data[v] = failed;
        tolerated.push(str(d.label) || str(d.action) || node.id);
        cursor = outFrom(g, node.id, null);
        continue;
      }
      return { status: "failed", steps: rc.position, error: `${str(d.label) || node.type} : ${msg}` };
    }
  }

  if (rc.position >= MAX) {
    return { status: "failed", steps: rc.position, error: `Plafond de ${MAX} étapes atteint — la chaîne reboucle sur elle-même.` };
  }
  return finish("succeeded");
}
