import { supabase } from "@/lib/supabase";
import { API_URL, SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/runtime-config";

/**
 * Avec VITE_API_URL, toutes les fonctions partent vers le backend Express
 * (backend/), sauf celles listées ici, qui restent sur les edge functions
 * Supabase. Sans VITE_API_URL, tout reste sur Supabase comme avant.
 * Ajouter un nom ici est le retour arrière d'une fonction, sans redéploiement
 * du backend.
 */
const EDGE_ONLY = new Set([
  // L'URL de redirection OAuth est déclarée dans l'app Slack. À retirer une
  // fois <backend>/functions/v1/slack-gateway ajoutée à ses « Redirect URLs ».
  "slack-gateway",
]);

/** L'origine (sans /functions/v1) qui sert la fonction `name` : le backend
 *  Express, ou Supabase. C'est l'URL à donner aux clients qui composent
 *  eux-mêmes le chemin (relais, extension navigateur). */
export function functionsBaseUrl(name: string): string {
  const apiUrl = API_URL;
  if (apiUrl && !EDGE_ONLY.has(name.split("?")[0])) return apiUrl.replace(/\/$/, "");
  return SUPABASE_URL;
}

/** `name` peut porter une query string : "automation-receiver?sentinel=admin". */
export function functionUrl(name: string): string {
  return `${functionsBaseUrl(name)}/functions/v1/${name}`;
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function callEdge<T = unknown>(
  name: string,
  body: unknown,
  /** Abort the in-flight call (a composer's stop button, an unmounting view). */
  signal?: AbortSignal,
): Promise<T> {
  const url = functionUrl(name);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    ...(await authHeader()),
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = (data as { error?: string; detail?: string }) ?? {};
    const parts = [err.error, err.detail].filter(Boolean);
    throw new Error(parts.length ? parts.join(" — ") : `Edge function ${name} failed (${res.status})`);
  }
  return data as T;
}
