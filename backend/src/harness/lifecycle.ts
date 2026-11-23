// Le cycle de vie d'un run sur le harnais : ce qui se passe quand l'exécution
// OpenCode s'arrête (bridge.ts → settle), et quand l'agent pose une question.
//
// Repris de la fin de runMissionTick (ancien moteur), dans le même ordre :
//
//   succès   1. contrat de succès (agent-loop.ts) et preuves des actions annoncées :
//               s'il manque quelque chose, la session est relancée (deux fois au plus)
//            2. garde du rapport : la personne a demandé un rapport et aucun livrable
//               n'existe → une relance, puis un livrable de repli
//            3. brouillon de rapport sauvé (report_section sans finalisation)
//            4. initiatives (reflectAndPropose) en pied de réponse
//            5. la fin propre au run : conversation (et canaux), salle, mission
//               (livrable de repli, Rédacteur, kanban, planning, retour A2A,
//               canal), workflow, message d'un collègue
//            6. le graphe de connaissances, en tâche de fond ; le tour suivant
//               d'une personne qui a écrit pendant le run
//   échec    run failed, message dans la conversation ou la salle, mission remise
//            « à faire », workflow et tâche de salle clos en échec, incident
//   annulé   run cancelled, tâche de salle et workflow clos
//   question run « awaiting_input » avec la question et ses options, dans la
//            conversation (et son canal) ; la réponse de la personne remplit le
//            formulaire et le MÊME run reprend (chat.ts)
//
// Un agent embarqué dont le contenu reste sur son instance (sync_level summary
// ou metadata) passe `content: false` : ni contrat relu sur sa réponse, ni
// initiatives, ni graphe de connaissances ; les fins de run s'appliquent.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "../edge/_shared/supabase-admin.ts";
import { logLlmUsage } from "../edge/_shared/llm-tracking.ts";
import { checkQuota, checkRunBudget } from "../edge/_shared/metering.ts";
import {
  evaluateContract, findUnbackedClaims, unbackedClaimGap, type SuccessContract, type ToolTrailEntry,
} from "../edge/_shared/agent-loop.ts";
import { reflectAndPropose, proposalsFooter } from "../edge/_shared/proactivity.ts";
import { captureKnowledgeInBackground } from "../edge/_shared/knowledge-graph.ts";
import { completeMissionTask } from "../edge/_shared/room-orchestrator.ts";
import { completeWorkflowRun } from "../edge/_shared/workflow-engine.ts";
import { recordRunIncident } from "../edge/_shared/governance-incidents.ts";
import { startDeferredTurn } from "../edge/_shared/turn-principal.ts";
import { loadAgentAndTools, type AgentRow } from "../agents/context.ts";
import {
  closeRoomMessage, completeRunTodos, finalizeChatSuccess, finalizeMissionSuccess, finalizeRoomSuccess,
  postReplyToBoundChannel, salvageReportDraft, verifyMissionOutcome,
} from "../agents/finalize.ts";
import { MISSION_COLUMNS, type MissionRow } from "../agents/mission.ts";
import type { BoundRun } from "./store.ts";
import type { RunOutcome, RunQuestion, TrailEntry } from "./bridge.ts";
import { legacyNameFor } from "./toolkit/catalogue.ts";
import { dropResearch, persistFindings } from "./research.ts";

type Admin = SupabaseClient;

/** Ce qu'il faut au cycle de vie pour relancer une session. */
export interface LifecycleDeps {
  /** Envoie un message à la session du run (relance après un contrat non tenu…). */
  prompt(sessionId: string, text: string): Promise<void>;
  /** La raison d'un arrêt décidé par le contrôleur de boucle : le run finit en échec. */
  abortReason?(runId: string): string | null;
  /** Le run est clos : le contrôleur oublie son état. */
  forget?(runId: string): void;
  log?: (message: string) => void;
}

/** Le résultat d'un run terminé, gardé un moment pour qui l'attend (runAndWait). */
const results = new Map<string, { status: RunOutcome["status"]; text: string }>();
export const runResult = (runId: string) => results.get(runId) ?? null;
const remember = (runId: string, status: RunOutcome["status"], text: string) => {
  results.set(runId, { status, text });
  while (results.size > 200) results.delete(results.keys().next().value as string);
};

const REPORT_ASKED = /\b(rapport|report|livrable|deliverable|compte[- ]rendu|document (écrit|pdf|word))\b/i;

interface Meta {
  kind?: string;
  task?: string;
  contract?: SuccessContract | null;
  verify_fails?: number;
  report_guard?: boolean;
  mission_id?: string | null;
  room?: { room_id: string; placeholder_id: string; requested_by?: string | null } | null;
  mission_task?: { mission_id: string; task_id: string } | null;
  workflow_run?: { id: string } | null;
  a2a?: { message_id: string } | null;
}

const metaOf = (run: BoundRun) => (run.meta ?? {}) as Meta;

async function saveMeta(admin: Admin, run: BoundRun, patch: Partial<Meta>) {
  const next = { ...(run.meta ?? {}), ...patch };
  run.meta = next;
  // Fusionné avec ce que les outils y ont écrit entre-temps (report_draft…).
  const { data } = await admin.from("internal_agent_runs").select("run_meta").eq("id", run.runId).maybeSingle();
  const current = ((data as { run_meta?: Record<string, unknown> } | null)?.run_meta ?? {}) as Record<string, unknown>;
  await admin.from("internal_agent_runs").update({ run_meta: { ...current, ...patch } }).eq("id", run.runId);
}

const event = (admin: Admin, run: BoundRun, kind: string, payload: Record<string, unknown>) =>
  admin.from("internal_agent_run_events").insert({ run_id: run.runId, agent_id: run.agentId, kind, payload }).then(() => {}, () => {});

/** Les appels du run, avec le nom de l'ancien outil, pour les contrôles écrits pour lui. */
function legacyTrail(trail: TrailEntry[]): ToolTrailEntry[] {
  return trail.map((t) => ({
    name: legacyNameFor(t.name, t.args),
    args: JSON.stringify(t.args ?? {}).slice(0, 600),
    ok: t.ok,
    result: t.result.slice(0, 600),
  }));
}

/** La tâche de salle et le workflow que sert ce run, clos avec son issue. */
async function reportBindings(admin: Admin, meta: Meta, ok: boolean, output: string) {
  if (meta.mission_task?.task_id && meta.mission_task.mission_id) {
    await completeMissionTask(admin as never, { missionId: meta.mission_task.mission_id, taskId: meta.mission_task.task_id, ok, output }).catch(() => {});
  }
  if (meta.workflow_run?.id) {
    await completeWorkflowRun(admin as never, { workflowRunId: meta.workflow_run.id, ok, error: ok ? undefined : output }).catch(() => {});
  }
}

async function loadMission(admin: Admin, missionId: string | null | undefined): Promise<MissionRow | null> {
  if (!missionId) return null;
  const { data } = await admin.from("internal_agent_missions").select(MISSION_COLUMNS).eq("id", missionId).maybeSingle();
  return (data as MissionRow | null) ?? null;
}

async function deliverableCount(admin: Admin, runId: string): Promise<number> {
  return (await admin.from("internal_agent_deliverables").select("id", { count: "exact", head: true }).eq("run_id", runId)).count ?? 0;
}

export function createLifecycle(deps: LifecycleDeps) {
  const log = deps.log ?? ((m: string) => console.warn(`[harness] ${m}`));

  /** Le contrat, les preuves, la garde du rapport : « continue » si la session a été relancée. */
  async function checks(admin: Admin, run: BoundRun, agent: AgentRow, outcome: RunOutcome, mission: MissionRow | null): Promise<"continue" | null> {
    const meta = metaOf(run);
    const fails = meta.verify_fails ?? 0;
    if (fails < 2) {
      let gaps: string[] = [];
      let hints: string[] = [];
      let passed: number | null = null;
      if (meta.contract) {
        const verdict = await evaluateContract({
          admin: admin as never, runId: run.runId, contract: meta.contract, finalOutput: outcome.text,
          workspaceId: agent.workspace_id, projectId: agent.project_id,
        }).catch(() => null);
        if (verdict) {
          gaps = verdict.gaps; hints = verdict.soft;
          if (verdict.pass) passed = verdict.results.filter((r) => !r.skipped).length;
        }
      } else if (mission) {
        const legacy = await verifyMissionOutcome(admin as never, run.runId, mission as never, outcome.text).catch(() => null);
        if (legacy && !legacy.pass) gaps = [legacy.feedback || "Les critères d'acceptation ne sont pas tous satisfaits."];
      }
      // Les actions que la réponse ANNONCE doivent être prouvées par un appel réussi.
      const unbacked = findUnbackedClaims(outcome.text, legacyTrail(outcome.trail));
      if (unbacked.length) {
        gaps = [...gaps, ...unbacked.map(unbackedClaimGap)];
        await event(admin, run, "status", {
          message: `Preuve manquante : la réponse annonce ${unbacked.map((u) => u.label).join(", ")} sans appel d'outil réussi qui le prouve. Reprise.`,
          unbacked_claims: unbacked.map((u) => ({ family: u.family, quote: u.quote })),
        });
      }
      if (gaps.length) {
        await event(admin, run, "status", { message: `Vérification du contrat : ÉCHEC, ${gaps[0].slice(0, 180)}. Reprise du travail.` });
        await event(admin, run, "loop", { phase: "verify", pass: false, gaps });
        await saveMeta(admin, run, { verify_fails: fails + 1 });
        await deps.prompt(run.sessionId, [
          "VÉRIFICATION ÉCHOUÉE : le travail n'est PAS terminé. Ces contrôles ne passent pas :",
          ...gaps.map((g) => `- ${g}`),
          ...(hints.length ? ["", "À corriger au passage :", ...hints.map((h) => `- ${h}`)] : []),
          "",
          "Corrige exactement ces manques (crée les livrables qui manquent, corrige les faux, termine les étapes ouvertes), puis donne de nouveau ta réponse finale. Ne refais rien de ce qui est passé.",
        ].join("\n"));
        return "continue";
      }
      if (passed !== null) {
        await event(admin, run, "status", { message: `Vérification du contrat : OK (${passed} contrôle${passed > 1 ? "s" : ""} passé${passed > 1 ? "s" : ""}).` });
      }
    }

    // La personne a demandé un rapport dans CE tour et aucun livrable n'existe.
    if ((run.kind ?? "chat") === "chat" && run.conversationId && !meta.report_guard) {
      const { data: lastAsk } = await admin.from("internal_agent_messages").select("content")
        .eq("conversation_id", run.conversationId).eq("role", "user")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const asked = REPORT_ASKED.test(String((lastAsk as { content?: string } | null)?.content ?? ""));
      if (asked && (await deliverableCount(admin, run.runId)) === 0) {
        await saveMeta(admin, run, { report_guard: true });
        await deps.prompt(run.sessionId,
          "La personne a EXPLICITEMENT demandé un rapport ou un livrable et AUCUN n'a été produit. Ne pose pas de question : tu as les informations. " +
          "Confie MAINTENANT toute la matière rassemblée au rédacteur (outil report, action request : sujet, matière avec les chiffres et leurs sources, constats, incertitudes), puis termine par deux phrases de résumé.");
        return "continue";
      }
    }
    return null;
  }

  /** Le livrable de repli quand la garde du rapport a déjà relancé sans succès. */
  async function reportFallback(admin: Admin, run: BoundRun, agent: AgentRow, text: string) {
    if (!metaOf(run).report_guard || (await deliverableCount(admin, run.runId)) > 0) return;
    const body = text.trim() || "Rapport généré automatiquement : voir le détail des étapes ci-dessus.";
    await admin.from("internal_agent_deliverables").insert({
      run_id: run.runId, mission_id: null, conversation_id: run.conversationId, agent_id: agent.id,
      kind: "markdown", name: "Rapport", content: body, summary: body.replace(/[#*`>_\n]+/g, " ").trim().slice(0, 200) || null,
    }).then(() => {}, () => {});
    await event(admin, run, "status", { message: "Livrable matérialisé automatiquement (l'agent avait fini sans l'enregistrer)." });
  }

  async function succeed(admin: Admin, run: BoundRun, agent: AgentRow, outcome: RunOutcome, content: boolean): Promise<"done" | "continue"> {
    const meta = metaOf(run);
    const kind = run.kind ?? "chat";
    const mission = kind === "mission" ? await loadMission(admin, meta.mission_id) : null;
    if (content && await checks(admin, run, agent, outcome, mission) === "continue") return "continue";

    let final = outcome.text;
    await reportFallback(admin, run, agent, final);
    await salvageReportDraft(admin as never, agent, run.runId, { mission_id: meta.mission_id ?? null, conversation_id: run.conversationId });

    // Initiatives : seulement un run qui a vraiment travaillé, jamais une tâche de salle.
    if (content && outcome.toolCalls >= 3 && !meta.mission_task && kind !== "a2a" && final.trim().length > 120) {
      const proposals = await reflectAndPropose(admin as never, {
        agentId: agent.id, workspaceId: agent.workspace_id ?? null, projectId: agent.project_id ?? null,
        goal: meta.contract?.goal || meta.task || "",
        output: final,
        actions: [...new Set(outcome.trail.map((t) => legacyNameFor(t.name, t.args)))],
      }).catch(() => []);
      if (proposals.length) {
        final += proposalsFooter(proposals);
        await event(admin, run, "status", { message: `💡 ${proposals.length} initiative(s) déposée(s) dans le backlog : ${proposals.map((p) => p.title).join(" · ")}.` });
      }
    }

    const stats = {
      tokIn: outcome.tokensIn, tokOut: outcome.tokensOut, cost: outcome.costUsd, actions: outcome.toolCalls,
      provider: outcome.model.provider || "opencode", model: outcome.model.id || "unknown",
    };
    if (kind === "mission") {
      if (!final.trim()) final = "Mission terminée : voir le détail des étapes et des livrables.";
      await finalizeMissionSuccess(admin as never, agent, run.runId, (mission ?? { id: meta.mission_id ?? "" }) as never, final, stats);
    } else {
      if (!final.trim()) {
        const { data: dv } = await admin.from("internal_agent_deliverables").select("name, summary")
          .eq("run_id", run.runId).order("created_at", { ascending: false }).limit(1).maybeSingle();
        const d = dv as { name?: string; summary?: string } | null;
        final = d ? `✅ **${d.name ?? "Livrable"}** créé : voir la carte ci-dessus.${d.summary ? `\n\n${d.summary}` : ""}` : "Terminé : voir le détail des étapes ci-dessus.";
      }
      if (meta.room) {
        await finalizeRoomSuccess(admin as never, agent, meta.room, run.runId, final, stats);
      } else if (run.conversationId) {
        await finalizeChatSuccess(admin as never, agent, run.conversationId, run.runId, final, stats);
      } else {
        // Workflow, message d'un collègue : pas de conversation, le résultat reste sur le run.
        await completeRunTodos(admin as never, run.runId);
        await admin.from("internal_agent_runs").update({
          status: "succeeded", finished_at: new Date().toISOString(), final_output: final.slice(0, 12000), live_output: null,
          tokens_in: stats.tokIn, tokens_out: stats.tokOut, cost_usd: stats.cost, action_count: stats.actions, steps: stats.actions,
        }).eq("id", run.runId);
        await logLlmUsage({
          workspace_id: agent.workspace_id, project_id: agent.project_id, provider: stats.provider, model: stats.model,
          task: "chat_simple", feature: kind === "a2a" ? "internal-agent-a2a" : "internal-agent-workflow", billable: false,
          usage: { prompt_tokens: stats.tokIn, completion_tokens: stats.tokOut, total_tokens: stats.tokIn + stats.tokOut },
          metadata: { run_id: run.runId, agent_id: agent.id, mode: kind },
        }).catch(() => {});
      }
      await reportBindings(admin, meta, true, final);
    }
    remember(run.runId, "succeeded", final);
    // Ce que le run a trouvé en cherchant devient une mémoire pour la prochaine fois.
    await persistFindings(run.runId).catch(() => {});
    if (content) captureKnowledgeInBackground(admin as never, {
      workspaceId: agent.workspace_id, projectId: agent.project_id, agentId: agent.id, runId: run.runId,
      text: final, context: kind === "mission" ? `Mission : ${mission?.title ?? ""}` : String(meta.task ?? "").slice(0, 1500),
    });
    // Une personne a écrit pendant ce tour sans le piloter : son tour commence.
    if (run.conversationId) await startDeferredTurn(admin as never, run.runId).catch(() => false);
    return "done";
  }

  async function fail(admin: Admin, run: BoundRun, agent: AgentRow | null, outcome: RunOutcome) {
    const meta = metaOf(run);
    const message = outcome.text || "échec de l'exécution";
    await event(admin, run, "error", { error: message });
    if (agent) await salvageReportDraft(admin as never, agent, run.runId, { mission_id: meta.mission_id ?? null, conversation_id: run.conversationId });
    await admin.from("internal_agent_runs").update({
      status: "failed", finished_at: new Date().toISOString(), error_message: message.slice(0, 500), live_output: null,
      tokens_in: outcome.tokensIn, tokens_out: outcome.tokensOut, cost_usd: outcome.costUsd, action_count: outcome.toolCalls,
    }).eq("id", run.runId);
    if (meta.room && agent) {
      await closeRoomMessage(admin as never, agent, meta.room, run.runId, `⚠️ ${message}`, "failed").catch(() => {});
    } else if (run.conversationId) {
      const text = `⚠️ Le run a échoué : ${message}`;
      await admin.from("internal_agent_messages").insert({
        conversation_id: run.conversationId, agent_id: run.agentId, role: "assistant", content: text, run_id: run.runId,
        tokens_in: outcome.tokensIn, tokens_out: outcome.tokensOut, cost_usd: outcome.costUsd,
      }).then(() => {}, () => {});
      await admin.from("internal_agent_conversations").update({ updated_at: new Date().toISOString() }).eq("id", run.conversationId).then(() => {}, () => {});
      if (agent) await postReplyToBoundChannel(admin as never, agent, run.conversationId, text).catch(() => {});
    }
    if (meta.mission_id) {
      await admin.from("internal_agent_missions").update({ board_column: "todo" }).eq("id", meta.mission_id).eq("board_column", "in_progress").then(() => {}, () => {});
    }
    await reportBindings(admin, meta, false, message);
    if (agent) {
      await recordRunIncident(admin as never, agent, run.runId, {
        title: "Échec d'exécution du run", description: message.slice(0, 1500), category: "other", severity: "medium",
      }).catch(() => {});
    }
    remember(run.runId, "failed", message);
    dropResearch(run.runId);
  }

  async function cancel(admin: Admin, run: BoundRun, agent: AgentRow | null) {
    const meta = metaOf(run);
    await admin.from("internal_agent_runs").update({ status: "cancelled", finished_at: new Date().toISOString(), live_output: null }).eq("id", run.runId);
    if (meta.room && agent) await closeRoomMessage(admin as never, agent, meta.room, run.runId, "Run annulé.", "failed").catch(() => {});
    if (meta.mission_id) {
      await admin.from("internal_agent_missions").update({ board_column: "todo" }).eq("id", meta.mission_id).eq("board_column", "in_progress").then(() => {}, () => {});
    }
    await reportBindings(admin, meta, false, "Run annulé.");
    remember(run.runId, "cancelled", "Run annulé.");
    dropResearch(run.runId);
  }

  return {
    async settle(run: BoundRun, outcome: RunOutcome, opts: { content?: boolean } = {}): Promise<"done" | "continue"> {
      const admin = createServiceClient() as unknown as Admin;
      const agent = await loadAgentAndTools(run.agentId).then((r) => r.agent).catch(() => null);
      if (outcome.status === "succeeded") {
        if (!agent) {
          await fail(admin, run, null, { ...outcome, status: "failed", text: "agent introuvable ou archivé à la fin du run" });
          return "done";
        }
        try {
          const next = await succeed(admin, run, agent, outcome, opts.content !== false);
          if (next === "done") deps.forget?.(run.runId);
          return next;
        } catch (e) {
          log(`fin du run ${run.runId} : ${e instanceof Error ? e.message : String(e)}`);
          await fail(admin, run, agent, { ...outcome, status: "failed", text: `fin de run impossible : ${e instanceof Error ? e.message : String(e)}` });
          return "done";
        }
      }
      const aborted = outcome.status === "cancelled" ? deps.abortReason?.(run.runId) ?? null : null;
      if (outcome.status === "failed" || aborted) await fail(admin, run, agent, aborted ? { ...outcome, status: "failed", text: aborted } : outcome);
      else await cancel(admin, run, agent);
      deps.forget?.(run.runId);
      return "done";
    },

    /** L'agent pose une question : le run attend la personne, dans la conversation et son canal. */
    async question(run: BoundRun, q: RunQuestion): Promise<void> {
      const admin = createServiceClient() as unknown as Admin;
      const first = q.fields[0];
      const question = [q.title, first?.title, first?.description].filter((x) => x && String(x).trim()).join("\n") || "J'ai besoin d'une précision pour continuer.";
      const options = (first?.options ?? []).filter(Boolean).slice(0, 6);
      await admin.from("internal_agent_runs").update({
        status: "awaiting_input", live_output: null,
        final_output: [question, ...options.map((o) => `- ${o}`)].join("\n").slice(0, 2000),
        pending_question: { question, options, form_id: q.formId, session_id: q.sessionId, fields: q.fields },
      }).eq("id", run.runId);
      await event(admin, run, "question", { question, options });
      const meta = metaOf(run);
      const agent = await loadAgentAndTools(run.agentId).then((r) => r.agent).catch(() => null);
      if (run.conversationId) {
        await admin.from("internal_agent_messages").insert({
          conversation_id: run.conversationId, agent_id: run.agentId, role: "assistant", content: question, run_id: run.runId,
          ui_blocks: options.length ? [{ component: "options", props: { question, options } }] : null,
        }).then(() => {}, () => {});
        await admin.from("internal_agent_conversations").update({ updated_at: new Date().toISOString() }).eq("id", run.conversationId).then(() => {}, () => {});
        if (agent) await postReplyToBoundChannel(admin as never, agent, run.conversationId, [question, ...options.map((o) => `• ${o}`)].join("\n")).catch(() => {});
      } else if (meta.room && agent) {
        await closeRoomMessage(admin as never, agent, meta.room, run.runId, question, "done").catch(() => {});
      }
    },

    /** Le plafond de dépense du run et les crédits de l'espace, après chaque étape. */
    async overBudget(run: BoundRun): Promise<string | null> {
      const budget = await checkRunBudget(run.runId).catch(() => null);
      if (budget?.exceeded) {
        return `Plafond de l'offre atteint pour cette exécution (${Math.round(budget.credits)} crédits, maximum ${budget.cap}). Relancez en découpant la mission, ou passez à une offre supérieure.`;
      }
      const credits = await checkQuota(run.workspaceId, "credits").catch(() => null);
      if (credits && !credits.allowed) return credits.reason ?? "Crédits IA épuisés pour cette période.";
      return null;
    },
  };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;
