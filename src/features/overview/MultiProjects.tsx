import { useQuery } from "@tanstack/react-query";
import { Boxes, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  health_score: number;
  description: string | null;
  created_at: string;
}

export function MultiProjectsPage() {
  const { workspaceId } = useCurrentContext();
  const { data, isLoading } = useQuery({
    queryKey: ["all_projects", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase
        .from("projects")
        .select("*")
        .eq("workspace_id", workspaceId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as ProjectRow[];
    },
  });

  return (
    <div>
      <PageHeader
        title="Multi-projects"
        description="All projects in this workspace. Switch context from the URL or workspace switcher."
      />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Boxes} title="No projects" description="A default project is created when you sign up." />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {data.map((p) => (
            <Card key={p.id}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-secondary">
                      <Boxes className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="font-medium">{p.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{p.slug}</div>
                    </div>
                  </div>
                  <Badge variant={p.health_score >= 70 ? "success" : p.health_score >= 40 ? "warning" : "destructive"}>
                    {p.health_score}/100
                  </Badge>
                </div>
                {p.description && <p className="mt-3 text-sm text-muted-foreground">{p.description}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
