import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import {
  Megaphone, Loader2, Send, BarChart3, CalendarDays, Plug, Plus, RefreshCw,
  Sparkles, Lightbulb, TrendingUp, Heart, Eye, Trash2,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { PromptDialog } from "@/components/PromptDialog";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface Post {
  id: string;
  platform: string;
  status: string;
  objective: string | null;
  content: string;
  hashtags: string[] | null;
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
  campaign_id: string | null;
}
interface Metric {
  post_id: string;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  engagement_rate: number;
}

function usePosts() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["mkt_posts", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("marketing_posts")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(300);
      return (data ?? []) as Post[];
    },
  });
}
function useMetrics() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["mkt_metrics", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("marketing_post_metrics")
        .select("*")
        .eq("project_id", projectId!)
        .limit(300);
      return (data ?? []) as Metric[];
    },
  });
}

function statusBadge(s: string) {
  if (s === "published") return <Badge variant="success">published</Badge>;
  if (s === "scheduled") return <Badge variant="info">scheduled</Badge>;
  if (s === "failed") return <Badge variant="destructive">failed</Badge>;
  if (s === "publishing") return <Badge variant="warning">publishing</Badge>;
  return <Badge variant="secondary">draft</Badge>;
}

// --- Overview -----------------------------------------------------------
export function MarketingOverviewPage() {
  const { workspaceSlug, projectSlug } = useParams();
  const { data: posts, isLoading } = usePosts();
  const { data: metrics } = useMetrics();

  const stats = useMemo(() => {
    const list = posts ?? [];
    const published = list.filter((p) => p.status === "published");
    const m = metrics ?? [];
    const impressions = m.reduce((s, x) => s + x.impressions, 0);
    const eng = m.reduce((s, x) => s + x.likes + x.comments + x.shares + x.clicks, 0);
    const avgRate = m.length ? m.reduce((s, x) => s + x.engagement_rate, 0) / m.length : 0;
    return { total: list.length, published: published.length, scheduled: list.filter((p) => p.status === "scheduled").length, impressions, eng, avgRate };
  }, [posts, metrics]);

  const base = `/app/${workspaceSlug}/${projectSlug}/marketing`;

  return (
    <div>
      <PageHeader title="Marketing Overview" description="Your social presence at a glance — generated from your SaaS understanding." />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <MetricCard label="Posts" value={String(stats.total)} icon={Megaphone} />
            <MetricCard label="Published" value={String(stats.published)} icon={Send} />
            <MetricCard label="Scheduled" value={String(stats.scheduled)} icon={CalendarDays} />
            <MetricCard label="Impressions" value={stats.impressions.toLocaleString()} icon={Eye} />
            <MetricCard label="Avg engagement" value={`${(stats.avgRate * 100).toFixed(1)}%`} icon={Heart} />
          </div>

          {stats.total === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="Start creating content"
              description="Generate posts from your SaaS understanding in Content Studio."
              action={<Link to={`${base}/content-studio`}><Button><Sparkles className="h-4 w-4" /> Open Content Studio</Button></Link>}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Link to={`${base}/content-studio`}><Button variant="outline" size="sm"><Sparkles className="h-4 w-4" /> Content Studio</Button></Link>
              <Link to={`${base}/calendar`}><Button variant="outline" size="sm"><CalendarDays className="h-4 w-4" /> Calendar</Button></Link>
              <Link to={`${base}/analytics`}><Button variant="outline" size="sm"><BarChart3 className="h-4 w-4" /> Analytics</Button></Link>
              <Link to={`${base}/advisor`}><Button variant="outline" size="sm"><Lightbulb className="h-4 w-4" /> Advisor</Button></Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Calendar -----------------------------------------------------------
export function MarketingCalendarPage() {
  const { data: posts, isLoading } = usePosts();
  const scheduled = useMemo(
    () => (posts ?? []).filter((p) => p.status === "scheduled" || p.status === "published")
      .sort((a, b) => (b.scheduled_at ?? b.published_at ?? b.created_at).localeCompare(a.scheduled_at ?? a.published_at ?? a.created_at)),
    [posts],
  );

  return (
    <div>
      <PageHeader title="Calendar" description="Scheduled and published posts timeline." />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : scheduled.length === 0 ? (
        <EmptyState icon={CalendarDays} title="Nothing scheduled" description="Publish or schedule posts from Content Studio." />
      ) : (
        <div className="space-y-2">
          {scheduled.map((p) => (
            <Card key={p.id}>
              <CardContent className="flex items-start gap-3 p-3">
                <div className="w-28 shrink-0 text-xs text-muted-foreground">
                  {new Date(p.scheduled_at ?? p.published_at ?? p.created_at).toLocaleString()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-1.5">
                    <Badge variant="info">{p.platform}</Badge>
                    {statusBadge(p.status)}
                  </div>
                  <p className="line-clamp-2 text-sm">{p.content}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Channels -----------------------------------------------------------
interface Channel { id: string; provider: string; platform: string; handle: string | null; status: string; }
export function MarketingChannelsPage() {
  const { workspaceSlug, projectSlug } = useParams();
  const { projectId } = useCurrentContext();
  const { data: channels, isLoading } = useQuery({
    queryKey: ["mkt_channels", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("marketing_channels").select("*").eq("project_id", projectId!);
      return (data ?? []) as Channel[];
    },
  });
  const base = `/app/${workspaceSlug}/${projectSlug}`;

  return (
    <div>
      <PageHeader
        title="Channels"
        description="Social accounts you publish to. Connect Buffer (or a webhook) in the Catalog, then add channels."
        actions={<Link to={`${base}/integrations/catalog`}><Button size="sm" variant="outline"><Plug className="h-4 w-4" /> Catalog</Button></Link>}
      />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !channels || channels.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No channels yet"
          description="Connect Buffer from the Catalog to publish to X, LinkedIn, Instagram and more from one place."
          action={<Link to={`${base}/integrations/catalog`}><Button><Plug className="h-4 w-4" /> Connect a channel</Button></Link>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {channels.map((c) => (
            <Card key={c.id}>
              <CardContent className="flex items-center justify-between p-4">
                <div>
                  <div className="font-medium capitalize">{c.platform}</div>
                  <div className="text-xs text-muted-foreground">{c.handle ?? c.provider}</div>
                </div>
                <Badge variant={c.status === "connected" ? "success" : "destructive"}>{c.status}</Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Analytics ----------------------------------------------------------
export function MarketingAnalyticsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const { data: posts } = usePosts();
  const { data: metrics, isLoading } = useMetrics();
  const [syncing, setSyncing] = useState(false);

  const postById = useMemo(() => new Map((posts ?? []).map((p) => [p.id, p])), [posts]);

  const rows = useMemo(
    () => (metrics ?? [])
      .map((m) => ({ ...m, post: postById.get(m.post_id) }))
      .filter((r) => r.post)
      .sort((a, b) => b.engagement_rate - a.engagement_rate),
    [metrics, postById],
  );

  const byPlatform = useMemo(() => {
    const m = new Map<string, { impressions: number; eng: number; count: number }>();
    rows.forEach((r) => {
      const k = r.post!.platform;
      const cur = m.get(k) ?? { impressions: 0, eng: 0, count: 0 };
      cur.impressions += r.impressions;
      cur.eng += r.likes + r.comments + r.shares + r.clicks;
      cur.count += 1;
      m.set(k, cur);
    });
    return [...m.entries()];
  }, [rows]);

  async function sync() {
    if (!workspaceId || !projectId) return;
    setSyncing(true);
    try {
      await callEdge("marketing-sync-metrics", { workspace_id: workspaceId, project_id: projectId });
      queryClient.invalidateQueries({ queryKey: ["mkt_metrics", projectId] });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Engagement per post and platform. Sync pulls the latest figures from Buffer."
        actions={
          <div className="flex gap-2">
            <ExportMenu
              rows={rows.map((r) => ({
                platform: r.post!.platform,
                impressions: r.impressions,
                likes: r.likes,
                comments: r.comments,
                shares: r.shares,
                clicks: r.clicks,
                engagement_rate: r.engagement_rate,
                content: r.post!.content.slice(0, 80),
              }))}
              filename="marketing-analytics"
            />
            <Button size="sm" variant="outline" onClick={sync} disabled={syncing}>
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Sync
            </Button>
          </div>
        }
      />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : rows.length === 0 ? (
        <EmptyState icon={BarChart3} title="No analytics yet" description="Publish posts via Buffer, then click Sync to pull engagement metrics." />
      ) : (
        <div className="space-y-6">
          {byPlatform.length > 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {byPlatform.map(([platform, v]) => (
                <MetricCard
                  key={platform}
                  label={platform}
                  value={v.impressions.toLocaleString()}
                  hint={`${v.eng.toLocaleString()} interactions · ${v.count} posts`}
                  icon={TrendingUp}
                />
              ))}
            </div>
          )}
          <Card>
            <CardHeader><CardTitle>Top posts</CardTitle></CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Post</th>
                    <th className="px-4 py-3">Platform</th>
                    <th className="px-4 py-3 text-right">Impr.</th>
                    <th className="px-4 py-3 text-right">Likes</th>
                    <th className="px-4 py-3 text-right">Clicks</th>
                    <th className="px-4 py-3 text-right">Eng.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.post_id}>
                      <td className="max-w-[280px] truncate px-4 py-3">{r.post!.content}</td>
                      <td className="px-4 py-3"><Badge variant="info">{r.post!.platform}</Badge></td>
                      <td className="px-4 py-3 text-right tabular-nums">{r.impressions.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{r.likes.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{r.clicks.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{(r.engagement_rate * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// --- Campaigns ----------------------------------------------------------
interface Campaign { id: string; name: string; objective: string; status: string; created_at: string; }
export function MarketingCampaignsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const { data: campaigns, isLoading } = useQuery({
    queryKey: ["mkt_campaigns", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("marketing_campaigns").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Campaign[];
    },
  });
  const { data: posts } = usePosts();
  const countByCampaign = useMemo(() => {
    const m = new Map<string, number>();
    (posts ?? []).forEach((p) => p.campaign_id && m.set(p.campaign_id, (m.get(p.campaign_id) ?? 0) + 1));
    return m;
  }, [posts]);

  async function remove(id: string) {
    await supabase.from("marketing_campaigns").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["mkt_campaigns", projectId] });
  }

  return (
    <div>
      <PageHeader
        title="Campaigns"
        description="Group posts into goal-driven campaigns."
        actions={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> New campaign</Button>}
      />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !campaigns || campaigns.length === 0 ? (
        <EmptyState icon={Megaphone} title="No campaigns yet" description="Create a campaign to organize related posts." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {campaigns.map((c) => (
            <Card key={c.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-semibold">{c.name}</div>
                    <Badge variant="outline" className="mt-1">{c.objective}</Badge>
                  </div>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => remove(c.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="mt-3 text-xs text-muted-foreground">{countByCampaign.get(c.id) ?? 0} posts</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <PromptDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New campaign"
        label="Campaign name"
        placeholder="Launch week"
        confirmText="Create"
        onSubmit={async (name) => {
          if (!workspaceId || !projectId) return;
          await supabase.from("marketing_campaigns").insert({ workspace_id: workspaceId, project_id: projectId, name });
          queryClient.invalidateQueries({ queryKey: ["mkt_campaigns", projectId] });
        }}
      />
    </div>
  );
}

// --- Advisor ------------------------------------------------------------
interface Advice {
  summary: string;
  best_practices: string[];
  recommendations: { title: string; why: string; priority: string }[];
  next_post_ideas: { platform: string; objective: string; hook: string }[];
}
export function MarketingAdvisorPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!workspaceId || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await callEdge<{ advice: Advice }>("marketing-advisor", { workspace_id: workspaceId, project_id: projectId });
      setAdvice(res.advice);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Advisor"
        description="AI marketing advice grounded in your post performance and your SaaS understanding."
        actions={<Button size="sm" onClick={run} disabled={loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Get advice</Button>}
      />
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      {!advice ? (
        <EmptyState icon={Lightbulb} title="No advice yet" description="Click 'Get advice' — the AI analyzes your posts and product to suggest your next moves." />
      ) : (
        <div className="space-y-4">
          <Card><CardContent className="p-5 text-sm text-foreground/90">{advice.summary}</CardContent></Card>

          {advice.recommendations?.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Recommendations</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {advice.recommendations.map((r, i) => (
                  <div key={i} className="rounded-md border border-border p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{r.title}</span>
                      <Badge variant={r.priority === "high" ? "destructive" : r.priority === "medium" ? "warning" : "secondary"}>{r.priority}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{r.why}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {advice.next_post_ideas?.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Next post ideas</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {advice.next_post_ideas.map((idea, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-md border border-border p-3">
                    <Lightbulb className="mt-0.5 h-4 w-4 text-amber-400" />
                    <div>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="info">{idea.platform}</Badge>
                        <Badge variant="outline">{idea.objective}</Badge>
                      </div>
                      <p className="mt-1 text-sm">{idea.hook}</p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {advice.best_practices?.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Best practices</CardTitle></CardHeader>
              <CardContent>
                <ul className="list-inside list-disc space-y-1 text-sm text-foreground/90">
                  {advice.best_practices.map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
