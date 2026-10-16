// mcp-openshift — l'API Kubernetes / OpenShift du cluster où tourne le
// serveur, dans les namespaces de la liste blanche uniquement.
//
// Identifiants (secrets.ts) : par défaut, des jetons de courte durée pour deux
// comptes de service dédiés, obtenus par l'API TokenRequest :
//   readCredential   { type: "k8s-token", serviceAccount: "mcp-<cluster>-reader" }
//                    lié à ai-reader dans chaque namespace autorisé ;
//   writeCredential  { type: "k8s-token", serviceAccount: "mcp-<cluster>-operator" }
//                    lié à ai-operator (ai-prd-restarter en PRD). Absent : aucune
//                    écriture n'est possible, le tool refuse.
// Le RBAC du cluster est la vraie barrière : la liste blanche du serveur et
// celle des RoleBindings disent la même chose, et les vérifications de
// démarrage (checks) signalent tout écart.
//
// Tools
//   lecture   pods_list, pod_logs, events_list, deployment_status, namespace_overview,
//             resource_list, resource_get, rollout_history, pod_metrics
//   écriture  deployment_restart, deployment_scale (simulation possible : dry_run)
// Jamais : les Secrets (aucun type ne les désigne), exec, port-forward, suppression.

import { z } from "zod";
import { request, requestJson, UpstreamError } from "../lib/http.ts";
import { credentialRefSchema, type CredentialRef } from "../lib/secrets.ts";
import type { ReadinessCheck, ServerModule } from "../lib/server.ts";
import { defineTool, ToolInputError } from "../lib/tool.ts";

const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const DNS1123_SUB = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const LABEL_SELECTOR = /^[\w./-]+(\s*(=|==|!=)\s*[\w.-]+)?(,[\w./-]+(\s*(=|==|!=)\s*[\w.-]+)?)*$/;

export const openshiftConfig = z.object({
  api: z.object({
    url: z.string().url().default("https://kubernetes.default.svc"),
    caFile: z.string().default("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
  }).default({ url: "https://kubernetes.default.svc", caFile: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt" }),
  namespaces: z.array(z.string().regex(DNS1123).max(63)).min(1).max(100),
  readCredential: credentialRefSchema,
  writeCredential: credentialRefSchema.optional(),
  /** Plafond de deployment_scale. */
  maxReplicas: z.number().int().min(1).max(100).default(10),
});
export type OpenshiftConfig = z.infer<typeof openshiftConfig>;

/** Les types lisibles par resource_list et resource_get. Les Secrets n'y sont pas, et n'y seront pas. */
export const KINDS = {
  Pod: { group: "", version: "v1", plural: "pods" },
  Deployment: { group: "apps", version: "v1", plural: "deployments" },
  StatefulSet: { group: "apps", version: "v1", plural: "statefulsets" },
  DaemonSet: { group: "apps", version: "v1", plural: "daemonsets" },
  ReplicaSet: { group: "apps", version: "v1", plural: "replicasets" },
  Job: { group: "batch", version: "v1", plural: "jobs" },
  CronJob: { group: "batch", version: "v1", plural: "cronjobs" },
  Service: { group: "", version: "v1", plural: "services" },
  ConfigMap: { group: "", version: "v1", plural: "configmaps" },
  PersistentVolumeClaim: { group: "", version: "v1", plural: "persistentvolumeclaims" },
  Route: { group: "route.openshift.io", version: "v1", plural: "routes" },
  Ingress: { group: "networking.k8s.io", version: "v1", plural: "ingresses" },
  NetworkPolicy: { group: "networking.k8s.io", version: "v1", plural: "networkpolicies" },
  HorizontalPodAutoscaler: { group: "autoscaling", version: "v2", plural: "horizontalpodautoscalers" },
  PodDisruptionBudget: { group: "policy", version: "v1", plural: "poddisruptionbudgets" },
} as const;
export type Kind = keyof typeof KINDS;
const kindEnum = z.enum(Object.keys(KINDS) as [Kind, ...Kind[]]);

const pathOf = (kind: Kind, namespace: string, name?: string) => {
  const k = KINDS[kind];
  const prefix = k.group ? `/apis/${k.group}/${k.version}` : `/api/${k.version}`;
  return `${prefix}/namespaces/${namespace}/${k.plural}${name ? `/${name}` : ""}`;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

/** Ce qui ne doit jamais sortir : champs de gestion, configuration appliquée, valeurs de ConfigMap, valeurs littérales d'env. */
export function sanitize(kind: Kind, input: Obj): Obj {
  const o: Obj = structuredClone(input);
  if (o.metadata) {
    delete o.metadata.managedFields;
    if (o.metadata.annotations) delete o.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"];
  }
  if (kind === "ConfigMap") {
    o.data = Object.fromEntries(Object.entries(o.data ?? {}).map(([k, v]) => [k, `[${Buffer.byteLength(String(v))} octets, valeur non renvoyée]`]));
    if (o.binaryData) o.binaryData = Object.fromEntries(Object.keys(o.binaryData).map((k) => [k, "[binaire, non renvoyé]"]));
  }
  const podSpecs: Obj[] = [];
  if (kind === "Pod") podSpecs.push(o.spec);
  if (o.spec?.template?.spec) podSpecs.push(o.spec.template.spec);
  if (o.spec?.jobTemplate?.spec?.template?.spec) podSpecs.push(o.spec.jobTemplate.spec.template.spec);
  for (const ps of podSpecs) {
    for (const c of [...(ps?.containers ?? []), ...(ps?.initContainers ?? [])]) {
      for (const e of c.env ?? []) if (typeof e.value === "string") e.value = "[masqué]";
    }
  }
  return o;
}

/** Une ligne par objet pour resource_list : l'état utile de chaque type, sans le reste. */
export function summarize(kind: Kind, it: Obj): Obj {
  const base = { name: it.metadata?.name, created: it.metadata?.creationTimestamp };
  const s = it.status ?? {};
  const sp = it.spec ?? {};
  switch (kind) {
    case "Pod": return { ...base, phase: s.phase, node: sp.nodeName };
    case "Deployment": return { ...base, ready: `${s.readyReplicas ?? 0}/${sp.replicas ?? 1}`, updated: s.updatedReplicas ?? 0, available: s.availableReplicas ?? 0 };
    case "StatefulSet": return { ...base, ready: `${s.readyReplicas ?? 0}/${sp.replicas ?? 1}` };
    case "DaemonSet": return { ...base, ready: `${s.numberReady ?? 0}/${s.desiredNumberScheduled ?? 0}`, unavailable: s.numberUnavailable ?? 0 };
    case "ReplicaSet": return { ...base, ready: `${s.readyReplicas ?? 0}/${sp.replicas ?? 0}`, revision: it.metadata?.annotations?.["deployment.kubernetes.io/revision"] };
    case "Job": return { ...base, active: s.active ?? 0, succeeded: s.succeeded ?? 0, failed: s.failed ?? 0, completed: s.completionTime ?? null };
    case "CronJob": return { ...base, schedule: sp.schedule, suspended: sp.suspend === true, last_schedule: s.lastScheduleTime ?? null, active: (s.active ?? []).length };
    case "Service": return { ...base, type: sp.type, cluster_ip: sp.clusterIP, ports: (sp.ports ?? []).map((p: Obj) => `${p.port}/${p.protocol ?? "TCP"}`) };
    case "ConfigMap": return { ...base, keys: Object.keys(it.data ?? {}).length + Object.keys(it.binaryData ?? {}).length };
    case "PersistentVolumeClaim": return { ...base, phase: s.phase, capacity: s.capacity?.storage ?? null, storage_class: sp.storageClassName ?? null };
    case "Route": return { ...base, host: sp.host, tls: sp.tls?.termination ?? null, service: sp.to?.name };
    case "Ingress": return { ...base, hosts: (sp.rules ?? []).map((r: Obj) => r.host).filter(Boolean) };
    case "NetworkPolicy": return { ...base, policy_types: sp.policyTypes ?? [], pod_selector: sp.podSelector?.matchLabels ?? {} };
    case "HorizontalPodAutoscaler": return { ...base, min: sp.minReplicas ?? 1, max: sp.maxReplicas, current: s.currentReplicas ?? 0, desired: s.desiredReplicas ?? 0 };
    case "PodDisruptionBudget": return { ...base, disruptions_allowed: s.disruptionsAllowed ?? 0, healthy: `${s.currentHealthy ?? 0}/${s.desiredHealthy ?? 0}` };
  }
}

/** « 250m », « 2 », « 123456789n » → millicœurs ; « 128Mi », « 131072Ki », « 1Gi », octets → Mio. */
export function parseCpuMillis(q: string): number {
  const m = /^(\d+(?:\.\d+)?)(n|u|m)?$/.exec(q.trim());
  if (!m) return 0;
  const v = Number(m[1]);
  return Math.round(m[2] === "n" ? v / 1e6 : m[2] === "u" ? v / 1e3 : m[2] === "m" ? v : v * 1000);
}
export function parseMemMiB(q: string): number {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|k)?$/.exec(q.trim());
  if (!m) return 0;
  const v = Number(m[1]);
  const f: Record<string, number> = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1000 / 1048576, k: 1000 / 1048576, M: 1e6 / 1048576, G: 1e9 / 1048576 };
  return Math.round((m[2] ? v * f[m[2]] : v / 1048576) * 10) / 10;
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

const eventTime = (e: K8sEvent) => Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp);

export const openshiftServer: ServerModule<OpenshiftConfig> = {
  name: "mcp-openshift",
  configSchema: openshiftConfig,

  createTools({ config, secrets }) {
    const nsEnum = z.enum(config.namespaces as [string, ...string[]]);
    const base = config.api.url.replace(/\/$/, "");

    const token = (namespace: string, write: boolean) => {
      const cred = write ? config.writeCredential : config.readCredential;
      if (!cred) throw new ToolInputError("action d'écriture non configurée sur ce cluster (writeCredential absent)");
      return secrets.resolve(cred, { namespace });
    };
    const call = async <T>(namespace: string, path: string, opts: { method?: string; json?: unknown; contentType?: string; write?: boolean; raw?: boolean; query?: Record<string, string | undefined> } = {}): Promise<T> => {
      const headers: Record<string, string> = { Authorization: `Bearer ${await token(namespace, !!opts.write)}` };
      if (opts.contentType) headers["Content-Type"] = opts.contentType;
      const q = new URLSearchParams(Object.entries(opts.query ?? {}).filter((e): e is [string, string] => e[1] !== undefined)).toString();
      const url = `${base}${path}${q ? `?${q}` : ""}`;
      if (opts.raw) {
        const res = await request(url, { headers: { ...headers, Accept: "text/plain" }, caFile: config.api.caFile, maxBytes: 2 * 1024 * 1024 });
        if (res.status !== 200) throw new UpstreamError(`API OpenShift : ${res.status} ${res.text.slice(0, 200)}`, res.status);
        return res.text as T;
      }
      return requestJson<T>(url, { method: opts.method, headers, caFile: config.api.caFile, ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}) });
    };
    const list = async (namespace: string, kind: Kind, opts: { labelSelector?: string; limit?: number } = {}) => {
      const res = await call<{ items: Obj[]; metadata?: { continue?: string } }>(namespace, pathOf(kind, namespace), {
        query: { labelSelector: opts.labelSelector, limit: opts.limit ? String(opts.limit) : undefined },
      });
      return { items: res.items ?? [], truncated: !!res.metadata?.continue };
    };

    return [
      defineTool({
        name: "pods_list",
        description: "Pods d'un namespace autorisé : phase, conteneurs prêts, redémarrages, nœud, propriétaire.",
        write: false,
        input: { namespace: nsEnum, label_selector: z.string().regex(LABEL_SELECTOR).max(200).optional() },
        async run({ namespace, label_selector }) {
          const { items } = await list(namespace, "Pod", { labelSelector: label_selector });
          return items.map((p) => {
            const cs: Obj[] = p.status?.containerStatuses ?? [];
            const waiting = cs.map((c) => c.state?.waiting?.reason).find(Boolean);
            return {
              name: p.metadata.name,
              phase: p.status?.phase,
              reason: waiting ?? p.status?.reason,
              ready: `${cs.filter((c) => c.ready).length}/${p.spec?.containers?.length ?? 0}`,
              restarts: cs.reduce((n, c) => n + (c.restartCount ?? 0), 0),
              node: p.spec?.nodeName,
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
          const text = await call<string>(namespace, `/api/v1/namespaces/${namespace}/pods/${pod}/log`, {
            raw: true, query: { tailLines: String(lines), previous: String(previous), container },
          });
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
            .map((e) => ({ ...e, at: eventTime(e) }))
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
          const d = await call<Obj>(namespace, pathOf("Deployment", namespace, name));
          const desired = d.spec?.replicas ?? 1;
          return {
            desired,
            ready: d.status?.readyReplicas ?? 0,
            updated: d.status?.updatedReplicas ?? 0,
            available: d.status?.availableReplicas ?? 0,
            unavailable: d.status?.unavailableReplicas ?? 0,
            rollout_complete: (d.status?.observedGeneration ?? 0) >= d.metadata.generation
              && (d.status?.updatedReplicas ?? 0) === desired
              && (d.status?.availableReplicas ?? 0) === desired,
            conditions: d.status?.conditions ?? [],
            images: (d.spec?.template?.spec?.containers ?? []).map((c: Obj) => ({ container: c.name, image: c.image })),
          };
        },
      }),

      defineTool({
        name: "namespace_overview",
        description: "Vue d'ensemble d'un namespace : charges en défaut, pods par phase, redémarrages, volumes en attente, avertissements des 15 dernières minutes.",
        write: false,
        input: { namespace: nsEnum },
        async run({ namespace }) {
          const [deps, sts, dss, pods, pvcs, events] = await Promise.all([
            list(namespace, "Deployment"), list(namespace, "StatefulSet"), list(namespace, "DaemonSet"),
            list(namespace, "Pod"), list(namespace, "PersistentVolumeClaim"),
            call<{ items: K8sEvent[] }>(namespace, `/api/v1/namespaces/${namespace}/events`),
          ]);
          const unhealthy = [
            ...deps.items.filter((d) => (d.status?.availableReplicas ?? 0) < (d.spec?.replicas ?? 1)).map((d) => ({ kind: "Deployment", ...summarize("Deployment", d) })),
            ...sts.items.filter((s) => (s.status?.readyReplicas ?? 0) < (s.spec?.replicas ?? 1)).map((s) => ({ kind: "StatefulSet", ...summarize("StatefulSet", s) })),
            ...dss.items.filter((d) => (d.status?.numberUnavailable ?? 0) > 0).map((d) => ({ kind: "DaemonSet", ...summarize("DaemonSet", d) })),
          ];
          const phases: Record<string, number> = {};
          for (const p of pods.items) phases[p.status?.phase ?? "Unknown"] = (phases[p.status?.phase ?? "Unknown"] ?? 0) + 1;
          const restarting = pods.items
            .map((p) => ({ name: p.metadata.name, restarts: (p.status?.containerStatuses ?? []).reduce((n: number, c: Obj) => n + (c.restartCount ?? 0), 0) }))
            .filter((p) => p.restarts > 0).sort((a, b) => b.restarts - a.restarts).slice(0, 10);
          const since = Date.now() - 15 * 60_000;
          const warnings = events.items.filter((e) => e.type === "Warning" && eventTime(e) >= since);
          const byReason: Record<string, number> = {};
          for (const e of warnings) byReason[e.reason] = (byReason[e.reason] ?? 0) + (e.count ?? 1);
          return {
            workloads: { deployments: deps.items.length, statefulsets: sts.items.length, daemonsets: dss.items.length },
            unhealthy,
            pods: phases,
            most_restarted: restarting,
            pvc_pending: pvcs.items.filter((p) => p.status?.phase !== "Bound").map((p) => p.metadata.name),
            warnings_15min: byReason,
          };
        },
      }),

      defineTool({
        name: "resource_list",
        description: "Liste les objets d'un type autorisé dans un namespace (déploiements, jobs, services, routes, PVC, HPA…), une ligne d'état par objet. Jamais de Secret.",
        write: false,
        input: {
          namespace: nsEnum,
          kind: kindEnum,
          label_selector: z.string().regex(LABEL_SELECTOR).max(200).optional(),
          limit: z.number().int().min(1).max(200).default(100),
        },
        async run({ namespace, kind, label_selector, limit }) {
          const { items, truncated } = await list(namespace, kind, { labelSelector: label_selector, limit });
          return { kind, namespace, count: items.length, truncated, items: items.map((it) => summarize(kind, it)) };
        },
      }),

      defineTool({
        name: "resource_get",
        description: "Un objet d'un type autorisé, sans champs de gestion, sans valeurs de ConfigMap ni valeurs littérales de variables d'environnement. Jamais de Secret.",
        write: false,
        input: { namespace: nsEnum, kind: kindEnum, name: z.string().regex(DNS1123_SUB).max(253) },
        async run({ namespace, kind, name }) {
          return sanitize(kind, await call<Obj>(namespace, pathOf(kind, namespace, name)));
        },
      }),

      defineTool({
        name: "rollout_history",
        description: "Historique des versions d'un déploiement (10 dernières révisions) : révision, images, date, réplicas encore actifs.",
        write: false,
        input: { namespace: nsEnum, name: z.string().regex(DNS1123).max(253) },
        async run({ namespace, name }) {
          const { items } = await list(namespace, "ReplicaSet");
          return items
            .filter((rs) => (rs.metadata.ownerReferences ?? []).some((o: Obj) => o.kind === "Deployment" && o.name === name))
            .map((rs) => ({
              revision: Number(rs.metadata.annotations?.["deployment.kubernetes.io/revision"] ?? 0),
              replicaset: rs.metadata.name,
              created: rs.metadata.creationTimestamp,
              replicas: rs.status?.replicas ?? 0,
              images: (rs.spec?.template?.spec?.containers ?? []).map((c: Obj) => ({ container: c.name, image: c.image })),
            }))
            .sort((a, b) => b.revision - a.revision)
            .slice(0, 10);
        },
      }),

      defineTool({
        name: "pod_metrics",
        description: "Consommation CPU (millicœurs) et mémoire (Mio) des pods d'un namespace, triée par CPU, d'après metrics.k8s.io.",
        write: false,
        input: {
          namespace: nsEnum,
          label_selector: z.string().regex(LABEL_SELECTOR).max(200).optional(),
          top: z.number().int().min(1).max(50).default(20),
        },
        async run({ namespace, label_selector, top }) {
          const res = await call<{ items: Obj[] }>(namespace, `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`, { query: { labelSelector: label_selector } });
          return (res.items ?? [])
            .map((p) => {
              const containers = (p.containers ?? []).map((c: Obj) => ({ name: c.name, cpu_m: parseCpuMillis(c.usage?.cpu ?? "0"), mem_mib: parseMemMiB(c.usage?.memory ?? "0") }));
              return {
                pod: p.metadata?.name,
                cpu_m: containers.reduce((n: number, c: Obj) => n + c.cpu_m, 0),
                mem_mib: Math.round(containers.reduce((n: number, c: Obj) => n + c.mem_mib, 0) * 10) / 10,
                containers,
                window: p.window,
              };
            })
            .sort((a, b) => b.cpu_m - a.cpu_m)
            .slice(0, top);
        },
      }),

      defineTool({
        name: "deployment_restart",
        description: "Redémarre UN déploiement (rollout restart, annotation restartedAt). dry_run : simulation côté serveur, rien n'est modifié. En PRD, exige une approbation.",
        write: true,
        input: { namespace: nsEnum, name: z.string().regex(DNS1123).max(253), dry_run: z.boolean().default(false) },
        // La même annotation que `oc rollout restart` : un seul champ à déclarer
        // dans ignoreDifferences côté Argo CD. Qui a redémarré est dans l'audit.
        async run({ namespace, name, dry_run }) {
          const restartedAt = new Date().toISOString();
          await call(namespace, pathOf("Deployment", namespace, name), {
            method: "PATCH",
            write: true,
            contentType: "application/strategic-merge-patch+json",
            query: { dryRun: dry_run ? "All" : undefined },
            json: { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": restartedAt } } } } },
          });
          return { namespace, deployment: name, restartedAt, dry_run };
        },
      }),

      defineTool({
        name: "deployment_scale",
        description: `Change le nombre de réplicas d'UN déploiement (0 à ${config.maxReplicas}). dry_run : simulation côté serveur. En PRD, exige une approbation.`,
        write: true,
        input: {
          namespace: nsEnum,
          name: z.string().regex(DNS1123).max(253),
          replicas: z.number().int().min(0).max(100),
          dry_run: z.boolean().default(false),
        },
        validate({ replicas }) {
          if (replicas > config.maxReplicas) throw new ToolInputError(`replicas : ${config.maxReplicas} au plus sur ce cluster`);
        },
        async run({ namespace, name, replicas, dry_run }) {
          const path = `${pathOf("Deployment", namespace, name)}/scale`;
          const current = await call<Obj>(namespace, path, { write: true });
          const before = current.spec?.replicas ?? 0;
          if (before === replicas) return { namespace, deployment: name, replicas, unchanged: true, dry_run };
          await call(namespace, path, {
            method: "PATCH",
            write: true,
            contentType: "application/merge-patch+json",
            query: { dryRun: dry_run ? "All" : undefined },
            json: { spec: { replicas } },
          });
          return { namespace, deployment: name, from: before, to: replicas, dry_run };
        },
      }),
    ];
  },

  checks({ config, secrets }) {
    const base = config.api.url.replace(/\/$/, "");
    const can = async (token: string, attrs: Record<string, string>) => {
      const res = await requestJson<{ status?: { allowed?: boolean } }>(`${base}/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        caFile: config.api.caFile,
        timeoutMs: 10_000,
        json: { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview", spec: { resourceAttributes: attrs } },
      });
      return res?.status?.allowed === true;
    };
    // Les droits réels de chaque compte, namespace par namespace : un écart
    // avec la liste blanche (RoleBinding oublié) se voit au démarrage.
    const rbac = (label: string, cred: CredentialRef, attrs: Record<string, string>): ReadinessCheck => ({
      name: `openshift:${label}`,
      critical: false,
      async run() {
        const missing: string[] = [];
        for (const ns of config.namespaces) {
          const token = await secrets.resolve(cred, { namespace: ns });
          if (!(await can(token, { ...attrs, namespace: ns }))) missing.push(ns);
        }
        const what = `${attrs.verb} ${attrs.group ? `${attrs.group}/` : ""}${attrs.resource}${attrs.subresource ? `/${attrs.subresource}` : ""}`;
        if (missing.length) throw new Error(`${what} refusé dans : ${missing.join(", ")}`);
        return `${what} permis dans ${config.namespaces.length} namespace(s)`;
      },
    });
    return [
      rbac("lecture", config.readCredential, { verb: "list", resource: "pods" }),
      ...(config.writeCredential
        ? [rbac("écriture", config.writeCredential, { verb: "patch", group: "apps", resource: "deployments" })]
        : []),
    ];
  },
};
