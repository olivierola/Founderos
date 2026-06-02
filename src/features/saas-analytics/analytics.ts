// Shared types + data hooks for the event-analytics pages (Events, Funnels,
// Cohorts). All heavy aggregation runs in the `analytics-query` edge function;
// the CRUD on definitions/funnels/cohorts goes straight through PostgREST (RLS
// scopes it to the caller's workspace).
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

// ── Types ─────────────────────────────────────────────────────────────────
export type EventCategory = "product" | "lifecycle" | "revenue" | "marketing" | "system" | "custom";

export interface PropertySpec {
  key: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
}

export interface EventDefinition {
  id: string;
  workspace_id: string;
  project_id: string;
  event_name: string;
  display_name: string | null;
  description: string | null;
  category: EventCategory;
  is_key_action: boolean;
  property_schema: PropertySpec[];
  created_at: string;
  updated_at: string;
}

export interface FunnelStep {
  event_name: string;
  label?: string;
}

export interface FunnelDef {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  description: string | null;
  steps: FunnelStep[];
  window_days: number;
  created_at: string;
}

export interface CohortDef {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  description: string | null;
  acquisition_event: string;
  return_event: string;
  period: "day" | "week" | "month";
  periods: number;
  created_at: string;
}

// ── Edge query result shapes ────────────────────────────────────────────────
export interface FunnelResult {
  ok: boolean;
  window_days: number;
  steps: Array<{
    event_name: string;
    count: number;
    pct_of_top: number;
    step_conversion: number;
    dropoff: number;
  }>;
}

export interface RetentionResult {
  ok: boolean;
  period: "day" | "week" | "month";
  periods: number;
  cohorts: Array<{ cohort: string; size: number; retained: number[]; pct: number[] }>;
}

export interface BreakdownResult {
  ok: boolean;
  events: Array<{ event_name: string; events: number; users: number; last_seen: string }>;
}

export interface TrendsResult {
  ok: boolean;
  period: "day" | "week" | "month";
  series: Array<{ bucket: string; events: number; users: number }>;
}

export interface SummaryResult {
  ok: boolean;
  total_events: number;
  distinct_events: number;
  active_users: number;
  active_1d: number;
  active_7d: number;
  active_30d: number;
}

export const CATEGORY_META: Record<EventCategory, { label: string; tone: string }> = {
  product: { label: "Product", tone: "text-sky-400" },
  lifecycle: { label: "Lifecycle", tone: "text-violet-400" },
  revenue: { label: "Revenue", tone: "text-emerald-400" },
  marketing: { label: "Marketing", tone: "text-fuchsia-400" },
  system: { label: "System", tone: "text-slate-400" },
  custom: { label: "Custom", tone: "text-amber-400" },
};

// ── Hooks ─────────────────────────────────────────────────────────────────
export function useEventDefinitions() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["event_definitions", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("event_definitions")
        .select("*")
        .eq("project_id", projectId!)
        .order("category", { ascending: true })
        .order("event_name", { ascending: true });
      return (data ?? []) as EventDefinition[];
    },
  });
}

export function useFunnels() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["analytics_funnels", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("analytics_funnels")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as FunnelDef[];
    },
  });
}

export function useCohortDefs() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["analytics_cohorts", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("analytics_cohorts")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as CohortDef[];
    },
  });
}

// Distinct event names seen in the raw stream — used to seed pickers even when
// no definition exists yet. Cheap breakdown query, capped server-side.
export function useObservedEventNames() {
  const { workspaceId, projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["observed_event_names", projectId],
    enabled: !!workspaceId && !!projectId,
    queryFn: async () => {
      const res = await callEdge<BreakdownResult>("analytics-query", {
        workspace_id: workspaceId,
        project_id: projectId,
        kind: "breakdown",
        limit: 200,
      });
      return res.events.map((e) => e.event_name);
    },
  });
}

// Merge declared definitions + observed names into one sorted, de-duplicated
// list of pickable event names.
export function mergeEventNames(defs: EventDefinition[], observed: string[]): string[] {
  const set = new Set<string>();
  defs.forEach((d) => set.add(d.event_name));
  observed.forEach((n) => set.add(n));
  return [...set].sort();
}
