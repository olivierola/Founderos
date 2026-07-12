import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Plus, Loader2, MoreVertical, Trash2, ChevronRight, MessageSquare, Globe } from "lucide-react";
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
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { PUBLIC_AGENT_PRESETS, type PublicAgentPreset } from "./publicAgentPresets";

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
  const { user } = useAuth();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [preset, setPreset] = useState<PublicAgentPreset>(PUBLIC_AGENT_PRESETS[0]);
  const [newName, setNewName] = useState(PUBLIC_AGENT_PRESETS[0].defaultName);
  const [creating, setCreating] = useState(false);

  function openCreate() {
    const first = PUBLIC_AGENT_PRESETS[0];
    setPreset(first);
    setNewName(first.defaultName);
    setCreateOpen(true);
  }

  function choosePreset(p: PublicAgentPreset) {
    setPreset(p);
    // Only overwrite the name when the user hasn't typed a custom one.
    setNewName((cur) => (PUBLIC_AGENT_PRESETS.some((x) => x.defaultName === cur) ? p.defaultName : cur));
  }

  async function createAgent() {
    if (!workspaceId || !projectId || !newName.trim()) return;
    setCreating(true);
    try {
      const { seed } = preset;
      const { data } = await supabase
        .from("rag_agents")
        .insert({
          workspace_id: workspaceId,
          project_id: projectId,
          created_by: user?.id ?? null,
          name: newName.trim(),
          description: seed.description || null,
          persona: seed.persona || null,
          instructions: seed.instructions || null,
          welcome_message: seed.welcome_message,
          onboarding_enabled: seed.onboarding_enabled,
          widget_config: seed.widget_config,
          accent_color: preset.accent,
        })
        .select("id")
        .single();
      queryClient.invalidateQueries({ queryKey: ["rag_agents", projectId] });
      setCreateOpen(false);
      // Land on Knowledge — a fresh public agent is only useful once it's fed.
      if (data) navigate(`/app/${workspaceSlug}/${projectSlug}/agent/builder/${data.id}/knowledge`);
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
        title="Agents publics"
        description="Des agents destinés au grand public de votre organisation — SAV, e-commerce, renseignements & onboarding. Nourris par votre base de connaissances, intégrables en widget sur n'importe quel site."
        actions={<Button onClick={openCreate}><Plus className="h-4 w-4" /> Nouvel agent</Button>}
      />

      {isLoading ? (
        <EmptyState icon={Loader2} title="Chargement…" />
      ) : !agents || agents.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="Aucun agent public pour l'instant"
          description="Créez un agent orienté client (SAV, e-commerce, guide, onboarding), ajoutez des sources de connaissance, puis intégrez-le en widget sur votre site."
          action={<Button onClick={openCreate}><Plus className="h-4 w-4" /> Nouvel agent</Button>}
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
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Nouvel agent public</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium">Partir d'un cas d'usage</label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {PUBLIC_AGENT_PRESETS.map((p) => {
                  const active = p.key === preset.key;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => choosePreset(p)}
                      className={cn(
                        "flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
                        active ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:border-primary/40 hover:bg-secondary/40",
                      )}
                    >
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-base"
                        style={{ background: `${p.accent}26` }}
                      >
                        {p.emoji}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{p.label}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{p.tagline}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium">Nom de l'agent</label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createAgent()}
                placeholder={preset.defaultName}
                autoFocus
              />
            </div>

            {/* Live preview */}
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="h-1" style={{ background: preset.accent }} />
              <div className="flex items-center gap-2 p-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-md text-base" style={{ background: `${preset.accent}26` }}>
                  {preset.emoji}
                </div>
                <span className="text-sm font-medium">{newName.trim() || preset.defaultName}</span>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>Annuler</Button>
              <Button onClick={createAgent} disabled={creating || !newName.trim()}>
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Créer
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
