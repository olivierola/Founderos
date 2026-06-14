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
import { AGENT_TEMPLATES, type AgentTemplate, type AgentCategory } from "./agentTemplates";
import { instantiateTemplate } from "./instantiateTemplate";

const ACCENT_COLORS = [
  "#2F2FE4", "#7c3aed", "#db2777", "#e11d48",
  "#ea580c", "#16a34a", "#0891b2", "#475569",
];
const EMOJIS = ["🤖", "🧠", "🛠️", "🎯", "📊", "✍️", "🔍", "📦", "💼", "⚡"];

interface InternalAgent {
  id: string;
  name: string;
  description: string | null;
  avatar_emoji: string | null;
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
  const [newEmoji, setNewEmoji] = useState(EMOJIS[0]);
  const [newColor, setNewColor] = useState(ACCENT_COLORS[0]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [activatingKey, setActivatingKey] = useState<string | null>(null);
  const [templateCat, setTemplateCat] = useState<AgentCategory | "All">("All");

  // Ordered categories present in the catalogue (for the filter bar).
  const templateCategories = useMemo(() => {
    const order: AgentCategory[] = [];
    for (const t of AGENT_TEMPLATES) if (!order.includes(t.category)) order.push(t.category);
    return order;
  }, []);
  const visibleTemplates = useMemo(
    () => (templateCat === "All" ? AGENT_TEMPLATES : AGENT_TEMPLATES.filter((t) => t.category === templateCat)),
    [templateCat],
  );

  async function activateTemplate(t: AgentTemplate) {
    if (!workspaceId || !projectId || !user) return;
    setActivatingKey(t.key);
    try {
      const id = await instantiateTemplate(t, { workspaceId, projectId, userId: user.id });
      queryClient.invalidateQueries({ queryKey: ["internal_agents", projectId] });
      setTemplatesOpen(false);
      navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal/${id}/chat`);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setActivatingKey(null);
    }
  }

  const { data: agents, isLoading } = useQuery({
    queryKey: ["internal_agents", projectId, user?.id],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents")
        .select("id, name, description, avatar_emoji, accent_color, created_by, created_at, chat_enabled, mission_enabled")
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
          avatar_emoji: newEmoji,
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
      setNewEmoji(EMOJIS[0]);
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
          {agents.map((a) => {
            const c = counts?.[a.id];
            const isMine = a.created_by === user?.id;
            return (
              <Card
                key={a.id}
                onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal/${a.id}/chat`)}
                className="group cursor-pointer transition-colors hover:border-foreground/30"
              >
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between">
                    <div
                      className="flex h-10 w-10 items-center justify-center rounded-md text-lg"
                      style={{ backgroundColor: (a.accent_color ?? "#2F2FE4") + "22", color: a.accent_color ?? undefined }}
                    >
                      {a.avatar_emoji ?? "🤖"}
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold leading-tight">{a.name}</h3>
                      {isMine && <Badge variant="outline" className="text-[10px]">Owner</Badge>}
                    </div>
                    {a.description ? (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{a.description}</p>
                    ) : (
                      <p className="mt-1 text-xs italic text-muted-foreground">No description</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    {a.chat_enabled && (
                      <span className="inline-flex items-center gap-1"><MessageSquare className="h-3 w-3" /> Chat</span>
                    )}
                    {a.mission_enabled && (
                      <span className="inline-flex items-center gap-1"><Target className="h-3 w-3" /> {c?.missions ?? 0} missions</span>
                    )}
                    <span className="inline-flex items-center gap-1"><Wrench className="h-3 w-3" /> {c?.tools ?? 0} tools</span>
                    <span className="inline-flex items-center gap-1"><UsersIcon className="h-3 w-3" /> {c?.members ?? 0} members</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Templates gallery — one-click, ready-to-run agents by category. */}
      <Dialog open={templatesOpen} onOpenChange={setTemplatesOpen}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> Agent templates
              <span className="text-xs font-normal text-muted-foreground">· {AGENT_TEMPLATES.length} ready-to-run</span>
            </DialogTitle>
          </DialogHeader>
          <p className="-mt-1 text-sm text-muted-foreground">
            Ready-to-run AI workers for any company. Activate one in a click — it comes with its
            instructions, tools and guardrails. Connect your tools and it starts working.
          </p>

          {/* Category filter */}
          <div className="-mx-1 flex flex-wrap gap-1.5 px-1">
            {(["All", ...templateCategories] as const).map((c) => (
              <button
                key={c}
                onClick={() => setTemplateCat(c)}
                className={
                  "rounded-full border px-2.5 py-1 text-xs transition-colors " +
                  (templateCat === c
                    ? "border-primary/50 bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground")
                }
              >
                {c}
              </button>
            ))}
          </div>

          <div className="mt-1 grid max-h-[60vh] grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
            {visibleTemplates.map((t) => (
              <div key={t.key} className="flex flex-col rounded-xl border border-border bg-card/40 p-4">
                <div className="flex items-start gap-3">
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-lg"
                    style={{ backgroundColor: t.accent + "22", color: t.accent }}
                  >
                    {t.emoji}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate font-semibold leading-tight">{t.name}</h3>
                      <Badge variant="outline" className="shrink-0 text-[10px]">{t.category}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t.tagline}</p>
                  </div>
                </div>

                <ul className="mt-3 space-y-1">
                  {t.outcomes.map((o) => (
                    <li key={o} className="flex items-start gap-1.5 text-xs text-foreground/80">
                      <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" /> {o}
                    </li>
                  ))}
                </ul>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
                    <Wrench className="h-3 w-3" /> {t.tools.length} tool{t.tools.length > 1 ? "s" : ""}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
                    <ShieldCheck className="h-3 w-3" /> {t.autonomy}
                  </span>
                  {t.suggestedSchedule && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
                      <CalendarClock className="h-3 w-3" /> {t.suggestedSchedule.label}
                    </span>
                  )}
                </div>

                <Button
                  size="sm"
                  className="mt-3 gap-1.5"
                  disabled={activatingKey === t.key}
                  onClick={() => activateTemplate(t)}
                >
                  {activatingKey === t.key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  Activate
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

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
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Avatar</label>
              <div className="flex flex-wrap gap-1.5">
                {EMOJIS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setNewEmoji(e)}
                    className={`flex h-8 w-8 items-center justify-center rounded text-base transition-colors ${
                      newEmoji === e ? "bg-foreground/10 ring-1 ring-foreground" : "bg-muted hover:bg-foreground/10"
                    }`}
                  >
                    {e}
                  </button>
                ))}
              </div>
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
