// Les demandes d'autorisation d'un agent, dans Slack et Teams.
//
// Un agent à qui l'on parle dans Slack ou Teams et qui veut ÉCRIRE — passer un
// work item en terminé, créer un cycle — doit demander l'autorisation. Cette
// demande ne s'affichait que dans l'application : dans le fil Slack, rien.
// L'agent attendait une validation que personne ne voyait, puis son exécution
// expirait. C'est ce qui empêchait les agents d'être réellement utilisables
// depuis la messagerie.
//
// La demande est désormais postée DANS LE FIL, avec des boutons.
//
// ── Ce qui se valide depuis le canal, et par qui ───────────────────────────
//
//   · SEULES les écritures du suivi de travail (`tracker_write`) : changer un
//     état, commenter, créer ou planifier un item, ouvrir un cycle. Elles sont
//     réversibles et bornées aux projets où l'agent est autorisé.
//   · Les actions EXTERNES — e-mail, CRM, webhooks, intégrations — restent
//     validées dans FounderOS, par le créateur ou un éditeur de l'agent. Les
//     rendre validables depuis Slack permettrait à n'importe quel membre de
//     l'espace Slack de faire envoyer un e-mail au nom de l'entreprise. Le fil
//     reçoit alors un lien, pas des boutons.
//   · Seul l'AUTEUR DE LA DEMANDE tranche : la dernière personne qui a écrit à
//     l'agent dans ce fil (`external_user_ref`, 0251). Un bouton cliqué par
//     quelqu'un d'autre est refusé.
//
// La preuve d'identité tient au transport : les clics Slack arrivent signés
// (HMAC du secret de signature, vérifié par slack-gateway), ceux de Teams dans
// une activité Bot Framework dont le JWT est vérifié par teams-gateway.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { executeApprovalAction, approvalScopePrefix } from "./approval-exec.ts";
import { teamsSendActivity } from "./teams.ts";
import { isMessagingProvider, sendMessagingApproval, type MessagingProvider } from "./messaging.ts";

type Provider = "slack" | "teams" | MessagingProvider;

const PROVIDER_LABEL: Record<Provider, string> = {
  slack: "Slack", teams: "Teams", telegram: "Telegram", discord: "Discord", whatsapp: "WhatsApp",
};

type Admin = SupabaseClient;

interface Binding {
  conversationId: string;
  channelId: string;
  provider: Provider;
  channelRef: string;
  threadRef: string | null;
  serviceUrl: string | null;
  requester: string | null;
}

async function bindingOf(admin: Admin, conversationId: string): Promise<Binding | null> {
  const { data: convo } = await admin.from("internal_agent_conversations")
    .select("channel_id, external_channel_ref, external_thread_ref, external_user_ref")
    .eq("id", conversationId).maybeSingle();
  const c = convo as {
    channel_id?: string | null; external_channel_ref?: string | null;
    external_thread_ref?: string | null; external_user_ref?: string | null;
  } | null;
  if (!c?.channel_id || !c.external_channel_ref) return null;

  const { data: ch } = await admin.from("internal_agent_channels")
    .select("provider, service_url").eq("id", c.channel_id).maybeSingle();
  const provider = (ch as { provider?: string } | null)?.provider;
  if (provider !== "slack" && provider !== "teams" && !isMessagingProvider(provider)) return null;

  return {
    conversationId,
    channelId: c.channel_id,
    provider: provider as Provider,
    channelRef: c.external_channel_ref,
    threadRef: c.external_thread_ref ?? null,
    serviceUrl: (ch as { service_url?: string | null }).service_url ?? null,
    requester: c.external_user_ref ?? null,
  };
}

/** Ce qu'on valide depuis un canal : les écritures du suivi de travail. */
export function isChannelDecidable(actionKind: string): boolean {
  return actionKind === "tracker_write";
}

/**
 * Poste une demande d'autorisation dans le fil Slack / Teams de la conversation.
 * Sans canal lié, ne fait rien. Toujours « au mieux » : un échec de publication
 * ne doit jamais empêcher la demande d'exister dans l'application.
 */
export async function postApprovalToBoundChannel(
  admin: Admin,
  input: {
    conversationId: string;
    approvalId: string;
    summary: string;
    scopeLabel: string;
    actionKind: string;
  },
): Promise<void> {
  try {
    const b = await bindingOf(admin, input.conversationId);
    if (!b) return;

    const decidable = isChannelDecidable(input.actionKind);
    const appUrl = Deno.env.get("APP_BASE_URL") ?? "";
    const headline = `🔐 J'ai besoin de ton feu vert pour : *${input.summary}*`;
    const note = decidable
      ? (b.requester
        ? "Seule la personne qui m'a fait la demande peut valider."
        : "Valide ou refuse ci-dessous.")
      : `Cette action touche un service externe : elle se valide dans FounderOS${appUrl ? ` — ${appUrl}` : ""}.`;

    // Telegram, Discord, WhatsApp : même demande, même règle, boutons natifs
    // de chaque messagerie (voir messaging.ts).
    if (isMessagingProvider(b.provider)) {
      await sendMessagingApproval(admin, b.channelId, b.channelRef, b.threadRef, {
        approvalId: input.approvalId, summary: input.summary, note, decidable,
      });
      return;
    }

    if (b.provider === "slack") {
      const { data: tok } = await admin.from("internal_agent_channel_tokens")
        .select("access_token").eq("channel_id", b.channelId).maybeSingle();
      const token = (tok as { access_token?: string } | null)?.access_token;
      if (!token) return;

      // La valeur du bouton porte la demande ET son auteur autorisé. Elle est
      // infalsifiable : un message posté par notre bot ne peut pas être modifié
      // par l'utilisateur, et le clic nous revient signé par Slack.
      const val = (d: string) => JSON.stringify({ a: input.approvalId, d, r: b.requester ?? "" });
      const blocks: unknown[] = [
        { type: "section", text: { type: "mrkdwn", text: `${headline}\n_${note}_` } },
      ];
      if (decidable) {
        blocks.push({
          type: "actions",
          block_id: `fos_approval_${input.approvalId}`,
          elements: [
            { type: "button", style: "primary", action_id: "fos_approve",
              text: { type: "plain_text", text: "Autoriser" }, value: val("approve") },
            { type: "button", action_id: "fos_approve_all",
              text: { type: "plain_text", text: `Tout autoriser (${input.scopeLabel})`.slice(0, 75) },
              value: val("approve_all") },
            { type: "button", style: "danger", action_id: "fos_reject",
              text: { type: "plain_text", text: "Refuser" }, value: val("reject") },
          ],
        });
      }
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          channel: b.channelRef,
          thread_ts: b.threadRef || undefined,
          text: `${input.summary} — autorisation demandée`,
          blocks,
        }),
      }).catch(() => {});
      return;
    }

    // Teams : une carte adaptative, dont les boutons renvoient `data` dans
    // l'activité suivante (activity.value), reçue par teams-gateway.
    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        { type: "TextBlock", text: `🔐 Autorisation demandée`, weight: "Bolder", wrap: true },
        { type: "TextBlock", text: input.summary, wrap: true },
        { type: "TextBlock", text: note, isSubtle: true, size: "Small", wrap: true },
      ],
      actions: decidable
        ? [
          { type: "Action.Submit", title: "Autoriser", style: "positive",
            data: { fos_approval: input.approvalId, decision: "approve" } },
          { type: "Action.Submit", title: `Tout autoriser (${input.scopeLabel})`.slice(0, 60),
            data: { fos_approval: input.approvalId, decision: "approve_all" } },
          { type: "Action.Submit", title: "Refuser", style: "destructive",
            data: { fos_approval: input.approvalId, decision: "reject" } },
        ]
        : [],
    };
    await teamsSendActivity(b.serviceUrl, b.channelRef, {
      type: "message",
      attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }],
    });
  } catch { /* au mieux */ }
}

/**
 * Applique une décision sur une demande d'autorisation.
 *
 * UNE implémentation, partagée par l'endpoint de l'application et par les
 * passerelles Slack / Teams : deux copies de cette logique finiraient par
 * diverger, et une demande validée depuis Slack ne s'exécuterait plus tout à
 * fait comme une demande validée dans l'app.
 */
export async function applyApprovalDecision(
  admin: Admin,
  approval: {
    id: string; agent_id: string; run_id: string | null; tool_name: string;
    action_kind: string; payload: Record<string, unknown>;
    workspace_id: string | null; project_id: string | null;
  },
  decision: "approve" | "approve_all" | "reject",
  decidedBy: string | null,
  decidedVia?: string,
): Promise<{ ok: boolean; status: string; detail: string }> {
  const now = new Date().toISOString();

  if (decision === "reject") {
    await admin.from("internal_agent_approvals")
      .update({
        status: "rejected", decided_by: decidedBy, decided_at: now,
        ...(decidedVia ? { result: { decided_via: decidedVia } } : {}),
      })
      .eq("id", approval.id).eq("status", "pending");
    return { ok: true, status: "rejected", detail: "" };
  }

  // Marquée d'abord, exécutée ensuite : le passage à « approved » réclame la
  // ligne, et deux clics simultanés ne l'exécutent pas deux fois.
  const { data: claimed } = await admin.from("internal_agent_approvals")
    .update({ status: "approved", decided_by: decidedBy, decided_at: now })
    .eq("id", approval.id).eq("status", "pending")
    .select("id");
  if (!claimed || (claimed as unknown[]).length === 0) {
    return { ok: false, status: "already_decided", detail: "Cette demande a déjà été traitée." };
  }

  let outcome: { ok: boolean; detail: string };
  try {
    outcome = await executeApprovalAction(approval as never);
  } catch (e) {
    outcome = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  const grantScope = decision === "approve_all"
    ? approvalScopePrefix(approval.action_kind as never, approval.payload ?? {}, approval.tool_name)
    : undefined;

  await admin.from("internal_agent_approvals").update({
    status: outcome.ok ? "executed" : "failed",
    executed_at: new Date().toISOString(),
    result: {
      detail: outcome.detail,
      ...(grantScope ? { grant_scope: grantScope } : {}),
      ...(decidedVia ? { decided_via: decidedVia } : {}),
    },
    error_message: outcome.ok ? null : outcome.detail.slice(0, 500),
  }).eq("id", approval.id);

  if (approval.run_id) {
    await admin.from("internal_agent_run_events").insert({
      run_id: approval.run_id,
      agent_id: approval.agent_id,
      kind: "tool_result",
      payload: {
        tool: approval.tool_name, ok: outcome.ok,
        approved_by: decidedBy ?? decidedVia ?? null,
        preview: outcome.detail.slice(0, 500),
      },
    }).then(() => {}, () => {});
  }

  return { ok: outcome.ok, status: outcome.ok ? "executed" : "failed", detail: outcome.detail };
}

/**
 * Une décision prise depuis un canal (clic Slack / Teams).
 *
 * Vérifie, dans l'ordre : que la demande existe et attend encore ; qu'elle est
 * validable depuis un canal ; qu'elle appartient bien à une conversation liée à
 * CE fournisseur ; que la personne qui clique est l'auteur de la demande. Puis
 * applique la décision, et — si l'exécution de l'agent a déjà cessé d'attendre —
 * le relance pour qu'il reprenne avec le résultat.
 */
export async function decideApprovalFromChannel(
  admin: Admin,
  input: {
    approvalId: string;
    decision: "approve" | "approve_all" | "reject";
    provider: Provider;
    clickerRef: string;
  },
): Promise<{ ok: boolean; message: string }> {
  const { data: row } = await admin.from("internal_agent_approvals")
    .select("id, agent_id, run_id, conversation_id, workspace_id, project_id, tool_name, action_kind, payload, status")
    .eq("id", input.approvalId).maybeSingle();
  const a = row as {
    id: string; agent_id: string; run_id: string | null; conversation_id: string | null;
    workspace_id: string | null; project_id: string | null; tool_name: string;
    action_kind: string; payload: Record<string, unknown>; status: string;
  } | null;

  if (!a) return { ok: false, message: "Cette demande n'existe plus." };
  if (a.status !== "pending") return { ok: false, message: `Cette demande a déjà été traitée (${a.status}).` };
  if (!isChannelDecidable(a.action_kind)) {
    return { ok: false, message: "Cette action se valide dans FounderOS, pas depuis la messagerie." };
  }
  if (!a.conversation_id) return { ok: false, message: "Demande sans conversation liée." };

  const b = await bindingOf(admin, a.conversation_id);
  if (!b || b.provider !== input.provider) {
    return { ok: false, message: "Cette demande n'appartient pas à ce canal." };
  }
  if (!b.requester || b.requester !== input.clickerRef) {
    return { ok: false, message: "Seule la personne qui a fait la demande à l'agent peut la valider." };
  }

  const result = await applyApprovalDecision(
    admin, a, input.decision, null, `${input.provider}:${input.clickerRef}`,
  );

  // L'agent n'attend sa réponse que deux minutes (awaitInlineApproval). Passé ce
  // délai, son exécution a continué ou s'est terminée : la décision serait alors
  // prise dans le vide. On le relance avec le verdict, pour qu'il reprenne.
  if (a.run_id) {
    const { data: run } = await admin.from("internal_agent_runs")
      .select("status").eq("id", a.run_id).maybeSingle();
    const stillWaiting = (run as { status?: string } | null)?.status === "running";
    if (!stillWaiting) {
      const verdict = input.decision === "reject"
        ? "a REFUSÉ l'action demandée. Ne la refais pas ; adapte-toi ou propose une alternative."
        : result.ok
          ? `a autorisé l'action demandée, qui a été exécutée. Résultat : ${result.detail.slice(0, 1500)}`
          : `a autorisé l'action demandée, mais son exécution a échoué : ${result.detail.slice(0, 800)}`;
      await admin.from("internal_agent_messages").insert({
        conversation_id: a.conversation_id, agent_id: a.agent_id, role: "user",
        content: `[Décision prise dans ${PROVIDER_LABEL[input.provider]}] L'utilisateur ${verdict} Poursuis.`,
      });
      const url = Deno.env.get("SUPABASE_URL");
      const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (url && key) {
        fetch(`${url}/functions/v1/internal-agent-run`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: a.agent_id, mode: "chat", conversation_id: a.conversation_id }),
        }).catch(() => {});
      }
    }
  }

  const message = input.decision === "reject"
    ? "❌ Refusé."
    : result.ok ? "✅ Autorisé et exécuté." : `⚠️ Autorisé, mais l'exécution a échoué : ${result.detail.slice(0, 300)}`;
  return { ok: result.ok || input.decision === "reject", message };
}
