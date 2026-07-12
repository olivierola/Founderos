import { useState, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot, Plus, Loader2, ChevronRight, MessageSquare, Target, Wrench, Users as UsersIcon,
  Sparkles, Check, ShieldCheck, CalendarClock,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { type AgentTemplate } from "./agentTemplates";
import { instantiateTemplate, type TemplateOverrides } from "./instantiateTemplate";
import { TemplateDrawer } from "./TemplateDrawer";
import { cn } from "@/lib/utils";
import { PixelField } from "./PixelField";
import { AvatarPicker, AgentAvatar, AVATAR_OPTIONS } from "./AvatarPicker";

const ACCENT_COLORS = [
  "#2F2FE4", "#7c3aed", "#db2777", "#e11d48",
  "#ea580c", "#16a34a", "#0891b2", "#475569",
];

interface InternalAgent {
  id: string;
  name: string;
  description: string | null;
  avatar_emoji: string | null;
  avatar_url: string | null;
  accent_color: string | null;
  created_by: string;
  created_at: string;
  chat_enabled: boolean;
  mission_enabled: boolean;
}

export function InternalAgentsListPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newAvatar, setNewAvatar] = useState<string | null>(AVATAR_OPTIONS[0]);
  const [newColor, setNewColor] = useState(ACCENT_COLORS[0]);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  async function activateTemplate(t: AgentTemplate, overrides: TemplateOverrides) {
    if (!workspaceId || !projectId || !user) return;
    const id = await instantiateTemplate(t, { workspaceId, projectId, userId: user.id }, overrides);
    queryClient.invalidateQueries({ queryKey: ["internal_agents", projectId] });
    setTemplatesOpen(false);
    navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal/${id}/chat`);
  }

  const { data: agents, isLoading } = useQuery({
    queryKey: ["internal_agents", projectId, user?.id],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents")
        .select("id, name, description, avatar_emoji, avatar_url, accent_color, created_by, created_at, chat_enabled, mission_enabled")
        .eq("project_id", projectId!)
        .eq("is_archived", false)
        .order("created_at", { ascending: false });
      return (data ?? []) as InternalAgent[];
    },
  });

  // Per-agent counts (missions, members, tools) for grid badges.
  const ids = (agents ?? []).map((a) => a.id);
  const { data: counts } = useQuery({
    queryKey: ["internal_agents_counts", ids.sort().join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const out: Record<string, { missions: number; members: number; tools: number }> = {};
      await Promise.all(
        ids.map(async (id) => {
          const [m, mb, tl] = await Promise.all([
            supabase.from("internal_agent_missions").select("id", { count: "exact", head: true }).eq("agent_id", id),
            supabase.from("internal_agent_members").select("id", { count: "exact", head: true }).eq("agent_id", id),
            supabase.from("internal_agent_tools").select("id", { count: "exact", head: true }).eq("agent_id", id),
          ]);
          out[id] = { missions: m.count ?? 0, members: mb.count ?? 0, tools: tl.count ?? 0 };
        }),
      );
      return out;
    },
  });

  async function createAgent() {
    if (!workspaceId || !projectId || !user || !newName.trim()) return;
    setCreating(true);
    try {
      const { data, error } = await supabase
        .from("internal_agents")
        .insert({
          workspace_id: workspaceId,
          project_id: projectId,
          name: newName.trim(),
          description: newDescription.trim() || null,
          avatar_emoji: null,
          avatar_url: newAvatar,
          accent_color: newColor,
          created_by: user.id,
        })
        .select("id")
        .single();
      if (error) throw error;
      queryClient.invalidateQueries({ queryKey: ["internal_agents", projectId] });
      setCreateOpen(false);
      setNewName("");
      setNewDescription("");
      setNewAvatar(AVATAR_OPTIONS[0]);
      setNewColor(ACCENT_COLORS[0]);
      if (data) navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal/${data.id}/chat`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Internal agents"
        description="Build internal AI collaborators for your team. Give them instructions, tools, and missions."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setTemplatesOpen(true)} className="gap-1.5">
              <Sparkles className="h-4 w-4" /> Browse templates
            </Button>
            <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" /> New agent
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : !agents || agents.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No internal agents yet"
          description="Internal agents are private AI workers for your team — they chat, run missions, and produce deliverables."
          action={
            <div className="flex items-center gap-2">
              <Button onClick={() => setTemplatesOpen(true)} className="gap-1.5">
                <Sparkles className="h-4 w-4" /> Start from a template
              </Button>
              <Button variant="outline" onClick={() => setCreateOpen(true)} className="gap-1.5">
                <Plus className="h-4 w-4" /> Blank agent
              </Button>
            </div>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {agents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              counts={counts?.[a.id]}
              isMine={a.created_by === user?.id}
              onOpen={() => navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal/${a.id}/chat`)}
            />
          ))}
          <button
            onClick={() => setCreateOpen(true)}
            className="group flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-dashed border-current transition-transform group-hover:scale-110">
              <Plus className="h-6 w-6" />
            </span>
            <span className="text-sm font-medium">Nouvel agent</span>
          </button>
        </div>
      )}

      {/* Templates browser + config stepper in a right-side full-height drawer. */}
      <TemplateDrawer open={templatesOpen} onClose={() => setTemplatesOpen(false)} onActivate={activateTemplate} />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New internal agent</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Research analyst"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Description (optional)</label>
              <Input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="What does this agent do?"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Avatar</label>
              <AvatarPicker value={newAvatar} onChange={setNewAvatar} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Accent</label>
              <div className="flex flex-wrap gap-1.5">
                {ACCENT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewColor(c)}
                    className={`h-7 w-7 rounded-full ${newColor === c ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : ""}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button onClick={createAgent} disabled={creating || !newName.trim()}>
                {creating && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Agent card: animated pixel field (accent-coloured, intensifies on hover) +
// the chosen avatar + basic info.
function AgentCard({
  agent,
  counts,
  isMine,
  onOpen,
}: {
  agent: InternalAgent;
  counts?: { missions: number; members: number; tools: number };
  isMine: boolean;
  onOpen: () => void;
}) {
  const [hover, setHover] = useState(false);
  const accent = agent.accent_color ?? "#2F2FE4";
  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="group relative cursor-pointer overflow-hidden rounded-2xl border bg-card transition-all duration-300 hover:-translate-y-0.5"
      style={{
        borderColor: hover ? accent : "hsl(var(--border))",
        boxShadow: hover ? `0 16px 40px -16px ${accent}66` : undefined,
      }}
    >
      <PixelField accent={accent} active={hover} />
      {/* Legibility veil over the pixel field (lets dots glow through, more on hover). */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-card via-card/80 to-card/40 transition-opacity duration-300 group-hover:opacity-90" />

      <div className="relative z-10 p-4">
        <div className="mb-3 flex items-start justify-between">
          <div
            className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl shadow-sm ring-2 ring-card"
            style={{ outline: `1.5px solid ${accent}66` }}
          >
            <AgentAvatar url={agent.avatar_url} seed={agent.name} className="h-full w-full" />
          </div>
          {isMine && <Badge variant="outline" className="shrink-0 text-[10px]">Owner</Badge>}
        </div>

        <div className="flex items-center gap-2">
          <h3 className="truncate font-semibold leading-tight">{agent.name}</h3>
        </div>
        <p className="mt-1 line-clamp-2 min-h-[2rem] text-xs text-muted-foreground">
          {agent.description || "No description"}
        </p>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {agent.chat_enabled && (
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              <MessageSquare className="h-3 w-3" /> Chat
            </span>
          )}
          {agent.mission_enabled && (
            <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Target className="h-3 w-3" /> Missions
            </span>
          )}
        </div>

        <div className="mt-3 flex items-center gap-4 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1" title="Missions"><Target className="h-3 w-3" /> {counts?.missions ?? 0}</span>
          <span className="inline-flex items-center gap-1" title="Tools & integrations"><Wrench className="h-3 w-3" /> {counts?.tools ?? 0}</span>
          <span className="inline-flex items-center gap-1" title="Members"><UsersIcon className="h-3 w-3" /> {counts?.members ?? 0}</span>
          <span className="ml-auto inline-flex items-center gap-1 font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
            Open <ChevronRight className="h-3 w-3" />
          </span>
        </div>
      </div>
    </div>
  );
}
