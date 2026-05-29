import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Plus, Loader2, MoreVertical, Trash2, ChevronRight, MessageSquare } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/EmptyState";
import { PromptDialog } from "@/components/PromptDialog";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface Agent {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  created_at: string;
}

export function RagAgentsPage() {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: agents, isLoading } = useQuery({
    queryKey: ["rag_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("rag_agents")
        .select("id, name, description, enabled, created_at")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as Agent[];
    },
  });

  // Per-agent source/conversation counts.
  const { data: counts } = useQuery({
    queryKey: ["rag_agent_counts", (agents ?? []).map((a) => a.id).sort()],
    enabled: !!agents && agents.length > 0,
    queryFn: async () => {
      const out: Record<string, { sources: number; convos: number }> = {};
      await Promise.all(
        (agents ?? []).map(async (a) => {
          const [s, c] = await Promise.all([
            supabase.from("rag_sources").select("id", { count: "exact", head: true }).eq("agent_id", a.id),
            supabase.from("rag_conversations").select("id", { count: "exact", head: true }).eq("agent_id", a.id),
          ]);
          out[a.id] = { sources: s.count ?? 0, convos: c.count ?? 0 };
        }),
      );
      return out;
    },
  });

  async function remove(id: string) {
    await supabase.from("rag_agents").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["rag_agents", projectId] });
  }

  return (
    <div>
      <PageHeader
        title="RAG Agents"
        description="Create AI agents grounded in your knowledge base and your SaaS structure. Embed them as a widget for your users."
        actions={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> New agent</Button>}
      />

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !agents || agents.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No agents yet"
          description="Create your first RAG agent, add knowledge sources (text, URLs, your SaaS structure), and embed it."
          action={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> New agent</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <Card
              key={a.id}
              className="group cursor-pointer transition-colors hover:border-primary/40"
              onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/agent/builder/${a.id}`)}
            >
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex h-11 w-11 items-center justify-center rounded-md bg-secondary">
                    <Bot className="h-5 w-5 text-primary" />
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem destructive onClick={() => remove(a.id)}>
                          <Trash2 className="h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                <div className="mt-4">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{a.name}</span>
                    {!a.enabled && <Badge variant="secondary">disabled</Badge>}
                  </div>
                  {a.description && <div className="truncate text-xs text-muted-foreground">{a.description}</div>}
                </div>
                <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-2">
                    {counts?.[a.id]?.sources ?? 0} sources
                    <span className="flex items-center gap-1"><MessageSquare className="h-3 w-3" /> {counts?.[a.id]?.convos ?? 0}</span>
                  </span>
                  <ChevronRight className="h-4 w-4" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <PromptDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New RAG agent"
        label="Agent name"
        placeholder="Support assistant"
        confirmText="Create"
        onSubmit={async (name) => {
          if (!workspaceId || !projectId) return;
          const { data } = await supabase
            .from("rag_agents")
            .insert({ workspace_id: workspaceId, project_id: projectId, name })
            .select("id")
            .single();
          queryClient.invalidateQueries({ queryKey: ["rag_agents", projectId] });
          if (data) navigate(`/app/${workspaceSlug}/${projectSlug}/agent/builder/${data.id}`);
        }}
      />
    </div>
  );
}
