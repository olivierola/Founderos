import { useState, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot, Plus, Loader2, ChevronRight, MessageSquare, Target, Wrench, Users as UsersIcon,
  Sparkles, Check, ShieldCheck, CalendarClock, Network,
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
import { STUDIO_LABELS, type AgentTemplate, type StudioKind } from "./agentTemplates";
import { instantiateTemplate, type TemplateOverrides } from "./instantiateTemplate";
import { TemplateDrawer } from "./TemplateDrawer";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { AgentCard as AgentCardShell, CHIP_COLORS, type AgentChip } from "./AgentCard";
import { AvatarPicker, AVATAR_OPTIONS } from "./AvatarPicker";

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
  avatar_style: "avatar" | "orb" | null;
  accent_color: string | null;
  created_by: string;
  created_at: string;
  chat_enabled: boolean;
  mission_enabled: boolean;
  service_dashboard_id: string | null;
  is_orchestrator: boolean;
  studio: StudioKind | null;
  swarm_enabled: boolean | null;
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

  const { data: allAgents, isLoading } = useQuery({
    queryKey: ["internal_agents", projectId, user?.id],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents")
        .select("id, name, description, avatar_emoji, avatar_url, avatar_style, accent_color, created_by, created_at, chat_enabled, mission_enabled, service_dashboard_id, is_orchestrator, studio, swarm_enabled")
        .eq("project_id", projectId!)
        .eq("is_archived", false)
        .order("created_at", { ascending: false });
      return (data ?? []) as InternalAgent[];
    },
  });
  // Orchestrators are per-dashboard default assistants — hidden from this overview.
  const agents = useMemo(() => (allAgents ?? []).filter((a) => !a.is_orchestrator), [allAgents]);

  // Service dashboards, so agents can be grouped by the service they belong to.
  const { data: dashboards } = useQuery({
    queryKey: ["service_dashboards_overview", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("service_dashboards")
        .select("id, name, color, position")
        .eq("project_id", projectId!)
        .order("position", { ascending: true });
      return (data ?? []) as Array<{ id: string; name: string; color: string | null; position: number }>;
    },
  });

  // Group agents by their service dashboard; unassigned agents go last.
  const groups = useMemo(() => {
    const byId = new Map<string, InternalAgent[]>();
    const unassigned: InternalAgent[] = [];
    for (const a of agents) {
      if (a.service_dashboard_id) {
        const arr = byId.get(a.service_dashboard_id) ?? [];
        arr.push(a); byId.set(a.service_dashboard_id, arr);
      } else unassigned.push(a);
    }
    const out: Array<{ id: string | null; name: string; color: string | null; agents: InternalAgent[] }> = [];
    for (const d of dashboards ?? []) {
      const list = byId.get(d.id);
      if (list && list.length) out.push({ id: d.id, name: d.name, color: d.color, agents: list });
    }
    if (unassigned.length) out.push({ id: null, name: "Sans service", color: null, agents: unassigned });
    return out;
  }, [agents, dashboards]);

  function openAgent(a: InternalAgent) {
    const dashId = a.service_dashboard_id;
    navigate(dashId
      ? `/app/${workspaceSlug}/${projectSlug}/service/${dashId}/agent/${a.id}`
      : `/app/${workspaceSlug}/${projectSlug}/agent/internal/${a.id}/chat`);
  }

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
        title="Agents par service"
        description="Vue d'ensemble de tous vos agents, regroupés par dashboard de service. Cliquez un agent pour ouvrir ses pages dans son service."
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
      ) : agents.length === 0 ? (
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
        <div className="space-y-8">
          {groups.map((g) => (
            <section key={g.id ?? "none"}>
              <div className="mb-3 flex items-center gap-2.5">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: g.color || "hsl(var(--muted-foreground))" }} />
                <h2 className="text-sm font-semibold">{g.name}</h2>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{g.agents.length}</span>
                {g.id && (
                  <button
                    onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/service/${g.id}/agents`)}
                    className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    Ouvrir le dashboard <ChevronRight className="h-3 w-3" />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 gap-[30px] sm:grid-cols-2 lg:grid-cols-3">
                {g.agents.map((a) => (
                  <AgentCard
                    key={a.id}
                    agent={a}
                    counts={counts?.[a.id]}
                    isMine={a.created_by === user?.id}
                    onOpen={() => openAgent(a)}
                  />
                ))}
              </div>
            </section>
          ))}
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

// Internal-agent card — the shared shell, fed with this list's own chips and
// counters. Identity is the agent's avatar OR floating orb, per avatar_style.
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
  const chips: AgentChip[] = [];
  if (agent.studio) chips.push({ icon: Sparkles, label: STUDIO_LABELS[agent.studio], color: CHIP_COLORS.studio });
  if (agent.chat_enabled) chips.push({ icon: MessageSquare, label: "Chat", color: CHIP_COLORS.chat });
  if (agent.mission_enabled) chips.push({ icon: Target, label: "Missions", color: CHIP_COLORS.missions });
  if (agent.swarm_enabled !== false)
    chips.push({
      icon: Network,
      label: "Essaim",
      color: CHIP_COLORS.accent,
      title: "Peut paralléliser en lançant plusieurs instances de lui-même",
    });

  return (
    <AgentCardShell
      // Studio agents keep the animated border they had as templates, so the
      // class of agent stays recognisable once it's live.
      className={cn(agent.studio && "studio-border")}
      onClick={onOpen}
      identity={
        <AgentIdentity style={agent.avatar_style} url={agent.avatar_url} seed={agent.name} size={56} rounded="rounded-xl" lightOrb />
      }
      name={agent.name}
      description={agent.description}
      chips={chips.slice(0, 2)}
      meta={
        <span className="flex items-center justify-end gap-2.5">
          <span className="inline-flex items-center gap-1" title="Missions"><Target className="h-3 w-3" /> {counts?.missions ?? 0}</span>
          <span className="inline-flex items-center gap-1" title="Tools & integrations"><Wrench className="h-3 w-3" /> {counts?.tools ?? 0}</span>
          <span className="inline-flex items-center gap-1" title="Members"><UsersIcon className="h-3 w-3" /> {counts?.members ?? 0}</span>
          {isMine && <span title="You own this agent">· Owner</span>}
        </span>
      }
    />
  );
}
