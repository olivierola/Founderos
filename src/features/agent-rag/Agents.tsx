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
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { AgentIdentity } from "@/components/AgentIdentity";
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
// The cards stay READ-and-open: BOTH kinds are worked with inside the service
// dashboard that owns them (0195 moved the public builder there too). This page
// is the directory, not a second place to configure or create them.

type Scope = "all" | "internal" | "public";

interface PublicAgent {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  accent_color: string | null;
  service_dashboard_id: string | null;
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
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<Scope>("all");
  const base = `/app/${workspaceSlug}/${projectSlug}`;

  const { data: publicAgents, isLoading: loadingPublic } = useQuery({
    queryKey: ["rag_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("rag_agents")
        .select("id, name, description, enabled, accent_color, service_dashboard_id, created_at")
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

  /** Same rule for a public agent: its builder tabs live in its dashboard, and
   *  the /agent/builder resolver handles the orphaned ones. */
  function openPublic(a: PublicAgent) {
    navigate(a.service_dashboard_id
      ? `${base}/service/${a.service_dashboard_id}/public/${a.id}`
      : `${base}/agent/builder/${a.id}/playground`);
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
              {/* Both kinds are created in a service dashboard now — this menu
                  only points there. */}
              <DropdownMenuItem
                disabled={!firstDashboardId}
                onSelect={() => firstDashboardId && navigate(`${base}/service/${firstDashboardId}/agents/new?type=public`)}
              >
                <Bot className="h-4 w-4" />
                <span className="min-w-0">
                  <span className="block text-sm">Agent public</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {firstDashboardId ? "Face client, nourri par une base de connaissances." : "Créez d'abord un dashboard de service."}
                  </span>
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
          description="Les agents — internes (ils travaillent pour votre équipe) comme publics (face client, nourris par votre base de connaissances) — se créent dans un dashboard de service."
          action={firstDashboardId
            ? <Button onClick={() => navigate(`${base}/service/${firstDashboardId}/agents/new`)}><Plus className="h-4 w-4" /> Créer un agent</Button>
            : undefined}
        />
      ) : visible === 0 ? (
        <EmptyState
          icon={Bot}
          title={scope === "internal" ? "Aucun agent interne" : "Aucun agent public"}
          description={scope === "internal"
            ? "Les agents internes se créent dans un dashboard de service."
            : "Créez un agent orienté client (SAV, e-commerce, guide, onboarding) depuis un dashboard de service, ajoutez des sources de connaissance, puis intégrez-le en widget sur votre site."}
          action={scope === "public" && firstDashboardId
            ? <Button onClick={() => navigate(`${base}/service/${firstDashboardId}/agents/new?type=public`)}><Plus className="h-4 w-4" /> Nouvel agent public</Button>
            : undefined}
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
                onClick={() => openPublic(a)}
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

    </div>
  );
}
