// Les adresses de l'installation : lues au DÉMARRAGE de l'interface, plus
// seulement figées à la construction (G5).
//
// L'image de l'interface (deploy/spa) écrit /config.js au lancement du
// conteneur, à partir de FOUNDEROS_SUPABASE_URL, FOUNDEROS_SUPABASE_ANON_KEY et
// FOUNDEROS_API_URL : une seule image publiée sert toutes les installations.
// Sans ce fichier (développement, Vercel), les variables VITE_* de la
// construction s'appliquent comme avant.

declare global {
  interface Window {
    __FOUNDEROS__?: { supabaseUrl?: string; supabaseAnonKey?: string; apiUrl?: string };
  }
}

const runtime = (typeof window !== "undefined" && window.__FOUNDEROS__) || {};

export const SUPABASE_URL: string = runtime.supabaseUrl || import.meta.env.VITE_SUPABASE_URL || "";
export const SUPABASE_ANON_KEY: string = runtime.supabaseAnonKey || import.meta.env.VITE_SUPABASE_ANON_KEY || "";
/** Le backend Express de l'installation ; vide : tout sur Supabase. */
export const API_URL: string = runtime.apiUrl || import.meta.env.VITE_API_URL || "";
