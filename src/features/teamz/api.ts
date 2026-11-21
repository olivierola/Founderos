// Teamz côté navigateur : le catalogue (partagé avec le serveur), la
// conception et le déploiement (internal-agent-a2a, actions team_design /
// team_deploy), et les chiffres qui donnent à une équipe sa crédibilité —
// exécutions réussies, livrables, échanges entre agents, temps gagné.

import { useQuery } from "@tanstack/react-query";
import { callEdge } from "@/lib/edge";
import { supabase } from "@/lib/supabase";
import type { AgentTeam } from "@/features/service-dashboards/model";
import {
  timeSaved, type BlueprintLint, type TeamBlueprint, type TimeSaved,
} from "../../../supabase/functions/_shared/teamz";

export { TEAMZ_CATALOG, findTeamzTemplate } from "../../../supabase/functions/_shared/teamz-catalog";
export {
  blueprintFromTemplate, composeMemberPrompt, describeCron, lintBlueprint, lintMember, timeSaved,
  type BlueprintLint, type MemberLint, type TeamBlueprint, type TeamzLink, type TeamzMember, type TeamzTemplate, type TimeSaved,
} from "../../../supabase/functions/_shared/teamz";

export interface DesignResponse {
  ok: true;
  blueprint_id: string | null;
  blueprint: TeamBlueprint;
  lint: BlueprintLint;
  refined: string[];
  origin: "architect" | "template" | "fallback";
  basedOn: string | null;
}

export interface DeployedAgent {
  id: string; key: string; name: string; role: string; lead: boolean;
  prompt_chars: number; tools: number; accent: string; emoji: string | null;
}

export interface DeployResponse {
  ok: true;
  team: AgentTeam;
  service: { id: string; name: string };
  agents: DeployedAgent[];
  missingPlugs: string[];
  routines: Array<{ label: string; owner: string; next_run_at: string }>;
  kickoffRunId: string | null;
  notes: string[];
  url: string | null;
  lint: BlueprintLint;
}

export function designTeam(dashboardId: string, brief: string, templateKey?: string | null): Promise<DesignResponse> {
  return callEdge<DesignResponse>("internal-agent-a2a", {
    action: "team_design", dashboard_id: dashboardId, brief, template_key: templateKey ?? undefined,
  });
}

export function deployTeam(dashboardId: string, opts: {
  blueprintId?: string | null; templateKey?: string | null; blueprint?: TeamBlueprint | null;
  kickoff?: boolean; routines?: boolean;
}): Promise<DeployResponse> {
  return callEdge<DeployResponse>("internal-agent-a2a", {
    action: "team_deploy", dashboard_id: dashboardId,
    blueprint_id: opts.blueprintId ?? undefined, template_key: opts.templateKey ?? undefined,
    blueprint: opts.blueprint ?? undefined,
    kickoff: opts.kickoff === true, routines: opts.routines !== false,
    tz_offset: new Date().getTimezoneOffset(),
  });
}

// ── Les chiffres d'une équipe ────────────────────────────────────────────────

export interface TeamStats {
  runs: number;
  deliverables: number;
  /** Échanges A2A des 7 derniers jours entre membres, par paire « a>b ». */
  exchanges: Map<string, number>;
  /** Le dernier échange, pour faire pulser le lien correspondant. */
  lastExchange: { from: string; to: string; at: string; kind: string } | null;
  saved: TimeSaved;
  live: Set<string>;
}

const DAY = 24 * 3600 * 1000;

/** Les chiffres réels des équipes d'un service, sur 30 jours (échanges : 7). */
export function useTeamsStats(teams: AgentTeam[]) {
  const ids = [...new Set(teams.flatMap((t) => t.agent_ids))].sort();
  return useQuery({
    queryKey: ["teamz_stats", ids.join(",")],
    enabled: ids.length > 0,
    refetchInterval: 20_000,
    queryFn: async () => {
      const since30 = new Date(Date.now() - 30 * DAY).toISOString();
      const since7 = new Date(Date.now() - 7 * DAY).toISOString();
      const [runs, delivs, a2a, live] = await Promise.all([
        supabase.from("internal_agent_runs").select("agent_id")
          .in("agent_id", ids).eq("status", "succeeded").gte("created_at", since30).limit(5000),
        supabase.from("internal_agent_deliverables").select("agent_id")
          .in("agent_id", ids).gte("created_at", since30).limit(5000),
        supabase.from("internal_agent_a2a_messages").select("from_agent, to_agent, kind, created_at")
          .in("from_agent", ids).gte("created_at", since7).order("created_at", { ascending: false }).limit(500),
        supabase.from("internal_agent_runs").select("agent_id")
          .in("agent_id", ids).in("status", ["running", "queued"]).limit(200),
      ]);
      const count = (rows: Array<{ agent_id: string | null }> | null) => {
        const m = new Map<string, number>();
        for (const r of rows ?? []) if (r.agent_id) m.set(r.agent_id, (m.get(r.agent_id) ?? 0) + 1);
        return m;
      };
      const runsBy = count(runs.data as Array<{ agent_id: string | null }> | null);
      const delivBy = count(delivs.data as Array<{ agent_id: string | null }> | null);
      const msgs = (a2a.data ?? []) as Array<{ from_agent: string; to_agent: string; kind: string; created_at: string }>;
      const liveSet = new Set(((live.data ?? []) as Array<{ agent_id: string }>).map((r) => r.agent_id));
      const out = new Map<string, TeamStats>();
      for (const t of teams) {
        const members = new Set(t.agent_ids);
        const r = t.agent_ids.reduce((n, id) => n + (runsBy.get(id) ?? 0), 0);
        const d = t.agent_ids.reduce((n, id) => n + (delivBy.get(id) ?? 0), 0);
        const exchanges = new Map<string, number>();
        let last: TeamStats["lastExchange"] = null;
        for (const m of msgs) {
          if (!members.has(m.from_agent) || !members.has(m.to_agent)) continue;
          const k = `${m.from_agent}>${m.to_agent}`;
          exchanges.set(k, (exchanges.get(k) ?? 0) + 1);
          if (!last) last = { from: m.from_agent, to: m.to_agent, at: m.created_at, kind: m.kind };
        }
        out.set(t.id, {
          runs: r, deliverables: d, exchanges, lastExchange: last,
          saved: timeSaved(r, d, t.minutes_per_run ?? 30),
          live: new Set(t.agent_ids.filter((id) => liveSet.has(id))),
        });
      }
      return out;
    },
  });
}

/** Les logos des apps (même requête et même cache que les cartes Connecter). */
export function useAppLogos() {
  const { data } = useQuery({
    queryKey: ["composio_toolkits"],
    staleTime: 5 * 60_000,
    queryFn: async () => (await callEdge<{ toolkits: Array<{ slug: string; logo: string | null; name: string }> }>("composio-catalog", {})).toolkits,
  });
  const m = new Map<string, { logo: string | null; name: string }>();
  for (const t of data ?? []) m.set(t.slug, { logo: t.logo, name: t.name });
  return m;
}

/** Les apps déjà branchées pour un service (les siennes et celles du projet). */
export function useConnectedApps(projectId: string | null | undefined, dashboardId: string | null | undefined) {
  const { data } = useQuery({
    queryKey: ["assistant_connector_status", projectId, dashboardId ?? null],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("connectors")
        .select("provider, status, scope, service_dashboard_id").eq("project_id", projectId!);
      return ((data ?? []) as Array<{ provider: string; status: string; scope: string | null; service_dashboard_id: string | null }>)
        .filter((c) => c.scope !== "personal" && (!c.service_dashboard_id || c.service_dashboard_id === dashboardId));
    },
  });
  return new Set((data ?? []).filter((c) => !c.status || ["connected", "active", "ok"].includes(c.status)).map((c) => c.provider.toLowerCase()));
}

/** « 37 h 20 » — lisible d'un coup d'œil. */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}

/** Les exemples qui donnent envie d'essayer l'architecte. */
export const ARCHITECT_PROMPTS = [
  "Une équipe qui gère notre support client sur Intercom et tient la doc Notion à jour",
  "Une cellule qui surveille 6 concurrents et m'envoie un brief chaque lundi",
  "Une équipe growth qui publie 2 articles SEO et 8 posts LinkedIn par semaine",
  "Une équipe qui prospecte des PME industrielles et prépare les séquences dans HubSpot",
  "Un cabinet qui trie mes emails, prépare mes réunions et me briefe le matin",
  "Une squad produit qui transforme les retours clients en specs et en PR testées",
];
