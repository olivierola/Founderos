import { Deno } from "../../compat/index.ts";

// Les faux outils des évals d'agent (backend/src/evals, d'après eve).
//
// Une éval fait tourner le VRAI moteur d'un agent, mais décide de ce que
// certains outils rendent : une séquence de réponses (« en attente » puis
// « terminé »), ou une panne. C'est ce qui permet de tester comment l'agent
// réagit à un e-mail refusé ou à un CRM muet, sans rien envoyer pour de vrai.
//
// Deux verrous, comme chez eve (« eve rejects stubs by default ») :
//   · le moteur ne les consulte que si AGENT_EVALS=1, jamais posé en
//     production ;
//   · les règles vivent dans la mémoire du processus, posées par le harnais
//     d'évals qui fait tourner le serveur dans le même processus. Aucune
//     requête HTTP ne peut en ajouter.
//
// Une règle par outil, examinées dans l'ordre : la première qui correspond
// répond. Aucune ne correspond : le vrai outil s'exécute.

export type EvalStubOutcome =
  | { response: unknown }
  | { throw: { message: string } };

export interface EvalStubRule {
  /** Le nom de l'outil tel que le modèle l'appelle. */
  tool: string;
  /** Les arguments attendus : égalité stricte, ou `{ pattern: "regex" }` pour
   *  une chaîne. Absent : tout appel de l'outil correspond. */
  match?: Record<string, unknown>;
  /** Une réponse rendue à chaque appel… */
  outcome?: EvalStubOutcome;
  /** …ou une séquence : chaque appel prend la suivante, la dernière se répète. */
  outcomes?: EvalStubOutcome[];
}

interface Registry {
  rules: Map<string, Array<EvalStubRule & { used: number }>>;
}

const KEY = "__founderosEvalStubs";

function registry(): Registry | null {
  if (Deno.env.get("AGENT_EVALS") !== "1") return null;
  const g = globalThis as unknown as Record<string, Registry | undefined>;
  return g[KEY] ?? null;
}

/** Pose les règles d'un agent (harnais d'évals uniquement). */
export function setEvalStubs(agentId: string, rules: EvalStubRule[]): void {
  const g = globalThis as unknown as Record<string, Registry | undefined>;
  const reg = g[KEY] ?? (g[KEY] = { rules: new Map() });
  reg.rules.set(agentId, rules.map((r) => ({ ...r, used: 0 })));
}

/** Retire les règles d'un agent. */
export function clearEvalStubs(agentId: string): void {
  const g = globalThis as unknown as Record<string, Registry | undefined>;
  g[KEY]?.rules.delete(agentId);
}

function matches(expected: Record<string, unknown> | undefined, args: Record<string, unknown>): boolean {
  if (!expected) return true;
  for (const [k, want] of Object.entries(expected)) {
    const got = args[k];
    if (want && typeof want === "object" && "pattern" in (want as Record<string, unknown>)) {
      if (typeof got !== "string" || !new RegExp(String((want as { pattern: string }).pattern), "i").test(got)) return false;
    } else if (JSON.stringify(got) !== JSON.stringify(want)) {
      return false;
    }
  }
  return true;
}

/** Le résultat imposé pour cet appel, ou `null` pour exécuter le vrai outil. */
export function evalStubFor(agentId: string, tool: string, args: Record<string, unknown>): string | null {
  const rules = registry()?.rules.get(agentId);
  if (!rules) return null;
  const rule = rules.find((r) => r.tool === tool && matches(r.match, args ?? {}));
  if (!rule) return null;
  const seq = rule.outcomes?.length ? rule.outcomes : rule.outcome ? [rule.outcome] : [];
  if (!seq.length) return null;
  const o = seq[Math.min(rule.used, seq.length - 1)];
  rule.used++;
  if ("throw" in o) return `ERROR: ${o.throw.message}`;
  return typeof o.response === "string" ? o.response : JSON.stringify(o.response);
}
