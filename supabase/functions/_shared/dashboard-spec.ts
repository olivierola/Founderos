// Les dashboards d'agents (0301) : ce qui est partagé entre le navigateur et
// les agents. Aucun import, aucun accès réseau : le front l'importe tel quel
// (src/features/dashboards), le moteur aussi (agent-dashboards.ts).
//
// Un dashboard est un MODÈLE écrit par un humain (ou par l'assistant) :
//   · des composants (KPI, jauge, courbe, barres, anneau, tableau, alertes,
//     texte), placés sur une grille de 12 colonnes ;
//   · pour chacun, les INSTRUCTIONS à l'agent : quoi afficher, avec quelles
//     sources, comment le calculer ;
//   · le CONTEXTE D'UTILISATION du dashboard : qui le lit, quand, pour décider
//     quoi ;
//   · des PARAMÈTRES ({{cluster}}, {{client}}…) qui rendent un modèle
//     réutilisable d'un périmètre à l'autre.
// Un collaborateur le REMPLIT : à la demande ou selon une cadence, il collecte
// les données avec ses outils et dépose chaque valeur au format du composant.
// Chaque remplissage laisse un instantané : l'historique se relit.

export const WIDGET_KINDS = ["kpi", "gauge", "line", "area", "bar", "donut", "table", "alerts", "text"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export type Status = "ok" | "warn" | "critical";

export interface WidgetConfig {
  /** Unité affichée après la valeur (%, ms, €, Go…). */
  unit?: string;
  /** Décimales affichées. */
  decimals?: number;
  /** Seuils d'alerte : au-dessus (ou en dessous) de warn → attention, de critical → critique. */
  thresholds?: { warn?: number | null; critical?: number | null; direction?: "above" | "below" };
  /** Jauge : la valeur pleine. */
  max?: number;
  /** Barres empilées. */
  stacked?: boolean;
}

export interface WidgetLayout { x: number; y: number; w: number; h: number }

export interface WidgetSpec {
  kind: WidgetKind;
  title: string;
  /** Ce que l'agent doit afficher ici, avec quoi et comment. */
  instructions: string;
  /** Les sources suggérées : outils, connecteurs, serveurs MCP. */
  sources?: string[];
  config?: WidgetConfig;
  layout?: WidgetLayout;
}

export interface DashboardParameter { key: string; label: string; value?: string }

export interface DashboardSpec {
  name: string;
  description?: string;
  /** Qui lit ce dashboard, quand, pour décider quoi. */
  usage_context?: string;
  parameters?: DashboardParameter[];
  widgets: WidgetSpec[];
}

// ── Les composants ───────────────────────────────────────────────────────────

export const WIDGET_META: Record<WidgetKind, {
  label: string;
  /** Ce que l'agent doit rendre, écrit pour lui. */
  format: string;
  size: { w: number; h: number };
}> = {
  kpi: {
    label: "KPI",
    format: `{"value": nombre ou texte, "unit"?: "%", "delta"?: variation en % vs la période précédente, "delta_label"?: "vs hier", "trend"?: [nombres, 12 à 30 points, du plus ancien au plus récent], "status"?: "ok"|"warn"|"critical", "caption"?: "une ligne de contexte"}`,
    size: { w: 3, h: 2 },
  },
  gauge: {
    label: "Jauge",
    format: `{"value": nombre, "max"?: nombre (100 par défaut), "unit"?: "%", "status"?: "ok"|"warn"|"critical", "caption"?: "…"}`,
    size: { w: 3, h: 2 },
  },
  line: {
    label: "Courbe",
    format: `{"labels": ["libellé de chaque point, du plus ancien au plus récent"], "series": [{"name": "…", "data": [nombres, autant que de labels]}], "unit"?: "…"} (8 séries au plus)`,
    size: { w: 6, h: 3 },
  },
  area: {
    label: "Aire",
    format: `{"labels": [...], "series": [{"name": "…", "data": [...]}], "unit"?: "…"} (une série de préférence)`,
    size: { w: 6, h: 3 },
  },
  bar: {
    label: "Barres",
    format: `{"labels": ["catégories"], "series": [{"name": "…", "data": [nombres]}], "unit"?: "…"} (8 séries au plus)`,
    size: { w: 6, h: 3 },
  },
  donut: {
    label: "Anneau",
    format: `{"items": [{"label": "…", "value": nombre}], "unit"?: "…"} (6 parts au plus ; le reste dans « Autres »)`,
    size: { w: 4, h: 3 },
  },
  table: {
    label: "Tableau",
    format: `{"columns": [{"key": "name", "label": "Nom"}], "rows": [{"name": "…", …, "_status"?: "ok"|"warn"|"critical"}]} (200 lignes au plus)`,
    size: { w: 12, h: 4 },
  },
  alerts: {
    label: "Alertes",
    format: `{"items": [{"title": "…", "severity": "info"|"warn"|"critical", "time"?: "ISO 8601", "source"?: "…", "detail"?: "…"}]} (les plus récentes d'abord)`,
    size: { w: 6, h: 4 },
  },
  text: {
    label: "Texte",
    format: `{"markdown": "analyse, synthèse ou recommandations en markdown, 4 000 caractères au plus"}`,
    size: { w: 6, h: 3 },
  },
};

export const isWidgetKind = (k: unknown): k is WidgetKind => typeof k === "string" && (WIDGET_KINDS as readonly string[]).includes(k);

// ── Les données d'un composant ───────────────────────────────────────────────

export type KpiData = { value: number | string; unit?: string; delta?: number; delta_label?: string; trend?: number[]; status?: Status; caption?: string };
export type GaugeData = { value: number; max: number; unit?: string; status?: Status; caption?: string };
export type SeriesData = { labels: string[]; series: Array<{ name: string; data: number[] }>; unit?: string };
export type DonutData = { items: Array<{ label: string; value: number }>; unit?: string };
export type TableData = { columns: Array<{ key: string; label: string }>; rows: Array<Record<string, string | number | null>> };
export type AlertsData = { items: Array<{ title: string; severity: "info" | "warn" | "critical"; time?: string; source?: string; detail?: string }> };
export type TextData = { markdown: string };
export type WidgetData = KpiData | GaugeData | SeriesData | DonutData | TableData | AlertsData | TextData;

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(",", ".")))) return Number(v.replace(",", "."));
  return null;
};
const txt = (v: unknown, max = 200): string | undefined => {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, max) : undefined;
};
const status = (v: unknown): Status | undefined => (v === "ok" || v === "warn" || v === "critical" ? v : undefined);
const parse = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
};

/**
 * Valide et normalise ce qu'un agent dépose dans un composant. Tolérant sur
 * la forme (nombres en texte, champs en trop), strict sur le fond : une
 * donnée inexploitable est refusée avec la raison, que l'agent lit.
 */
export function normalizeWidgetData(kind: WidgetKind, raw: unknown): { data: WidgetData } | { error: string } {
  const d = parse(raw) as Record<string, unknown> | null;
  if (!d || typeof d !== "object" || Array.isArray(d)) return { error: `data doit être un objet : ${WIDGET_META[kind].format}` };
  switch (kind) {
    case "kpi": {
      const n = num(d.value);
      const value = n ?? txt(d.value, 40);
      if (value === undefined) return { error: "kpi : value manquant." };
      const trend = Array.isArray(d.trend) ? d.trend.map(num).filter((x): x is number => x !== null).slice(-60) : undefined;
      return { data: {
        value, unit: txt(d.unit, 12), delta: num(d.delta) ?? undefined, delta_label: txt(d.delta_label, 30),
        trend: trend?.length ? trend : undefined, status: status(d.status), caption: txt(d.caption, 120),
      } };
    }
    case "gauge": {
      const value = num(d.value);
      if (value === null) return { error: "gauge : value doit être un nombre." };
      const max = num(d.max) ?? 100;
      return { data: { value, max: max > 0 ? max : 100, unit: txt(d.unit, 12), status: status(d.status), caption: txt(d.caption, 120) } };
    }
    case "line": case "area": case "bar": {
      const labels = Array.isArray(d.labels) ? d.labels.map((l) => String(l ?? "")).slice(0, 400) : [];
      const series = (Array.isArray(d.series) ? d.series : []).slice(0, 8).map((s, i) => {
        const o = (s ?? {}) as Record<string, unknown>;
        const data = (Array.isArray(o.data) ? o.data : []).map((x) => num(x) ?? 0).slice(0, labels.length || 400);
        return { name: txt(o.name, 60) ?? `Série ${i + 1}`, data };
      }).filter((s) => s.data.length > 0);
      if (!labels.length && series[0]) labels.push(...series[0].data.map((_, i) => String(i + 1)));
      if (!series.length) return { error: `${kind} : series vide. ${WIDGET_META[kind].format}` };
      for (const s of series) while (s.data.length < labels.length) s.data.push(0);
      return { data: { labels, series, unit: txt(d.unit, 12) } };
    }
    case "donut": {
      let items = (Array.isArray(d.items) ? d.items : []).map((it) => {
        const o = (it ?? {}) as Record<string, unknown>;
        return { label: txt(o.label, 60) ?? "?", value: Math.max(0, num(o.value) ?? 0) };
      }).filter((it) => it.value > 0).sort((a, b) => b.value - a.value);
      if (!items.length) return { error: "donut : items vide." };
      // Six parts au plus : au-delà, un anneau ne se lit plus.
      if (items.length > 6) {
        const rest = items.slice(5).reduce((s, it) => s + it.value, 0);
        items = [...items.slice(0, 5), { label: "Autres", value: rest }];
      }
      return { data: { items, unit: txt(d.unit, 12) } };
    }
    case "table": {
      const rows = (Array.isArray(d.rows) ? d.rows : []).slice(0, 200).map((r) => {
        const o = (r ?? {}) as Record<string, unknown>;
        const out: Record<string, string | number | null> = {};
        for (const [k, v] of Object.entries(o).slice(0, 16)) out[k] = typeof v === "number" ? v : v == null ? null : String(v).slice(0, 300);
        return out;
      });
      let columns = (Array.isArray(d.columns) ? d.columns : []).slice(0, 12).map((c) => {
        if (typeof c === "string") return { key: c, label: c };
        const o = (c ?? {}) as Record<string, unknown>;
        const key = txt(o.key, 60) ?? txt(o.label, 60) ?? "";
        return { key, label: txt(o.label, 60) ?? key };
      }).filter((c) => c.key);
      if (!columns.length && rows[0]) columns = Object.keys(rows[0]).filter((k) => k !== "_status").slice(0, 12).map((k) => ({ key: k, label: k }));
      if (!columns.length) return { error: "table : columns et rows vides." };
      return { data: { columns, rows } };
    }
    case "alerts": {
      const items = (Array.isArray(d.items) ? d.items : []).slice(0, 100).map((it) => {
        const o = (it ?? {}) as Record<string, unknown>;
        const sev = o.severity === "critical" || o.severity === "warn" || o.severity === "info" ? o.severity
          : o.severity === "warning" ? "warn" : o.severity === "error" || o.severity === "high" ? "critical" : "info";
        return { title: txt(o.title, 200) ?? "Alerte", severity: sev as "info" | "warn" | "critical", time: txt(o.time, 40), source: txt(o.source, 80), detail: txt(o.detail, 500) };
      });
      return { data: { items } };
    }
    case "text": {
      const markdown = txt(d.markdown ?? d.text, 4000);
      if (!markdown) return { error: "text : markdown vide." };
      return { data: { markdown } };
    }
  }
}

/** L'état d'une valeur face aux seuils du composant (ou celui que l'agent a donné). */
export function statusOf(value: number | null | undefined, config: WidgetConfig | undefined, given?: Status): Status | undefined {
  if (given) return given;
  const t = config?.thresholds;
  if (value == null || !t) return undefined;
  const below = t.direction === "below";
  const past = (limit: number | null | undefined) => limit != null && (below ? value <= limit : value >= limit);
  if (past(t.critical)) return "critical";
  if (past(t.warn)) return "warn";
  return t.warn != null || t.critical != null ? "ok" : undefined;
}

/** Remplace les {{paramètres}} d'un texte par leur valeur. */
export function applyParameters(text: string, params: DashboardParameter[] | undefined): string {
  if (!text || !params?.length) return text;
  return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, key: string) => {
    const p = params.find((x) => x.key === key);
    return p?.value ? p.value : m;
  });
}

// ── La consigne de l'agent ───────────────────────────────────────────────────

export interface BriefWidget {
  id: string; kind: WidgetKind; title: string; instructions: string; sources?: string[] | null; config?: WidgetConfig | null;
  /** La dernière valeur déposée, pour calculer les variations. */
  data?: unknown; filled_at?: string | null;
}

/** La consigne complète d'un remplissage : contexte, méthode, composants. */
export function buildDashboardBrief(d: {
  id: string; name: string; description?: string | null; usage_context?: string | null; parameters?: DashboardParameter[] | null;
}, widgets: BriefWidget[], lastSummary?: string | null): string {
  const params = d.parameters ?? [];
  const p = (s: string) => applyParameters(s, params);
  const lines: string[] = [
    `# Dashboard « ${p(d.name)} » (dashboard_id: ${d.id})`,
    d.description ? `\n${p(d.description)}` : "",
    d.usage_context ? `\n## Contexte d'utilisation\n${p(d.usage_context)}` : "",
    params.filter((x) => x.value).length ? `\n## Paramètres\n${params.filter((x) => x.value).map((x) => `- ${x.label || x.key} (${x.key}) = ${x.value}`).join("\n")}` : "",
    "\n## Méthode",
    "1. Pour chaque composant ci-dessous, collecte les données demandées avec tes outils (connecteurs, serveurs MCP, requêtes, commandes, recherche). Les sources indiquées sont des pistes : utilise celles que tu as.",
    "2. Dépose chaque résultat avec dashboard(action=\"fill\", widget_id, data, note), au format exact du composant. La note dit d'où vient la donnée et comment tu l'as calculée, en une phrase.",
    "3. N'invente JAMAIS un chiffre. Donnée introuvable ou outil indisponible : dashboard(action=\"fill\", widget_id, status=\"no_data\", note=\"pourquoi\").",
    "4. Termine par dashboard(action=\"publish\", summary) : ce qui a changé depuis le dernier remplissage, les anomalies, ce qui demande une action. Trois à six lignes, pour les personnes du contexte d'utilisation.",
    "\n## Composants",
  ];
  for (const w of widgets) {
    const t = w.config?.thresholds;
    const th = t && (t.warn != null || t.critical != null)
      ? ` Seuils : ${t.direction === "below" ? "en dessous de" : "au-dessus de"} ${t.warn ?? "–"} = attention, ${t.critical ?? "–"} = critique.`
      : "";
    lines.push(
      `\n### [${w.id}] ${WIDGET_META[w.kind].label} « ${p(w.title)} »`,
      `Instructions : ${p(w.instructions) || "(aucune : déduis-les du titre et du contexte)"}`,
      w.sources?.length ? `Sources suggérées : ${w.sources.join(", ")}` : "",
      `Format de data : ${WIDGET_META[w.kind].format}${w.config?.unit ? ` Unité : ${w.config.unit}.` : ""}${th}`,
      w.data != null && w.filled_at ? `Valeur précédente (${w.filled_at.slice(0, 16).replace("T", " ")}) : ${JSON.stringify(w.data).slice(0, 600)}` : "",
    );
  }
  if (lastSummary) lines.push(`\n## Synthèse du remplissage précédent\n${lastSummary.slice(0, 1200)}`);
  return lines.filter(Boolean).join("\n");
}

// ── Les modèles prêts à l'emploi ─────────────────────────────────────────────

export interface DashboardTemplate extends DashboardSpec { key: string; category: string; tagline: string }

const L = (x: number, y: number, w: number, h: number): WidgetLayout => ({ x, y, w, h });

export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  {
    key: "k8s-cluster", category: "Infrastructure", name: "Santé du cluster {{cluster}}",
    tagline: "CPU, mémoire, disque, activité et alertes d'un cluster Kubernetes.",
    description: "L'état du cluster {{cluster}} et de ses alertes.",
    usage_context: "Lu par l'équipe SRE au point du matin et pendant un incident : savoir en dix secondes si le cluster tient, ce qui sature et quelles alertes traiter d'abord.",
    parameters: [{ key: "cluster", label: "Cluster", value: "" }],
    widgets: [
      { kind: "kpi", title: "CPU", instructions: "Utilisation CPU moyenne du cluster {{cluster}} sur les 5 dernières minutes, en %. trend : les 24 dernières heures, un point par heure. delta : variation vs il y a 24 h.", sources: ["prometheus", "grafana", "kubectl top nodes"], config: { unit: "%", thresholds: { warn: 70, critical: 90 } }, layout: L(0, 0, 3, 2) },
      { kind: "kpi", title: "Mémoire", instructions: "Mémoire utilisée sur le cluster {{cluster}}, en % de l'allouable. Même trend et delta que le CPU.", sources: ["prometheus", "kubectl top nodes"], config: { unit: "%", thresholds: { warn: 75, critical: 90 } }, layout: L(3, 0, 3, 2) },
      { kind: "gauge", title: "Disque", instructions: "Occupation des volumes persistants du cluster {{cluster}} (le volume le plus plein), en %.", sources: ["prometheus", "kubectl get pvc"], config: { unit: "%", max: 100, thresholds: { warn: 80, critical: 92 } }, layout: L(6, 0, 3, 2) },
      { kind: "kpi", title: "Pods en échec", instructions: "Nombre de pods en CrashLoopBackOff, Error ou Pending depuis plus de 5 minutes sur {{cluster}}.", sources: ["kubectl get pods -A"], config: { thresholds: { warn: 1, critical: 5 } }, layout: L(9, 0, 3, 2) },
      { kind: "line", title: "Activité sur 24 h", instructions: "Requêtes par seconde (série « RPS ») et latence p95 en ms (série « p95 ») du point d'entrée de {{cluster}}, un point par heure sur les dernières 24 h. Si les ordres de grandeur sont trop éloignés, ne garde que RPS.", sources: ["prometheus", "ingress metrics"], config: { unit: "" }, layout: L(0, 2, 8, 3) },
      { kind: "donut", title: "Alertes par sévérité", instructions: "Répartition des alertes actives sur {{cluster}} par sévérité.", sources: ["alertmanager"], layout: L(8, 2, 4, 3) },
      { kind: "alerts", title: "Alertes actives", instructions: "Les alertes actives sur {{cluster}}, les plus graves puis les plus récentes : titre, sévérité, heure de début, source (namespace/service), et la cause probable dans detail.", sources: ["alertmanager", "kubectl get events"], layout: L(0, 5, 7, 4) },
      { kind: "text", title: "Lecture de l'agent", instructions: "Ce qui se passe sur {{cluster}} en trois à cinq points : la cause probable des alertes, le risque, l'action recommandée.", layout: L(7, 5, 5, 4) },
    ],
  },
  {
    key: "sales-pipeline", category: "Ventes", name: "Pipeline commercial",
    tagline: "Opportunités, valeur pondérée, conversion et affaires à relancer.",
    description: "Le pipeline commercial du trimestre.",
    usage_context: "Revue hebdomadaire des ventes : où en est le trimestre, quelles affaires bougent, lesquelles relancer cette semaine.",
    widgets: [
      { kind: "kpi", title: "Pipeline ouvert", instructions: "Valeur totale des opportunités ouvertes. delta : vs il y a 7 jours.", sources: ["hubspot", "salesforce", "pipedrive"], config: { unit: "€" }, layout: L(0, 0, 3, 2) },
      { kind: "kpi", title: "Signé ce trimestre", instructions: "Montant des affaires gagnées depuis le début du trimestre. trend : cumul par semaine.", sources: ["hubspot", "salesforce", "stripe"], config: { unit: "€" }, layout: L(3, 0, 3, 2) },
      { kind: "gauge", title: "Objectif du trimestre", instructions: "Signé ce trimestre en % de l'objectif trimestriel (demande l'objectif s'il n'est nulle part).", config: { unit: "%", max: 100, thresholds: { warn: 60, critical: 40, direction: "below" } }, layout: L(6, 0, 3, 2) },
      { kind: "kpi", title: "Taux de conversion", instructions: "Affaires gagnées / affaires clôturées sur 90 jours, en %.", config: { unit: "%" }, layout: L(9, 0, 3, 2) },
      { kind: "bar", title: "Pipeline par étape", instructions: "Valeur des opportunités ouvertes par étape du pipeline, dans l'ordre du pipeline.", config: { unit: "€" }, layout: L(0, 2, 6, 3) },
      { kind: "line", title: "Signé par semaine", instructions: "Montant signé par semaine sur les 12 dernières semaines.", config: { unit: "€" }, layout: L(6, 2, 6, 3) },
      { kind: "table", title: "Affaires à relancer", instructions: "Les 15 plus grosses opportunités sans activité depuis 10 jours : nom, compte, montant, étape, dernier contact, propriétaire. _status=warn au-delà de 10 jours, critical au-delà de 21.", layout: L(0, 5, 12, 4) },
    ],
  },
  {
    key: "support-desk", category: "Support", name: "Support client",
    tagline: "Tickets ouverts, délais de réponse, satisfaction et sujets du moment.",
    usage_context: "Lu chaque matin par le responsable support : charge, retards de SLA et sujets qui montent.",
    widgets: [
      { kind: "kpi", title: "Tickets ouverts", instructions: "Nombre de tickets ouverts. delta vs hier. trend : 14 derniers jours.", sources: ["zendesk", "intercom", "freshdesk"], layout: L(0, 0, 3, 2) },
      { kind: "kpi", title: "Première réponse", instructions: "Délai médian de première réponse sur 7 jours, en heures.", config: { unit: "h", thresholds: { warn: 4, critical: 8 } }, layout: L(3, 0, 3, 2) },
      { kind: "kpi", title: "Satisfaction", instructions: "CSAT sur 30 jours, en %.", config: { unit: "%", thresholds: { warn: 85, critical: 75, direction: "below" } }, layout: L(6, 0, 3, 2) },
      { kind: "kpi", title: "Hors SLA", instructions: "Tickets ouverts qui ont dépassé leur SLA.", config: { thresholds: { warn: 1, critical: 10 } }, layout: L(9, 0, 3, 2) },
      { kind: "area", title: "Tickets reçus", instructions: "Tickets créés par jour sur 30 jours.", layout: L(0, 2, 8, 3) },
      { kind: "donut", title: "Par catégorie", instructions: "Tickets ouverts par catégorie ou étiquette.", layout: L(8, 2, 4, 3) },
      { kind: "table", title: "Tickets en retard", instructions: "Tickets hors SLA : sujet, client, priorité, âge, assigné.", layout: L(0, 5, 12, 4) },
    ],
  },
  {
    key: "marketing-acquisition", category: "Marketing", name: "Acquisition",
    tagline: "Trafic, inscriptions, coût d'acquisition et canaux.",
    usage_context: "Point marketing hebdomadaire : quels canaux rapportent, à quel coût.",
    widgets: [
      { kind: "kpi", title: "Visiteurs (7 j)", instructions: "Visiteurs uniques sur 7 jours, delta vs les 7 jours d'avant, trend journalier sur 30 jours.", sources: ["google analytics", "posthog"], layout: L(0, 0, 3, 2) },
      { kind: "kpi", title: "Inscriptions (7 j)", instructions: "Nouvelles inscriptions sur 7 jours, delta vs la semaine d'avant.", layout: L(3, 0, 3, 2) },
      { kind: "kpi", title: "Conversion", instructions: "Inscriptions / visiteurs sur 7 jours, en %.", config: { unit: "%" }, layout: L(6, 0, 3, 2) },
      { kind: "kpi", title: "Coût d'acquisition", instructions: "Dépense publicitaire / inscriptions payantes sur 30 jours.", config: { unit: "€" }, layout: L(9, 0, 3, 2) },
      { kind: "bar", title: "Inscriptions par canal", instructions: "Inscriptions sur 30 jours par canal d'acquisition.", layout: L(0, 2, 6, 3) },
      { kind: "line", title: "Trafic quotidien", instructions: "Visiteurs par jour sur 30 jours.", layout: L(6, 2, 6, 3) },
    ],
  },
  {
    key: "finance-cash", category: "Finance", name: "Trésorerie et revenus",
    tagline: "MRR, encaissements, impayés et autonomie financière.",
    usage_context: "Revue mensuelle du dirigeant : revenus, trésorerie, risques d'impayés.",
    widgets: [
      { kind: "kpi", title: "MRR", instructions: "Revenu mensuel récurrent actuel, delta vs le mois dernier, trend sur 12 mois.", sources: ["stripe"], config: { unit: "€" }, layout: L(0, 0, 3, 2) },
      { kind: "kpi", title: "Encaissé ce mois", instructions: "Paiements encaissés depuis le début du mois.", sources: ["stripe", "banque"], config: { unit: "€" }, layout: L(3, 0, 3, 2) },
      { kind: "kpi", title: "Impayés", instructions: "Montant des factures en retard de paiement.", config: { unit: "€", thresholds: { warn: 1000, critical: 10000 } }, layout: L(6, 0, 3, 2) },
      { kind: "kpi", title: "Autonomie", instructions: "Trésorerie / dépense nette mensuelle moyenne, en mois.", config: { unit: "mois", thresholds: { warn: 9, critical: 6, direction: "below" } }, layout: L(9, 0, 3, 2) },
      { kind: "line", title: "MRR sur 12 mois", instructions: "MRR à la fin de chaque mois sur 12 mois.", config: { unit: "€" }, layout: L(0, 2, 8, 3) },
      { kind: "table", title: "Factures en retard", instructions: "Factures impayées : client, montant, échéance, jours de retard. _status=critical au-delà de 30 jours.", layout: L(0, 5, 12, 4) },
      { kind: "text", title: "Lecture de l'agent", instructions: "Trois points : la tendance des revenus, le risque principal, l'action à mener ce mois-ci.", layout: L(8, 2, 4, 3) },
    ],
  },
];

export function findDashboardTemplate(key: string): DashboardTemplate | undefined {
  return DASHBOARD_TEMPLATES.find((t) => t.key === key);
}

/** La place d'un nouveau composant : sous tout ce qui existe déjà. */
export function nextLayout(existing: WidgetLayout[], kind: WidgetKind): WidgetLayout {
  const { w, h } = WIDGET_META[kind].size;
  const bottom = existing.reduce((m, l) => Math.max(m, l.y + l.h), 0);
  return { x: 0, y: bottom, w, h };
}
