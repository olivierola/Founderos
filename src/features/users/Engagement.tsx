import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Plus, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface EventRow {
  id: string;
  event_name: string;
  customer_external_id: string | null;
  user_email: string | null;
  properties: Record<string, unknown>;
  occurred_at: string;
}

export function EngagementPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [eventName, setEventName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [emitting, setEmitting] = useState(false);

  const { data: events } = useQuery({
    queryKey: ["product_events", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("product_events")
        .select("*")
        .eq("project_id", projectId!)
        .order("occurred_at", { ascending: false })
        .limit(200);
      return (data ?? []) as EventRow[];
    },
  });

  const stats = useMemo(() => {
    const list = events ?? [];
    const last7 = Date.now() - 7 * 86400_000;
    const byName = new Map<string, number>();
    const dau = new Set<string>();
    list.forEach((e) => {
      if (new Date(e.occurred_at).getTime() >= last7) {
        if (e.user_email) dau.add(e.user_email.toLowerCase());
      }
      byName.set(e.event_name, (byName.get(e.event_name) ?? 0) + 1);
    });
    return {
      total: list.length,
      uniqueUsers7d: dau.size,
      top: [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    };
  }, [events]);

  async function emit() {
    if (!workspaceId || !projectId || !eventName) return;
    setEmitting(true);
    try {
      await callEdge("track-event", {
        workspace_id: workspaceId,
        project_id: projectId,
        event_name: eventName,
        user_email: userEmail || undefined,
        properties: { source: "dashboard_test" },
      });
      setEventName("");
      setUserEmail("");
      queryClient.invalidateQueries({ queryKey: ["product_events", projectId] });
    } finally {
      setEmitting(false);
    }
  }

  // Daily timeseries last 14 days
  const series = useMemo(() => {
    const days = 14;
    const buckets: Record<string, number> = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      buckets[d] = 0;
    }
    (events ?? []).forEach((e) => {
      const d = e.occurred_at.slice(0, 10);
      if (d in buckets) buckets[d]++;
    });
    return Object.entries(buckets).sort((a, b) => a[0].localeCompare(b[0]));
  }, [events]);

  const max = Math.max(1, ...series.map(([, v]) => v));

  return (
    <div>
      <PageHeader
        title="Engagement"
        description="Native product event tracking — no PostHog needed. Use the API key in Integrations to ingest from your app."
        actions={
          <ExportMenu
            rows={(events ?? []).map((e) => ({
              when: e.occurred_at,
              event: e.event_name,
              user: e.user_email ?? e.customer_external_id,
            }))}
            filename="product-events"
          />
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Events tracked" value={String(stats.total)} icon={Activity} />
        <MetricCard label="Active users (7d)" value={String(stats.uniqueUsers7d)} />
        <MetricCard label="Top event" value={stats.top[0]?.[0] ?? "—"} hint={stats.top[0] ? `${stats.top[0][1]} events` : ""} />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" /> Emit a test event
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input placeholder="event_name (e.g. signup)" value={eventName} onChange={(e) => setEventName(e.target.value)} />
          <Input placeholder="user_email (optional)" value={userEmail} onChange={(e) => setUserEmail(e.target.value)} />
          <Button onClick={emit} disabled={emitting || !eventName}>
            {emitting && <Loader2 className="h-4 w-4 animate-spin" />} Emit
          </Button>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Events / day (14d)</CardTitle>
          </CardHeader>
          <CardContent>
            {series.every(([, v]) => v === 0) ? (
              <p className="text-sm text-muted-foreground">No events yet.</p>
            ) : (
              <div className="flex h-32 items-end gap-1">
                {series.map(([d, v]) => (
                  <div key={d} className="flex-1" title={`${d}: ${v}`}>
                    <div className="rounded-t bg-primary/60" style={{ height: `${Math.max(4, (v / max) * 120)}px` }} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top events</CardTitle>
          </CardHeader>
          <CardContent>
            {stats.top.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {stats.top.map(([name, count]) => (
                  <li key={name} className="flex items-center justify-between">
                    <span>{name}</span>
                    <Badge variant="secondary">{count}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {events && events.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Recent events</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Event</th>
                  <th className="px-4 py-3">User</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.slice(0, 25).map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(e.occurred_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-medium">{e.event_name}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {e.user_email ?? e.customer_external_id ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {(!events || events.length === 0) && (
        <EmptyState
          icon={Activity}
          title="No events yet"
          description="Emit a test event above, or ingest from your app via the track-event Edge Function."
        />
      )}
    </div>
  );
}
