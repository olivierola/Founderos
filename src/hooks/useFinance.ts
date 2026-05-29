import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export interface FinanceMetrics {
  mrr_cents: number;
  arr_cents: number;
  arpu_cents: number;
  currency: string;
  active_subscriptions: number;
  paying_subscriptions: number;
  churn_rate_30d: number;
  canceled_last_30d: number;
  customers: number;
  total_revenue_cents: number;
  revenue_last_30d_cents: number;
  failed_payments: number;
  computed_at: string;
}

export function useLatestMetrics(projectId: string | null) {
  return useQuery({
    queryKey: ["metrics-latest", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("metrics_snapshots")
        .select("metrics, snapshot_date")
        .eq("project_id", projectId!)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!data) return null;
      return { date: data.snapshot_date as string, metrics: data.metrics as FinanceMetrics };
    },
  });
}

export function useMetricsHistory(projectId: string | null, days = 30) {
  return useQuery({
    queryKey: ["metrics-history", projectId, days],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("metrics_snapshots")
        .select("metrics, snapshot_date")
        .eq("project_id", projectId!)
        .order("snapshot_date", { ascending: false })
        .limit(days);
      return (data ?? []).reverse() as { snapshot_date: string; metrics: FinanceMetrics }[];
    },
  });
}

export function useStripeConnector(projectId: string | null) {
  return useQuery({
    queryKey: ["connector", "stripe", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("connectors")
        .select("*")
        .eq("project_id", projectId!)
        .eq("provider", "stripe")
        .maybeSingle();
      return data;
    },
  });
}
