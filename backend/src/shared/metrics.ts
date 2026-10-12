// Audit et métriques des appels MCP faits par les agents (installation dédiée,
// docs/openshift-implementation.md D7).
//
// Les fonctions signalent chaque appel de tool et chaque étape d'une
// approbation (supabase/functions/_shared/mcp-observe.ts) ; ce module en fait :
//   - une ligne JSON sur stdout, collectée vers le tenant d'audit (Loki). Son
//     `trace_id` est celui du serveur MCP pour le même appel ;
//   - les métriques Prometheus, servies sur le port de gestion (MGMT_PORT),
//     jamais routé hors du cluster :
//       ai_tool_calls_total{tool, cluster, status}
//       ai_tool_denied_total{tool, reason}
//       ai_approval_requests_total{status}
//       ai_tool_duration_seconds{tool}   (histogramme)
//
// Format texte Prometheus, sans dépendance : le même registre que les serveurs
// MCP (MCP/src/lib/metrics.ts).

import { createServer, type Server } from "node:http";

const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

type Labels = Record<string, string>;
const key = (labels: Labels) => JSON.stringify(Object.entries(labels).sort());
const fmt = (labels: Labels) =>
  Object.keys(labels).length
    ? `{${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`).join(",")}}`
    : "";

class Counter {
  private values = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels): void {
    const k = key(labels);
    const cur = this.values.get(k) ?? { labels, value: 0 };
    cur.value += 1;
    this.values.set(k, cur);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) lines.push(`${this.name}${fmt(labels)} ${value}`);
    return lines.join("\n");
  }
}

class Histogram {
  private series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string) {}
  observe(labels: Labels, seconds: number): void {
    const k = key(labels);
    const s = this.series.get(k) ?? { labels, counts: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => { if (seconds <= b) s.counts[i] += 1; });
    s.sum += seconds;
    s.count += 1;
    this.series.set(k, s);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      BUCKETS.forEach((b, i) => lines.push(`${this.name}_bucket${fmt({ ...s.labels, le: String(b) })} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket${fmt({ ...s.labels, le: "+Inf" })} ${s.count}`);
      lines.push(`${this.name}_sum${fmt(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${fmt(s.labels)} ${s.count}`);
    }
    return lines.join("\n");
  }
}

export class Metrics {
  readonly calls = new Counter("ai_tool_calls_total", "Appels de tools MCP faits par les agents, par issue.");
  readonly denied = new Counter("ai_tool_denied_total", "Appels de tools refusés, par motif.");
  readonly approvals = new Counter("ai_approval_requests_total", "Demandes d'approbation PRD, par étape.");
  readonly duration = new Histogram("ai_tool_duration_seconds", "Durée des appels de tools MCP.");

  render(): string {
    return `${[this.calls.render(), this.denied.render(), this.approvals.render(), this.duration.render()].join("\n")}\n`;
  }
}

// Les formes émises par supabase/functions/_shared/mcp-observe.ts.
export interface ToolCallEvent {
  trace_id: string;
  session_id: string | null;
  user: string | null;
  user_sub: string | null;
  agent: string | null;
  agent_client: string | null;
  workspace_id: string | null;
  mcp_server: string;
  cluster: string | null;
  tool: string;
  status: string;
  reason: string | null;
  policy_decision: string | null;
  approval_id: string | null;
  duration_ms: number;
}

export interface ApprovalStepEvent {
  approval_id: string;
  status: string;
  tool: string;
  target_cluster: string | null;
  requester: string | null;
  approver: string | null;
}

export const metrics = new Metrics();

type Write = (line: string) => void;

/** L'observateur des appels MCP : audit JSON + métriques. */
export function createMcpObserver(m: Metrics = metrics, write: Write = (line) => process.stdout.write(`${line}\n`)) {
  return {
    toolCall(e: ToolCallEvent): void {
      write(JSON.stringify({ ts: new Date().toISOString(), event: "tool_call", source: "founderos", ...e }));
      m.calls.inc({ tool: e.tool, cluster: e.cluster ?? "", status: e.status });
      if (e.status === "denied" || e.status === "invalid") m.denied.inc({ tool: e.tool, reason: e.reason ?? e.status });
      m.duration.observe({ tool: e.tool }, e.duration_ms / 1000);
    },
    approval(e: ApprovalStepEvent): void {
      write(JSON.stringify({ ts: new Date().toISOString(), event: "approval", source: "founderos", ...e }));
      m.approvals.inc({ status: e.status });
    },
  };
}

/** Installé au chargement du backend : les fonctions le trouvent sur globalThis. */
export function installMcpObserver(): void {
  (globalThis as { __mcpObserver?: unknown }).__mcpObserver = createMcpObserver();
}

/** Port de gestion : /metrics pour Prometheus, /healthz. Jamais derrière une Route. */
export function createMgmtServer(m: Metrics = metrics): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" }).end(m.render());
      return;
    }
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  });
}
