// Ce qu'un agent en mode pools découvre de ses pools (0291) : l'inventaire,
// la fiche d'une ressource, et les outils qui les servent — my_resources,
// run_automation, use_procedure — branchés dans le vrai toolset.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { scopeFromItems, loadPoolInventory, forgetPoolScope } = await import("../edge/_shared/resource-pools.ts");
const { inventoryText, findResource, resourceSheet, usageOf } = await import("../edge/_shared/pool-discovery.ts");
const { buildInternalToolset } = await import("../edge/_shared/internal-agent-tools.ts");

type Row = Record<string, unknown>;
type Query = { table: string; eq: Record<string, unknown>; in: Record<string, unknown[]>; cols: string };
type Handler = (q: Query) => { data?: unknown; error?: { message: string } | null; count?: number };

/** Un client Supabase réduit : chaque table répond selon les filtres reçus. */
function fakeAdmin(tables: Record<string, Handler>) {
  return {
    from(table: string) {
      const q: Query = { table, eq: {}, in: {}, cols: "" };
      const run = () => {
        const h = tables[table];
        const r = h ? h(q) : { data: [] };
        return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null };
      };
      const chain: Record<string, unknown> = {
        select: (cols: string) => { q.cols = cols; return chain; },
        eq: (k: string, v: unknown) => { q.eq[k] = v; return chain; },
        in: (k: string, v: unknown[]) => { q.in[k] = v; return chain; },
        neq: () => chain, gte: () => chain, order: () => chain, limit: () => chain,
        maybeSingle: () => {
          const r = run();
          return Promise.resolve({ ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data });
        },
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, ko),
      };
      return chain;
    },
  };
}

const AGENT = "a-1";
const reg = (id: string, kind: string, source: string, sourceId: string, name: string, extra: Partial<Row> = {}): Row => ({
  id, kind, source, source_id: sourceId, item_key: "", parent_id: null, name, description: null,
  risk: "unknown", status: "active", metadata: {}, ...extra,
});

// Ce que contiennent les pools « Support » (p1) et « Infra » (p2).
const P1 = [
  reg("r-git-pr", "tool", "mcp", "srv-git", "open_pr", { item_key: "open_pr", parent_id: "r-git", risk: "write" }),
  reg("r-gmail", "toolset", "composio", "conn-gmail", "Gmail", { metadata: { toolkit: "gmail" } }),
  reg("r-web", "toolset", "builtin", "proj", "Recherche web", { item_key: "web_search", risk: "read" }),
  reg("r-db", "toolset", "builtin", "proj", "Lecture de tables", { item_key: "db_read", risk: "read", metadata: { requires_config: true } }),
  reg("r-col", "knowledge", "rag", "col-1", "Docs produit", { description: "Notices et FAQ", risk: "read" }),
  reg("r-skill", "skill", "skill", "sk-1", "Rédaction", { metadata: { slug: "redaction" } }),
  reg("r-proc", "procedure", "workflow", "wf-proc", "Réclamation client", { description: "Quand un client se plaint", metadata: { workflow_status: "active" } }),
  reg("r-auto", "automation", "workflow", "wf-auto", "Relance facture", { metadata: { workflow_status: "active" } }),
  reg("r-auto-off", "automation", "workflow", "wf-off", "Archivage", { metadata: { workflow_status: "paused" } }),
  reg("r-lea", "agent", "agent", "agent-b", "Léa"),
  reg("r-max", "agent", "agent", "agent-c", "Max"),
  reg("r-g", "guardrail", "guardrail", "g-1", "Pas de numéro de carte", { metadata: { enforcement: "block" } }),
];
const P2 = [
  reg("r-k8s", "toolset", "mcp", "srv-k8s", "k8s"),
  reg("r-graf", "toolset", "custom_connector", "cc-1", "Grafana", { status: "unavailable" }),
];
// Les outils du serveur k8s, donné entier : ils viennent avec lui.
const K8S_TOOLS = [
  reg("r-k8s-list", "tool", "mcp", "srv-k8s", "pods_list", { item_key: "pods_list", parent_id: "r-k8s", risk: "read" }),
  reg("r-k8s-del", "tool", "mcp", "srv-k8s", "pods_delete", { item_key: "pods_delete", parent_id: "r-k8s", risk: "destructive" }),
  reg("r-k8s-hidden", "tool", "mcp", "srv-k8s", "node_drain", { item_key: "node_drain", parent_id: "r-k8s", risk: "write" }),
];

const WORKFLOWS: Record<string, Row> = {
  "wf-proc": { id: "wf-proc", name: "Réclamation client", description: "Quand un client se plaint", document: "1. Lire\n2. Répondre", status: "active", kind: "procedure", service_dashboard_id: "dash-other", workspace_id: "ws-1", blocks: { nodes: [] } },
  "wf-auto": { id: "wf-auto", name: "Relance facture", status: "active", kind: "automation", workspace_id: "ws-1", blocks: { nodes: [{ type: "step", data: { agent_id: "agent-z" } }] } },
  "wf-off": { id: "wf-off", name: "Archivage", status: "paused", kind: "automation", workspace_id: "ws-1", blocks: { nodes: [] } },
  "wf-out": { id: "wf-out", name: "Hors pool", description: null, document: "x", status: "active", kind: "procedure", service_dashboard_id: "dash-1", workspace_id: "ws-1", blocks: { nodes: [] } },
};

const admin = fakeAdmin({
  agent_resource_pools: (q) => {
    if (q.eq.agent_id === AGENT) return { data: [{ pool_id: "p1", pool: { id: "p1", name: "Support" } }, { pool_id: "p2", pool: { id: "p2", name: "Infra" } }] };
    // Max est en mode pools, et ses pools ne contiennent pas a-1.
    if (q.eq.agent_id === "agent-c") return { data: [{ pool_id: "p9", pool: { id: "p9", name: "Autre" } }] };
    return { data: [] };
  },
  resource_pool_items: (q) => {
    const ids = (q.in.pool_id ?? []) as string[];
    return { data: [...(ids.includes("p1") ? P1.map((r) => ({ pool_id: "p1", registry: r })) : []), ...(ids.includes("p2") ? P2.map((r) => ({ pool_id: "p2", registry: r })) : [])] };
  },
  resource_pools: () => ({ data: [{ id: "p1", name: "Support", description: "Le kit du support" }, { id: "p2", name: "Infra", description: null }] }),
  resource_registry: (q) => {
    if (q.in.parent_id) return { data: K8S_TOOLS.filter((t) => (q.in.parent_id as string[]).includes(t.parent_id as string)) };
    if (q.in.id) return { data: (q.in.id as string[]).includes("r-git") ? [{ id: "r-git", name: "git", source_id: "srv-git", status: "active", metadata: {} }] : [] };
    return { data: [] };
  },
  agent_workflows: (q) => {
    if (q.eq.id) return { data: WORKFLOWS[q.eq.id as string] ?? null };
    if (q.in.id) return { data: (q.in.id as string[]).map((id) => WORKFLOWS[id]).filter(Boolean) };
    return { data: [] };
  },
  agent_workflow_runs: () => ({ data: null, count: 0 }),
  aiops_guardrails: () => ({ data: { body: "Ne recopie jamais un numéro de carte bancaire, même partiel." } }),
  internal_agents: () => ({ data: [{ id: "agent-z", name: "Zoé" }] }),
}) as never;

const scope = scopeFromItems(AGENT, [{ id: "p1", name: "Support" }, { id: "p2", name: "Infra" }], [...P1, ...P2] as never);

/** Le toolset tel qu'un run en mode pools le construit. */
function toolset(opts: { unlocked?: string[]; onUnlock?: (n: string[]) => void; poolScope?: unknown } = {}) {
  const ctx = {
    admin, workspaceId: "ws-1", projectId: "proj", agentId: AGENT, agentName: "Agent", runId: "r-1",
    serviceDashboardId: "dash-1", collaborationEnabled: true,
    requestApproval: async () => "", logEvent: async () => {}, isCancelled: async () => false,
    poolScope: "poolScope" in opts ? opts.poolScope : scope,
    unlockedTools: opts.unlocked ?? [],
    onToolsUnlocked: async (n: string[]) => opts.onUnlock?.(n),
    skills: [{ id: "sk-1", slug: "redaction", name: "Rédaction", description: null, instructions: "…" }],
    mcpServers: [{
      id: "srv-k8s", name: "k8s", url: "https://mcp.example/k8s", headers: {},
      tools: [
        { name: "pods_list", description: "Liste les pods", inputSchema: { type: "object", properties: { namespace: { type: "string" } }, required: ["namespace"] } },
        { name: "pods_delete", description: "Supprime un pod" },
      ],
    }],
    customConnectors: [],
  } as never;
  const rows = [
    { id: "t-web", kind: "web_search", name: "Recherche web", description: null, config: {}, enabled: true, requires_approval: false },
    { id: "t-gmail", kind: "composio_toolkit", name: "Gmail", description: null, config: { toolkit: "gmail" }, enabled: true, requires_approval: false },
    { id: "t-rag", kind: "rag_search", name: "Docs", description: null, config: { collection_ids: ["col-1"] }, enabled: true, requires_approval: false },
  ] as never;
  return buildInternalToolset(rows, ctx);
}

describe("découverte des pools : la portée", () => {
  it("sépare les procédures (à suivre) des automatisations (à lancer)", () => {
    assert.deepEqual([...scope.procedures], ["wf-proc"]);
    assert.deepEqual([...scope.automations].sort(), ["wf-auto", "wf-off"]);
    assert.equal(scope.workflows.size, 3);
  });
});

describe("découverte des pools : l'inventaire", () => {
  it("rapporte ce qui est dans les pools, avec les outils d'une source donnée entière et le nom de la source d'un outil seul", async () => {
    forgetPoolScope();
    const inv = await loadPoolInventory(admin, scope);
    assert.deepEqual(inv.pools.map((p) => p.name), ["Support", "Infra"]);
    const keys = inv.items.map((r) => r.id).sort();
    assert.ok(keys.includes("r-k8s-list") && keys.includes("r-k8s-del"), keys.join(", "));
    assert.equal(inv.items.find((r) => r.id === "r-k8s-list")!.direct, false);
    assert.deepEqual(inv.items.find((r) => r.id === "r-k8s-list")!.pools, ["Infra"]);
    assert.equal(inv.parents.get("r-git")?.name, "git");
  });

  it("groupe par nature et donne le geste de chaque ressource ; l'indisponible et l'A2A non réciproque sont dits", async () => {
    forgetPoolScope();
    const out = await toolset().executor("my_resources", {});
    assert.match(out, /Tes pools : « Support » \(Le kit du support\), « Infra »/);
    assert.match(out, /Serveur MCP « k8s » — toute la source/);
    assert.match(out, /pods_list \[lecture\] → mcp_k8s_pods_list/);
    assert.match(out, /pods_delete \[DESTRUCTIF\] → mcp_k8s_pods_delete/);
    assert.match(out, /node_drain \[écriture\] — ✗ pas exposé à ce run/, "un outil du registre que le serveur n'expose pas");
    assert.match(out, /Serveur MCP « git »\n  - open_pr \[écriture\] — ✗ pas exposé/, "l'outil seul est rangé sous sa source");
    assert.match(out, /App « Gmail » — toute la source → use_gmail\(\) liste ses actions/);
    assert.match(out, /Outil maison « Grafana » — toute la source — ✗ indisponible : désactivée ou déconnectée/);
    assert.match(out, /« Recherche web » → web_search/);
    assert.match(out, /« Lecture de tables » — ✗ indisponible : ton pool l'autorise, mais cet outil se configure aussi sur toi/);
    assert.match(out, /« Docs produit » — Notices et FAQ → search_context\(scope="kb", query="…", collection_id="col-1"\)/);
    assert.match(out, /« Rédaction » → use_skill\(slug="redaction"\)/);
    assert.match(out, /« Réclamation client » — Quand un client se plaint → use_procedure\(id="wf-proc"\)/);
    assert.match(out, /« Relance facture » → run_automation\(id="wf-auto"/);
    assert.match(out, /« Archivage » — ✗ indisponible : en pause/);
    assert.match(out, /« Léa » → send_message_to_agent\(to_agent_id="agent-b"/);
    assert.match(out, /« Max » — ⚠ ne t'a pas dans ses pools/);
    assert.match(out, /GARDE-FOUS[^\n]*\n· « Pas de numéro de carte » \[block\]/);
  });

  it("filtre par mot-clé, accents ignorés, et par nature", async () => {
    forgetPoolScope();
    const ts = toolset();
    const pods = await ts.executor("my_resources", { query: "POD" });
    assert.match(pods, /pods_list/);
    assert.doesNotMatch(pods, /Gmail|Docs produit/);
    const recl = await ts.executor("my_resources", { query: "reclamation" });
    assert.match(recl, /Réclamation client/);
    const agents = await ts.executor("my_resources", { kind: "agents" });
    assert.match(agents, /Léa/);
    assert.doesNotMatch(agents, /k8s|Gmail/);
    assert.match(await ts.executor("my_resources", { query: "zzz" }), /Rien ne correspond/);
  });
});

describe("découverte des pools : la fiche et le déverrouillage", () => {
  it("retrouve une ressource par le nom de son outil, l'id de sa source ou son nom", async () => {
    forgetPoolScope();
    const inv = await loadPoolInventory(admin, scope);
    const ts = toolset();
    // L'index du toolset sert à traduire ; on le reconstruit ici par l'usage.
    const idx = {
      mcp: (s: string, t: string) => (s === "srv-k8s" && ["pods_list", "pods_delete"].includes(t) ? `mcp_k8s_${t}` : null),
      mcpServerTools: (s: string) => (s === "srv-k8s" ? ["mcp_k8s_pods_list", "mcp_k8s_pods_delete"] : []),
      composio: (tk: string) => (tk === "gmail" ? "use_gmail" : null),
      app: () => null,
      custom: () => null,
      builtin: (f: string) => (f === "web_search" ? ["web_search"] : []),
      has: (n: string) => ts.defsFor("full").some((d) => d.function.name === n),
    };
    const m = (k: string) => { const f = findResource(inv, idx, k); return "match" in f ? f.match.id : `candidates:${f.candidates.length}`; };
    assert.equal(m("mcp_k8s_pods_list"), "r-k8s-list");
    assert.equal(m("use_gmail"), "r-gmail");
    assert.equal(m("col-1"), "r-col");
    assert.equal(m("wf-auto"), "r-auto");
    assert.equal(m("relance facture"), "r-auto");
    assert.equal(m("redaction"), "r-skill", "par le slug");
    assert.equal(m("inexistant"), "candidates:0");
    assert.equal(usageOf(inv.items.find((r) => r.id === "r-g")!, idx).how, "", "un garde-fou s'applique seul");
  });

  it("la fiche d'un outil MCP porte son schéma, et l'outil devient appelable sur-le-champ", async () => {
    forgetPoolScope();
    const unlocked: string[][] = [];
    const ts = toolset({ onUnlock: (n) => unlocked.push(n) });
    const before = ts.defsFor("core").map((d) => d.function.name);
    assert.ok(!before.includes("mcp_k8s_pods_list"), "la famille INTEGRATIONS n'est pas chargée d'office");
    assert.ok(before.includes("my_resources"), "my_resources est toujours là");
    const sheet = await ts.executor("my_resources", { id: "mcp_k8s_pods_list" });
    assert.match(sheet, /# Outil du serveur MCP « k8s » : pods_list/);
    assert.match(sheet, /Pools : « Infra » \(avec sa source, donnée entière\)/);
    assert.match(sheet, /"required":\["namespace"\]/);
    assert.match(sheet, /Appelable dès maintenant : mcp_k8s_pods_list/);
    assert.deepEqual(unlocked, [["mcp_k8s_pods_list"]]);
    assert.ok(ts.defsFor("core").some((d) => d.function.name === "mcp_k8s_pods_list"));
    // Et pas son voisin : on ne charge pas tout le serveur pour un outil.
    assert.ok(!ts.defsFor("core").some((d) => d.function.name === "mcp_k8s_pods_delete"));
  });

  it("les outils déverrouillés à un tick précédent le restent", () => {
    const ts = toolset({ unlocked: ["mcp_k8s_pods_delete"] });
    assert.ok(ts.defsFor("core").some((d) => d.function.name === "mcp_k8s_pods_delete"));
  });

  it("l'inventaire rend appelables les gestes génériques, pas les outils des sources", async () => {
    forgetPoolScope();
    const unlocked: string[] = [];
    const ts = toolset({ onUnlock: (n) => unlocked.push(...n) });
    await ts.executor("my_resources", {});
    assert.ok(unlocked.includes("search_context") && unlocked.includes("run_automation") && unlocked.includes("use_procedure"), unlocked.join(", "));
    assert.ok(!unlocked.some((n) => n.startsWith("mcp_") || n === "use_gmail"), unlocked.join(", "));
  });

  it("une automatisation qui sortirait des pools se dit sur sa fiche, et ne déverrouille rien", async () => {
    forgetPoolScope();
    const unlocked: string[] = [];
    const ts = toolset({ onUnlock: (n) => unlocked.push(...n) });
    const sheet = await ts.executor("my_resources", { id: "wf-auto" });
    assert.match(sheet, /✗ Elle sortirait de tes pools : il fait intervenir « Zoé », absent de ses pools/);
    assert.deepEqual(unlocked, []);
  });

  it("la fiche d'un garde-fou en donne le texte entier", async () => {
    forgetPoolScope();
    const sheet = await toolset().executor("my_resources", { id: "g-1" });
    assert.match(sheet, /S'applique d'office \(block\)/);
    assert.match(sheet, /Ne recopie jamais un numéro de carte bancaire/);
  });

  it("un collègue qui ne nous a pas dans ses pools : la fiche le dit, rien n'est déverrouillé", async () => {
    forgetPoolScope();
    const unlocked: string[] = [];
    const sheet = await toolset({ onUnlock: (n) => unlocked.push(...n) }).executor("my_resources", { id: "agent-c" });
    assert.match(sheet, /ne t'a pas dans les siens/);
    assert.deepEqual(unlocked, []);
  });

  it("resourceSheet : une ressource disparue ne se propose pas", () => {
    const inv = { pools: [], items: [], parents: new Map() };
    const r = { ...reg("x", "tool", "mcp", "srv", "gone", { item_key: "gone", status: "removed" }), pools: ["Infra"], direct: true, metadata: {} } as never;
    const idx = { mcp: () => "mcp_srv_gone", mcpServerTools: () => [], composio: () => null, app: () => null, custom: () => null, builtin: () => [], has: () => true };
    assert.match(resourceSheet(r, inv as never, idx), /✗ Indisponible : n'existe plus sur sa source/);
  });
});

describe("découverte des pools : les outils qui servent les ressources", () => {
  it("sans pool : ni my_resources ni run_automation", () => {
    const names = toolset({ poolScope: null }).defsFor("full").map((d) => d.function.name);
    assert.ok(!names.includes("my_resources") && !names.includes("run_automation"), names.join(", "));
    assert.ok(names.includes("use_procedure"), "le comportement d'avant : les procédures du service");
  });

  it("le prompt annonce les pools et ce qu'ils contiennent", () => {
    const { capabilitySummary } = toolset();
    assert.match(capabilitySummary, /MODE POOLS — tes pools : « Support », « Infra » \(5 sources d'outils, 1 collection, 1 compétence, 1 procédure, 2 automatisations, 2 collègues, 1 garde-fou\)/);
    // Rangés dans leur vraie famille : appelables d'office, pas « à charger ».
    assert.match(capabilitySummary, /## PLAN & PROGRESS\n[^#]*- my_resources:/);
    assert.match(capabilitySummary, /## PLAN & PROGRESS\n[^#]*- use_procedure:/);
  });

  it("use_procedure suit les pools : il liste les leurs, d'un autre service aussi, et refuse le reste", async () => {
    forgetPoolScope();
    const ts = toolset();
    const list = JSON.parse(await ts.executor("use_procedure", {}));
    assert.deepEqual(list.map((r: { id: string }) => r.id), ["wf-proc"]);
    assert.match(await ts.executor("use_procedure", { id: "wf-proc" }), /# Procédure : Réclamation client/);
    assert.match(await ts.executor("use_procedure", { id: "wf-out" }), /hors des ressources de cet agent/);
    assert.match(await ts.executor("use_procedure", { id: "wf-auto" }), /est une automatisation : lance-la avec run_automation/);
  });

  it("run_automation liste, refuse ce qui est en pause, hors pool, une procédure, ou ce qui sortirait des pools", async () => {
    forgetPoolScope();
    const ts = toolset();
    const list = JSON.parse(await ts.executor("run_automation", {}));
    assert.deepEqual(list.map((r: { id: string; lançable: string }) => [r.id, r.lançable]).sort(), [["wf-auto", "oui"], ["wf-off", "non (en pause)"]]);
    assert.match(await ts.executor("run_automation", { id: "wf-off" }), /est en pause : ne la lance pas/);
    assert.match(await ts.executor("run_automation", { id: "wf-proc" }), /est une procédure : lis-la avec use_procedure/);
    assert.match(await ts.executor("run_automation", { id: "wf-out" }), /hors des ressources de cet agent/);
    assert.match(await ts.executor("run_automation", { id: "wf-auto" }), /sortirait de tes pools : il fait intervenir « Zoé »/);
  });

  it("search_context(kb) cherche dans une seule collection, à condition qu'elle soit ouverte", async () => {
    const ts = toolset();
    const def = ts.defsFor("full").find((d) => d.function.name === "search_context")!;
    assert.ok("collection_id" in (def.function.parameters as { properties: Record<string, unknown> }).properties);
    assert.match(await ts.executor("search_context", { scope: "kb", query: "x", collection_id: "col-9" }), /is not one of yours/);
  });
});
