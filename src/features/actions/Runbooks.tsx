import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Sparkles, Loader2, Trash2, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface RunbookRow {
  id: string;
  title: string;
  category: string | null;
  generated_by_ai: boolean;
  steps: { title: string; description?: string; command?: string }[];
  created_at: string;
}

export function RunbooksPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [generating, setGenerating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["runbooks", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("runbooks")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as RunbookRow[];
    },
  });

  async function generate() {
    if (!workspaceId || !projectId || !title) return;
    setGenerating(true);
    try {
      await callEdge("generate-runbook", {
        workspace_id: workspaceId,
        project_id: projectId,
        title,
        category: "ops",
      });
      setTitle("");
      queryClient.invalidateQueries({ queryKey: ["runbooks", projectId] });
    } finally {
      setGenerating(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete runbook?")) return;
    await supabase.from("runbooks").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["runbooks", projectId] });
  }

  return (
    <div>
      <PageHeader
        title="Runbooks"
        description="Reusable AI-generated runbooks for incidents and operations."
      />

      <Card className="mb-6">
        <CardContent className="flex gap-2 p-4">
          <Input
            placeholder="Runbook title (e.g. 'Stripe webhook is failing')"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button onClick={generate} disabled={generating || !title}>
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Generate with AI
          </Button>
        </CardContent>
      </Card>

      {!data || data.length === 0 ? (
        <EmptyState icon={BookOpen} title="No runbooks yet" description="Generate one with AI above." />
      ) : (
        <div className="space-y-3">
          {data.map((rb) => {
            const open = expanded === rb.id;
            return (
              <Card key={rb.id}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <button
                      onClick={() => setExpanded(open ? null : rb.id)}
                      className="flex flex-1 items-center gap-2 text-left"
                    >
                      <ChevronRight className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`} />
                      <span className="font-medium">{rb.title}</span>
                      {rb.generated_by_ai && <Badge variant="default">AI</Badge>}
                      {rb.category && <Badge variant="outline">{rb.category}</Badge>}
                    </button>
                    <Button size="icon" variant="ghost" onClick={() => remove(rb.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {open && (
                    <ol className="mt-3 space-y-2 pl-6">
                      {(rb.steps ?? []).map((step, i) => (
                        <li key={i} className="rounded-md border border-border p-2 text-sm">
                          <div className="font-medium">
                            {i + 1}. {step.title}
                          </div>
                          {step.description && <p className="mt-1 text-xs text-muted-foreground">{step.description}</p>}
                          {step.command && (
                            <code className="mt-2 block overflow-x-auto rounded bg-background/40 p-2 font-mono text-xs">
                              {step.command}
                            </code>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
