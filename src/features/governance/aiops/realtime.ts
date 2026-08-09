// Shared Supabase Realtime glue for the AI Ops module.
// Subscribes to postgres_changes on a publication-enabled table and hands each
// event to a callback (invalidate a query, append to a list…). The table must
// be in the supabase_realtime publication (see 0180_aiops_realtime_costs.sql)
// and the caller must be able to SELECT the row — RLS applies per event.
import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";

export interface RealtimeRowChange {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  newRow: Record<string, unknown> | null;
  oldRow: Record<string, unknown> | null;
}

/**
 * Subscribe to realtime changes on `table`, filtered with a postgres filter
 * string (e.g. `project_id=eq.<uuid>` or `agent_id=in.(a,b)`). Channel name is
 * unique per mount so several instances can watch the same table.
 */
export function usePostgresChanges(opts: {
  table: string;
  filter: string;
  onEvent: (c: RealtimeRowChange) => void;
  enabled?: boolean;
}) {
  const { table, filter, enabled = true } = opts;
  const cbRef = useRef(opts.onEvent);
  cbRef.current = opts.onEvent;
  const chanId = useRef(Math.random().toString(36).slice(2)).current;

  useEffect(() => {
    if (!enabled) return;
    const channel = supabase
      .channel(`pg:${table}:${chanId}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table,
        filter,
      }, (payload) => {
        cbRef.current({
          eventType: payload.eventType as RealtimeRowChange["eventType"],
          newRow: (payload.new as Record<string, unknown>) ?? null,
          oldRow: (payload.old as Record<string, unknown>) ?? null,
        });
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [table, filter, enabled, chanId]);
}
