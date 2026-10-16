import { z } from "zod";
import type { ServerModule } from "../lib/server.ts";
import { argocdServer } from "./argocd.ts";
import { fleetServer } from "./fleet.ts";
import { gitServer } from "./git.ts";
import { observabilityServer } from "./observability.ts";
import { openshiftServer } from "./openshift.ts";
import { prtgServer } from "./prtg.ts";

/** MCP_SERVER → module. */
export const SERVERS: Record<string, ServerModule<any>> = {
  observability: observabilityServer,
  fleet: fleetServer,
  openshift: openshiftServer,
  argocd: argocdServer,
  git: gitServer,
  prtg: prtgServer,
};

/**
 * Un serveur par cluster : tous les modules utiles à ce cluster derrière un
 * seul point d'accès MCP (MCP_SERVER=openshift,argocd,observability). Un jeton
 * tournant, un certificat et un jeu de comptes de service par cluster ; FounderOS
 * ne déclare qu'un serveur par cluster.
 *
 * Chaque module garde sa configuration (`{ "openshift": {…}, "argocd": {…} }`),
 * ses identifiants, ses contrôles et ses vérifications. Les verrous ne changent
 * pas : jeton d'appel, décision OPA par tool, identifiant de courte durée.
 */
export function combineModules(keys: string[]): ServerModule<Record<string, unknown>> {
  const unique = [...new Set(keys)];
  if (unique.length !== keys.length) throw new Error(`MCP_SERVER : module en double (${keys.join(", ")})`);
  const modules = unique.map((k) => {
    const m = SERVERS[k];
    if (!m) throw new Error(`MCP_SERVER inconnu : ${k} (attendu : ${Object.keys(SERVERS).join(", ")})`);
    return [k, m] as const;
  });
  const shape = Object.fromEntries(modules.map(([k, m]) => [k, m.configSchema])) as Record<string, z.ZodTypeAny>;
  return {
    name: "mcp",
    configSchema: z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>>,
    createTools(deps) {
      const tools = modules.flatMap(([k, m]) => m.createTools({ ...deps, config: deps.config[k] }));
      const seen = new Set<string>();
      for (const t of tools) {
        if (seen.has(t.name)) throw new Error(`tool « ${t.name} » fourni par deux modules : ${unique.join(", ")}`);
        seen.add(t.name);
      }
      return tools;
    },
    checks(deps) {
      return modules.flatMap(([k, m]) => m.checks?.({ ...deps, config: deps.config[k] }) ?? []);
    },
  };
}

/** MCP_SERVER : une clé (un module), ou plusieurs séparées par des virgules (un serveur par cluster). */
export function resolveServerModule(spec: string): ServerModule<any> {
  const keys = spec.split(",").map((s) => s.trim()).filter(Boolean);
  if (keys.length === 1) {
    const m = SERVERS[keys[0]];
    if (!m) throw new Error(`MCP_SERVER inconnu : ${keys[0]} (attendu : ${Object.keys(SERVERS).join(", ")})`);
    return m;
  }
  if (keys.length === 0) throw new Error("MCP_SERVER est vide");
  return combineModules(keys);
}
