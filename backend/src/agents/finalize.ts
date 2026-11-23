// La fin d'un run : réponse dans la conversation, salle ou mission, livrables de
// repli, rapport du Rédacteur, mémoire, kanban, retour A2A, canaux (Slack,
// Teams, messageries), apprentissage. Sorti de l'ancien moteur
// (internal-agent-run) ; appelé par le cycle de vie des runs du harnais.

import { Deno, FUNCTIONS_URL } from "../compat/index.ts";
import { createServiceClient } from "../edge/_shared/supabase-admin.ts";
import { callAi, safeParseJson, truncateMiddle } from "../edge/_shared/ai.ts";
import { writeReport } from "../edge/_shared/reporter.ts";
import { cheapModel, cheapProvider } from "../edge/_shared/model-router.ts";
import { logLlmUsage } from "../edge/_shared/llm-tracking.ts";
import { writeAgentMemory } from "../edge/_shared/internal-agent-tools.ts";
import { teamsSendMessage } from "../edge/_shared/teams.ts";
import { isMessagingProvider, sendMessagingText } from "../edge/_shared/messaging.ts";
import { describeOutcome, feedbackCue, learnFromFeedback } from "../edge/_shared/agent-learning.ts";
import { nextRunAt } from "./context.ts";
import type { AgentRow } from "./context.ts";

/**
 * The latest user message, read as feedback on the assistant message just
 * before it. The outcome lands in the timeline of the run now answering, so
 * the user sees the lesson next to the reply.
 */
export async function learnFromChatMessage(
  admin: ReturnType<typeof createServiceClient>,
  agentId: string,
  conversationId: string,
  currentRunId: string | null,
): Promise<void> {
  const { data } = await admin.from("internal_agent_messages")
    .select("id, role, content, run_id")
    .eq("conversation_id", conversationId).in("role", ["user", "assistant"])
    .order("created_at", { ascending: false }).limit(2);
  const [last, prev] = (data ?? []) as Array<{ id: string; role: string; content: string | null; run_id: string | null }>;
  if (!last || last.role !== "user" || !prev || prev.role !== "assistant") return;
  if (!feedbackCue(last.content ?? "")) return;

  const { data: conv } = await admin.from("internal_agent_conversations")
    .select("user_id").eq("id", conversationId).maybeSingle();
  const outcome = await learnFromFeedback(admin, {
    agentId, source: "chat", sourceMessageId: last.id,
    feedback: last.content ?? "", agentOutput: prev.content ?? "", agentRunId: prev.run_id,
    conversationId, userId: (conv as { user_id: string | null } | null)?.user_id ?? null,
  });
  const line = describeOutcome(outcome);
  if (line && currentRunId) {
    await admin.from("internal_agent_run_events")
      .insert({ run_id: currentRunId, agent_id: agentId, kind: "status", payload: { message: line, learning_id: outcome?.id } })
      .then(() => {}, () => {});
  }
}

// Finalize a successful (or budget-exhausted) mission: deliverable safety net,
// run → succeeded, kanban → review, scheduling, delegation report-back, usage.
// Deterministic, best-effort memory write — so the agent's memory populates
// from real lifecycle events instead of only when the model remembers to call
// save_memory. `dedupePrefix` replaces any prior memory with that prefix so a
// recurring mission keeps ONE up-to-date entry instead of piling up.
export async function autoSaveMemory(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  runId: string | null,
  opts: { kind: "fact" | "preference" | "learning" | "context"; content: string; importance?: number; dedupePrefix?: string },
) {
  const content = opts.content.replace(/\s+/g, " ").trim().slice(0, 600);
  if (!content) return;
  try {
    if (opts.dedupePrefix) {
      const esc = opts.dedupePrefix.replace(/[%_]/g, (m) => `\\${m}`);
      await admin.from("internal_agent_memories").delete().eq("agent_id", agent.id).ilike("content", `${esc}%`);
    }
    // Dedup (a recurring lesson merges into itself) and eviction at the cap
    // are handled by the shared writer.
    await writeAgentMemory(admin, {
      agent_id: agent.id, workspace_id: agent.workspace_id, project_id: agent.project_id,
      kind: opts.kind, content, importance: opts.importance ?? 3, source_run_id: runId,
    });
  } catch { /* best-effort: never block finalization on memory */ }
}

/** A mission that was ASKED for something written. Routing every mission to the
 *  Rédacteur would bill an authoring pass to hourly syncs and health checks —
 *  which produce a line of output, not a document. */
export const WRITTEN_OUTPUT_RE =
  /\b(rapport|report|analyse|analyser|audit|synth[eè]se|bilan|compte[- ]rendu|d[ée]brief|veille|[ée]tude|note d'analyse|restitution|livrable|executive summary)\b/i;

/** The matter a mission actually gathered: what its tools returned, plus its
 *  closing text. Le Rédacteur has no tools of its own — this is everything it
 *  will ever know about the mission, so it is assembled generously and cut in
 *  the middle rather than at the end (a run carries its findings at both ends).
 */
export async function gatherRunMaterial(
  admin: ReturnType<typeof createServiceClient>,
  runId: string,
  finalOutput: string,
): Promise<string> {
  const parts: string[] = [];
  const { data: evts } = await admin
    .from("internal_agent_run_events")
    .select("kind, payload")
    .eq("run_id", runId)
    .in("kind", ["tool_result", "log"])
    .order("created_at", { ascending: true })
    .limit(400);
  for (const e of (evts ?? []) as Array<{ kind: string; payload: Record<string, unknown> | null }>) {
    const p = (e.payload ?? {}) as { tool?: string; preview?: string; message?: string; ok?: boolean };
    if (p.ok === false) continue; // a failed call is not matter
    const body = String(p.preview ?? p.message ?? "").trim();
    if (body.length < 40) continue;
    parts.push(`### ${p.tool ?? "note"}\n${body}`);
  }
  const gathered = parts.join("\n\n");
  const closing = finalOutput.trim();
  return [
    closing ? `## Ce que l'agent a conclu\n${closing}` : "",
    gathered ? `## Ce que ses outils ont rendu\n${truncateMiddle(gathered, 24_000)}` : "",
  ].filter(Boolean).join("\n\n");
}

export async function finalizeMissionSuccess(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  runId: string,
  mission: { id: string; title?: string; schedule?: string | null; report_back_to_agent?: string | null },
  finalOutput: string,
  stats: { tokIn: number; tokOut: number; cost: number; actions: number; provider: string; model: string; custom?: boolean },
) {
  // Counted over the MISSION, not this run: a mission re-ticks and resumes, and
  // a per-run count hands a second copy to every continuation.
  const { count } = await admin
    .from("internal_agent_deliverables")
    .select("id", { count: "exact", head: true })
    .eq("mission_id", mission.id);
  const { data: m } = await admin.from("internal_agent_missions")
    .select("description, expected_deliverables, delegation_depth, delegated_by_agent")
    .eq("id", mission.id).maybeSingle();
  const mm = (m ?? {}) as {
    description?: string; expected_deliverables?: unknown;
    delegation_depth?: number; delegated_by_agent?: string | null;
  };
  // A DELEGATED mission is a sub-task. It closes by reporting back to the agent
  // that delegated it, and that agent writes the one report at the end. Left to
  // finish like a top-level mission, a five-task mission produced five documents
  // and none of them was the one anyone asked for.
  const isSubTask = (mm.delegation_depth ?? 0) > 0 || !!mm.delegated_by_agent;

  if (!count && !isSubTask) {
    // A mission that owed a document and finished without one: hand what it
    // gathered to the Rédacteur rather than dumping the closing text into a
    // markdown row nobody opens. Only when a document was actually expected —
    // and never at the cost of the mission's own outcome, so any failure falls
    // back to the row that has always been written here.
    const expected = JSON.stringify(mm.expected_deliverables ?? "");
    const wanted = [mission.title ?? "", mm.description ?? "", expected].join(" ");
    let written = false;
    if (WRITTEN_OUTPUT_RE.test(wanted) && finalOutput.trim().length > 200) {
      const material = await gatherRunMaterial(admin, runId, finalOutput);
      const res = await writeReport({
        admin,
        workspaceId: agent.workspace_id,
        projectId: agent.project_id,
        parentRunId: runId,
        missionId: mission.id,
        requesterAgentId: agent.id,
        requesterName: agent.name,
        createdBy: agent.created_by ?? null,
        parentLogEvent: async (kind, payload) => {
          await admin.from("internal_agent_run_events")
            .insert({ run_id: runId, agent_id: agent.id, kind, payload }).then(() => {}, () => {});
        },
      }, {
        subject: mission.title ?? "Bilan de mission",
        material,
        angle: mm.description || undefined,
      }).catch(() => ({ ok: false } as { ok: boolean }));
      written = res.ok === true;
    }
    if (!written) {
      await admin.from("internal_agent_deliverables").insert({
        run_id: runId, mission_id: mission.id, agent_id: agent.id, kind: "markdown",
        name: "Mission output", content: finalOutput,
        summary: finalOutput.replace(/[#*`>_\n]+/g, " ").trim().slice(0, 200) || null,
      });
    }
  }
  await admin.from("internal_agent_runs").update({
    status: "succeeded", finished_at: new Date().toISOString(), final_output: finalOutput,
    tokens_in: stats.tokIn, tokens_out: stats.tokOut, cost_usd: stats.cost,
    action_count: stats.actions, steps: stats.actions,
  }).eq("id", runId);
  await completeRunTodos(admin, runId);

  const missionUpdate: Record<string, unknown> = { last_run_at: new Date().toISOString() };
  if (mission.schedule) missionUpdate.next_run_at = nextRunAt(mission.schedule, new Date());
  await admin.from("internal_agent_missions").update(missionUpdate).eq("id", mission.id);
  await admin.from("internal_agent_missions").update({ board_column: "review" }).eq("id", mission.id).eq("board_column", "in_progress");

  // Consign the mission outcome to the agent's persistent memory so future
  // sessions know what was done, what it produced, and the key conclusion.
  try {
    const title = mission.title ?? "mission";
    const { data: delivs } = await admin
      .from("internal_agent_deliverables").select("name").eq("run_id", runId).limit(8);
    const delivList = (delivs ?? []).map((d: any) => d.name).filter(Boolean).join(", ");
    const summary = finalOutput.replace(/[#*`>_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    await autoSaveMemory(admin, agent, runId, {
      kind: "context",
      importance: 4,
      dedupePrefix: `Mission "${title}"`,
      content: `Mission "${title}" — completed ${new Date().toISOString().slice(0, 10)}.${summary ? ` Result: ${summary}` : ""}${delivList ? ` · Deliverables: ${delivList}.` : ""}`,
    });
  } catch { /* best-effort */ }

  if (mission.report_back_to_agent) {
    try {
      const [a, b] = [agent.id, mission.report_back_to_agent as string].sort();
      let threadId: string;
      const { data: existing } = await admin.from("internal_agent_a2a_threads").select("id").eq("agent_a", a).eq("agent_b", b).maybeSingle();
      if (existing) threadId = (existing as { id: string }).id;
      else {
        const { data: created } = await admin.from("internal_agent_a2a_threads")
          .insert({ workspace_id: agent.workspace_id, project_id: agent.project_id, agent_a: a, agent_b: b, topic: `Re: ${mission.title}` })
          .select("id").single();
        threadId = (created as { id: string }).id;
      }
      const { data: rb } = await admin.from("internal_agent_a2a_messages").insert({
        thread_id: threadId, workspace_id: agent.workspace_id, project_id: agent.project_id,
        from_agent: agent.id, to_agent: mission.report_back_to_agent,
        content: `Delegated mission "${mission.title}" complete. Report:\n\n${finalOutput.slice(0, 3500)}`,
      }).select("id").single();
      if (rb) {
        const base = Deno.env.get("SUPABASE_URL"); const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (base && key) {
          fetch(`${FUNCTIONS_URL}/functions/v1/internal-agent-a2a`, {
            method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ message_id: (rb as { id: string }).id }),
          }).catch(() => {});
        }
      }
    } catch { /* best-effort */ }
  }

  await logLlmUsage({
    workspace_id: agent.workspace_id, project_id: agent.project_id,
    provider: stats.provider, model: stats.model,
    task: "content_generation", feature: "internal-agent-mission",
    custom: stats.custom,
    // Ligne de SYNTHÈSE du run : la dépense a déjà été facturée tick par tick
    // (voir la télémétrie par tour). On la garde pour le monitoring, pas pour
    // la facturation — sinon chaque run serait débité deux fois.
    billable: false,
    usage: { prompt_tokens: stats.tokIn, completion_tokens: stats.tokOut, total_tokens: stats.tokIn + stats.tokOut },
    metadata: { run_id: runId, agent_id: agent.id, mode: "mission", custom: !!stats.custom },
  });
  // If the mission was created from a channel (e.g. a Slack "mission: …"), post
  // the completion report back into that thread.
  await postMissionReportToChannel(admin, mission.id, finalOutput);
}

// Post a mission's completion report to its bound channel (Slack thread).
export async function postMissionReportToChannel(
  admin: ReturnType<typeof createServiceClient>,
  missionId: string,
  report: string,
) {
  try {
    const { data: m } = await admin
      .from("internal_agent_missions")
      .select("title, channel_id, external_channel_ref, external_thread_ref")
      .eq("id", missionId).maybeSingle();
    if (!m?.channel_id || !m.external_channel_ref) return;
    const { data: ch } = await admin
      .from("internal_agent_channels").select("provider, service_url").eq("id", m.channel_id).maybeSingle();
    const body = report.replace(/[#*`>_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 2500);

    if (ch?.provider === "teams") {
      await teamsSendMessage(ch.service_url, m.external_channel_ref,
        `✅ Mission **${m.title}** terminée.\n\n${body}\n\n_(Livrables complets dans l'onglet Deliverables.)_`);
      return;
    }
    // Sans cette branche, un rapport de mission lancée depuis Telegram, Discord
    // ou WhatsApp serait parti vers l'API Slack — et perdu en silence.
    if (isMessagingProvider(ch?.provider)) {
      await sendMessagingText(admin, m.channel_id, m.external_channel_ref, m.external_thread_ref ?? null,
        `✅ Mission « ${m.title} » terminée.\n\n${body}\n\n(Livrables complets dans FounderOS.)`);
      return;
    }
    // Slack
    const { data: tok } = await admin
      .from("internal_agent_channel_tokens").select("access_token").eq("channel_id", m.channel_id).maybeSingle();
    if (!tok?.access_token) return;
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        channel: m.external_channel_ref,
        thread_ts: m.external_thread_ref || undefined,
        text: `✅ Mission *${m.title}* terminée.\n\n${body}\n\n_(Livrables complets dans l'onglet Deliverables.)_`,
      }),
    }).catch(() => {});
  } catch { /* best-effort */ }
}

// Post an agent reply back to whatever channel the conversation is bound to: an
// external Slack thread and/or an in-app project-inbox channel. Best-effort — a
// channel failure must never block finalization.
export async function postReplyToBoundChannel(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  conversationId: string,
  text: string,
) {
  try {
    const { data: convo } = await admin
      .from("internal_agent_conversations")
      .select("channel_id, external_channel_ref, external_thread_ref, inbox_channel_id, workspace_id, project_id")
      .eq("id", conversationId).maybeSingle();
    if (!convo) return;

    // In-app project-inbox mirror (repairs the async-chat regression).
    if (convo.inbox_channel_id) {
      await admin.from("project_messages").insert({
        workspace_id: convo.workspace_id, project_id: convo.project_id,
        channel_id: convo.inbox_channel_id, author_kind: "agent", agent_id: agent.id,
        body: text.slice(0, 12000),
      }).then(() => {}, () => {});
    }

    // External channel (Slack thread / Teams conversation).
    if (convo.channel_id && convo.external_channel_ref) {
      const { data: ch } = await admin
        .from("internal_agent_channels").select("provider, service_url").eq("id", convo.channel_id).maybeSingle();
      if (ch?.provider === "teams") {
        await teamsSendMessage(ch.service_url, convo.external_channel_ref, text.slice(0, 12000));
      } else if (isMessagingProvider(ch?.provider)) {
        // Telegram, Discord, WhatsApp (messaging-gateway).
        await sendMessagingText(admin, convo.channel_id, convo.external_channel_ref, convo.external_thread_ref ?? null, text);
      } else if (ch?.provider === "slack") {
        const { data: tok } = await admin
          .from("internal_agent_channel_tokens").select("access_token").eq("channel_id", convo.channel_id).maybeSingle();
        if (tok?.access_token) {
          await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({
              channel: convo.external_channel_ref,
              thread_ts: convo.external_thread_ref || undefined,
              text: text.slice(0, 3500),
            }),
          }).catch(() => {});
        }
      }
    }
  } catch { /* best-effort */ }
}

// Mark the run's todo checklist complete on a successful finish (blocked items
// keep their status — they tell the story of what didn't work).
export async function completeRunTodos(
  admin: ReturnType<typeof createServiceClient>,
  runId: string,
) {
  try {
    const { data: r } = await admin.from("internal_agent_runs").select("todos").eq("id", runId).maybeSingle();
    const todos = Array.isArray(r?.todos) ? (r!.todos as Array<Record<string, unknown>>) : [];
    if (!todos.length) return;
    const done = todos.map((t) => ({ ...t, status: t.status === "blocked" ? "blocked" : "done" }));
    await admin.from("internal_agent_runs").update({ todos: done }).eq("id", runId);
  } catch { /* best-effort */ }
}

// Finalize a chat run: post the assistant reply, mark the run succeeded and
// bump the conversation. The chat equivalent of finalizeMissionSuccess.
/** UI blocks the agent attached during the run (render_ui → 'ui' events). */
export async function collectUiBlocks(
  admin: ReturnType<typeof createServiceClient>,
  runId: string,
): Promise<Array<Record<string, unknown>> | null> {
  try {
    const { data } = await admin
      .from("internal_agent_run_events")
      .select("payload")
      .eq("run_id", runId).eq("kind", "ui")
      // Deliverables now emit a block too, so a productive run legitimately has
      // more than a handful; a cap of 8 silently swallowed the later cards.
      .order("created_at", { ascending: true }).limit(24);
    const blocks = (data ?? [])
      .map((e: { payload?: { block?: Record<string, unknown> } }) => e.payload?.block)
      .filter((b): b is Record<string, unknown> => !!b && typeof b === "object");
    return blocks.length ? blocks : null;
  } catch {
    return null;
  }
}

export async function finalizeChatSuccess(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  conversationId: string,
  runId: string,
  finalOutput: string,
  stats: { tokIn: number; tokOut: number; cost: number; actions: number; provider: string; model: string; custom?: boolean },
) {
  const reply = finalOutput?.trim() || "(no reply)";
  const uiBlocks = (await collectUiBlocks(admin, runId)) ?? [];
  // Attach any deliverables produced this run as openable cards ON the message —
  // guarantees the card renders inline (not dependent on a separate client query
  // that can miss on timing). Covers ctx.createDeliverable + materialize + salvage.
  const { data: delivs } = await admin
    .from("internal_agent_deliverables").select("id, name, kind")
    .eq("run_id", runId).order("created_at", { ascending: true });
  const deliverableBlocks = (delivs ?? []).map((d) => ({
    component: "deliverable",
    props: { id: (d as { id: string }).id, name: (d as { name: string }).name, kind: (d as { kind: string }).kind, agentId: agent.id },
  }));
  const allBlocks = [...uiBlocks, ...deliverableBlocks];
  await admin.from("internal_agent_messages").insert({
    conversation_id: conversationId, agent_id: agent.id, role: "assistant",
    content: reply, run_id: runId, ui_blocks: allBlocks.length ? allBlocks : null,
    tokens_in: stats.tokIn, tokens_out: stats.tokOut, cost_usd: stats.cost,
  });
  await completeRunTodos(admin, runId);
  await admin.from("internal_agent_runs").update({
    status: "succeeded", finished_at: new Date().toISOString(), final_output: finalOutput?.slice(0, 2000),
    tokens_in: stats.tokIn, tokens_out: stats.tokOut, cost_usd: stats.cost,
    action_count: stats.actions, steps: stats.actions,
  }).eq("id", runId);
  await admin.from("internal_agent_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  // Mirror the reply to any bound channel (Slack thread / project inbox) —
  // channels can't render UI blocks, so strip the [[ui:N]] placement tags.
  await postReplyToBoundChannel(admin, agent, conversationId, reply.replace(/\n?\[\[ui:\d+\]\]\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
  await logLlmUsage({
    workspace_id: agent.workspace_id, project_id: agent.project_id,
    provider: stats.provider, model: stats.model, task: "chat_simple", feature: "internal-agent-chat",
    custom: stats.custom,
    billable: false, // synthèse du run — déjà facturé par tick
    usage: { prompt_tokens: stats.tokIn, completion_tokens: stats.tokOut, total_tokens: stats.tokIn + stats.tokOut },
    metadata: { run_id: runId, agent_id: agent.id, mode: "chat", custom: !!stats.custom },
  });
}

/**
 * Persist a report the agent built section-by-section but never finalised.
 *
 * `report_section` accumulates into run_state.meta.report_draft, and only
 * `create_deliverable(kind="report")` turns it into a row. A run that stops
 * before that call — budget exhausted, approval gate, context overflow, or a
 * worker killed and later reaped (which DELETES the state row) — used to throw
 * the whole report away: the human then sees an agent claiming a report that
 * exists nowhere. Called from every terminal path, idempotent by the count
 * check below.
 */
export async function salvageReportDraft(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  runId: string,
  state: { mission_id: string | null; conversation_id: string | null },
): Promise<boolean> {
  try {
    const { data: fs } = await admin.from("internal_agent_runs").select("run_meta").eq("id", runId).maybeSingle();
    const draft = ((fs as { run_meta?: { report_draft?: { title?: string; subtitle?: string; author?: string; summary?: string; sections?: unknown[] } } } | null)?.run_meta?.report_draft) ?? null;
    if (!draft || !Array.isArray(draft.sections) || draft.sections.length === 0) return false;
    const { count } = await admin.from("internal_agent_deliverables")
      .select("id", { count: "exact", head: true }).eq("run_id", runId).eq("kind", "report");
    if ((count ?? 0) > 0) return false;
    const content = JSON.stringify({
      title: draft.title || "Rapport", subtitle: draft.subtitle, author: draft.author,
      summary: draft.summary, sections: draft.sections,
    });
    await admin.from("internal_agent_deliverables").insert({
      run_id: runId, mission_id: state.mission_id ?? null, conversation_id: state.conversation_id,
      agent_id: agent.id, kind: "report", name: draft.title || "Rapport",
      content, summary: (draft.summary || draft.title || "Rapport").slice(0, 200),
    }).then(() => {}, () => {});
    await admin.from("internal_agent_run_events").insert({
      run_id: runId, agent_id: agent.id, kind: "status",
      payload: { message: `Rapport « ${draft.title || "Rapport"} » sauvegardé depuis les ${draft.sections.length} sections construites (le run s'est arrêté avant de le finaliser).` },
    }).then(() => {}, () => {});
    return true;
  } catch {
    return false; // best-effort salvage
  }
}

/** Every card this run produced: UI blocks it emitted, plus its deliverables,
 *  de-duplicated (createDeliverable now emits its own block, and a run from
 *  before that change has only the row). */
export async function runCards(
  admin: ReturnType<typeof createServiceClient>,
  runId: string,
  agentId: string,
): Promise<Array<Record<string, unknown>>> {
  const uiBlocks = (await collectUiBlocks(admin, runId)) ?? [];
  const seen = new Set(
    uiBlocks
      .filter((b) => b.component === "deliverable")
      .map((b) => String((b.props as { id?: string } | undefined)?.id ?? "")),
  );
  const { data: delivs } = await admin
    .from("internal_agent_deliverables").select("id, name, kind")
    .eq("run_id", runId).order("created_at", { ascending: true });
  const deliverableBlocks = (delivs ?? [])
    .filter((d) => !seen.has((d as { id: string }).id))
    .map((d) => ({
      component: "deliverable",
      props: { id: (d as { id: string }).id, name: (d as { name: string }).name, kind: (d as { kind: string }).kind, agentId },
    }));
  return [...uiBlocks, ...deliverableBlocks];
}

/**
 * Close a room turn that did NOT end in success — an approval gate, a question,
 * an exhausted budget, an unreachable sandbox.
 *
 * These paths used to write plain text over the placeholder, discarding the
 * cards for work the agent had genuinely finished before it stopped. Stopping
 * early is not the same as producing nothing, and the room has to show the
 * difference.
 */
export async function closeRoomMessage(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  room: { room_id: string; placeholder_id: string },
  runId: string,
  content: string,
  status: "done" | "failed",
) {
  const blocks = await runCards(admin, runId, agent.id);
  await admin.from("service_room_messages").update({
    content, status, run_id: runId, ui_blocks: blocks.length ? blocks : null,
  }).eq("id", room.placeholder_id);
  await admin.from("service_rooms").update({ updated_at: new Date().toISOString() }).eq("id", room.room_id);
}

// Finalize a ROOM-bound run on the durable tick engine: update the room
// placeholder message (content + UI blocks + deliverable cards produced) so the
// room reply materialises exactly like a chat reply — but survives the edge
// wall-clock because it ran on the tick queue. The room equivalent of
// finalizeChatSuccess.
export async function finalizeRoomSuccess(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  room: { room_id: string; placeholder_id: string },
  runId: string,
  finalOutput: string,
  stats: { tokIn: number; tokOut: number; cost: number; actions: number; provider: string; model: string; custom?: boolean },
) {
  const reply = (finalOutput?.trim() || "Terminé — voir les cartes ci-dessus.")
    .replace(/\n?\[\[ui:\d+\]\]\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const allBlocks = await runCards(admin, runId, agent.id);
  await admin.from("service_room_messages").update({
    content: reply, ui_blocks: allBlocks.length ? allBlocks : null, status: "done", run_id: runId,
  }).eq("id", room.placeholder_id);
  await completeRunTodos(admin, runId);
  await admin.from("internal_agent_runs").update({
    status: "succeeded", finished_at: new Date().toISOString(), final_output: finalOutput?.slice(0, 2000),
    tokens_in: stats.tokIn, tokens_out: stats.tokOut, cost_usd: stats.cost, action_count: stats.actions, steps: stats.actions,
  }).eq("id", runId);
  await admin.from("service_rooms").update({ updated_at: new Date().toISOString() }).eq("id", room.room_id);
  await logLlmUsage({
    workspace_id: agent.workspace_id, project_id: agent.project_id,
    provider: stats.provider, model: stats.model, task: "chat_simple", feature: "internal-agent-room",
    custom: stats.custom,
    billable: false, // synthèse du run — déjà facturé par tick
    usage: { prompt_tokens: stats.tokIn, completion_tokens: stats.tokOut, total_tokens: stats.tokIn + stats.tokOut },
    metadata: { run_id: runId, agent_id: agent.id, mode: "room", custom: !!stats.custom },
  });
}

// ── Mission self-verification ─────────────────────────────────────────────────
// Before finalizing a mission, have a fast reviewer check the outcome against
// the brief/acceptance criteria and the deliverables actually produced. A FAIL
// feeds concrete gaps back into the loop instead of shipping a partial result.
export async function verifyMissionOutcome(
  admin: ReturnType<typeof createServiceClient>,
  runId: string,
  mission: { title?: string; brief?: string | null; acceptance_criteria?: string | null } | null,
  finalOutput: string,
): Promise<{ pass: boolean; feedback: string } | null> {
  if (!mission?.brief && !mission?.acceptance_criteria) return null; // nothing to check against
  const { data: delivs } = await admin
    .from("internal_agent_deliverables").select("kind, name, content, file_url")
    .eq("run_id", runId).limit(12);
  const delivList = (delivs ?? [])
    .map((d: any) => `- [${d.kind}] ${d.name} — ${d.content ? `${String(d.content).length} chars` : d.file_url ? d.file_url : "empty"}`)
    .join("\n") || "(no deliverables produced)";
  const res = await callAi({
    task: "classification",
    // Cheap side-call: Groq when it is keyed, otherwise whatever is — this used
    // to be hard-coded and silently disabled mission verification on a
    // DeepSeek-only deployment.
    provider: cheapProvider(), model: cheapModel(),
    jsonMode: true,
    maxTokens: 500,
    systemPrompt:
      'You are a strict QA reviewer for an autonomous agent\'s mission. Decide if the mission is genuinely COMPLETE. PASS only if the final report answers the brief AND every acceptance criterion is satisfied AND the expected deliverables exist (non-empty). Reply as JSON: {"verdict":"pass"|"fail","missing":"short concrete list of what is missing or wrong"}.',
    userPrompt: `MISSION: ${mission.title ?? ""}\n\nBRIEF:\n${(mission.brief ?? "").slice(0, 2000)}\n\nACCEPTANCE CRITERIA:\n${(mission.acceptance_criteria ?? "(none stated)").slice(0, 1200)}\n\nDELIVERABLES PRODUCED:\n${delivList}\n\nFINAL REPORT:\n${finalOutput.slice(0, 3500)}`,
  });
  const j = safeParseJson<{ verdict?: string; missing?: string }>(res.content);
  if (!j?.verdict) return null;
  return { pass: j.verdict.toLowerCase() === "pass", feedback: String(j.missing ?? "").slice(0, 800) };
}
