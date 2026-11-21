// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/self-model.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// La CONSCIENCE DE SOI d'un agent : ce qu'il sait de lui-même au moment d'agir.
//
// Un agent qui ignore son équipe ne peut pas passer la main ; qui ignore ses
// échecs récents les répète ; qui ignore sa charge accepte tout. Ce module
// rassemble, en quelques requêtes, ce qu'un collègue humain sait sans y penser :
//
//   · son rôle, et l'équipe à laquelle il appartient (service_dashboards.settings.teams),
//     avec qui l'anime et ce que fait chaque coéquipier ;
//   · son bilan récent — réussites, échecs, et la dernière erreur, mot pour mot ;
//   · sa charge — les work items ouverts qu'on lui a confiés ;
//   · et une doctrine courte : connaître ses limites, passer la main, se
//     corriger, proposer.
//
// Le tout tient en une vingtaine de lignes, ajoutées à l'identité de l'agent.
// Chaque requête est bornée et une panne ne bloque rien : la section se réduit.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface SelfAgent {
  id: string;
  name: string;
  description?: string | null;
  service_dashboard_id?: string | null;
  is_orchestrator?: boolean | null;
}

interface TeamCfg {
  id: string; name: string; agent_ids: string[]; lead_id: string | null; focus?: string;
  /** Le flux d'une Teamz (0298) : qui passe la main à qui, consulte, relit. */
  links?: Array<{ from: string; to: string; kind: string; when: string }>;
  playbook?: string[];
}

const FLOW_VERB: Record<string, [string, string]> = {
  handoff: ["tu passes la main à", "tu reçois le travail de"],
  consult: ["tu consultes", "tu es consulté par"],
  review: ["tu fais relire par", "tu relis le travail de"],
};

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export async function loadSelfModel(admin: SupabaseClient, agent: SelfAgent): Promise<string> {
  try {
    const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    const [dash, runs, work] = await Promise.all([
      agent.service_dashboard_id
        ? admin.from("service_dashboards").select("name, settings").eq("id", agent.service_dashboard_id).maybeSingle()
        : Promise.resolve({ data: null }),
      admin.from("internal_agent_runs").select("status, error, finished_at")
        .eq("agent_id", agent.id).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(40),
      admin.from("pj_issue_agents").select("issue:pj_issues(name, completed_at, archived_at, target_date)")
        .eq("agent_id", agent.id).limit(40),
    ]);

    const lines: string[] = ["## Qui tu es (conscience de toi-même)"];
    if (agent.description) lines.push(`- Ton rôle : ${clip(agent.description, 220)}`);

    // L'équipe : qui l'anime, qui fait quoi.
    const settings = ((dash as { data: { name?: string; settings?: Record<string, unknown> } | null }).data?.settings ?? {}) as Record<string, unknown>;
    const teams = (Array.isArray(settings.teams) ? settings.teams : []) as TeamCfg[];
    const mine = teams.find((t) => Array.isArray(t.agent_ids) && t.agent_ids.includes(agent.id)) ?? null;
    const mateIds = mine ? mine.agent_ids.filter((id) => id !== agent.id) : [];
    if (mine) {
      const { data: mates } = mateIds.length
        ? await admin.from("internal_agents").select("id, name, description").in("id", mateIds.slice(0, 8)).eq("is_archived", false)
        : { data: [] as Array<{ id: string; name: string; description: string | null }> };
      const lead = mine.lead_id === agent.id ? "tu l'animes" : mine.lead_id
        ? `animée par ${(mates ?? []).find((m) => m.id === mine.lead_id)?.name ?? "un coéquipier"}` : "sans responsable désigné";
      lines.push(`- Ton équipe : ${mine.name}${mine.focus ? ` (${clip(mine.focus, 100)})` : ""}, ${lead}.`);
      for (const m of mates ?? []) lines.push(`  · ${m.name} — ${clip(m.description, 110) || "rôle non décrit"}`);
      // Le flux de travail de l'équipe, vu depuis cet agent : la passation
      // devient un réflexe (handoff_to_teammate) au lieu d'une improvisation.
      const nameOf = (id: string) => (mates ?? []).find((m) => m.id === id)?.name ?? null;
      const flow: string[] = [];
      for (const l of mine.links ?? []) {
        const verb = FLOW_VERB[l.kind];
        if (!verb) continue;
        if (l.from === agent.id && nameOf(l.to)) flow.push(`  · ${verb[0]} ${nameOf(l.to)} — ${clip(l.when, 90)}`);
        else if (l.to === agent.id && nameOf(l.from)) flow.push(`  · ${verb[1]} ${nameOf(l.from)} — ${clip(l.when, 90)}`);
      }
      if (flow.length) {
        lines.push("- Ton flux dans l'équipe (passer la main = handoff_to_teammate, avec critères de fin) :", ...flow.slice(0, 8));
      }
      if (mine.playbook?.length) lines.push(`- Règles de l'équipe : ${mine.playbook.slice(0, 4).map((r) => clip(r, 90)).join(" · ")}`);
      const others = teams.filter((t) => t !== mine).map((t) => t.name);
      if (others.length) lines.push(`- Les autres équipes du service : ${others.join(", ")}.`);
    } else if (teams.length) {
      lines.push(`- Tu n'es dans aucune équipe ; le service en compte ${teams.length} (${teams.map((t) => t.name).join(", ")}).`);
    }

    // Le bilan : ce qui a marché, ce qui a cassé.
    const rs = ((runs as { data: Array<{ status: string; error: string | null }> | null }).data ?? []);
    if (rs.length) {
      const ok = rs.filter((r) => r.status === "succeeded").length;
      const ko = rs.filter((r) => r.status === "failed").length;
      lines.push(`- Ton bilan sur 14 jours : ${ok} exécution(s) réussie(s), ${ko} en échec, sur ${rs.length}.`);
      const lastFail = rs.find((r) => r.status === "failed" && r.error);
      if (lastFail) lines.push(`- Ton dernier échec : « ${clip(lastFail.error, 200)} ». Ne refais pas la même erreur.`);
    }

    // La charge : ce qu'on t'a confié et qui n'est pas fini.
    type W = { issue: { name: string; completed_at: string | null; archived_at: string | null; target_date: string | null } | null };
    const open = (((work as { data: W[] | null }).data ?? []) as W[])
      .map((w) => w.issue).filter((i): i is NonNullable<W["issue"]> => !!i && !i.completed_at && !i.archived_at);
    if (open.length) {
      lines.push(`- Ta charge : ${open.length} work item(s) ouvert(s) — ${open.slice(0, 3).map((i) => `« ${clip(i.name, 60)} »${i.target_date ? ` (échéance ${i.target_date})` : ""}`).join(", ")}${open.length > 3 ? "…" : ""}.`);
    }

    lines.push(
      "- Connais tes limites : si un coéquipier est mieux outillé pour une partie du travail, passe-lui la main (send_message_to_agent, delegate_mission) plutôt que de bricoler.",
      "- Corrige-toi : quand un résultat, un pair ou un humain te montre une erreur, reconnais-la en une phrase, corrige, et retiens la leçon (save_memory, kind=learning).",
      "- Propose : une idée qui servirait l'équipe, un doute sur une décision, un livrable à faire relire — dis-le au bon collègue, brièvement, avec ce qui le justifie.",
    );
    return lines.join("\n");
  } catch {
    return "";
  }
}
