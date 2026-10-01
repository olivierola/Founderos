// AgentPilot — les décisions de pilotage d'un run, en Jev.
//
// Le runtime savait déjà router une room (`agent_choice`), trier les outils et
// les skills, et juger la fin d'un run. Il lui manquait trois décisions, qui
// étaient prises par des heuristiques aveugles :
//
//   model_choice      — faut-il le modèle de RAISONNEMENT pour cette tâche ?
//                       Avant : une regex de mots-clés (« analy », « debug »…)
//                       et la longueur du texte. Une demande courte et dure
//                       partait sur le modèle rapide ; une longue et banale
//                       payait le raisonneur.
//   loop_watch        — l'agent tourne-t-il en rond SOUS DES FORMES DIFFÉRENTES ?
//                       Le garde-fou par signature ne voit que les appels
//                       identiques ; une boucle de reformulations (« tarif X
//                       2024 », « prix X France », « X pricing ») lui échappe.
//   human_escalation  — ce blocage dépend-il d'une chose que SEUL l'humain peut
//                       donner (un accès, un fichier, un choix) ? Si oui, une
//                       replanification de plus ne fait que brûler des tours :
//                       il faut poser la question.
//
// Ce module ne DÉCIDE pas la boucle : il produit des SIGNAUX que `decideNext`
// (agent-loop.ts) lit. Le contrôleur reste une fonction pure — mêmes signaux,
// même décision — et c'est ce qui garde la boucle reproductible.
//
// Même contrat que tout le jugement rapide : chaque usage a son réglage
// off / shadow / on, `null` veut dire « garde le comportement d'avant », et
// chaque décision est journalisée dans `agentpilot_decisions` pour l'écran
// AgentPilot (en shadow aussi : c'est ce qu'on compare avant de basculer).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { judge, noul, readNoul, type JudgeContext } from "./typesafe.ts";

type Admin = SupabaseClient;

export type PilotKind = "model_choice" | "loop_watch" | "human_escalation" | "controller";

export interface PilotContext extends JudgeContext {
  agentId: string;
}

// ── model_choice ─────────────────────────────────────────────────────────────

/**
 * Le modèle de raisonnement se justifie-t-il pour cette tâche ?
 *
 * Rend le tier à utiliser (`heavy` ou `standard`), ou `null` pour garder celui
 * de l'heuristique. Ne descend JAMAIS une tâche que l'heuristique a mise en
 * `light` : ce palier-là décide aussi de la boîte à outils envoyée (classifyRequest),
 * et un « bonjour » n'a pas besoin d'un avis.
 */
export async function judgeModelTier(
  ctx: PilotContext,
  task: string,
  heuristic: "light" | "standard" | "heavy",
  mode: "chat" | "mission",
): Promise<"standard" | "heavy" | null> {
  if (heuristic === "light" || !task.trim()) return null;
  const verdict = await judge(
    ctx, "model_choice",
    { tache: task.slice(0, 3000), mode },
    {
      // Phrasé pour que haut = oui = le raisonneur.
      raisonnement: noul(
        "Bien faire cette tâche exige-t-il de raisonner en plusieurs étapes avant d'agir ?",
        {
          true: {
            what: "Il faut analyser, comparer des options avec leurs compromis, diagnostiquer une cause, concevoir une architecture ou un plan sous contraintes, ou vérifier un raisonnement chiffré. Une erreur de raisonnement rendrait le résultat faux.",
            examples: [
              "pourquoi nos conversions ont chuté depuis mars, et que faire",
              "compare ces trois offres d'hébergement pour notre charge et recommande-en une",
              "le test d'intégration échoue une fois sur deux, trouve la cause",
              "construis le plan de migration de la base sans interruption de service",
            ],
          },
          false: {
            what: "La tâche est claire et s'exécute directement : rédiger, reformuler, chercher une information, mettre en forme, envoyer, créer un objet, répondre à une question factuelle — même si elle est longue.",
            examples: [
              "rédige un mail de relance pour les devis en attente",
              "résume ce document en cinq points",
              "ajoute ces trois contacts au CRM",
              "trouve le site officiel et le numéro de ce fournisseur",
            ],
          },
        },
      ),
    },
    { subject: `${mode} · ${task.slice(0, 80)}` },
  );
  const p = readNoul(verdict, "raisonnement");
  if (p == null) return null;
  const tier = p >= (verdict?.threshold ?? 0.7) ? "heavy" : "standard";
  void recordDecision(ctx, {
    kind: "model_choice", applied: !!verdict?.apply, probability: p,
    decision: tier, detail: { heuristic, mode, changed: tier !== heuristic },
  });
  return verdict?.apply ? tier : null;
}

// ── loop_watch ───────────────────────────────────────────────────────────────

/**
 * L'agent répète-t-il la même tentative sous des formes différentes ?
 *
 * `calls` : les derniers appels d'outils (nom + arguments abrégés), du plus
 * ancien au plus récent. `errors` : les dernières erreurs d'outils. Rend VRAI
 * seulement quand l'usage est `on` et que la probabilité passe le seuil — le
 * résultat alimente le signal `loopDetected` du contrôleur, rien d'autre.
 */
export async function judgeSemanticLoop(
  ctx: PilotContext,
  goal: string,
  calls: string[],
  errors: string[],
): Promise<boolean> {
  if (calls.length < 6) return false;
  const verdict = await judge(
    ctx, "loop_watch",
    {
      objectif: goal.slice(0, 1200),
      derniers_appels: calls.slice(-12).map((c, i) => `${i + 1}. ${c.slice(0, 220)}`).join("\n"),
      ...(errors.length ? { dernieres_erreurs: errors.slice(-4).map((e) => e.slice(0, 200)).join("\n") } : {}),
    },
    {
      tourne_en_rond: noul(
        "Ces derniers appels répètent-ils la même tentative sous des formes différentes, sans rien obtenir de nouveau ?",
        {
          true: {
            what: "Le même but est poursuivi par des appels quasi équivalents : la même recherche reformulée, la même page ou le même fichier relus, la même action retentée avec des paramètres à peine modifiés — sans passer à l'étape suivante.",
            examples: [
              "web_search « tarif Acme 2024 » puis « prix Acme France » puis « Acme pricing plans » puis « Acme tarifs entreprise »",
              "read_file src/app.ts, puis list_files src, puis read_file src/app.ts à nouveau",
              "use_hubspot create_contact échoue, puis la même création avec un champ en moins, puis encore la même",
            ],
          },
          false: {
            what: "Les appels avancent : ils traitent des éléments DIFFÉRENTS d'une liste (autres fichiers, autres contacts, pages suivantes) ou enchaînent des étapes distinctes d'un plan (chercher, puis lire, puis écrire, puis vérifier).",
            examples: [
              "read_url sur cinq sites de concurrents différents",
              "web_search, puis read_url du meilleur résultat, puis report_section",
              "query_table page 1, page 2, page 3",
            ],
          },
        },
      ),
    },
    { subject: `${calls.length} appel(s) récents` },
  );
  const p = readNoul(verdict, "tourne_en_rond");
  if (p == null) return false;
  const loop = p >= (verdict?.threshold ?? 0.75);
  // On ne journalise que les jugements qui disent « boucle » : un « tout va
  // bien » à chaque tick noierait l'écran sans rien apprendre.
  if (loop) {
    void recordDecision(ctx, {
      kind: "loop_watch", applied: !!verdict?.apply, probability: p,
      decision: "boucle sémantique", detail: { calls: calls.slice(-8) },
    });
  }
  return !!verdict?.apply && loop;
}

// ── human_escalation ─────────────────────────────────────────────────────────

/**
 * Le blocage dépend-il d'une chose que seul l'utilisateur peut fournir ?
 *
 * Appelé UNIQUEMENT quand le contrôleur s'apprête à replanifier : c'est le
 * moment où une replanification de plus serait inutile si ce qui manque est
 * hors de portée de l'agent. Rend VRAI seulement en mode `on`.
 */
export async function judgeNeedsHuman(
  ctx: PilotContext,
  goal: string,
  why: string,
  errors: string[],
  lastOutput: string,
): Promise<boolean> {
  const verdict = await judge(
    ctx, "human_escalation",
    {
      objectif: goal.slice(0, 1200),
      blocage: why.slice(0, 300),
      ...(errors.length ? { erreurs: errors.slice(-5).map((e) => e.slice(0, 240)).join("\n") } : {}),
      ...(lastOutput.trim() ? { dernier_message_agent: lastOutput.slice(0, 800) } : {}),
    },
    {
      besoin_humain: noul(
        "Pour avancer, l'agent a-t-il besoin de quelque chose que seul l'utilisateur peut lui donner ?",
        {
          true: {
            what: "Il manque un accès (identifiants, connexion à un outil, permission refusée), un document ou une donnée privée introuvable ailleurs, ou une décision qui appartient à l'utilisateur (choix entre deux directions, validation d'une action engageante). Réessayer autrement ne changera rien.",
            examples: [
              "401 Unauthorized sur l'API du CRM à chaque appel",
              "le fichier « budget 2027 » dont parle la demande n'existe nulle part",
              "deux clients s'appellent Martin : lequel est concerné ?",
              "connecteur Gmail non connecté pour ce projet",
            ],
          },
          false: {
            what: "Le blocage est technique ou de méthode, et l'agent peut s'en sortir seul : mauvais paramètres, source peu fiable, approche à changer, découpage à revoir, page lente ou introuvable qui a des alternatives.",
            examples: [
              "la recherche web ne trouve rien avec ces mots-clés",
              "400 Bad Request : champ « email » mal formé",
              "le rapport tourne en rond sur la même section",
            ],
          },
        },
      ),
    },
    { subject: why.slice(0, 120) },
  );
  const p = readNoul(verdict, "besoin_humain");
  if (p == null) return false;
  const needs = p >= (verdict?.threshold ?? 0.7);
  void recordDecision(ctx, {
    kind: "human_escalation", applied: !!verdict?.apply && needs, probability: p,
    decision: needs ? "question à l'utilisateur" : "replanification", detail: { why },
  });
  return !!verdict?.apply && needs;
}

// ── Le journal ───────────────────────────────────────────────────────────────

/** Une décision de pilotage. `controller` trace aussi les décisions du
 *  contrôleur déterministe (replan, finalisation forcée, arrêt) — sans elles,
 *  l'écran ne verrait que les jugements Jev, pas les boucles réellement
 *  cassées. */
export async function recordDecision(ctx: PilotContext, row: {
  kind: PilotKind;
  applied: boolean;
  decision: string;
  probability?: number | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await (ctx.admin as Admin).from("agentpilot_decisions").insert({
      workspace_id: ctx.workspaceId,
      project_id: ctx.projectId ?? null,
      agent_id: ctx.agentId,
      run_id: ctx.runId ?? null,
      kind: row.kind,
      decision: row.decision.slice(0, 200),
      applied: row.applied,
      probability: row.probability ?? null,
      detail: row.detail ?? {},
    });
  } catch { /* le journal ne doit jamais faire échouer un run */ }
}
