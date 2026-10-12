// LeadSense — la qualification des prospects, par les agents internes.
//
// Un prospect arrive (formulaire, agent public, e-mail, fiche CRM). Il faut
// dire : qu'est-ce que c'est (démo, devis, partenariat… ou un candidat, un
// client mal routé, du spam), vaut-il le coup, faut-il appeler MAINTENANT, et
// qui doit s'en occuper. LeadSense pose ces questions à Jev en un appel, sur une
// grille que l'entreprise écrit elle-même :
//
//   type        — choice parmi les types de demande (réglables)
//   critères    — un score 0-3 par critère (besoin, budget, décideur,
//                 échéance, adéquation… réglables), chaque niveau décrit
//                 comme une SITUATION
//   chaud       — noul : à transmettre immédiatement ?
//   commercial  — choice parmi les commerciaux, d'après ce que chacun couvre
//
// Le CODE fait le reste : score pondéré 0-100, rang A/B/C/D, commercial retenu
// seulement si le choix est sûr. Avant le jugement, le prospect est ENRICHI
// par ce que le CRM sait déjà (même e-mail, même domaine) et par le contexte que
// l'agent a lui-même trouvé (recherche web autorisée) — un « déjà client » ne
// se qualifie pas comme un inconnu.
//
// L'outil est appelé explicitement par un agent : en `shadow` comme en `on`, il
// rend son résultat (c'est sa raison d'être), et le mode est enregistré avec le
// prospect. Éteint, il le dit et ne devine rien.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  judge, choice, score, noul, readChoice, readScore, readNoul, qid, hasTypesafeKey,
  loadTypesafeConfig, type Level,
} from "./typesafe.ts";

type Admin = SupabaseClient;

// ── La grille ────────────────────────────────────────────────────────────────

export interface Criterion {
  key: string;
  label: string;
  /** Ce que le critère mesure — l'énoncé de la question. */
  what: string;
  /** Quatre situations, de 0 à 3. */
  levels: [string, string, string, string];
  weight: number;
}

export interface LeadType {
  key: string;
  label: string;
  what: string;
  not_for?: string;
  examples?: string[];
  /** Ce type mérite-t-il un score commercial ? (non pour spam, candidature…) */
  qualify: boolean;
}

export interface Rep {
  id: string;
  name: string;
  email?: string;
  /** Ce que ce commercial couvre : segment, taille, secteur, région, langue. */
  covers: string;
}

export interface LeadConfig {
  ideal_customer: string;
  criteria: Criterion[];
  lead_types: LeadType[];
  hot_rule: string;
  reps: Rep[];
  tiers: { a: number; b: number; c: number };
}

export const DEFAULT_LEAD_CONFIG: LeadConfig = {
  ideal_customer: "",
  criteria: [
    {
      key: "besoin", label: "Besoin", weight: 25,
      what: "Le prospect exprime-t-il un problème que notre offre résout ?",
      levels: [
        "Aucun besoin exprimé : message vide, question hors sujet, simple bonjour.",
        "Curiosité : il se renseigne, sans problème précis à régler.",
        "Problème identifié : il décrit une difficulté que notre offre adresse.",
        "Besoin précis : cas d'usage détaillé, volumes, outils actuels ou contrainte chiffrée.",
      ],
    },
    {
      key: "budget", label: "Budget", weight: 20,
      what: "Y a-t-il des signes que le prospect peut et veut payer ?",
      levels: [
        "Signaux contraires : cherche du gratuit, étudiant, projet personnel sans moyens.",
        "Aucun indice sur le budget.",
        "Budget plausible : taille d'équipe ou d'entreprise compatible, outil payant déjà en place.",
        "Budget affirmé : demande de devis chiffré, enveloppe citée, achat déjà décidé.",
      ],
    },
    {
      key: "decideur", label: "Décideur", weight: 20,
      what: "La personne a-t-elle le pouvoir de décider de l'achat ?",
      levels: [
        "Aucun pouvoir : particulier, étudiant, stagiaire.",
        "Utilisateur : il utiliserait l'outil mais ne décide pas.",
        "Prescripteur : manager ou chef de projet qui recommande.",
        "Décideur : fondateur, dirigeant, directeur, responsable des achats.",
      ],
    },
    {
      key: "echeance", label: "Échéance", weight: 15,
      what: "Quand le prospect compte-t-il agir ?",
      levels: [
        "Aucune échéance, ou « un jour peut-être ».",
        "Lointaine : dans plus de six mois, prochain exercice.",
        "Ce trimestre : projet planifié, appel d'offres en cours.",
        "Immédiate : besoin sous un mois, date butoir, remplacement urgent d'un outil.",
      ],
    },
    {
      key: "adequation", label: "Adéquation", weight: 20,
      what: "Le prospect ressemble-t-il à notre client idéal ?",
      levels: [
        "Hors cible : secteur, taille ou pays que nous ne servons pas.",
        "Marginal : servable, mais loin de nos clients habituels.",
        "Proche : ressemble à nos clients sur l'essentiel.",
        "Cœur de cible : exactement le profil de nos meilleurs clients.",
      ],
    },
  ],
  lead_types: [
    {
      key: "demo", label: "Demande de démo", qualify: true,
      what: "Le prospect veut voir le produit : démonstration, essai accompagné, rendez-vous de présentation.",
      examples: ["je voudrais une démo pour mon équipe", "pouvez-vous me montrer comment ça marche ?"],
    },
    {
      key: "devis", label: "Demande de devis", qualify: true,
      what: "Le prospect veut un prix pour son cas : devis, tarif sur mesure, offre entreprise, volume.",
      not_for: "Une question sur les tarifs publics sans projet d'achat (c'est une question).",
      examples: ["combien pour 50 utilisateurs ?", "pouvez-vous m'envoyer une proposition commerciale ?"],
    },
    {
      key: "question", label: "Question avant-vente", qualify: true,
      what: "Une question sur l'offre avant d'acheter : fonctionnalité, intégration, sécurité, conditions.",
      examples: ["est-ce que vous vous intégrez à Salesforce ?", "êtes-vous conformes RGPD ?"],
    },
    {
      key: "partenariat", label: "Partenariat", qualify: true,
      what: "Une proposition de partenariat, de revente, d'intégration ou d'affiliation.",
      examples: ["nous sommes intégrateurs et aimerions revendre votre solution"],
    },
    {
      key: "client_existant", label: "Client existant (support)", qualify: false,
      what: "Un client actuel qui a un problème ou une question sur son compte — ce n'est pas un prospect.",
      examples: ["ma facture est fausse", "je n'arrive plus à me connecter"],
    },
    {
      key: "candidature", label: "Candidature", qualify: false,
      what: "Une candidature spontanée, une demande de stage ou d'emploi.",
      examples: ["je souhaite rejoindre votre équipe", "vous recrutez des alternants ?"],
    },
    {
      key: "fournisseur", label: "Prospection entrante", qualify: false,
      what: "Quelqu'un qui veut NOUS vendre quelque chose : agence, prestataire, outil, levée de fonds.",
      examples: ["nous aidons les SaaS à générer des leads", "offre de référencement SEO"],
    },
    {
      key: "spam", label: "Spam", qualify: false,
      what: "Message automatique, sans rapport, promotionnel ou frauduleux.",
      examples: ["gagnez 10 000 € par mois", "lien suspect sans texte"],
    },
  ],
  hot_rule:
    "Le prospect demande une action commerciale immédiate (démo, devis, rappel, rendez-vous) ET donne des signes sérieux : entreprise identifiée, besoin précis, ou échéance proche.",
  reps: [],
  tiers: { a: 75, b: 50, c: 25 },
};

export function normalizeLeadConfig(raw: unknown): LeadConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<LeadConfig>;
  const d = DEFAULT_LEAD_CONFIG;
  const criteria = Array.isArray(r.criteria)
    ? r.criteria.filter((c): c is Criterion =>
        !!c && typeof c.key === "string" && !!c.key && Array.isArray(c.levels) && c.levels.length === 4)
    : [];
  const types = Array.isArray(r.lead_types)
    ? r.lead_types.filter((t): t is LeadType => !!t && typeof t.key === "string" && !!t.key && typeof t.label === "string")
    : [];
  const reps = Array.isArray(r.reps)
    ? r.reps.filter((x): x is Rep => !!x && typeof x.id === "string" && typeof x.name === "string" && !!x.name.trim())
    : [];
  const tiers = (r.tiers ?? {}) as Partial<LeadConfig["tiers"]>;
  const n = (v: unknown, fb: number) => (Number.isFinite(Number(v)) ? Number(v) : fb);
  return {
    ideal_customer: typeof r.ideal_customer === "string" ? r.ideal_customer : d.ideal_customer,
    criteria: criteria.length ? criteria.slice(0, 10) : d.criteria,
    lead_types: types.length >= 2 ? types.slice(0, 30) : d.lead_types,
    hot_rule: typeof r.hot_rule === "string" && r.hot_rule.trim() ? r.hot_rule : d.hot_rule,
    reps: reps.slice(0, 50),
    tiers: { a: n(tiers.a, d.tiers.a), b: n(tiers.b, d.tiers.b), c: n(tiers.c, d.tiers.c) },
  };
}

export async function loadLeadConfig(admin: Admin, projectId: string): Promise<LeadConfig> {
  try {
    const { data } = await admin.from("leadsense_config").select("config").eq("project_id", projectId).maybeSingle();
    return normalizeLeadConfig((data as { config?: unknown } | null)?.config);
  } catch {
    return DEFAULT_LEAD_CONFIG;
  }
}

// ── L'enrichissement ─────────────────────────────────────────────────────────

const FREE_MAIL = /@(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|me|aol|proton(mail)?|gmx|orange|free|sfr|laposte|wanadoo|yandex)\./i;

export interface Enrichment {
  crm_matches: Array<{ id: string; object: string; title: string; fields: Record<string, unknown> }>;
  company_domain: string | null;
  personal_email: boolean;
}

/** Ce que le CRM sait déjà de ce prospect : même e-mail, ou même domaine
 *  d'entreprise (jamais un domaine de messagerie grand public). */
export async function enrichFromCrm(admin: Admin, projectId: string, email: string | null): Promise<Enrichment> {
  const out: Enrichment = { crm_matches: [], company_domain: null, personal_email: false };
  if (!email || !email.includes("@")) return out;
  const clean = email.trim().toLowerCase().replace(/[,()]/g, "");
  out.personal_email = FREE_MAIL.test(clean);
  const domain = out.personal_email ? null : clean.split("@")[1] ?? null;
  out.company_domain = domain;
  try {
    const ors = [`data->>email.ilike.${clean}`];
    if (domain) ors.push(`data->>website.ilike.*${domain}*`, `data->>domain.ilike.*${domain}*`, `data->>email.ilike.*@${domain}`);
    const { data } = await admin.from("crm_records")
      .select("id, object_id, data, crm_objects(slug, title_property)")
      .eq("project_id", projectId).or(ors.join(",")).limit(8);
    for (const r of (data ?? []) as Array<{
      id: string; data: Record<string, unknown>;
      crm_objects: { slug: string; title_property: string | null } | null;
    }>) {
      const titleKey = r.crm_objects?.title_property || "name";
      const fields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r.data ?? {})) {
        if (v == null || v === "" || typeof v === "object") continue;
        fields[k] = typeof v === "string" ? v.slice(0, 120) : v;
        if (Object.keys(fields).length >= 10) break;
      }
      out.crm_matches.push({
        id: r.id, object: r.crm_objects?.slug ?? "?",
        title: String(r.data?.[titleKey] ?? r.data?.name ?? r.data?.email ?? r.id), fields,
      });
    }
  } catch { /* un CRM injoignable ne bloque pas la qualification */ }
  return out;
}

// ── La qualification ─────────────────────────────────────────────────────────

export interface LeadInput {
  name?: string; email?: string; company?: string; role?: string;
  message: string; source?: string; source_ref?: string;
  /** Ce que l'agent a trouvé lui-même (site, taille, secteur, actualité). */
  context?: string;
  fields?: Record<string, unknown>;
}

export interface Qualification {
  type: LeadType; typeConfidence: number;
  criteria: Record<string, number>;
  score: number | null;
  tier: "A" | "B" | "C" | "D" | null;
  hot: boolean; hotP: number;
  rep: Rep | null; repConfidence: number | null;
  mode: "shadow" | "on";
}

export async function qualifyLead(
  ctx: { admin: Admin; workspaceId: string; projectId: string; runId?: string | null },
  config: LeadConfig,
  lead: LeadInput,
  enrichment: Enrichment,
): Promise<Qualification | "off" | null> {
  if (!hasTypesafeKey()) return "off";
  const cfg = (await loadTypesafeConfig(ctx.admin, ctx.workspaceId))["lead_scoring"];
  if (!cfg || cfg.mode === "off") return "off";

  const typeByKey = new Map<string, LeadType>();
  const typeCriteria: Record<string, { what: string; not_for?: string; examples?: string[] }> = {};
  for (const t of config.lead_types) {
    const k = qid(t.key);
    typeByKey.set(k, t);
    typeCriteria[k] = { what: t.what || t.label, ...(t.not_for ? { not_for: t.not_for } : {}), ...(t.examples?.length ? { examples: t.examples.slice(0, 5) } : {}) };
  }
  const repByKey = new Map<string, Rep>();
  const repCriteria: Record<string, { what: string }> = {};
  for (const r of config.reps) {
    const k = qid(`r_${r.name}_${r.id.slice(0, 6)}`);
    repByKey.set(k, r);
    repCriteria[k] = { what: `${r.name} — couvre : ${r.covers || "tout"}` };
  }

  const questions: Record<string, ReturnType<typeof choice> | ReturnType<typeof score> | ReturnType<typeof noul>> = {
    type: choice("Quel genre de demande est-ce ?", typeCriteria),
    chaud: noul("Faut-il transmettre ce prospect à un commercial immédiatement ?", {
      true: { what: config.hot_rule },
      false: { what: "Le prospect peut attendre le traitement normal : il se renseigne, n'a pas d'échéance, ou n'est pas un prospect." },
    }),
  };
  for (const c of config.criteria) {
    const what = c.key === "adequation" && config.ideal_customer.trim()
      ? `${c.what} Notre client idéal : ${config.ideal_customer.trim()}`
      : c.what;
    questions[`c_${qid(c.key)}`] = score(what, c.levels.map((l): Level => ({ summary: l })));
  }
  if (repByKey.size >= 2) questions.commercial = choice("Quel commercial doit reprendre ce prospect ?", repCriteria);

  const state: Record<string, unknown> = {
    message: lead.message.slice(0, 3000),
    ...(lead.name ? { nom: lead.name } : {}),
    ...(lead.company ? { entreprise: lead.company } : {}),
    ...(lead.role ? { fonction: lead.role } : {}),
    ...(lead.source ? { source: lead.source } : {}),
    ...(enrichment.company_domain ? { domaine: enrichment.company_domain } : {}),
    ...(enrichment.personal_email ? { email: "adresse personnelle (messagerie grand public)" } : {}),
    ...(lead.fields && Object.keys(lead.fields).length ? { champs: JSON.stringify(lead.fields).slice(0, 800) } : {}),
    ...(lead.context?.trim() ? { recherche: lead.context.slice(0, 2000) } : {}),
    ...(enrichment.crm_matches.length
      ? { deja_dans_le_crm: enrichment.crm_matches.map((m) => `${m.object} « ${m.title} » ${JSON.stringify(m.fields).slice(0, 300)}`).join("\n") }
      : {}),
  };

  const verdict = await judge(ctx, "lead_scoring", state, questions, {
    subject: `${lead.company || lead.name || lead.email || "prospect"} · ${lead.message.slice(0, 60)}`,
  });
  if (!verdict) return null;

  const t = readChoice(verdict, "type");
  const type = (t && typeByKey.get(t.choice)) || null;
  if (!type) return null;
  const criteria: Record<string, number> = {};
  for (const c of config.criteria) {
    const s = readScore(verdict, `c_${qid(c.key)}`);
    if (s) criteria[c.key] = Math.min(3, Math.max(0, Math.round(s.score)));
  }
  // Le score n'a de sens que pour un vrai prospect : un candidat ou un spam
  // n'a pas un « mauvais score », il n'a pas de score.
  let scoreValue: number | null = null;
  let tier: Qualification["tier"] = null;
  if (type.qualify) {
    const totalWeight = config.criteria.reduce((n, c) => n + (c.weight > 0 ? c.weight : 0), 0) || 1;
    scoreValue = Math.round(config.criteria.reduce((n, c) =>
      n + (c.weight > 0 ? c.weight : 0) * ((criteria[c.key] ?? 0) / 3), 0) / totalWeight * 100);
    tier = scoreValue >= config.tiers.a ? "A" : scoreValue >= config.tiers.b ? "B" : scoreValue >= config.tiers.c ? "C" : "D";
  }
  const hotP = readNoul(verdict, "chaud") ?? 0;
  const hot = type.qualify && hotP >= verdict.threshold;
  let rep: Rep | null = null;
  let repConfidence: number | null = null;
  if (repByKey.size === 1) rep = config.reps[0];
  const rc = readChoice(verdict, "commercial");
  if (rc) {
    repConfidence = rc.confidence;
    // Un commercial choisi en hésitant n'est pas une affectation : on laisse
    // la personne trancher plutôt que de répartir au hasard.
    if (rc.confidence >= 0.5) rep = repByKey.get(rc.choice) ?? null;
  }
  return {
    type, typeConfidence: t?.confidence ?? 0, criteria, score: scoreValue, tier,
    hot, hotP, rep: type.qualify ? rep : null, repConfidence,
    mode: verdict.mode === "on" ? "on" : "shadow",
  };
}

// ── Le tableau prédéfini (livrable lead_board) ───────────────────────────────

export interface LeadRow {
  id: string; name: string | null; email: string | null; company: string | null; role: string | null;
  source: string | null; lead_type_label: string; qualifies: boolean;
  criteria: Record<string, number>; score: number | null; tier: string | null;
  hot: boolean; rep_name: string | null; status: string; message: string | null; created_at: string;
}

/** Le contenu d'un livrable `lead_board`. Les chiffres viennent des lignes ;
 *  l'agent n'apporte que son titre, sa lecture et ses recommandations. */
export function buildLeadBoard(
  rows: LeadRow[], config: LeadConfig,
  text: { title: string; headline: string; recommendations: string[]; period_days: number },
): Record<string, unknown> {
  const qualified = rows.filter((r) => r.qualifies);
  const count = (key: (r: LeadRow) => string | null) => {
    const m: Record<string, number> = {};
    for (const r of rows) { const k = key(r); if (k) m[k] = (m[k] ?? 0) + 1; }
    return m;
  };
  return {
    type: "lead_board",
    version: 1,
    title: text.title,
    generated_at: new Date().toISOString(),
    period_days: text.period_days,
    headline: text.headline,
    recommendations: text.recommendations.slice(0, 8),
    criteria: config.criteria.map((c) => ({ key: c.key, label: c.label, weight: c.weight })),
    totals: {
      leads: rows.length,
      qualified: qualified.length,
      hot: rows.filter((r) => r.hot).length,
      avg_score: qualified.length
        ? Math.round(qualified.reduce((n, r) => n + (r.score ?? 0), 0) / qualified.length)
        : null,
    },
    by_tier: count((r) => r.tier),
    by_type: count((r) => r.lead_type_label),
    by_source: count((r) => r.source),
    by_rep: count((r) => (r.qualifies ? r.rep_name ?? "Non affecté" : null)),
    leads: [...rows]
      .sort((a, b) => Number(b.hot) - Number(a.hot) || (b.score ?? -1) - (a.score ?? -1))
      .slice(0, 60)
      .map((r) => ({
        id: r.id, name: r.name, company: r.company, role: r.role, email: r.email, source: r.source,
        type: r.lead_type_label, score: r.score, tier: r.tier, hot: r.hot, rep: r.rep_name,
        status: r.status, criteria: r.criteria, excerpt: (r.message ?? "").slice(0, 200), created_at: r.created_at,
      })),
  };
}
