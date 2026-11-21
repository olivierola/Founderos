/**
 * Les composants des dashboards d'agents sur des données d'exemple, sans
 * connexion ni réseau — servi par le serveur de dev à /dashboard-harness.html
 * (?theme=dark pour le thème sombre). Un navigateur sans tête l'ouvre et en
 * fait une capture : c'est la façon la moins chère de VOIR les graphiques.
 */
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { WidgetBody } from "@/features/agent-dashboards/widgets";
import { normalizeWidgetData, type WidgetConfig, type WidgetKind } from "@/features/agent-dashboards/api";
import "@/styles/globals.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.add(dark ? "dark" : "light");

const hours = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}h`);
const wave = (base: number, amp: number) => hours.map((_, i) => Math.round(base + amp * Math.sin(i / 3) + (i % 5)));

const FIXTURES: Array<{ title: string; kind: WidgetKind; span: string; config?: WidgetConfig; data: unknown }> = [
  { title: "CPU", kind: "kpi", span: "col-span-3", config: { unit: "%", thresholds: { warn: 70, critical: 90 } }, data: { value: 72.4, delta: 8.2, delta_label: "vs hier", trend: wave(60, 10) } },
  { title: "Mémoire", kind: "kpi", span: "col-span-3", config: { unit: "%", thresholds: { warn: 75, critical: 90 } }, data: { value: 54, delta: -3.1, trend: wave(55, 4) } },
  { title: "Disque", kind: "gauge", span: "col-span-3", config: { unit: "%", max: 100, thresholds: { warn: 80, critical: 92 } }, data: { value: 93 } },
  { title: "Pods en échec", kind: "kpi", span: "col-span-3", config: { thresholds: { warn: 1, critical: 5 } }, data: { value: 2, caption: "api-7, worker-3" } },
  { title: "Activité sur 24 h", kind: "line", span: "col-span-8", data: { labels: hours, series: [{ name: "RPS", data: wave(420, 120) }, { name: "Erreurs", data: wave(30, 12) }] } },
  { title: "Alertes par sévérité", kind: "donut", span: "col-span-4", data: { items: [{ label: "Critique", value: 3 }, { label: "Attention", value: 7 }, { label: "Info", value: 12 }] } },
  { title: "Requêtes par service", kind: "bar", span: "col-span-6", data: { labels: ["api", "web", "worker", "auth", "search"], series: [{ name: "Requêtes", data: [820, 640, 310, 220, 180] }] } },
  { title: "Tickets reçus", kind: "area", span: "col-span-6", data: { labels: hours, series: [{ name: "Tickets", data: wave(40, 15) }] } },
  { title: "Alertes actives", kind: "alerts", span: "col-span-6", data: { items: [
    { title: "PodCrashLooping api-7", severity: "critical", source: "prod/api", time: new Date(Date.now() - 12 * 60000).toISOString(), detail: "OOMKilled après le déploiement de 10:42." },
    { title: "Disque > 90 % sur pv-data-2", severity: "critical", source: "prod/db", time: new Date(Date.now() - 40 * 60000).toISOString() },
    { title: "Latence p95 > 800 ms", severity: "warn", source: "ingress", time: new Date(Date.now() - 90 * 60000).toISOString() },
  ] } },
  { title: "Pods à surveiller", kind: "table", span: "col-span-6", data: { columns: [{ key: "pod", label: "Pod" }, { key: "restarts", label: "Redémarrages" }, { key: "age", label: "Âge" }], rows: [
    { pod: "api-7", restarts: 14, age: "2 h", _status: "critical" }, { pod: "worker-3", restarts: 3, age: "5 h", _status: "warn" }, { pod: "web-1", restarts: 0, age: "3 j", _status: "ok" },
  ] } },
  { title: "Lecture de l'agent", kind: "text", span: "col-span-12", data: { markdown: "**Cause probable** : le déploiement de 10:42 a réduit la limite mémoire d'`api`.\n\n- Risque : saturation du disque `pv-data-2` d'ici 6 h.\n- Action : relever la limite à 1 Go et purger les journaux." } },
];

function Harness() {
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="grid grid-cols-12 gap-4">
        {FIXTURES.map((f) => {
          const n = normalizeWidgetData(f.kind, f.data);
          const height = f.kind === "kpi" || f.kind === "gauge" ? 170 : f.kind === "text" ? 150 : 260;
          return (
            <section key={f.title} className={`${f.span} flex flex-col overflow-hidden rounded-2xl border border-border bg-card`} style={{ height }}>
              <h3 className="px-4 pt-3.5 text-13 font-medium text-muted-foreground">{f.title}</h3>
              <div className="min-h-0 flex-1 px-4 pb-3 pt-2.5">
                {"data" in n ? <WidgetBody kind={f.kind} data={n.data} config={f.config ?? {}} /> : <p className="text-red-600">{n.error}</p>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
