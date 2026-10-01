// SentinelFlow — le triage SOC : toutes les sources d'alertes, un seul format,
// un tri Jev, des faux positifs prouvés, et jamais de remédiation sans humain.
//
// ── Les portes d'entrée ──────────────────────────────────────────────────────
//
//   webhook   — l'outil de sécurité POSTe ses alertes (JSON, NDJSON, lots, ou
//               lignes CEF en texte) sur automation-receiver?sentinel=<jeton>.
//               Un jeton par source, stocké haché.
//   poll      — SentinelFlow interroge l'API de l'outil (URL HTTPS, méthode,
//               corps avec {{since}}, authentification chiffrée), chaque N
//               minutes, depuis le planificateur.
//   internal  — nos propres signaux : résultats des scans de sécurité, incidents
//               de gouvernance, actions refusées par PolicyGuard.
//   agent     — un agent pousse ce qu'il lit dans ses connecteurs (boîte mail
//               d'alertes, canal Slack sécurité…) avec l'outil `sentinel`.
//   manual    — import d'un fichier ou d'un collage depuis l'écran.
//
// Chaque source porte un PRÉRÉGLAGE d'éditeur (où se trouvent le titre, la
// gravité, l'hôte, les IP… dans son JSON) et des SURCHARGES modifiables : les
// formats changent d'une version à l'autre, la correspondance doit pouvoir
// suivre sans déploiement.
//
// ── Les trois décisions ──────────────────────────────────────────────────────
//
//   1. Faux positif — seulement sur des critères VÉRIFIABLES, calculés en code :
//      règle de suppression, actif marqué test/scanner, scan autorisé en cours
//      sur l'hôte, même règle déjà classée faux positif sur le même hôte, taux
//      historique de faux positifs de la règle. Jev donne un avis, jamais une
//      preuve : son avis seul ne ferme rien.
//   2. Priorité — Jev juge la SITUATION (4 niveaux), le code ajoute le contexte
//      de l'actif (un serveur critique monte d'un cran).
//   3. Procédure — Jev propose la procédure et dit s'il faut un analyste
//      maintenant. Aucune remédiation ne s'exécute : elle devient une
//      proposition que quelqu'un valide.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { judge, choice, score, noul, readChoice, readScore, readNoul, qid } from "./typesafe.ts";
import { decryptSecret } from "./crypto.ts";
import { safeFetch } from "./ssrf.ts";

type Admin = SupabaseClient;

// ── Le format commun ─────────────────────────────────────────────────────────

/** 0 faible · 1 moyenne · 2 haute · 3 critique. */
export type Sev = 0 | 1 | 2 | 3;

export interface NormalizedAlert {
  external_id: string | null;
  title: string;
  description: string | null;
  severity_raw: string | null;
  severity: Sev | null;
  category_raw: string | null;
  rule_id: string | null;
  rule_name: string | null;
  host: string | null;
  src_ip: string | null;
  dst_ip: string | null;
  user_name: string | null;
  mitre: string[];
  occurred_at: string;
  dedupe_key: string;
}

export type FieldKey =
  | "external_id" | "title" | "description" | "severity" | "category" | "rule_id" | "rule_name"
  | "host" | "src_ip" | "dst_ip" | "user" | "mitre" | "occurred_at";

export type SeverityScale = "auto" | "wazuh15" | "pct100" | "ten" | "suricata";

export interface VendorPreset {
  key: string;
  label: string;
  /** Comment les alertes arrivent chez nous, pour ce produit. */
  delivery: Array<"webhook" | "poll">;
  /** Où sont les alertes dans une réponse ou un lot (chemins essayés dans l'ordre). */
  items: string[];
  fields: Partial<Record<FieldKey, string[]>>;
  scale: SeverityScale;
  /** Ce qu'il faut faire côté produit — affiché à l'écran. */
  setup: string;
}

// Les chemins communs, essayés APRÈS ceux du préréglage : un produit qui ajoute
// un champ standard (ECS, OCSF) est lu quand même.
const COMMON: Record<FieldKey, string[]> = {
  external_id: ["id", "alert_id", "alertId", "uuid", "event_id", "eventId", "_id", "finding_id"],
  title: ["title", "name", "rule.name", "alert.name", "signature", "summary", "message", "event.title", "displayMessage"],
  description: ["description", "details", "rule.description", "message", "text", "summary"],
  severity: ["severity", "severity_label", "level", "priority", "risk_score", "urgency", "alert.severity", "event.severity"],
  category: ["category", "rule.category", "event.category", "type", "alert.category", "classification", "eventType"],
  rule_id: ["rule.id", "rule_id", "ruleId", "signature_id", "alert.signature_id", "detection_id"],
  rule_name: ["rule.name", "rule_name", "ruleName", "rule.description", "signature", "alert.signature"],
  host: ["host.name", "hostname", "host", "device.hostname", "agent.name", "asset.name", "computer", "computer_name", "dhost"],
  src_ip: ["source.ip", "src_ip", "srcip", "data.srcip", "client.ip", "client_ip", "src", "remote_ip"],
  dst_ip: ["destination.ip", "dst_ip", "dstip", "dest_ip", "data.dstip", "dst", "local_ip"],
  user: ["user.name", "username", "user", "data.dstuser", "account", "suser", "actor.alternateId"],
  mitre: ["threat.technique.id", "rule.mitre.id", "mitre.technique", "techniques", "mitre_techniques", "mitreTechniques"],
  occurred_at: ["@timestamp", "timestamp", "time", "created_at", "createdAt", "detected_at", "event.created", "eventTime", "published", "rt"],
};

export const VENDOR_PRESETS: VendorPreset[] = [
  {
    key: "generic", label: "JSON générique", delivery: ["webhook", "poll"], scale: "auto",
    items: ["alerts", "data", "items", "results", "events", "value", "records", "Records"],
    fields: {},
    setup: "Envoyez un objet JSON (ou un tableau d'objets) par alerte. Les champs courants (title, severity, host, source.ip, rule.id, @timestamp…) sont reconnus ; les autres se mappent ci-dessous.",
  },
  {
    key: "wazuh", label: "Wazuh", delivery: ["webhook", "poll"], scale: "wazuh15",
    items: ["data.affected_items", "alerts"],
    fields: {
      title: ["rule.description"], severity: ["rule.level"], rule_id: ["rule.id"], rule_name: ["rule.description"],
      host: ["agent.name", "manager.name"], src_ip: ["data.srcip", "agent.ip"], dst_ip: ["data.dstip"],
      user: ["data.dstuser", "data.srcuser"], mitre: ["rule.mitre.id"], category: ["rule.groups"], occurred_at: ["timestamp"],
      external_id: ["id"],
    },
    setup: "Webhook : ajoutez une intégration « custom » dans ossec.conf (hook_url = l'URL ci-dessous, level minimal au choix). Interrogation : API Wazuh Indexer (/wazuh-alerts-*/_search).",
  },
  {
    key: "elastic", label: "Elastic Security / Kibana", delivery: ["webhook", "poll"], scale: "pct100",
    items: ["hits.hits", "alerts", "context.alerts"],
    fields: {
      external_id: ["_id", "kibana.alert.uuid"], title: ["_source.kibana.alert.rule.name", "kibana.alert.rule.name", "rule.name"],
      description: ["_source.kibana.alert.reason", "kibana.alert.reason"],
      severity: ["_source.kibana.alert.risk_score", "kibana.alert.risk_score", "_source.kibana.alert.severity", "kibana.alert.severity"],
      rule_id: ["_source.kibana.alert.rule.uuid", "kibana.alert.rule.uuid"], rule_name: ["_source.kibana.alert.rule.name", "kibana.alert.rule.name"],
      host: ["_source.host.name", "host.name"], src_ip: ["_source.source.ip", "source.ip"], dst_ip: ["_source.destination.ip", "destination.ip"],
      user: ["_source.user.name", "user.name"], mitre: ["_source.threat.technique.id", "threat.technique.id"],
      occurred_at: ["_source.@timestamp", "@timestamp"], category: ["_source.event.category", "event.category"],
    },
    setup: "Webhook : connecteur « Webhook » de Kibana sur vos règles de détection, corps = {{context.alerts}}. Interrogation : POST .alerts-security.alerts-*/_search avec un filtre sur @timestamp ≥ {{since}}.",
  },
  {
    key: "ms_sentinel", label: "Microsoft Sentinel / Defender XDR", delivery: ["webhook", "poll"], scale: "auto",
    items: ["value", "alerts"],
    fields: {
      external_id: ["id", "providerAlertId"], title: ["title", "properties.title", "properties.alertDisplayName"],
      description: ["description", "properties.description"], severity: ["severity", "properties.severity"],
      category: ["category", "properties.tactics"], host: ["evidence.0.deviceDnsName", "properties.compromisedEntity"],
      src_ip: ["evidence.0.ipAddress"], user: ["evidence.0.userAccount.accountName"],
      mitre: ["mitreTechniques", "properties.techniques"], occurred_at: ["createdDateTime", "properties.timeGenerated"],
    },
    setup: "Webhook : playbook Logic App « When an incident is created » → HTTP POST vers l'URL ci-dessous. Interrogation : Microsoft Graph /security/alerts_v2 (jeton d'application).",
  },
  {
    key: "splunk", label: "Splunk", delivery: ["webhook", "poll"], scale: "auto",
    items: ["results"],
    fields: {
      external_id: ["sid", "result._cd"], title: ["search_name", "result.signature", "result.rule_name"],
      severity: ["result.severity", "result.urgency"], host: ["result.host", "result.dest"],
      src_ip: ["result.src_ip", "result.src"], dst_ip: ["result.dest_ip", "result.dest"], user: ["result.user"],
      rule_name: ["search_name"], occurred_at: ["result._time"],
    },
    setup: "Webhook : action d'alerte « Webhook » sur vos recherches enregistrées (Splunk envoie search_name + result). Interrogation : API REST /services/search/jobs/export.",
  },
  {
    key: "crowdstrike", label: "CrowdStrike Falcon", delivery: ["webhook", "poll"], scale: "pct100",
    items: ["resources", "events"],
    fields: {
      external_id: ["composite_id", "CompositeId", "DetectId", "id"], title: ["display_name", "DetectName", "Description", "name"],
      description: ["description", "DetectDescription"], severity: ["severity", "Severity", "SeverityName"],
      host: ["device.hostname", "ComputerName", "Hostname"], src_ip: ["device.local_ip", "LocalIP"], user: ["user_name", "UserName"],
      mitre: ["technique_id", "Technique"], category: ["tactic", "Tactic"], occurred_at: ["created_timestamp", "ProcessStartTime", "timestamp"],
    },
    setup: "Webhook : workflow Falcon Fusion « Nouvelle détection » → action Webhook. Interrogation : API /alerts/entities/alerts/v2 (client OAuth).",
  },
  {
    key: "sentinelone", label: "SentinelOne", delivery: ["webhook", "poll"], scale: "auto",
    items: ["data"],
    fields: {
      external_id: ["id", "threatInfo.threatId"], title: ["threatInfo.threatName"], severity: ["threatInfo.confidenceLevel"],
      category: ["threatInfo.classification"], host: ["agentRealtimeInfo.agentComputerName", "agentDetectionInfo.agentComputerName"],
      src_ip: ["agentDetectionInfo.agentIpV4"], user: ["threatInfo.processUser"], occurred_at: ["threatInfo.createdAt"],
    },
    setup: "Webhook : notification Singularity vers un webhook. Interrogation : API /web/api/v2.1/threats?createdAt__gte={{since}}.",
  },
  {
    key: "guardduty", label: "AWS GuardDuty", delivery: ["webhook"], scale: "ten",
    items: ["Records"],
    fields: {
      external_id: ["detail.id"], title: ["detail.title"], description: ["detail.description"], severity: ["detail.severity"],
      category: ["detail.type"], host: ["detail.resource.instanceDetails.instanceId"],
      src_ip: ["detail.service.action.networkConnectionAction.remoteIpDetails.ipAddressV4"], occurred_at: ["time", "detail.createdAt"],
    },
    setup: "EventBridge : règle source aws.guardduty → cible « API destination » vers l'URL ci-dessous (en-tête x-sentinel-token).",
  },
  {
    key: "securityhub", label: "AWS Security Hub", delivery: ["webhook"], scale: "auto",
    items: ["detail.findings"],
    fields: {
      external_id: ["Id"], title: ["Title"], description: ["Description"], severity: ["Severity.Label"],
      category: ["Types.0"], host: ["Resources.0.Id"], occurred_at: ["CreatedAt"],
    },
    setup: "EventBridge : règle « Security Hub Findings - Imported » → API destination vers l'URL ci-dessous.",
  },
  {
    key: "gcp_scc", label: "Google Security Command Center / SecOps", delivery: ["webhook", "poll"], scale: "auto",
    items: ["detections", "findings", "listFindingsResults"],
    fields: {
      external_id: ["finding.name", "id"], title: ["finding.category", "detection.0.ruleName", "ruleName"],
      severity: ["finding.severity", "detection.0.severity"], host: ["resource.displayName", "finding.resourceName"],
      category: ["finding.findingClass"], occurred_at: ["finding.eventTime", "createdTime"],
    },
    setup: "Webhook : notification Pub/Sub → push vers l'URL ci-dessous. Interrogation : API SCC findings.list avec filtre event_time.",
  },
  {
    key: "qradar", label: "IBM QRadar", delivery: ["poll", "webhook"], scale: "ten",
    items: ["offenses"],
    fields: {
      external_id: ["id"], title: ["description"], severity: ["magnitude", "severity"], category: ["categories.0"],
      src_ip: ["offense_source"], occurred_at: ["start_time"],
    },
    setup: "Interrogation : API /api/siem/offenses?filter=start_time>… (jeton SEC en en-tête).",
  },
  {
    key: "datadog", label: "Datadog Cloud SIEM", delivery: ["webhook"], scale: "auto",
    items: ["signals"],
    fields: {
      external_id: ["id", "alert_id"], title: ["title"], description: ["body", "text"], severity: ["priority", "severity", "alert_priority"],
      host: ["host", "hostname"], occurred_at: ["date", "last_updated"],
    },
    setup: "Intégration Webhooks : corps JSON {\"id\":\"$ID\",\"title\":\"$EVENT_TITLE\",\"body\":\"$EVENT_MSG\",\"priority\":\"$ALERT_PRIORITY\",\"host\":\"$HOSTNAME\",\"date\":\"$DATE\"}.",
  },
  {
    key: "suricata", label: "Suricata (eve.json)", delivery: ["webhook"], scale: "suricata",
    items: ["events"],
    fields: {
      external_id: ["flow_id"], title: ["alert.signature"], severity: ["alert.severity"], rule_id: ["alert.signature_id"],
      rule_name: ["alert.signature"], category: ["alert.category"], src_ip: ["src_ip"], dst_ip: ["dest_ip"], host: ["host"],
      occurred_at: ["timestamp"],
    },
    setup: "Transférez eve.json (événements alert) par Fluent Bit / Vector / Logstash vers l'URL ci-dessous, en NDJSON ou par lots.",
  },
  {
    key: "github", label: "GitHub (code, secrets, dépendances)", delivery: ["webhook"], scale: "auto",
    items: [],
    fields: {
      external_id: ["alert.html_url", "alert.number"],
      title: ["alert.rule.description", "alert.security_advisory.summary", "alert.secret_type_display_name"],
      severity: ["alert.rule.security_severity_level", "alert.security_advisory.severity", "alert.rule.severity"],
      rule_id: ["alert.rule.id", "alert.security_advisory.ghsa_id", "alert.secret_type"], host: ["repository.full_name"],
      category: ["action"], occurred_at: ["alert.created_at"],
    },
    setup: "Webhook de dépôt ou d'organisation, événements code_scanning_alert, secret_scanning_alert, dependabot_alert ; content type application/json ; jeton en paramètre d'URL.",
  },
  {
    key: "okta", label: "Okta (journal système)", delivery: ["webhook", "poll"], scale: "auto",
    items: ["data.events"],
    fields: {
      external_id: ["uuid"], title: ["displayMessage"], severity: ["severity"], category: ["eventType"],
      src_ip: ["client.ipAddress"], user: ["actor.alternateId"], occurred_at: ["published"],
    },
    setup: "Event Hook Okta vers l'URL ci-dessous (filtrez sur les événements de sécurité). Interrogation : /api/v1/logs?since={{since}}.",
  },
  {
    key: "cloudflare", label: "Cloudflare", delivery: ["webhook"], scale: "auto",
    items: [],
    fields: {
      external_id: ["data.id", "ts"], title: ["name", "alert_type"], description: ["text"], severity: ["data.severity"],
      host: ["data.zone_name", "data.domain"], occurred_at: ["ts"],
    },
    setup: "Notifications → destination Webhook vers l'URL ci-dessous (attaques DDoS, WAF, certificats…).",
  },
  {
    key: "cef", label: "CEF / syslog (texte)", delivery: ["webhook"], scale: "ten",
    items: [],
    fields: {},
    setup: "Envoyez les lignes CEF (une par ligne) en text/plain, par exemple depuis rsyslog (omhttp), Vector ou Fluent Bit. Les champs src, dst, suser, dhost, rt sont lus.",
  },
];

export const presetOf = (key: string | null | undefined): VendorPreset =>
  VENDOR_PRESETS.find((p) => p.key === key) ?? VENDOR_PRESETS[0];

// ── Lecture des champs ───────────────────────────────────────────────────────

/** `a.b.0.c` dans un objet, en acceptant aussi les clés APLATIES qu'Elastic
 *  renvoie (`"kibana.alert.rule.name": "…"`). */
export function pick(obj: unknown, path: string): unknown {
  if (obj == null || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  if (path in o) return o[path];
  const parts = path.split(".");
  for (let i = parts.length - 1; i >= 1; i--) {
    const head = parts.slice(0, i).join(".");
    if (head in o) {
      const v = pick(o[head], parts.slice(i).join("."));
      if (v !== undefined) return v;
    }
  }
  const [first, ...rest] = parts;
  if (Array.isArray(obj) && /^\d+$/.test(first)) return rest.length ? pick(obj[Number(first)], rest.join(".")) : obj[Number(first)];
  if (!(first in o)) return undefined;
  return rest.length ? pick(o[first], rest.join(".")) : o[first];
}

function firstOf(obj: unknown, paths: string[]): unknown {
  for (const p of paths) {
    const v = pick(obj, p);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

const asText = (v: unknown, max = 500): string | null => {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map((x) => asText(x, 80)).filter(Boolean).join(", ").slice(0, max) || null;
  if (typeof v === "object") { try { return JSON.stringify(v).slice(0, max); } catch { return null; } }
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

export function normalizeSeverity(v: unknown, scale: SeverityScale): Sev | null {
  if (v == null || v === "") return null;
  if (typeof v === "string" && !/^\s*-?\d+(\.\d+)?\s*$/.test(v)) {
    const s = v.toLowerCase();
    if (/crit|severe|emerg|fatal|p1\b/.test(s)) return 3;
    if (/high|error|major|alert|p2\b/.test(s)) return 2;
    if (/med|moder|warn|p3\b/.test(s)) return 1;
    if (/low|info|notice|minor|debug|p4\b|p5\b/.test(s)) return 0;
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const s: SeverityScale = scale !== "auto" ? scale : n > 15 ? "pct100" : n > 10 ? "wazuh15" : n > 4 ? "ten" : "auto";
  if (s === "wazuh15") return n >= 12 ? 3 : n >= 8 ? 2 : n >= 5 ? 1 : 0;
  if (s === "pct100") return n >= 90 ? 3 : n >= 70 ? 2 : n >= 40 ? 1 : 0;
  if (s === "ten") return n >= 9 ? 3 : n >= 7 ? 2 : n >= 4 ? 1 : 0;
  if (s === "suricata") return n <= 1 ? 2 : n === 2 ? 1 : 0;
  // 1-4 : une échelle à quatre crans, du plus faible au plus fort.
  return Math.min(3, Math.max(0, Math.round(n) - 1)) as Sev;
}

function toIso(v: unknown): string {
  if (v == null || v === "") return new Date().toISOString();
  if (typeof v === "number") {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const hashToken = sha256;

/** Une ligne CEF → un objet plat (en-tête + extensions). */
export function parseCEF(line: string): Record<string, unknown> | null {
  const i = line.indexOf("CEF:");
  if (i < 0) return null;
  const body = line.slice(i + 4);
  const head: string[] = [];
  let cur = "", rest = "";
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c === "\\" && k + 1 < body.length) { cur += body[++k]; continue; }
    if (c === "|" && head.length < 7) { head.push(cur); cur = ""; if (head.length === 7) { rest = body.slice(k + 1); break; } continue; }
    cur += c;
  }
  if (head.length < 7) return null;
  const ext: Record<string, string> = {};
  const re = /(\w+)=((?:\\=|[^=])*?)(?=\s+\w+=|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) ext[m[1]] = m[2].replace(/\\=/g, "=").trim();
  return {
    vendor: head[1], product: head[2], signature_id: head[4], name: head[5], severity: head[6],
    src: ext.src, dst: ext.dst, suser: ext.suser, dhost: ext.dhost ?? ext.shost, rt: ext.rt, msg: ext.msg,
    cat: ext.cat, ...ext,
  };
}

/** Le corps reçu → une liste d'objets d'alerte. */
export function extractItems(body: unknown, preset: VendorPreset, itemsPath?: string | null): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const paths = [itemsPath, ...preset.items, ...(preset.key === "generic" ? [] : VENDOR_PRESETS[0].items)].filter(Boolean) as string[];
    for (const p of paths) {
      const v = pick(body, p);
      if (Array.isArray(v) && v.length) return v;
    }
    return [body];
  }
  return [];
}

/** Texte brut : NDJSON, lignes CEF, ou un seul JSON. */
export function parseTextBody(text: string): unknown[] {
  const t = text.trim();
  if (!t) return [];
  try { const j = JSON.parse(t); return Array.isArray(j) ? j : [j]; } catch { /* lignes */ }
  const out: unknown[] = [];
  for (const line of t.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    if (l.includes("CEF:")) { const c = parseCEF(l); if (c) out.push(c); continue; }
    try { out.push(JSON.parse(l)); } catch { out.push({ message: l.slice(0, 2000) }); }
  }
  return out;
}

export async function normalizeAlert(
  raw: unknown, preset: VendorPreset, overrides: Partial<Record<FieldKey, string[]>>, sourceId: string,
): Promise<NormalizedAlert> {
  const paths = (k: FieldKey) => [...(overrides[k] ?? []), ...(preset.fields[k] ?? []), ...COMMON[k]];
  const f = (k: FieldKey, max?: number) => asText(firstOf(raw, paths(k)), max);
  const mitreRaw = firstOf(raw, paths("mitre"));
  const mitre = (Array.isArray(mitreRaw) ? mitreRaw : mitreRaw ? String(mitreRaw).split(/[,\s]+/) : [])
    .map((x) => String(typeof x === "object" && x ? (x as { id?: string }).id ?? "" : x))
    .filter((x) => /^T\d{4}(\.\d{3})?$/i.test(x)).slice(0, 10);
  const sevRaw = firstOf(raw, paths("severity"));
  const title = f("title", 300) ?? f("rule_name", 300) ?? "Alerte sans titre";
  const alert: Omit<NormalizedAlert, "dedupe_key"> = {
    external_id: f("external_id", 200),
    title,
    description: f("description", 2000),
    severity_raw: asText(sevRaw, 40),
    severity: normalizeSeverity(sevRaw, preset.scale),
    category_raw: f("category", 120),
    rule_id: f("rule_id", 120),
    rule_name: f("rule_name", 300),
    host: f("host", 200),
    src_ip: f("src_ip", 64),
    dst_ip: f("dst_ip", 64),
    user_name: f("user", 200),
    mitre,
    occurred_at: toIso(firstOf(raw, paths("occurred_at"))),
  };
  // Même source + même identifiant éditeur = même alerte. Sans identifiant, la
  // règle, l'hôte, l'IP et le titre dans la même heure : un renvoi ou une
  // rafale ne créent pas cinquante lignes.
  const hour = alert.occurred_at.slice(0, 13);
  const dedupe_key = await sha256(alert.external_id
    ? `${sourceId}|${alert.external_id}`
    : `${sourceId}|${alert.rule_id ?? ""}|${alert.host ?? ""}|${alert.src_ip ?? ""}|${alert.title}|${hour}`);
  return { ...alert, dedupe_key };
}

// ── La configuration du projet ───────────────────────────────────────────────

export interface Playbook { key: string; label: string; what: string }
export interface SentinelConfig {
  playbooks: Playbook[];
  /** Fermer seul une alerte dont le faux positif est PROUVÉ (critère vérifiable). */
  auto_close_verified_fp: boolean;
  /** Taux historique de faux positifs d'une règle au-delà duquel c'est un critère. */
  fp_rate_threshold: number;
  fp_rate_min_samples: number;
}

export const DEFAULT_SENTINEL_CONFIG: SentinelConfig = {
  playbooks: [
    { key: "enqueter", label: "Enquêter", what: "Rassembler le contexte (journaux, autres alertes de l'hôte ou de l'utilisateur) avant de conclure ; aucune action sur les systèmes." },
    { key: "isoler_poste", label: "Isoler le poste", what: "Un poste ou serveur montre une exécution malveillante, un ransomware ou un contrôle à distance : le couper du réseau." },
    { key: "reinitialiser_compte", label: "Réinitialiser le compte", what: "Un compte est probablement compromis (connexion impossible, force brute réussie, jeton volé) : révoquer les sessions et changer les identifiants." },
    { key: "bloquer_ip", label: "Bloquer l'adresse", what: "Une adresse externe attaque ou exfiltre : la bloquer au pare-feu, au WAF ou au proxy." },
    { key: "corriger", label: "Corriger la vulnérabilité", what: "Une faiblesse exploitable est exposée (CVE, secret publié, configuration dangereuse) : corriger, faire tourner le secret, mettre à jour." },
    { key: "clore", label: "Clore sans action", what: "Activité légitime ou bruit : documenter la raison et clore." },
  ],
  auto_close_verified_fp: false,
  fp_rate_threshold: 0.9,
  fp_rate_min_samples: 10,
};

export function normalizeSentinelConfig(raw: unknown): SentinelConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<SentinelConfig>;
  const d = DEFAULT_SENTINEL_CONFIG;
  const pbs = Array.isArray(r.playbooks) ? r.playbooks.filter((p): p is Playbook => !!p && !!p.key && !!p.label) : [];
  return {
    playbooks: pbs.length >= 2 ? pbs.slice(0, 30) : d.playbooks,
    auto_close_verified_fp: r.auto_close_verified_fp === true,
    fp_rate_threshold: Number.isFinite(Number(r.fp_rate_threshold)) ? Number(r.fp_rate_threshold) : d.fp_rate_threshold,
    fp_rate_min_samples: Number.isFinite(Number(r.fp_rate_min_samples)) ? Number(r.fp_rate_min_samples) : d.fp_rate_min_samples,
  };
}

// ── Les faux positifs vérifiables ────────────────────────────────────────────

interface AlertRow extends NormalizedAlert {
  id: string; workspace_id: string; project_id: string; source_id: string; source_name?: string;
}

interface Asset { id: string; name: string; ips: string[]; criticality: string; tags: string[]; owner: string | null }

async function findAsset(admin: Admin, projectId: string, a: NormalizedAlert): Promise<Asset | null> {
  const { data } = await admin.from("sentinel_assets").select("id, name, ips, criticality, tags, owner").eq("project_id", projectId).limit(2000);
  const host = (a.host ?? "").toLowerCase();
  for (const x of (data ?? []) as Asset[]) {
    if (host && x.name.toLowerCase() === host) return x;
    if ((x.ips ?? []).some((ip) => ip === a.dst_ip || ip === a.src_ip)) return x;
  }
  return null;
}

/** Les raisons PROUVABLES de tenir l'alerte pour un faux positif. */
async function verifiableReasons(
  admin: Admin, a: AlertRow, asset: Asset | null, config: SentinelConfig,
): Promise<string[]> {
  const reasons: string[] = [];

  // 1. Une règle de suppression écrite par l'équipe.
  const { data: sups } = await admin.from("sentinel_suppressions")
    .select("label, match, reason, expires_at").eq("project_id", a.project_id).eq("enabled", true);
  for (const s of (sups ?? []) as Array<{ label: string; match: Record<string, string>; reason: string | null; expires_at: string | null }>) {
    if (s.expires_at && Date.parse(s.expires_at) < Date.now()) continue;
    const m = s.match ?? {};
    const checks: Array<[string | undefined, string | null]> = [
      [m.rule_id, a.rule_id], [m.host, a.host], [m.src_ip, a.src_ip], [m.user, a.user_name], [m.category, a.category_raw],
    ];
    const set = checks.filter(([want]) => want);
    const titleOk = !m.title_contains || a.title.toLowerCase().includes(m.title_contains.toLowerCase());
    if ((set.length || m.title_contains) && titleOk && set.every(([want, got]) => (got ?? "").toLowerCase() === want!.toLowerCase())) {
      reasons.push(`règle de suppression « ${s.label} »${s.reason ? ` (${s.reason})` : ""}`);
    }
  }

  // 2. L'actif est déclaré comme environnement de test, scanner ou leurre.
  if (asset && asset.tags?.some((t) => /^(test|scanner|honeypot|lab|sandbox)$/i.test(t))) {
    reasons.push(`actif « ${asset.name} » marqué ${asset.tags.join(", ")}`);
  }

  // 3. Un scan de sécurité AUTORISÉ visait cet hôte à ce moment-là.
  if (a.host || a.dst_ip) {
    const around = Date.parse(a.occurred_at);
    const { data: scans } = await admin.from("security_scans")
      .select("target_host, started_at, finished_at, status").eq("project_id", a.project_id)
      .gte("created_at", new Date(around - 6 * 3600_000).toISOString()).limit(200);
    const hit = ((scans ?? []) as Array<{ target_host: string; started_at: string | null; finished_at: string | null }>).find((s) => {
      const h = (s.target_host ?? "").toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
      const match = h && (h === (a.host ?? "").toLowerCase() || h === a.dst_ip);
      const start = s.started_at ? Date.parse(s.started_at) - 5 * 60_000 : 0;
      const end = s.finished_at ? Date.parse(s.finished_at) + 15 * 60_000 : Date.now();
      return match && around >= start && around <= end;
    });
    if (hit) reasons.push(`scan de sécurité autorisé en cours sur ${hit.target_host}`);
  }

  // 4. La même règle sur le même hôte a déjà été classée faux positif (7 jours).
  if (a.rule_id && a.host) {
    const { count } = await admin.from("sentinel_alerts").select("id", { count: "exact", head: true })
      .eq("project_id", a.project_id).eq("rule_id", a.rule_id).eq("host", a.host).eq("status", "closed_fp")
      .gte("created_at", new Date(Date.now() - 7 * 86400_000).toISOString());
    if ((count ?? 0) > 0) reasons.push(`même règle sur le même hôte déjà classée faux positif ${count} fois cette semaine`);
  }

  // 5. Le taux historique de faux positifs de la règle.
  if (a.rule_id) {
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const { data: hist } = await admin.from("sentinel_alerts").select("status")
      .eq("project_id", a.project_id).eq("rule_id", a.rule_id).in("status", ["closed_fp", "closed_resolved"]).gte("created_at", since).limit(1000);
    const rows = (hist ?? []) as Array<{ status: string }>;
    if (rows.length >= config.fp_rate_min_samples) {
      const rate = rows.filter((r) => r.status === "closed_fp").length / rows.length;
      if (rate >= config.fp_rate_threshold) reasons.push(`règle close en faux positif dans ${Math.round(rate * 100)} % des ${rows.length} cas des 30 derniers jours`);
    }
  }
  return reasons;
}

// ── Le tri ───────────────────────────────────────────────────────────────────

const CATEGORIES: Record<string, { what: string; not_for?: string }> = {
  malware: { what: "Exécution ou présence de code malveillant : virus, rançongiciel, cheval de Troie, script suspect.", not_for: "Une vulnérabilité non exploitée." },
  phishing: { what: "Hameçonnage : e-mail, lien ou pièce jointe piégés, usurpation d'expéditeur." },
  identifiants: { what: "Attaque sur des identifiants : force brute, bourrage d'identifiants, connexion anormale, jeton volé, MFA contournée." },
  exfiltration: { what: "Des données sortent ou fuient : transfert massif, envoi vers un stockage externe, secret publié.", not_for: "Un simple accès en lecture autorisé." },
  elevation: { what: "Élévation de privilèges : obtention de droits d'administration, modification de rôle, sudo anormal." },
  laterale: { what: "Déplacement latéral : un poste compromis en contacte d'autres (RDP, SMB, WMI, PsExec)." },
  reconnaissance: { what: "Reconnaissance : balayage de ports, énumération, découverte de services, requêtes DNS massives." },
  vulnerabilite: { what: "Une faiblesse exposée mais pas (encore) exploitée : CVE, dépendance vulnérable, mauvaise configuration.", not_for: "Une exploitation active (c'est malware ou intrusion)." },
  intrusion: { what: "Exploitation active d'une application ou d'un service : injection, exécution de commande à distance, webshell." },
  deni_service: { what: "Déni de service ou saturation : DDoS, pics de requêtes, épuisement de ressources." },
  politique: { what: "Violation d'une règle interne sans attaque : usage non autorisé, logiciel interdit, action d'agent refusée." },
  benin: { what: "Activité légitime ou bruit : tâche d'administration, sauvegarde, outil de supervision, test autorisé.", not_for: "Une activité inhabituelle qu'on ne sait pas encore expliquer." },
};

const GRAVITY_LEVELS = [
  { summary: "Bruit ou activité normale : rien à faire au-delà de la trace.", signals: ["outil de supervision", "tâche planifiée connue", "alerte informative"] },
  { summary: "Suspect, à vérifier : inhabituel mais sans signe d'impact.", signals: ["première occurrence", "tentative échouée", "scan externe générique"] },
  { summary: "Incident probable à impact limité : une attaque a sans doute réussi sur un périmètre restreint.", signals: ["connexion réussie après force brute", "malware bloqué puis relancé", "un seul poste touché"] },
  { summary: "Compromission active ou critique : attaque en cours, données ou systèmes critiques en jeu.", signals: ["rançongiciel", "exfiltration en cours", "compte administrateur compromis", "plusieurs postes touchés"] },
];

export interface TriageResult {
  category: string | null; categoryConfidence: number | null;
  priority: Sev; gravity: Sev | null;
  fpVerified: string[]; fpHintP: number | null;
  escalate: boolean; playbook: string | null;
  status: "triaged" | "escalated" | "closed_fp";
  mode: "shadow" | "on" | "off";
}

export async function triageOne(admin: Admin, a: AlertRow, config: SentinelConfig): Promise<TriageResult> {
  const asset = await findAsset(admin, a.project_id, a);
  const fpVerified = await verifiableReasons(admin, a, asset, config);

  // Le contexte que Jev lit : l'alerte, l'actif, et le voisinage (24 h).
  const since = new Date(Date.parse(a.occurred_at) - 24 * 3600_000).toISOString();
  let neighbours = 0;
  if (a.host || a.src_ip) {
    const ors = [a.host ? `host.eq.${a.host.replace(/[,()]/g, "")}` : null, a.src_ip ? `src_ip.eq.${a.src_ip.replace(/[,()]/g, "")}` : null].filter(Boolean).join(",");
    const { count } = await admin.from("sentinel_alerts").select("id", { count: "exact", head: true })
      .eq("project_id", a.project_id).neq("id", a.id).gte("occurred_at", since).or(ors);
    neighbours = count ?? 0;
  }

  const pbByKey = new Map<string, Playbook>();
  const pbCriteria: Record<string, { what: string }> = {};
  for (const p of config.playbooks) { const k = qid(p.key); pbByKey.set(k, p); pbCriteria[k] = { what: `${p.label} — ${p.what}` }; }
  const catCriteria = Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v]));

  const verdict = await judge(
    { admin, workspaceId: a.workspace_id, projectId: a.project_id },
    "soc_triage",
    {
      alerte: a.title,
      ...(a.description ? { description: a.description.slice(0, 1200) } : {}),
      ...(a.rule_name && a.rule_name !== a.title ? { regle: a.rule_name } : {}),
      ...(a.severity_raw ? { gravite_editeur: a.severity_raw } : {}),
      ...(a.category_raw ? { categorie_editeur: a.category_raw } : {}),
      ...(a.host ? { hote: a.host } : {}), ...(a.src_ip ? { ip_source: a.src_ip } : {}),
      ...(a.dst_ip ? { ip_destination: a.dst_ip } : {}), ...(a.user_name ? { utilisateur: a.user_name } : {}),
      ...(a.mitre.length ? { mitre: a.mitre.join(", ") } : {}),
      ...(asset ? { actif: `${asset.name} — criticité ${asset.criticality}${asset.tags?.length ? `, ${asset.tags.join(", ")}` : ""}` } : {}),
      autres_alertes_24h_meme_hote_ou_ip: String(neighbours),
      ...(fpVerified.length ? { elements_verifies: fpVerified.join(" ; ") } : {}),
    },
    {
      categorie: choice("De quel genre d'événement de sécurité s'agit-il ?", catCriteria),
      gravite: score("Quelle est la situation réelle derrière cette alerte ?", GRAVITY_LEVELS),
      faux_positif: noul("Cette alerte est-elle vraisemblablement une activité légitime mal interprétée ?", {
        true: { what: "Tout indique une activité normale : administration, supervision, test, comportement habituel de cet hôte ou de cet utilisateur." },
        false: { what: "Rien n'explique l'activité de façon légitime, ou des signes concrets d'attaque sont présents." },
      }),
      escalade: noul("Un analyste doit-il intervenir maintenant, sans attendre le prochain tri ?", {
        true: { what: "Une attaque est peut-être en cours ou vient de réussir, ou un actif critique est touché : attendre aggrave les dégâts." },
        false: { what: "L'alerte peut attendre le traitement normal de la file." },
      }),
      ...(pbByKey.size >= 2 ? { procedure: choice("Quelle procédure appliquer ?", pbCriteria) } : {}),
    },
    { subject: a.title.slice(0, 120) },
  );

  const cat = readChoice(verdict, "categorie");
  const grav = readScore(verdict, "gravite");
  const gravity = grav ? (Math.min(3, Math.max(0, Math.round(grav.score))) as Sev) : null;
  const esc = readNoul(verdict, "escalade");
  const pb = readChoice(verdict, "procedure");

  // La priorité : la situation jugée, sinon la gravité annoncée par l'éditeur ;
  // un actif critique ou élevé monte d'un cran ; un faux positif prouvé
  // redescend à zéro.
  let priority: Sev = (gravity ?? a.severity ?? 1) as Sev;
  if (asset && /^(critical|high)$/.test(asset.criticality) && priority >= 1) priority = Math.min(3, priority + 1) as Sev;
  if (fpVerified.length) priority = 0;

  const escalate = !fpVerified.length && (esc ?? 0) >= (verdict?.threshold ?? 0.7) && priority >= 2;
  const status: TriageResult["status"] =
    fpVerified.length && config.auto_close_verified_fp ? "closed_fp"
    : escalate ? "escalated" : "triaged";

  return {
    category: cat?.choice ?? null, categoryConfidence: cat?.confidence ?? null,
    priority, gravity, fpVerified, fpHintP: readNoul(verdict, "faux_positif"),
    escalate, playbook: pb && pb.confidence >= 0.4 ? (pbByKey.get(pb.choice)?.key ?? null) : null,
    status, mode: verdict ? (verdict.mode === "on" ? "on" : "shadow") : "off",
  };
}

// ── L'ingestion ──────────────────────────────────────────────────────────────

export interface SourceRow {
  id: string; workspace_id: string; project_id: string; name: string; kind: string; vendor: string;
  mapping: Partial<Record<FieldKey, string[]>> | null; items_path: string | null;
  poll: Record<string, unknown> | null; secret_ciphertext: string | null; secret_iv: string | null;
  cursor: string | null; enabled: boolean;
}

/** Enregistre un lot. Rend le nombre de nouvelles alertes et de doublons. Le
 *  tri se fait ensuite, par le planificateur, pour que la source reçoive sa
 *  réponse vite (les outils de sécurité réessaient sur un timeout). */
export async function ingest(admin: Admin, source: SourceRow, items: unknown[]): Promise<{ created: number; duplicates: number; errors: number }> {
  const preset = presetOf(source.vendor);
  let created = 0, duplicates = 0, errors = 0;
  for (const raw of items.slice(0, 500)) {
    try {
      const a = await normalizeAlert(raw, preset, source.mapping ?? {}, source.id);
      const { data: prev } = await admin.from("sentinel_alerts").select("id, occurrences")
        .eq("source_id", source.id).eq("dedupe_key", a.dedupe_key).maybeSingle();
      if (prev) {
        const p = prev as { id: string; occurrences: number };
        await admin.from("sentinel_alerts").update({ occurrences: (p.occurrences ?? 1) + 1, last_seen_at: new Date().toISOString() }).eq("id", p.id);
        duplicates++;
        continue;
      }
      let rawJson: unknown = raw;
      try { if (JSON.stringify(raw).length > 20_000) rawJson = { truncated: JSON.stringify(raw).slice(0, 20_000) }; } catch { rawJson = null; }
      const { error } = await admin.from("sentinel_alerts").insert({
        workspace_id: source.workspace_id, project_id: source.project_id, source_id: source.id,
        ...a, raw: rawJson, status: "new",
      });
      if (error) { errors++; continue; }
      created++;
    } catch { errors++; }
  }
  await admin.from("sentinel_sources").update({
    last_seen_at: new Date().toISOString(),
  }).eq("id", source.id);
  return { created, duplicates, errors };
}

/** Trie les alertes en attente (nouvelles) — appelé par le planificateur et
 *  par l'outil des agents. */
export async function triagePending(admin: Admin, opts: { projectId?: string; limit?: number; deadline?: number }): Promise<number> {
  let q = admin.from("sentinel_alerts").select("*").eq("status", "new").order("created_at", { ascending: true }).limit(opts.limit ?? 25);
  if (opts.projectId) q = q.eq("project_id", opts.projectId);
  const { data } = await q;
  const configs = new Map<string, SentinelConfig>();
  let done = 0;
  for (const a of (data ?? []) as AlertRow[]) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    let config = configs.get(a.project_id);
    if (!config) {
      const { data: c } = await admin.from("sentinel_config").select("config").eq("project_id", a.project_id).maybeSingle();
      config = normalizeSentinelConfig((c as { config?: unknown } | null)?.config);
      configs.set(a.project_id, config);
    }
    try {
      const t = await triageOne(admin, a, config);
      // Jugement éteint (ou en panne) ET aucun critère vérifiable : on ne
      // fabrique pas un tri. L'alerte reste « nouvelle », avec sa gravité éditeur.
      if (t.mode === "off" && !t.fpVerified.length) {
        await admin.from("sentinel_alerts").update({ status: "untriaged", priority: a.severity ?? 1 }).eq("id", a.id);
        continue;
      }
      await admin.from("sentinel_alerts").update({
        status: t.status, priority: t.priority, gravity: t.gravity,
        category: t.category, category_confidence: t.categoryConfidence,
        fp_verified: t.fpVerified, fp_hint_p: t.fpHintP, escalate: t.escalate,
        playbook: t.playbook, triage_mode: t.mode, triaged_at: new Date().toISOString(),
        ...(t.status === "closed_fp" ? { closed_at: new Date().toISOString(), resolution: `Faux positif prouvé : ${t.fpVerified.join(" ; ")}` } : {}),
      }).eq("id", a.id);
      done++;
    } catch { /* l'alerte reste nouvelle, reprise au prochain passage */ }
  }
  return done;
}

// ── L'interrogation ──────────────────────────────────────────────────────────

function fill(template: string, since: string): string {
  return template.replaceAll("{{since}}", since).replaceAll("{{since_epoch}}", String(Math.floor(Date.parse(since) / 1000)));
}

export async function pollSource(admin: Admin, s: SourceRow): Promise<{ created: number; duplicates: number; errors: number; error?: string }> {
  const since = s.cursor ?? new Date(Date.now() - 60 * 60_000).toISOString();
  const now = new Date().toISOString();
  try {
    if (s.kind === "internal") return await pollInternal(admin, s, since, now);
    const cfg = (s.poll ?? {}) as { url?: string; method?: string; body?: string; auth?: string; header_name?: string };
    const url = fill(String(cfg.url ?? ""), since);
    // Une URL choisie par l'espace et interrogée depuis nos serveurs est une
    // porte SSRF : HTTPS obligatoire, et safeFetch résout le DNS et refuse toute
    // adresse privée, de bouclage ou de métadonnées — à chaque redirection aussi.
    if (!/^https:\/\//i.test(url)) throw new Error("URL refusée (HTTPS uniquement)");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (s.secret_ciphertext && s.secret_iv) {
      const secret = await decryptSecret(s.secret_ciphertext, s.secret_iv);
      if (cfg.auth === "bearer") headers.Authorization = `Bearer ${secret}`;
      else if (cfg.auth === "basic") headers.Authorization = `Basic ${btoa(secret)}`;
      else if (cfg.auth === "header" && cfg.header_name) headers[cfg.header_name] = secret;
    }
    const method = (cfg.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
    if (method === "POST") headers["Content-Type"] = "application/json";
    const res = await safeFetch(url, {
      method, headers, body: method === "POST" && cfg.body ? fill(cfg.body, since) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = parseTextBody(text); }
    const items = extractItems(body, presetOf(s.vendor), s.items_path);
    const r = await ingest(admin, s, items);
    await admin.from("sentinel_sources").update({ cursor: now, last_polled_at: now, last_error: null }).eq("id", s.id);
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 300) : "erreur";
    await admin.from("sentinel_sources").update({ last_polled_at: now, last_error: msg }).eq("id", s.id);
    return { created: 0, duplicates: 0, errors: 1, error: msg };
  }
}

/** Nos propres signaux, transformés en alertes. */
async function pollInternal(admin: Admin, s: SourceRow, since: string, now: string) {
  const which = String((s.poll as { internal?: string } | null)?.internal ?? "scan_findings");
  let items: Record<string, unknown>[] = [];
  if (which === "scan_findings") {
    const { data } = await admin.from("security_scan_findings")
      .select("id, severity, title, detail, created_at, security_scans(target_host, scan_type)")
      .eq("project_id", s.project_id).gt("created_at", since).limit(500);
    items = ((data ?? []) as Array<Record<string, unknown>>).map((f) => ({
      id: f.id, title: f.title, description: f.detail, severity: f.severity, created_at: f.created_at,
      host: (f.security_scans as { target_host?: string } | null)?.target_host ?? null,
      category: `scan ${(f.security_scans as { scan_type?: string } | null)?.scan_type ?? ""}`.trim(),
    }));
  } else if (which === "gov_incidents") {
    const { data } = await admin.from("gov_incidents")
      .select("id, title, description, category, severity, occurred_at")
      .eq("project_id", s.project_id).gt("created_at", since).limit(500);
    items = (data ?? []) as Record<string, unknown>[];
  } else if (which === "policy_blocks") {
    const { data } = await admin.from("policy_decisions")
      .select("id, tool, action, risk_level, reason, agent_id, created_at")
      .eq("project_id", s.project_id).eq("applied_decision", "block").gt("created_at", since).limit(500);
    items = ((data ?? []) as Array<Record<string, unknown>>).map((d) => ({
      id: d.id, title: `Action d'agent refusée : ${d.tool} · ${d.action}`, description: d.reason,
      severity: Number(d.risk_level) >= 3 ? "high" : "medium", category: "politique", user: d.agent_id, created_at: d.created_at,
    }));
  }
  const r = await ingest(admin, s, items);
  await admin.from("sentinel_sources").update({ cursor: now, last_polled_at: now, last_error: null }).eq("id", s.id);
  return r;
}

/** Le passage du planificateur : interroger les sources dues, puis trier. */
export async function sentinelTick(admin: Admin, budgetMs: number): Promise<{ polled: number; triaged: number }> {
  const deadline = Date.now() + budgetMs;
  const { data } = await admin.from("sentinel_sources").select("*")
    .eq("enabled", true).in("kind", ["poll", "internal"]).limit(50);
  let polled = 0;
  for (const s of (data ?? []) as Array<SourceRow & { poll_interval_minutes: number | null; last_polled_at: string | null }>) {
    if (Date.now() > deadline) break;
    const every = Math.max(1, s.poll_interval_minutes ?? 5) * 60_000;
    if (s.last_polled_at && Date.now() - Date.parse(s.last_polled_at) < every) continue;
    await pollSource(admin, s);
    polled++;
  }
  const triaged = await triagePending(admin, { limit: 40, deadline });
  return { polled, triaged };
}
