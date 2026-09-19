import {
  PlayIcon as Play,
  TargetIcon as Target,
  ShieldWarningIcon as ShieldAlert,
  ListNumbersIcon as ListOrdered,
  GitBranchIcon as GitBranch,
  UserCheckIcon as UserCheck,
  BookBookmarkIcon as BookMarked,
  FileArrowUpIcon as FileOutput,
  LightbulbIcon as Lightbulb,
  BrainIcon as Brain,
  RepeatIcon as Repeat,
  TextHIcon as Heading,
  TrayIcon as Inbox,
  WrenchIcon as Wrench,
  UsersIcon as Users,
  BrainIcon as BrainCircuit,
  type Icon as LucideIcon,
} from "@phosphor-icons/react";
import { contextBodyOf, contextSourceOf, paramsOf, agentIdsOf } from "./context";
import type { ContextRef, BlockKind } from "./context";
import {
  BLOCK_DOC, BLOCK_KINDS, type BlockDoc,
} from "../../../supabase/functions/_shared/workflow-doc";

// L'APPARENCE des blocs — un nom, une phrase, une icône, une teinte.
//
// Ce que ce fichier ne fait PAS : redéclarer ce qu'un bloc est. Le rôle, les
// valeurs par défaut et la façon dont un bloc compile vivent dans le langage
// partagé (workflow-doc.ts), parce que le runtime edge en a besoin autant que
// l'éditeur. Ils étaient copiés ici, et une copie de règles finit toujours par
// diverger de l'original : c'est exactement ce qui est arrivé au vocabulaire
// des types, où l'éditeur refusait un bloc que le compilateur savait produire.
//
// Donc : la présentation ici, la sémantique là-bas, fusionnées ci-dessous. Un
// nouveau bloc s'ajoute dans workflow-doc.ts, et on lui donne un visage ici.

/** Bordure + fond + texte, un triplet par teinte. Les blocs se lisent comme
 *  une famille parce que les trois valeurs bougent ensemble. */
const COLOR_CLASSES: Record<string, string> = {
  emerald: "border-emerald-400/40 bg-emerald-400/10 text-emerald-400",
  indigo: "border-indigo-400/40 bg-indigo-400/10 text-indigo-400",
  rose: "border-rose-400/40 bg-rose-400/10 text-rose-400",
  sky: "border-sky-400/40 bg-sky-400/10 text-sky-400",
  amber: "border-amber-400/40 bg-amber-400/10 text-amber-400",
  purple: "border-purple-400/40 bg-purple-400/10 text-purple-400",
  cyan: "border-cyan-400/40 bg-cyan-400/10 text-cyan-400",
  teal: "border-teal-400/40 bg-teal-400/10 text-teal-400",
  orange: "border-orange-400/40 bg-orange-400/10 text-orange-400",
  slate: "border-slate-400/40 bg-slate-400/10 text-slate-400",
  violet: "border-violet-400/40 bg-violet-400/10 text-violet-400",
  lime: "border-lime-400/40 bg-lime-400/10 text-lime-400",
  fuchsia: "border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-400",
  blue: "border-blue-400/40 bg-blue-400/10 text-blue-400",
};

interface Look { label: string; hint: string; icon: LucideIcon; color: string }

/** Le `hint` est la ligne lue dans un menu au moment de choisir. Il dit ce que
 *  le bloc FAIT, en une ligne — pas ce qu'il est en théorie. */
const LOOK: Record<BlockKind, Look> = {
  trigger: { label: "Déclencheur", hint: "Quand la procédure se lance", icon: Play, color: "emerald" },
  input: { label: "Entrée", hint: "Ce qu'il faut connaître pour démarrer", icon: Inbox, color: "lime" },
  goal: { label: "Objectif", hint: "Ce qui est visé, et à quoi on voit que c'est fait", icon: Target, color: "indigo" },
  rule: { label: "Règle", hint: "Une contrainte à ne jamais enfreindre", icon: ShieldAlert, color: "rose" },
  context: { label: "Contexte", hint: "Des connaissances à charger ici", icon: Brain, color: "violet" },
  resource: { label: "Ressource", hint: "Un document, une base, une app", icon: BookMarked, color: "cyan" },
  tool: { label: "Outil", hint: "Un outil imposé à cet endroit", icon: Wrench, color: "blue" },
  section: { label: "Section", hint: "Un intertitre qui groupe les étapes", icon: Heading, color: "slate" },
  step: { label: "Étape", hint: "Une action — à faire ou à confier", icon: ListOrdered, color: "sky" },
  loop: { label: "Boucle", hint: "Répéter pour chaque élément, ou jusqu'à une condition", icon: Repeat, color: "orange" },
  decision: { label: "Décision", hint: "Bifurcation : si… sinon…", icon: GitBranch, color: "amber" },
  handoff: { label: "Passation", hint: "Confier à des agents, avec ce qui doit revenir", icon: Users, color: "fuchsia" },
  approval: { label: "Validation humaine", hint: "Point d'arrêt : demander avant de continuer", icon: UserCheck, color: "purple" },
  deliverable: { label: "Livrable", hint: "Ce qui doit être produit, et sous quelle forme", icon: FileOutput, color: "teal" },
  memory: { label: "Mémoire", hint: "Ce qui doit servir aux runs suivants", icon: BrainCircuit, color: "violet" },
  example: { label: "Exemple", hint: "Un cas traité de bout en bout", icon: Lightbulb, color: "slate" },
};

export interface BlockDef extends Look, BlockDoc { kind: BlockKind }

export const BLOCKS: BlockDef[] = BLOCK_KINDS.map((kind) => ({
  kind, ...LOOK[kind], ...BLOCK_DOC[kind],
}));
export const BLOCK_BY_KIND = new Map(BLOCKS.map((b) => [b.kind, b]));
export const blockColorClass = (color: string) => COLOR_CLASSES[color] ?? COLOR_CLASSES.slate;

/** Short line under the title. Empty until written, which is what makes an
 *  unfinished block visibly unfinished. */
export function blockSummary(kind: BlockKind, data: Record<string, unknown>): string {
  const s = (v: unknown) => String(v ?? "").trim();
  if (kind === "trigger") {
    return data.mode === "schedule" ? `Planifié · ${s(data.schedule) || "cron non défini"}`
      : data.mode === "event" ? `Événement · ${s(data.event) || "non défini"}`
      : data.mode === "webhook" ? "Webhook entrant"
      : "Lancement manuel";
  }
  if (kind === "loop") {
    return data.mode === "until"
      ? `Jusqu'à : ${s(data.until) || "condition non définie"}`
      : `Pour chaque : ${s(data.over) || "liste non définie"}`;
  }
  // A context block says what it IS, not what it contains: in collections mode
  // its body may hold a dormant draft that the document never prints, and a
  // card showing that draft would describe a block the agent never receives.
  if (kind === "context" && contextSourceOf(data) === "collections") {
    const cols = refsOf(data).filter((r) => r.kind === "collection");
    return cols.length ? cols.map((r) => r.label).join(" · ") : "Aucune collection choisie";
  }
  if (kind === "input") {
    const p = paramsOf(data);
    return p.length ? p.map((x) => x.name || "?").join(" · ") : s(data.body) || "Aucun paramètre";
  }
  if (kind === "tool") {
    // Une action nommée se lit « app → action » ; une capacité, par son seul
    // nom. Afficher l'un pour l'autre laisserait croire qu'un appel précis est
    // programmé là où l'agent choisira encore.
    const name = s(data.provider) && s(data.action)
      ? `${s(data.provider)} → ${s(data.action)}`
      : s(data.tool) || "outil non choisi";
    return `${name}${data.required === false ? " (si besoin)" : ""}${s(data.body) ? ` — ${s(data.body)}` : ""}`;
  }
  if (kind === "handoff") {
    const n = agentIdsOf(data).length;
    const who = n === 0 ? "destinataire à choisir" : n === 1 ? "1 agent" : `${n} agents${data.mode === "parallel" ? " en parallèle" : ""}`;
    return `${who}${s(data.body) ? ` — ${s(data.body)}` : ""}`;
  }
  const body = kind === "context" ? contextBodyOf(data).trim() : s(data.body);
  if (body) return body;
  const def = BLOCK_BY_KIND.get(kind);
  return `À rédiger — ${def?.hint.toLowerCase() ?? ""}`;
}

export { paramsOf, agentIdsOf } from "./context";
export type { InputParam } from "./context";

export const refsOf = (data: Record<string, unknown>): ContextRef[] =>
  Array.isArray(data.refs) ? (data.refs as ContextRef[]) : [];

/** A block that carries neither text nor attached knowledge contributes nothing
 *  to the playbook. */
export function isBlockEmpty(kind: BlockKind, data: Record<string, unknown>): boolean {
  if (kind === "trigger") return false;
  if (kind === "loop") return !String(data.over ?? "").trim() && !String(data.until ?? "").trim();
  if (kind === "input") return paramsOf(data).every((p) => !p.name?.trim()) && !String(data.body ?? "").trim();
  if (kind === "tool") {
    const isAction = !!String(data.provider ?? "").trim() && !!String(data.action ?? "").trim();
    return !isAction && !String(data.tool ?? "").trim();
  }
  // A handoff with nobody on the other end is a step that never happens.
  if (kind === "handoff") return agentIdsOf(data).length === 0;
  // Judged on the ACTIVE source only — a block pointing at collections with
  // none selected is empty, whatever dormant text it still carries.
  if (kind === "context") {
    return contextSourceOf(data) === "collections"
      ? !refsOf(data).some((r) => r.kind === "collection")
      : !contextBodyOf(data).trim();
  }
  return !String(data.body ?? "").trim() && !String(data.label ?? "").trim();
}

/**
 * Les capacités qu'une procédure épingle nommément.
 *
 * Pas la boîte à outils complète d'un agent — il l'a déjà. Ce sont celles
 * qu'on impose à un endroit précis, et c'est ce qui empêche un agent de
 * répondre de mémoire à une question qui demandait d'aller vérifier.
 *
 * Vit ici, et pas dans le formulaire, parce que le menu `/` du document les
 * propose aussi : deux listes finiraient par ne plus offrir les mêmes outils.
 */
export const KNOWN_TOOLS: Array<{ value: string; label: string }> = [
  { value: "web_search", label: "Recherche web" },
  { value: "deep_research", label: "Recherche approfondie" },
  { value: "read_url", label: "Lire une page" },
  { value: "rag_search", label: "Base de connaissances (RAG)" },
  { value: "query_table", label: "Interroger les données du projet" },
  { value: "python_exec", label: "Exécuter du Python" },
  { value: "shell_exec", label: "Exécuter une commande shell" },
  { value: "sandbox_browser", label: "Navigateur du sandbox" },
  { value: "http_request", label: "Appel HTTP" },
  { value: "send_email", label: "Envoyer un e-mail" },
  { value: "create_deliverable", label: "Produire un livrable" },
];

/** Les formes qu'un livrable peut prendre. Le format n'est pas cosmétique :
 *  un JSON est lu par un programme et porte son schéma, un rapport est écrit
 *  par Le Rédacteur. */
export const DELIVERABLE_FORMATS: Array<{ value: string; label: string; hint: string }> = [
  { value: "report", label: "Rapport", hint: "Document conçu, écrit par Le Rédacteur" },
  { value: "markdown", label: "Document", hint: "Markdown simple" },
  { value: "csv", label: "Tableau CSV", hint: "Des lignes et des colonnes" },
  { value: "json", label: "JSON structuré", hint: "Lu par un programme — schéma exigé" },
  { value: "notification", label: "Notification", hint: "Un message, pas un fichier" },
];
