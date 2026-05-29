import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { callEdge } from "@/lib/edge";
import { formatCurrency } from "@/lib/utils";
import { CHART_COLORS, type Widget } from "./types";

function applyFormula(value: number, formula?: string): number {
  if (!formula) return value;
  try {
    // very small safe evaluator: only `value`, numbers and + - * / ( )
    if (!/^[\d\s+\-*/().value]+$/.test(formula)) return value;
    // eslint-disable-next-line no-new-func
    const fn = new Function("value", `return (${formula});`);
    const r = fn(value);
    return typeof r === "number" && isFinite(r) ? r : value;
  } catch {
    return value;
  }
}

function fmt(value: number, cfg: Widget["config"]): string {
  const v = applyFormula(value, cfg.formula);
  if (cfg.format === "currency") return formatCurrency(v, "EUR");
  if (cfg.format === "percent") return `${(v * 100).toFixed(1)}%`;
  const s = Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
  return `${cfg.prefix ?? ""}${s}${cfg.suffix ?? ""}`;
}

export interface CrossFilter {
  column: string;
  value: string;
}

export function WidgetView({
  widget,
  workspaceId,
  projectId,
  crossFilter,
  refreshKey,
  onSegmentClick,
}: {
  widget: Widget;
  workspaceId: string;
  projectId: string;
  crossFilter?: CrossFilter | null;
  refreshKey?: number;
  onSegmentClick?: (filter: CrossFilter) => void;
}) {
  const needsData = widget.type !== "markdown";

  // Merge an active cross-filter into this widget's source filters (if its source
  // is on the same kind/table and the filter column isn't what this widget emits).
  const effectiveSource = (() => {
    const s = widget.config.source;
    if (!s || !crossFilter) return s;
    if (widget.config.emitFilterColumn === crossFilter.column) return s; // don't filter the emitter itself
    return { ...s, filters: [...(s.filters ?? []), { column: crossFilter.column, op: "=", value: crossFilter.value }] };
  })();

  const { data, isLoading, error } = useQuery({
    queryKey: ["widget-data", widget.id, JSON.stringify(effectiveSource), refreshKey ?? 0],
    enabled: needsData && !!effectiveSource && !!projectId,
    queryFn: async () => {
      const res = await callEdge<{ rows: Record<string, unknown>[] }>("dashboard-data", {
        workspace_id: workspaceId,
        project_id: projectId,
        source: effectiveSource,
      });
      return res.rows ?? [];
    },
  });

  if (widget.type === "markdown") {
    return (
      <div className="h-full overflow-auto whitespace-pre-wrap p-1 text-sm text-foreground/90">
        {widget.config.text || "Empty note. Edit this widget to add text."}
      </div>
    );
  }

  if (!widget.config.source) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Configure this widget</div>;
  }
  if (isLoading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>;
  }
  if (error) {
    return <div className="flex h-full items-center justify-center px-2 text-center text-xs text-destructive">{(error as Error).message}</div>;
  }

  const rows = data ?? [];
  const cfg = widget.config;

  if (widget.type === "kpi") {
    const value = Number((rows[0] as any)?.value ?? (rows[0] ? Object.values(rows[0])[0] : 0) ?? 0);
    // Delta: compare last vs previous point of a time series (when available)
    let delta: number | null = null;
    if (cfg.showDelta && rows.length >= 2 && "value" in (rows[rows.length - 1] as any)) {
      const last = Number((rows[rows.length - 1] as any).value ?? 0);
      const prev = Number((rows[rows.length - 2] as any).value ?? 0);
      if (prev !== 0) delta = ((last - prev) / Math.abs(prev)) * 100;
    }
    // For metrics series, the KPI value should be the latest point, not the first.
    const kpiValue =
      cfg.source?.kind === "metrics" && rows.length > 0
        ? Number((rows[rows.length - 1] as any).value ?? 0)
        : value;
    return (
      <div className="flex h-full flex-col justify-center">
        <div className="text-3xl font-semibold tracking-tight">{fmt(kpiValue, cfg)}</div>
        {delta !== null && (
          <div className={`mt-1 text-xs ${delta >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}% vs previous
          </div>
        )}
      </div>
    );
  }

  if (widget.type === "table") {
    if (rows.length === 0) return <Empty />;
    const cols = Object.keys(rows[0]!);
    return (
      <div className="h-full overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card text-left text-muted-foreground">
            <tr>{cols.map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.slice(0, 100).map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c} className="max-w-[160px] truncate px-2 py-1 font-mono">
                    {typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Charts
  const xKey = cfg.xKey ?? (rows[0] && ("date" in rows[0] ? "date" : "label" in rows[0] ? "label" : Object.keys(rows[0])[0]!)) ?? "label";
  const yKey = cfg.yKey ?? (rows[0] && "value" in rows[0] ? "value" : Object.keys(rows[0] ?? {})[1] ?? "value");

  if (rows.length === 0) return <Empty />;

  const colors = cfg.colors?.length ? cfg.colors : CHART_COLORS;
  const axis = { stroke: "hsl(var(--muted-foreground))", fontSize: 11 };
  const grid = <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />;
  const tip = (
    <Tooltip
      contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
      labelStyle={{ color: "hsl(var(--foreground))" }}
    />
  );

  if (widget.type === "line") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows}>
          {grid}<XAxis dataKey={xKey} {...axis} /><YAxis {...axis} />{tip}
          <Line type="monotone" dataKey={yKey} stroke={colors[0]} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    );
  }
  if (widget.type === "area") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows}>
          {grid}<XAxis dataKey={xKey} {...axis} /><YAxis {...axis} />{tip}
          <Area type="monotone" dataKey={yKey} stroke={colors[0]} fill={colors[0]} fillOpacity={0.2} />
        </AreaChart>
      </ResponsiveContainer>
    );
  }
  const emitCol = cfg.emitFilterColumn || cfg.source?.group_by || xKey;
  const emit = (row: any) => {
    if (!onSegmentClick || !emitCol) return;
    const value = String(row?.[xKey] ?? row?.label ?? "");
    if (value) onSegmentClick({ column: emitCol, value });
  };

  if (widget.type === "bar") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows}>
          {grid}<XAxis dataKey={xKey} {...axis} /><YAxis {...axis} />{tip}
          <Bar
            dataKey={yKey}
            fill={colors[0]}
            radius={[4, 4, 0, 0]}
            cursor={onSegmentClick ? "pointer" : undefined}
            onClick={(d: any) => emit(d?.payload ?? d)}
          />
        </BarChart>
      </ResponsiveContainer>
    );
  }
  if (widget.type === "pie") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={rows}
            dataKey={yKey}
            nameKey={xKey}
            cx="50%"
            cy="50%"
            outerRadius="80%"
            cursor={onSegmentClick ? "pointer" : undefined}
            onClick={(d: any) => emit(d?.payload ?? d)}
          >
            {rows.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
          </Pie>
          {tip}
        </PieChart>
      </ResponsiveContainer>
    );
  }
  return null;
}

function Empty() {
  return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">No data</div>;
}
