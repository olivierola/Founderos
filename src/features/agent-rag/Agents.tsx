import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Plus, Loader2, MoreVertical, Trash2, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
import { PUBLIC_AGENT_PRESETS, type PublicAgentPreset } from "./publicAgentPresets";
import { CatalogCard } from "@/features/service-dashboards/CatalogCard";
import { fetchServiceDashboards } from "@/features/service-dashboards/model";
import {
  useComposioToolkits, useConnectorStatus, toolSlugsFromRows, resolveNeeds,
} from "@/features/service-dashboards/useToolkits";

// One roster for the whole workforce. Internal agents (the team's own workers,
// living in a service dashboard) and public agents (customer-facing, fed by a
// knowledge base) used to be two separate tabs, which asked the reader to know
// the difference before they could find anyone. They are listed together here
// and told apart by a badge; the filter is there when you do care.
//
// The cards stay READ-and-open: an internal agent is still worked with inside
// its dashboard, a public one inside its builder. This page is the directory,
// not a third place to configure them.

type Scope = "all" | "internal" | "public";

interface PublicAgent {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  accent_color: string | null;
  created_at: string;
}

interface InternalAgent {
  id: string;
  name: string;
  description: string | null;
  avatar_style: "avatar" | "orb" | null;
  avatar_url: string | null;
  model: string | null;
  sandbox_mode: string | null;
  studio: string | null;
  is_orchestrator: boolean | null;
  service_dashboard_id: string | null;
  created_at: string;
}

export function AgentsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<Scope>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [preset, setPreset] = useState<PublicAgentPreset>(PUBLIC_AGENT_PRESETS[0]);
  const [newName, setNewName] = useState(PUBLIC_AGENT_PRESETS[0].defaultName);
  const [creating, setCreating] = useState(false);
  const base = `/app/${workspaceSlug}/${projectSlug}`;

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
      if (data) navigate(`${base}/agent/builder/${data.id}/knowledge`);
    } finally {
      setCreating(false);
    }
  }

  const { data: publicAgents, isLoading: loadingPublic } = useQuery({
    queryKey: ["rag_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("rag_agents")
        .select("id, name, description, enabled, accent_color, created_at")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as PublicAgent[];
    },
  });

  const { data: internalAgents, isLoading: loadingInternal } = useQuery({
    queryKey: ["workforce_internal_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("internal_agents")
        .select("id, name, description, avatar_style, avatar_url, model, sandbox_mode, studio, is_orchestrator, service_dashboard_id, created_at")
        .eq("project_id", projectId!)
        .eq("is_archived", false)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as InternalAgent[];
    },
  });

  // Where "Nouvel agent interne" goes: an internal agent belongs to a service
  // dashboard, so it is created there. Without one there is nowhere to put it,
  // and the option is simply not offered.
  const { data: dashboards } = useQuery({
    queryKey: ["service_dashboards", projectId],
    enabled: !!projectId,
    queryFn: () => fetchServiceDashboards(projectId!),
  });
  const firstDashboardId = (dashboards ?? [])[0]?.id ?? null;

  // Tool + skill counts for the internal roster, in two queries.
  const internalIds = (internalAgents ?? []).map((a) => a.id);
  const { data: internalCounts } = useQuery({
    queryKey: ["workforce_agent_counts", internalIds.join(",")],
    enabled: internalIds.length > 0,
    queryFn: async () => {
      const [tools, skills] = await Promise.all([
        supabase.from("internal_agent_tools").select("agent_id, kind, config").in("agent_id", internalIds),
        supabase.from("agent_skill_activations").select("agent_id").in("agent_id", internalIds),
      ]);
      const map = new Map<string, { tools: number; skills: number; slugs: string[] }>();
      const row = (id: string) => {
        const cur = map.get(id) ?? { tools: 0, skills: 0, slugs: [] as string[] };
        map.set(id, cur);
        return cur;
      };
      for (const r of (tools.data ?? []) as Array<{ agent_id: string; kind: string; config: Record<string, unknown> | null }>) {
        const cur = row(r.agent_id);
        cur.tools += 1;
        for (const s of toolSlugsFromRows([r])) if (!cur.slugs.includes(s)) cur.slugs.push(s);
      }
      for (const r of (skills.data ?? []) as Array<{ agent_id: string }>) row(r.agent_id).skills += 1;
      return map;
    },
  });
  const countMap = internalCounts ?? new Map<string, { tools: number; skills: number; slugs: string[] }>();

  const { data: toolkits } = useComposioToolkits();
  const { data: connStatus } = useConnectorStatus(workspaceId, projectId);

  // Per-public-agent source/conversation counts.
  const { data: publicCounts } = useQuery({
    queryKey: ["rag_agent_counts", (publicAgents ?? []).map((a) => a.id).sort()],
    enabled: !!publicAgents && publicAgents.length > 0,
    queryFn: async () => {
      const out: Record<string, { sources: number; convos: number }> = {};
      await Promise.all(
        (publicAgents ?? []).map(async (a) => {
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

  async function removePublic(id: string) {
    await supabase.from("rag_agents").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["rag_agents", projectId] });
  }

  /** An internal agent opens inside the dashboard that owns it; one that isn't
   *  attached to any goes through the resolver route, which finds the project's
   *  first dashboard rather than dead-ending. */
  function openInternal(a: InternalAgent) {
    navigate(a.service_dashboard_id
      ? `${base}/service/${a.service_dashboard_id}/agent/${a.id}`
      : `${base}/agent/internal/${a.id}`);
  }

  const isLoading = loadingPublic || loadingInternal;
  const internals = internalAgents ?? [];
  const publics = publicAgents ?? [];
  const total = internals.length + publics.length;

  const showInternal = scope === "all" || scope === "internal";
  const showPublic = scope === "all" || scope === "public";
  const visible = (showInternal ? internals.length : 0) + (showPublic ? publics.length : 0);

  const filters = useMemo(() => ([
    { key: "all" as Scope, label: "Tous", count: total },
    { key: "internal" as Scope, label: "Internes", count: internals.length },
    { key: "public" as Scope, label: "Publics", count: publics.length },
  ]), [total, internals.length, publics.length]);

  return (
    <div>
      <PageHeader
        title="Agents"
        description="Toute la main-d'œuvre IA du projet : les agents internes qui travaillent pour l'équipe (dans leur dashboard de service) et les agents publics destinés à vos clients (SAV, e-commerce, renseignements, onboarding)."
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button><Plus className="h-4 w-4" /> Nouvel agent</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">Type d'agent</DropdownMenuLabel>
              <DropdownMenuItem
                disabled={!firstDashboardId}
                onSelect={() => firstDashboardId && navigate(`${base}/service/${firstDashboardId}/agents/new`)}
              >
                <Users className="h-4 w-4" />
                <span className="min-w-0">
                  <span className="block text-sm">Agent interne</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {firstDashboardId ? "Travaille pour l'équipe, dans un dashboard de service." : "Créez d'abord un dashboard de service."}
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openCreate()}>
                <Bot className="h-4 w-4" />
                <span className="min-w-0">
                  <span className="block text-sm">Agent public</span>
                  <span className="block text-[11px] text-muted-foreground">Face client, nourri par une base de connaissances.</span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      {total > 0 && (
        <div className="mb-5 flex items-center gap-1.5">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setScope(f.key)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs transition-colors",
                scope === f.key
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {f.label} <span className="tabular-nums opacity-60">{f.count}</span>
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <EmptyState icon={Loader2} title="Chargement…" />
      ) : total === 0 ? (
        <EmptyState
          icon={Bot}
          title="Aucun agent pour l'instant"
          description="Créez un agent interne (il travaille pour votre équipe depuis un dashboard de service) ou un agent public (face client, nourri par votre base de connaissances)."
          action={<Button onClick={openCreate}><Plus className="h-4 w-4" /> Nouvel agent public</Button>}
        />
      ) : visible === 0 ? (
        <EmptyState
          icon={Bot}
          title={scope === "internal" ? "Aucun agent interne" : "Aucun agent public"}
          description={scope === "internal"
            ? "Les agents internes se créent dans un dashboard de service."
            : "Créez un agent orienté client (SAV, e-commerce, guide, onboarding), ajoutez des sources de connaissance, puis intégrez-le en widget sur votre site."}
          action={scope === "public" ? <Button onClick={openCreate}><Plus className="h-4 w-4" /> Nouvel agent public</Button> : undefined}
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {showInternal && internals.map((a) => {
            const c = countMap.get(a.id);
            return (
              <CatalogCard
                key={a.id}
                className={cn(a.studio && "studio-border")}
                onClick={() => openInternal(a)}
                glyph={<AgentIdentity style={a.avatar_style} url={a.avatar_url} seed={a.name} size={54} rounded="rounded-xl" />}
                name={a.name}
                tools={c?.tools ?? null}
                extras={c?.skills ?? null}
                tools_needed={resolveNeeds(c?.slugs ?? [], toolkits, connStatus)}
                badges={[
                  { label: "interne", tone: "auth", title: "Agent interne — travaille pour l'équipe" },
                  { label: a.model ?? "deepseek", tone: "key", title: "Modèle" },
                ]}
                meta={new Date(a.created_at).toISOString().slice(0, 10)}
              />
            );
          })}

          {showPublic && publics.map((a) => {
            const color = a.accent_color || "#001BB7";
            const c = publicCounts?.[a.id];
            return (
              <CatalogCard
                key={a.id}
                onClick={() => navigate(`${base}/agent/builder/${a.id}/playground`)}
                glyph={
                  <span
                    className="flex h-14 w-14 items-center justify-center rounded-xl"
                    style={{ background: `${color}26` }}
                  >
                    <Bot className="h-7 w-7" style={{ color }} />
                  </span>
                }
                name={a.name}
                // A public agent's numbers are its knowledge sources and the
                // conversations it has held — not tools and skills.
                tools={c?.sources ?? null}
                extras={c?.convos ?? null}
                badges={[
                  { label: "public", tone: "auth", title: "Agent public — face client" },
                  { label: a.enabled ? "live" : "disabled", tone: "key", title: "État de publication" },
                ]}
                meta={new Date(a.created_at).toISOString().slice(0, 10)}
                action={
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        title="Actions"
                        className="rounded-lg border border-border/70 bg-background/90 p-1 text-muted-foreground backdrop-blur transition-colors hover:text-foreground"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem destructive onClick={() => removePublic(a.id)}>
                        <Trash2 className="h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
              />
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
