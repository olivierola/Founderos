// L'index de recherche des agents (migration 0308) sur une vraie base PGlite,
// toutes migrations comprises : le remplissage par les triggers, le pliage des
// accents, la recherche en début de mot, la portée (un agent ne lit pas la
// mémoire d'un autre), et le grep du harnais branché dessus.
//
// Lent (les migrations, ~20 s) : PLATFORM_E2E=0 le saute.

process.env.PLATFORM = "self";
process.env.DATABASE_URL = "pglite://memory";
process.env.JWT_SECRET = "e2e-secret-e2e-secret-e2e-secret-e2e-secret";
process.env.FUNCTIONS_URL = "http://localhost:18793";
process.env.STORAGE_DIR = `${process.env.TEMP ?? "/tmp"}/founderos-search-e2e-${process.pid}`;
process.env.MGMT_PORT = "0";
delete process.env.AUTH_SMTP_HOST;
delete process.env.RESEND_API_KEY;

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { newContextState } from "./toolkit/context.ts";
import { grep, rpcSearchIndex, type IndexRow, type Rpc } from "./toolkit/grep.ts";

const skip = process.env.PLATFORM_E2E === "0";

describe("index de recherche des agents (0308)", { skip, timeout: 240_000 }, () => {
  let platform: import("../platform/platform.ts").Platform;
  const id: Record<string, string> = {};
  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => platform.db.query<T>(sql, params);
  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];

  // search_grep et search_read appelés comme le ferait PostgREST.
  const rpc: Rpc = async (fn, a) => (fn === "search_grep"
    ? await q<Record<string, unknown>>(
      "select * from public.search_grep($1, $2, $3, $4::text[], $5::text[], $6, $7, $8, $9, $10::uuid[])",
      [a.p_workspace, a.p_project, a.p_agent, a.p_types, a.p_regexes, a.p_all, a.p_path, a.p_limit, a.p_offset, a.p_collections])
    : await q<Record<string, unknown>>(
      "select * from public.search_read($1, $2, $3, $4::uuid[], $5, 60, $6::uuid[])",
      [a.p_workspace, a.p_project, a.p_agent, a.p_ids, a.p_whole, a.p_collections])) as unknown as IndexRow[];
  const indexOf = (agent: string, collections: string[] | null = null) =>
    rpcSearchIndex(rpc, { workspaceId: id.ws, projectId: id.project, agentId: agent, collections });
  const ALL = ["documents", "memory", "team", "facts", "past_work", "artifacts", "conversation"];

  before(async () => {
    const { env } = await import("../env.ts");
    const { startPlatform } = await import("../platform/platform.ts");
    platform = await startPlatform({
      ...env.platform!, publicUrl: env.functionsUrl, anonKey: env.supabaseAnonKey, serviceKey: env.supabaseServiceRoleKey,
    }, () => {});

    id.ws = (await one<{ id: string }>("insert into public.workspaces (name, slug) values ('Espace', 'espace-search') returning id"))!.id;
    // L'offre gratuite limite le nombre d'agents : le test en crée plusieurs.
    await q(`insert into public.workspace_subscriptions (workspace_id, plan_code) values ($1, 'enterprise')
       on conflict (workspace_id) do update set plan_code = 'enterprise'`, [id.ws]);
    id.project = (await one<{ id: string }>("insert into public.projects (workspace_id, name, slug) values ($1, 'Projet', 'projet-search') returning id", [id.ws]))!.id;
    const agent = async (name: string) => (await one<{ id: string }>(
      "insert into public.internal_agents (workspace_id, project_id, name) values ($1, $2, $3) returning id", [id.ws, id.project, name]))!.id;
    id.a = await agent("Compta");
    id.b = await agent("Ventes");

    id.coll = (await one<{ id: string }>("insert into public.rag_collections (workspace_id, project_id, name) values ($1, $2, 'Contrats clients') returning id", [id.ws, id.project]))!.id;
    id.src = (await one<{ id: string }>(
      "insert into public.rag_sources (workspace_id, project_id, type, title, source_ref, collection_id) values ($1, $2, 'document', 'Contrat cadre Acme 2026', 'acme.pdf', $3) returning id",
      [id.ws, id.project, id.coll]))!.id;
    const chunk = async (content: string) => (await one<{ id: string }>(
      "insert into public.rag_chunks (workspace_id, project_id, source_id, collection_id, content) values ($1, $2, $3, $4, $5) returning id",
      [id.ws, id.project, id.src, id.coll, content]))!.id;
    id.c1 = await chunk("Article 4 : le délai de paiement des factures est de 45 jours\nfin de mois, par virement.");
    id.c2 = await chunk("Article 6 : pénalités de retard de 3 %. Rien de préfacturé.");

    // Une seconde collection, que l'agent restreint aux contrats ne doit jamais lire.
    id.collRh = (await one<{ id: string }>("insert into public.rag_collections (workspace_id, project_id, name) values ($1, $2, 'RH') returning id", [id.ws, id.project]))!.id;
    id.srcRh = (await one<{ id: string }>(
      "insert into public.rag_sources (workspace_id, project_id, type, title, collection_id) values ($1, $2, 'document', 'Grille des salaires', $3) returning id",
      [id.ws, id.project, id.collRh]))!.id;
    id.rh = (await one<{ id: string }>(
      "insert into public.rag_chunks (workspace_id, project_id, source_id, collection_id, content) values ($1, $2, $3, $4, 'Salaire du directeur : confidentiel. Contrat Acme cité.') returning id",
      [id.ws, id.project, id.srcRh, id.collRh]))!.id;

    id.memA = (await one<{ id: string }>(
      "insert into public.internal_agent_memories (agent_id, workspace_id, project_id, kind, content) values ($1, $2, $3, 'fact', 'Les factures Acme partent le 5 du mois.') returning id",
      [id.a, id.ws, id.project]))!.id;
    await q("insert into public.internal_agent_memories (agent_id, workspace_id, project_id, kind, content) values ($1, $2, $3, 'fact', 'Secret des ventes : remise Acme de 12 %.')", [id.b, id.ws, id.project]);

    id.entity = (await one<{ id: string }>(
      "insert into public.knowledge_entities (workspace_id, key, name, kind, summary, aliases) values ($1, 'acme-sas', 'Acme SAS', 'customer', 'Client industriel', array['ACME']) returning id",
      [id.ws]))!.id;
    id.fact = (await one<{ id: string }>(
      "insert into public.knowledge_facts (workspace_id, entity_id, key, statement, kind) values ($1, $2, 'paiement', 'Acme SAS règle ses factures par virement.', 'fact') returning id",
      [id.ws, id.entity]))!.id;

    id.conv = (await one<{ id: string }>(
      "insert into public.internal_agent_conversations (agent_id, workspace_id, project_id, title) values ($1, $2, $3, 'Relances') returning id",
      [id.a, id.ws, id.project]))!.id;
    await q("insert into public.internal_agent_messages (conversation_id, agent_id, role, content) values ($1, $2, 'user', 'Relance la FACTURATION de Globex.'), ($1, $2, 'tool', 'facturation brute')",
      [id.conv, id.a]);
  });

  after(async () => { await platform?.close(); });

  it("les triggers remplissent l'index, avec type, chemin et groupe", async () => {
    const rows = await q<{ type: string; path: string; grp: string; agent_id: string | null }>(
      "select type, path, grp, agent_id from public.search_index where workspace_id = $1 order by type, path", [id.ws]);
    const paths = rows.map((r) => `${r.type} ${r.path}`);
    assert.ok(paths.includes("documents documents/contrats-clients/contrat-cadre-acme-2026"), paths.join("\n"));
    assert.ok(paths.includes("facts facts/customer/acme-sas"));
    assert.ok(paths.some((p) => /^conversation conversation\/relances-[0-9a-f]{8}\/user$/.test(p)));
    // Les messages d'outil ne sont pas indexés.
    assert.equal(rows.filter((r) => r.type === "conversation").length, 1);
    assert.equal(rows.filter((r) => r.grp === `doc:${id.src}`).length, 2);
  });

  it("sans accents ni majuscules, en début de mot : « delai » trouve « délai », « factur » ne trouve pas « préfacturé »", async () => {
    const delai = await indexOf(id.a).grep({ types: ALL, regexes: ["\\mdelai"], all: true, path: null, limit: 10, offset: 0 });
    assert.deepEqual(delai.map((r) => r.source_id), [id.c1]);
    const factur = await indexOf(id.a).grep({ types: ["documents"], regexes: ["\\mfactur"], all: true, path: null, limit: 10, offset: 0 });
    assert.deepEqual(factur.map((r) => r.source_id), [id.c1]);
  });

  it("un agent lit sa mémoire et ce qui est partagé, jamais la mémoire d'un autre agent", async () => {
    const a = await indexOf(id.a).grep({ types: ALL, regexes: ["\\macme"], all: true, path: null, limit: 20, offset: 0 });
    const texts = a.map((r) => r.content).join("\n");
    assert.match(texts, /partent le 5 du mois/);
    assert.doesNotMatch(texts, /Secret des ventes/);
    const b = await indexOf(id.b).grep({ types: ["memory", "conversation"], regexes: ["\\macme", "\\mfactur"], all: false, path: null, limit: 20, offset: 0 });
    assert.deepEqual(b.map((r) => r.content), ["Secret des ventes : remise Acme de 12 %."]);
  });

  it("mode pools : un agent limité à ses collections ne trouve ni ne relit rien d'une autre", async () => {
    const find = (collections: string[] | null) => indexOf(id.a, collections)
      .grep({ types: ["documents"], regexes: ["\\msalaire", "\\macme"], all: false, path: null, limit: 20, offset: 0 })
      .then((rows) => rows.map((r) => r.source_id).sort());
    // Tout le projet (hors pools, sans collection désignée).
    assert.ok((await find(null)).includes(id.rh));
    // Ses collections seulement.
    assert.deepEqual(await find([id.coll]), [id.c1, id.c2].sort());
    // Aucune collection : aucun document.
    assert.deepEqual(await find([]), []);
    // Ni par l'identifiant d'une ligne interdite, ni par « tout le document ».
    const [rhRow] = await indexOf(id.a, null).grep({ types: ["documents"], regexes: ["\\msalaire"], all: true, path: null, limit: 1, offset: 0 });
    assert.deepEqual(await indexOf(id.a, [id.coll]).read([rhRow.id], true), []);
    // Les autres types ne dépendent pas des collections.
    const facts = await indexOf(id.a, []).grep({ types: ["facts"], regexes: ["\\macme"], all: true, path: null, limit: 5, offset: 0 });
    assert.ok(facts.length > 0);
  });

  it("score : les sources qui ont le plus de mots d'abord ; chemin à la manière d'un glob", async () => {
    const rows = await indexOf(id.a).grep({ types: ALL, regexes: ["\\mfactur", "\\mvirement"], all: false, path: null, limit: 20, offset: 0 });
    assert.ok(rows[0].score >= 2, JSON.stringify(rows.map((r) => [r.path, r.score])));
    const facts = await indexOf(id.a).grep({ types: ALL, regexes: ["\\macme"], all: false, path: "facts/customer/%", limit: 20, offset: 0 });
    assert.ok(facts.length > 0 && facts.every((r) => r.path.startsWith("facts/customer/")));
  });

  it("search_read relit une source, ou tout son document", async () => {
    const [hit] = await indexOf(id.a).grep({ types: ["documents"], regexes: ["\\mdelai"], all: true, path: null, limit: 1, offset: 0 });
    assert.equal((await indexOf(id.a).read([hit.id], false)).length, 1);
    const whole = await indexOf(id.a).read([hit.id], true);
    assert.deepEqual(whole.map((r) => r.source_id), [id.c1, id.c2]);
  });

  it("les triggers suivent les changements : contenu modifié, mémoire supprimée, fait remplacé, entité renommée", async () => {
    await q("update public.rag_chunks set content = 'Article 4 : échéance à 60 jours.' where id = $1", [id.c1]);
    assert.equal((await one<{ n: number }>("select count(*)::int as n from public.search_index where source_id = $1 and doc like '%60 jours%'", [id.c1]))!.n, 1);
    await q("delete from public.internal_agent_memories where id = $1", [id.memA]);
    assert.equal((await one<{ n: number }>("select count(*)::int as n from public.search_index where source_id = $1", [id.memA]))!.n, 0);
    await q("update public.knowledge_entities set name = 'Acme Industries' where id = $1", [id.entity]);
    assert.equal((await one<{ path: string }>("select path from public.search_index where source_id = $1", [id.fact]))!.path, "facts/customer/acme-industries");
    const newer = (await one<{ id: string }>(
      "insert into public.knowledge_facts (workspace_id, entity_id, key, statement) values ($1, $2, 'paiement-2', 'Acme Industries paie par prélèvement.') returning id",
      [id.ws, id.entity]))!.id;
    await q("update public.knowledge_facts set superseded_by = $1 where id = $2", [newer, id.fact]);
    assert.equal((await one<{ n: number }>("select count(*)::int as n from public.search_index where source_id = $1", [id.fact]))!.n, 0);
  });

  it("le grep du harnais, branché sur la base : lignes trouvées et sources numérotées", async () => {
    const state = newContextState();
    const out = await grep(indexOf(id.a), state, { pattern: "Globex facturation" }, ALL);
    assert.match(out, /<conversation hit="g1" path="conversation\/relances-[0-9a-f]{8}\/user" title="Relances">\n1: Relance la FACTURATION de Globex\./);
    assert.equal(state.hits.get("g1")?.type, "conversation");
  });
});
