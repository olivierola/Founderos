import { useQuery } from "@tanstack/react-query";
import { CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
import { CHART_COLORS, type Widget } from "./types";
import { getModuleWidget } from "./moduleWidgetRegistry";
import { formatWidgetValue as fmt, widgetChartKeys, widgetKpi } from "./widgetData";

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
  const needsData = widget.type !== "markdown" && widget.type !== "module";

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

  if (widget.type === "module") {
    const entry = getModuleWidget(widget.config.moduleWidgetId);
    if (!entry) {
      return (
        <div className="flex h-full items-center justify-center px-2 text-center text-xs text-muted-foreground">
          Unknown module widget.
        </div>
      );
    }
    const Component = entry.component;
    return <Component workspaceId={workspaceId} projectId={projectId} refreshKey={refreshKey} />;
  }

  if (widget.type === "markdown") {
    const text = widget.config.text ?? "";
    const align = widget.config.textAlign ?? "left";
    const headingLevel = widget.config.headingLevel;

    // When a heading level is set, render the whole text as a single heading
    // (clean shortcut for "Section title" widgets without typing # markers).
    if (headingLevel && text.trim()) {
      const sizes: Record<1 | 2 | 3 | 4, string> = {
        1: "text-3xl font-semibold tracking-tight",
        2: "text-2xl font-semibold tracking-tight",
        3: "text-xl font-semibold",
        4: "text-base font-semibold",
      };
      const alignClass = align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left";
      return (
        <div className={`flex h-full items-center px-1 ${alignClass}`}>
          <div className={`w-full ${sizes[headingLevel]}`}>{text}</div>
        </div>
      );
    }

    if (!text.trim()) {
      return (
        <div className="flex h-full items-center justify-center px-2 text-center text-xs text-muted-foreground">
          Empty note. Edit this widget to add text.
        </div>
      );
    }

    const alignClass = align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left";
    return (
      <div className={`h-full overflow-auto p-1 text-sm leading-relaxed ${alignClass}`}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => <h1 className="mb-2 mt-3 text-2xl font-semibold tracking-tight first:mt-0">{children}</h1>,
            h2: ({ children }) => <h2 className="mb-2 mt-3 text-xl font-semibold first:mt-0">{children}</h2>,
            h3: ({ children }) => <h3 className="mb-1.5 mt-2 text-base font-semibold first:mt-0">{children}</h3>,
            h4: ({ children }) => <h4 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h4>,
            p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
            ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5 last:mb-0">{children}</ul>,
            ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5 last:mb-0">{children}</ol>,
            strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
            em: ({ children }) => <em className="italic">{children}</em>,
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-[hsl(var(--primary-soft))] underline underline-offset-2 hover:opacity-80">
                {children}
              </a>
            ),
            code: ({ inline, children, ...props }: any) =>
              inline ? (
                <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.85em]" {...props}>
                  {children}
                </code>
              ) : (
                <code className="block" {...props}>{children}</code>
              ),
            pre: ({ children }) => (
              <pre className="my-2 overflow-x-auto rounded border border-border bg-secondary p-2 text-xs">{children}</pre>
            ),
            blockquote: ({ children }) => (
              <blockquote className="my-2 border-l-2 border-border pl-3 italic text-muted-foreground">{children}</blockquote>
            ),
            hr: () => <hr className="my-3 border-border" />,
          }}
        >
          {text}
        </ReactMarkdown>
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
    return <WidgetError error={error as Error} source={widget.config.source} />;
  }

  const rows = data ?? [];
  const cfg = widget.config;

  if (widget.type === "kpi") {
    const { value: kpiValue, delta } = widgetKpi(rows, cfg);
    return (
      <div className="flex h-full flex-col justify-center">
        <div className="font-stat-number text-3xl font-semibold tracking-tight">{fmt(kpiValue, cfg)}</div>
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
  const { xKey, yKey } = widgetChartKeys(rows, cfg);

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

/* Friendly error rendering — turn PostgREST / edge errors into readable hints
   instead of dumping raw JSON. */
function WidgetError({ error, source }: { error: Error; source?: WidgetSource }) {
  const msg = error?.message ?? "Unknown error";
  const parsed = parsePostgrestError(msg);

  if (parsed) {
    const isClient = source?.kind === "project_db";
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-xs text-destructive">
        <span className="font-medium">Table not found: {parsed.missing ?? source?.table ?? "?"}</span>
        {parsed.hint && (
          <span className="text-muted-foreground">
            Did you mean <span className="font-mono">{parsed.hint}</span>?
          </span>
        )}
        <span className="text-[11px] text-muted-foreground">
          {isClient
            ? "Searched the connected project DB (PostgREST exposes only schema `public`)."
            : "Searched Anduran internal tables."}
        </span>
        <span className="text-[10px] text-muted-foreground">Edit the widget to fix the table name.</span>
      </div>
    );
  }

  // Generic fallback — show a one-liner, not raw JSON.
  let display = msg;
  try {
    const j = JSON.parse(msg);
    display = j.message ?? j.error ?? display;
  } catch {
    /* keep as-is */
  }
  return (
    <div className="flex h-full items-center justify-center px-3 text-center text-xs text-destructive">
      {display}
    </div>
  );
}

interface WidgetSource {
  kind?: string;
  table?: string;
}

function parsePostgrestError(raw: string): { missing?: string; hint?: string } | null {
  // The edge wraps errors as `project_db query failed: {json}` — strip the prefix.
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const j = JSON.parse(jsonMatch[0]);
    if (typeof j.message !== "string") return null;
    if (j.code !== "PGRST205" && !/Could not find the table/i.test(j.message)) return null;
    const miss = j.message.match(/'public\.([^']+)'/);
    const hint = typeof j.hint === "string" ? (j.hint.match(/'public\.([^']+)'/) ?? [])[1] : undefined;
    return { missing: miss?.[1], hint };
  } catch {
    return null;
  }
}
