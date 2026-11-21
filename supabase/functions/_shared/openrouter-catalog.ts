// La connexion LLM par défaut de la plateforme : OpenRouter.
//
// Avant qu'une entreprise branche ses propres modèles (AI Ops → Modèles), les
// agents et l'assistant tournent sur le compte OpenRouter de la plateforme
// (OPENROUTER_API_KEY). Par défaut, ce compte ne sert QUE des modèles gratuits
// (OPENROUTER_FREE_ONLY, défaut 1) : les identifiants `…:free`, et
// `openrouter/free`, le routeur d'OpenRouter qui choisit lui-même un modèle
// gratuit disponible. Il sert de dernier repli à chaque palier, si bien qu'un
// modèle gratuit retiré du catalogue (ils tournent vite) ne casse pas un run.
//
// Les modèles par défaut ci-dessous ont été choisis dans le catalogue du
// 19/11/2026 (tous acceptent les outils). Le catalogue vivant est lu par
// `openrouterCatalog()` : l'interface l'affiche, et la génération d'image s'y
// rabat quand le modèle d'image par défaut a disparu.
//
// Limites des modèles gratuits chez OpenRouter : 50 requêtes par jour sur un
// compte qui n'a jamais acheté de crédits, 1 000 au-delà de 10 $ achetés
// (`/api/v1/key` → free_model_daily_requests).

export const OPENROUTER_FREE_ROUTER = "openrouter/free";

/** Les routes gratuites par défaut : palier (light, standard, heavy) et
 *  critère (code, vision, long_context, image, judge). « a,b,c » = replis. */
export const OPENROUTER_FREE_ROUTES: Record<string, string> = {
  light: "nvidia/nemotron-3.5-lightning:free,google/gemma-4-26b-a4b-it:free,openrouter/free",
  standard: "nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free,openrouter/free",
  heavy: "nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3.5-super-vl:free,openrouter/free",
  code: "cohere/north-mini-code:free,nvidia/nemotron-3-ultra-550b-a55b:free,openrouter/free",
  vision: "nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free,openrouter/free",
  long_context: "nvidia/nemotron-3.5-lightning:free,nvidia/nemotron-3.5-super-vl:free,openrouter/free",
  judge: "nvidia/nemotron-3.5-lightning:free,google/gemma-4-26b-a4b-it:free,openrouter/free",
  // Modèle d'image seul (endpoint /images d'OpenRouter, pas le chat).
  image: "recraft/recraft-v4.1-flash-v2:free",
};

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

/** Le compte de la plateforme ne sert que des modèles gratuits (défaut). */
export function openrouterFreeOnly(): boolean {
  return env("OPENROUTER_FREE_ONLY") !== "0";
}

/** Un identifiant gratuit chez OpenRouter. */
export function isFreeOpenRouterModel(id: string): boolean {
  const m = id.trim();
  return m.endsWith(":free") || m === OPENROUTER_FREE_ROUTER;
}

/**
 * Une route « a,b,c » réduite à ses modèles gratuits, ou `fallback` quand il
 * n'en reste aucun. Sans le mode gratuit, la route passe telle quelle.
 */
export function freeRoute(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (!openrouterFreeOnly()) return value;
  const kept = value.split(",").map((m) => m.trim()).filter((m) => m && isFreeOpenRouterModel(m));
  return kept.length ? kept.join(",") : fallback;
}

/** Une table de routes entière, filtrée par `freeRoute` (palier par défaut en
 *  repli de chaque critère). */
export function freeRoutes(routes: Partial<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(routes)) {
    if (!v) continue;
    out[k] = freeRoute(v, OPENROUTER_FREE_ROUTES[k] ?? OPENROUTER_FREE_ROUTES.standard);
  }
  return out;
}

// ── Le catalogue vivant ─────────────────────────────────────────────────────

export interface CatalogModel {
  id: string;
  name: string;
  context_length: number | null;
  input: string[];
  output: string[];
  tools: boolean;
  free: boolean;
  /** Prix par million de tokens (entrée, sortie), null quand inconnu. */
  price_in: number | null;
  price_out: number | null;
  /** Date de retrait annoncée par OpenRouter (souvent sur les gratuits). */
  expires: string | null;
}

let cache: { at: number; models: CatalogModel[] } | null = null;
const CACHE_MS = 60 * 60 * 1000;

function baseUrl(): string {
  return (env("OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
}

/** Le catalogue d'OpenRouter (texte et images ; ni vidéo, ni audio, ni
 *  embeddings), mis en cache une heure. Lève une erreur lisible. */
export async function openrouterCatalog(): Promise<CatalogModel[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.models;
  const key = env("OPENROUTER_API_KEY");
  const res = await fetch(`${baseUrl()}/models?output_modalities=all`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`catalogue OpenRouter indisponible (HTTP ${res.status})`);
  const json = await res.json() as { data?: Array<Record<string, unknown>> };
  const models: CatalogModel[] = [];
  for (const m of json.data ?? []) {
    const arch = (m.architecture ?? {}) as { input_modalities?: string[]; output_modalities?: string[] };
    const output = arch.output_modalities ?? [];
    if (!output.includes("text") && !output.includes("image")) continue;
    const pricing = (m.pricing ?? {}) as Record<string, string>;
    const id = String(m.id ?? "");
    if (!id) continue;
    const prices = Object.values(pricing).map(Number).filter(Number.isFinite);
    // openrouter/auto affiche -1 (variable) : ni gratuit, ni payant connu.
    const free = isFreeOpenRouterModel(id) || (prices.length > 0 && prices.every((p) => p === 0));
    const per = (v: string | undefined) => (v != null && Number(v) >= 0 ? Math.round(Number(v) * 1e6 * 1000) / 1000 : null);
    const exp = m.expiration_date;
    models.push({
      id,
      name: String(m.name ?? id),
      context_length: typeof m.context_length === "number" ? m.context_length : null,
      input: arch.input_modalities ?? [],
      output,
      tools: ((m.supported_parameters as string[] | undefined) ?? []).includes("tools"),
      free,
      price_in: per(pricing.prompt),
      price_out: per(pricing.completion),
      expires: typeof exp === "string" ? exp : null,
    });
  }
  cache = { at: Date.now(), models };
  return models;
}

/** Les modèles que la connexion par défaut peut servir : gratuits seulement
 *  en mode gratuit. Les modèles de texte d'abord, puis les images. */
export async function platformModels(): Promise<CatalogModel[]> {
  const all = await openrouterCatalog();
  const allowed = openrouterFreeOnly() ? all.filter((m) => m.free) : all;
  return allowed.sort((a, b) =>
    Number(b.output.includes("text")) - Number(a.output.includes("text")) || a.id.localeCompare(b.id));
}

/** Un modèle d'image gratuit du catalogue (repli quand le défaut a disparu). */
export async function firstFreeImageModel(exclude?: string): Promise<string | null> {
  try {
    const all = await openrouterCatalog();
    const img = all.filter((m) => m.free && m.output.includes("image") && !m.output.includes("text") && m.id !== exclude);
    // Les modèles sans date de retrait d'abord.
    img.sort((a, b) => Number(!!a.expires) - Number(!!b.expires));
    return img[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Pour les tests. */
export function resetOpenRouterCatalog(): void {
  cache = null;
}
