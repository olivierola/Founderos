// mcp-prtg — capteurs PRTG en erreur et historique d'un capteur. Lecture seule.
// Placement à définir (la doc d'architecture le laisse ouvert) : là où PRTG est
// joignable, IPS par défaut dans le catalogue.
//
// API HTTP classique de PRTG, clé d'API en lecture dans le paramètre apitoken
// (KV de Vault, secret/mcp/ips/prtg/). La clé n'apparaît ni dans l'audit ni dans les erreurs.

import { z } from "zod";
import { request, UpstreamError } from "../lib/http.ts";
import { credentialRefSchema } from "../lib/secrets.ts";
import type { ServerModule } from "../lib/server.ts";
import { defineTool } from "../lib/tool.ts";

export const prtgConfig = z.object({
  url: z.string().url(),
  caFile: z.string().optional(),
  apiKey: credentialRefSchema,
});
export type PrtgConfig = z.infer<typeof prtgConfig>;

/** 5 en panne, 14 panne partielle, 13 panne acquittée. */
const DOWN_STATUSES = ["5", "14", "13"];

function prtgDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export const prtgServer: ServerModule<PrtgConfig> = {
  name: "mcp-prtg",
  configSchema: prtgConfig,
  createTools({ config, secrets }) {
    const base = config.url.replace(/\/$/, "");

    const get = async <T>(path: string, params: Record<string, string>, repeat: Array<[string, string]> = []): Promise<T> => {
      const q = new URLSearchParams(params);
      for (const [k, v] of repeat) q.append(k, v);
      const key = await secrets.resolve(config.apiKey, {});
      q.set("apitoken", key);
      const res = await request(`${base}${path}?${q}`, { caFile: config.caFile, timeoutMs: 20_000 });
      // Jamais l'URL dans l'erreur : elle porte la clé.
      if (res.status !== 200) throw new UpstreamError(`PRTG a répondu ${res.status} sur ${path}`, res.status);
      try {
        return JSON.parse(res.text) as T;
      } catch {
        throw new UpstreamError(`PRTG : réponse non JSON sur ${path}`);
      }
    };

    return [
      defineTool({
        name: "sensors_down",
        description: "Capteurs PRTG en erreur (pannes, pannes partielles, acquittées) ; avec sensor_id, l'historique de ce capteur.",
        write: false,
        input: {
          sensor_id: z.number().int().positive().optional(),
          hours: z.number().int().min(1).max(24).default(6).describe("Fenêtre d'historique (24 h max)"),
          limit: z.number().int().min(1).max(200).default(100),
        },
        async run({ sensor_id, hours, limit }) {
          if (sensor_id === undefined) {
            const res = await get<{ sensors?: Array<Record<string, unknown>> }>("/api/table.json", {
              content: "sensors",
              columns: "objid,probe,group,device,sensor,status,message,lastvalue,priority,downtimesince",
              count: String(limit),
            }, DOWN_STATUSES.map((s) => ["filter_status", s] as [string, string]));
            return { count: res.sensors?.length ?? 0, sensors: res.sensors ?? [] };
          }
          const end = new Date();
          const start = new Date(end.getTime() - hours * 3_600_000);
          const details = await get<{ sensordata?: Record<string, unknown> }>("/api/getsensordetails.json", { id: String(sensor_id) });
          const history = await get<{ histdata?: Array<Record<string, unknown>> }>("/api/historicdata.json", {
            id: String(sensor_id), sdate: prtgDate(start), edate: prtgDate(end), avg: String(hours <= 6 ? 300 : 900), usecaption: "1",
          });
          return { sensor_id, details: details.sensordata ?? null, history: (history.histdata ?? []).slice(-200) };
        },
      }),
    ];
  },
};
