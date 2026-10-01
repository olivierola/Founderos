// ResolveAI — le tri des demandes reçues par un agent public.
//
// Un agent public répondait à tout de la même façon : une question sur les
// horaires et une demande de remboursement d'un client furieux recevaient la
// même réponse générée, sans trace, sans priorité, sans personne derrière.
// ResolveAI classe chaque message AVANT la réponse, en un appel Jev :
//
//   intention      — quoi : remboursement, bug, résiliation… (liste réglable par agent)
//   urgence        — 0 information · 1 gêne · 2 bloquant · 3 critique
//   humain_requis  — la demande appelle-t-elle une PERSONNE (geste commercial,
//                    dérogation, litige, modification de compte) ?
//
// Puis le CODE combine — jamais le modèle — pour décider :
//
//   priorité       = urgence (0 basse · 1 normale · 2 haute · 3 urgente)
//   service        = celui de l'intention (table de routage de l'agent)
//   réponse auto   = intention autorisée en auto ET pas d'humain requis ET
//                    urgence < critique ET contexte documentaire suffisant
//                    (couverture ContextIQ ≥ 2 quand elle est connue)
//
// La règle d'atomicité de la doc Jev dicte cette forme : une question = une
// propriété, les combinaisons se font en code, où elles se relisent.
//
// Effets en mode `on` : la consigne propre à l'intention entre dans le prompt ;
// une demande non éligible reçoit une réponse prudente qui annonce le relais à
// l'équipe, et devient une demande OUVERTE, avec son échéance SLA, dans la file
// de l'onglet « Demandes ». En `shadow`, tout est calculé et enregistré, rien
// ne change dans la réponse. Éteint : rien n'est appelé, rien n'est enregistré.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  judge, choice, score, noul, readChoice, readScore, readNoul, qid,
  type Criterion,
} from "./typesafe.ts";

type Admin = SupabaseClient;

// ── La configuration d'un agent ──────────────────────────────────────────────

export interface IntentDef {
  key: string;
  label: string;
  what: string;
  not_for?: string;
  examples?: string[];
  /** L'agent peut-il traiter seul ce genre de demande ? */
  auto_reply: boolean;
  /** Le service qui reprend la demande quand un humain est requis. */
  route?: string;
  /** Consigne ajoutée au prompt pour cette intention. */
  playbook?: string;
}

export interface SupportConfig {
  intents: IntentDef[];
  /** Heures avant échéance, par priorité. */
  sla_hours: { urgent: number; high: number; normal: number; low: number };
  /** Ce que dit l'agent quand il passe la main. */
  handoff_message: string;
}

export const DEFAULT_SUPPORT_CONFIG: SupportConfig = {
  intents: [
    {
      key: "information", label: "Question produit", auto_reply: true, route: "Support",
      what: "Une question sur le fonctionnement, les fonctionnalités, les prix publics, les horaires ou les conditions — la réponse est dans la documentation.",
      not_for: "Un problème rencontré sur son compte ou sa commande (c'est un bug ou une commande).",
      examples: ["est-ce que vous livrez en Belgique ?", "comment exporter mes données en CSV ?", "quels sont vos tarifs ?"],
    },
    {
      key: "commande", label: "Commande & livraison", auto_reply: true, route: "Logistique",
      what: "Le suivi d'une commande précise : où en est-elle, retard, colis non reçu, erreur d'article, retour à organiser.",
      not_for: "Une demande de remboursement d'argent (c'est un remboursement).",
      examples: ["ma commande 4521 n'est toujours pas arrivée", "j'ai reçu la mauvaise taille, comment faire un retour ?"],
    },
    {
      key: "remboursement", label: "Remboursement", auto_reply: false, route: "Facturation",
      what: "Le client veut récupérer de l'argent : remboursement, avoir, geste commercial, contestation d'un prélèvement.",
      not_for: "Une simple question sur la politique de remboursement, sans demande pour lui-même (c'est une question produit).",
      examples: ["je veux être remboursé", "vous m'avez prélevé deux fois", "je conteste ce paiement"],
    },
    {
      key: "facturation", label: "Facturation", auto_reply: true, route: "Facturation",
      what: "Factures, moyens de paiement, changement d'offre, TVA, adresse de facturation — sans demande de remboursement.",
      not_for: "Récupérer de l'argent (c'est un remboursement). Arrêter l'abonnement (c'est une résiliation).",
      examples: ["où trouver ma facture de mars ?", "je veux changer de carte bancaire", "passer à l'offre annuelle"],
    },
    {
      key: "bug", label: "Bug / incident", auto_reply: false, route: "Technique",
      what: "Quelque chose ne marche pas comme prévu : erreur, page blanche, fonctionnalité cassée, données disparues, lenteur anormale.",
      not_for: "Ne pas savoir comment faire quelque chose qui fonctionne (c'est une question produit). Un problème de connexion à son compte (c'est un accès).",
      examples: ["le bouton payer ne fait rien", "erreur 500 quand j'importe mon fichier", "mes projets ont disparu"],
    },
    {
      key: "acces", label: "Compte & accès", auto_reply: true, route: "Support",
      what: "Connexion impossible, mot de passe, double authentification, e-mail du compte, invitation d'un collègue.",
      not_for: "Supprimer son compte ou arrêter l'abonnement (c'est une résiliation).",
      examples: ["je n'arrive plus à me connecter", "je ne reçois pas le code de vérification"],
    },
    {
      key: "resiliation", label: "Résiliation", auto_reply: false, route: "Rétention",
      what: "Le client veut arrêter : résilier, se désabonner, supprimer son compte, ne pas renouveler.",
      not_for: "Une question sur les conditions de résiliation sans intention de partir (c'est une question produit).",
      examples: ["je veux résilier mon abonnement", "supprimez mon compte", "comment annuler le renouvellement ?"],
    },
    {
      key: "avant_vente", label: "Avant-vente", auto_reply: true, route: "Commercial",
      what: "Un prospect qui envisage d'acheter : devis, démo, offre entreprise, volume, partenariat.",
      not_for: "Un client existant qui change d'offre (c'est de la facturation).",
      examples: ["je voudrais une démo pour mon équipe de 40 personnes", "vous faites des tarifs pour les associations ?"],
    },
    {
      key: "reclamation", label: "Réclamation", auto_reply: false, route: "Support",
      what: "Un mécontentement exprimé sur le service reçu : plainte, insatisfaction, menace d'avis négatif ou de recours.",
      not_for: "Un problème technique décrit calmement (c'est un bug).",
      examples: ["c'est inadmissible, trois semaines sans réponse", "je vais laisser un avis sur Trustpilot"],
    },
  ],
  sla_hours: { urgent: 1, high: 4, normal: 24, low: 72 },
  handoff_message:
    "Je transmets votre demande à l'équipe, qui reviendra vers vous. Si vous le souhaitez, laissez-moi votre adresse e-mail pour être recontacté.",
};

/** La config d'un agent, complétée par les valeurs par défaut. Une config
 *  partielle ou abîmée ne doit jamais désactiver le tri. */
export function normalizeSupportConfig(raw: unknown): SupportConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<SupportConfig>;
  const intents = Array.isArray(r.intents)
    ? r.intents.filter((i): i is IntentDef => !!i && typeof i.key === "string" && !!i.key && typeof i.label === "string")
    : [];
  const sla = (r.sla_hours ?? {}) as Partial<SupportConfig["sla_hours"]>;
  const hours = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    intents: intents.length ? intents.slice(0, 40) : DEFAULT_SUPPORT_CONFIG.intents,
    sla_hours: {
      urgent: hours(sla.urgent, DEFAULT_SUPPORT_CONFIG.sla_hours.urgent),
      high: hours(sla.high, DEFAULT_SUPPORT_CONFIG.sla_hours.high),
      normal: hours(sla.normal, DEFAULT_SUPPORT_CONFIG.sla_hours.normal),
      low: hours(sla.low, DEFAULT_SUPPORT_CONFIG.sla_hours.low),
    },
    handoff_message: typeof r.handoff_message === "string" && r.handoff_message.trim()
      ? r.handoff_message.trim()
      : DEFAULT_SUPPORT_CONFIG.handoff_message,
  };
}

// ── Le tri ───────────────────────────────────────────────────────────────────

export type Priority = "low" | "normal" | "high" | "urgent";
export const PRIORITY_BY_URGENCY: Priority[] = ["low", "normal", "high", "urgent"];

export interface Triage {
  intent: IntentDef;
  intentConfidence: number;
  urgency: 0 | 1 | 2 | 3;
  priority: Priority;
  needsHumanP: number;
  /** Décision COMBINÉE en code (voir l'en-tête). */
  autoEligible: boolean;
  /** Pourquoi la demande n'est pas éligible — lisible dans la file. */
  handoffReason: string | null;
  applied: boolean;
  mode: "shadow" | "on";
}

// Quatre SITUATIONS, pas quatre degrés : c'est ce que la doc Jev demande pour
// qu'un barème soit comparable.
const URGENCY_LEVELS = [
  {
    summary: "Simple information : le client se renseigne, rien n'est en jeu pour lui aujourd'hui.",
    signals: ["question générale", "curiosité, comparaison, avant achat", "aucun problème en cours"],
  },
  {
    summary: "Gêne : quelque chose ne va pas, mais le client peut attendre ou contourner.",
    signals: ["retard modéré", "fonction secondaire en panne", "« quand vous pourrez »"],
  },
  {
    summary: "Bloquant : le client ne peut plus utiliser le service, ou de l'argent est en jeu maintenant.",
    signals: ["paiement refusé ou prélevé deux fois", "impossible de se connecter ou de travailler", "échéance proche, commande urgente"],
  },
  {
    summary: "Critique : perte de données, faille de sécurité, menace juridique ou client prêt à partir en colère.",
    signals: ["données supprimées", "compte piraté", "avocat, plainte, litige", "« c'est inadmissible », « je résilie »"],
  },
];

const PLAYBOOK_DEFAULT = "";

/**
 * Trier un message. `null` = rien n'a tourné (usage éteint, clé absente, API
 * en panne) : l'appelant garde exactement son comportement d'avant.
 */
export async function triageMessage(
  ctx: { admin: Admin; workspaceId: string; projectId?: string | null },
  config: SupportConfig,
  message: string,
  history: Array<{ role: string; content: string }>,
  coverage: number | null,
): Promise<Triage | null> {
  const byKey = new Map<string, IntentDef>();
  const criteria: Record<string, Criterion> = {};
  for (const intent of config.intents) {
    const key = qid(intent.key);
    byKey.set(key, intent);
    criteria[key] = {
      what: intent.what || intent.label,
      ...(intent.not_for ? { not_for: intent.not_for } : {}),
      ...(intent.examples?.length ? { examples: intent.examples.slice(0, 6) } : {}),
    };
  }
  if (byKey.size < 2) return null;

  const verdict = await judge(
    { admin: ctx.admin, workspaceId: ctx.workspaceId, projectId: ctx.projectId ?? null },
    "support_triage",
    {
      message: message.slice(0, 1500),
      ...(history.length
        ? { conversation: history.slice(-6).map((m) => `${m.role === "user" ? "Client" : "Agent"} : ${m.content.slice(0, 300)}`).join("\n") }
        : {}),
    },
    {
      intention: choice("Que demande le client dans son dernier message ?", criteria),
      urgence: score("Quelle est la situation du client ?", URGENCY_LEVELS),
      // Haut = oui = il faut une personne.
      humain_requis: noul(
        "Traiter cette demande exige-t-il une décision ou une action qu'une personne de l'entreprise doit prendre ?",
        {
          true: {
            what: "Il faut accorder quelque chose (remboursement, geste, dérogation), trancher un litige, modifier ou supprimer un compte, ou constater un incident sur ses données. Une réponse d'information ne règle pas la demande.",
            examples: ["remboursez-moi", "annulez ma commande qui est déjà partie", "supprimez mes données", "mes factures ont disparu de mon espace"],
          },
          false: {
            what: "Une réponse, une explication ou une procédure que le client applique lui-même suffit à régler la demande.",
            examples: ["comment changer mon mot de passe ?", "quels sont les délais de livraison ?", "où télécharger ma facture ?"],
          },
        },
      ),
    },
    { subject: message.slice(0, 120) },
  );
  if (!verdict) return null;

  const picked = readChoice(verdict, "intention");
  const intent = (picked && byKey.get(picked.choice)) || null;
  const urg = readScore(verdict, "urgence")?.score;
  const needsHumanP = readNoul(verdict, "humain_requis");
  if (!intent || urg == null || needsHumanP == null) return null;

  const urgency = Math.min(3, Math.max(0, Math.round(urg))) as 0 | 1 | 2 | 3;
  const needsHuman = needsHumanP >= verdict.threshold;
  // Une intention reconnue en hésitant ne doit pas autoriser une réponse seule :
  // sous 0,5 de confiance, on la traite comme non autorisée en auto.
  const unsureIntent = (picked?.confidence ?? 0) < 0.5;
  const thinDocs = coverage != null && coverage < 2;

  const reasons: string[] = [];
  if (!intent.auto_reply) reasons.push(`« ${intent.label} » est traité par l'équipe`);
  if (needsHuman) reasons.push("une décision humaine est nécessaire");
  if (urgency === 3) reasons.push("situation critique");
  if (unsureIntent) reasons.push("intention incertaine");
  if (thinDocs) reasons.push("documentation insuffisante");

  return {
    intent,
    intentConfidence: picked?.confidence ?? 0,
    urgency,
    priority: PRIORITY_BY_URGENCY[urgency],
    needsHumanP,
    autoEligible: reasons.length === 0,
    handoffReason: reasons.length ? reasons.join(", ") : null,
    applied: verdict.apply,
    mode: verdict.mode === "on" ? "on" : "shadow",
  };
}

/** Ce que le tri ajoute au prompt — rien en shadow. */
export function triagePrompt(t: Triage | null, config: SupportConfig): string {
  if (!t?.applied) return "";
  const lines = [`Detected request type: ${t.intent.label} (priority: ${t.priority}).`];
  if (t.intent.playbook?.trim()) lines.push(`How to handle this type of request: ${t.intent.playbook.trim()}`);
  if (!t.autoEligible) {
    lines.push(
      "This request must be handled by a person from the team. Answer only what the documentation supports, " +
      "do NOT promise any refund, compensation, deadline or exception, and end your reply with this handoff, " +
      `in the customer's language: "${config.handoff_message}"`,
    );
  }
  return lines.join("\n") || PLAYBOOK_DEFAULT;
}

// ── La demande ───────────────────────────────────────────────────────────────

export type TicketStatus = "auto" | "open" | "in_progress" | "closed";

/**
 * Crée ou met à jour la demande d'une conversation.
 *
 * Une conversation = une demande. L'urgence ne REDESCEND jamais au fil des
 * tours (un client qui a signalé une perte de données puis dit « merci » n'est
 * pas redevenu une simple information), et une demande passée à un humain ne
 * redevient pas automatique. Le statut n'est jamais réécrit une fois qu'une
 * personne l'a pris en main (in_progress / closed).
 */
export async function recordTicket(
  admin: Admin,
  agent: { id: string; workspace_id: string; project_id: string | null },
  conversationId: string,
  t: Triage,
  message: string,
  config: SupportConfig,
  /** widget (vrai visiteur) ou playground (test) — la file masque les tests par défaut. */
  source: string,
): Promise<void> {
  try {
    const { data: prev } = await admin.from("resolve_tickets")
      .select("id, urgency, status, sla_due_at, turn_count, needs_human")
      .eq("conversation_id", conversationId).maybeSingle();
    const p = prev as {
      id: string; urgency: number; status: TicketStatus; sla_due_at: string | null;
      turn_count: number; needs_human: boolean;
    } | null;

    const urgency = Math.max(p?.urgency ?? 0, t.urgency) as 0 | 1 | 2 | 3;
    const priority = PRIORITY_BY_URGENCY[urgency];
    const handedOff = !t.autoEligible || !!p?.needs_human;
    // Une demande prise en main garde son statut. Une demande CLOSE reste close,
    // sauf si le client revient avec quelque chose qui demande une personne :
    // elle se rouvre plutôt que d'attendre dans une file que personne ne lit.
    const status: TicketStatus =
      p?.status === "in_progress" ? "in_progress"
      : p?.status === "closed" ? (!t.autoEligible ? "open" : "closed")
      : handedOff ? "open" : "auto";
    // L'échéance part du moment où la demande a été confiée à l'équipe, et
    // se resserre si la priorité monte — jamais l'inverse.
    const reopened = p?.status === "closed" && status === "open";
    // Une demande rouverte repart avec une échéance neuve : l'ancienne a été
    // tenue ou non, elle ne concerne plus ce nouveau message.
    let slaDue = reopened ? null : p?.sla_due_at ?? null;
    if (status === "open") {
      const due = new Date(Date.now() + config.sla_hours[priority] * 3600_000).toISOString();
      if (!slaDue || due < slaDue) slaDue = due;
    }

    const row = {
      workspace_id: agent.workspace_id,
      project_id: agent.project_id,
      agent_id: agent.id,
      conversation_id: conversationId,
      intent: t.intent.key,
      intent_label: t.intent.label,
      intent_confidence: Number(t.intentConfidence.toFixed(3)),
      urgency,
      priority,
      route: t.intent.route ?? null,
      needs_human: handedOff,
      handoff_reason: t.handoffReason,
      status,
      sla_due_at: slaDue,
      mode: t.mode,
      source,
      last_message: message.slice(0, 1000),
      turn_count: (p?.turn_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
      ...(reopened ? { closed_at: null } : {}),
    };
    if (p) {
      await admin.from("resolve_tickets").update(row).eq("id", p.id);
    } else {
      await admin.from("resolve_tickets").insert({ ...row, first_message: message.slice(0, 1000) });
    }
  } catch { /* la file ne doit jamais coûter sa réponse au visiteur */ }
}

// ── Lecture pour les agents internes (outil support_desk) ────────────────────

export interface DeskScope { admin: Admin; workspaceId: string; projectId: string }

export async function listTickets(s: DeskScope, f: {
  status?: string; priority?: string; intent?: string; agent_id?: string;
  overdue?: boolean; since_days?: number; limit?: number; include_tests?: boolean;
}): Promise<unknown[]> {
  let q = s.admin.from("resolve_tickets")
    .select("id, agent_id, conversation_id, intent_label, priority, urgency, route, status, needs_human, handoff_reason, sla_due_at, first_message, last_message, turn_count, assignee, created_at, updated_at")
    .eq("project_id", s.projectId)
    .gte("created_at", new Date(Date.now() - (f.since_days ?? 30) * 86400_000).toISOString())
    .order("updated_at", { ascending: false })
    .limit(Math.min(Math.max(f.limit ?? 25, 1), 100));
  if (!f.include_tests) q = q.eq("source", "widget");
  if (f.status) q = q.eq("status", f.status);
  if (f.priority) q = q.eq("priority", f.priority);
  if (f.intent) q = q.eq("intent", f.intent);
  if (f.agent_id) q = q.eq("agent_id", f.agent_id);
  if (f.overdue) q = q.eq("status", "open").lt("sla_due_at", new Date().toISOString());
  const { data } = await q;
  return data ?? [];
}

export async function getTicket(s: DeskScope, id: string): Promise<unknown> {
  const { data: t } = await s.admin.from("resolve_tickets").select("*")
    .eq("id", id).eq("project_id", s.projectId).maybeSingle();
  if (!t) return null;
  const { data: msgs } = await s.admin.from("rag_messages")
    .select("role, content, created_at")
    .eq("conversation_id", (t as { conversation_id: string }).conversation_id)
    .order("created_at", { ascending: true }).limit(60);
  return { ...(t as Record<string, unknown>), transcript: msgs ?? [] };
}

export async function updateTicket(s: DeskScope, id: string, patch: {
  status?: string; note?: string; assignee?: string; priority?: string;
}, author: string): Promise<string> {
  const { data: t } = await s.admin.from("resolve_tickets").select("id, notes")
    .eq("id", id).eq("project_id", s.projectId).maybeSingle();
  if (!t) return "ERROR: ticket not found in this project.";
  const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status) {
    if (!["open", "in_progress", "closed"].includes(patch.status)) return "ERROR: status must be open, in_progress or closed.";
    upd.status = patch.status;
    if (patch.status === "closed") upd.closed_at = new Date().toISOString();
  }
  if (patch.priority) {
    if (!PRIORITY_BY_URGENCY.includes(patch.priority as Priority)) return "ERROR: priority must be low, normal, high or urgent.";
    upd.priority = patch.priority;
  }
  if (patch.assignee !== undefined) upd.assignee = patch.assignee.slice(0, 120) || null;
  if (patch.note?.trim()) {
    const notes = Array.isArray((t as { notes?: unknown }).notes) ? (t as { notes: unknown[] }).notes : [];
    upd.notes = [...notes, { at: new Date().toISOString(), by: author, text: patch.note.trim().slice(0, 2000) }].slice(-50);
  }
  const { error } = await s.admin.from("resolve_tickets").update(upd).eq("id", id);
  return error ? `ERROR: ${error.message}` : "OK";
}

/** Les chiffres d'une période, pour un rapport. Calculés en code sur les
 *  lignes réelles — l'agent rédige, il n'estime rien. */
export async function supportStats(s: DeskScope, sinceDays: number, agentId?: string): Promise<Record<string, unknown>> {
  let q = s.admin.from("resolve_tickets")
    .select("intent_label, priority, status, needs_human, route, sla_due_at, closed_at, created_at")
    .eq("project_id", s.projectId)
    .gte("created_at", new Date(Date.now() - sinceDays * 86400_000).toISOString())
    .eq("source", "widget")
    .limit(5000);
  if (agentId) q = q.eq("agent_id", agentId);
  const { data } = await q;
  const rows = (data ?? []) as Array<{
    intent_label: string; priority: string; status: string; needs_human: boolean; route: string | null;
    sla_due_at: string | null; closed_at: string | null; created_at: string;
  }>;
  const count = (key: (r: typeof rows[number]) => string | null) => {
    const m: Record<string, number> = {};
    for (const r of rows) { const k = key(r) ?? "—"; m[k] = (m[k] ?? 0) + 1; }
    return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
  };
  const now = Date.now();
  const handed = rows.filter((r) => r.needs_human);
  const breached = handed.filter((r) => r.sla_due_at && (
    r.closed_at ? r.closed_at > r.sla_due_at : r.status !== "closed" && Date.parse(r.sla_due_at) < now
  ));
  return {
    period_days: sinceDays,
    total_requests: rows.length,
    handled_by_agent: rows.filter((r) => !r.needs_human).length,
    handed_to_team: handed.length,
    automation_rate: rows.length ? Number((rows.filter((r) => !r.needs_human).length / rows.length).toFixed(3)) : null,
    open_now: rows.filter((r) => r.status === "open").length,
    sla_breaches: breached.length,
    by_intent: count((r) => r.intent_label),
    by_priority: count((r) => r.priority),
    by_route: count((r) => r.needs_human ? r.route : null),
  };
}
