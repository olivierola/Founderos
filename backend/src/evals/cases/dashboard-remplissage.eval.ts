// Un collaborateur remplit le dashboard qui lui est confié (0301) : il lit la
// consigne, dépose chaque composant au bon format, refuse d'inventer une
// donnée qu'il n'a pas, puis publie sa synthèse. Le moteur valide les
// formats : une donnée mal formée est renvoyée à l'agent, pas enregistrée.

import { callTool, defineEval, say, type ModelReply } from "../harness.ts";

const ids = { dashboard: "", cpu: "", alerts: "", disk: "" };

export default defineEval({
  description: "un dashboard est rempli composant par composant, sans donnée inventée, puis publié",
  tags: ["dashboards", "smoke"],
  only: "mock",
  model: (req): ModelReply => {
    const calls = req.toolResults.filter((r) => r.name === "dashboard");
    if (calls.length === 0) return callTool("dashboard", { action: "brief", dashboard_id: ids.dashboard });
    if (calls.length === 1) {
      // Une première tentative mal formée : le moteur doit la refuser.
      return callTool("dashboard", { action: "fill", dashboard_id: ids.dashboard, widget_id: ids.cpu, data: { unit: "%" } });
    }
    if (calls.length === 2) {
      return {
        toolCalls: [
          { name: "dashboard", args: { action: "fill", dashboard_id: ids.dashboard, widget_id: ids.cpu, data: { value: 72, unit: "%", trend: [60, 65, 72] }, note: "Prometheus, moyenne 5 min." } },
          { name: "dashboard", args: { action: "fill", dashboard_id: ids.dashboard, widget_id: ids.alerts, data: { items: [{ title: "PodCrashLooping api-7", severity: "critical" }] }, note: "Alertmanager." } },
          { name: "dashboard", args: { action: "fill", dashboard_id: ids.dashboard, widget_id: ids.disk, status: "no_data", note: "Aucun accès aux volumes depuis ce collaborateur." } },
        ],
      };
    }
    if (calls.length === 5) {
      return callTool("dashboard", { action: "publish", dashboard_id: ids.dashboard, summary: "CPU à 72 %, une alerte critique sur api-7. Disque non mesuré (accès manquant)." });
    }
    return say("Le dashboard est à jour : CPU à 72 %, une alerte critique, le disque n'a pas pu être mesuré.");
  },
  async test(t) {
    const { data: d } = await t.admin.from("agent_dashboards").insert({
      workspace_id: t.workspaceId, project_id: t.projectId, agent_id: t.agentId,
      name: "Cluster {{cluster}}", usage_context: "Point SRE du matin.",
      parameters: [{ key: "cluster", label: "Cluster", value: "prod-eu-1" }],
    }).select("id").single();
    ids.dashboard = d.id;
    const widget = async (kind: string, title: string, instructions: string) => {
      const { data } = await t.admin.from("agent_dashboard_widgets").insert({
        dashboard_id: d.id, workspace_id: t.workspaceId, kind, title, instructions,
      }).select("id").single();
      return data.id as string;
    };
    ids.cpu = await widget("kpi", "CPU", "CPU moyen de {{cluster}} sur 5 min, en %.");
    ids.alerts = await widget("alerts", "Alertes", "Alertes actives de {{cluster}}.");
    ids.disk = await widget("gauge", "Disque", "Volume le plus plein de {{cluster}}, en %.");

    await t.send("Remplis le dashboard du cluster maintenant.");
    t.statusIs("succeeded");

    const dashCalls = t.calls.filter((c) => c.name === "dashboard");
    t.check("la donnée mal formée est refusée", dashCalls[1]?.ok === false, { detail: dashCalls[1]?.preview });

    const { data: rows } = await t.admin.from("agent_dashboard_widgets").select("id, data, fill_status, note, alert_level, alert_since").eq("dashboard_id", d.id);
    const byId = new Map((rows ?? []).map((r: { id: string }) => [r.id, r]));
    const cpu = byId.get(ids.cpu) as { data: { value: number; trend: number[] } | null; fill_status: string } | undefined;
    t.check("le KPI CPU est enregistré au bon format", cpu?.data?.value === 72 && cpu?.data?.trend?.length === 3 && cpu?.fill_status === "ok",
      { detail: JSON.stringify(cpu) });
    const disk = byId.get(ids.disk) as { data: unknown; fill_status: string; note: string } | undefined;
    t.check("le disque est marqué sans donnée, avec la raison, sans valeur inventée",
      disk?.fill_status === "no_data" && disk?.data == null && /accès/.test(disk?.note ?? ""), { detail: JSON.stringify(disk) });

    const alerts = byId.get(ids.alerts) as { alert_level: string | null; alert_since: string | null } | undefined;
    t.check("une alerte critique met le composant en état critique (0302)", alerts?.alert_level === "critical" && !!alerts?.alert_since,
      { detail: JSON.stringify(alerts) });

    const { data: snaps } = await t.admin.from("agent_dashboard_snapshots").select("status, summary, data").eq("dashboard_id", d.id);
    const snap = (snaps ?? [])[0] as { status: string; summary: string; data: Record<string, unknown> } | undefined;
    t.check("un instantané publié garde la synthèse et les trois composants",
      snap?.status === "done" && /72 %/.test(snap?.summary ?? "") && Object.keys(snap?.data ?? {}).length === 3,
      { detail: JSON.stringify(snap) });
    const { data: dash } = await t.admin.from("agent_dashboards").select("last_filled_at, last_summary").eq("id", d.id).single();
    t.check("le dashboard sait quand il a été rempli", !!dash?.last_filled_at && !!dash?.last_summary);
  },
});
