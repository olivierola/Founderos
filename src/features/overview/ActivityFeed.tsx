import { useQuery } from "@tanstack/react-query";
import { Activity, GitBranch, KeyRound, Plug, RefreshCw, ScanLine, Sparkles, Wallet } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface LogRow {
  id: string;
  event_type: string;
  title: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

function eventIcon(type: string) {
  if (type.startsWith("scan.")) return ScanLine;
  if (type.startsWith("connector.")) return Plug;
  if (type.startsWith("stripe.")) return RefreshCw;
  if (type.startsWith("cost.")) return Wallet;
  if (type.startsWith("ai.")) return Sparkles;
  if (type.startsWith("auth.")) return KeyRound;
  if (type.startsWith("repo.")) return GitBranch;
  return Activity;
}

export function ActivityFeedPage() {
  const { projectId } = useCurrentContext();
  const { data, isLoading } = useQuery({
    queryKey: ["activity_logs", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("activity_logs")
        .select("id, event_type, title, payload, created_at")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(100);
      return (data ?? []) as LogRow[];
    },
  });

  return (
    <div>
      <PageHeader
        title="Activity feed"
        description="Every meaningful event in this project."
        actions={
          <ExportMenu
            rows={(data ?? []).map((r) => ({ when: r.created_at, event: r.event_type, title: r.title }))}
            filename="activity-feed"
          />
        }
      />
      {isLoading ? (
        <EmptyState icon={Activity} title="Loading…" />
      ) : !data || data.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No activity yet"
          description="Run a scan, connect a provider or sync Stripe — events will show up here."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {data.map((r) => {
                const Icon = eventIcon(r.event_type);
                return (
                  <li key={r.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-secondary">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{r.title ?? r.event_type}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {new Date(r.created_at).toLocaleString()}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{r.event_type}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
