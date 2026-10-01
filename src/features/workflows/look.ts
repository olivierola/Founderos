import type { Node } from "reactflow";
import { BLOCK_BY_KIND, KNOWN_TOOLS, DELIVERABLE_FORMATS } from "./blocks";
import { contextSourceOf, varsOf, normalizeVarName } from "./context";
import type { BlockKind, ContextRef } from "./context";
import type { ChipInfo } from "./RichLine";

// Comment un bloc se NOMME et se COLORE, partout où on le montre.
//
// Vivait dans l'éditeur document, qui en était le seul lecteur. La vue graphe
// affiche exactement les mêmes blocs : les recopier là-bas aurait donné deux
// vocabulaires visuels pour un seul modèle — une pastille bleue dans une phrase
// et une carte grise sur le canevas pour le même outil.

/** La teinte d'un bloc pour un `style` inline — les classes Tailwind du
 *  catalogue ne servent à rien ni dans un SVG ni dans un dégradé. */
export const HUE: Record<string, string> = {
  emerald: "#34d399", indigo: "#818cf8", rose: "#fb7185", sky: "#38bdf8",
  amber: "#fbbf24", purple: "#c084fc", cyan: "#22d3ee", teal: "#2dd4bf",
  orange: "#fb923c", slate: "#94a3b8", violet: "#a78bfa", lime: "#a3e635",
  fuchsia: "#e879f9", blue: "#60a5fa",
};

export const hueOf = (kind: string | undefined): string =>
  HUE[BLOCK_BY_KIND.get((kind ?? "step") as BlockKind)?.color ?? "slate"] ?? HUE.slate;

/** Le nom court d'un bloc — dans une pastille, sur une carte, dans un journal.
 *  Un bloc sans titre affiche ce qu'il CONTIENT : « sans titre » au milieu
 *  d'une phrase ou sur un nœud ne dit rien de ce qu'il fait là. */
export function chipLabelOf(n: Node): string {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const label = String(d.label ?? "").trim();
  if (label) return label;
  if (n.type === "tool") {
    const provider = String(d.provider ?? "").trim();
    const action = String(d.action ?? "").trim();
    if (provider && action) return `${provider} → ${action}`;
    const tool = String(d.tool ?? "").trim();
    // Le nom lisible plutôt que le slug : une pastille au milieu d'une phrase
    // doit se lire, et `deep_research` n'est pas du français.
    return KNOWN_TOOLS.find((t) => t.value === tool)?.label ?? tool ?? "à choisir";
  }
  if (n.type === "context") {
    const cols = (Array.isArray(d.refs) ? (d.refs as ContextRef[]) : []).filter((r) => r.kind === "collection");
    if (cols.length) return cols.map((r) => r.label).join(" · ");
    return contextSourceOf(d) === "collections" ? "à choisir" : "à rédiger";
  }
  if (n.type === "deliverable") {
    const fmt = String(d.format ?? "report");
    return DELIVERABLE_FORMATS.find((f) => f.value === fmt)?.label ?? fmt;
  }
  if (n.type === "variables") {
    const names = varsOf(d).map((v) => normalizeVarName(v.name)).filter(Boolean);
    return names.length ? names.join(" · ") : "Variables";
  }
  return BLOCK_BY_KIND.get((n.type ?? "step") as BlockKind)?.label ?? "Bloc";
}

export const chipInfoOf = (n: Node): ChipInfo => ({
  id: n.id,
  verb: BLOCK_BY_KIND.get((n.type ?? "context") as BlockKind)?.attachLabel ?? "Cadrage",
  label: chipLabelOf(n),
  color: hueOf(n.type),
});
