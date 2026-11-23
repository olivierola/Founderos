
// Teamz — des équipes d'agents spécialisés, prêtes à brancher.
//
// Une « Teamz » est une équipe COMPLÈTE : des rôles complémentaires, un prompt
// système détaillé par rôle, un animateur, un flux de travail entre agents
// (qui passe la main à qui, qui consulte qui, qui relit qui — les liens A2A),
// des routines, et les outils à brancher. On l'installe, on branche ses
// outils, on la laisse travailler.
//
// Ce module est PUR (aucun import Deno, aucun accès base) : le front l'importe
// tel quel pour la galerie et l'aperçu, le backend pour l'architecte et le
// déploiement. Trois idées le structurent :
//
//   1. Le prompt système n'est jamais écrit d'un bloc. Un rôle se décrit par
//      des CHAMPS (mission, responsabilités, méthode, exigences, limites,
//      livrables) et `composeMemberPrompt` en fait un prompt de structure
//      constante, auquel s'ajoute ce qu'aucun rôle isolé ne peut savoir : son
//      équipe, sa place dans le flux, le protocole de passation. Un modèle qui
//      conçoit une équipe remplit des champs ; la forme est garantie ici.
//   2. La qualité se MESURE (`lintMember`, `lintBlueprint`) au lieu de se
//      supposer : un rôle sans méthode ou sans limites est signalé, chiffré, et
//      l'architecte le fait réécrire avant de le proposer.
//   3. Un plan d'équipe venu d'un modèle est une ENTRÉE NON FIABLE :
//      `normalizeBlueprint` le ramène à une forme valide (bornes, clés
//      uniques, liens qui pointent vers de vrais membres, outils connus).

// ── Types ────────────────────────────────────────────────────────────────────

/** Les types d'outils qu'un membre peut recevoir à la création (sous-ensemble
 *  de CONFIGURABLE_TOOL_KINDS : ceux qui fonctionnent sans configuration
 *  propre au client, ou dont l'absence de config est signalée à l'écran). */
export const TEAMZ_TOOL_KINDS = [
  "web_search", "web_fetch", "rag_search", "tracker", "edge_function",
  "vibe_code", "testing", "security_scan", "simulation", "support", "leads", "soc", "governance",
] as const;
export type TeamzToolKind = typeof TEAMZ_TOOL_KINDS[number];

export interface TeamzTool { kind: TeamzToolKind; name?: string; config?: Record<string, unknown> }

/** handoff : je te confie la suite (une mission te revient) ;
 *  consult  : je te pose une question, tu réponds ;
 *  review   : tu relis ce que je produis avant que ça sorte. */
export type TeamzLinkKind = "handoff" | "consult" | "review";
export interface TeamzLink { from: string; to: string; kind: TeamzLinkKind; when: string }

export interface TeamzMember {
  /** Stable dans l'équipe : les liens et les routines s'y réfèrent. */
  key: string;
  name: string;
  role: string;
  emoji?: string;
  accent?: string;
  /** L'étiquette en une ligne (internal_agents.persona). */
  persona: string;
  /** Le caractère (internal_agents.soul) : court, toujours envoyé. */
  soul: string;
  mission: string;
  responsibilities: string[];
  method: string[];
  quality: string[];
  limits: string[];
  deliverables: string[];
  tools: TeamzTool[];
  /** Slugs d'apps (Composio ou natives) dont ce rôle se sert. */
  connectors?: string[];
  /** Slugs de skills système à activer. */
  skills?: string[];
  lead?: boolean;
  /** Ce qu'une tâche typique de ce rôle prendrait à un humain, en minutes :
   *  sert l'estimation du temps gagné, affichée AVEC sa formule. */
  minutes_per_task?: number;
}

export interface TeamzPlug { slug: string; name: string; why: string; required?: boolean }
export interface TeamzRoutine { owner: string; label: string; cron: string; prompt: string }

export interface TeamzTemplate {
  key: string;
  name: string;
  tagline: string;
  category: string;
  emoji: string;
  accent: string;
  mission: string;
  outcomes: string[];
  plugs: TeamzPlug[];
  members: TeamzMember[];
  links: TeamzLink[];
  playbook: string[];
  routines: TeamzRoutine[];
  kickoff: { title: string; brief: string };
  /** Estimation déclarée, affichée comme telle (« ≈ »), jamais comme un fait. */
  hours_saved_per_week: number;
  /** Phrases types : aident l'architecte à partir du bon modèle. */
  keywords: string[];
}

/** Ce qu'on déploie : un modèle instancié, ou ce qu'a conçu l'architecte. */
export interface TeamBlueprint {
  version: 1;
  source: "template" | "architect";
  template_key: string | null;
  /** La demande en langage naturel, quand il y en a une. */
  brief: string;
  name: string;
  mission: string;
  emoji: string;
  accent: string;
  members: TeamzMember[];
  links: TeamzLink[];
  playbook: string[];
  routines: TeamzRoutine[];
  plugs: TeamzPlug[];
  outcomes: string[];
  kickoff: { title: string; brief: string } | null;
  hours_saved_per_week: number;
  minutes_per_run: number;
}

// ── Petits outils ────────────────────────────────────────────────────────────

const s = (v: unknown, max = 4000): string => (typeof v === "string" ? v : v == null ? "" : String(v)).trim().slice(0, max);
const list = (v: unknown, maxItems = 8, maxLen = 400): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(/\n+/) : [])
    .map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? Object.values(x as Record<string, unknown>).filter((y) => typeof y === "string").join(" : ") : String(x ?? "")))
    .map((x) => x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim().slice(0, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);

export function slugKey(v: string): string {
  return v.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "membre";
}

const HEX = /^#[0-9a-f]{6}$/i;
export const TEAMZ_ACCENTS = ["#8b7cf6", "#e07a5f", "#3d9a8b", "#d4a537", "#7a9e7e", "#5b8def", "#c06c84", "#6c8ead"];

// ── Le prompt système d'un membre ────────────────────────────────────────────

export interface TeamContext {
  name: string;
  mission: string;
  playbook: string[];
  members: Array<Pick<TeamzMember, "key" | "name" | "role" | "lead">>;
  links: TeamzLink[];
}

const LINK_VERB: Record<TeamzLinkKind, { out: string; in: string; tool: string }> = {
  handoff: { out: "Tu passes la main à", in: "Tu reçois le travail de", tool: "handoff_to_teammate" },
  consult: { out: "Tu consultes", in: "Tu es consulté par", tool: "send_message_to_agent" },
  review: { out: "Tu fais relire par", in: "Tu relis le travail de", tool: "send_message_to_agent" },
};

/** Le flux A2A vu depuis un membre : ce qu'il reçoit, ce qu'il transmet. */
export function memberFlowLines(team: TeamContext, key: string): string[] {
  const nameOf = (k: string) => team.members.find((m) => m.key === k)?.name ?? k;
  const out: string[] = [];
  for (const l of team.links) {
    const v = LINK_VERB[l.kind];
    if (l.from === key) out.push(`- ${v.out} ${nameOf(l.to)} : ${l.when} (${v.tool}).`);
    else if (l.to === key) out.push(`- ${v.in} ${nameOf(l.from)} : ${l.when}.`);
  }
  return out;
}

export const HANDOFF_PROTOCOL = [
  "- Passer la main = appeler handoff_to_teammate avec : l'objectif en une phrase, ce qui est DÉJÀ fait (avec liens et identifiants), les livrables joints, les critères de fin vérifiables, l'échéance. Un coéquipier ne doit jamais avoir à te recontacter pour comprendre.",
  "- Recevoir la main : relis les critères de fin. S'ils sont flous ou impossibles, pose UNE question précise à l'émetteur (send_message_to_agent) avant de commencer ; sinon, exécute sans attendre.",
  "- Ne refais jamais ce qu'un coéquipier a déjà livré : pars de son livrable, cite-le, améliore-le.",
  "- Désaccord sur une approche : expose-le en deux phrases à l'animateur de l'équipe, avec ce qui le justifie. Il tranche ; tu appliques et tu notes la décision (team_memory, portée service).",
  "- Ce qui vaut pour toute l'équipe (une convention, un interlocuteur, un piège) va dans team_memory : personne ne doit le redécouvrir.",
];

export const FINISH_RULES = [
  "- Tout travail substantiel se termine par un livrable (create_deliverable) : le livrable est le travail, ta réponse n'en est que le résumé.",
  "- Cite tes sources (URL, identifiant d'enregistrement, nom de fichier). Une affirmation sans source vérifiable est une hypothèse, et tu le dis.",
  "- N'annonce JAMAIS une action que tu n'as pas réellement exécutée avec un outil (envoi, publication, mise à jour). Si elle attend une validation, dis qu'elle attend.",
  "- Si tu ne peux pas conclure, dis ce qui manque et ce qu'il faudrait pour trancher.",
];

/** Le prompt système complet d'un membre, dans son équipe. */
export function composeMemberPrompt(team: TeamContext, m: TeamzMember): string {
  const lead = team.members.find((x) => x.lead);
  const mates = team.members.filter((x) => x.key !== m.key);
  const flow = memberFlowLines(team, m.key);
  const lines: string[] = [
    `# ${m.name}, ${m.role}`,
    `Tu fais partie de l'équipe « ${team.name} ». Mission de l'équipe : ${team.mission}`,
    "",
    "## TA MISSION",
    m.mission,
    "",
    "## RESPONSABILITÉS",
    ...m.responsibilities.map((r) => `- ${r}`),
    "",
    "## MÉTHODE",
    ...m.method.map((r, i) => `${i + 1}. ${r}`),
    "",
    "## TON ÉQUIPE",
    m.lead
      ? "- Tu ANIMES cette équipe : tu reçois les demandes, tu découpes, tu répartis, tu arbitres, tu rends compte à l'humain. Tu ne fais pas le travail d'un coéquipier mieux outillé que toi : tu le lui confies."
      : `- ${lead ? `${lead.name} anime l'équipe : c'est vers lui que remontent les arbitrages et les blocages.` : "L'équipe n'a pas d'animateur désigné : coordonne-toi directement avec tes coéquipiers."}`,
    ...mates.map((x) => `- ${x.name} : ${x.role}${x.lead ? " (anime l'équipe)" : ""}`),
  ];
  if (flow.length) lines.push("", "## TA PLACE DANS LE FLUX (A2A)", ...flow);
  lines.push("", "## PROTOCOLE DE PASSATION", ...HANDOFF_PROTOCOL);
  if (team.playbook.length) lines.push("", "## RÈGLES DE L'ÉQUIPE", ...team.playbook.map((r) => `- ${r}`));
  lines.push(
    "",
    "## EXIGENCES DE QUALITÉ",
    ...m.quality.map((r) => `- ${r}`),
    "",
    "## LIMITES : CE QUE TU NE FAIS JAMAIS",
    ...m.limits.map((r) => `- ${r}`),
    "",
    "## LIVRABLES ATTENDUS",
    ...m.deliverables.map((r) => `- ${r}`),
    "",
    "## FINIR CORRECTEMENT",
    ...FINISH_RULES,
  );
  return lines.join("\n");
}

// ── Mesurer la qualité d'un rôle et d'une équipe ─────────────────────────────

export interface MemberLint { key: string; name: string; score: number; issues: string[] }
export interface BlueprintLint { score: number; members: MemberLint[]; team: string[] }

/** Un score sur 100, et ce qui manque pour l'atteindre, en clair. */
export function lintMember(m: TeamzMember): MemberLint {
  const issues: string[] = [];
  let score = 0;
  const add = (ok: boolean, pts: number, issue: string) => { if (ok) score += pts; else issues.push(issue); };
  add(m.mission.length >= 80, 15, "mission trop vague (moins de 80 caractères)");
  add(m.responsibilities.length >= 3, 15, "moins de 3 responsabilités");
  add(m.method.length >= 4, 20, "méthode de moins de 4 étapes");
  add(m.quality.length >= 2, 15, "moins de 2 exigences de qualité");
  add(m.limits.length >= 2, 15, "moins de 2 limites explicites");
  add(m.deliverables.length >= 1, 10, "aucun livrable attendu");
  add(m.tools.length + (m.connectors?.length ?? 0) >= 1, 10, "aucun outil ni application");
  return { key: m.key, name: m.name, score, issues };
}

export function lintBlueprint(bp: Pick<TeamBlueprint, "members" | "links">): BlueprintLint {
  const members = bp.members.map(lintMember);
  const team: string[] = [];
  const keys = new Set(bp.members.map((m) => m.key));
  const leads = bp.members.filter((m) => m.lead);
  if (bp.members.length < 2) team.push("une équipe compte au moins 2 membres");
  if (leads.length !== 1) team.push(leads.length ? "plusieurs animateurs" : "aucun animateur désigné");
  for (const l of bp.links) {
    if (!keys.has(l.from) || !keys.has(l.to)) team.push(`lien vers un membre inconnu (${l.from} → ${l.to})`);
  }
  for (const m of bp.members) {
    if (bp.members.length > 1 && !bp.links.some((l) => l.from === m.key || l.to === m.key)) {
      team.push(`${m.name} n'est relié à personne`);
    }
  }
  const avg = members.length ? members.reduce((t, x) => t + x.score, 0) / members.length : 0;
  const score = Math.max(0, Math.round(avg - team.length * 8));
  return { score, members, team };
}

// ── Normaliser un plan d'équipe (sortie de modèle = entrée non fiable) ───────

const LINK_KINDS: TeamzLinkKind[] = ["handoff", "consult", "review"];
export const TEAM_MIN = 2;
export const TEAM_MAX = 8;

function normalizeTools(raw: unknown): TeamzTool[] {
  const out: TeamzTool[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(raw) ? raw : []) {
    const kind = s(typeof t === "string" ? t : (t as { kind?: unknown })?.kind, 40).toLowerCase() as TeamzToolKind;
    if (!(TEAMZ_TOOL_KINDS as readonly string[]).includes(kind) || seen.has(kind)) continue;
    seen.add(kind);
    const obj = (t && typeof t === "object" ? t : {}) as { name?: unknown; config?: unknown };
    const config = obj.config && typeof obj.config === "object" && !Array.isArray(obj.config) ? obj.config as Record<string, unknown> : undefined;
    // Une fonction interne nommée ailleurs que dans la liste blanche n'existe pas.
    if (kind === "edge_function" && !/^[a-z0-9-]{3,60}$/.test(String(config?.slug ?? ""))) continue;
    out.push({ kind, ...(s(obj.name, 80) ? { name: s(obj.name, 80) } : {}), ...(config ? { config } : {}) });
  }
  return out.slice(0, 8);
}

function normalizeSlugs(raw: unknown, max = 8): string[] {
  return [...new Set(list(raw, 20, 60).map((x) => x.toLowerCase().trim()).filter((x) => /^[a-z0-9_.-]{2,60}$/.test(x)))].slice(0, max);
}

/** Un membre tel qu'un modèle l'a rendu → un membre valide (ou null). */
export function normalizeMember(raw: unknown, i: number): TeamzMember | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = s(r.name, 60);
  const role = s(r.role ?? r.title, 140);
  if (!name || !role) return null;
  const minutes = Number(r.minutes_per_task);
  return {
    key: slugKey(s(r.key, 40) || name) || `membre-${i + 1}`,
    name,
    role,
    emoji: s(r.emoji, 8) || undefined,
    accent: HEX.test(s(r.accent, 7)) ? s(r.accent, 7) : TEAMZ_ACCENTS[i % TEAMZ_ACCENTS.length],
    persona: s(r.persona, 400) || role,
    soul: s(r.soul, 2400),
    mission: s(r.mission, 1200),
    responsibilities: list(r.responsibilities, 7),
    method: list(r.method ?? r.procedure, 9),
    quality: list(r.quality, 6),
    limits: list(r.limits, 6),
    deliverables: list(r.deliverables, 5),
    tools: normalizeTools(r.tools),
    connectors: normalizeSlugs(r.connectors),
    skills: normalizeSlugs(r.skills, 6),
    lead: r.lead === true,
    minutes_per_task: Number.isFinite(minutes) && minutes > 0 ? Math.min(Math.round(minutes), 480) : undefined,
  };
}

/** Clés uniques, un seul animateur, liens valides, bornes respectées. */
export function normalizeBlueprint(raw: unknown, opts: { brief?: string; source?: TeamBlueprint["source"]; templateKey?: string | null } = {}): TeamBlueprint {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const members: TeamzMember[] = [];
  const usedKeys = new Set<string>();
  const usedNames = new Set<string>();
  for (const [i, m] of (Array.isArray(r.members) ? r.members : []).entries()) {
    const nm = normalizeMember(m, i);
    if (!nm) continue;
    let key = nm.key;
    for (let n = 2; usedKeys.has(key); n++) key = `${nm.key}-${n}`;
    let name = nm.name;
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${nm.name} ${n}`;
    usedKeys.add(key);
    usedNames.add(name.toLowerCase());
    members.push({ ...nm, key, name });
    if (members.length >= TEAM_MAX) break;
  }
  // Exactement un animateur : celui que le plan désigne, sinon le premier.
  const leadKey = s(r.lead, 60) ? slugKey(s(r.lead, 60)) : "";
  let leadIdx = members.findIndex((m) => m.key === leadKey || slugKey(m.name) === leadKey);
  if (leadIdx < 0) leadIdx = members.findIndex((m) => m.lead);
  if (leadIdx < 0 && members.length) leadIdx = 0;
  members.forEach((m, i) => { m.lead = i === leadIdx; });

  const keyOf = (ref: unknown): string | null => {
    const k = slugKey(s(ref, 60));
    return members.find((m) => m.key === k || slugKey(m.name) === k)?.key ?? null;
  };
  const links: TeamzLink[] = [];
  const seenLinks = new Set<string>();
  for (const l of Array.isArray(r.links) ? r.links : []) {
    const o = (l ?? {}) as Record<string, unknown>;
    const from = keyOf(o.from);
    const to = keyOf(o.to);
    const kind = (LINK_KINDS as string[]).includes(s(o.kind, 20)) ? s(o.kind, 20) as TeamzLinkKind : "handoff";
    if (!from || !to || from === to) continue;
    const id = `${from}>${to}:${kind}`;
    if (seenLinks.has(id)) continue;
    seenLinks.add(id);
    links.push({ from, to, kind, when: s(o.when, 240) || "quand ton travail le demande" });
    if (links.length >= 24) break;
  }
  // Personne n'est isolé : un membre sans lien reçoit le travail de l'animateur
  // et lui rend compte — la topologie minimale d'une équipe.
  const lead = members[leadIdx];
  if (lead) {
    for (const m of members) {
      if (m === lead || links.some((l) => l.from === m.key || l.to === m.key)) continue;
      links.push({ from: lead.key, to: m.key, kind: "handoff", when: `quand une demande relève du rôle de ${m.name}` });
      links.push({ from: m.key, to: lead.key, kind: "review", when: "avant de livrer à l'humain" });
    }
  }

  const routines: TeamzRoutine[] = [];
  for (const x of Array.isArray(r.routines) ? r.routines : []) {
    const o = (x ?? {}) as Record<string, unknown>;
    const owner = keyOf(o.owner) ?? lead?.key ?? null;
    const cron = s(o.cron, 40);
    const label = s(o.label, 120);
    const prompt = s(o.prompt, 1500);
    if (!owner || !label || !prompt || !/^\S+ \S+ \S+ \S+ \S+$/.test(cron)) continue;
    routines.push({ owner, label, cron, prompt });
    if (routines.length >= 4) break;
  }

  const plugs: TeamzPlug[] = [];
  for (const p of Array.isArray(r.plugs) ? r.plugs : []) {
    const o = (typeof p === "string" ? { slug: p } : p ?? {}) as Record<string, unknown>;
    const slug = s(o.slug, 60).toLowerCase();
    if (!/^[a-z0-9_.-]{2,60}$/.test(slug) || plugs.some((x) => x.slug === slug)) continue;
    plugs.push({ slug, name: s(o.name, 60) || slug, why: s(o.why, 200), required: o.required === true });
  }
  // Une app citée par un membre est une prise de l'équipe.
  for (const m of members) {
    for (const c of m.connectors ?? []) {
      if (!plugs.some((p) => p.slug === c)) plugs.push({ slug: c, name: c, why: `utilisée par ${m.name}` });
    }
  }

  const kickoffRaw = (r.kickoff && typeof r.kickoff === "object" ? r.kickoff : null) as Record<string, unknown> | null;
  const kickoff = kickoffRaw && s(kickoffRaw.title, 160) && s(kickoffRaw.brief, 3000)
    ? { title: s(kickoffRaw.title, 160), brief: s(kickoffRaw.brief, 3000) } : null;
  const minutesPerRun = averageMinutes(members);
  const declared = Number(r.hours_saved_per_week);
  return {
    version: 1,
    source: opts.source ?? "architect",
    template_key: opts.templateKey ?? (s(r.template_key, 60) || null),
    brief: s(opts.brief ?? r.brief, 2000),
    name: s(r.name, 80) || "Nouvelle équipe",
    mission: s(r.mission, 600),
    emoji: s(r.emoji, 8) || "✦",
    accent: HEX.test(s(r.accent, 7)) ? s(r.accent, 7) : TEAMZ_ACCENTS[0],
    members,
    links: links.slice(0, 32),
    playbook: list(r.playbook, 8),
    routines,
    plugs: plugs.slice(0, 10),
    outcomes: list(r.outcomes, 5, 200),
    kickoff,
    hours_saved_per_week: Number.isFinite(declared) && declared > 0
      ? Math.min(Math.round(declared), 60)
      : estimateHoursPerWeek(members, routines),
    minutes_per_run: minutesPerRun,
  };
}

export function averageMinutes(members: TeamzMember[]): number {
  const xs = members.map((m) => m.minutes_per_task ?? 30);
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 30;
}

/** Estimation PRUDENTE : chaque membre traite ~4 tâches/semaine, plus une par
 *  routine hebdomadaire. Affichée « ≈ », avec sa formule. */
export function estimateHoursPerWeek(members: TeamzMember[], routines: TeamzRoutine[]): number {
  const tasks = members.reduce((t, m) => t + 4 * (m.minutes_per_task ?? 30), 0);
  const routineMin = routines.reduce((t, x) => t + routinesPerWeek(x.cron) * (members.find((m) => m.key === x.owner)?.minutes_per_task ?? 30), 0);
  return Math.max(2, Math.min(60, Math.round((tasks + routineMin) / 60)));
}

/** Combien de fois par semaine une cadence simple se déclenche. */
export function routinesPerWeek(cron: string): number {
  const [, h, dom, , dow] = cron.trim().split(/\s+/);
  if (h === "*") return 7 * 24;
  if (dow && dow !== "*") return dow.split(",").length;
  if (dom && dom !== "*") return 0.25;
  return 7;
}

/** Un modèle du catalogue, prêt à déployer. */
export function blueprintFromTemplate(t: TeamzTemplate, brief = ""): TeamBlueprint {
  return {
    version: 1,
    source: "template",
    template_key: t.key,
    brief,
    name: t.name,
    mission: t.mission,
    emoji: t.emoji,
    accent: t.accent,
    members: t.members.map((m) => ({ ...m })),
    links: t.links.map((l) => ({ ...l })),
    playbook: [...t.playbook],
    routines: t.routines.map((r) => ({ ...r })),
    plugs: t.plugs.map((p) => ({ ...p })),
    outcomes: [...t.outcomes],
    kickoff: { ...t.kickoff },
    hours_saved_per_week: t.hours_saved_per_week,
    minutes_per_run: averageMinutes(t.members),
  };
}

/** Le modèle du catalogue le plus proche d'une demande (lexical, sans modèle). */
export function matchTemplate<T extends Pick<TeamzTemplate, "key" | "name" | "tagline" | "keywords" | "category">>(
  brief: string, catalog: T[],
): { template: T; score: number } | null {
  const words = new Set(tokens(brief));
  if (!words.size) return null;
  let best: { template: T; score: number } | null = null;
  for (const t of catalog) {
    const hay = tokens(`${t.name} ${t.tagline} ${t.category} ${t.keywords.join(" ")}`);
    let score = 0;
    for (const w of new Set(hay)) if (words.has(w)) score += w.length > 6 ? 2 : 1;
    if (!best || score > best.score) best = { template: t, score };
  }
  return best && best.score >= 2 ? best : null;
}

function tokens(v: string): string[] {
  return v.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.replace(/(s|x)$/, ""));
}
const STOP = new Set(["les", "des", "une", "pour", "avec", "dans", "sur", "par", "qui", "que", "est", "the", "and", "for", "with", "equipe", "team", "agent", "agents", "cree", "creer", "moi", "mon", "mes", "nos", "notre"]);

// ── Routines : du cron « heure locale » à la ligne du planificateur ──────────
//
// Mêmes formes que src/features/service-dashboards/scheduleCadence.ts : une
// routine est une ligne internal_agent_missions avec une cadence et ses
// champs d'alignement UTC. Le cron d'un modèle s'écrit dans l'heure de la
// personne (« 0 8 * * 1 » = lundi 8 h chez elle) ; `tzOffsetMinutes` est
// celui de Date#getTimezoneOffset (Paris l'hiver : -60).

export type Cadence = "hourly" | "daily" | "weekly" | "monthly";
export interface Cadenced { cadence: Cadence; minute: number; hour: number; dow: number; dom: number }

export function cadenceOfCron(cron: string): Cadenced | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, h, dom, mon, dow] = parts;
  const num = (x: string) => (/^\d+$/.test(x) ? Number(x) : null);
  const minute = num(mi);
  if (minute === null || minute > 59 || mon !== "*") return null;
  if (h === "*" && dom === "*" && dow === "*") return { cadence: "hourly", minute, hour: 0, dow: 0, dom: 1 };
  const hour = num(h);
  if (hour === null || hour > 23) return null;
  if (dom === "*" && dow === "*") return { cadence: "daily", minute, hour, dow: 0, dom: 1 };
  const d = num(dow);
  if (dom === "*" && d !== null && d <= 6) return { cadence: "weekly", minute, hour, dow: d, dom: 1 };
  const m = num(dom);
  if (dow === "*" && m !== null && m >= 1 && m <= 28) return { cadence: "monthly", minute, hour, dow: 0, dom: m };
  return null;
}

export interface ScheduledRow {
  schedule: Cadence;
  next_run_at: string;
  schedule_minute: number;
  schedule_hour: number | null;
  schedule_dow: number | null;
  schedule_dom: number | null;
}

/** La première occurrence strictement future, calculée dans l'heure locale de
 *  la personne, puis ramenée en UTC avec ses champs d'alignement. */
export function scheduleRowFor(sel: Cadenced, tzOffsetMinutes: number, now = new Date()): ScheduledRow {
  // On travaille sur une horloge « locale » simulée en UTC : décalée de
  // l'offset, ses getUTC* sont les heures murales de la personne.
  const shift = -tzOffsetMinutes * 60_000;
  const local = new Date(now.getTime() + shift);
  const d = new Date(local);
  d.setUTCSeconds(0, 0);
  if (sel.cadence === "hourly") {
    d.setUTCMinutes(sel.minute);
    if (d <= local) d.setUTCHours(d.getUTCHours() + 1);
  } else {
    d.setUTCHours(sel.hour, sel.minute);
    if (sel.cadence === "daily") {
      if (d <= local) d.setUTCDate(d.getUTCDate() + 1);
    } else if (sel.cadence === "weekly") {
      let delta = (sel.dow - d.getUTCDay() + 7) % 7;
      if (delta === 0 && d <= local) delta = 7;
      d.setUTCDate(d.getUTCDate() + delta);
    } else {
      d.setUTCDate(sel.dom);
      if (d <= local) d.setUTCMonth(d.getUTCMonth() + 1, sel.dom);
    }
  }
  const occ = new Date(d.getTime() - shift);
  return {
    schedule: sel.cadence,
    next_run_at: occ.toISOString(),
    schedule_minute: occ.getUTCMinutes(),
    schedule_hour: sel.cadence === "hourly" ? null : occ.getUTCHours(),
    schedule_dow: sel.cadence === "weekly" ? occ.getUTCDay() : null,
    schedule_dom: sel.cadence === "monthly" ? Math.min(occ.getUTCDate(), 28) : null,
  };
}

/** Un libellé humain : « chaque lundi à 08:00 ». */
export function describeCron(cron: string): string {
  const c = cadenceOfCron(cron);
  if (!c) return cron;
  const hm = `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
  const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  if (c.cadence === "hourly") return `chaque heure à la minute ${c.minute}`;
  if (c.cadence === "daily") return `chaque jour à ${hm}`;
  if (c.cadence === "weekly") return `chaque ${DAYS[c.dow]} à ${hm}`;
  return `le ${c.dom} de chaque mois à ${hm}`;
}

// ── Temps gagné (affiché avec sa formule) ────────────────────────────────────

export interface TimeSaved { minutes: number; runs: number; deliverables: number; formula: string }

/** Exécutions réussies × minutes par exécution + 15 min par livrable produit. */
export function timeSaved(runs: number, deliverables: number, minutesPerRun: number): TimeSaved {
  const minutes = Math.round(runs * minutesPerRun + deliverables * 15);
  return {
    minutes, runs, deliverables,
    formula: `${runs} exécution${runs > 1 ? "s" : ""} réussie${runs > 1 ? "s" : ""} × ${minutesPerRun} min + ${deliverables} livrable${deliverables > 1 ? "s" : ""} × 15 min`,
  };
}
