// Ce qu'un agent en mode pools voit de ses pools (0291) : l'inventaire, et le
// geste qui sert chaque ressource.
//
// Le mode pools ferme tout ce qui est hors des pools ; encore faut-il que
// l'agent sache ce qui est DEDANS. Sans ça, il lit une liste d'outils
// mcp_… sans savoir d'où ils viennent, ignore qu'une collection lui est
// ouverte, qu'une automatisation peut être lancée, ou qu'un collègue ne pourra
// pas lui répondre — et il improvise ce que le pool fait déjà.
//
// Ce module est PUR : il reçoit l'inventaire (resource-pools.ts) et un index
// du toolset de CE run (les noms réels des outils), et rend du texte. Les
// lectures annexes (schéma d'un outil MCP, texte d'un garde-fou) sont faites
// par l'outil my_resources (internal-agent-tools.ts), qui les lui passe.

import type { PoolInventory, PoolResource } from "./resource-pools.ts";

export type ResourceGroup = "tools" | "knowledge" | "skills" | "procedures" | "automations" | "agents" | "guardrails";

export const RESOURCE_GROUPS: ResourceGroup[] = ["tools", "knowledge", "skills", "procedures", "automations", "agents", "guardrails"];

const GROUP_LABEL: Record<ResourceGroup, string> = {
  tools: "OUTILS",
  knowledge: "CONNAISSANCES",
  skills: "COMPÉTENCES",
  procedures: "PROCÉDURES — à lire puis suivre toi-même",
  automations: "AUTOMATISATIONS — à lancer, le moteur les exécute",
  agents: "COLLÈGUES (A2A)",
  guardrails: "GARDE-FOUS — appliqués d'office à tes réponses et actions",
};

const SOURCE_LABEL: Record<string, string> = {
  mcp: "Serveur MCP", composio: "App", app_connector: "Connecteur", custom_connector: "Outil maison", builtin: "Intégré",
};

const SOURCE_OF: Record<string, string> = {
  mcp: "du serveur MCP", composio: "de l'app", app_connector: "du connecteur", custom_connector: "de l'outil maison",
};

const RISK_LABEL: Record<string, string> = { read: "lecture", write: "écriture", destructive: "DESTRUCTIF" };

/** Outils listés par source dans l'inventaire ; au-delà, l'agent filtre. */
const TOOLS_PER_SOURCE = 12;
const TOOLS_PER_SOURCE_FILTERED = 40;

export function groupOf(r: Pick<PoolResource, "kind">): ResourceGroup {
  switch (r.kind) {
    case "knowledge": return "knowledge";
    case "skill": return "skills";
    case "procedure": return "procedures";
    case "automation": return "automations";
    case "agent": return "agents";
    case "guardrail": return "guardrails";
    default: return "tools";
  }
}

/** Ce que le toolset de CE run expose : les vrais noms d'outils. */
export interface ToolIndex {
  /** L'outil d'un outil MCP, ou null s'il n'est pas exposé à ce run. */
  mcp(serverId: string, tool: string): string | null;
  /** Les outils exposés d'un serveur MCP. */
  mcpServerTools(serverId: string): string[];
  composio(toolkit: string): string | null;
  /** L'outil d'un connecteur maison (0293), par fournisseur. */
  app(provider: string): string | null;
  custom(connectorId: string): string | null;
  /** Les outils d'une famille intégrée exposés à ce run. */
  builtin(family: string): string[];
  has(name: string): boolean;
}

export interface Usage {
  /** Les outils qui servent cette ressource (à rendre appelables). */
  tools: string[];
  /** Le geste, en une ligne. Vide : rien à faire (un garde-fou s'applique seul). */
  how: string;
  /** Pourquoi elle n'est pas utilisable maintenant. */
  blocked?: string;
}

const NOT_EXPOSED = "pas exposé à ce run (serveur injoignable, jeton absent ou outil hors du catalogue d'accès)";

const short = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const norm = (s: string | null | undefined) =>
  (s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

const toolkitOf = (r: PoolResource) => String(r.metadata?.toolkit ?? "").toLowerCase();

/** Le geste qui sert une ressource, dans le toolset de ce run. */
export function usageOf(r: PoolResource, idx: ToolIndex): Usage {
  if (r.status === "removed") return { tools: [], how: "", blocked: "n'existe plus sur sa source" };
  if (r.status !== "active") return { tools: [], how: "", blocked: "désactivée ou déconnectée à la source" };
  const wfStatus = String(r.metadata?.workflow_status ?? "active");
  switch (r.source) {
    case "mcp": {
      if (r.kind === "tool") {
        const fn = idx.mcp(r.source_id, r.item_key);
        return fn ? { tools: [fn], how: `${fn}(…)` } : { tools: [], how: "", blocked: NOT_EXPOSED };
      }
      const fns = idx.mcpServerTools(r.source_id);
      return fns.length
        ? { tools: [], how: `${fns.length} outil(s) mcp_… — demande le mode d'emploi de celui qu'il te faut` }
        : { tools: [], how: "", blocked: NOT_EXPOSED };
    }
    case "composio": {
      const fn = idx.composio(toolkitOf(r));
      if (!fn) return { tools: [], how: "", blocked: "l'app n'est pas branchée sur ce run" };
      return r.kind === "tool"
        ? { tools: [fn], how: `${fn}(action="${r.item_key}", params={…})` }
        : { tools: [fn], how: `${fn}() liste ses actions, puis ${fn}(action="…", params={…})` };
    }
    case "app_connector": {
      const fn = idx.app(String(r.metadata?.provider ?? ""));
      if (!fn) return { tools: [], how: "", blocked: "le connecteur n'est pas branché sur ce run" };
      return r.kind === "tool"
        ? { tools: [fn], how: `${fn}(action="${r.item_key}", params={…})` }
        : { tools: [fn], how: `${fn}(action="…", params={…})` };
    }
    case "custom_connector": {
      const fn = idx.custom(r.source_id);
      if (!fn) return { tools: [], how: "", blocked: "l'outil n'est pas branché sur ce run (brouillon, ou réservé à un autre service)" };
      return r.kind === "tool"
        ? { tools: [fn], how: `${fn}(operation="${r.item_key}", params={…})` }
        : { tools: [fn], how: `${fn}(operation="…", params={…})` };
    }
    case "builtin": {
      const fns = idx.builtin(r.item_key);
      if (fns.length) return { tools: fns, how: fns.join(", ") };
      return {
        tools: [], how: "",
        blocked: r.metadata?.requires_config
          ? "ton pool l'autorise, mais cet outil se configure aussi sur toi (tables, fonction, connecteur) : demande-le à un humain"
          : "pas exposé à ce run",
      };
    }
    case "rag":
      // search_knowledge est replié derrière search_context(scope="kb").
      return idx.has("search_context")
        ? { tools: ["search_context"], how: `search_context(scope="kb", query="…", collection_id="${r.source_id}")` }
        : idx.has("search_knowledge")
        ? { tools: ["search_knowledge"], how: `search_knowledge(query="…", collection_id="${r.source_id}")` }
        : { tools: [], how: "", blocked: "la recherche dans les connaissances n'est pas disponible sur ce run" };
    case "skill": {
      const slug = String(r.metadata?.slug ?? "");
      return idx.has("use_skill") && slug
        ? { tools: ["use_skill"], how: `use_skill(slug="${slug}")` }
        : { tools: [], how: "", blocked: "compétence non chargée sur ce run" };
    }
    case "workflow": {
      if (wfStatus !== "active") return { tools: [], how: "", blocked: wfStatus === "paused" ? "en pause" : "pas encore activée (brouillon)" };
      if (r.kind === "automation") {
        return idx.has("run_automation")
          ? { tools: ["run_automation"], how: `run_automation(id="${r.source_id}", payload={…})` }
          : { tools: [], how: "", blocked: "le lancement d'automatisations n'est pas disponible sur ce run" };
      }
      return idx.has("use_procedure")
        ? { tools: ["use_procedure"], how: `use_procedure(id="${r.source_id}")` }
        : { tools: [], how: "", blocked: "la lecture des procédures n'est pas disponible sur ce run" };
    }
    case "agent": {
      const fns = ["send_message_to_agent", "delegate_mission"].filter((n) => idx.has(n));
      return fns.length
        ? { tools: fns, how: fns.map((n) => `${n}(to_agent_id="${r.source_id}", …)`).join(" ou ") }
        : { tools: [], how: "", blocked: "la collaboration est coupée sur toi" };
    }
    case "guardrail":
      return { tools: [], how: "" };
  }
  return { tools: [], how: "", blocked: "type de ressource inconnu" };
}

export interface InventoryFilter {
  kind?: ResourceGroup;
  query?: string;
  /** Nom ou id d'un pool. */
  pool?: string;
  /** Collègues qui ne t'ont pas dans leurs pools (A2A non réciproque). */
  peerBlocked?: Set<string>;
}

function matchesPool(r: PoolResource, inv: PoolInventory, pool?: string): boolean {
  if (!pool) return true;
  const want = norm(pool);
  const p = inv.pools.find((x) => x.id === pool || norm(x.name) === want);
  return !!p && r.pools.includes(p.name);
}

function haystack(r: PoolResource, inv: PoolInventory): string {
  const parent = r.parent_id ? inv.parents.get(r.parent_id)?.name ?? "" : "";
  return norm(`${r.name} ${r.item_key} ${r.description ?? ""} ${parent} ${String(r.metadata?.slug ?? "")} ${toolkitOf(r)}`);
}

/** Le jeu (serveur, app, outil maison) auquel appartient une ressource outil. */
const setIdOf = (r: PoolResource) => (r.kind === "tool" && r.parent_id ? r.parent_id : r.id);

function itemLine(r: PoolResource, idx: ToolIndex, peerBlocked?: Set<string>): string {
  const u = usageOf(r, idx);
  const desc = short(r.description, 140);
  let line = `· « ${r.name} »`;
  if (r.kind === "guardrail") {
    const enf = String(r.metadata?.enforcement ?? "");
    return `${line}${enf ? ` [${enf}]` : ""}${desc ? ` — ${desc}` : ""}${u.blocked ? ` — désactivé` : ""}`;
  }
  if (desc) line += ` — ${desc}`;
  if (u.blocked) return `${line} — ✗ indisponible : ${u.blocked}`;
  if (r.kind === "agent" && peerBlocked?.has(r.source_id)) {
    return `${line} — ⚠ ne t'a pas dans ses pools : il ne pourra ni te répondre ni te rendre compte (refusé)`;
  }
  return `${line} → ${u.how}`;
}

function toolLines(rows: PoolResource[], inv: PoolInventory, idx: ToolIndex, filtered: boolean): string[] {
  const out: string[] = [];
  const builtins = rows.filter((r) => r.source === "builtin").sort((a, b) => a.name.localeCompare(b.name));
  const sets = new Map<string, PoolResource[]>();
  for (const r of rows) {
    if (r.source === "builtin") continue;
    const k = setIdOf(r);
    sets.set(k, [...(sets.get(k) ?? []), r]);
  }
  for (const [setId, members] of sets) {
    const head = members.find((m) => m.id === setId) ?? null;
    const parent = inv.parents.get(setId);
    const source = (head ?? members[0]).source;
    const name = head?.name ?? parent?.name ?? "?";
    const tools = members.filter((m) => m.kind === "tool").sort((a, b) => a.item_key.localeCompare(b.item_key));
    const headUsage = head ? usageOf(head, idx) : null;
    let line = `· ${SOURCE_LABEL[source] ?? source} « ${name} »`;
    if (head?.direct) line += " — toute la source";
    if (headUsage?.blocked) {
      out.push(`${line} — ✗ indisponible : ${headUsage.blocked}${tools.length ? ` (${tools.length} outil(s))` : ""}`);
      continue;
    }
    if (head && source !== "mcp") line += ` → ${headUsage!.how}`;
    out.push(line);
    const max = filtered ? TOOLS_PER_SOURCE_FILTERED : TOOLS_PER_SOURCE;
    for (const t of tools.slice(0, max)) {
      const u = usageOf(t, idx);
      const risk = RISK_LABEL[t.risk] ? ` [${RISK_LABEL[t.risk]}]` : "";
      out.push(u.blocked
        ? `  - ${t.item_key}${risk} — ✗ ${u.blocked}`
        : `  - ${t.item_key}${risk} → ${u.tools[0] ?? u.how}${source === "mcp" ? "" : ` (${source === "custom_connector" ? "operation" : "action"}="${t.item_key}")`}`);
    }
    if (tools.length > max) {
      out.push(`  … et ${tools.length - max} autre(s) : my_resources(query="…") pour filtrer, ou my_resources(id="${head?.source_id ?? parent?.source_id ?? setId}") pour tout voir`);
    }
  }
  for (const b of builtins) out.push(itemLine(b, idx));
  return out;
}

/** L'inventaire, groupé par nature, avec le geste de chaque ressource. */
export function inventoryText(inv: PoolInventory, idx: ToolIndex, f: InventoryFilter = {}): string {
  const q = norm(f.query?.trim());
  const rows = inv.items.filter((r) =>
    (!f.kind || groupOf(r) === f.kind) && matchesPool(r, inv, f.pool) && (!q || haystack(r, inv).includes(q)));
  const poolLine = inv.pools.map((p) => `« ${p.name} »${p.description ? ` (${short(p.description, 100)})` : ""}`).join(", ");
  const out: string[] = [
    `Tes pools : ${poolLine || "aucun"}. Tu n'atteins QUE ce qu'ils contiennent.`,
  ];
  if (!rows.length) {
    out.push(q || f.kind || f.pool
      ? "Rien ne correspond à ce filtre dans tes pools. Relance my_resources sans filtre pour tout voir."
      : "Tes pools sont vides : tu ne disposes que de tes outils de base. Demande à un humain d'y ajouter ce qu'il te faut.");
    return out.join("\n");
  }
  for (const g of RESOURCE_GROUPS) {
    const inGroup = rows.filter((r) => groupOf(r) === g);
    if (!inGroup.length) continue;
    out.push("", `${GROUP_LABEL[g]}`);
    if (g === "tools") out.push(...toolLines(inGroup, inv, idx, !!q));
    else out.push(...inGroup.sort((a, b) => a.name.localeCompare(b.name)).map((r) => itemLine(r, idx, f.peerBlocked)));
  }
  out.push("", "Mode d'emploi complet d'une ressource (paramètres, risque, détails) : my_resources(id=\"<nom de l'outil, id ou nom>\") — l'outil qui la sert devient appelable aussitôt.");
  return out.join("\n");
}

/**
 * Retrouve une ressource par ce que l'agent a sous les yeux : l'id du
 * registre, le nom de l'outil qui la sert, l'id de sa source (collection,
 * procédure, collègue…), son nom ou sa clé. Plusieurs candidates : on les rend
 * toutes, l'agent choisit.
 */
export function findResource(inv: PoolInventory, idx: ToolIndex, key: string): { match: PoolResource } | { candidates: PoolResource[] } {
  const k = key.trim();
  if (!k) return { candidates: [] };
  const byId = inv.items.find((r) => r.id === k);
  if (byId) return { match: byId };
  // Le nom d'outil : un outil MCP précis, ou une app / un outil maison entier
  // (sa ligne de source plutôt qu'une de ses actions).
  const byFn = inv.items.filter((r) => r.status === "active" && usageOf(r, idx).tools.includes(k) && r.source !== "agent");
  const pick = (list: PoolResource[]) => list.find((r) => r.kind === "toolset") ?? (list.length === 1 ? list[0] : null);
  if (byFn.length) {
    const p = pick(byFn);
    return p ? { match: p } : { candidates: byFn.slice(0, 12) };
  }
  const bySource = inv.items.filter((r) => r.source_id === k);
  if (bySource.length) {
    const p = pick(bySource);
    if (p) return { match: p };
  }
  const want = norm(k);
  const byName = inv.items.filter((r) => norm(r.name) === want || norm(r.item_key) === want || norm(String(r.metadata?.slug ?? "")) === want);
  if (byName.length === 1) return { match: byName[0] };
  if (byName.length > 1) return { candidates: byName };
  const loose = inv.items.filter((r) => norm(r.name).includes(want) || norm(r.item_key).includes(want));
  return loose.length === 1 ? { match: loose[0] } : { candidates: loose.slice(0, 12) };
}

/** Ce que l'outil my_resources a lu en plus pour la fiche d'une ressource. */
export interface ResourceDetails {
  /** Schéma des paramètres d'un outil MCP (JSON). */
  schema?: unknown;
  /** Opérations d'un outil maison, déjà décrites. */
  operations?: string[];
  /** Actions ouvertes d'une app (null : toute l'app). */
  actions?: string[] | null;
  /** Texte complet d'un garde-fou. */
  guardrailBody?: string | null;
  /** A2A non réciproque. */
  peerBlocked?: boolean;
  /** Une automatisation ou procédure qui sortirait des pools. */
  violations?: string[];
  /** Descriptions des outils d'une famille intégrée. */
  builtinDocs?: string[];
}

/** La fiche d'une ressource : tout ce qu'il faut pour s'en servir. */
export function resourceSheet(r: PoolResource, inv: PoolInventory, idx: ToolIndex, d: ResourceDetails = {}): string {
  const u = usageOf(r, idx);
  const parent = r.parent_id ? inv.parents.get(r.parent_id) : undefined;
  const out: string[] = [];
  const what = r.source === "workflow" ? (r.kind === "automation" ? "Automatisation" : "Procédure")
    : r.kind === "tool" ? `Outil${parent ? ` ${SOURCE_OF[r.source] ?? "de"} « ${parent.name} »` : ""}`
    : r.kind === "toolset" ? (SOURCE_LABEL[r.source] ?? "Source d'outils")
    : ({ knowledge: "Collection de connaissances", skill: "Compétence", agent: "Collègue", guardrail: "Garde-fou" } as Record<string, string>)[r.kind] ?? r.kind;
  out.push(`# ${what} : ${r.name}`);
  if (r.pools.length) out.push(`Pools : ${r.pools.map((p) => `« ${p} »`).join(", ")}${r.direct ? "" : " (avec sa source, donnée entière)"}`);
  if (RISK_LABEL[r.risk]) out.push(`Risque : ${RISK_LABEL[r.risk]}${r.risk !== "read" ? " — une écriture peut attendre une approbation humaine" : ""}`);
  if (r.description) out.push("", short(r.description, 1500));

  if (r.kind === "guardrail") {
    const enf = String(r.metadata?.enforcement ?? "");
    out.push("", `S'applique d'office${enf ? ` (${enf})` : ""} à tes réponses et à tes actions : respecte-le, tu n'as rien à appeler.`);
    if (d.guardrailBody) out.push("", "Texte complet :", short(d.guardrailBody, 3000));
    if (u.blocked) out.push("", "Il est désactivé pour l'instant.");
    return out.join("\n");
  }
  if (u.blocked) {
    out.push("", `✗ Indisponible : ${u.blocked}. Ne compte pas dessus ; fais sans, ou signale-le.`);
    return out.join("\n");
  }
  if (r.kind === "agent" && d.peerBlocked) {
    out.push("", "⚠ Ce collègue est en mode pools et ne t'a pas dans les siens : il ne pourrait ni te répondre ni te rendre compte. L'A2A est refusé tant qu'un humain ne t'y ajoute pas.");
    return out.join("\n");
  }
  if (d.violations?.length) {
    out.push("", `✗ Elle sortirait de tes pools : ${d.violations.join(" ; ")}. Son lancement sera refusé tant qu'un humain ne corrige pas le pool ou le workflow.`);
    return out.join("\n");
  }
  if (u.how) out.push("", `Comment t'en servir : ${u.how}`);

  if (r.kind === "toolset" && r.source === "mcp") {
    const fns = idx.mcpServerTools(r.source_id);
    const kids = inv.items.filter((x) => x.parent_id === r.id && x.kind === "tool");
    if (kids.length) {
      out.push("", "Ses outils :");
      for (const k of kids.sort((a, b) => a.item_key.localeCompare(b.item_key)).slice(0, 80)) {
        const ku = usageOf(k, idx);
        out.push(`- ${k.item_key}${RISK_LABEL[k.risk] ? ` [${RISK_LABEL[k.risk]}]` : ""}${ku.blocked ? ` — ✗ ${ku.blocked}` : ` → ${ku.tools[0]}`}${k.description ? ` : ${short(k.description, 120)}` : ""}`);
      }
    } else if (fns.length) out.push("", `Ses outils : ${fns.join(", ")}`);
    out.push("", "Demande la fiche de l'outil précis qu'il te faut : my_resources(id=\"<nom de l'outil>\").");
  }
  if (d.schema !== undefined) {
    let json = "";
    try { json = JSON.stringify(d.schema); } catch { /* schéma illisible */ }
    if (json) out.push("", `Paramètres (JSON Schema) : ${json.length > 3000 ? `${json.slice(0, 3000)}…` : json}`);
  }
  if (d.actions !== undefined) {
    out.push("", d.actions === null
      ? "Toute l'app t'est ouverte : appelle l'outil sans action pour lister ses actions et leurs paramètres."
      : `Actions ouvertes par tes pools : ${d.actions.join(", ") || "aucune"}. Les autres seront refusées.`);
  }
  if (d.operations?.length) out.push("", r.source === "custom_connector" ? "Opérations :" : "Actions :", ...d.operations.map((o) => `- ${o}`));
  if (d.builtinDocs?.length) out.push("", ...d.builtinDocs.map((o) => `- ${o}`));
  if (r.kind === "procedure") out.push("", "Lis-la avec use_procedure, puis suis-la toi-même dans ce run. mode=\"run\" la lance à part, confiée à l'assistant de son service.");
  if (r.kind === "automation") out.push("", "Le moteur l'exécute en quelques secondes et te rend son résultat. payload = les données d'entrée qu'elle attend (ce que son déclencheur lui passerait).");
  if (u.tools.length) out.push("", `Appelable dès maintenant : ${u.tools.join(", ")}.`);
  return out.join("\n");
}
