// Évals d'agent (d'après eve, `eve eval`) : des scénarios qui parlent au VRAI
// moteur d'un agent (internal-agent-run sur la plateforme auto-hébergée,
// PGlite) et vérifient ce qu'il a fait.
//
// Une éval :
//   · crée un agent et sa conversation ;
//   · impose, si besoin, ce que rendent certains outils (faux outils,
//     eval-stubs.ts) : une séquence de réponses, ou une panne ;
//   · envoie des messages et laisse le moteur dérouler ses ticks ;
//   · vérifie ce qui s'est passé : outils appelés, réponse, statut du run.
//
// Deux modes, mêmes fichiers :
//   · simulé (défaut, CI) : le modèle est la fonction `model` du scénario,
//     déterministe. On teste le moteur : reprise, contrats, garde-fous,
//     faux outils, règles de tour ;
//   · réel (`--live`) : le modèle configuré répond. On teste le comportement
//     de l'agent face à un prompt ou un outil modifié.
//
// Une assertion est BLOQUANTE (gate, par défaut) ou INDICATIVE (soft) : un
// échec bloquant fait échouer l'éval et la commande ; un échec indicatif est
// rapporté, et ne fait échouer la commande qu'avec `--strict`.

import type { EvalStubRule } from "../edge/_shared/eval-stubs.ts";

// ── Le modèle simulé ──────────────────────────────────────────────────────

/** Ce que le modèle simulé voit d'un appel de la boucle d'outils. */
export interface ModelRequest {
  /** Le dernier message de la personne (hors messages d'outils). */
  lastUserMessage: string;
  /** Les noms des outils proposés à ce tour. */
  tools: string[];
  /** Les résultats d'outils déjà reçus pendant ce tour, dans l'ordre. */
  toolResults: Array<{ name: string; content: string }>;
  /** Tout ce que le modèle reçoit, une ligne par message (rôle: contenu) :
   *  pour réagir à une relance du moteur (contrat, affirmation sans preuve…). */
  transcript: string;
  /** Le nombre d'appels de la boucle déjà faits dans cette éval. */
  callIndex: number;
}

/** Ce que le modèle simulé répond : du texte, ou des appels d'outils. */
export type ModelReply =
  | { text: string }
  | { toolCalls: Array<{ name: string; args: Record<string, unknown> }> };

export type MockModel = (req: ModelRequest) => ModelReply;

// ── Le contexte d'une éval ────────────────────────────────────────────────

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  stubbed: boolean;
  preview: string;
}

export interface Turn {
  runId: string;
  status: string;
  reply: string;
  toolCalls: ToolCallRecord[];
  ticks: number;
}

export interface AssertionResult {
  label: string;
  pass: boolean;
  severity: "gate" | "soft";
  detail?: string;
}

export interface EvalContext {
  /** Le client service de la plateforme d'éval : préparer des données, vérifier la base. */
  // deno-lint-ignore no-explicit-any
  readonly admin: any;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  /** Envoie un message comme la personne, et attend la fin du tour. */
  send(message: string): Promise<Turn>;
  /** Le dernier tour terminé. */
  readonly turn: Turn;
  /** Tous les appels d'outils de l'éval. */
  readonly calls: ToolCallRecord[];
  /** L'outil a été appelé (au moins une fois, avec ces arguments s'ils sont donnés). */
  calledTool(name: string, args?: Record<string, unknown>, opts?: Severity): void;
  /** L'outil n'a jamais été appelé. */
  notCalledTool(name: string, opts?: Severity): void;
  /** Aucun appel d'outil n'a échoué. */
  noFailedCalls(opts?: Severity): void;
  /** La dernière réponse correspond (ou non, avec `not`). */
  replyMatches(re: RegExp, opts?: Severity & { not?: boolean }): void;
  /** Le dernier tour s'est terminé avec ce statut. */
  statusIs(status: string | string[], opts?: Severity): void;
  /** Une vérification libre. */
  check(label: string, pass: boolean, opts?: Severity & { detail?: string }): void;
}

export interface Severity {
  severity?: "gate" | "soft";
}

export interface EvalDefinition {
  /** Ce que vérifie l'éval, en une phrase. */
  description: string;
  /** Le prompt système et la description de l'agent testé. */
  agent?: { name?: string; systemPrompt?: string; description?: string };
  /** Les faux outils (voir eval-stubs.ts). */
  stubs?: EvalStubRule[];
  /** Le modèle simulé. Ignoré en mode réel. */
  model: MockModel;
  /** Les étiquettes, pour filtrer (`--tag`). */
  tags?: string[];
  /** Réservée au mode simulé ou au mode réel. */
  only?: "mock" | "live";
  test(t: EvalContext): Promise<void>;
}

export function defineEval(def: EvalDefinition): EvalDefinition {
  return def;
}

// ── Aides pour écrire les modèles simulés ─────────────────────────────────

/** Un appel d'outil. */
export const callTool = (name: string, args: Record<string, unknown> = {}): ModelReply => ({ toolCalls: [{ name, args }] });
/** Une réponse texte. */
export const say = (text: string): ModelReply => ({ text });
