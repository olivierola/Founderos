import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import {
  Megaphone, Loader2, Send, BarChart3, CalendarDays, Plug, Plus, RefreshCw,
  Sparkles, Lightbulb, TrendingUp, Heart, Eye, Trash2,
  MessageCircle, Repeat2, MousePointerClick, ChevronLeft, ChevronRight, Check, X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { PromptDialog } from "@/components/PromptDialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface Post {
  id: string;
  platform: string;
  status: string;
  objective: string | null;
  tone: string | null;
  angle: string | null;
  cta: string | null;
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

// Flip scheduled posts whose time has passed to "published" (Buffer posts them
// on its side without notifying us). Best-effort; ids passed are already due.
export async function markDueAsPublished(duePosts: { id: string; status: string; scheduled_at: string | null }[]) {
  const now = Date.now();
  const due = duePosts.filter(
    (p) => p.status === "scheduled" && p.scheduled_at && new Date(p.scheduled_at).getTime() <= now,
  );
  if (due.length === 0) return false;
  await Promise.all(
    due.map((p) =>
      supabase
        .from("marketing_posts")
        .update({ status: "published", published_at: p.scheduled_at })
        .eq("id", p.id)
        .eq("status", "scheduled"),
    ),
  );
  return true;
}

export function usePosts() {
  const { projectId } = useCurrentContext();
  const queryClient = useQueryClient();
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
      const posts = (data ?? []) as Post[];
      // Auto-promote due scheduled posts, then refetch once so the UI reflects it.
      const changed = await markDueAsPublished(posts);
      if (changed) {
        posts.forEach((p) => {
          if (p.status === "scheduled" && p.scheduled_at && new Date(p.scheduled_at).getTime() <= Date.now()) {
            p.status = "published";
            p.published_at = p.scheduled_at;
          }
        });
        queryClient.invalidateQueries({ queryKey: ["mkt_published_studio", projectId] });
        queryClient.invalidateQueries({ queryKey: ["mkt_scheduled_studio", projectId] });
      }
      return posts;
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

// Reusable: render a published post with its metrics (impressions / likes / etc.).
export function PublishedPostCard({ post, metric }: { post: Post; metric?: Metric }) {
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="info">{post.platform}</Badge>
          {statusBadge(post.status)}
          {post.objective && <Badge variant="outline">{post.objective}</Badge>}
          <span className="ml-auto text-xs text-muted-foreground">
            {post.published_at ? new Date(post.published_at).toLocaleDateString() : "—"}
          </span>
        </div>
        <p className="line-clamp-3 text-sm">{post.content}</p>
        {(post.hashtags ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {post.hashtags!.slice(0, 6).map((h) => <span key={h} className="text-xs text-primary">#{h}</span>)}
          </div>
        )}
        <div className="flex flex-wrap gap-4 border-t border-border pt-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><Eye className="h-3.5 w-3.5" /> {(metric?.impressions ?? 0).toLocaleString()}</span>
          <span className="flex items-center gap-1"><Heart className="h-3.5 w-3.5" /> {(metric?.likes ?? 0).toLocaleString()}</span>
          <span className="flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" /> {(metric?.comments ?? 0).toLocaleString()}</span>
          <span className="flex items-center gap-1"><Repeat2 className="h-3.5 w-3.5" /> {(metric?.shares ?? 0).toLocaleString()}</span>
          <span className="flex items-center gap-1"><MousePointerClick className="h-3.5 w-3.5" /> {(metric?.clicks ?? 0).toLocaleString()}</span>
          <span className="ml-auto flex items-center gap-1 text-foreground">
            <TrendingUp className="h-3.5 w-3.5" /> {((metric?.engagement_rate ?? 0) * 100).toFixed(1)}%
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Overview -----------------------------------------------------------
export function MarketingOverviewPage() {
  const { workspaceSlug, projectSlug } = useParams();
  const { data: posts, isLoading } = usePosts();
  const { data: metrics } = useMetrics();

  const metricById = useMemo(() => new Map((metrics ?? []).map((m) => [m.post_id, m])), [metrics]);

  const stats = useMemo(() => {
    const list = posts ?? [];
    const published = list.filter((p) => p.status === "published");
    const m = metrics ?? [];
    const impressions = m.reduce((s, x) => s + x.impressions, 0);
    const likes = m.reduce((s, x) => s + x.likes, 0);
    const clicks = m.reduce((s, x) => s + x.clicks, 0);
    const eng = m.reduce((s, x) => s + x.likes + x.comments + x.shares + x.clicks, 0);
    const avgRate = m.length ? m.reduce((s, x) => s + x.engagement_rate, 0) / m.length : 0;
    // Best post by engagement rate
    const best = [...m].sort((a, b) => b.engagement_rate - a.engagement_rate)[0] ?? null;
    return {
      total: list.length,
      published: published.length,
      scheduled: list.filter((p) => p.status === "scheduled").length,
      drafts: list.filter((p) => p.status === "draft").length,
      impressions, likes, clicks, eng, avgRate, best,
    };
  }, [posts, metrics]);

  const publishedPosts = useMemo(
    () =>
      (posts ?? [])
        .filter((p) => p.status === "published")
        .sort((a, b) => (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at)),
    [posts],
  );

  const base = `/app/${workspaceSlug}/${projectSlug}/marketing`;

  return (
    <div>
      <PageHeader title="Marketing Overview" description="Your social presence at a glance — generated from your SaaS understanding." />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : (
        <div className="space-y-6">
          {/* Volume metrics */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard label="Total posts" value={String(stats.total)} icon={Megaphone} hint={`${stats.drafts} drafts`} />
            <MetricCard label="Published" value={String(stats.published)} icon={Send} />
            <MetricCard label="Scheduled" value={String(stats.scheduled)} icon={CalendarDays} />
            <MetricCard
              label="Best engagement"
              value={`${((stats.best?.engagement_rate ?? 0) * 100).toFixed(1)}%`}
              icon={TrendingUp}
            />
          </div>
          {/* Engagement metrics */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard label="Impressions" value={stats.impressions.toLocaleString()} icon={Eye} />
            <MetricCard label="Likes" value={stats.likes.toLocaleString()} icon={Heart} />
            <MetricCard label="Clicks" value={stats.clicks.toLocaleString()} icon={MousePointerClick} />
            <MetricCard label="Avg engagement" value={`${(stats.avgRate * 100).toFixed(1)}%`} icon={TrendingUp} />
          </div>

          {stats.total === 0 ? (
            <EmptyState
              icon={Sparkles}
              title="Start creating content"
              description="Generate posts from your SaaS understanding in Content Studio."
              action={<Link to={`${base}/content-studio`}><Button><Sparkles className="h-4 w-4" /> Open Content Studio</Button></Link>}
            />
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Link to={`${base}/content-studio`}><Button variant="outline" size="sm"><Sparkles className="h-4 w-4" /> Content Studio</Button></Link>
                <Link to={`${base}/calendar`}><Button variant="outline" size="sm"><CalendarDays className="h-4 w-4" /> Calendar</Button></Link>
                <Link to={`${base}/analytics`}><Button variant="outline" size="sm"><BarChart3 className="h-4 w-4" /> Analytics</Button></Link>
                <Link to={`${base}/advisor`}><Button variant="outline" size="sm"><Lightbulb className="h-4 w-4" /> Advisor</Button></Link>
              </div>

              <div>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-medium">Published posts</h2>
                  {publishedPosts.length > 0 && (
                    <Link to={`${base}/analytics`} className="text-xs text-primary hover:underline">View analytics →</Link>
                  )}
                </div>
                {publishedPosts.length === 0 ? (
                  <EmptyState icon={Send} title="No published posts yet" description="Publish from Content Studio to see them here with their metrics." />
                ) : (
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                    {publishedPosts.slice(0, 6).map((p) => (
                      <PublishedPostCard key={p.id} post={p} metric={metricById.get(p.id)} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// --- Calendar (real month grid) ----------------------------------------
function ymdKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function MarketingCalendarPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const { data: posts, isLoading } = usePosts();

  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [scheduleDay, setScheduleDay] = useState<Date | null>(null);
  const [selectedPost, setSelectedPost] = useState<Post | null>(null);

  // Map posts (scheduled or published) to their day key.
  const postsByDay = useMemo(() => {
    const m = new Map<string, Post[]>();
    (posts ?? []).forEach((p) => {
      const when = p.scheduled_at ?? p.published_at;
      if (!when || (p.status !== "scheduled" && p.status !== "published")) return;
      const key = ymdKey(new Date(when));
      const arr = m.get(key) ?? [];
      arr.push(p);
      m.set(key, arr);
    });
    return m;
  }, [posts]);

  // Build the month grid (weeks start Monday).
  const cells = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const startOffset = (first.getDay() + 6) % 7; // Mon=0
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const out: (Date | null)[] = [];
    for (let i = 0; i < startOffset; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(new Date(year, month, d));
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [cursor]);

  const todayKey = ymdKey(new Date());
  const drafts = useMemo(() => (posts ?? []).filter((p) => p.status === "draft"), [posts]);

  function platformDot(platform: string) {
    const color =
      platform === "twitter" || platform === "x" ? "bg-sky-400"
      : platform === "linkedin" ? "bg-blue-500"
      : platform === "instagram" ? "bg-pink-400"
      : platform === "facebook" ? "bg-indigo-400" : "bg-primary";
    return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />;
  }

  return (
    <div>
      <PageHeader
        title="Calendar"
        description="Schedule posts to specific dates. Scheduled and published posts appear as badges in their day."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-36 text-center text-sm font-medium">{MONTHS[cursor.getMonth()]} {cursor.getFullYear()}</span>
            <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => { const d = new Date(); setCursor(new Date(d.getFullYear(), d.getMonth(), 1)); }}>Today</Button>
          </div>
        }
      />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : (
        <Card>
          <CardContent className="p-3">
            <div className="grid grid-cols-7 gap-1">
              {WEEKDAYS.map((w) => (
                <div key={w} className="px-2 py-1 text-center text-xs font-medium uppercase tracking-wider text-muted-foreground">{w}</div>
              ))}
              {cells.map((day, i) => {
                if (!day) return <div key={i} className="min-h-24 rounded-md bg-muted/20" />;
                const key = ymdKey(day);
                const dayPosts = postsByDay.get(key) ?? [];
                const isToday = key === todayKey;
                const isPast = day < new Date(new Date().setHours(0, 0, 0, 0));
                return (
                  <div
                    key={i}
                    className={`group min-h-24 rounded-md border p-1.5 transition-colors ${isToday ? "border-primary/50 bg-primary/5" : "border-border"}`}
                  >
                    <div className="mb-1 flex items-center justify-between">
                      <span className={`text-xs ${isToday ? "font-semibold text-primary" : "text-muted-foreground"}`}>{day.getDate()}</span>
                      {!isPast && (
                        <button
                          onClick={() => setScheduleDay(day)}
                          className="opacity-0 transition-opacity group-hover:opacity-100"
                          title="Schedule a post"
                        >
                          <Plus className="h-3.5 w-3.5 text-muted-foreground hover:text-primary" />
                        </button>
                      )}
                    </div>
                    <div className="space-y-1">
                      {dayPosts.slice(0, 4).map((p) => (
                        <button
                          key={p.id}
                          title={p.content}
                          onClick={() => setSelectedPost(p)}
                          className={`flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[10px] transition-opacity hover:opacity-80 ${
                            p.status === "published" ? "bg-[hsl(var(--accent-2)/0.22)] text-[hsl(var(--accent-2))]" : "bg-info/15 text-info"
                          }`}
                        >
                          {platformDot(p.platform)}
                          <span className="truncate">{p.content.slice(0, 28)}</span>
                        </button>
                      ))}
                      {dayPosts.length > 4 && <div className="text-[10px] text-muted-foreground">+{dayPosts.length - 4} more</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <ScheduleDialog
        open={!!scheduleDay}
        day={scheduleDay}
        drafts={drafts}
        onClose={() => setScheduleDay(null)}
        onScheduled={() => {
          queryClient.invalidateQueries({ queryKey: ["mkt_posts", projectId] });
          setScheduleDay(null);
        }}
        workspaceId={workspaceId}
        projectId={projectId}
      />

      <PostDetailDialog
        post={selectedPost}
        onClose={() => setSelectedPost(null)}
        onChanged={() => {
          queryClient.invalidateQueries({ queryKey: ["mkt_posts", projectId] });
          setSelectedPost(null);
        }}
        workspaceId={workspaceId}
        projectId={projectId}
      />
    </div>
  );
}

// Shared post detail / edit modal. Lets you edit content, reschedule and delete.
export function PostDetailDialog({
  post, onClose, onChanged, workspaceId, projectId,
}: {
  post: Post | null;
  onClose: () => void;
  onChanged: () => void;
  workspaceId: string | null;
  projectId: string | null;
}) {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reschedule, setReschedule] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");

  // Sync local editing state when a new post is opened.
  const pid = post?.id ?? "";
  useMemo(() => {
    setContent(post?.content ?? "");
    setError(null);
    setReschedule(false);
    if (post?.scheduled_at) {
      const d = new Date(post.scheduled_at);
      setDate(ymdKey(d));
      setTime(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
    }
  }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!post) return null;
  const editable = post.status === "draft" || post.status === "scheduled";

  async function saveContent() {
    if (!post) return;
    setBusy(true); setError(null);
    try {
      await supabase.from("marketing_posts").update({ content, updated_at: new Date().toISOString() }).eq("id", post.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function applyReschedule() {
    if (!workspaceId || !projectId || !post || !date) return;
    setBusy(true); setError(null);
    try {
      const [h, m] = time.split(":").map(Number);
      const when = new Date(date);
      when.setHours(h || 9, m || 0, 0, 0);
      // Persist any content edits first, then (re)schedule via the publish edge.
      await supabase.from("marketing_posts").update({ content }).eq("id", post.id);
      await callEdge("marketing-publish", {
        workspace_id: workspaceId, project_id: projectId, post_id: post.id, schedule_at: when.toISOString(),
      });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!post) return;
    setBusy(true);
    try {
      await supabase.from("marketing_posts").delete().eq("id", post.id);
      onChanged();
    } finally { setBusy(false); }
  }

  return (
    <MkDialog open={!!post} onClose={onClose} title="Post details">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="info">{post.platform}</Badge>
          {statusBadge(post.status)}
          {post.objective && <Badge variant="outline">{post.objective}</Badge>}
          <span className="ml-auto text-xs text-muted-foreground">
            {post.scheduled_at
              ? `Scheduled ${new Date(post.scheduled_at).toLocaleString()}`
              : post.published_at
                ? `Published ${new Date(post.published_at).toLocaleString()}`
                : ""}
          </span>
        </div>

        {editable ? (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        ) : (
          <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/20 p-3 text-sm">{post.content}</p>
        )}

        {(post.hashtags ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {post.hashtags!.map((h) => <span key={h} className="text-xs text-primary">#{h}</span>)}
          </div>
        )}
        {post.cta && <p className="text-xs text-muted-foreground">CTA: {post.cta}</p>}

        {editable && reschedule && (
          <div className="grid grid-cols-2 gap-2 rounded-md border border-border p-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Time</label>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" />
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={remove} disabled={busy}>
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
          <div className="flex items-center gap-2">
            {editable && (
              <Button variant="outline" size="sm" onClick={saveContent} disabled={busy}>Save</Button>
            )}
            {editable && !reschedule && (
              <Button variant="outline" size="sm" onClick={() => { setReschedule(true); if (!date) setDate(ymdKey(new Date())); }}>
                <CalendarDays className="h-4 w-4" /> {post.status === "scheduled" ? "Reschedule" : "Schedule"}
              </Button>
            )}
            {editable && reschedule && (
              <Button size="sm" onClick={applyReschedule} disabled={busy || !date}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarDays className="h-4 w-4" />} Confirm
              </Button>
            )}
          </div>
        </div>
      </div>
    </MkDialog>
  );
}

function ScheduleDialog({
  open, day, drafts, onClose, onScheduled, workspaceId, projectId,
}: {
  open: boolean;
  day: Date | null;
  drafts: Post[];
  onClose: () => void;
  onScheduled: () => void;
  workspaceId: string | null;
  projectId: string | null;
}) {
  const [postId, setPostId] = useState("");
  const [time, setTime] = useState("09:00");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset selection when the dialog opens for a new day.
  const dayKey = day ? ymdKey(day) : "";
  useMemo(() => { setPostId(drafts[0]?.id ?? ""); setError(null); }, [dayKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    if (!workspaceId || !projectId || !postId || !day) return;
    setSubmitting(true);
    setError(null);
    try {
      const [h, m] = time.split(":").map(Number);
      const when = new Date(day);
      when.setHours(h || 9, m || 0, 0, 0);
      await callEdge("marketing-publish", {
        workspace_id: workspaceId,
        project_id: projectId,
        post_id: postId,
        schedule_at: when.toISOString(),
      });
      onScheduled();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <MkDialog open={open} onClose={onClose} title={`Schedule a post${day ? ` — ${day.toLocaleDateString()}` : ""}`}>
      {drafts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No drafts available. Generate posts in Content Studio first, then come back to schedule them.
        </p>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="mb-1.5 block text-xs text-muted-foreground">Choose a draft</label>
            <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
              {drafts.map((d) => {
                const active = postId === d.id;
                return (
                  <button
                    key={d.id}
                    onClick={() => setPostId(d.id)}
                    className={`w-full rounded-md border p-3 text-left transition-colors ${
                      active ? "border-primary/50 bg-primary/10" : "border-border hover:bg-secondary"
                    }`}
                  >
                    <div className="mb-1 flex items-center gap-1.5">
                      <Badge variant="info">{d.platform}</Badge>
                      {d.objective && <Badge variant="outline">{d.objective}</Badge>}
                      {active && <Check className="ml-auto h-4 w-4 text-primary" />}
                    </div>
                    <p className="line-clamp-3 text-sm">{d.content}</p>
                    {(d.hashtags ?? []).length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {d.hashtags!.slice(0, 5).map((h) => <span key={h} className="text-xs text-primary">#{h}</span>)}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Time</label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={submitting || !postId}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarDays className="h-4 w-4" />} Schedule
            </Button>
          </div>
        </div>
      )}
    </MkDialog>
  );
}

function MkDialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {/* grid-cols-[minmax(0,1fr)] lets the single column shrink below content so children can truncate */}
      <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg grid-cols-[minmax(0,1fr)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="min-w-0">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

// --- Channels -----------------------------------------------------------
interface Channel { id: string; provider: string; platform: string; handle: string | null; status: string; }
export function MarketingChannelsPage() {
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const { data: channels, isLoading } = useQuery({
    queryKey: ["mkt_channels", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("marketing_channels")
        .select("*")
        .eq("project_id", projectId!)
        .order("platform", { ascending: true });
      return (data ?? []) as Channel[];
    },
  });
  const base = `/app/${workspaceSlug}/${projectSlug}`;

  async function resync() {
    if (!workspaceId || !projectId) return;
    setSyncing(true);
    setError(null);
    try {
      await callEdge("marketing-sync-channels", { workspace_id: workspaceId, project_id: projectId });
      queryClient.invalidateQueries({ queryKey: ["mkt_channels", projectId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function toggle(c: Channel) {
    setBusyId(c.id);
    try {
      const next = c.status === "connected" ? "disconnected" : "connected";
      await supabase.from("marketing_channels").update({ status: next }).eq("id", c.id);
      queryClient.invalidateQueries({ queryKey: ["mkt_channels", projectId] });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Channels"
        description="Social accounts you publish to. Re-sync from Buffer, or toggle a channel off to skip it when publishing."
        actions={
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add channel</Button>
            <Button size="sm" variant="outline" onClick={resync} disabled={syncing}>
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Resync
            </Button>
            <Link to={`${base}/integrations/catalog`}><Button size="sm" variant="outline"><Plug className="h-4 w-4" /> Catalog</Button></Link>
          </div>
        }
      />
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !channels || channels.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No channels yet"
          description="Connect Buffer from the Catalog, then click 'Resync from Buffer' to pull your social accounts."
          action={
            <div className="flex gap-2">
              <Link to={`${base}/integrations/catalog`}><Button><Plug className="h-4 w-4" /> Connect Buffer</Button></Link>
              <Button variant="outline" onClick={resync} disabled={syncing}>
                {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Resync
              </Button>
            </div>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {channels.map((c) => {
            const on = c.status === "connected";
            return (
              <Card key={c.id} className={on ? "" : "opacity-60"}>
                <CardContent className="flex items-center justify-between p-4">
                  <div className="min-w-0">
                    <div className="font-medium capitalize">{c.platform}</div>
                    <div className="truncate text-xs text-muted-foreground">{c.handle ?? c.provider}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={on ? "success" : "secondary"}>{on ? "active" : "off"}</Badge>
                    <Button
                      size="sm"
                      variant={on ? "ghost" : "outline"}
                      disabled={busyId === c.id}
                      onClick={() => toggle(c)}
                      title={on ? "Disable channel" : "Enable channel"}
                    >
                      {busyId === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : on ? "Disable" : "Enable"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <AddChannelDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onImported={() => { queryClient.invalidateQueries({ queryKey: ["mkt_channels", projectId] }); setAddOpen(false); }}
        workspaceId={workspaceId}
        projectId={projectId}
      />
    </div>
  );
}

interface BufferChannel { external_id: string; platform: string; handle: string | null; imported: boolean }

function AddChannelDialog({
  open, onClose, onImported, workspaceId, projectId,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
  workspaceId: string | null;
  projectId: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<BufferChannel[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function load() {
    if (!workspaceId || !projectId) return;
    setLoading(true); setError(null);
    try {
      const res = await callEdge<{ channels: BufferChannel[] }>("marketing-sync-channels", {
        workspace_id: workspaceId, project_id: projectId, mode: "list",
      });
      setAvailable(res.channels ?? []);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Fetch the Buffer profile list each time the dialog opens.
  useMemo(() => { if (open) load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function importSelected() {
    if (!workspaceId || !projectId || selected.size === 0) return;
    setImporting(true); setError(null);
    try {
      await callEdge("marketing-sync-channels", {
        workspace_id: workspaceId, project_id: projectId, mode: "import", external_ids: [...selected],
      });
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  function toggleSel(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const importable = available.filter((c) => !c.imported);

  return (
    <MkDialog open={open} onClose={onClose} title="Add channels from Buffer">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading your Buffer profiles…</div>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : available.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No Buffer profiles found. Connect your social accounts inside Buffer first — they'll appear here to import.
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            To add a brand-new network, connect it in Buffer, then import it here.
          </p>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {available.map((c) => (
              <label
                key={c.external_id}
                className={`flex cursor-pointer items-center gap-2 rounded-md border p-2.5 ${
                  c.imported ? "border-border opacity-60" : selected.has(c.external_id) ? "border-primary/50 bg-primary/10" : "border-border hover:bg-secondary"
                }`}
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  disabled={c.imported}
                  checked={c.imported || selected.has(c.external_id)}
                  onChange={() => toggleSel(c.external_id)}
                />
                <Badge variant="info" className="shrink-0 capitalize">{c.platform}</Badge>
                <span className="min-w-0 flex-1 truncate text-sm">{c.handle ?? c.external_id}</span>
                {c.imported && <span className="shrink-0 text-xs text-muted-foreground">already added</span>}
              </label>
            ))}
          </div>
          {importable.length === 0 && <p className="text-xs text-muted-foreground">All Buffer profiles are already imported.</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button onClick={importSelected} disabled={importing || selected.size === 0}>
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add {selected.size > 0 ? `(${selected.size})` : ""}
            </Button>
          </div>
        </div>
      )}
    </MkDialog>
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
  const [openCampaign, setOpenCampaign] = useState<Campaign | null>(null);
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
        description="Group posts into goal-driven campaigns. Click a campaign to add or remove posts."
        actions={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> New campaign</Button>}
      />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !campaigns || campaigns.length === 0 ? (
        <EmptyState icon={Megaphone} title="No campaigns yet" description="Create a campaign to organize related posts." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {campaigns.map((c) => (
            <Card key={c.id} className="cursor-pointer transition-colors hover:border-primary/40" onClick={() => setOpenCampaign(c)}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-semibold">{c.name}</div>
                    <Badge variant="outline" className="mt-1">{c.objective}</Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); remove(c.id); }}
                  >
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

      <CampaignDetailDialog
        campaign={openCampaign}
        posts={posts ?? []}
        onClose={() => setOpenCampaign(null)}
        onChanged={() => {
          queryClient.invalidateQueries({ queryKey: ["mkt_posts", projectId] });
          queryClient.invalidateQueries({ queryKey: ["mkt_campaigns", projectId] });
        }}
      />
    </div>
  );
}

function CampaignDetailDialog({
  campaign, posts, onClose, onChanged,
}: {
  campaign: Campaign | null;
  posts: Post[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!campaign) return null;
  const inCampaign = posts.filter((p) => p.campaign_id === campaign.id);
  const available = posts.filter((p) => !p.campaign_id);

  async function setCampaign(postId: string, value: string | null) {
    setBusyId(postId);
    try {
      await supabase.from("marketing_posts").update({ campaign_id: value }).eq("id", postId);
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  function row(p: Post, action: "add" | "remove") {
    return (
      <div key={p.id} className="flex items-center gap-2 rounded-md border border-border p-2">
        <Badge variant="info" className="shrink-0">{p.platform}</Badge>
        <span className="min-w-0 flex-1 truncate text-sm">{p.content}</span>
        <Button
          size="icon"
          variant={action === "add" ? "outline" : "ghost"}
          className={`h-8 w-8 shrink-0 ${action === "remove" ? "text-muted-foreground hover:text-destructive" : ""}`}
          disabled={busyId === p.id}
          onClick={() => setCampaign(p.id, action === "add" ? campaign!.id : null)}
        >
          {busyId === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : action === "add" ? <Plus className="h-4 w-4" /> : <X className="h-4 w-4" />}
        </Button>
      </div>
    );
  }

  return (
    <MkDialog open={!!campaign} onClose={onClose} title={campaign.name}>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant="outline">{campaign.objective}</Badge>
          <span className="text-xs text-muted-foreground">{inCampaign.length} posts in this campaign</span>
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">In campaign</div>
          {inCampaign.length === 0 ? (
            <p className="text-sm text-muted-foreground">No posts yet. Add some from the list below.</p>
          ) : (
            <div className="max-h-48 space-y-2 overflow-y-auto pr-1">{inCampaign.map((p) => row(p, "remove"))}</div>
          )}
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Available posts</div>
          {available.length === 0 ? (
            <p className="text-sm text-muted-foreground">No unassigned posts. Generate more in Content Studio.</p>
          ) : (
            <div className="max-h-48 space-y-2 overflow-y-auto pr-1">{available.map((p) => row(p, "add"))}</div>
          )}
        </div>
      </div>
    </MkDialog>
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
