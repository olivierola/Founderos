// mcp-openshift — un par cluster (SDB, NPR, PRD, IPS) : ressources du cluster
// local, dans les namespaces de la liste blanche uniquement.
//
// Lecture : jeton de compte de service éphémère émis par le moteur Kubernetes de
// Vault (rôle lié à ai-reader), pour LE namespace visé. Écriture
// (deployment_restart) : un rôle Vault distinct, lié à ai-operator en SDB/NPR —
// en PRD, un rôle limité au patch des déploiements (voir la doc, phase 4).
// Sans rôle d'écriture configuré, le tool refuse.

import { z } from "zod";
import { request, requestJson, UpstreamError } from "../lib/http.ts";
import { credentialRefSchema } from "../lib/secrets.ts";
import type { ServerModule } from "../lib/server.ts";
import { defineTool, ToolInputError } from "../lib/tool.ts";

const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS1123_SUB = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

export const openshiftConfig = z.object({
  api: z.object({
    url: z.string().url().default("https://kubernetes.default.svc"),
    caFile: z.string().default("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
  }).default({ url: "https://kubernetes.default.svc", caFile: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt" }),
  namespaces: z.array(z.string().regex(DNS1123)).min(1),
  readCredential: credentialRefSchema,
  writeCredential: credentialRefSchema.optional(),
});
export type OpenshiftConfig = z.infer<typeof openshiftConfig>;

interface Pod {
  metadata: { name: string; creationTimestamp: string; ownerReferences?: Array<{ kind: string; name: string }> };
  spec: { nodeName?: string; containers: Array<{ name: string }> };
  status: { phase: string; reason?: string; containerStatuses?: Array<{ name: string; ready: boolean; restartCount: number; state?: Record<string, { reason?: string }> }> };
}

interface K8sEvent {
  type: string;
  reason: string;
  message: string;
  count?: number;
  lastTimestamp?: string;
  eventTime?: string;
  metadata: { creationTimestamp: string };
  involvedObject: { kind: string; name: string };
}

export const openshiftServer: ServerModule<OpenshiftConfig> = {
  name: "mcp-openshift",
  configSchema: openshiftConfig,
  createTools({ config, secrets }) {
    const nsEnum = z.enum(config.namespaces as [string, ...string[]]);
    const base = config.api.url.replace(/\/$/, "");

    const call = async <T>(namespace: string, path: string, opts: { method?: string; json?: unknown; contentType?: string; write?: boolean; raw?: boolean } = {}): Promise<T> => {
      const cred = opts.write ? config.writeCredential : config.readCredential;
      if (!cred) throw new ToolInputError("action d'écriture non configurée sur ce cluster");
      const token = await secrets.resolve(cred, { namespace });
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (opts.contentType) headers["Content-Type"] = opts.contentType;
      if (opts.raw) {
        const res = await request(`${base}${path}`, { headers: { ...headers, Accept: "text/plain" }, caFile: config.api.caFile, maxBytes: 2 * 1024 * 1024 });
        if (res.status !== 200) throw new UpstreamError(`API OpenShift : ${res.status} ${res.text.slice(0, 200)}`, res.status);
        return res.text as T;
      }
      return requestJson<T>(`${base}${path}`, {
        method: opts.method,
        headers,
        caFile: config.api.caFile,
        ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
      });
    };

    return [
      defineTool({
        name: "pods_list",
        description: "Pods d'un namespace autorisé : phase, conteneurs prêts, redémarrages, nœud, propriétaire.",
        write: false,
        input: { namespace: nsEnum, label_selector: z.string().regex(/^[\w./-]+(=[\w.-]+)?(,[\w./-]+(=[\w.-]+)?)*$/).optional() },
        async run({ namespace, label_selector }) {
          const q = label_selector ? `?labelSelector=${encodeURIComponent(label_selector)}` : "";
          const res = await call<{ items: Pod[] }>(namespace, `/api/v1/namespaces/${namespace}/pods${q}`);
          return res.items.map((p) => {
            const cs = p.status.containerStatuses ?? [];
            const waiting = cs.map((c) => c.state?.waiting?.reason).find(Boolean);
            return {
              name: p.metadata.name,
              phase: p.status.phase,
              reason: waiting ?? p.status.reason,
              ready: `${cs.filter((c) => c.ready).length}/${p.spec.containers.length}`,
              restarts: cs.reduce((n, c) => n + c.restartCount, 0),
              node: p.spec.nodeName,
              owner: p.metadata.ownerReferences?.[0] ? `${p.metadata.ownerReferences[0].kind}/${p.metadata.ownerReferences[0].name}` : null,
              created: p.metadata.creationTimestamp,
            };
          });
        },
      }),

      defineTool({
        name: "pod_logs",
        description: "Dernières lignes de log d'un conteneur (500 au plus), masquées avant renvoi.",
        write: false,
        input: {
          namespace: nsEnum,
          pod: z.string().regex(DNS1123_SUB).max(253),
          container: z.string().regex(DNS1123).max(63).optional(),
          previous: z.boolean().default(false).describe("Logs de l'instance précédente (après un redémarrage)"),
          lines: z.number().int().min(1).max(500).default(200),
        },
        async run({ namespace, pod, container, previous, lines }) {
          const q = new URLSearchParams({ tailLines: String(lines), previous: String(previous) });
          if (container) q.set("container", container);
          const text = await call<string>(namespace, `/api/v1/namespaces/${namespace}/pods/${pod}/log?${q}`, { raw: true });
          return text.split("\n").slice(-lines).join("\n");
        },
      }),

      defineTool({
        name: "events_list",
        description: "Événements Kubernetes d'un namespace sur la dernière heure au plus, éventuellement pour un objet.",
        write: false,
        input: {
          namespace: nsEnum,
          minutes: z.number().int().min(1).max(60).default(60),
          object_name: z.string().regex(DNS1123_SUB).max(253).optional(),
          warnings_only: z.boolean().default(false),
        },
        async run({ namespace, minutes, object_name, warnings_only }) {
          const res = await call<{ items: K8sEvent[] }>(namespace, `/api/v1/namespaces/${namespace}/events`);
          const since = Date.now() - minutes * 60_000;
          return res.items
            .map((e) => ({ ...e, at: Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp) }))
            .filter((e) => e.at >= since)
            .filter((e) => !object_name || e.involvedObject.name === object_name)
            .filter((e) => !warnings_only || e.type === "Warning")
            .sort((a, b) => b.at - a.at)
            .slice(0, 200)
            .map((e) => ({
              at: new Date(e.at).toISOString(), type: e.type, reason: e.reason,
              object: `${e.involvedObject.kind}/${e.involvedObject.name}`, message: e.message, count: e.count ?? 1,
            }));
        },
      }),

      defineTool({
        name: "deployment_status",
        description: "État d'un déploiement : réplicas, déploiement en cours, conditions, images.",
        write: false,
        input: { namespace: nsEnum, name: z.string().regex(DNS1123).max(253) },
        async run({ namespace, name }) {
          const d = await call<{
            metadata: { generation: number; annotations?: Record<string, string> };
            spec: { replicas?: number; template: { spec: { containers: Array<{ name: string; image: string }> } } };
            status: { observedGeneration?: number; replicas?: number; readyReplicas?: number; updatedReplicas?: number; availableReplicas?: number; unavailableReplicas?: number; conditions?: Array<{ type: string; status: string; reason?: string; message?: string; lastUpdateTime?: string }> };
          }>(namespace, `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`);
          return {
            desired: d.spec.replicas ?? 1,
            ready: d.status.readyReplicas ?? 0,
            updated: d.status.updatedReplicas ?? 0,
            available: d.status.availableReplicas ?? 0,
            unavailable: d.status.unavailableReplicas ?? 0,
            rollout_complete: (d.status.observedGeneration ?? 0) >= d.metadata.generation
              && (d.status.updatedReplicas ?? 0) === (d.spec.replicas ?? 1)
              && (d.status.availableReplicas ?? 0) === (d.spec.replicas ?? 1),
            conditions: d.status.conditions ?? [],
            images: d.spec.template.spec.containers.map((c) => ({ container: c.name, image: c.image })),
          };
        },
      }),

      defineTool({
        name: "deployment_restart",
        description: "Redémarre UN déploiement (rollout restart, annotation restartedAt). En PRD, exige une approbation.",
        write: true,
        input: { namespace: nsEnum, name: z.string().regex(DNS1123).max(253) },
        // La même annotation que `oc rollout restart` : un seul champ à déclarer
        // dans ignoreDifferences côté Argo CD. Qui a redémarré est dans l'audit.
        async run({ namespace, name }) {
          const restartedAt = new Date().toISOString();
          await call(namespace, `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`, {
            method: "PATCH",
            write: true,
            contentType: "application/strategic-merge-patch+json",
            json: { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": restartedAt } } } } },
          });
          return { namespace, deployment: name, restartedAt };
        },
      }),
    ];
  },
};
