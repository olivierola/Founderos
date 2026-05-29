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
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";

const AGENT_COLORS = ["#001BB7", "#2F2FE4", "#7c3aed", "#db2777", "#e11d48", "#ea580c", "#16a34a", "#0891b2", "#475569"];

interface Agent {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  accent_color: string | null;
  created_at: string;
}

export function RagAgentsPage() {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(AGENT_COLORS[0]);
  const [creating, setCreating] = useState(false);

  async function createAgent() {
    if (!workspaceId || !projectId || !newName.trim()) return;
    setCreating(true);
    try {
      const { data } = await supabase
        .from("rag_agents")
        .insert({ workspace_id: workspaceId, project_id: projectId, name: newName.trim(), accent_color: newColor })
        .select("id")
        .single();
      queryClient.invalidateQueries({ queryKey: ["rag_agents", projectId] });
      setCreateOpen(false);
      setNewName("");
      setNewColor(AGENT_COLORS[0]);
      if (data) navigate(`/app/${workspaceSlug}/${projectSlug}/agent/builder/${data.id}/playground`);
    } finally {
      setCreating(false);
    }
  }

  const { data: agents, isLoading } = useQuery({
    queryKey: ["rag_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("rag_agents")
        .select("id, name, description, enabled, accent_color, created_at")
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
          {agents.map((a) => {
            const color = a.accent_color || "#001BB7";
            return (
              <Card
                key={a.id}
                className="group relative cursor-pointer overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg"
                style={{ borderColor: undefined }}
                onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/agent/builder/${a.id}/playground`)}
              >
                {/* Accent strip */}
                <div className="absolute inset-x-0 top-0 h-1 transition-all duration-200 group-hover:h-1.5" style={{ background: color }} />
                <CardContent className="relative p-5">
                  <div className="flex items-start justify-between">
                    <div
                      className="flex h-11 w-11 items-center justify-center rounded-md transition-transform duration-200 group-hover:scale-105"
                      style={{ background: `${color}26` }}
                    >
                      <Bot className="h-5 w-5" style={{ color }} />
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
                    <ChevronRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                  </div>

                  {/* Hover-reveal extra info */}
                  <div className="grid grid-rows-[0fr] overflow-hidden transition-all duration-300 group-hover:grid-rows-[1fr] group-hover:pt-3">
                    <div className="min-h-0">
                      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                        <Badge variant="outline" style={{ borderColor: `${color}66`, color }}>{a.enabled ? "Live" : "Disabled"}</Badge>
                        <span>Created {new Date(a.created_at).toLocaleDateString()}</span>
                        <span className="ml-auto font-medium text-foreground">Open →</span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={(o) => { if (!o) setCreateOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New RAG agent</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium">Agent name</label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createAgent()}
                placeholder="Support assistant"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium">Ambience color</label>
              <div className="flex flex-wrap items-center gap-2">
                {AGENT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewColor(c)}
                    className={`h-7 w-7 rounded-full transition-transform ${newColor === c ? "ring-2 ring-offset-2 ring-offset-card scale-110" : "hover:scale-105"}`}
                    style={{ background: c, boxShadow: newColor === c ? `0 0 0 2px ${c}` : undefined }}
                    aria-label={c}
                  />
                ))}
                <label className="relative ml-1 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-dashed border-border" title="Custom color">
                  <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                  <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} className="absolute h-7 w-7 cursor-pointer opacity-0" />
                </label>
              </div>
            </div>
            {/* Live preview */}
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="h-1" style={{ background: newColor }} />
              <div className="flex items-center gap-2 p-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-md" style={{ background: `${newColor}26` }}>
                  <Bot className="h-4 w-4" style={{ color: newColor }} />
                </div>
                <span className="text-sm font-medium">{newName.trim() || "Agent name"}</span>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button onClick={createAgent} disabled={creating || !newName.trim()}>
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
