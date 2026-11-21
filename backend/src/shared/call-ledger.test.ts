// La reprise exacte après un worker tué (call-ledger.ts, 0299) : un appel resté
// sans résultat dans le transcrit sauvegardé reçoit le résultat enregistré s'il
// a abouti, un avertissement daté s'il a seulement démarré, et le résultat
// synthétique d'avant si le registre ne sait rien.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MISSING_TOOL_RESULT, type ChatMessage } from "../edge/_shared/ai.ts";
import {
  recoverInterruptedCalls, recoveredResult, unansweredCallIds, type LedgerRow,
} from "../edge/_shared/call-ledger.ts";

const call = (id: string, name: string) => ({ id, type: "function" as const, function: { name, arguments: "{}" } });

/** Le transcrit d'un tick tué pendant son tour : la demande d'appels est
 *  sauvegardée (onBeforeTools), aucun résultat ne l'est. */
const interrupted = (): ChatMessage[] => [
  { role: "system", content: "s" },
  { role: "user", content: "Envoie le devis à ACME et crée la fiche." },
  { role: "assistant", content: null, tool_calls: [call("a", "send_email"), call("b", "crm"), call("c", "http_request")] },
];

/** Un client Supabase réduit à la lecture du registre. */
const fakeAdmin = (rows: LedgerRow[]) => ({
  from: () => ({ select: () => ({ eq: () => ({ in: (_c: string, ids: string[]) => Promise.resolve({ data: rows.filter((r) => ids.includes(r.call_id)) }) }) }) }),
}) as unknown as Parameters<typeof recoverInterruptedCalls>[0];

describe("registre des appels : reprise", () => {
  it("repère les appels sans résultat, et seulement eux", () => {
    const msgs = interrupted();
    assert.deepEqual(unansweredCallIds(msgs), ["a", "b", "c"]);
    msgs.push({ role: "tool", tool_call_id: "a", content: "envoyé" });
    assert.deepEqual(unansweredCallIds(msgs), ["b", "c"]);
  });

  it("un appel abouti rend son résultat ; un échec n'est pas présenté comme un succès", () => {
    const done = recoveredResult({ call_id: "a", tool: "send_email", status: "done", result: "E-mail envoyé (id 42)", started_at: "2026-11-18T09:00:00Z" });
    assert.match(done!, /A ABOUTI, ne le refais pas/);
    assert.match(done!, /id 42/);
    const failed = recoveredResult({ call_id: "a", tool: "send_email", status: "done", result: "ERROR: SMTP refusé", started_at: "2026-11-18T09:00:00Z" });
    assert.doesNotMatch(failed!, /A ABOUTI/);
    assert.match(failed!, /SMTP refusé/);
  });

  it("un appel seulement démarré est signalé avec son heure, effet inconnu", () => {
    const out = recoveredResult({ call_id: "b", tool: "crm", status: "started", result: null, started_at: "2026-11-18T09:14:03Z" });
    assert.match(out!, /^ERROR: l'appel crm a démarré à 09:14:03 UTC/);
    assert.match(out!, /effet est INCONNU/);
    assert.equal(recoveredResult(undefined), undefined);
  });

  it("complète le transcrit en place : abouti, démarré, inconnu", async () => {
    const msgs = interrupted();
    const res = await recoverInterruptedCalls(fakeAdmin([
      { call_id: "a", tool: "send_email", status: "done", result: "E-mail envoyé (id 42)", started_at: "2026-11-18T09:14:01Z" },
      { call_id: "b", tool: "crm", status: "started", result: null, started_at: "2026-11-18T09:14:03Z" },
    ]), "run-1", msgs);
    assert.deepEqual(res, { recovered: 1, unknown: 1 });
    const results = msgs.filter((m) => m.role === "tool");
    assert.deepEqual(results.map((m) => m.tool_call_id), ["a", "b", "c"]);
    assert.match(String(results[0].content), /A ABOUTI.*\n.*id 42/s);
    assert.match(String(results[1].content), /a démarré à 09:14:03 UTC/);
    assert.equal(results[2].content, MISSING_TOOL_RESULT, "sans trace au registre : le résultat synthétique d'avant");
  });

  it("un registre illisible (table absente) laisse le comportement d'avant", async () => {
    const msgs = interrupted();
    const broken = { from: () => ({ select: () => ({ eq: () => ({ in: () => Promise.reject(new Error("relation does not exist")) }) }) }) } as unknown as Parameters<typeof recoverInterruptedCalls>[0];
    const res = await recoverInterruptedCalls(broken, "run-1", msgs);
    assert.deepEqual(res, { recovered: 0, unknown: 0 });
    assert.ok(msgs.filter((m) => m.role === "tool").every((m) => m.content === MISSING_TOOL_RESULT));
  });

  it("un transcrit complet n'interroge pas le registre", async () => {
    const msgs: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "salut" }];
    let asked = false;
    const spy = { from: () => { asked = true; throw new Error("ne doit pas être appelé"); } } as unknown as Parameters<typeof recoverInterruptedCalls>[0];
    assert.deepEqual(await recoverInterruptedCalls(spy, "run-1", msgs), { recovered: 0, unknown: 0 });
    assert.equal(asked, false);
  });
});
