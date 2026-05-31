import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Loader2, Send, Trash2, Copy, Check, Wand2, CalendarDays, Image } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { PublishedPostCard, PostDetailDialog, markDueAsPublished } from "./Extra";
import { VisualGenerator } from "./VisualGenerator";

const PLATFORMS = ["twitter", "linkedin", "facebook", "instagram", "threads"];
const OBJECTIVES = ["awareness", "launch", "feature", "educational", "engagement", "conversion"];
const TONES = ["professional", "casual", "bold", "technical", "playful"];

interface PostRow {
  id: string;
  platform: string;
  status: string;
  objective: string | null;
  tone: string | null;
  angle: string | null;
  content: string;
  hashtags: string[] | null;
  cta: string | null;
  source: string;
  created_at: string;
}

export function ContentStudioPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();

  const [platform, setPlatform] = useState("twitter");
  const [objective, setObjective] = useState("awareness");
  const [tone, setTone] = useState("professional");
  const [count, setCount] = useState(3);
  const [topic, setTopic] = useState("");
  const [language, setLanguage] = useState("en");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [detailPost, setDetailPost] = useState<any | null>(null);

  function refreshAll() {
    queryClient.invalidateQueries({ queryKey: ["mkt_drafts", projectId] });
    queryClient.invalidateQueries({ queryKey: ["mkt_scheduled_studio", projectId] });
    queryClient.invalidateQueries({ queryKey: ["mkt_published_studio", projectId] });
    queryClient.invalidateQueries({ queryKey: ["mkt_posts", projectId] });
  }

  const { data: drafts } = useQuery({
    queryKey: ["mkt_drafts", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("marketing_posts")
        .select("*")
        .eq("project_id", projectId!)
        .eq("status", "draft")
        .order("created_at", { ascending: false })
        .limit(50);
      return (data ?? []) as PostRow[];
    },
  });

  const { data: published } = useQuery({
    queryKey: ["mkt_published_studio", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("marketing_posts")
        .select("*")
        .eq("project_id", projectId!)
        .eq("status", "published")
        .order("published_at", { ascending: false })
        .limit(20);
      return (data ?? []) as any[];
    },
  });

  const { data: scheduled } = useQuery({
    queryKey: ["mkt_scheduled_studio", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("marketing_posts")
        .select("*")
        .eq("project_id", projectId!)
        .eq("status", "scheduled")
        .order("scheduled_at", { ascending: true })
        .limit(50);
      const list = (data ?? []) as any[];
      // Promote due scheduled posts to published, then keep only still-future ones.
      const changed = await markDueAsPublished(list);
      if (changed) {
        queryClient.invalidateQueries({ queryKey: ["mkt_published_studio", projectId] });
        return list.filter((p) => !(p.scheduled_at && new Date(p.scheduled_at).getTime() <= Date.now()));
      }
      return list;
    },
  });

  const { data: metrics } = useQuery({
    queryKey: ["mkt_metrics", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("marketing_post_metrics")
        .select("*")
        .eq("project_id", projectId!)
        .limit(300);
      return (data ?? []) as any[];
    },
  });
  const metricById = useMemo(() => new Map((metrics ?? []).map((m: any) => [m.post_id, m])), [metrics]);

  async function generate() {
    if (!workspaceId || !projectId) return;
    setGenerating(true);
    setError(null);
    try {
      await callEdge("marketing-generate", {
        workspace_id: workspaceId,
        project_id: projectId,
        platform,
        objective,
        tone,
        count,
        topic: topic || undefined,
        language,
      });
      queryClient.invalidateQueries({ queryKey: ["mkt_drafts", projectId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function publish(id: string) {
    if (!workspaceId || !projectId) return;
    setPublishing(id);
    setError(null);
    try {
      await callEdge("marketing-publish", { workspace_id: workspaceId, project_id: projectId, post_id: id });
      queryClient.invalidateQueries({ queryKey: ["mkt_drafts", projectId] });
      queryClient.invalidateQueries({ queryKey: ["mkt_published_studio", projectId] });
      queryClient.invalidateQueries({ queryKey: ["mkt_posts", projectId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPublishing(null);
    }
  }

  async function remove(id: string) {
    await supabase.from("marketing_posts").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["mkt_drafts", projectId] });
  }

  async function saveEdit(id: string, content: string) {
    await supabase.from("marketing_posts").update({ content, updated_at: new Date().toISOString() }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["mkt_drafts", projectId] });
  }

  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  }

  if (!workspaceId || !projectId) return <PageHeader title="Content Studio" />;

  return (
    <div>
      <PageHeader
        title="Content Studio"
        description="Generate social posts grounded in your SaaS — informed by your latest code scan."
      />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" /> Generate posts
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Field label="Platform">
              <Select value={platform} onChange={setPlatform} options={PLATFORMS} />
            </Field>
            <Field label="Objective">
              <Select value={objective} onChange={setObjective} options={OBJECTIVES} />
            </Field>
            <Field label="Tone">
              <Select value={tone} onChange={setTone} options={TONES} />
            </Field>
            <Field label="Count">
              <Select value={String(count)} onChange={(v) => setCount(Number(v))} options={["1", "2", "3", "4", "5", "6"]} />
            </Field>
            <Field label="Language">
              <Select value={language} onChange={setLanguage} options={["en", "fr"]} />
            </Field>
          </div>
          <Field label="Topic / angle (optional)">
            <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. our new AI cost dashboard" />
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button onClick={generate} disabled={generating}>
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Generate
            </Button>
          </div>
        </CardContent>
      </Card>

      <h2 className="mb-3 text-sm font-medium">Drafts</h2>
      {!drafts || drafts.length === 0 ? (
        <EmptyState icon={Sparkles} title="No drafts yet" description="Generate posts above. They appear here ready to edit and publish." />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {drafts.map((p) => (
            <DraftCard
              key={p.id}
              post={p}
              copied={copied === p.id}
              publishing={publishing === p.id}
              onCopy={() => copy(`${p.content}\n\n${(p.hashtags ?? []).map((h) => `#${h}`).join(" ")}`, p.id)}
              onPublish={() => publish(p.id)}
              onRemove={() => remove(p.id)}
              onSave={(c) => saveEdit(p.id, c)}
              onSchedule={() => setDetailPost(p)}
            />
          ))}
        </div>
      )}

      {scheduled && scheduled.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-sm font-medium">Scheduled posts</h2>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {scheduled.map((p) => (
              <button key={p.id} onClick={() => setDetailPost(p)} className="text-left">
                <Card className="transition-colors hover:border-primary/40">
                  <CardContent className="space-y-2 p-4">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="info">{p.platform}</Badge>
                      <Badge variant="info">scheduled</Badge>
                      <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                        <CalendarDays className="h-3.5 w-3.5" />
                        {p.scheduled_at ? new Date(p.scheduled_at).toLocaleString() : "—"}
                      </span>
                    </div>
                    <p className="line-clamp-3 text-sm">{p.content}</p>
                  </CardContent>
                </Card>
              </button>
            ))}
          </div>
        </>
      )}

      {published && published.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-sm font-medium">Published posts</h2>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {published.map((p) => (
              <PublishedPostCard key={p.id} post={p} metric={metricById.get(p.id)} />
            ))}
          </div>
        </>
      )}

      <PostDetailDialog
        post={detailPost}
        onClose={() => setDetailPost(null)}
        onChanged={() => { refreshAll(); setDetailPost(null); }}
        workspaceId={workspaceId}
        projectId={projectId}
      />
    </div>
  );
}

function DraftCard({
  post,
  copied,
  publishing,
  onCopy,
  onPublish,
  onRemove,
  onSave,
  onSchedule,
}: {
  post: PostRow;
  copied: boolean;
  publishing: boolean;
  onCopy: () => void;
  onPublish: () => void;
  onRemove: () => void;
  onSave: (content: string) => void;
  onSchedule: () => void;
}) {
  const [text, setText] = useState(post.content);
  const [visualOpen, setVisualOpen] = useState(false);
  const dirty = text !== post.content;
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="info">{post.platform}</Badge>
          {post.objective && <Badge variant="secondary">{post.objective}</Badge>}
          {post.tone && <Badge variant="outline">{post.tone}</Badge>}
          {post.source === "ai" && <Badge variant="outline" className="gap-1"><Sparkles className="h-3 w-3" /> AI</Badge>}
        </div>
        {post.angle && <p className="text-xs text-muted-foreground">Angle: {post.angle}</p>}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {(post.hashtags ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {post.hashtags!.map((h) => <span key={h} className="text-xs text-primary">#{h}</span>)}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{text.length} chars</span>
          <div className="flex items-center gap-1.5">
            {dirty && (
              <Button size="sm" variant="outline" onClick={() => onSave(text)}>Save</Button>
            )}
            <Button size="sm" variant="ghost" onClick={onCopy} title="Copy">
              {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button size="sm" variant="ghost" onClick={onRemove} title="Delete" className="text-muted-foreground hover:text-destructive">
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={() => setVisualOpen(true)} title="Create visual">
              <Image className="h-4 w-4" /> Visual
            </Button>
            <Button size="sm" variant="outline" onClick={onSchedule} title="Schedule">
              <CalendarDays className="h-4 w-4" /> Schedule
            </Button>
            <Button size="sm" onClick={onPublish} disabled={publishing}>
              {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Publish
            </Button>
          </div>
        </div>
      </CardContent>
      <VisualGenerator
        open={visualOpen}
        onOpenChange={setVisualOpen}
        initialContent={{
          title: text.split("\n")[0]?.slice(0, 80),
          body: text,
          handle: post.platform ? `@${post.platform}` : undefined,
        }}
      />
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm capitalize"
    >
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
