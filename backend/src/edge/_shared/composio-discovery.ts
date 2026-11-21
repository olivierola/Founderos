// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/composio-discovery.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// Les actions d'une app Composio, découvertes et gardées en cache dans
// connectors.metadata.tools. C'est là que le registre des ressources (0291)
// les lit pour en faire des ressources de pool, une ligne par action : sans
// découverte, une app ne se donne qu'entière.
//
// Trois moments la déclenchent :
//   · la connexion d'une app (composio-connect, composio-connection-status) ;
//   · « Resynchroniser » dans l'onglet Pools (composio-action, discover_all) ;
//   · chaque découverte faite par un agent ou par l'interface (composio-action).
//
// Le cache s'enrichit, il ne rétrécit jamais : une découverte plafonnée n'est
// pas la liste complète, et une action qui disparaîtrait d'un listage partiel
// passerait « removed » dans le registre à tort.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getComposio } from "./composio.ts";

/** Ce qu'une découverte de fond demande à Composio ; refusé, on retombe sur le
 *  plafond que l'interface utilise depuis toujours. */
export const DISCOVERY_LIMIT = 300;
const DISCOVERY_FALLBACK_LIMIT = 100;
/** Ce que le cache garde au plus, par connexion. */
export const CACHE_CAP = 300;

export interface CachedAction {
  slug: string;
  name: string;
  description: string;
  /** Les indications de Composio (readOnlyHint, destructiveHint…) : le registre
   *  en tire le risque de l'action. */
  tags?: string[];
}

export function toCachedActions(list: Array<Record<string, unknown>>): CachedAction[] {
  return list
    .map((t) => {
      const tags = Array.isArray(t.tags) ? (t.tags as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 12) : [];
      return {
        slug: String(t.slug ?? "").toUpperCase(),
        name: String(t.name ?? t.slug ?? ""),
        description: String(t.description ?? "").slice(0, 300),
        ...(tags.length ? { tags } : {}),
      };
    })
    .filter((t) => t.slug);
}

/** Ajoute au cache des connexions partagées (projet, service) de cette app ce
 *  qu'une découverte a vu. Rend le nombre d'actions ajoutées. */
export async function cacheDiscoveredActions(
  admin: SupabaseClient, workspaceId: string, projectId: string, toolkit: string, list: Array<Record<string, unknown>>,
): Promise<number> {
  const seen = toCachedActions(list);
  if (!seen.length) return 0;
  const { data: rows } = await admin.from("connectors").select("id, metadata")
    .eq("workspace_id", workspaceId).eq("project_id", projectId)
    .eq("provider", toolkit).eq("source", "composio").neq("scope", "personal");
  let total = 0;
  for (const r of (rows ?? []) as Array<{ id: string; metadata: Record<string, unknown> | null }>) {
    const meta = r.metadata ?? {};
    const known = Array.isArray(meta.tools) ? (meta.tools as Array<Record<string, unknown>>) : [];
    const bySlug = new Map(known.map((t) => [String(t.slug ?? "").toUpperCase(), t]));
    let added = 0;
    for (const t of seen) {
      const prev = bySlug.get(t.slug);
      // Une entrée d'avant sans indications les reçoit : le risque s'affine.
      if (!prev) { bySlug.set(t.slug, t as unknown as Record<string, unknown>); added++; }
      else if (t.tags && !prev.tags) { bySlug.set(t.slug, { ...prev, tags: t.tags }); added++; }
    }
    if (!added) continue;
    total += added;
    await admin.from("connectors").update({ metadata: { ...meta, tools: [...bySlug.values()].slice(0, CACHE_CAP) } }).eq("id", r.id);
  }
  return total;
}

/** Liste les actions d'une app chez Composio et les met en cache. */
export async function discoverToolkit(
  admin: SupabaseClient,
  opts: { workspaceId: string; projectId: string; toolkit: string; limit?: number },
): Promise<Array<Record<string, unknown>>> {
  const composio = getComposio();
  const ask = (limit: number) => composio.tools.getRawComposioTools(
    { toolkits: [opts.toolkit], limit } as Parameters<typeof composio.tools.getRawComposioTools>[0],
  );
  const limit = opts.limit ?? DISCOVERY_LIMIT;
  let tools: unknown;
  try {
    tools = await ask(limit);
  } catch (e) {
    if (limit <= DISCOVERY_FALLBACK_LIMIT) throw e;
    tools = await ask(DISCOVERY_FALLBACK_LIMIT);
  }
  const list = (Array.isArray(tools) ? tools : []) as Array<Record<string, unknown>>;
  await cacheDiscoveredActions(admin, opts.workspaceId, opts.projectId, opts.toolkit, list).catch((e) =>
    console.error(`[composio-discovery] mise en cache des actions de ${opts.toolkit} : ${e instanceof Error ? e.message : e}`));
  return list;
}

export interface DiscoveryReport {
  project_id: string;
  toolkit: string;
  actions?: number;
  error?: string;
}

/**
 * Découvre les actions de toutes les apps partagées et connectées d'un projet
 * — ou de toute l'installation, appelé par le serveur. `onlyMissing` saute une
 * app dont le cache n'est pas vide (la reprise de l'existant).
 */
export async function discoverConnectedApps(
  admin: SupabaseClient,
  opts: { projectId?: string; onlyMissing?: boolean; max?: number } = {},
): Promise<DiscoveryReport[]> {
  let q = admin.from("connectors").select("workspace_id, project_id, provider, metadata")
    .eq("source", "composio").eq("status", "connected").neq("scope", "personal");
  if (opts.projectId) q = q.eq("project_id", opts.projectId);
  const { data } = await q.limit(500);
  // Une app par projet : le cache est écrit sur toutes ses connexions partagées.
  const apps = new Map<string, { workspace_id: string; project_id: string; provider: string; cached: number }>();
  for (const r of (data ?? []) as Array<{ workspace_id: string; project_id: string; provider: string; metadata: Record<string, unknown> | null }>) {
    if (!r.workspace_id || !r.project_id || !r.provider) continue;
    const k = `${r.project_id}:${r.provider}`;
    const cached = Array.isArray(r.metadata?.tools) ? (r.metadata!.tools as unknown[]).length : 0;
    const cur = apps.get(k);
    apps.set(k, { ...r, cached: Math.min(cur?.cached ?? cached, cached) });
  }
  const out: DiscoveryReport[] = [];
  for (const a of [...apps.values()].slice(0, opts.max ?? 60)) {
    if (opts.onlyMissing && a.cached > 0) continue;
    try {
      const list = await discoverToolkit(admin, { workspaceId: a.workspace_id, projectId: a.project_id, toolkit: a.provider });
      out.push({ project_id: a.project_id, toolkit: a.provider, actions: list.length });
    } catch (e) {
      out.push({ project_id: a.project_id, toolkit: a.provider, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
