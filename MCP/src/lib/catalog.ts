// Le catalogue des tools (policies/catalog/data.json) : la même source que
// les règles OPA. Un serveur n'enregistre que les tools que le catalogue prévoit
// pour SON cluster — premier des trois verrous : ce qui n'est pas enregistré
// n'existe pas pour l'agent.

import { readFileSync } from "node:fs";
import { z } from "zod";

export const CLUSTERS = ["hub", "ips", "sdb", "npr", "prd"] as const;
export type Cluster = (typeof CLUSTERS)[number];

const catalogSchema = z.object({
  tools: z.record(z.enum(CLUSTERS), z.array(z.string())),
  scopes: z.record(z.string(), z.string()),
  write_tools: z.array(z.string()),
  approval_required: z.record(z.string(), z.array(z.string())),
  // Approbateurs distincts exigés par cluster cible (G3). Absent : 1.
  approval_quorum: z.record(z.string(), z.number().int().min(1).max(5)).default({}),
  role_scopes: z.record(z.string(), z.array(z.string())),
  approver_role: z.string(),
});

export type Catalog = z.infer<typeof catalogSchema>;

/** src/lib/ et dist/lib/ sont tous deux à deux niveaux de la racine du paquet. */
const DEFAULT_FILE = new URL("../../policies/catalog/data.json", import.meta.url);

export function loadCatalog(file: string | URL = process.env.CATALOG_FILE || DEFAULT_FILE): Catalog {
  return catalogSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function toolsForCluster(catalog: Catalog, cluster: Cluster): Set<string> {
  return new Set(catalog.tools[cluster] ?? []);
}
