#!/usr/bin/env node
// Revectorise les espaces après un changement de modèle d'embeddings.
//
// Deux modèles ne rangent pas les textes dans le même espace : après une bascule
// (Jina → text-embedding-3 d'Azure AI Foundry, par exemple), une question
// vectorisée par le nouveau ne retrouve plus rien de ce que l'ancien avait
// rangé. Ce script appelle, espace par espace, l'action `reembed` de rag-ingest
// jusqu'à ce qu'elle réponde `done` : passages RAG, mémoires des agents,
// entités du graphe de connaissances.
//
// À lancer depuis la racine, APRÈS la bascule des secrets du modèle :
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=… \
//     node scripts/reembed-workspaces.mjs <workspace_id> [<workspace_id>…]
//
// La clé service role n'est jamais affichée. Sans identifiant d'espace, le
// script liste les espaces qui ont des vecteurs (lecture REST, service role).

const base = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!base || !key) {
  console.error("Renseignez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const headers = { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" };

async function workspacesWithVectors() {
  const ids = new Set();
  for (const table of ["rag_chunks", "internal_agent_memories", "knowledge_entities"]) {
    const res = await fetch(`${base}/rest/v1/${table}?select=workspace_id&embedding=not.is.null&limit=10000`, { headers });
    if (!res.ok) throw new Error(`${table} : ${res.status} ${(await res.text()).slice(0, 200)}`);
    for (const r of await res.json()) if (r.workspace_id) ids.add(r.workspace_id);
  }
  return [...ids];
}

async function reembed(workspaceId) {
  let cursor = null;
  let total = 0;
  for (let page = 0; page < 10_000; page++) {
    const res = await fetch(`${base}/functions/v1/rag-ingest`, {
      method: "POST", headers,
      body: JSON.stringify({ action: "reembed", workspace_id: workspaceId, cursor }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${workspaceId} : ${res.status} ${out.error ?? ""}`);
    total += out.processed ?? 0;
    if (out.table) process.stdout.write(`  ${out.table} : +${out.processed}\n`);
    if (out.done || !out.next) return total;
    cursor = out.next;
  }
  throw new Error(`${workspaceId} : trop de lots, arrêt par sécurité`);
}

const args = process.argv.slice(2);
const targets = args.length ? args : await workspacesWithVectors();
if (!args.length) console.log(`Espaces avec des vecteurs : ${targets.length}`);
for (const ws of targets) {
  console.log(`Espace ${ws}`);
  const n = await reembed(ws);
  console.log(`  ${n} vecteur(s) recalculé(s)`);
}
