
// Le CADRAGE d'une mission par l'équipe d'agents (0295).
//
// L'humain a dit ce qu'il voulait : titre, description, brief, livrables. Ici,
// l'équipe s'en empare — et chaque prise de parole est un vrai appel au modèle,
// avec la persona, les instructions et les outils de l'agent qui parle :
//
//   scoping:lead         le pilote lit le brief : compréhension, hypothèses,
//                        risques, questions, approche.
//   scoping:review:<i>   chaque responsable d'une autre équipe le challenge
//                        depuis son métier.
//   scoping:consolidate  le pilote tranche, reformule la mission, et ne garde
//                        pour l'humain que les questions BLOQUANTES.
//   (questions)          on attend ses réponses — ou son « continuez sans ».
//   planning:plan        le pilote découpe en work items, fixe des délais
//                        réalistes POUR DES AGENTS, pose les dépendances,
//                        confie chaque item à une équipe.
//   planning:team:<i>    chaque équipe affine ses items, les redécoupe au besoin
//                        et les répartit entre ses agents selon leurs outils.
//   planning:done        le plan est prêt ; l'exécution part (autostart) ou
//                        attend le feu vert humain.
//
// Une étape par appel, jamais plus : un appel au modèle de raisonnement peut
// prendre une minute, et la fonction n'en a que quelques-unes. L'étape est
// « réservée » (suffixe @run) avant d'être jouée : deux appels concurrents ne
// la jouent jamais deux fois. Le planificateur relance ce qui s'est perdu.

import type { SupabaseClient } from "@supabase/supabase-js";
import { callAi } from "./ai.ts";
import { logLlmUsage } from "./llm-tracking.ts";

type Admin = SupabaseClient;

export type PlanningStatus = "none" | "scoping" | "questions" | "planning" | "planned" | "executing" | "failed";

interface Team { id: string; name: string; agent_ids: string[]; lead_id: string | null; focus?: string }

interface CrewAgent {
  id: string;
  name: string;
  persona: string | null;
  description: string | null;
  instructions: string | null;
  is_orchestrator: boolean | null;
  mission_enabled: boolean | null;
  tools: string[];
}

interface Mission {
  id: string;
  workspace_id: string;
  project_id: string;
  dashboard_id: string | null;
  name: string;
  identifier: string;
  description: string | null;
  brief: string | null;
  deliverables: Array<{ title?: string; description?: string }> | null;
  planning_teams: string[] | null;
  planning_status: PlanningStatus;
  planning_step: string | null;
  planning_lead_agent_id: string | null;
  planning_summary: string | null;
  planning_autostart: boolean | null;
  planning_error: string | null;
}

interface Question { question: string; why?: string; suggestion?: string }

const MAX_TRIES = 3;
/** Une étape réservée depuis plus longtemps a planté : on la rend. */
export const STEP_LEASE_MS = 6 * 60 * 1000;

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
/**
 * Le texte d'un point rendu par le modèle. Il répond souvent par des phrases,
 * parfois par des objets ({point, why}, {title, description}…) : on en tire la
 * phrase principale et, s'il y en a une, sa justification. Jamais
 * « [object Object] ».
 */
const MAIN_KEYS = ["text", "point", "challenge", "addition", "title", "name", "idea", "assumption", "risk", "issue", "item", "description", "detail", "content", "value"];
const WHY_KEYS = ["why", "reason", "rationale", "impact", "because", "justification", "details"];
export function asText(x: unknown): string {
  if (x == null) return "";
  if (typeof x === "string") return x.trim();
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  if (Array.isArray(x)) return x.map(asText).filter(Boolean).join(" ; ");
  if (typeof x === "object") {
    const o = x as Record<string, unknown>;
    const mainKey = MAIN_KEYS.find((k) => typeof o[k] === "string" && (o[k] as string).trim());
    const whyKey = WHY_KEYS.find((k) => k !== mainKey && typeof o[k] === "string" && (o[k] as string).trim());
    if (mainKey) return whyKey ? `${(o[mainKey] as string).trim()} — ${(o[whyKey] as string).trim()}` : (o[mainKey] as string).trim();
    return Object.values(o).map(asText).filter(Boolean).join(" — ");
  }
  return "";
}
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(asText).filter(Boolean) : typeof v === "string" && v.trim() ? [v.trim()] : []);
const asQuestions = (v: unknown): Question[] => (Array.isArray(v) ? v : [])
  .map((q) => (typeof q === "string" ? { question: q } : { ...(q as Question), question: asText((q as Question).question ?? q) }))
  .filter((q) => q && typeof q.question === "string" && q.question.trim().length > 3)
  .map((q) => ({ question: q.question.trim(), why: q.why?.toString().trim() || undefined, suggestion: q.suggestion?.toString().trim() || undefined }));

function parseJson<T>(raw: string): T | null {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t) as T; } catch { /* essai suivant */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) as T; } catch { /* rien */ } }
  return null;
}

// ── Le contexte : la mission, ses équipes, son équipage ──────────────────────

interface Ctx {
  mission: Mission;
  teams: Team[];
  crew: Map<string, CrewAgent>;
  lead: CrewAgent;
}

async function loadCtx(admin: Admin, mission: Mission): Promise<Ctx> {
  const { data: dash } = mission.dashboard_id
    ? await admin.from("service_dashboards").select("settings").eq("id", mission.dashboard_id).maybeSingle()
    : { data: null };
  const settings = ((dash as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const allTeams = (Array.isArray(settings.teams) ? settings.teams : []) as Team[];
  const wanted = new Set(mission.planning_teams ?? []);
  let teams = allTeams.filter((t) => !wanted.size || wanted.has(t.id)).filter((t) => (t.agent_ids ?? []).length);

  let agentsQ = admin.from("internal_agents")
    .select("id, name, persona, description, instructions, is_orchestrator, mission_enabled, is_archived")
    .eq("is_archived", false);
  agentsQ = mission.dashboard_id ? agentsQ.eq("service_dashboard_id", mission.dashboard_id) : agentsQ.eq("project_id", mission.project_id);
  const { data: agents } = await agentsQ.limit(80);
  const rows = (agents ?? []) as Array<Omit<CrewAgent, "tools">>;
  // Sans équipe déclarée, tout le service forme une seule équipe.
  if (!teams.length) {
    teams = [{ id: "service", name: "Le service", agent_ids: rows.map((a) => a.id), lead_id: rows.find((a) => a.is_orchestrator)?.id ?? null }];
  }
  const inTeams = new Set(teams.flatMap((t) => t.agent_ids));
  const members = rows.filter((a) => inTeams.has(a.id));
  const { data: tools } = members.length
    ? await admin.from("internal_agent_tools").select("agent_id, name, kind, enabled").in("agent_id", members.map((a) => a.id))
    : { data: [] };
  const toolsOf = new Map<string, string[]>();
  for (const t of (tools ?? []) as Array<{ agent_id: string; name: string; kind: string; enabled: boolean }>) {
    if (t.enabled === false) continue;
    const list = toolsOf.get(t.agent_id) ?? [];
    if (list.length < 14) list.push(t.name || t.kind);
    toolsOf.set(t.agent_id, list);
  }
  const crew = new Map<string, CrewAgent>(members.map((a) => [a.id, { ...a, tools: toolsOf.get(a.id) ?? [] }]));
  // Le pilote : celui qu'on a déjà choisi, sinon le responsable de la première
  // équipe, sinon l'orchestrateur du service, sinon le premier venu.
  const leadId = (mission.planning_lead_agent_id && crew.has(mission.planning_lead_agent_id) && mission.planning_lead_agent_id)
    || teams.map((t) => t.lead_id).find((id) => !!id && crew.has(id))
    || [...crew.values()].find((a) => a.is_orchestrator)?.id
    || [...crew.keys()][0];
  if (!leadId) throw new Error("Aucun agent disponible dans les équipes choisies pour cadrer la mission.");
  return { mission, teams, crew, lead: crew.get(leadId)! };
}

/** Les relecteurs du cadrage : les responsables des autres équipes ; à défaut,
 *  deux coéquipiers du pilote. Trois au plus — au-delà, on répète. */
function reviewersOf(ctx: Ctx): CrewAgent[] {
  const out: CrewAgent[] = [];
  for (const t of ctx.teams) {
    const id = t.lead_id && ctx.crew.has(t.lead_id) ? t.lead_id : t.agent_ids.find((a) => ctx.crew.has(a));
    if (id && id !== ctx.lead.id && !out.some((a) => a.id === id)) out.push(ctx.crew.get(id)!);
  }
  if (out.length < 2) {
    for (const a of ctx.crew.values()) {
      if (out.length >= 2) break;
      if (a.id !== ctx.lead.id && !out.some((o) => o.id === a.id)) out.push(a);
    }
  }
  return out.slice(0, 3);
}

function voice(a: CrewAgent): string {
  return [
    `Tu es ${a.persona || a.name}${a.description ? ` — ${clip(a.description, 240)}` : ""}.`,
    a.instructions ? `Ta façon de travailler (extrait de tes instructions) :\n${clip(a.instructions, 1200)}` : "",
    a.tools.length ? `Tes outils : ${a.tools.join(", ")}.` : "",
    "Tu fais partie d'une équipe d'agents IA qui travaillent ensemble pour un humain. Tu parles en ton nom, depuis ton métier, en français, sans formules creuses.",
  ].filter(Boolean).join("\n");
}

function missionBlock(ctx: Ctx): string {
  const m = ctx.mission;
  const deliv = (m.deliverables ?? []).filter((d) => d && d.title)
    .map((d) => `- ${d.title}${d.description ? ` — ${d.description}` : ""}`).join("\n");
  const teams = ctx.teams.map((t) => {
    const mem = t.agent_ids.map((id) => ctx.crew.get(id)).filter((a): a is CrewAgent => !!a)
      .map((a) => `    · ${a.name}${a.id === t.lead_id ? " (responsable)" : ""} — ${clip(a.description, 120) || "rôle non décrit"}${a.tools.length ? ` — outils : ${a.tools.slice(0, 8).join(", ")}` : ""}`);
    return `- ${t.name} [team_id: ${t.id}]${t.focus ? ` — ${t.focus}` : ""}\n${mem.join("\n")}`;
  }).join("\n");
  return [
    `# Mission « ${m.name} » (${m.identifier})`,
    m.description ? `Description : ${m.description}` : "",
    `## Brief de l'humain\n${m.brief || "(pas de brief détaillé)"}`,
    deliv ? `## Livrables attendus\n${deliv}` : "## Livrables attendus\n(non précisés)",
    `## Équipes engagées\n${teams}`,
  ].filter(Boolean).join("\n\n");
}

async function speak<T>(admin: Admin, ctx: Ctx, agent: CrewAgent, task: string, payload: string, maxTokens = 2200): Promise<T> {
  const res = await callAi({
    task: "json_extraction",
    jsonMode: true,
    systemPrompt: `${voice(agent)}\n\n${task}\n\nRéponds UNIQUEMENT par un objet JSON valide, sans texte autour.`,
    userPrompt: payload,
    maxTokens,
    temperature: 0.4,
  });
  await logLlmUsage({
    workspace_id: ctx.mission.workspace_id, project_id: ctx.mission.project_id,
    provider: res.provider, model: res.model, task: "json_extraction", feature: "mission-planning", usage: res.usage,
  }).catch(() => {});
  const out = parseJson<T>(res.content);
  if (!out) throw new Error(`${agent.name} n'a pas rendu de réponse exploitable.`);
  return out;
}

async function say(admin: Admin, m: Mission, agentId: string | null, kind: string, content: string, data: Record<string, unknown> = {}, userId: string | null = null) {
  await admin.from("pj_mission_discussion").insert({
    pj_project_id: m.id, workspace_id: m.workspace_id, agent_id: agentId, author_user: userId, kind, content, data,
  });
}

async function thread(admin: Admin, m: Mission, limit = 30): Promise<string> {
  const { data } = await admin.from("pj_mission_discussion").select("agent_id, author_user, kind, content")
    .eq("pj_project_id", m.id).order("created_at", { ascending: true }).limit(limit);
  const ids = [...new Set((data ?? []).map((d: { agent_id: string | null }) => d.agent_id).filter(Boolean))] as string[];
  const { data: names } = ids.length ? await admin.from("internal_agents").select("id, name").in("id", ids) : { data: [] };
  const nameOf = new Map((names ?? []).map((n: { id: string; name: string }) => [n.id, n.name]));
  return (data ?? []).map((d: { agent_id: string | null; author_user: string | null; kind: string; content: string }) =>
    `### ${d.agent_id ? nameOf.get(d.agent_id) ?? "Un agent" : "L'humain"} (${d.kind})\n${clip(d.content, 2500)}`).join("\n\n");
}

// ── Les étapes ───────────────────────────────────────────────────────────────

interface StepOut { status: PlanningStatus; step: string | null; patch?: Record<string, unknown> }

async function stepLead(admin: Admin, ctx: Ctx): Promise<StepOut> {
  type R = { understanding?: string; approach?: string; assumptions?: unknown; risks?: unknown; questions?: unknown };
  const r = await speak<R>(admin, ctx, ctx.lead,
    "Tu PILOTES le cadrage de cette mission, confiée à ton équipe. Lis le brief comme un chef de projet exigeant et produis : " +
    "understanding (5 à 8 phrases : ce qui est vraiment attendu, pour qui, à quoi on reconnaîtra le succès), " +
    "approach (3 à 5 phrases : comment l'équipe va s'y prendre), assumptions (hypothèses que tu poses), risks (risques), " +
    "questions ([{question, why, suggestion}] — seulement les zones floues qui changeraient le plan ; why = ce qui change selon la réponse ; suggestion = la réponse que tu retiendrais par défaut).",
    missionBlock(ctx));
  const assumptions = asList(r.assumptions), risks = asList(r.risks), questions = asQuestions(r.questions);
  const content = [
    asText(r.understanding),
    r.approach ? `**Approche** — ${asText(r.approach)}` : "",
    assumptions.length ? `**Hypothèses**\n${assumptions.map((a) => `- ${a}`).join("\n")}` : "",
    risks.length ? `**Risques**\n${risks.map((a) => `- ${a}`).join("\n")}` : "",
    questions.length ? `**Points flous**\n${questions.map((q) => `- ${q.question}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  await say(admin, ctx.mission, ctx.lead.id, "analysis", content, { ...r, questions });
  const reviewers = reviewersOf(ctx);
  return { status: "scoping", step: reviewers.length ? "review:0" : "consolidate", patch: { planning_lead_agent_id: ctx.lead.id } };
}

async function stepReview(admin: Admin, ctx: Ctx, i: number): Promise<StepOut> {
  const reviewers = reviewersOf(ctx);
  const reviewer = reviewers[i];
  if (!reviewer) return { status: "scoping", step: "consolidate" };
  type R = { challenges?: unknown; additions?: unknown; questions?: unknown; verdict?: string };
  const r = await speak<R>(admin, ctx, reviewer,
    `${ctx.lead.name} pilote le cadrage de cette mission. CHALLENGE son analyse depuis ton métier, franchement : ` +
    "challenges (ce qui est faux, risqué, sous-estimé ou manquant), additions (ce que ton équipe peut apporter, ce qu'il faut ajouter au plan), " +
    "questions ([{question, why, suggestion}] — seulement si un point flou n'a pas été relevé), verdict (1 à 2 phrases). " +
    "Ne répète pas ce qui a déjà été dit ; si l'analyse te paraît juste sur un point, ne le commente pas.",
    `${missionBlock(ctx)}\n\n## La concertation jusqu'ici\n${await thread(admin, ctx.mission)}`);
  const challenges = asList(r.challenges), additions = asList(r.additions), questions = asQuestions(r.questions);
  const content = [
    asText(r.verdict),
    challenges.length ? `**Je challenge**\n${challenges.map((a) => `- ${a}`).join("\n")}` : "",
    additions.length ? `**J'ajoute**\n${additions.map((a) => `- ${a}`).join("\n")}` : "",
    questions.length ? `**Questions**\n${questions.map((q) => `- ${q.question}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  await say(admin, ctx.mission, reviewer.id, "challenge", content || "Rien à redire : l'analyse tient.", { ...r, questions });
  return { status: "scoping", step: i + 1 < reviewers.length ? `review:${i + 1}` : "consolidate" };
}

async function stepConsolidate(admin: Admin, ctx: Ctx): Promise<StepOut> {
  type R = { summary?: string; questions?: unknown; decisions?: unknown };
  const r = await speak<R>(admin, ctx, ctx.lead,
    "Tu as entendu ton équipe. CONSOLIDE le cadrage : intègre les remarques justes, écarte les autres, TRANCHE. Produis : " +
    "summary (la mission reformulée et complétée, telle que l'équipe va l'exécuter : objectif, périmètre, hypothèses retenues, critères de succès — markdown court, 10 à 20 lignes), " +
    "decisions (les arbitrages que tu as faits), " +
    "questions ([{question, why, suggestion}] — UNIQUEMENT ce qui bloque vraiment et que seul l'humain peut trancher ; 5 au plus, dédoublonnées ; " +
    "liste vide si une hypothèse raisonnable suffit — dans ce cas, pose-la dans summary).",
    `${missionBlock(ctx)}\n\n## La concertation\n${await thread(admin, ctx.mission)}`);
  const questions = asQuestions(r.questions).slice(0, 5);
  const decisions = asList(r.decisions);
  const summary = asText(r.summary) || ctx.mission.brief || "";
  await say(admin, ctx.mission, ctx.lead.id, "decision",
    [summary, decisions.length ? `**Arbitrages**\n${decisions.map((d) => `- ${d}`).join("\n")}` : ""].filter(Boolean).join("\n\n"),
    { decisions });
  if (questions.length) {
    await admin.from("pj_mission_questions").insert(questions.map((q) => ({
      pj_project_id: ctx.mission.id, workspace_id: ctx.mission.workspace_id, asked_by_agent: ctx.lead.id,
      question: q.question, why: q.why ?? null, suggestion: q.suggestion ?? null,
    })));
    await say(admin, ctx.mission, ctx.lead.id, "question",
      `Avant de planifier, j'ai besoin de vous sur ${questions.length === 1 ? "un point" : `${questions.length} points`}. Une réponse suggérée accompagne chaque question : vous pouvez la valider telle quelle.`,
      { questions });
    return { status: "questions", step: null, patch: { planning_summary: summary } };
  }
  return { status: "planning", step: "plan", patch: { planning_summary: summary } };
}

const PRIORITIES = new Set(["urgent", "high", "medium", "low"]);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

async function stepPlan(admin: Admin, ctx: Ctx): Promise<StepOut> {
  type Item = { key?: string; title?: string; description?: string; brief?: string; deliverable?: string; team_id?: string; priority?: string; hours?: number; depends_on?: unknown };
  const { data: qa } = await admin.from("pj_mission_questions").select("question, answer, status, suggestion")
    .eq("pj_project_id", ctx.mission.id);
  const answers = (qa ?? []).map((q: { question: string; answer: string | null; status: string; suggestion: string | null }) =>
    `- Q : ${q.question}\n  R : ${q.status === "answered" ? q.answer : `(sans réponse — hypothèse retenue : ${q.suggestion ?? "au jugement de l'équipe"})`}`).join("\n");
  const r = await speak<{ items?: Item[]; rationale?: string }>(admin, ctx, ctx.lead,
    "Découpe la mission en WORK ITEMS. Repères de durée — vous êtes des agents IA, très rapides : une recherche documentée 1 à 3 h, " +
    "une rédaction 1 à 2 h, une analyse de données 1 à 4 h, un développement 2 à 8 h. Compte en HEURES d'agent, jamais en semaines. " +
    "Chaque item : un résultat vérifiable, confié à UNE équipe (team_id parmi celles listées, la mieux outillée), au service d'un livrable attendu. " +
    "Pose les dépendances (depends_on : clés des items qui doivent être finis avant) ; parallélise tout ce qui peut l'être. " +
    "Produis : items ([{key: \"A1\", title, description (contexte pour l'équipe), brief (la consigne pour l'agent : quoi produire, critères de fini), " +
    "deliverable (titre du livrable servi, ou \"\"), team_id, priority (urgent|high|medium|low), hours, depends_on: [clés]}] — entre 3 et 12 items), " +
    "rationale (2 à 4 phrases : la logique du découpage et du calendrier).",
    `${missionBlock(ctx)}\n\n## La mission telle que l'équipe l'a cadrée\n${ctx.mission.planning_summary ?? ""}\n\n${answers ? `## Réponses de l'humain\n${answers}` : ""}`,
    3600);
  const teamIds = new Set(ctx.teams.map((t) => t.id));
  const items = (r.items ?? []).filter((it) => it && it.title).slice(0, 14).map((it, k) => ({
    key: String(it.key || `I${k + 1}`),
    title: asText(it.title).slice(0, 250),
    description: asText(it.description),
    brief: asText(it.brief) || asText(it.description) || asText(it.title),
    deliverable: String(it.deliverable ?? ""),
    team_id: teamIds.has(String(it.team_id)) ? String(it.team_id) : ctx.teams[k % ctx.teams.length].id,
    priority: PRIORITIES.has(String(it.priority)) ? String(it.priority) : "medium",
    hours: Math.min(40, Math.max(0.5, Number(it.hours) || 2)),
    depends_on: asList(it.depends_on),
  }));
  if (!items.length) throw new Error("Le plan proposé ne contient aucun work item.");

  // Le calendrier : chaque item démarre quand ses dépendances sont finies.
  const byKey = new Map(items.map((it) => [it.key, it]));
  const endOf = new Map<string, number>();
  const startOf = new Map<string, number>();
  const visit = (key: string, depth = 0): number => {
    if (endOf.has(key)) return endOf.get(key)!;
    const it = byKey.get(key);
    if (!it || depth > 20) return 0;
    const start = Math.max(0, ...it.depends_on.filter((d) => d !== key && byKey.has(d)).map((d) => visit(d, depth + 1)));
    startOf.set(key, start);
    endOf.set(key, start + it.hours);
    return start + it.hours;
  };
  items.forEach((it) => visit(it.key));
  const t0 = Date.now();
  const at = (h: number) => isoDay(new Date(t0 + h * 3600 * 1000));

  const { data: states } = await admin.from("pj_states").select("id, \"group\", is_default").eq("pj_project_id", ctx.mission.id);
  const st = (states ?? []) as Array<{ id: string; group: string; is_default: boolean }>;
  const stateId = st.find((s) => s.group === "unstarted")?.id ?? st.find((s) => s.is_default)?.id ?? null;

  const idOf = new Map<string, string>();
  for (const it of items) {
    const desc = [it.description, it.deliverable ? `Livrable servi : ${it.deliverable}` : ""].filter(Boolean).join("\n\n");
    const { data: row, error } = await admin.from("pj_issues").insert({
      pj_project_id: ctx.mission.id, workspace_id: ctx.mission.workspace_id,
      name: it.title, description_text: desc, description_html: desc ? `<p>${esc(desc).replace(/\n+/g, "</p><p>")}</p>` : "",
      priority: it.priority, state_id: stateId,
      start_date: at(startOf.get(it.key) ?? 0), target_date: at(endOf.get(it.key) ?? it.hours),
      agent_brief: it.brief, team_id: it.team_id, estimate_hours: it.hours, planned_by_agent: ctx.lead.id,
    }).select("id").single();
    if (error || !row) throw new Error(`work item « ${it.title} » : ${error?.message ?? "non créé"}`);
    idOf.set(it.key, (row as { id: string }).id);
  }
  const relations = items.flatMap((it) => it.depends_on.filter((d) => idOf.has(d) && d !== it.key).map((d) => ({
    issue_id: idOf.get(it.key)!, related_id: idOf.get(d)!, workspace_id: ctx.mission.workspace_id, relation_type: "blocked_by",
  })));
  if (relations.length) await admin.from("pj_issue_relations").insert(relations);

  const total = Math.max(...items.map((it) => endOf.get(it.key) ?? 0));
  const teamName = new Map(ctx.teams.map((t) => [t.id, t.name]));
  await say(admin, ctx.mission, ctx.lead.id, "plan", [
    asText(r.rationale),
    items.map((it) => `- **${it.key}** · ${it.title} — ${teamName.get(it.team_id) ?? it.team_id} · ${it.hours} h${it.depends_on.length ? ` · après ${it.depends_on.join(", ")}` : ""}`).join("\n"),
    `Durée totale estimée : ${total < 24 ? `${Math.ceil(total)} h` : `${Math.ceil(total / 24)} jour(s)`}.`,
  ].filter(Boolean).join("\n\n"), { items: items.map((it) => ({ key: it.key, issue_id: idOf.get(it.key), team_id: it.team_id })) });

  const teamsWithItems = ctx.teams.filter((t) => items.some((it) => it.team_id === t.id)).map((t) => t.id);
  return {
    status: "planning", step: teamsWithItems.length ? "team:0" : "done",
    patch: { start_date: at(0), target_date: at(total), planning_teams: ctx.mission.planning_teams?.length ? ctx.mission.planning_teams : [] },
  };
}

async function plannedTeams(admin: Admin, ctx: Ctx): Promise<string[]> {
  const { data } = await admin.from("pj_issues").select("team_id").eq("pj_project_id", ctx.mission.id)
    .is("parent_id", null).not("team_id", "is", null);
  const set = new Set((data ?? []).map((r: { team_id: string }) => r.team_id));
  return ctx.teams.map((t) => t.id).filter((id) => set.has(id));
}

async function stepTeam(admin: Admin, ctx: Ctx, i: number): Promise<StepOut> {
  const order = await plannedTeams(admin, ctx);
  const team = ctx.teams.find((t) => t.id === order[i]);
  if (!team) return { status: "planning", step: "done" };
  const members = team.agent_ids.map((id) => ctx.crew.get(id)).filter((a): a is CrewAgent => !!a);
  const pool = members.length ? members : [ctx.lead];
  const leader = (team.lead_id && ctx.crew.get(team.lead_id)) || pool[0];
  const { data: rows } = await admin.from("pj_issues")
    .select("id, sequence_id, name, description_text, agent_brief, estimate_hours, start_date, target_date, priority")
    .eq("pj_project_id", ctx.mission.id).eq("team_id", team.id).is("parent_id", null).is("archived_at", null);
  const items = (rows ?? []) as Array<{ id: string; sequence_id: number; name: string; description_text: string; agent_brief: string | null; estimate_hours: number | null; start_date: string | null; target_date: string | null; priority: string }>;
  if (!items.length) return { status: "planning", step: i + 1 < order.length ? `team:${i + 1}` : "done" };

  const roster = pool.map((a) => `- ${a.name} [agent_id: ${a.id}] — ${clip(a.description, 160) || "rôle non décrit"}${a.tools.length ? ` — outils : ${a.tools.join(", ")}` : ""}${a.mission_enabled === false ? " — (missions désactivées : ne lui confie rien)" : ""}`).join("\n");
  const list = items.map((it) => `- [issue_id: ${it.id}] ${ctx.mission.identifier}-${it.sequence_id} · ${it.name} (${it.estimate_hours ?? "?"} h, du ${it.start_date} au ${it.target_date})\n  Brief : ${clip(it.agent_brief, 600)}`).join("\n");
  type Sub = { title?: string; brief?: string; agent_id?: string; hours?: number };
  type R = { items?: Array<{ issue_id?: string; agent_id?: string; brief?: string; subtasks?: Sub[] }>; note?: string };
  const r = await speak<R>(admin, ctx, leader,
    `Tu animes l'équipe « ${team.name} ». Le pilote de la mission vous a confié les work items ci-dessous. AFFINE-les et RÉPARTIS-les entre les agents de ton équipe, ` +
    "selon leurs outils et leurs capacités — le bon agent pour chaque tâche, et une charge équilibrée. Pour chaque item : soit tu le confies tel quel à UN agent " +
    "(agent_id) avec un brief précisé si besoin, soit — s'il mélange des métiers ou dépasse 4 h — tu le découpes en 2 à 5 sous-tâches, chacune confiée à un agent, " +
    "avec un brief (quoi produire, critère de fini) et une durée en heures. Produis : items ([{issue_id, agent_id?, brief?, subtasks?: [{title, brief, agent_id, hours}]}]), " +
    "note (2 phrases : ta logique de répartition).",
    `${missionBlock(ctx)}\n\n## Tes agents\n${roster}\n\n## Les work items de ton équipe\n${list}`, 3000);

  const valid = new Set(pool.filter((a) => a.mission_enabled !== false).map((a) => a.id));
  const fallback = [...valid];
  let rr = 0;
  const pick = (id?: string) => (id && valid.has(id) ? id : fallback.length ? fallback[rr++ % fallback.length] : null);
  const assigned: string[] = [];
  const nameOf = (id: string | null) => (id ? ctx.crew.get(id)?.name ?? "?" : "personne");
  const assign = async (issueId: string, agentId: string | null) => {
    if (!agentId) return;
    await admin.from("pj_issue_agents").upsert({ issue_id: issueId, agent_id: agentId, workspace_id: ctx.mission.workspace_id }, { onConflict: "issue_id,agent_id" });
    await admin.from("pj_project_agents").upsert({ pj_project_id: ctx.mission.id, agent_id: agentId, workspace_id: ctx.mission.workspace_id, role: "contributor" }, { onConflict: "pj_project_id,agent_id" });
  };
  for (const it of items) {
    const plan = (r.items ?? []).find((p) => p.issue_id === it.id);
    const subs = (plan?.subtasks ?? []).filter((s) => s && s.title).slice(0, 5);
    if (subs.length >= 2) {
      const childIds: string[] = [];
      for (const s of subs) {
        const agentId = pick(s.agent_id);
        const { data: child } = await admin.from("pj_issues").insert({
          pj_project_id: ctx.mission.id, workspace_id: ctx.mission.workspace_id, parent_id: it.id,
          name: asText(s.title).slice(0, 250), description_text: "", description_html: "",
          priority: it.priority, start_date: it.start_date, target_date: it.target_date,
          agent_brief: asText(s.brief) || asText(s.title), team_id: team.id,
          estimate_hours: Math.min(24, Math.max(0.25, Number(s.hours) || 1)), planned_by_agent: leader.id,
        }).select("id").single();
        if (child) {
          childIds.push((child as { id: string }).id);
          await assign((child as { id: string }).id, agentId);
        }
        assigned.push(`  · ${s.title} → ${nameOf(agentId)}`);
      }
      await rewireDependencies(admin, ctx.mission.workspace_id, it.id, childIds);
      assigned.unshift(`- ${ctx.mission.identifier}-${it.sequence_id} · ${it.name} — découpé en ${subs.length} :`);
    } else {
      const agentId = pick(plan?.agent_id);
      const refined = asText(plan?.brief);
      if (refined.length > 10) {
        await admin.from("pj_issues").update({ agent_brief: refined }).eq("id", it.id);
      }
      await assign(it.id, agentId);
      assigned.push(`- ${ctx.mission.identifier}-${it.sequence_id} · ${it.name} → ${nameOf(agentId)}`);
    }
  }
  await say(admin, ctx.mission, leader.id, "assignment", [asText(r.note), assigned.join("\n")].filter(Boolean).join("\n\n"), { team_id: team.id });
  return { status: "planning", step: i + 1 < order.length ? `team:${i + 1}` : "done" };
}

/**
 * Un item découpé ne porte plus le travail : ses sous-tâches le font. La file
 * autonome (0245) ne regarde que les relations DIRECTES, alors on les reporte :
 *   · ce qui bloquait le parent bloque chacune de ses sous-tâches — sinon elles
 *     partiraient avant leurs prérequis ;
 *   · ce qui attendait le parent attend chacune de ses sous-tâches — sinon il
 *     attendrait un parent que personne ne termine jamais.
 */
async function rewireDependencies(admin: Admin, workspaceId: string, parentId: string, childIds: string[]) {
  if (!childIds.length) return;
  const { data: rels } = await admin.from("pj_issue_relations").select("id, issue_id, related_id, relation_type")
    .or(`issue_id.eq.${parentId},related_id.eq.${parentId}`).eq("relation_type", "blocked_by");
  const rows = (rels ?? []) as Array<{ id: string; issue_id: string; related_id: string }>;
  const inserts: Array<Record<string, string>> = [];
  for (const r of rows) {
    if (r.issue_id === parentId) {
      for (const c of childIds) inserts.push({ issue_id: c, related_id: r.related_id, workspace_id: workspaceId, relation_type: "blocked_by" });
    } else {
      for (const c of childIds) inserts.push({ issue_id: r.issue_id, related_id: c, workspace_id: workspaceId, relation_type: "blocked_by" });
    }
  }
  if (inserts.length) await admin.from("pj_issue_relations").insert(inserts);
  const waiting = rows.filter((r) => r.related_id === parentId).map((r) => r.id);
  if (waiting.length) await admin.from("pj_issue_relations").delete().in("id", waiting);
}

async function stepDone(admin: Admin, ctx: Ctx): Promise<StepOut> {
  const { count } = await admin.from("pj_issues").select("id", { count: "exact", head: true }).eq("pj_project_id", ctx.mission.id);
  const { data: who } = await admin.from("pj_project_agents").select("agent_id").eq("pj_project_id", ctx.mission.id);
  await say(admin, ctx.mission, ctx.lead.id, "decision",
    `Le plan est prêt : ${count ?? 0} work item(s), ${(who ?? []).length} agent(s) mobilisé(s).` +
    (ctx.mission.planning_autostart ? " On démarre." : " Il attend votre feu vert pour démarrer."));
  if (ctx.mission.planning_autostart) {
    await launchMission(admin, ctx.mission.id);
    return { status: "executing", step: null };
  }
  return { status: "planned", step: null };
}

// ── Le moteur ────────────────────────────────────────────────────────────────

async function loadMission(admin: Admin, id: string): Promise<Mission | null> {
  const { data } = await admin.from("pj_projects").select("*").eq("id", id).maybeSingle();
  return (data as Mission) ?? null;
}

/** Confie la mission à l'équipe : le cadrage commence. */
export async function startMissionPlanning(admin: Admin, missionId: string, userId: string | null): Promise<Mission> {
  const m = await loadMission(admin, missionId);
  if (!m) throw new Error("Mission introuvable.");
  if (!(m.brief ?? "").trim() && !(m.description ?? "").trim()) throw new Error("La mission n'a ni brief ni description : rien à cadrer.");
  if (m.planning_status === "scoping" || m.planning_status === "planning") return m;
  const ctx = await loadCtx(admin, m);
  await admin.from("pj_projects").update({
    planning_status: "scoping", planning_step: "lead", planning_lead_agent_id: ctx.lead.id,
    planning_error: null, planning_updated_at: new Date().toISOString(),
  }).eq("id", m.id);
  await say(admin, m, null, "note",
    `Mission confiée à ${ctx.teams.map((t) => t.name).join(", ")}. ${ctx.lead.name} pilote le cadrage.`, {}, userId);
  return m;
}

/** Joue l'étape en cours, et UNE seule. `next` : il en reste une à jouer. */
export async function advanceMission(admin: Admin, missionId: string): Promise<{ next: boolean; status?: PlanningStatus; step?: string | null }> {
  const m = await loadMission(admin, missionId);
  if (!m || !m.planning_step || (m.planning_status !== "scoping" && m.planning_status !== "planning")) return { next: false };
  const step = m.planning_step;
  if (step.endsWith("@run")) return { next: false };
  // La réservation : seul celui qui fait passer l'étape à « @run » la joue.
  const { data: claimed } = await admin.from("pj_projects")
    .update({ planning_step: `${step}@run`, planning_updated_at: new Date().toISOString() })
    .eq("id", m.id).eq("planning_step", step).select("id").maybeSingle();
  if (!claimed) return { next: false };

  try {
    const ctx = await loadCtx(admin, m);
    const [phase, a, b] = step.split(":");
    const out: StepOut =
      step === "lead" ? await stepLead(admin, ctx)
      : phase === "review" ? await stepReview(admin, ctx, Number(a) || 0)
      : step === "consolidate" ? await stepConsolidate(admin, ctx)
      : step === "plan" ? await stepPlan(admin, ctx)
      : phase === "team" ? await stepTeam(admin, ctx, Number(a ?? b) || 0)
      : await stepDone(admin, ctx);
    await admin.from("pj_projects").update({
      planning_status: out.status, planning_step: out.step, planning_error: null,
      planning_updated_at: new Date().toISOString(), ...(out.patch ?? {}),
    }).eq("id", m.id);
    return { next: !!out.step && (out.status === "scoping" || out.status === "planning"), status: out.status, step: out.step };
  } catch (e) {
    // On rend l'étape ; au troisième échec d'affilée, la mission passe en échec
    // — avec le message, pour qu'on sache quoi corriger avant de relancer.
    const msg = e instanceof Error ? e.message : String(e);
    const prev = (m.planning_error ?? "").match(/^\[(.+?)#(\d+)\]/);
    const tries = prev && prev[1] === step ? Number(prev[2]) + 1 : 1;
    const failed = tries >= MAX_TRIES;
    await admin.from("pj_projects").update({
      planning_step: step, planning_status: failed ? "failed" : m.planning_status,
      planning_error: `[${step}#${tries}] ${msg}`.slice(0, 1000), planning_updated_at: new Date().toISOString(),
    }).eq("id", m.id);
    if (failed) await say(admin, m, null, "note", `Le cadrage s'est arrêté : ${msg}`);
    return { next: !failed };
  }
}

/** L'humain a répondu (ou dit « continuez sans ») : on passe au plan. */
export async function resumeMission(admin: Admin, missionId: string, userId: string, skip: boolean): Promise<void> {
  const m = await loadMission(admin, missionId);
  if (!m) throw new Error("Mission introuvable.");
  if (m.planning_status !== "questions") throw new Error("Le cadrage n'attend pas de réponse.");
  if (skip) {
    await admin.from("pj_mission_questions").update({ status: "dismissed" }).eq("pj_project_id", m.id).eq("status", "open");
  }
  const { data: qa } = await admin.from("pj_mission_questions").select("question, answer, status")
    .eq("pj_project_id", m.id).order("created_at");
  const lines = (qa ?? []).map((q: { question: string; answer: string | null; status: string }) =>
    `- ${q.question}\n  → ${q.status === "answered" ? q.answer : "à l'appréciation de l'équipe"}`);
  if (lines.length) await say(admin, m, null, "answer", lines.join("\n"), {}, userId);
  await admin.from("pj_projects").update({
    planning_status: "planning", planning_step: "plan", planning_error: null, planning_updated_at: new Date().toISOString(),
  }).eq("id", m.id);
}

/** Le feu vert : chaque work item confié à un agent, avec son brief, part dans
 *  la file autonome (0242), qui respecte dépendances et dates de début. */
export async function launchMission(admin: Admin, missionId: string): Promise<number> {
  const { data: rows } = await admin.from("pj_issues").select("id, agent_brief, pj_issue_agents(agent_id)")
    .eq("pj_project_id", missionId).is("completed_at", null).is("archived_at", null);
  const ids = (rows ?? []).filter((r: { agent_brief: string | null; pj_issue_agents: unknown[] }) =>
    (r.agent_brief ?? "").trim() && Array.isArray(r.pj_issue_agents) && r.pj_issue_agents.length).map((r: { id: string }) => r.id);
  if (ids.length) await admin.from("pj_issues").update({ agent_autorun: true }).in("id", ids);
  await admin.from("pj_projects").update({ planning_status: "executing", planning_updated_at: new Date().toISOString() }).eq("id", missionId);
  return ids.length;
}

/** Relancer un cadrage en échec, à l'étape où il s'est arrêté. */
export async function retryMission(admin: Admin, missionId: string): Promise<void> {
  const m = await loadMission(admin, missionId);
  if (!m || m.planning_status !== "failed") throw new Error("Rien à relancer.");
  const step = (m.planning_step ?? "lead").replace(/@run$/, "");
  const scoping = step === "lead" || step === "consolidate" || step.startsWith("review");
  await admin.from("pj_projects").update({
    planning_status: scoping ? "scoping" : "planning", planning_step: step, planning_error: null,
    planning_updated_at: new Date().toISOString(),
  }).eq("id", m.id);
}

/** Pour le planificateur : les cadrages à relancer — une étape oubliée (un
 *  appel perdu) ou une réservation qui a expiré (un appel mort en route). */
export async function staleMissions(admin: Admin): Promise<string[]> {
  const { data } = await admin.from("pj_projects").select("id, planning_step, planning_updated_at")
    .in("planning_status", ["scoping", "planning"]).limit(20);
  const now = Date.now();
  const out: string[] = [];
  for (const r of (data ?? []) as Array<{ id: string; planning_step: string | null; planning_updated_at: string | null }>) {
    const age = now - new Date(r.planning_updated_at ?? 0).getTime();
    if (!r.planning_step) continue;
    if (r.planning_step.endsWith("@run")) {
      if (age > STEP_LEASE_MS) {
        await admin.from("pj_projects").update({ planning_step: r.planning_step.replace(/@run$/, ""), planning_updated_at: new Date().toISOString() })
          .eq("id", r.id).eq("planning_step", r.planning_step);
        out.push(r.id);
      }
    } else if (age > 90 * 1000) {
      out.push(r.id);
    }
  }
  return out;
}
