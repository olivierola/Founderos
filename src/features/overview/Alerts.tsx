import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface AlertRow {
  id: string;
  type: string;
  severity: "info" | "warning" | "high" | "critical";
  title: string;
  message: string | null;
  status: "open" | "acknowledged" | "resolved";
  created_at: string;
  resolved_at: string | null;
}

function sevVariant(s: string): "destructive" | "warning" | "secondary" {
  if (s === "critical" || s === "high") return "destructive";
  if (s === "warning") return "warning";
  return "secondary";
}

export function AlertsPage() {
  const { projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["alerts", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("alerts")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(100);
      return (data ?? []) as AlertRow[];
    },
  });

  async function updateStatus(id: string, status: "acknowledged" | "resolved") {
    await supabase
      .from("alerts")
      .update({ status, resolved_at: status === "resolved" ? new Date().toISOString() : null })
      .eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["alerts", projectId] });
  }

  return (
    <div>
      <PageHeader title="Alerts" description="Operational and security alerts raised across the project." />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading alerts…" />
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="All clear"
          description="No alerts have been raised yet. They will appear here when budgets exceed thresholds, scans fail, or CVEs are detected."
        />
      ) : (
        <div className="space-y-2">
          {data.map((a) => (
            <Card key={a.id}>
              <CardContent className="flex items-start gap-3 p-4">
                <AlertCircle
                  className={
                    a.severity === "critical" || a.severity === "high"
                      ? "h-5 w-5 text-destructive"
                      : a.severity === "warning"
                        ? "h-5 w-5 text-amber-400"
                        : "h-5 w-5 text-muted-foreground"
                  }
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{a.title}</span>
                    <Badge variant={sevVariant(a.severity)}>{a.severity}</Badge>
                    <Badge variant={a.status === "open" ? "warning" : "secondary"}>{a.status}</Badge>
                  </div>
                  {a.message && <p className="mt-1 text-sm text-muted-foreground">{a.message}</p>}
                  <div className="mt-1 text-xs text-muted-foreground">
                    {new Date(a.created_at).toLocaleString()} · {a.type}
                  </div>
                </div>
                {a.status === "open" && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => updateStatus(a.id, "acknowledged")}>
                      Acknowledge
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => updateStatus(a.id, "resolved")}>
                      <CheckCircle2 className="h-4 w-4" /> Resolve
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
