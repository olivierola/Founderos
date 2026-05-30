export type WidgetType = "kpi" | "line" | "bar" | "area" | "pie" | "table" | "markdown";

export interface WidgetSource {
  kind: "internal" | "metrics" | "static" | "project_db";
  table?: string;
  metric?: string;
  columns?: string[];
  aggregate?: { fn: "count" | "sum" | "avg" | "min" | "max" | "count_distinct"; column: string } | null;
  group_by?: string | null;
  // time bucketing for date series (overrides group_by when set)
  bucket?: { column: string; unit: "none" | "day" | "week" | "month" } | null;
  filters?: { column: string; op: string; value: string }[];
  order_by?: string;
  order_dir?: "asc" | "desc";
  limit?: number;
  rows?: Record<string, unknown>[];
}

export interface WidgetConfig {
  source?: WidgetSource;
  // chart mapping
  xKey?: string; // category / x axis
  yKey?: string; // value axis
  // kpi
  format?: "number" | "currency" | "percent";
  prefix?: string;
  suffix?: string;
  showDelta?: boolean; // compare last vs previous point of a time series
  // markdown
  text?: string;
  /** Optional heading level applied to a "text" widget. When set, the value is
   *  rendered as an H1/H2/H3/H4 — useful to drop section titles between charts. */
  headingLevel?: 1 | 2 | 3 | 4;
  /** Optional text alignment for markdown widgets. */
  textAlign?: "left" | "center" | "right";
  // optional formula applied to a numeric result (uses `value`, basic JS-safe expr)
  formula?: string;
  // cross-filtering: which column this chart emits when a segment is clicked
  emitFilterColumn?: string;
  // chart appearance: explicit colors (hex). For single-series charts colors[0] is used;
  // pie/multi-series cycle through the array. Empty = default palette.
  colors?: string[];
}

export interface Widget {
  id: string;
  dashboard_id: string;
  workspace_id: string;
  type: WidgetType;
  title: string | null;
  config: WidgetConfig;
  position: { x: number; y: number; w: number; h: number };
}

export interface CustomDashboard {
  id: string;
  name: string;
  description: string | null;
  layout: unknown[];
}

export const INTERNAL_TABLES = [
  "customers",
  "subscriptions",
  "invoices",
  "revenue_records",
  "cost_records",
  "llm_usage",
  "scan_results",
  "product_events",
  "alerts",
  "activity_logs",
  "deployments",
  "error_events",
  "incidents",
];

export const METRIC_KEYS = [
  "mrr_cents",
  "arr_cents",
  "arpu_cents",
  "active_subscriptions",
  "customers",
  "new_customers_30d",
  "churned_customers_30d",
  "total_revenue_cents",
  "revenue_last_30d_cents",
  "revenue_last_7d_cents",
  "churn_rate_30d",
  "ltv_cents",
  "trial_conversions_30d",
  "active_users_30d",
  "signups_30d",
];

export const CHART_COLORS = ["#C2D099", "#BBE0EF", "#F16D34", "#a78bfa", "#34d399", "#fbbf24", "#f472b6"];

// Named palettes the user can pick from for a chart.
export const CHART_PALETTES: { name: string; colors: string[] }[] = [
  { name: "Default", colors: CHART_COLORS },
  { name: "Sage", colors: ["#C2D099", "#A3B373", "#849658", "#677842", "#4d5a30"] },
  { name: "Ocean", colors: ["#BBE0EF", "#7FC4E0", "#4AA3CC", "#2C7BA6", "#1E5878"] },
  { name: "Sunset", colors: ["#F16D34", "#F59E5B", "#FBBF24", "#F472B6", "#A855F7"] },
  { name: "Forest", colors: ["#34d399", "#10b981", "#059669", "#047857", "#065f46"] },
  { name: "Mono", colors: ["#71717a", "#52525b", "#3f3f46", "#27272a", "#18181b"] },
];

// Aggregatable suggestions per internal table (column → semantic). Used by the dialog
// to offer relevant columns instead of free-typing.
export const TABLE_NUMERIC_COLUMNS: Record<string, string[]> = {
  customers: ["lifetime_value_cents"],
  subscriptions: ["amount_cents"],
  invoices: ["amount_cents", "amount_paid_cents"],
  revenue_records: ["amount_cents"],
  cost_records: ["amount_cents"],
  llm_usage: ["tokens", "cost_cents"],
  product_events: [],
  deployments: [],
  error_events: [],
};

export const TABLE_DATE_COLUMNS: Record<string, string[]> = {
  customers: ["created_at"],
  subscriptions: ["created_at", "current_period_start", "current_period_end"],
  invoices: ["created_at", "paid_at"],
  revenue_records: ["recorded_at", "created_at"],
  cost_records: ["recorded_at", "created_at"],
  llm_usage: ["created_at"],
  product_events: ["occurred_at", "created_at"],
  activity_logs: ["created_at"],
  deployments: ["created_at", "deployed_at"],
  error_events: ["occurred_at", "created_at"],
  incidents: ["created_at", "resolved_at"],
};
