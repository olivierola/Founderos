// MCP tools for PUBLIC (customer-facing) agents.
//
// Internal agents already get MCP servers through internal-agent-tools.ts. This
// is the same mechanism for the widget-facing side, with the constraints that
// come from the caller being an anonymous visitor rather than a logged-in
// employee:
//
//   • the merchant picks WHICH tools of a server the agent may call
//     (rag_agent_mcp_servers.allowed_tools) — a storefront MCP exposes cart
//     mutations, and "the agent can do everything the server offers" is not a
//     safe default when anyone on the internet can talk to it;
//   • every call is audited (rag_agent_tool_calls) with the visitor id;
//   • the number of rounds is capped per agent.
//
// Shopify's Storefront MCP (https://{shop}/api/mcp) is the reference case: an
// unauthenticated per-store endpoint exposing catalogue search and cart
// operations, which is exactly what a shopping assistant needs.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { mcpCallTool, type McpTool } from "./mcp-client.ts";
import { ensureAccessToken } from "./mcp-oauth.ts";
import type { ToolDef } from "./ai.ts";

export interface ProductCard {
  id: string;
  title: string;
  /** Overline on the card — a vendor, product type or collection when the
   *  storefront exposes one. */
  category: string | null;
  price: number | null;
  currency: string | null;
  image_url: string | null;
  url: string | null;
  in_stock: boolean;
}

export interface PublicAgentTools {
  tools: ToolDef[];
  executor: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Product cards harvested from tool results, for the widget to render. */
  products: ProductCard[];
  /** Server names, for the system prompt. */
  serverNames: string[];
  /** Compteurs du tour en cours, mutés par l'executor : la télémétrie de
   *  conversation (0217) doit savoir si un outil a été joué et s'il a cassé,
   *  et rag-chat ne voit pas passer les appels. */
  stats: { calls: number; errors: number };
}

const EMPTY: PublicAgentTools = { tools: [], executor: async () => "", products: [], serverNames: [], stats: { calls: 0, errors: 0 } };

interface AttachedServer {
  id: string; name: string; url: string;
  headers: Record<string, string>;
  tools: McpTool[];
}

/** `mcp_<server>_<tool>` — same namespacing the internal runtime uses, so an
 *  operator reading logs sees one convention. */
function toolNameFor(serverSlug: string, tool: string): string {
  return `mcp_${serverSlug}_${tool}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 60);
}
function slugFor(server: { id: string; name: string }): string {
  return (server.name || server.id)
    .replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || server.id.slice(0, 8);
}

export async function loadPublicAgentTools(
  admin: SupabaseClient,
  agent: { id: string; workspace_id: string; project_id: string; max_tool_calls?: number; storefront_url?: string | null },
  ctx: { conversationId?: string | null; visitorId?: string | null } = {},
): Promise<PublicAgentTools> {
  const { data } = await admin
    .from("rag_agent_mcp_servers")
    .select("allowed_tools, server:mcp_servers(id, name, url, headers, enabled, cached_tools, auth_mode, oauth)")
    .eq("agent_id", agent.id);

  const rows = (data ?? []) as Array<{ allowed_tools: string[] | null; server: any }>;
  const servers: AttachedServer[] = [];

  for (const row of rows) {
    const s = row.server;
    if (!s || !s.enabled) continue;

    let headers: Record<string, string> = s.headers && typeof s.headers === "object" ? { ...s.headers } : {};
    if (s.auth_mode === "oauth") {
      const token = await ensureAccessToken(admin, { id: s.id, oauth: s.oauth || {} });
      if (token) headers = { ...headers, Authorization: `Bearer ${token}` };
    }

    const cached: McpTool[] = Array.isArray(s.cached_tools) ? s.cached_tools : [];
    // An empty allowlist means "nothing yet", not "everything": the merchant has
    // to tick the tools this public agent may use. Erring the other way would
    // hand cart/checkout mutations to anonymous traffic the moment a server is
    // attached.
    const allowed = new Set(row.allowed_tools ?? []);
    const tools = cached.filter((t) => t?.name && allowed.has(t.name));
    if (tools.length) servers.push({ id: s.id, name: s.name, url: s.url, headers, tools });
  }

  if (!servers.length) return EMPTY;

  const defs: ToolDef[] = [];
  const dispatch = new Map<string, { server: AttachedServer; tool: McpTool }>();

  for (const server of servers) {
    const slug = slugFor(server);
    for (const t of server.tools) {
      const name = toolNameFor(slug, t.name);
      if (dispatch.has(name)) continue;
      const schema = t.inputSchema && typeof t.inputSchema === "object"
        && (t.inputSchema as { type?: unknown }).type === "object"
        ? t.inputSchema as Record<string, unknown>
        : { type: "object", properties: {}, additionalProperties: true };
      defs.push({
        type: "function",
        // A remote server's schema is a contract we don't own — never rewrite it.
        incompressible: true,
        function: {
          name,
          description: `[${server.name}] ${t.description || t.name}`.slice(0, 1000),
          parameters: schema,
        },
      });
      dispatch.set(name, { server, tool: t });
    }
  }

  const products: ProductCard[] = [];
  const stats = { calls: 0, errors: 0 };
  const sessions = new Map<string, { id?: string }>();

  const executor = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const target = dispatch.get(name);
    if (!target) return `ERROR: unknown tool ${name}`;
    const started = Date.now();
    stats.calls += 1;
    let out = "";
    let failed = false;
    try {
      let sess = sessions.get(target.server.id);
      if (!sess) { sess = {}; sessions.set(target.server.id, sess); }
      out = await mcpCallTool(target.server.url, target.server.headers, target.tool.name, args, sess);
      failed = out.startsWith("ERROR:");
    } catch (e) {
      failed = true;
      out = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }

    // Harvest anything product-shaped so the widget can draw cards instead of
    // making the model re-type prices into prose.
    if (!failed) {
      for (const p of extractProducts(out, agent.storefront_url ?? null)) {
        if (!products.some((x) => x.id === p.id)) products.push(p);
      }
    }

    if (failed) stats.errors += 1;

    // Anonymous visitors are triggering calls to an external system: keep a trail.
    await admin.from("rag_agent_tool_calls").insert({
      workspace_id: agent.workspace_id, project_id: agent.project_id, agent_id: agent.id,
      conversation_id: ctx.conversationId ?? null, visitor_id: ctx.visitorId ?? null,
      server_id: target.server.id, tool_name: target.tool.name,
      args: safeJson(args), ok: !failed,
      error: failed ? out.slice(0, 500) : null,
      duration_ms: Date.now() - started,
    }).then(() => {}, () => {});

    return out;
  };

  return { tools: defs, executor, products, serverNames: servers.map((s) => s.name), stats };
}

function safeJson(v: unknown): Record<string, unknown> {
  try { return JSON.parse(JSON.stringify(v ?? {})); } catch { return {}; }
}

/* ── Product extraction ───────────────────────────────────────────────────── */

const NUM = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(typeof v === "string" ? v.replace(/[^\d.,-]/g, "").replace(",", ".") : v);
  return Number.isFinite(n) ? n : null;
};
const STR = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Pull product-looking records out of an MCP tool result.
 *
 *  Deliberately shape-driven rather than server-specific: MCP tool results are
 *  free-form JSON-in-text and every storefront names its fields differently, so
 *  this recognises the SHAPE (something with a title and a price) and maps the
 *  common aliases. A server we've never seen still renders cards; one that
 *  returns prose simply yields none and the answer stays text-only. */
export function extractProducts(raw: string, storefront: string | null): ProductCard[] {
  const parsed = looseParseJson(raw);
  if (!parsed) return [];

  const found: ProductCard[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number) => {
    if (!node || depth > 6 || found.length >= 12) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    const o = node as Record<string, unknown>;
    const card = asProduct(o, storefront);
    if (card) { found.push(card); return; }   // don't descend into a matched product
    for (const v of Object.values(o)) walk(v, depth + 1);
  };

  walk(parsed, 0);
  return found;
}

/** Field lookup that ignores naming style. `price_range`, `priceRange` and
 *  `PriceRange` are the same field to three different storefronts, and listing
 *  every alias by hand is how this quietly stops working on the fourth. */
function fields(o: Record<string, unknown>): (...names: string[]) => unknown {
  const norm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(o)) {
    const key = k.replace(/[_\-\s]/g, "").toLowerCase();
    if (!norm.has(key)) norm.set(key, v);
  }
  return (...names: string[]) => {
    for (const n of names) {
      const v = norm.get(n.replace(/[_\-\s]/g, "").toLowerCase());
      if (v != null) return v;
    }
    return undefined;
  };
}
const obj = (v: unknown): Record<string, any> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;

function asProduct(o: Record<string, unknown>, storefront: string | null): ProductCard | null {
  const f = fields(o);
  const title = STR(f("title", "name", "productTitle"));
  if (!title) return null;

  const priceRange = obj(f("priceRange"));
  const pr = priceRange ? fields(priceRange) : null;
  const minVariant = pr ? obj(pr("minVariantPrice", "min_variant_price")) : undefined;
  const variantsRaw = f("variants");
  const variant = Array.isArray(variantsRaw) ? obj(variantsRaw[0]) : undefined;
  const vf = variant ? fields(variant) : null;
  const variantPrice = vf ? (obj(vf("price")) ?? vf("price")) : undefined;

  const price =
    NUM(f("price", "amount"))
    ?? (pr ? NUM(pr("min")) : null)
    ?? (minVariant ? NUM(fields(minVariant)("amount")) : null)
    ?? NUM(obj(variantPrice) ? fields(obj(variantPrice)!)("amount") : variantPrice);

  // A title alone is just an object; a title WITH a price is a product. This is
  // what stops policy pages and cart totals from rendering as cards.
  if (price == null) return null;

  const currency =
    STR(f("currency", "currencyCode"))
    ?? (pr ? STR(pr("currency", "currencyCode")) : null)
    ?? (minVariant ? STR(fields(minVariant)("currencyCode", "currency")) : null)
    ?? (obj(variantPrice) ? STR(fields(obj(variantPrice)!)("currencyCode", "currency")) : null);

  const imagesRaw = f("images");
  const firstImage = Array.isArray(imagesRaw) ? imagesRaw[0] : undefined;
  const image =
    STR(f("imageUrl", "image", "thumbnail"))
    ?? STR(obj(f("featuredImage", "image")) ? fields(obj(f("featuredImage", "image"))!)("url", "src") : undefined)
    ?? STR(obj(firstImage) ? fields(obj(firstImage)!)("url", "src") : firstImage);

  const url = rehost(STR(f("url", "onlineStoreUrl", "productUrl", "link", "permalink")), storefront);

  const availability = f("available", "availableForSale", "inStock", "stockStatus");
  const inStock = availability == null
    ? true
    : typeof availability === "string"
      ? !/^(out|unavailable|outofstock|sold_?out)/i.test(availability)
      : !!availability;

  const id = STR(f("productId", "id", "gid", "sku")) ?? url ?? title;
  const category = STR(f("vendor", "productType", "brand", "category", "collection"));

  return { id: String(id), title, category, price, currency, image_url: image, url, in_stock: inStock };
}

/** Swap a product link onto the merchant's public storefront when it differs
 *  from whatever host the MCP server reported. */
function rehost(url: string | null, storefront: string | null): string | null {
  if (!url || !storefront) return url;
  try {
    const t = new URL(url);
    const base = new URL(storefront.startsWith("http") ? storefront : `https://${storefront}`);
    t.protocol = base.protocol;
    t.host = base.host;
    return t.toString();
  } catch { return url; }
}

/** MCP text content is often JSON, sometimes JSON inside a ```json fence,
 *  sometimes prose with a JSON blob in the middle. */
export function looseParseJson(raw: string): unknown {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const direct = tryJson(text);
  if (direct !== undefined) return direct;

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const v = tryJson(fence[1].trim());
    if (v !== undefined) return v;
  }
  const first = text.search(/[[{]/);
  if (first >= 0) {
    const last = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
    if (last > first) {
      const v = tryJson(text.slice(first, last + 1));
      if (v !== undefined) return v;
    }
  }
  return null;
}
function tryJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}
