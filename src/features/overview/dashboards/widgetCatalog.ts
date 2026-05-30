// Pre-configured widgets the user can add to a custom dashboard in one click.
// Each entry produces the same shape as a custom widget — the user is free to
// tweak it after adding (the dialog opens pre-filled).

import type { WidgetConfig, WidgetType } from "./types";

export type WidgetCategory =
  | "Text"
  | "Finance"
  | "Costs"
  | "Users"
  | "Engagement"
  | "Marketing"
  | "Code"
  | "Security"
  | "Health"
  | "Ops"
  | "AI"
  | "Integrations";

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

  /* ===================== Text / Layout ===================== */
  {
    id: "text-section-title",
    category: "Text",
    title: "Section heading",
    description: "Big H2 title to separate sections in the dashboard.",
    type: "markdown",
    config: { text: "Section title", headingLevel: 2, textAlign: "left" },
  },
  {
    id: "text-page-title",
    category: "Text",
    title: "Page title",
    description: "Large centered H1 — good for the top of a dashboard.",
    type: "markdown",
    config: { text: "Dashboard", headingLevel: 1, textAlign: "center" },
  },
  {
    id: "text-subtitle",
    category: "Text",
    title: "Subtitle",
    description: "Smaller H3 heading.",
    type: "markdown",
    config: { text: "Subtitle", headingLevel: 3, textAlign: "left" },
  },
  {
    id: "text-note",
    category: "Text",
    title: "Note / paragraph",
    description: "Formatted markdown note with bold, italic, lists, links.",
    type: "markdown",
    config: {
      text:
        "**Note.** Add context to your dashboard. Supports *italic*, [links](https://example.com), `code`, lists and tables.",
      textAlign: "left",
    },
  },
  {
    id: "text-checklist",
    category: "Text",
    title: "Checklist",
    description: "Markdown task list — GFM checkboxes.",
    type: "markdown",
    config: {
      text: "- [ ] First task\n- [ ] Second task\n- [x] Done",
      textAlign: "left",
    },
  },
  {
    id: "text-divider",
    category: "Text",
    title: "Divider",
    description: "Horizontal rule to break sections.",
    type: "markdown",
    config: { text: "---", textAlign: "left" },
  },

  /* ===================== Finance — extras ===================== */
  {
    id: "fin-total-revenue",
    category: "Finance",
    title: "Total revenue (all time)",
    description: "Lifetime revenue from the metrics snapshot.",
    type: "kpi",
    config: {
      source: { kind: "metrics", metric: "total_revenue_cents" },
      format: "currency",
      formula: "value / 100",
    },
  },
  {
    id: "fin-revenue-30d",
    category: "Finance",
    title: "Revenue (30d)",
    description: "Trailing 30-day revenue.",
    type: "kpi",
    config: {
      source: { kind: "metrics", metric: "revenue_last_30d_cents" },
      format: "currency",
      formula: "value / 100",
    },
  },
  {
    id: "fin-revenue-7d",
    category: "Finance",
    title: "Revenue (7d)",
    description: "Trailing 7-day revenue.",
    type: "kpi",
    config: {
      source: { kind: "metrics", metric: "revenue_last_7d_cents" },
      format: "currency",
      formula: "value / 100",
    },
  },
  {
    id: "fin-churned-30d",
    category: "Finance",
    title: "Churned (30d)",
    description: "Customers churned in the last 30 days.",
    type: "kpi",
    config: { source: { kind: "metrics", metric: "churned_customers_30d" } },
  },
  {
    id: "fin-arr-trend",
    category: "Finance",
    title: "ARR trend",
    description: "Annualised revenue over time.",
    type: "area",
    config: {
      source: { kind: "metrics", metric: "arr_cents" },
      xKey: "date",
      yKey: "value",
    },
  },
  {
    id: "fin-active-subs-trend",
    category: "Finance",
    title: "Active subs trend",
    description: "Number of active subscriptions over time.",
    type: "line",
    config: {
      source: { kind: "metrics", metric: "active_subscriptions" },
      xKey: "date",
      yKey: "value",
    },
  },
  {
    id: "fin-customers-trend",
    category: "Finance",
    title: "Customers trend",
    description: "Customer count over time.",
    type: "area",
    config: {
      source: { kind: "metrics", metric: "customers" },
      xKey: "date",
      yKey: "value",
    },
  },
  {
    id: "fin-churn-trend",
    category: "Finance",
    title: "Churn rate trend",
    description: "30d churn rate evolution.",
    type: "line",
    config: {
      source: { kind: "metrics", metric: "churn_rate_30d" },
      format: "percent",
      xKey: "date",
      yKey: "value",
    },
  },
  {
    id: "fin-trial-users",
    category: "Finance",
    title: "Trial users",
    description: "Subscriptions currently in trial.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "subscriptions",
        aggregate: { fn: "count", column: "id" },
        filters: [{ column: "status", op: "=", value: "trialing" }],
      },
    },
  },
  {
    id: "fin-past-due",
    category: "Finance",
    title: "Past-due subs",
    description: "Subscriptions in past_due state.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "subscriptions",
        aggregate: { fn: "count", column: "id" },
        filters: [{ column: "status", op: "=", value: "past_due" }],
      },
    },
  },
  {
    id: "fin-canceled-30d",
    category: "Finance",
    title: "Canceled (30d)",
    description: "Subscriptions canceled in the last 30 days.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "subscriptions",
        aggregate: { fn: "count", column: "id" },
        filters: [{ column: "status", op: "=", value: "canceled" }],
      },
    },
  },
  {
    id: "fin-recent-revenue",
    category: "Finance",
    title: "Recent revenue events",
    description: "Latest 10 revenue records.",
    type: "table",
    config: {
      source: {
        kind: "internal",
        table: "revenue_records",
        order_by: "recorded_at",
        order_dir: "desc",
        limit: 10,
      },
    },
  },
  {
    id: "fin-recent-invoices",
    category: "Finance",
    title: "Recent invoices",
    description: "Last 20 invoices.",
    type: "table",
    config: {
      source: {
        kind: "internal",
        table: "invoices",
        order_by: "created_at",
        order_dir: "desc",
        limit: 20,
      },
    },
  },
  {
    id: "fin-invoices-by-status",
    category: "Finance",
    title: "Invoices by status",
    description: "Distribution of invoices across statuses.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "invoices",
        aggregate: { fn: "count", column: "id" },
        group_by: "status",
      },
      xKey: "label",
      yKey: "value",
      emitFilterColumn: "status",
    },
  },
  {
    id: "fin-signups-by-month",
    category: "Finance",
    title: "Signups by month",
    description: "New customers per month.",
    type: "bar",
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
    id: "fin-top-customers",
    category: "Finance",
    title: "Top customers by LTV",
    description: "Top 20 customers ranked by lifetime value.",
    type: "table",
    config: {
      source: {
        kind: "internal",
        table: "customers",
        order_by: "lifetime_value_cents",
        order_dir: "desc",
        limit: 20,
      },
    },
  },

  /* ===================== Costs — extras ===================== */
  {
    id: "costs-total-recorded",
    category: "Costs",
    title: "Total recorded costs",
    description: "Sum of all cost records.",
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
  {
    id: "costs-by-category",
    category: "Costs",
    title: "Spend by category",
    description: "Cost records grouped by category.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "cost_records",
        aggregate: { fn: "sum", column: "amount_cents" },
        group_by: "category",
      },
      xKey: "label",
      yKey: "value",
      emitFilterColumn: "category",
    },
  },
  {
    id: "costs-by-provider",
    category: "Costs",
    title: "Spend by provider",
    description: "Cost records grouped by provider.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "cost_records",
        aggregate: { fn: "sum", column: "amount_cents" },
        group_by: "provider",
      },
      xKey: "label",
      yKey: "value",
      emitFilterColumn: "provider",
    },
  },
  {
    id: "costs-llm-calls-count",
    category: "Costs",
    title: "LLM calls count",
    description: "Total number of LLM calls.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "llm_usage",
        aggregate: { fn: "count", column: "id" },
      },
    },
  },
  {
    id: "costs-llm-tokens-total",
    category: "Costs",
    title: "LLM tokens (total)",
    description: "Sum of total tokens consumed.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "llm_usage",
        aggregate: { fn: "sum", column: "tokens" },
      },
    },
  },
  {
    id: "costs-llm-by-model",
    category: "Costs",
    title: "LLM cost by model",
    description: "Spend grouped by model name.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "llm_usage",
        aggregate: { fn: "sum", column: "cost_cents" },
        group_by: "model",
      },
      xKey: "label",
      yKey: "value",
      emitFilterColumn: "model",
    },
  },

  /* ===================== Users — extras ===================== */
  {
    id: "users-churned-30d",
    category: "Users",
    title: "Churned (30d)",
    description: "Customers churned in the last 30 days.",
    type: "kpi",
    config: { source: { kind: "metrics", metric: "churned_customers_30d" } },
  },
  {
    id: "users-dau",
    category: "Users",
    title: "DAU (1d)",
    description: "Distinct users with a product event in the last day.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "product_events",
        aggregate: { fn: "count_distinct", column: "user_id" },
      },
    },
  },
  {
    id: "users-wau",
    category: "Users",
    title: "WAU (7d)",
    description: "Distinct users active over the last 7 days.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "product_events",
        aggregate: { fn: "count_distinct", column: "user_id" },
      },
    },
  },
  {
    id: "users-mau",
    category: "Users",
    title: "MAU (30d)",
    description: "Distinct monthly active users.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "product_events",
        aggregate: { fn: "count_distinct", column: "user_id" },
      },
    },
  },

  /* ===================== Engagement — extras ===================== */
  {
    id: "eng-events-by-hour",
    category: "Engagement",
    title: "Events by hour",
    description: "Product events grouped by event_name (top 10).",
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
    id: "eng-activity-daily",
    category: "Engagement",
    title: "Activity volume (daily)",
    description: "Activity log entries per day.",
    type: "line",
    config: {
      source: {
        kind: "internal",
        table: "activity_logs",
        aggregate: { fn: "count", column: "id" },
        bucket: { column: "created_at", unit: "day" },
      },
      xKey: "date",
      yKey: "value",
    },
  },

  /* ===================== Marketing — extras ===================== */
  {
    id: "mkt-posts-by-status",
    category: "Marketing",
    title: "Posts by status",
    description: "Marketing posts split by status (via activity_logs).",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "activity_logs",
        aggregate: { fn: "count", column: "id" },
        group_by: "event_type",
        filters: [{ column: "event_type", op: "LIKE", value: "marketing.%" }],
      },
      xKey: "label",
      yKey: "value",
    },
  },

  /* ===================== Code — extras ===================== */
  {
    id: "code-failed-scans",
    category: "Code",
    title: "Failed scans",
    description: "Recent failed scan jobs (best-effort proxy).",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "scan_results",
        aggregate: { fn: "count", column: "id" },
        filters: [{ column: "ai_analysis", op: "is", value: "null" }],
      },
    },
  },

  /* ===================== Security — extras ===================== */
  {
    id: "sec-critical-alerts",
    category: "Security",
    title: "Critical alerts (open)",
    description: "Open alerts with severity=critical.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "alerts",
        aggregate: { fn: "count", column: "id" },
        filters: [
          { column: "status", op: "=", value: "open" },
          { column: "severity", op: "=", value: "critical" },
        ],
      },
    },
  },
  {
    id: "sec-high-alerts",
    category: "Security",
    title: "High alerts (open)",
    description: "Open alerts with severity=high.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "alerts",
        aggregate: { fn: "count", column: "id" },
        filters: [
          { column: "status", op: "=", value: "open" },
          { column: "severity", op: "=", value: "high" },
        ],
      },
    },
  },
  {
    id: "sec-alerts-trend",
    category: "Security",
    title: "Alerts over time",
    description: "Alert volume per week.",
    type: "line",
    config: {
      source: {
        kind: "internal",
        table: "alerts",
        aggregate: { fn: "count", column: "id" },
        bucket: { column: "created_at", unit: "week" },
      },
      xKey: "date",
      yKey: "value",
    },
  },
  {
    id: "sec-recent-alerts",
    category: "Security",
    title: "Recent alerts",
    description: "Last 10 alerts (any status).",
    type: "table",
    config: {
      source: {
        kind: "internal",
        table: "alerts",
        order_by: "created_at",
        order_dir: "desc",
        limit: 10,
      },
    },
  },

  /* ===================== Health — extras ===================== */
  {
    id: "health-incidents-count",
    category: "Health",
    title: "Open incidents (count)",
    description: "Number of unresolved incidents.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "incidents",
        aggregate: { fn: "count", column: "id" },
        filters: [{ column: "status", op: "!=", value: "resolved" }],
      },
    },
  },
  {
    id: "health-incidents-by-severity",
    category: "Health",
    title: "Incidents by severity",
    description: "Open incidents grouped by severity.",
    type: "pie",
    config: {
      source: {
        kind: "internal",
        table: "incidents",
        aggregate: { fn: "count", column: "id" },
        group_by: "severity",
        filters: [{ column: "status", op: "!=", value: "resolved" }],
      },
      xKey: "label",
      yKey: "value",
      emitFilterColumn: "severity",
    },
  },
  {
    id: "health-incidents-trend",
    category: "Health",
    title: "Incidents per week",
    description: "Number of incidents reported each week.",
    type: "line",
    config: {
      source: {
        kind: "internal",
        table: "incidents",
        aggregate: { fn: "count", column: "id" },
        bucket: { column: "created_at", unit: "week" },
      },
      xKey: "date",
      yKey: "value",
    },
  },
  {
    id: "health-errors-7d",
    category: "Health",
    title: "Errors (7d)",
    description: "Error events in the last 7 days.",
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
    id: "health-errors-by-level",
    category: "Health",
    title: "Errors by level",
    description: "Error events grouped by severity level.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "error_events",
        aggregate: { fn: "count", column: "id" },
        group_by: "level",
      },
      xKey: "label",
      yKey: "value",
      emitFilterColumn: "level",
    },
  },
  {
    id: "health-top-errors",
    category: "Health",
    title: "Top error messages",
    description: "Most frequent error messages.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "error_events",
        aggregate: { fn: "count", column: "id" },
        group_by: "message",
        order_by: "value",
        order_dir: "desc",
        limit: 10,
      },
      xKey: "label",
      yKey: "value",
    },
  },
  {
    id: "health-deploys-24h",
    category: "Health",
    title: "Deploys (24h)",
    description: "Number of deployments in the last day.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "deployments",
        aggregate: { fn: "count", column: "id" },
      },
    },
  },
  {
    id: "health-deploys-by-env",
    category: "Health",
    title: "Deploys by environment",
    description: "Deployments grouped by environment.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "deployments",
        aggregate: { fn: "count", column: "id" },
        group_by: "environment",
      },
      xKey: "label",
      yKey: "value",
      emitFilterColumn: "environment",
    },
  },
  {
    id: "health-failed-deploys",
    category: "Health",
    title: "Failed deploys",
    description: "Recent failed deployments.",
    type: "table",
    config: {
      source: {
        kind: "internal",
        table: "deployments",
        order_by: "created_at",
        order_dir: "desc",
        limit: 10,
        filters: [{ column: "state", op: "=", value: "failure" }],
      },
    },
  },

  /* ===================== Ops — extras ===================== */
  {
    id: "ops-activity-24h",
    category: "Ops",
    title: "Activity events (24h)",
    description: "Number of activity entries in the last 24 hours.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "activity_logs",
        aggregate: { fn: "count", column: "id" },
      },
    },
  },
  {
    id: "ops-activity-by-actor",
    category: "Ops",
    title: "Activity by actor",
    description: "Top actors by number of activity events.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "activity_logs",
        aggregate: { fn: "count", column: "id" },
        group_by: "actor_user_id",
        order_by: "value",
        order_dir: "desc",
        limit: 10,
      },
      xKey: "label",
      yKey: "value",
    },
  },

  /* ===================== AI — extras ===================== */
  {
    id: "ai-llm-calls-7d",
    category: "AI",
    title: "LLM calls (7d)",
    description: "LLM API calls over the last week.",
    type: "kpi",
    config: {
      source: {
        kind: "internal",
        table: "llm_usage",
        aggregate: { fn: "count", column: "id" },
      },
    },
  },
  {
    id: "ai-llm-tokens-by-model",
    category: "AI",
    title: "LLM tokens by model",
    description: "Total tokens grouped by model.",
    type: "bar",
    config: {
      source: {
        kind: "internal",
        table: "llm_usage",
        aggregate: { fn: "sum", column: "tokens" },
        group_by: "model",
      },
      xKey: "label",
      yKey: "value",
    },
  },
  {
    id: "ai-llm-cost-day",
    category: "AI",
    title: "LLM cost per day",
    description: "Daily LLM spend over time.",
    type: "line",
    config: {
      source: {
        kind: "internal",
        table: "llm_usage",
        aggregate: { fn: "sum", column: "cost_cents" },
        bucket: { column: "created_at", unit: "day" },
      },
      xKey: "date",
      yKey: "value",
    },
  },

  /* ===================== Integrations ===================== */
  {
    id: "int-connectors-total",
    category: "Integrations",
    title: "Connectors total",
    description: "Total connectors configured for this project.",
    type: "kpi",
    config: {
      source: { kind: "internal", table: "activity_logs", aggregate: { fn: "count", column: "id" }, filters: [{ column: "event_type", op: "=", value: "connector.connected" }] },
    },
  },
];

export function getCatalogCategories(): WidgetCategory[] {
  const set = new Set<WidgetCategory>();
  WIDGET_CATALOG.forEach((w) => set.add(w.category));
  return Array.from(set);
}
