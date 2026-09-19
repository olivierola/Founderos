// Le contexte d'entreprise — ce que tout agent doit savoir avant de commencer.
//
// Un agent avait jusqu'ici une identité, une âme, des instructions, une
// mémoire et des skills. Il n'avait pas d'employeur : `internal-agent-run` ne
// lisait même pas la ligne `projects`. Chaque run redécouvrait donc l'activité,
// le marché, la cible et le ton — mal, et différemment d'un agent à l'autre.
//
// Ce module rend deux choses, et décide de ce qui vaut la place :
//
//   • LE PROFIL (company_profile, 0212) — court, stable, TOUJOURS envoyé. Il
//     tient en une dizaine de lignes, il ne change pas d'une tâche à l'autre,
//     et il vaut mille tours de clarification. Les non-négociables en sortent
//     à part : ce n'est pas de l'information, c'est une règle.
//   • LES OBJECTIFS (company_objectives, 0212) — SÉLECTIONNÉS. Une entreprise
//     peut en avoir quarante ; en envoyer quarante à un agent qui range des
//     factures, c'est reprendre en bruit ce qu'on a gagné en contexte. Trois
//     familles passent d'office (voir `selectObjectives`), le reste concourt.
//
// Le fichier est PUR — pas de client, pas d'I/O, pas d'API Deno — SAUF la
// section « Chargement » tout en bas, isolée exprès : c'est ce qui permet au
// moteur de run, au tour de room et aux tests de partager le même rendu.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { selectRelevant } from "./prompt-compiler.ts";

// ---------------------------------------------------------------------------
// Les données
// ---------------------------------------------------------------------------

export interface CompanyProfile {
  legal_name?: string | null;
  activity?: string | null;
  mission?: string | null;
  market?: string | null;
  icp?: string | null;
  value_prop?: string | null;
  differentiators?: string | null;
  stage?: string | null;
  team_size?: number | null;
  geographies?: string[] | null;
  languages?: string[] | null;
  tone?: string | null;
  constraints?: string | null;
  non_negotiables?: string | null;
}

export interface CompanyObjective {
  id: string;
  parent_id?: string | null;
  title: string;
  detail?: string | null;
  metric?: string | null;
  unit?: string | null;
  baseline_value?: number | null;
  target_value?: number | null;
  current_value?: number | null;
  direction?: "increase" | "decrease" | "maintain" | null;
  period_end?: string | null;
  status?: string | null;
  priority?: number | null;
  owner_dashboard_id?: string | null;
  owner_agent_id?: string | null;
}

/** Qui lit le contexte — ce qui décide de ce qui est « à toi ». */
export interface CompanyReader {
  agentId?: string | null;
  dashboardId?: string | null;
  /** Nom du service, pour que l'agent sache où il travaille. */
  dashboardName?: string | null;
  /** Mission du service (service_dashboards.mission, 0213). */
  dashboardMission?: string | null;
}

export interface CompanyContext {
  profile: CompanyProfile | null;
  objectives: CompanyObjective[];
  reader: CompanyReader;
}

/** Le profil tient en peu de lignes ; les objectifs se disputent le reste. */
export const COMPANY_PROFILE_MAX_CHARS = 1400;
export const COMPANY_OBJECTIVES_BUDGET = 1400;

// ---------------------------------------------------------------------------
// Le profil
// ---------------------------------------------------------------------------

const PROFILE_FIELDS: Array<[keyof CompanyProfile, string]> = [
  ["activity", "Activité"],
  ["mission", "Raison d'être"],
  ["market", "Marché"],
  ["icp", "Client type"],
  ["value_prop", "Proposition de valeur"],
  ["differentiators", "Ce qui nous distingue"],
  ["tone", "Ton à respecter"],
  ["constraints", "Contraintes"],
];

const oneLine = (v: unknown): string =>
  String(v ?? "").replace(/\s+/g, " ").trim();

/**
 * Le profil, en lignes « Libellé : valeur ». Les champs vides disparaissent
 * complètement plutôt que de sortir en « Marché : (non renseigné) » — une
 * ligne vide apprend au modèle que le champ existe et qu'il est inutile, ce
 * qui est la pire des deux options.
 */
export function renderCompanyProfile(
  profile: CompanyProfile | null | undefined,
  reader: CompanyReader = {},
): string {
  if (!profile) return "";
  const out: string[] = [];
  const name = oneLine(profile.legal_name);
  if (name) out.push(`- Entreprise : ${name}`);
  for (const [key, label] of PROFILE_FIELDS) {
    const v = oneLine(profile[key]);
    if (v) out.push(`- ${label} : ${v}`);
  }
  // Stade et taille se lisent ensemble ou pas du tout : « croissance » seul ne
  // dit rien, « croissance, 12 personnes » situe immédiatement.
  const situation = [
    oneLine(profile.stage),
    profile.team_size ? `${profile.team_size} personnes` : "",
  ].filter(Boolean).join(" · ");
  if (situation) out.push(`- Situation : ${situation}`);
  const geo = (profile.geographies ?? []).filter(Boolean).join(", ");
  const lang = (profile.languages ?? []).filter(Boolean).join(", ");
  if (geo) out.push(`- Zones : ${geo}`);
  if (lang) out.push(`- Langues de travail : ${lang}`);

  // Où travaille CET agent. C'est du contexte d'entreprise, pas du contexte
  // d'agent : c'est l'entreprise qui découpe ses services, pas l'agent.
  const svc = oneLine(reader.dashboardName);
  if (svc) {
    const mission = oneLine(reader.dashboardMission);
    out.push(`- Ton service : ${svc}${mission ? ` — ${mission}` : ""}`);
  }

  const body = out.join("\n");
  return body.length > COMPANY_PROFILE_MAX_CHARS
    ? `${body.slice(0, COMPANY_PROFILE_MAX_CHARS)}…`
    : body;
}

// ---------------------------------------------------------------------------
// Les objectifs
// ---------------------------------------------------------------------------

/** Avancement en %, ou null quand l'objectif n'est pas mesuré. Sens compris :
 *  faire BAISSER un chiffre de 100 à 60 avec une cible à 50, c'est 80 %, pas
 *  -20 %. Un objectif mal orienté qui affiche un pourcentage aberrant est un
 *  objectif que personne ne relit. */
export function objectiveProgress(o: CompanyObjective): number | null {
  const target = o.target_value;
  const current = o.current_value;
  if (target == null || current == null) return null;
  const base = o.baseline_value ?? 0;
  if (o.direction === "maintain") return current >= target ? 100 : null;
  const span = target - base;
  if (span === 0) return current === target ? 100 : null;
  const pct = ((current - base) / span) * 100;
  return Math.max(0, Math.min(999, Math.round(pct)));
}

/** Une ligne d'objectif : le titre, la mesure, l'échéance, et à qui il est. */
export function renderObjective(o: CompanyObjective, reader: CompanyReader = {}): string {
  const mine = !!reader.agentId && o.owner_agent_id === reader.agentId;
  const ours = !mine && !!reader.dashboardId && o.owner_dashboard_id === reader.dashboardId;
  const tag = mine ? "[À TOI] " : ours ? "[TON SERVICE] " : "";

  const bits: string[] = [];
  if (o.metric) {
    const cur = o.current_value ?? null;
    const tgt = o.target_value ?? null;
    const unit = o.unit ? ` ${o.unit}` : "";
    if (cur != null && tgt != null) bits.push(`${o.metric} : ${cur}${unit} → ${tgt}${unit}`);
    else if (tgt != null) bits.push(`${o.metric} : cible ${tgt}${unit}`);
    else bits.push(o.metric);
  }
  const pct = objectiveProgress(o);
  if (pct != null) bits.push(`${pct} %`);
  if (o.period_end) bits.push(`échéance ${o.period_end}`);
  if (o.status && o.status !== "active") bits.push(o.status);

  const measure = bits.length ? ` (${bits.join(" · ")})` : "";
  const detail = oneLine(o.detail);
  return `- ${tag}${oneLine(o.title)}${measure}${detail ? ` — ${detail}` : ""}`;
}

/**
 * Ce que cet agent doit voir des objectifs de l'entreprise.
 *
 * Trois familles passent SANS concourir, parce qu'un agent qui ne connaît pas
 * ces trois-là travaille à l'aveugle quelle que soit la tâche :
 *   1. ce dont il est nommément responsable (owner_agent_id) ;
 *   2. ce que porte son service (owner_dashboard_id) ;
 *   3. les objectifs racines de l'entreprise (parent_id null) — le « pourquoi »
 *      dont tout le reste découle, et la seule chose qui permette de remonter
 *      la chaîne quand on lui demande quelque chose d'inattendu.
 *
 * Le reste (les objectifs des AUTRES services) concourt sur la pertinence
 * lexicale : ils comptent quand la tâche les touche, et disparaissent sinon.
 * Rien n'est perdu — `company_objectives` reste interrogeable par l'outil.
 */
export function selectObjectives(
  objectives: CompanyObjective[],
  task: string,
  reader: CompanyReader = {},
  budget: number = COMPANY_OBJECTIVES_BUDGET,
): { body: string; kept: CompanyObjective[]; dropped: number; offered: number } {
  const live = (objectives ?? []).filter(
    (o) => o.status !== "done" && o.status !== "abandoned" && o.status !== "draft",
  );
  if (live.length === 0) return { body: "", kept: [], dropped: 0, offered: 0 };

  const render = (o: CompanyObjective) => renderObjective(o, reader);
  const offered = live.map(render).join("\n").length;

  const isPinned = (o: CompanyObjective) =>
    (!!reader.agentId && o.owner_agent_id === reader.agentId) ||
    (!!reader.dashboardId && o.owner_dashboard_id === reader.dashboardId) ||
    !o.parent_id;

  if (!task || offered <= budget) {
    // Priorité d'abord, puis « à moi » avant « à l'entreprise » : un agent lit
    // les premières lignes, elles doivent être les siennes.
    const ordered = [...live].sort(
      (a, b) =>
        Number(isPinned(b)) - Number(isPinned(a)) ||
        (a.priority ?? 3) - (b.priority ?? 3),
    );
    return { body: ordered.map(render).join("\n"), kept: ordered, dropped: 0, offered };
  }

  const sel = selectRelevant(live, {
    task,
    text: (o) => `${o.title} ${o.detail ?? ""} ${o.metric ?? ""}`,
    pin: isPinned,
    budget,
    size: (o) => render(o).length + 1,
    // Un objectif hors périmètre qui effleure la tâche mérite mieux qu'un
    // silence : il indique à l'agent qu'un autre service travaille sur le même
    // sujet, ce qui est exactement le moment où il devrait aller lui parler.
    floor: 0.08,
  });
  const kept = sel.kept.sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));
  return {
    body: kept.map(render).join("\n"),
    kept,
    dropped: live.length - kept.length,
    offered,
  };
}

// ---------------------------------------------------------------------------
// La section complète
// ---------------------------------------------------------------------------

export interface CompanySection {
  body: string;
  dropped: number;
  offered: number;
}

/**
 * La section `company` du prompt système. Trois blocs, dans cet ordre :
 * l'entreprise, ses non-négociables, ses objectifs. L'ordre compte — les
 * non-négociables arrivent AVANT les objectifs, parce qu'une règle qui suit
 * une cible chiffrée se lit comme une réserve, pas comme une limite.
 */
export function renderCompanySection(
  ctx: CompanyContext | null,
  task: string,
  budget: number = COMPANY_OBJECTIVES_BUDGET,
): CompanySection {
  if (!ctx) return { body: "", dropped: 0, offered: 0 };
  const parts: string[] = [];

  const profile = renderCompanyProfile(ctx.profile, ctx.reader);
  if (profile) parts.push(profile);

  // Une règle par ligne. On découpe sur le brut (retours à la ligne, `;`, `·`)
  // et surtout PAS après oneLine : replier le texte en une seule ligne
  // supprimerait les séparateurs qu'on cherche, et les cinq règles écrites par
  // l'humain arriveraient en un seul pavé que le modèle lit comme une phrase.
  const nonNegLines = String(ctx.profile?.non_negotiables ?? "")
    .split(/\n+|\s*[;·]\s*/)
    .map((l) => l.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
  if (nonNegLines.length > 0) {
    parts.push("", "**Non négociable, quelle que soit la demande :**", ...nonNegLines.map((l) => `- ${l}`));
  }

  const obj = selectObjectives(ctx.objectives ?? [], task, ctx.reader, budget);
  if (obj.body) {
    parts.push(
      "",
      "**Ce que l'entreprise cherche à accomplir en ce moment :**",
      obj.body,
    );
  }

  const body = parts.join("\n").trim();
  return { body, dropped: obj.dropped, offered: (profile.length + obj.offered) || body.length };
}

// L'en-tête de la section (« ## L'entreprise pour laquelle tu travailles »)
// vit dans prompt-compiler.ts avec tous les autres : c'est le compilateur qui
// possède l'ordre, les titres et les lignes vides ; ce module ne rend que le
// corps.

// ---------------------------------------------------------------------------
// Chargement — la SEULE partie non pure de ce fichier
// ---------------------------------------------------------------------------

/**
 * Lit le contexte d'entreprise d'un projet, et la place du lecteur dedans.
 *
 * Le nom et la mission du service sont résolus ICI plutôt que par l'appelant :
 * les trois chemins qui construisent un prompt (chat, mission, room) doivent
 * donner le MÊME contexte, et laisser chacun se souvenir de charger sa moitié
 * est la façon la plus fiable d'obtenir trois comportements différents. Un
 * appelant qui connaît déjà ces valeurs les passe et rien n'est relu.
 *
 * Best-effort de bout en bout : une entreprise sans profil ni objectif est le
 * cas NORMAL au premier jour, et un agent doit tourner exactement pareil — la
 * section disparaît, rien ne casse.
 */
export async function loadCompanyContext(
  admin: SupabaseClient,
  projectId: string,
  reader: CompanyReader = {},
): Promise<CompanyContext | null> {
  if (!projectId) return null;
  try {
    if (reader.dashboardId && (!reader.dashboardName || reader.dashboardMission === undefined)) {
      const { data } = await admin
        .from("service_dashboards").select("name, mission")
        .eq("id", reader.dashboardId).maybeSingle();
      const d = data as { name?: string | null; mission?: string | null } | null;
      reader = {
        ...reader,
        dashboardName: reader.dashboardName ?? d?.name ?? null,
        dashboardMission: reader.dashboardMission ?? d?.mission ?? null,
      };
    }
    const [{ data: profile }, { data: objectives }] = await Promise.all([
      admin.from("company_profile")
        .select("legal_name, activity, mission, market, icp, value_prop, differentiators, stage, team_size, geographies, languages, tone, constraints, non_negotiables")
        .eq("project_id", projectId).maybeSingle(),
      admin.from("company_objectives")
        .select("id, parent_id, title, detail, metric, unit, baseline_value, target_value, current_value, direction, period_end, status, priority, owner_dashboard_id, owner_agent_id")
        .eq("project_id", projectId)
        .in("status", ["active", "at_risk"])
        .order("priority", { ascending: true })
        .limit(60),
    ]);
    const p = (profile ?? null) as CompanyProfile | null;
    const o = ((objectives ?? []) as CompanyObjective[]);
    if (!p && o.length === 0) return null;
    return { profile: p, objectives: o, reader };
  } catch {
    return null;
  }
}
