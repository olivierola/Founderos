// Métriques Prometheus, format texte, sans dépendance : cinq séries suffisent
// et chaque dépendance de plus est une ligne de la chaîne d'approvisionnement.
//
//   ai_tool_calls_total{tool, cluster, status}
//   ai_tool_denied_total{tool, reason}
//   ai_tool_duration_seconds{tool}   (histogramme)
//   mcp_token_push_total{result}     (jeton tournant : delivered, current, unknown, error)
//   mcp_check_ok{check}              (vérifications : RBAC, OPA, livraison du jeton)

const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

type Labels = Record<string, string>;
const key = (labels: Labels) => JSON.stringify(Object.entries(labels).sort());
const fmt = (labels: Labels) =>
  Object.keys(labels).length
    ? `{${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`
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

class Gauge {
  private values = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string) {}
  set(labels: Labels, value: number): void {
    this.values.set(key(labels), { labels, value });
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.values.values()) lines.push(`${this.name}${fmt(labels)} ${value}`);
    return lines.join("\n");
  }
}

export class Metrics {
  readonly calls = new Counter("ai_tool_calls_total", "Appels de tools, par issue.");
  readonly denied = new Counter("ai_tool_denied_total", "Appels refusés, par motif.");
  readonly duration = new Histogram("ai_tool_duration_seconds", "Durée des appels de tools.");
  readonly tokenPush = new Counter("mcp_token_push_total", "Livraisons du jeton tournant à FounderOS, par issue.");
  readonly checks = new Gauge("mcp_check_ok", "Vérifications de démarrage et de disponibilité : 1 si elle passe, 0 sinon.");

  render(): string {
    return `${[this.calls.render(), this.denied.render(), this.duration.render(), this.tokenPush.render(), this.checks.render()].join("\n")}\n`;
  }
}
