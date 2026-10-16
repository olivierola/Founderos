// mcp-fleet — sur le Hub : inventaire multi-clusters par ACM Search, et
// conformité des politiques de gouvernance ACM. Lecture seule.
//
// Les types de ressources consultables sont une liste blanche ; Secret n'y
// entre jamais, quelle que soit la configuration.

import { z } from "zod";
import { CLUSTERS, type Cluster } from "../lib/catalog.ts";
import { requestJson } from "../lib/http.ts";
import { credentialRefSchema } from "../lib/secrets.ts";
import type { ReadinessCheck, ServerModule } from "../lib/server.ts";
import { defineTool } from "../lib/tool.ts";

const FORBIDDEN_KINDS = new Set(["secret", "serviceaccounttoken", "tokenreview"]);

export const fleetConfig = z.object({
  clusters: z.array(z.enum(CLUSTERS)).min(1),
  search: z.object({
    /** ex. https://search-search-api.open-cluster-management.svc:4010/searchapi/graphql */
    url: z.string().url(),
    token: credentialRefSchema,
    caFile: z.string().optional(),
  }),
  /** API Kubernetes du Hub, pour les objets Policy. */
  hubApi: z.object({
    url: z.string().url().default("https://kubernetes.default.svc"),
    token: credentialRefSchema,
    caFile: z.string().default("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
  }),
  kinds: z.array(z.string()).min(1).default(["Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Service", "Route", "Node", "Namespace", "PersistentVolumeClaim", "Application"]),
}).refine((c) => !c.kinds.some((k) => FORBIDDEN_KINDS.has(k.toLowerCase())), { message: "Secret ne peut pas figurer dans fleet.kinds" });
export type FleetConfig = z.infer<typeof fleetConfig>;

const SEARCH_QUERY = "query searchResult($input: [SearchInput]) { searchResult: search(input: $input) { count items } }";

interface PolicyObj {
  metadata: { name: string; namespace: string; labels?: Record<string, string> };
  spec?: { remediationAction?: string; disabled?: boolean };
  status?: { compliant?: string; status?: Array<{ clustername: string; compliant?: string }> };
}

export const fleetServer: ServerModule<FleetConfig> = {
  name: "mcp-fleet",
  configSchema: fleetConfig,
  createTools({ config, secrets }) {
    const kindEnum = z.enum(config.kinds as [string, ...string[]]);
    const clusterEnum = z.enum(config.clusters as [Cluster, ...Cluster[]]);

    return [
      defineTool({
        name: "fleet_search",
        description: "Inventaire multi-clusters (ACM Search) : ressources d'un type de la liste blanche, filtrables par cluster, namespace, nom et label. Jamais de Secret.",
        write: false,
        input: {
          kind: kindEnum,
          cluster: clusterEnum.optional(),
          namespace: z.string().max(63).optional(),
          name: z.string().max(253).optional().describe("Nom exact, ou préfixe suivi de *"),
          label: z.string().regex(/^[\w./-]+=[\w.-]+$/).optional().describe("Un label, ex. app=payment-api"),
          limit: z.number().int().min(1).max(200).default(50),
        },
        async run({ kind, cluster, namespace, name, label, limit }) {
          const filters: Array<{ property: string; values: string[] }> = [{ property: "kind", values: [kind] }];
          if (cluster) filters.push({ property: "cluster", values: [cluster] });
          if (namespace) filters.push({ property: "namespace", values: [namespace] });
          if (name) filters.push({ property: "name", values: [name] });
          if (label) filters.push({ property: "label", values: [label] });
          const s = config.search;
          const res = await requestJson<{ data?: { searchResult?: Array<{ count: number; items: Array<Record<string, unknown>> }> }; errors?: Array<{ message: string }> }>(s.url, {
            method: "POST",
            headers: { Authorization: `Bearer ${await secrets.resolve(s.token, {})}` },
            caFile: s.caFile,
            json: { operationName: "searchResult", query: SEARCH_QUERY, variables: { input: [{ keywords: [], filters, limit }] } },
          });
          if (res.errors?.length) throw new Error(`ACM Search : ${res.errors.map((e) => e.message).join(" ; ")}`);
          const r = res.data?.searchResult?.[0];
          // Défense en profondeur : même si l'API renvoyait un Secret, il ne sort pas.
          const items = (r?.items ?? []).filter((i) => !FORBIDDEN_KINDS.has(String(i.kind ?? "").toLowerCase()));
          return {
            count: r?.count ?? 0,
            items: items.map((i) => ({
              kind: i.kind, name: i.name, namespace: i.namespace, cluster: i.cluster,
              status: i.status, created: i.created, label: i.label,
            })),
          };
        },
      }),

      defineTool({
        name: "policy_compliance",
        description: "Conformité des politiques de gouvernance ACM, par politique et par cluster.",
        write: false,
        input: {
          cluster: clusterEnum.optional(),
          only_non_compliant: z.boolean().default(false),
        },
        async run({ cluster, only_non_compliant }) {
          const h = config.hubApi;
          const res = await requestJson<{ items: PolicyObj[] }>(
            `${h.url.replace(/\/$/, "")}/apis/policy.open-cluster-management.io/v1/policies`,
            { headers: { Authorization: `Bearer ${await secrets.resolve(h.token, {})}` }, caFile: h.caFile },
          );
          // Politiques racines seulement : les copies répliquées par cluster portent le label root-policy.
          const roots = res.items.filter((p) => !p.metadata.labels?.["policy.open-cluster-management.io/root-policy"]);
          const rows = roots.map((p) => {
            const perCluster = (p.status?.status ?? []).filter((s) => !cluster || s.clustername === cluster);
            return {
              policy: `${p.metadata.namespace}/${p.metadata.name}`,
              remediation: p.spec?.remediationAction,
              disabled: p.spec?.disabled ?? false,
              compliant: cluster ? perCluster[0]?.compliant ?? "Unknown" : p.status?.compliant ?? "Unknown",
              clusters: perCluster.map((s) => ({ cluster: s.clustername, compliant: s.compliant ?? "Unknown" })),
            };
          });
          return rows.filter((r) => !only_non_compliant || r.compliant !== "Compliant");
        },
      }),
    ];
  },

  // ACM Search répond, et le compte lit les politiques du Hub.
  checks({ config, secrets }): ReadinessCheck[] {
    const s = config.search;
    const h = config.hubApi;
    return [
      {
        name: "flotte:recherche",
        critical: false,
        async run() {
          const res = await requestJson<{ errors?: Array<{ message: string }> }>(s.url, {
            method: "POST", headers: { Authorization: `Bearer ${await secrets.resolve(s.token, {})}` }, caFile: s.caFile, timeoutMs: 10_000,
            json: { operationName: "searchResult", query: SEARCH_QUERY, variables: { input: [{ keywords: [], filters: [{ property: "kind", values: ["Namespace"] }], limit: 1 }] } },
          });
          if (res?.errors?.length) throw new Error(`ACM Search : ${res.errors.map((e) => e.message).join(" ; ")}`);
          return "ACM Search répond";
        },
      },
      {
        name: "flotte:politiques",
        critical: false,
        async run() {
          await requestJson(`${h.url.replace(/\/$/, "")}/apis/policy.open-cluster-management.io/v1/policies?limit=1`, {
            headers: { Authorization: `Bearer ${await secrets.resolve(h.token, {})}` }, caFile: h.caFile, timeoutMs: 10_000,
          });
          return "politiques ACM lisibles";
        },
      },
    ];
  },
};
