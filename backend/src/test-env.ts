// Environnement des tests. À importer EN PREMIER dans chaque fichier de test :
// les modules de l'app lisent ces variables au chargement. Aucun test ne parle
// à Supabase — l'URL vise un port fermé.

import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export const ANON_KEY = "test-anon-key";
export const SERVICE_ROLE_KEY = "test-service-role-key";
export const JWT_SECRET = "test-jwt-secret-with-at-least-32-chars";

process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
process.env.SUPABASE_JWT_SECRET = JWT_SECRET;

/** Démarre le serveur sur un port libre et renvoie son URL. */
export async function listen(server: Server): Promise<string> {
  server.listen(0);
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
