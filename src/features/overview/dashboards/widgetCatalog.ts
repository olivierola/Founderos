// Pre-configured widgets the user can add to a custom dashboard in one click.
// Each entry produces the same shape as a custom widget — the user is free to
// tweak it after adding (the dialog opens pre-filled).

import type { WidgetConfig, WidgetType } from "./types";

export type WidgetCategory =
  | "Finance"
  | "Costs"
  | "Users"
  | "Engagement"
  | "Marketing"
  | "Code"
  | "Security"
  | "Health"
  | "Ops"
  | "AI";

export interface CatalogWidget {
  id: string;
  category: WidgetCategory;
  title: string;
  description: string;
  type: WidgetType;
  config: WidgetConfig;
  /** Keywords for fuzzy search. */
  keywords?: string[];
}

const monthlyBucket = (dateCol = "created_at") => ({
  bucket: { column: dateCol, unit: "month" as const },
});

export const WIDGET_CATALOG: CatalogWidget[] = [
  /* ===================== Finance ===================== */
  {
    id: "fin-mrr",
    category: "Finance",
    title: "MRR",
    description: "Monthly recurring revenue, latest value from metrics.",
    type: "kpi",
    config: {
      source: { kind: "metrics", metric: "mrr_cents" },
      format: "currency",
      formula: "value / 100",
      showDelta: true,
    },
    keywords: ["revenue", "subscription"],
  },
  {
    id: "fin-arr",
    category: "Finance",
    title: "ARR",
    description: "Annualised recurring revenue (MRR × 12).",
    type: "kpi",
    config: {
      source: { kind: "metrics", metric: "arr_cents" },
      format: "currency",
      formula: "value / 100",
    },
  },
  {
    id: "fin-arpu",
    category: "Finance",
    title: "ARPU",
    description: "Average revenue per active user.",
    type: "kpi",
    config: {
      source: { kind: "metrics", metric: "arpu_cents" },
      format: "currency",
      formula: "value / 100",
    },
  },
  {
    id: "fin-active-subs",
    category: "Finance",
    title: "Active subscriptions",
    description: "Count of active or trialing subscriptions.",
    type: "kpi",
    config: { source: { kind: "metrics", metric: "active_subscriptions" } },
  },
  {
    id: "fin-customers",
    category: "Finance",
    title: "Total customers",
    description: "Total customers synced into FounderOS.",
    type: "kpi",
    config: { source: { kind: "metrics", metric: "customers" } },
  },
  {
    id: "fin-new-customers-30d",
    category: "Finance",
    title: "New customers (30d)",
    description: "Customers added in the last 30 days.",
    type: "kpi",
    config: { source: { kind: "metrics", metric: "new_customers_30d" } },
  },
  {
    id: "fin-churn-30d",
    category: "Finance",
    title: "Churn rate (30d)",
    description: "% of customers who churned over the trailing 30 days.",
    type: "kpi",
    config: { source: { kind: "metrics", metric: "churn_rate_30d" }, format: "percent" },
  },
  {
    id: "fin-ltv",
    category: "Finance",
    title: "LTV",
    description: "Average lifetime value (cents → €).",
    type: "kpi",
    config: {
      source: { kind: "metrics", metric: "ltv_cents" },
      format: "currency",
      formula: "value / 100",
    },
  },
  {
    id: "fin-trial-conv",
    category: "Finance",
    title: "Trial conversions (30d)",
    description: "Trials that converted to paid in the last 30 days.",
    type: "kpi",
    config: { source: { kind: "metrics", metric: "trial_conversions_30d" } },
  },
  {
    id: "fin-mrr-trend",
    category: "Finance",
    title: "MRR trend",
    description: "MRR over time (line chart).",
    type: "line",
    config: {
      source: { kind: "metrics", metric: "mrr_cents" },
      xKey: "date",
      yKey: "value",
    },
  },
  {
    id: "fin-revenue-by-month",
    category: "Finance",
    title: "Revenue by month",
    description: "Sum of revenue grouped per month.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "revenue_records",
        aggregate: { fn: "sum", column: "amount_cents" },
        ...monthlyBucket("recorded_at"),
      },
      xKey: "date",
      yKey: "value",
    },
  },
  {
    id: "fin-subs-by-status",
    category: "Finance",
    title: "Subscriptions by status",
    description: "Pie chart of subscriptions grouped by status.",
    type: "pie",
    config: {
      source: {
        kind: "internal",
        table: "subscriptions",
        aggregate: { fn: "count", column: "id" },
        group_by: "status",
      },
      xKey: "label",
      yKey: "value",
      emitFilterColumn: "status",
    },
  },
  {
    id: "fin-subs-by-plan",
    category: "Finance",
    title: "Subscriptions by plan",
    description: "Distribution of active subscriptions across plans.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "subscriptions",
        aggregate: { fn: "count", column: "id" },
        group_by: "plan_name",
      },
      xKey: "label",
      yKey: "value",
      emitFilterColumn: "plan_name",
    },
  },
  {
    id: "fin-invoices-paid-month",
    category: "Finance",
    title: "Invoices paid (by month)",
    description: "Sum of paid invoices per month.",
    type: "area",
    config: {
      source: {
        kind: "internal",
        table: "invoices",
        aggregate: { fn: "sum", column: "amount_paid_cents" },
        bucket: { column: "paid_at", unit: "month" },
      },
      xKey: "date",
      yKey: "value",
    },
  },

  /* ===================== Costs ===================== */
  {
    id: "costs-total-month",
    category: "Costs",
    title: "Costs this month",
    description: "Sum of cost records grouped by month.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "cost_records",
        aggregate: { fn: "sum", column: "amount_cents" },
        bucket: { column: "recorded_at", unit: "month" },
      },
      xKey: "date",
      yKey: "value",
    },
  },
  {
    id: "costs-llm-by-provider",
    category: "Costs",
    title: "LLM cost by provider",
    description: "Sum of LLM usage cost per provider.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "llm_usage",
        aggregate: { fn: "sum", column: "cost_cents" },
        group_by: "provider",
      },
      xKey: "label",
      yKey: "value",
      emitFilterColumn: "provider",
    },
  },
  {
    id: "costs-llm-tokens",
    category: "Costs",
    title: "LLM tokens (by day)",
    description: "Total tokens consumed daily.",
    type: "line",
    config: {
      source: {
        kind: "internal",
        table: "llm_usage",
        aggregate: { fn: "sum", column: "tokens" },
        bucket: { column: "created_at", unit: "day" },
      },
      xKey: "date",
      yKey: "value",
    },
  },
  {
    id: "costs-burn-30d",
    category: "Costs",
    title: "Burn rate (30d)",
    description: "Sum of costs in the last 30 days (KPI).",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "cost_records",
        aggregate: { fn: "sum", column: "amount_cents" },
      },
      format: "currency",
      formula: "value / 100",
    },
  },

  /* ===================== Users ===================== */
  {
    id: "users-total",
    category: "Users",
    title: "Total users",
    description: "Customer count (synced from billing / auth).",
    type: "kpi",
    config: { source: { kind: "metrics", metric: "customers" } },
  },
  {
    id: "users-active-30d",
    category: "Users",
    title: "Active users (30d)",
    description: "Users seen in the last 30 days.",
    type: "kpi",
    config: { source: { kind: "metrics", metric: "active_users_30d" } },
  },
  {
    id: "users-signups-30d",
    category: "Users",
    title: "Signups (30d)",
    description: "New signups in the last 30 days.",
    type: "kpi",
    config: { source: { kind: "metrics", metric: "signups_30d" } },
  },
  {
    id: "users-signups-trend",
    category: "Users",
    title: "Signups trend",
    description: "New customers per month over time.",
    type: "area",
    config: {
      source: {
        kind: "internal",
        table: "customers",
        aggregate: { fn: "count", column: "id" },
        bucket: { column: "created_at", unit: "month" },
      },
      xKey: "date",
      yKey: "value",
    },
  },
  {
    id: "users-recent",
    category: "Users",
    title: "Recent signups",
    description: "Last 20 customers (table).",
    type: "table",
    config: {
      source: {
        kind: "internal",
        table: "customers",
        order_by: "created_at",
        order_dir: "desc",
        limit: 20,
      },
    },
  },

  /* ===================== Engagement ===================== */
  {
    id: "eng-events-30d",
    category: "Engagement",
    title: "Product events (30d)",
    description: "Total tracked product events over the last month.",
    type: "line",
    config: {
      source: {
        kind: "internal",
        table: "product_events",
        aggregate: { fn: "count", column: "id" },
        bucket: { column: "occurred_at", unit: "day" },
      },
      xKey: "date",
      yKey: "value",
    },
  },
  {
    id: "eng-top-features",
    category: "Engagement",
    title: "Top features (by events)",
    description: "Most-used features by event count.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "product_events",
        aggregate: { fn: "count", column: "id" },
        group_by: "event_name",
        order_by: "value",
        order_dir: "desc",
        limit: 10,
      },
      xKey: "label",
      yKey: "value",
    },
  },
  {
    id: "eng-activity-recent",
    category: "Engagement",
    title: "Recent activity",
    description: "Last 25 entries from the activity feed.",
    type: "table",
    config: {
      source: {
        kind: "internal",
        table: "activity_logs",
        order_by: "created_at",
        order_dir: "desc",
        limit: 25,
      },
    },
  },

  /* ===================== Marketing ===================== */
  {
    id: "mkt-published-week",
    category: "Marketing",
    title: "Posts published (week)",
    description: "Posts whose status transitioned to published this week.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "activity_logs",
        aggregate: { fn: "count", column: "id" },
        filters: [{ column: "event_type", op: "=", value: "marketing.post_published" }],
      },
    },
  },

  /* ===================== Code ===================== */
  {
    id: "code-last-scans",
    category: "Code",
    title: "Recent scans",
    description: "Last 10 code scans across all repositories.",
    type: "table",
    config: {
      source: {
        kind: "internal",
        table: "scan_results",
        order_by: "created_at",
        order_dir: "desc",
        limit: 10,
      },
    },
  },
  {
    id: "code-scans-trend",
    category: "Code",
    title: "Scans over time",
    description: "Number of scans per week.",
    type: "line",
    config: {
      source: {
        kind: "internal",
        table: "scan_results",
        aggregate: { fn: "count", column: "id" },
        bucket: { column: "created_at", unit: "week" },
      },
      xKey: "date",
      yKey: "value",
    },
  },

  /* ===================== Security ===================== */
  {
    id: "sec-open-alerts",
    category: "Security",
    title: "Open alerts",
    description: "Alerts currently in status=open.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "alerts",
        aggregate: { fn: "count", column: "id" },
        filters: [{ column: "status", op: "=", value: "open" }],
      },
    },
  },
  {
    id: "sec-alerts-by-severity",
    category: "Security",
    title: "Alerts by severity",
    description: "Open alerts grouped by severity.",
    type: "pie",
    config: {
      source: {
        kind: "internal",
        table: "alerts",
        aggregate: { fn: "count", column: "id" },
        group_by: "severity",
        filters: [{ column: "status", op: "=", value: "open" }],
      },
      xKey: "label",
      yKey: "value",
      emitFilterColumn: "severity",
    },
  },

  /* ===================== Health ===================== */
  {
    id: "health-errors-24h",
    category: "Health",
    title: "Errors (24h)",
    description: "Error events count in the last 24 hours.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "error_events",
        aggregate: { fn: "count", column: "id" },
      },
    },
  },
  {
    id: "health-errors-trend",
    category: "Health",
    title: "Errors over time",
    description: "Error events per day.",
    type: "area",
    config: {
      source: {
        kind: "internal",
        table: "error_events",
        aggregate: { fn: "count", column: "id" },
        bucket: { column: "occurred_at", unit: "day" },
      },
      xKey: "date",
      yKey: "value",
    },
  },
  {
    id: "health-deploys-week",
    category: "Health",
    title: "Deployments (week)",
    description: "Total deployments grouped per week.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "deployments",
        aggregate: { fn: "count", column: "id" },
        bucket: { column: "deployed_at", unit: "week" },
      },
      xKey: "date",
      yKey: "value",
    },
  },
  {
    id: "health-incidents-open",
    category: "Health",
    title: "Open incidents",
    description: "Incidents not yet resolved.",
    type: "table",
    config: {
      source: {
        kind: "internal",
        table: "incidents",
        order_by: "created_at",
        order_dir: "desc",
        limit: 10,
        filters: [{ column: "status", op: "!=", value: "resolved" }],
      },
    },
  },

  /* ===================== Ops ===================== */
  {
    id: "ops-activity-by-type",
    category: "Ops",
    title: "Activity by type (30d)",
    description: "Activity log entries grouped by event_type.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "activity_logs",
        aggregate: { fn: "count", column: "id" },
        group_by: "event_type",
        order_by: "value",
        order_dir: "desc",
        limit: 10,
      },
      xKey: "label",
      yKey: "value",
      emitFilterColumn: "event_type",
    },
  },

  /* ===================== AI ===================== */
  {
    id: "ai-llm-cost-month",
    category: "AI",
    title: "LLM spend (this month)",
    description: "Sum of LLM cost in the current month.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "llm_usage",
        aggregate: { fn: "sum", column: "cost_cents" },
      },
      format: "currency",
      formula: "value / 100",
    },
  },
  {
    id: "ai-llm-calls-day",
    category: "AI",
    title: "LLM calls (by day)",
    description: "Number of LLM API calls per day.",
    type: "line",
    config: {
      source: {
        kind: "internal",
        table: "llm_usage",
        aggregate: { fn: "count", column: "id" },
        bucket: { column: "created_at", unit: "day" },
      },
      xKey: "date",
      yKey: "value",
    },
  },
];

export function getCatalogCategories(): WidgetCategory[] {
  const set = new Set<WidgetCategory>();
  WIDGET_CATALOG.forEach((w) => set.add(w.category));
  return Array.from(set);
}
