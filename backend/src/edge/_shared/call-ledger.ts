// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/call-ledger.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// Le registre des appels à effet d'un run (0299) : la reprise exacte après un
// worker tué, d'après eve (vercel/eve, « Resuming after a crash »).
//
// Le moteur de tick sauvegarde le transcrit après chaque tour. Restait le tour
// EN COURS : un envoi d'e-mail parti, puis le worker tué avant la sauvegarde,
// et la relivraison du tick rappelait le modèle sans la moindre trace de
// l'envoi. Il le refaisait.
//
// Désormais :
//   1. le transcrit est sauvegardé dès que le modèle demande un appel à effet,
//      avant l'exécution (onBeforeTools, ai.ts) ;
//   2. chaque appel à effet est noté « started » ici avant de partir, puis
//      « done » avec son résultat ;
//   3. à la reprise, un appel resté sans résultat dans le transcrit reçoit le
//      résultat enregistré s'il a abouti, sinon un avertissement daté : il a
//      démarré, son effet est inconnu, vérifier avant de relancer.
//
// Sans la table (migration non appliquée), tout échoue en silence et le
// moteur se comporte comme avant : MISSING_TOOL_RESULT pour un appel perdu.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  repairToolPairing, truncateMiddle, TOOL_RESULT_CAP, type CallLedger, type ChatMessage,
} from "./ai.ts";

const TABLE = "internal_agent_call_ledger";

export interface LedgerRow {
  call_id: string;
  tool: string;
  status: "started" | "done";
  result: string | null;
  started_at: string;
}

/** Le registre d'un run, branché sur runToolRounds. */
export function createCallLedger(admin: SupabaseClient, runId: string): CallLedger {
  return {
    async started(call) {
      await admin.from(TABLE).upsert({
        run_id: runId, call_id: call.id, tool: call.name, status: "started",
        result: null, started_at: new Date().toISOString(), settled_at: null,
      }, { onConflict: "run_id,call_id" }).then(() => {}, () => {});
    },
    async settled(call, result) {
      await admin.from(TABLE).update({
        status: "done", result: truncateMiddle(result, TOOL_RESULT_CAP), settled_at: new Date().toISOString(),
      }).eq("run_id", runId).eq("call_id", call.id).then(() => {}, () => {});
    },
  };
}

/** Les appels du transcrit qui n'ont pas reçu leur résultat. */
export function unansweredCallIds(messages: ChatMessage[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const calls = messages[i].role === "assistant" ? messages[i].tool_calls : undefined;
    if (!calls?.length) continue;
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const id = messages[j].tool_call_id;
      if (id) answered.add(id);
      j++;
    }
    for (const c of calls) if (c.id && !answered.has(c.id)) out.push(c.id);
  }
  return out;
}

/** Ce que le modèle lit à la place d'un résultat perdu, selon le registre.
 *  `undefined` : le registre ne sait rien, le résultat synthétique d'avant. */
export function recoveredResult(row: LedgerRow | undefined): string | undefined {
  if (!row) return undefined;
  if (row.status === "done" && row.result != null) {
    return row.result.startsWith("ERROR")
      ? `[Résultat récupéré après l'arrêt du worker]\n${row.result}`
      : `[Résultat récupéré après l'arrêt du worker : cet appel A ABOUTI, ne le refais pas.]\n${row.result}`;
  }
  const at = Number.isFinite(Date.parse(row.started_at)) ? new Date(row.started_at).toISOString().slice(11, 19) + " UTC" : "un moment inconnu";
  return `ERROR: l'appel ${row.tool} a démarré à ${at} et le worker s'est arrêté avant son résultat. `
    + "Son effet est INCONNU : il a pu aboutir. Vérifie l'état (envoi, fiche, fichier, ticket…) avant de le relancer, "
    + "et ne le relance que si tu as constaté qu'il n'a pas eu lieu.";
}

/** Complète, dans le transcrit rechargé, les résultats perdus d'un tour
 *  interrompu. Modifie `messages` en place. */
export async function recoverInterruptedCalls(
  admin: SupabaseClient,
  runId: string,
  messages: ChatMessage[],
): Promise<{ recovered: number; unknown: number }> {
  const ids = unansweredCallIds(messages);
  if (!ids.length) return { recovered: 0, unknown: 0 };
  const { data } = await admin.from(TABLE)
    .select("call_id, tool, status, result, started_at")
    .eq("run_id", runId).in("call_id", ids)
    .then((r) => r, () => ({ data: null }));
  const rows = new Map(((data ?? []) as LedgerRow[]).map((r) => [r.call_id, r]));
  const fixed = repairToolPairing(messages, (id) => recoveredResult(rows.get(id)));
  if (fixed !== messages) {
    messages.length = 0;
    messages.push(...fixed);
  }
  let recovered = 0;
  let unknown = 0;
  for (const id of ids) {
    const r = rows.get(id);
    if (r?.status === "done") recovered++;
    else if (r) unknown++;
  }
  return { recovered, unknown };
}
