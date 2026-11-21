// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/context-checkpoint.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// La compaction hybride : un résumé déterministe ET un point de situation.
//
// Le transcrit d'un long run est scellé par segments (internal-agent-run,
// compactMessagesIfNeeded) : la partie ancienne est remplacée par un résumé
// DÉTERMINISTE de ce qui a été appelé, produit et raté. Gratuit, instantané,
// incapable d'inventer — mais muet sur ce qu'aucun appel d'outil ne porte :
// les exigences que l'utilisateur a posées, les décisions prises en route, ce
// qui reste à faire. Un agent qui perdait ces trois choses à la compaction
// refaisait un choix déjà tranché ou oubliait une contrainte.
//
// Ce module ajoute un POINT DE SITUATION écrit par un modèle léger, limité à
// trois sections (Exigences, Décisions, État du travail), d'après le gabarit
// de compaction d'OpenCode. Il est préparé EN AVANCE, quand le contexte
// approche du seuil, en parallèle des tours du tick : quand la compaction
// arrive, il est déjà là et part dans le segment scellé avec le résumé
// déterministe. S'il manque (modèle indisponible, réponse hors gabarit), le
// résumé déterministe suffit, comme avant.
//
// Il est INCRÉMENTAL : le point suivant met à jour le précédent avec ce qui
// s'est passé depuis, au lieu de tout relire.
//
// Et la taille du contexte n'est plus devinée en caractères : le nombre de
// tokens que le fournisseur a FACTURÉ au dernier tour sert d'étalon, et seul
// ce qui s'est ajouté depuis est estimé (d'après OpenCode : « measured » +
// « estimated »).

import { callAi, type ChatMessage } from "./ai.ts";
import { cheapModel, cheapProvider } from "./model-router.ts";

// ── La mesure ────────────────────────────────────────────────────────────────

/** Le dernier tour mesuré : ce que le fournisseur a compté, et la taille de ce
 *  qu'on lui avait envoyé. Le rapport des deux est le vrai taux de ce modèle
 *  sur CE contenu (JSON, code, français…), au lieu d'un 3,4 supposé. */
export interface PromptMeasure {
  /** `usage.prompt_tokens` du dernier tour. */
  tokens: number;
  /** Caractères du corps envoyé à ce tour (messages + outils + éphémère). */
  bodyChars: number;
  /** Caractères des seuls messages du transcrit à ce moment-là. */
  msgChars: number;
  at?: number;
}

/** Caractères par token supposés quand rien n'a encore été mesuré. Pessimiste. */
const FALLBACK_CHARS_PER_TOKEN = 3.4;

export const transcriptChars = (messages: ChatMessage[]) => JSON.stringify(messages).length;

/**
 * Les tokens du prochain envoi : la mesure du dernier tour, plus ce que le
 * transcrit a pris depuis, converti au taux mesuré. Sans mesure : les
 * caractères au taux pessimiste, comme avant.
 */
export function estimatePromptTokens(messages: ChatMessage[], measure?: PromptMeasure | null): number {
  const chars = transcriptChars(messages);
  if (!measure || !(measure.tokens > 0) || !(measure.bodyChars > 0)) {
    return Math.ceil(chars / FALLBACK_CHARS_PER_TOKEN);
  }
  const rate = measure.tokens / measure.bodyChars;
  // Une compaction a pu RÉDUIRE le transcrit depuis : le delta est alors négatif.
  return Math.max(0, Math.round(measure.tokens + (chars - measure.msgChars) * rate));
}

/** Le taux mesuré (tokens par caractère), ou celui par défaut. */
export function tokensPerChar(measure?: PromptMeasure | null): number {
  return measure && measure.tokens > 0 && measure.bodyChars > 0
    ? measure.tokens / measure.bodyChars
    : 1 / FALLBACK_CHARS_PER_TOKEN;
}

// ── Le point de situation ────────────────────────────────────────────────────

export interface ContextCheckpoint {
  /** Les trois sections, en Markdown. */
  text: string;
  /** Combien de messages du transcrit il couvre (depuis le début). */
  covered: number;
  at: string;
}

const SECTIONS = ["## Exigences", "## Décisions", "## État du travail"];

const TEMPLATE = `Réponds EXACTEMENT avec ce gabarit (rien avant, rien après) :
## Exigences
- [contraintes, préférences, périmètre et critères posés par l'utilisateur ou le brief, mot pour mot quand c'est court ; sinon « (aucune) »]

## Décisions
- [ce qui a été tranché en route, et pourquoi en quelques mots ; sinon « (aucune) »]

## État du travail
### Terminé
- [ce qui est fait, avec les identifiants, chemins, URL et chiffres exacts produits ; sinon « (rien) »]
### En cours
- [ce qui est commencé et pas fini ; sinon « (rien) »]
### Bloqué
- [ce qui bloque, et pourquoi ; sinon « (rien) »]`;

const RULES = `Règles :
- Une ligne par puce, courte. Pas de paragraphes.
- Garde EXACTS les chemins, identifiants, URL, noms de fichiers, chiffres et messages d'erreur.
- Ne recopie pas les consignes système de l'agent ni l'inventaire de ses outils : il les reçoit à part.
- Ne parle pas du résumé lui-même. N'appelle aucun outil. Ne continue pas la tâche.`;

/** Le transcrit rendu lisible et borné pour le modèle qui résume. */
export function renderTranscript(messages: ChatMessage[], maxChars = 40_000): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.floor(n * 0.7))} […] ${s.slice(-Math.floor(n * 0.3))}` : s);
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const text = String(m.content ?? "").trim();
    if (m.role === "user") {
      if (text.startsWith("[FOCUS")) continue;
      lines.push(`UTILISATEUR : ${clip(text, 1500)}`);
    } else if (m.role === "assistant") {
      if (text) lines.push(`AGENT : ${clip(text, 1200)}`);
      for (const c of m.tool_calls ?? []) {
        lines.push(`  → ${c.function?.name}(${clip(String(c.function?.arguments ?? ""), 300)})`);
      }
    } else if (m.role === "tool") {
      lines.push(`  ← ${clip(text, text.startsWith("ERROR") ? 300 : 450)}`);
    }
  }
  const all = lines.join("\n");
  if (all.length <= maxChars) return all;
  // Trop long : le début (la demande) et la fin (l'état présent) comptent le
  // plus ; le milieu est ce qu'un point précédent couvre déjà.
  const head = all.slice(0, Math.floor(maxChars * 0.25));
  const tail = all.slice(-Math.floor(maxChars * 0.75));
  return `${head}\n[…]\n${tail}`;
}

/** Vrai quand le texte a bien les trois sections attendues. */
export function isValidCheckpoint(text: string): boolean {
  return SECTIONS.every((h) => text.includes(h));
}

/**
 * Faut-il préparer (ou rafraîchir) le point de situation à ce tick ?
 * Dès 60 % du seuil de compaction, et seulement si assez de transcrit est
 * venu s'ajouter depuis le dernier — un point par tick serait du gaspillage.
 */
export function shouldPrepareCheckpoint(
  estimatedTokens: number, triggerTokens: number, prev: ContextCheckpoint | null, messageCount: number,
): boolean {
  if (estimatedTokens < triggerTokens * 0.6) return false;
  if (!prev) return true;
  return messageCount - prev.covered >= 12;
}

/**
 * Écrit (ou met à jour) le point de situation sur `messages`. null : modèle
 * indisponible, ou réponse hors gabarit — l'appelant garde le précédent.
 */
export async function buildCheckpoint(input: {
  goal: string;
  messages: ChatMessage[];
  previous?: ContextCheckpoint | null;
}): Promise<ContextCheckpoint | null> {
  const prev = input.previous && isValidCheckpoint(input.previous.text) ? input.previous : null;
  // Mise à jour : seulement ce qui s'est passé depuis le point précédent.
  const span = prev ? input.messages.slice(prev.covered) : input.messages;
  if (span.length === 0) return prev;
  const update = !!prev;
  try {
    const res = await callAi({
      task: "summary", provider: cheapProvider(), model: cheapModel(),
      maxTokens: 1400, temperature: 0.1,
      systemPrompt: [
        update
          ? "Tu mets à jour le point de situation d'un agent autonome avec ce qui s'est passé depuis. Ce qui est plus récent l'emporte. Garde ce qui reste vrai ; retire ce qui est résolu, contredit ou périmé. Déplace ce qui est fini d'« En cours » vers « Terminé »."
          : "Tu écris le point de situation d'un agent autonome, pour qu'il reprenne son travail après que le début de sa conversation aura été retiré de son contexte.",
        TEMPLATE,
        RULES,
      ].join("\n\n"),
      userPrompt: [
        `# Objectif\n${input.goal.slice(0, 1200)}`,
        prev ? `# Point de situation précédent\n${prev.text}` : "",
        `# ${update ? "Ce qui s'est passé depuis" : "Transcrit"}\n${renderTranscript(span)}`,
      ].filter(Boolean).join("\n\n"),
    });
    const text = String(res.content ?? "").trim();
    if (!isValidCheckpoint(text)) return prev;
    return { text: text.slice(0, 6000), covered: input.messages.length, at: new Date().toISOString() };
  } catch {
    return prev;
  }
}

/** Le bloc ajouté au segment scellé, après le résumé déterministe. */
export function checkpointBlock(cp: ContextCheckpoint | null | undefined): string {
  if (!cp || !isValidCheckpoint(cp.text)) return "";
  return `\n\nPoint de situation (rédigé par le harnais, à jour au message ${cp.covered}) :\n${cp.text}`;
}
