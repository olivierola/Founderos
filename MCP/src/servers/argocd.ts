// mcp-argocd — un par cluster : applications de l'Argo CD local, limitées aux
// AppProjects autorisés. app_sync n'est pas au catalogue de PRD : la production
// converge uniquement depuis Git.
//
// Identifiant : jeton d'un rôle de projet Argo CD, dans un Secret monté
// (/etc/mcp-secrets/argocd/token) ; le rôle lui-même ne donne que get (et sync
// hors PRD) sur ses applications.

import { z } from "zod";
import { requestJson } from "../lib/http.ts";
import { credentialRefSchema } from "../lib/secrets.ts";
import type { ReadinessCheck, ServerModule } from "../lib/server.ts";
import { defineTool, ToolInputError } from "../lib/tool.ts";

export const argocdConfig = z.object({
  url: z.string().url().describe("ex. https://openshift-gitops-server.openshift-gitops.svc"),
  caFile: z.string().optional(),
  token: credentialRefSchema,
  projects: z.array(z.string()).min(1),
});
export type ArgocdConfig = z.infer<typeof argocdConfig>;

interface Application {
  metadata: { name: string; namespace?: string };
  spec: { project: string; destination?: { server?: string; namespace?: string; name?: string }; source?: { repoURL?: string; path?: string; targetRevision?: string } };
  status?: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string; message?: string };
    operationState?: { phase?: string; message?: string; finishedAt?: string };
    conditions?: Array<{ type: string; message: string }>;
    resources?: Array<{ kind: string; namespace?: string; name: string; status?: string; health?: { status?: string }; requiresPruning?: boolean }>;
    history?: Array<{ id: number; revision: string; deployedAt: string; deployStartedAt?: string; source?: { repoURL?: string; path?: string; targetRevision?: string } }>;
  };
}

const APP_NAME = z.string().regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/).max(253);

export const argocdServer: ServerModule<ArgocdConfig> = {
  name: "mcp-argocd",
  configSchema: argocdConfig,
  createTools({ config, secrets }) {
    const base = config.url.replace(/\/$/, "");
    const headers = async () => ({ Authorization: `Bearer ${await secrets.resolve(config.token, {})}` });

    /** Lit l'application et vérifie qu'elle appartient à un projet autorisé. */
    const getApp = async (name: string): Promise<Application> => {
      const app = await requestJson<Application>(`${base}/api/v1/applications/${encodeURIComponent(name)}`, { headers: await headers(), caFile: config.caFile });
      if (!config.projects.includes(app.spec.project)) {
        throw new ToolInputError(`Application ${name} hors des projets autorisés (${app.spec.project})`);
      }
      return app;
    };

    return [
      defineTool({
        name: "app_status",
        description: "État d'une application Argo CD : synchronisation, santé, révision, dernière opération, conditions.",
        write: false,
        input: { app: APP_NAME },
        async run({ app }) {
          const a = await getApp(app);
          return {
            app, project: a.spec.project, destination: a.spec.destination,
            sync: a.status?.sync?.status, revision: a.status?.sync?.revision,
            health: a.status?.health?.status, health_message: a.status?.health?.message,
            last_operation: a.status?.operationState ? { phase: a.status.operationState.phase, message: a.status.operationState.message, finishedAt: a.status.operationState.finishedAt } : null,
            conditions: a.status?.conditions ?? [],
          };
        },
      }),

      defineTool({
        name: "app_diff",
        description: "Écart entre Git et le cluster : ressources désynchronisées ou en mauvaise santé.",
        write: false,
        input: { app: APP_NAME },
        async run({ app }) {
          const a = await getApp(app);
          const resources = a.status?.resources ?? [];
          const drift = resources.filter((r) => r.status && r.status !== "Synced" || r.requiresPruning || (r.health?.status && r.health.status !== "Healthy"));
          return {
            app, sync: a.status?.sync?.status, revision: a.status?.sync?.revision,
            total_resources: resources.length,
            drift: drift.slice(0, 100).map((r) => ({
              kind: r.kind, namespace: r.namespace, name: r.name, sync: r.status, health: r.health?.status, requires_pruning: r.requiresPruning ?? false,
            })),
          };
        },
      }),

      defineTool({
        name: "app_history",
        description: "Les 10 derniers déploiements d'une application : révision, date, source.",
        write: false,
        input: { app: APP_NAME },
        async run({ app }) {
          const a = await getApp(app);
          return (a.status?.history ?? []).slice(-10).reverse().map((h) => ({
            id: h.id, revision: h.revision, deployed_at: h.deployedAt, started_at: h.deployStartedAt,
            source: h.source ? { repo: h.source.repoURL, path: h.source.path, target: h.source.targetRevision } : null,
          }));
        },
      }),

      defineTool({
        name: "app_sync",
        description: "Synchronise une application depuis Git (sans prune). Une synchronisation déjà en cours n'est pas relancée. dry_run : simulation par Argo CD. Absent en PRD.",
        write: true,
        input: {
          app: APP_NAME,
          revision: z.string().regex(/^[\w./-]{1,100}$/).optional().describe("Révision cible ; défaut : celle de l'application"),
          dry_run: z.boolean().default(false),
        },
        async run({ app, revision, dry_run }) {
          const current = await getApp(app);
          // Un agent qui relance après un délai dépassé ne double pas l'opération.
          const op = current.status?.operationState;
          if (op?.phase === "Running") {
            return { app, dry_run, unchanged: true, operation: "Running", message: "une opération est déjà en cours : rien n'est relancé" };
          }
          const res = await requestJson<Application>(`${base}/api/v1/applications/${encodeURIComponent(app)}/sync`, {
            method: "POST", headers: await headers(), caFile: config.caFile,
            json: { prune: false, dryRun: dry_run, ...(revision ? { revision } : {}) },
          });
          return { app, dry_run, operation: res.status?.operationState?.phase ?? "Running" };
        },
      }),
    ];
  },

  // Le jeton du rôle de projet est valable et voit chaque projet autorisé.
  checks({ config, secrets }): ReadinessCheck[] {
    const base = config.url.replace(/\/$/, "");
    return [{
      name: "argocd:projets",
      critical: false,
      async run() {
        const headers = { Authorization: `Bearer ${await secrets.resolve(config.token, {})}` };
        const counts: string[] = [];
        for (const p of config.projects) {
          const res = await requestJson<{ items?: unknown[] | null }>(
            `${base}/api/v1/applications?${new URLSearchParams({ projects: p, fields: "items.metadata.name" })}`,
            { headers, caFile: config.caFile, timeoutMs: 10_000 },
          );
          counts.push(`${p} : ${res?.items?.length ?? 0} application(s)`);
        }
        return counts.join(" ; ");
      },
    }];
  },
};
