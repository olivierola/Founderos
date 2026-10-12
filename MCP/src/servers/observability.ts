// mcp-observability — sur le Hub : Observatorium (métriques de tous les
// clusters), Loki, Alertmanager, Grafana, indicateurs Percona.
//
// Aucun texte libre n'atteint Loki : la requête LogQL est construite à partir
// d'une application de la liste blanche, d'un niveau et d'une durée. PromQL est
// libre (lecture seule), mais borné en durée, en pas et en longueur.

import { z } from "zod";
import { CLUSTERS, type Cluster } from "../lib/catalog.ts";
import { requestJson } from "../lib/http.ts";
import { credentialRefSchema } from "../lib/secrets.ts";
import type { ServerModule } from "../lib/server.ts";
import { defineTool, ToolInputError } from "../lib/tool.ts";

const LABEL_SELECTOR = /^\s*[a-zA-Z_][a-zA-Z0-9_]*\s*(=|!=|=~|!~)\s*"[^"\\]*"(\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*\s*(=|!=|=~|!~)\s*"[^"\\]*")*\s*$/;

const endpoint = z.object({
  url: z.string().url(),
  token: credentialRefSchema.optional(),
  caFile: z.string().optional(),
});

export const observabilityConfig = z.object({
  /** Clusters qu'on peut viser (filtre par label, cible des silences). */
  clusters: z.array(z.enum(CLUSTERS)).min(1),
  observatorium: endpoint.extend({
    /** Label qui porte le nom du cluster dans les séries (ACM : `cluster`). */
    clusterLabel: z.string().default("cluster"),
  }),
  loki: endpoint.extend({
    /** En-tête de tenant Loki (X-Scope-OrgID), si l'instance est multi-tenant. */
    orgId: z.string().optional(),
    namespaceLabel: z.string().default("kubernetes_namespace_name"),
    clusterLabel: z.string().optional(),
    /** json : `| json | level="…"` ; label : `{level="…"}`. */
    levelMode: z.enum(["json", "label"]).default("json"),
    levelLabel: z.string().default("level"),
  }),
  /** Application → namespace (et cluster) : seules ces applications sont lisibles. */
  apps: z.record(z.string(), z.object({ namespace: z.string(), cluster: z.enum(CLUSTERS) })),
  alertmanager: endpoint.extend({ clusterLabel: z.string().default("managed_cluster") }),
  grafana: endpoint,
  /** Bases suivies : sélecteur de labels des séries de l'exporter Percona. */
  databases: z.record(z.string(), z.object({
    engine: z.enum(["mysql", "postgresql", "mongodb"]),
    selector: z.string().regex(LABEL_SELECTOR, "sélecteur de labels invalide"),
  })).default({}),
});
export type ObservabilityConfig = z.infer<typeof observabilityConfig>;

const LEVELS = ["error", "warn", "info", "debug"] as const;

const DB_QUERIES: Record<"mysql" | "postgresql" | "mongodb", Record<string, (sel: string) => string>> = {
  mysql: {
    up: (s) => `min(mysql_up{${s}})`,
    galera_cluster_size: (s) => `min(mysql_global_status_wsrep_cluster_size{${s}})`,
    connections: (s) => `sum(mysql_global_status_threads_connected{${s}})`,
    max_connections: (s) => `max(mysql_global_variables_max_connections{${s}})`,
    slow_queries_per_s: (s) => `sum(rate(mysql_global_status_slow_queries{${s}}[5m]))`,
  },
  postgresql: {
    up: (s) => `min(pg_up{${s}})`,
    connections: (s) => `sum(pg_stat_activity_count{${s}})`,
    max_connections: (s) => `max(pg_settings_max_connections{${s}})`,
    replication_lag_s: (s) => `max(pg_replication_lag{${s}})`,
  },
  mongodb: {
    up: (s) => `min(mongodb_up{${s}})`,
    connections: (s) => `sum(mongodb_connections{${s},state="current"})`,
  },
};

export function buildLogQl(cfg: ObservabilityConfig["loki"], namespace: string, cluster: Cluster, level: string): string {
  const matchers = [`${cfg.namespaceLabel}="${namespace}"`];
  if (cfg.clusterLabel) matchers.push(`${cfg.clusterLabel}="${cluster}"`);
  if (cfg.levelMode === "label") return `{${[...matchers, `${cfg.levelLabel}="${level}"`].join(", ")}}`;
  return `{${matchers.join(", ")}} | json | ${cfg.levelLabel}=~"(?i)${level}"`;
}

type PromResult = { status: string; data: { resultType: string; result: Array<{ metric: Record<string, string>; value?: [number, string]; values?: Array<[number, string]> }> } };

export const observabilityServer: ServerModule<ObservabilityConfig> = {
  name: "mcp-observability",
  configSchema: observabilityConfig,
  createTools({ config, secrets }) {
    const auth = async (e: z.infer<typeof endpoint>, extra: Record<string, string> = {}) => ({
      ...(e.token ? { Authorization: `Bearer ${await secrets.resolve(e.token, {})}` } : {}),
      ...extra,
    });
    const clusterEnum = z.enum(config.clusters as [Cluster, ...Cluster[]]);

    const promQuery = async (path: string, params: Record<string, string>) => {
      const o = config.observatorium;
      const res = await requestJson<PromResult>(
        `${o.url.replace(/\/$/, "")}${path}?${new URLSearchParams(params)}`,
        { headers: await auth(o), caFile: o.caFile, timeoutMs: 30_000 },
      );
      return res.data;
    };

    return [
      defineTool({
        name: "metrics_query",
        description: "Requête PromQL sur Observatorium (tous les clusters, label de cluster inclus). Fenêtre de 24 h au plus, pas de 30 s au moins.",
        write: false,
        input: {
          query: z.string().min(1).max(2000).describe("Expression PromQL"),
          minutes: z.number().int().min(1).max(1440).default(60).describe("Fenêtre jusqu'à maintenant, en minutes (24 h max)"),
          step_seconds: z.number().int().min(30).max(3600).default(60).describe("Pas en secondes (30 s min)"),
        },
        async run({ query, minutes, step_seconds }) {
          const end = Math.floor(Date.now() / 1000);
          const data = await promQuery("/api/v1/query_range", {
            query, start: String(end - minutes * 60), end: String(end), step: String(step_seconds),
          });
          return {
            resultType: data.resultType,
            series: data.result.slice(0, 50).map((s) => ({ metric: s.metric, points: (s.values ?? []).slice(-120) })),
            truncated_series: Math.max(0, data.result.length - 50),
          };
        },
      }),

      defineTool({
        name: "logs_query",
        description: "Dernières lignes de log d'une application de la liste blanche, filtrées par niveau. 1 h et 500 lignes au plus.",
        write: false,
        input: {
          app: z.string().describe(`Application : ${Object.keys(config.apps).join(", ") || "(aucune configurée)"}`),
          level: z.enum(LEVELS).default("error"),
          minutes: z.number().int().min(1).max(60).default(15),
          limit: z.number().int().min(1).max(500).default(200),
        },
        validate({ app }) {
          if (!Object.hasOwn(config.apps, app)) throw new ToolInputError(`Application non autorisée : ${app}`);
        },
        targetCluster: ({ app }) => config.apps[app].cluster,
        async run({ app, level, minutes, limit }) {
          const { namespace, cluster } = config.apps[app];
          const l = config.loki;
          const end = Date.now() * 1_000_000;
          const query = buildLogQl(l, namespace, cluster, level);
          const res = await requestJson<{ data: { result: Array<{ stream: Record<string, string>; values: Array<[string, string]> }> } }>(
            `${l.url.replace(/\/$/, "")}/loki/api/v1/query_range?${new URLSearchParams({
              query, start: String(end - minutes * 60 * 1_000_000_000), end: String(end), limit: String(limit), direction: "backward",
            })}`,
            { headers: await auth(l, l.orgId ? { "X-Scope-OrgID": l.orgId } : {}), caFile: l.caFile, timeoutMs: 30_000 },
          );
          const lines = res.data.result
            .flatMap((s) => s.values.map(([ts, line]) => ({ ts: Number(BigInt(ts) / 1_000_000n), pod: s.stream.kubernetes_pod_name, line })))
            .sort((a, b) => b.ts - a.ts)
            .slice(0, limit)
            .map((e) => `${new Date(e.ts).toISOString()} ${e.pod ?? ""} ${e.line}`);
          return { app, namespace, cluster, level, minutes, count: lines.length, lines };
        },
      }),

      defineTool({
        name: "alerts_list",
        description: "Alertes actives (non silencées) et silences en cours d'Alertmanager, éventuellement pour un cluster.",
        write: false,
        input: {
          cluster: clusterEnum.optional(),
          include_silences: z.boolean().default(true),
        },
        async run({ cluster, include_silences }) {
          const a = config.alertmanager;
          const base = a.url.replace(/\/$/, "");
          const headers = await auth(a);
          const q = new URLSearchParams({ active: "true", silenced: "false", inhibited: "false" });
          if (cluster) q.append("filter", `${a.clusterLabel}="${cluster}"`);
          const alerts = await requestJson<Array<{ labels: Record<string, string>; annotations: Record<string, string>; startsAt: string; status: { state: string } }>>(
            `${base}/api/v2/alerts?${q}`, { headers, caFile: a.caFile },
          );
          const silences = include_silences
            ? (await requestJson<Array<{ id: string; status: { state: string }; matchers: unknown; endsAt: string; createdBy: string; comment: string }>>(
                `${base}/api/v2/silences`, { headers, caFile: a.caFile },
              )).filter((s) => s.status.state === "active")
            : [];
          return {
            alerts: alerts.slice(0, 200).map((x) => ({
              name: x.labels.alertname, severity: x.labels.severity, cluster: x.labels[a.clusterLabel],
              namespace: x.labels.namespace, since: x.startsAt, summary: x.annotations.summary ?? x.annotations.description,
            })),
            silences: silences.map((s) => ({ id: s.id, matchers: s.matchers, endsAt: s.endsAt, createdBy: s.createdBy, comment: s.comment })),
          };
        },
      }),

      defineTool({
        name: "dashboard_find",
        description: "Recherche de tableaux de bord Grafana par titre (lecture seule).",
        write: false,
        input: { query: z.string().min(2).max(100) },
        async run({ query }) {
          const g = config.grafana;
          const base = g.url.replace(/\/$/, "");
          const res = await requestJson<Array<{ uid: string; title: string; url: string; folderTitle?: string; tags?: string[] }>>(
            `${base}/api/search?${new URLSearchParams({ query, type: "dash-db", limit: "20" })}`,
            { headers: await auth(g), caFile: g.caFile },
          );
          return res.map((d) => ({ title: d.title, uid: d.uid, folder: d.folderTitle, tags: d.tags, url: `${base}${d.url}` }));
        },
      }),

      defineTool({
        name: "db_health",
        description: "Indicateurs de santé d'une base suivie (exporters Percona) : disponibilité, connexions, réplication. Pas de requête SQL.",
        write: false,
        input: { database: z.string().describe(`Base : ${Object.keys(config.databases).join(", ") || "(aucune configurée)"}`) },
        validate({ database }) {
          if (!Object.hasOwn(config.databases, database)) throw new ToolInputError(`Base non suivie : ${database}`);
        },
        async run({ database }) {
          const db = config.databases[database];
          const out: Record<string, number | null> = {};
          for (const [name, build] of Object.entries(DB_QUERIES[db.engine])) {
            const data = await promQuery("/api/v1/query", { query: build(db.selector) });
            const v = data.result[0]?.value?.[1];
            out[name] = v === undefined ? null : Number(v);
          }
          return { database, engine: db.engine, indicators: out };
        },
      }),

      defineTool({
        name: "alert_silence_create",
        description: "Crée un silence Alertmanager sur une alerte d'un cluster : 2 h au plus, commentaire obligatoire. En PRD, exige une approbation.",
        write: true,
        input: {
          alertname: z.string().min(1).max(200),
          cluster: clusterEnum,
          namespace: z.string().regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/).max(63).optional(),
          duration_minutes: z.number().int().min(5).max(120),
          comment: z.string().min(10, "commentaire obligatoire (10 caractères au moins)").max(500),
        },
        targetCluster: ({ cluster }) => cluster,
        async run({ alertname, cluster, namespace, duration_minutes, comment }, ctx) {
          const a = config.alertmanager;
          const now = new Date();
          const matchers = [
            { name: "alertname", value: alertname, isRegex: false, isEqual: true },
            { name: a.clusterLabel, value: cluster, isRegex: false, isEqual: true },
            ...(namespace ? [{ name: "namespace", value: namespace, isRegex: false, isEqual: true }] : []),
          ];
          const res = await requestJson<{ silenceID: string }>(`${a.url.replace(/\/$/, "")}/api/v2/silences`, {
            method: "POST",
            headers: await auth(a),
            caFile: a.caFile,
            json: {
              matchers,
              startsAt: now.toISOString(),
              endsAt: new Date(now.getTime() + duration_minutes * 60_000).toISOString(),
              createdBy: ctx.identity.username ?? ctx.identity.sub,
              comment: `${comment} [FounderOS, agent ${ctx.identity.azp}, trace ${ctx.traceId}]`,
            },
          });
          return { silence_id: res.silenceID, ends_in_minutes: duration_minutes, matchers };
        },
      }),
    ];
  },
};
