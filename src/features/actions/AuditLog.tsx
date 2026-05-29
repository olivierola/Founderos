import { useQuery } from "@tanstack/react-query";
import { ScrollText, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface LogRow {
  id: string;
  event_type: string;
  title: string | null;
  payload: Record<string, unknown>;
  actor_user_id: string | null;
  created_at: string;
}

export function AuditLogPage() {
  const { projectId } = useCurrentContext();
  const { data, isLoading } = useQuery({
    queryKey: ["audit_log", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("activity_logs")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(200);
      return (data ?? []) as LogRow[];
    },
  });

  return (
    <div>
      <PageHeader
        title="Audit Log"
        description="Full immutable record of every workspace action — scans, connectors, syncs, costs and admin actions."
        actions={
          <ExportMenu
            rows={(data ?? []).map((r) => ({
              when: r.created_at,
              event: r.event_type,
              title: r.title,
              actor: r.actor_user_id,
            }))}
            filename="audit-log"
          />
        }
      />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={ScrollText} title="No audit entries yet" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Event</th>
                  <th className="px-4 py-3">Title</th>
                  <th className="px-4 py-3">Actor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline">{r.event_type}</Badge>
                    </td>
                    <td className="px-4 py-3">{r.title ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {r.actor_user_id ? r.actor_user_id.slice(0, 8) : "system"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
