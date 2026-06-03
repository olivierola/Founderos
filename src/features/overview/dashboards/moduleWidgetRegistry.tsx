// Registry of REAL module widgets — the actual components rendered on the
// Finance / Users / Costs / Security / Health module pages, extracted so they
// can be imported "as is" into a custom dashboard.
//
// Each entry maps a stable id (stored in widget.config.moduleWidgetId) to the
// component, plus metadata for the library dropdown and a default grid size.

import type { ModuleWidgetProps } from "./moduleWidgets/shared";
import type { WidgetType } from "./types";
import * as Finance from "./moduleWidgets/finance";
import * as Engagement from "./moduleWidgets/engagement";
import * as Costs from "./moduleWidgets/costs";
import * as Security from "./moduleWidgets/security";
import * as Health from "./moduleWidgets/health";

export type ModuleName = "Finance" | "Users" | "Costs" | "Security" | "Health";

/** Visual kind — drives the default grid footprint and the library icon. */
export type ModuleWidgetKind = "kpi" | "chart" | "table" | "list";

export interface ModuleWidgetEntry {
  id: string;
  module: ModuleName;
  /** Where it comes from in the product, e.g. "Revenue", "Engagement". */
  page: string;
  title: string;
  description: string;
  kind: ModuleWidgetKind;
  component: React.ComponentType<ModuleWidgetProps>;
}

const DEFAULT_SIZE_BY_KIND: Record<ModuleWidgetKind, { w: number; h: number }> = {
  kpi: { w: 3, h: 2 },
  chart: { w: 6, h: 4 },
  table: { w: 6, h: 5 },
  list: { w: 4, h: 4 },
};

export const MODULE_WIDGETS: ModuleWidgetEntry[] = [
  /* ===================== Finance ===================== */
  { id: "finance.mrr", module: "Finance", page: "Revenue", title: "MRR", description: "Monthly recurring revenue card.", kind: "kpi", component: Finance.FinanceMrrCard },
  { id: "finance.arr", module: "Finance", page: "Revenue", title: "ARR", description: "Annual recurring revenue card.", kind: "kpi", component: Finance.FinanceArrCard },
  { id: "finance.arpu", module: "Finance", page: "Revenue", title: "ARPU", description: "Average revenue per user card.", kind: "kpi", component: Finance.FinanceArpuCard },
  { id: "finance.active_subs", module: "Finance", page: "Revenue", title: "Active subscriptions", description: "Active subscriptions with paying hint.", kind: "kpi", component: Finance.FinanceActiveSubsCard },
  { id: "finance.total_revenue", module: "Finance", page: "Revenue", title: "Total revenue", description: "All-time revenue card.", kind: "kpi", component: Finance.FinanceTotalRevenueCard },
  { id: "finance.revenue_30d", module: "Finance", page: "Revenue", title: "Last 30 days", description: "Revenue over the last 30 days.", kind: "kpi", component: Finance.FinanceRevenue30dCard },
  { id: "finance.failed_payments", module: "Finance", page: "Revenue", title: "Failed payments", description: "Number of failed payments.", kind: "kpi", component: Finance.FinanceFailedPaymentsCard },
  { id: "finance.mrr_movement", module: "Finance", page: "MRR Movement", title: "MRR movement", description: "Daily MRR snapshots bar chart.", kind: "chart", component: Finance.FinanceMrrMovementChart },
  { id: "finance.recent_revenue", module: "Finance", page: "Revenue", title: "Recent revenue events", description: "Latest revenue records table.", kind: "table", component: Finance.FinanceRecentRevenueTable },
  { id: "finance.customers", module: "Finance", page: "Customers", title: "Customers", description: "Stripe customers table.", kind: "table", component: Finance.FinanceCustomersTable },

  /* ===================== Users / Engagement ===================== */
  { id: "users.events_tracked", module: "Users", page: "Engagement", title: "Events tracked", description: "Total product events tracked.", kind: "kpi", component: Engagement.EngagementEventsTrackedCard },
  { id: "users.active_users_7d", module: "Users", page: "Engagement", title: "Active users (7d)", description: "Unique active users over 7 days.", kind: "kpi", component: Engagement.EngagementActiveUsersCard },
  { id: "users.top_event", module: "Users", page: "Engagement", title: "Top event", description: "Most frequent product event.", kind: "kpi", component: Engagement.EngagementTopEventCard },
  { id: "users.events_per_day", module: "Users", page: "Engagement", title: "Events / day (14d)", description: "Daily events bar chart.", kind: "chart", component: Engagement.EngagementEventsPerDayChart },
  { id: "users.top_events", module: "Users", page: "Engagement", title: "Top events", description: "Top events ranked list.", kind: "list", component: Engagement.EngagementTopEventsList },
  { id: "users.recent_events", module: "Users", page: "Engagement", title: "Recent events", description: "Recent product events table.", kind: "table", component: Engagement.EngagementRecentEventsTable },

  /* ===================== Costs ===================== */
  { id: "costs.monthly_recurring", module: "Costs", page: "Overview", title: "Monthly recurring", description: "Normalized monthly recurring cost.", kind: "kpi", component: Costs.CostsMonthlyRecurringCard },
  { id: "costs.total", module: "Costs", page: "Overview", title: "Total (recorded)", description: "Sum of recorded costs.", kind: "kpi", component: Costs.CostsTotalCard },
  { id: "costs.last_30d", module: "Costs", page: "Overview", title: "Last 30 days", description: "Cost recorded in last 30 days.", kind: "kpi", component: Costs.CostsLast30dCard },
  { id: "costs.llm", module: "Costs", page: "Overview", title: "LLM cost (est.)", description: "Estimated LLM spend.", kind: "kpi", component: Costs.CostsLlmCard },
  { id: "costs.by_category", module: "Costs", page: "Overview", title: "Spend by category", description: "Cost breakdown bars by category.", kind: "chart", component: Costs.CostsByCategoryChart },
  { id: "costs.recent_expenses", module: "Costs", page: "Overview", title: "Recent expenses", description: "Recent cost records table.", kind: "table", component: Costs.CostsRecentExpensesTable },

  /* ===================== Security ===================== */
  { id: "security.code_health", module: "Security", page: "Findings", title: "Code health", description: "Latest code health score.", kind: "kpi", component: Security.SecurityCodeHealthCard },
  { id: "security.critical_risks", module: "Security", page: "Findings", title: "Critical risks", description: "Count of critical risks.", kind: "kpi", component: Security.SecurityCriticalRisksCard },
  { id: "security.high_risks", module: "Security", page: "Findings", title: "High risks", description: "Count of high risks.", kind: "kpi", component: Security.SecurityHighRisksCard },
  { id: "security.static_findings", module: "Security", page: "Findings", title: "Static findings", description: "Static scan findings list.", kind: "list", component: Security.SecurityStaticFindingsList },
  { id: "security.ai_risks", module: "Security", page: "Findings", title: "AI-detected risks", description: "AI risk analysis list.", kind: "list", component: Security.SecurityAiRisksList },

  /* ===================== Health ===================== */
  { id: "health.overall", module: "Health", page: "Status", title: "Overall status", description: "Overall health status card.", kind: "kpi", component: Health.HealthOverallCard },
  { id: "health.connectors", module: "Health", page: "Status", title: "Connectors OK", description: "Connected vs total connectors.", kind: "kpi", component: Health.HealthConnectorsCard },
  { id: "health.failed_scans", module: "Health", page: "Status", title: "Failed scans (recent)", description: "Recent failed scan jobs.", kind: "kpi", component: Health.HealthFailedScansCard },
  { id: "health.open_incidents", module: "Health", page: "Status", title: "Open incidents", description: "Unresolved incidents count.", kind: "kpi", component: Health.HealthOpenIncidentsCard },
  { id: "health.p50_latency", module: "Health", page: "Performance", title: "p50 scan latency", description: "Median scan latency.", kind: "kpi", component: Health.HealthP50LatencyCard },
  { id: "health.p95_latency", module: "Health", page: "Performance", title: "p95 scan latency", description: "95th percentile scan latency.", kind: "kpi", component: Health.HealthP95LatencyCard },
  { id: "health.recent_errors", module: "Health", page: "Errors", title: "Errors", description: "Recent deduped error events.", kind: "list", component: Health.HealthRecentErrorsList },
];

const BY_ID = new Map(MODULE_WIDGETS.map((w) => [w.id, w]));

export function getModuleWidget(id: string | undefined): ModuleWidgetEntry | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function moduleWidgetDefaultSize(id: string | undefined): { w: number; h: number } {
  const entry = getModuleWidget(id);
  return entry ? DEFAULT_SIZE_BY_KIND[entry.kind] : { w: 4, h: 3 };
}

/** Group widgets by module, in a stable display order. */
export const MODULE_ORDER: ModuleName[] = ["Finance", "Users", "Costs", "Security", "Health"];

export function groupedModuleWidgets(): { module: ModuleName; widgets: ModuleWidgetEntry[] }[] {
  return MODULE_ORDER.map((module) => ({
    module,
    widgets: MODULE_WIDGETS.filter((w) => w.module === module),
  })).filter((g) => g.widgets.length > 0);
}

/** Map the widget kind to the WidgetType stored on the dashboard widget row.
 *  All module widgets use the dedicated "module" type — this is for callers
 *  that need a representative icon. */
export function moduleWidgetIconType(id: string | undefined): WidgetType {
  const entry = getModuleWidget(id);
  if (!entry) return "module";
  switch (entry.kind) {
    case "kpi": return "kpi";
    case "chart": return "bar";
    case "table": return "table";
    case "list": return "table";
    default: return "module";
  }
}
