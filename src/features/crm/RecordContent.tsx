import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ExternalLink, Send, Users, Hash, Bot } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { CrmObject, CrmRecord } from "./objectModel";
import { fetchAgentDeliverables, fetchMissionDeliverables, type Deliverable } from "./objectActions";

// Embeds the real module content for a record, reusing existing data without
// touching the source modules. Returns null when there's nothing to embed.
export function hasContent(slug: string): boolean {
  return ["discussions", "missions", "autonomous_agents", "documents"].includes(slug);
}

export function RecordContent({ object, record }: { object: CrmObject; record: CrmRecord }) {
  const navigate = useNavigate();
  const { workspaceSlug = "", projectSlug = "" } = useParams();
  const sid = record.source_id;

  if (!sid) return <Empty text="No linked source content." />;

  if (object.slug === "discussions") return <ChannelChat channelId={sid} />;
  if (object.slug === "missions") return <DeliverableList load={() => fetchMissionDeliverables(sid)} empty="No deliverables for this mission yet." />;
  if (object.slug === "autonomous_agents") return (
    <div className="space-y-4 p-4">
      <DeliverableList load={() => fetchAgentDeliverables(sid)} empty="This agent has no deliverables yet." />
      <Button variant="outline" size="sm" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal/${sid}/chat`)}>
        <ExternalLink className="mr-1 h-3.5 w-3.5" /> Open agent chat
      </Button>
    </div>
  );
  if (object.slug === "documents") return (
    <div className="p-4">
      <Button variant="outline" size="sm" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/office/document/${sid}`)}>
        <ExternalLink className="mr-1 h-3.5 w-3.5" /> Open document editor
      </Button>
    </div>
  );
  return <Empty text="No embedded content for this object." />;
}

// Full channel chat: live message bubbles + composer + a right sidebar with
// channel info & members. Reuses project_messages + project-inbox-post.
interface ChatMsg { id: string; channel_id: string; author_kind: "user" | "agent" | "system"; user_id: string | null; agent_id: string | null; body: string; created_at: string }

function ChannelChat({ channelId }: { channelId: string }) {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const { data: messages } = useQuery({
    queryKey: ["crm_channel_messages", channelId],
    queryFn: async () => {
      const { data } = await supabase.from("project_messages")
        .select("id, channel_id, author_kind, user_id, agent_id, body, created_at")
        .eq("channel_id", channelId).order("created_at", { ascending: true }).limit(300);
      return (data ?? []) as ChatMsg[];
    },
  });

  // Realtime updates.
  useEffect(() => {
    const ch = supabase.channel(`crm-chan-${channelId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "project_messages", filter: `channel_id=eq.${channelId}` },
        () => queryClient.invalidateQueries({ queryKey: ["crm_channel_messages", channelId] }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [channelId, queryClient]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages?.length]);

  async function send() {
    if (!text.trim() || !workspaceId || !projectId || sending) return;
    setSending(true);
    try {
      await callEdge("project-inbox-post", { workspace_id: workspaceId, project_id: projectId, channel_id: channelId, body: text.trim(), mentions: [] });
      setText("");
      queryClient.invalidateQueries({ queryKey: ["crm_channel_messages", channelId] });
    } finally { setSending(false); }
  }

  return (
    <div className="flex h-full">
      {/* Messages + composer */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {(messages ?? []).length === 0 ? <Empty text="No messages yet — say hello." />
            : (messages ?? []).map((m) => {
                const sent = m.author_kind === "user";
                return (
                  <div key={m.id} className={cn("flex", sent ? "justify-end" : "justify-start")}>
                    <div className={cn("max-w-[75%] rounded-2xl px-3 py-2 text-sm", sent ? "bg-primary/15" : m.author_kind === "agent" ? "border border-primary/30 bg-primary/5" : "bg-muted")}>
                      <div className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {m.author_kind === "agent" && <Bot className="h-3 w-3 text-primary" />}{m.author_kind}
                      </div>
                      <div className="whitespace-pre-wrap">{m.body}</div>
                    </div>
                  </div>
                );
              })}
          <div ref={endRef} />
        </div>
        <div className="flex items-center gap-2 border-t border-border p-3">
          <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())} placeholder="Message…" className="h-9" />
          <Button size="icon" className="h-9 w-9" onClick={send} disabled={sending || !text.trim()}>{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</Button>
        </div>
      </div>

      {/* Right info sidebar */}
      <ChannelInfo channelId={channelId} />
    </div>
  );
}

function ChannelInfo({ channelId }: { channelId: string }) {
  const { data: members } = useQuery({
    queryKey: ["crm_channel_members", channelId],
    queryFn: async () => {
      const { data } = await supabase.from("project_channel_members")
        .select("id, user_id, agent_id").eq("channel_id", channelId);
      return (data ?? []) as { id: string; user_id: string | null; agent_id: string | null }[];
    },
  });
  const { data: count } = useQuery({
    queryKey: ["crm_channel_msgcount", channelId],
    queryFn: async () => {
      const { count } = await supabase.from("project_messages").select("id", { count: "exact", head: true }).eq("channel_id", channelId);
      return count ?? 0;
    },
  });
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-l border-border bg-card/30 p-4 lg:flex">
      <div className="mb-3 flex items-center gap-1.5 text-sm font-medium"><Hash className="h-4 w-4 text-muted-foreground" /> Channel</div>
      <div className="mb-4 space-y-1 text-xs text-muted-foreground">
        <div>{count ?? 0} messages</div>
        <div>{(members ?? []).length} members</div>
      </div>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase text-muted-foreground"><Users className="h-3.5 w-3.5" /> Members</div>
      <div className="space-y-1">
        {(members ?? []).map((m) => (
          <div key={m.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
            <span className={cn("flex h-5 w-5 items-center justify-center rounded-full text-[10px]", m.agent_id ? "bg-primary/15 text-primary" : "bg-muted")}>{m.agent_id ? <Bot className="h-3 w-3" /> : "U"}</span>
            <span className="truncate text-xs text-muted-foreground">{m.agent_id ? "Agent" : "Member"}</span>
          </div>
        ))}
        {(members ?? []).length === 0 && <p className="text-[11px] text-muted-foreground">No members listed.</p>}
      </div>
    </aside>
  );
}

function DeliverableList({ load, empty }: { load: () => Promise<Deliverable[]>; empty: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["crm_content_deliverables", empty, Math.random().toString(36).slice(2)], queryFn: load });
  if (isLoading) return <Centered />;
  if (!data || data.length === 0) return <Empty text={empty} />;
  return (
    <div className="space-y-2 p-4">
      {data.map((d) => (
        <div key={d.id} className="rounded-lg border border-border bg-card p-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{d.kind}</span>
            <span className="text-sm font-medium">{d.name}</span>
          </div>
          {d.file_url && <a href={d.file_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><ExternalLink className="h-3 w-3" /> Open file</a>}
          {d.content && <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs">{d.content}</pre>}
        </div>
      ))}
    </div>
  );
}

function Centered() { return <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>; }
function Empty({ text }: { text: string }) { return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">{text}</div>; }
