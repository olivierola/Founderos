import { memo } from "react";
import { motion } from "framer-motion";
import { Handle, Position, type NodeProps } from "reactflow";
import {
  Play, Target, ShieldAlert, ListOrdered, GitBranch, UserCheck,
  BookMarked, FileOutput, Lightbulb, ArrowRight, Brain, Repeat, Bot,
  Inbox, Wrench, Users, BrainCircuit,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { contextBodyOf, contextSourceOf, paramsOf, agentIdsOf } from "./context";
import type { ContextRef } from "./context";
import type { BlockKind } from "./model";

// The block catalogue. A workflow is a PROCEDURE, and these are the sections a
// good procedure is made of — not runtime nodes. Each one compiles into a part
// of the `workflow.md` the assistant executes.
//
// The palette, the canvas and the inspector all read from here, so a new block
// is added in exactly one place.

export interface BlockDef {
  kind: BlockKind;
  label: string;
  hint: string;
  /** What it becomes in the document — shown in the palette, because that is
   *  what actually tells the two similar-looking blocks apart. */
  compiles: string;
  icon: LucideIcon;
  color: string;
  hasInput: boolean;
  outputs: { id?: string; label?: string }[];
  defaults: Record<string, unknown>;
}

/** Border + tint + text, one tuple per hue. Blocks read as a family because the
 *  three values always move together. */
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

export const BLOCKS: BlockDef[] = [
  {
    kind: "trigger", label: "Déclencheur", hint: "Quand la procédure se lance",
    compiles: "frontmatter", icon: Play, color: "emerald",
    hasInput: false, outputs: [{}],
    defaults: { label: "Déclencheur", mode: "manual", schedule: "0 9 * * 1", event: "" },
  },
  {
    kind: "input", label: "Entrée", hint: "Ce qu'il faut connaître pour démarrer — demandé si absent",
    compiles: "## Entrées", icon: Inbox, color: "lime",
    hasInput: true, outputs: [{}],
    defaults: { label: "", body: "", params: [] },
  },
  {
    kind: "goal", label: "Objectif", hint: "Ce qui est visé, et à quoi on voit que c'est fait",
    compiles: "## Objectif", icon: Target, color: "indigo",
    hasInput: true, outputs: [{}],
    defaults: { label: "", body: "" },
  },
  {
    kind: "rule", label: "Règle", hint: "Contrainte qui vaut pour toutes les étapes",
    compiles: "## Règles", icon: ShieldAlert, color: "rose",
    hasInput: true, outputs: [{}],
    defaults: { label: "", body: "" },
  },
  {
    kind: "context", label: "Contexte", hint: "Connaissances à charger — pour tout, ou pour cette branche seulement",
    compiles: "## Contexte", icon: Brain, color: "violet",
    hasInput: true, outputs: [{}],
    defaults: { label: "", body: "", refs: [], scope: "global" },
  },
  {
    kind: "resource", label: "Ressource", hint: "Document, base ou app à utiliser",
    compiles: "## Ressources", icon: BookMarked, color: "cyan",
    hasInput: true, outputs: [{}],
    defaults: { label: "", body: "" },
  },
  {
    kind: "tool", label: "Outil", hint: "Une capacité imposée ici : recherche, code, appel HTTP, connecteur…",
    compiles: "## Outils à utiliser", icon: Wrench, color: "blue",
    hasInput: true, outputs: [{}],
    defaults: { label: "", body: "", tool: "web_search", required: true },
  },
  {
    kind: "step", label: "Étape", hint: "Une action — à faire soi-même ou à confier, avec son contexte",
    compiles: "### n. Titre", icon: ListOrdered, color: "sky",
    hasInput: true, outputs: [{}],
    defaults: { label: "", body: "", agent_id: null, refs: [] },
  },
  {
    kind: "loop", label: "Boucle", hint: "Répéter : pour chaque élément, ou jusqu'à une condition",
    compiles: "### Boucle", icon: Repeat, color: "orange",
    hasInput: true,
    outputs: [{ id: "body", label: "répéter" }, { id: "done", label: "après" }],
    defaults: { label: "", body: "", mode: "foreach", over: "", until: "", max: 20 },
  },
  {
    kind: "decision", label: "Décision", hint: "Bifurcation : si oui… sinon…",
    compiles: "### Décision", icon: GitBranch, color: "amber",
    hasInput: true, outputs: [{ id: "true", label: "si oui" }, { id: "false", label: "sinon" }],
    defaults: { label: "", body: "" },
  },
  {
    kind: "handoff", label: "Passation", hint: "Confier à un ou plusieurs agents, avec ce qu'on rend en retour",
    compiles: "### ➜ Passation", icon: Users, color: "fuchsia",
    hasInput: true, outputs: [{}],
    defaults: { label: "", body: "", agent_ids: [], mode: "sequential", expects: "", refs: [] },
  },
  {
    kind: "approval", label: "Validation humaine", hint: "Point d'arrêt : demander avant de continuer",
    compiles: "### ⏸ Validation", icon: UserCheck, color: "purple",
    hasInput: true, outputs: [{}],
    defaults: { label: "", body: "" },
  },
  {
    kind: "deliverable", label: "Livrable", hint: "Ce qui doit être produit, et sous quelle forme",
    compiles: "## Livrables", icon: FileOutput, color: "teal",
    hasInput: true, outputs: [{}],
    defaults: { label: "", body: "", format: "report" },
  },
  {
    kind: "memory", label: "Mémoire", hint: "Ce qui doit survivre au run et servir aux suivants",
    compiles: "## À mémoriser", icon: BrainCircuit, color: "violet",
    hasInput: true, outputs: [{}],
    defaults: { label: "", body: "", scope: "team" },
  },
  {
    kind: "example", label: "Exemple", hint: "Un cas traité de bout en bout",
    compiles: "## Exemples", icon: Lightbulb, color: "slate",
    hasInput: true, outputs: [{}],
    defaults: { label: "", body: "" },
  },
];

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
    const name = s(data.tool) || "outil non choisi";
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
  if (kind === "tool") return !String(data.tool ?? "").trim();
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

const NODE_WIDTH = 224;

function BlockCardBody({ type, data, selected }: NodeProps) {
  // React Flow's `type` IS the kind — it is what the graph stores and what the
  // node-type registry keyed on.
  const kind = (type || "step") as BlockKind;
  const def = BLOCK_BY_KIND.get(kind) ?? BLOCKS[4];
  const Icon = def.icon;
  const tone = blockColorClass(def.color);
  const summary = blockSummary(kind, data as Record<string, unknown>);
  const empty = Boolean(data.__empty);
  const title = String(data.label ?? "").trim() || def.label;
  // Resolved by the canvas — the graph stores an agent id, not a name.
  const delegate = String(data.__agentName ?? "").trim();
  const refs = refsOf(data as Record<string, unknown>);

  return (
    <motion.div
      initial={{ scale: 0.94, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.18 }}
      style={{ width: NODE_WIDTH }}
      className="relative"
    >
      {def.hasInput && (
        <Handle
          type="target" position={Position.Top}
          className="!h-2.5 !w-2.5 !border-2 !border-background !bg-muted-foreground"
        />
      )}

      <div
        className={cn(
          "group/block relative overflow-hidden rounded-xl border bg-background/70 p-3 backdrop-blur transition-all hover:shadow-lg",
          tone,
          selected && "ring-2 ring-primary",
          empty && "border-dashed",
        )}
      >
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-foreground/[0.05] via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover/block:opacity-100" />

        <div className="relative space-y-2">
          <div className="flex items-center gap-2">
            <div
              className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-background/80 backdrop-blur", tone)}
              aria-hidden="true"
            >
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <Badge
                variant="outline"
                className="mb-0.5 rounded-full border-border/40 bg-background/80 px-1.5 py-0 text-[9px] uppercase tracking-[0.15em] text-foreground/60"
              >
                {def.label}
              </Badge>
              <h3 className="truncate text-xs font-semibold tracking-tight text-foreground">{title}</h3>
            </div>
          </div>

          <p className={cn("line-clamp-3 text-[10px] leading-relaxed", empty ? "text-amber-500" : "text-foreground/70")}>
            {summary}
          </p>

          {/* Who takes this, and with what knowledge — the two things that make
              a workflow a situated frame rather than a to-do list. Shown on the
              card because they are what you scan a graph for. */}
          {(delegate || refs.length > 0) && (
            <div className="flex flex-wrap items-center gap-1">
              {delegate && (
                <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-indigo-400/40 bg-indigo-400/10 px-1.5 py-0.5 text-[9px] text-indigo-400">
                  <Bot className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{delegate}</span>
                </span>
              )}
              {refs.slice(0, 2).map((r, i) => (
                <span key={i} className="inline-flex max-w-full items-center gap-1 rounded-full border border-violet-400/40 bg-violet-400/10 px-1.5 py-0.5 text-[9px] text-violet-400">
                  <Brain className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{r.label || "contexte"}</span>
                </span>
              ))}
              {refs.length > 2 && (
                <span className="text-[9px] text-foreground/50">+{refs.length - 2}</span>
              )}
            </div>
          )}

          <div className="flex items-center gap-1.5 text-[10px] text-foreground/45">
            <ArrowRight className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
            <span className="truncate font-mono">{def.compiles}</span>
          </div>
        </div>
      </div>

      {def.outputs.map((o, i) => {
        const many = def.outputs.length > 1;
        const left = many ? `${((i + 1) / (def.outputs.length + 1)) * 100}%` : "50%";
        return (
          <span key={o.id ?? i}>
            <Handle
              type="source" position={Position.Bottom} id={o.id}
              style={{ left }}
              className="!h-2.5 !w-2.5 !border-2 !border-background !bg-muted-foreground"
            />
            {o.label && (
              <span
                className="pointer-events-none absolute -bottom-4 -translate-x-1/2 text-[9px] font-medium uppercase tracking-[0.1em] text-foreground/50"
                style={{ left }}
              >
                {o.label}
              </span>
            )}
          </span>
        );
      })}
    </motion.div>
  );
}

const BlockCard = memo(BlockCardBody);

// Every kind renders through the same component — it reads its own definition
// from `type`. One registry entry per kind keeps React Flow's `type` field
// meaningful (and the stored graph readable) without nine near-identical
// components.
export const BLOCK_NODE_TYPES = Object.fromEntries(
  BLOCKS.map((b) => [b.kind, BlockCard]),
) as Record<string, typeof BlockCard>;
