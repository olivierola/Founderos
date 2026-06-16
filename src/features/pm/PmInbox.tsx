import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Hash, Lock, Plus, Loader2, Send, Bot, Trash2, X, AtSign,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

interface Channel {
  id: string; name: string; description: string | null;
  is_private: boolean; is_default: boolean; created_at: string;
}
interface Message {
  id: string; channel_id: string; author_kind: "user" | "agent" | "system";
  user_id: string | null; agent_id: string | null; body: string;
  mentions: string[]; created_at: string;
}
interface AgentLite { id: string; name: string; avatar_emoji: string | null; accent_color: string | null }

function relTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

export function PmInboxPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Ensure a default #general channel exists, then list channels.
  const { data: channels, isLoading } = useQuery({
    queryKey: ["pm_channels", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      let { data } = await supabase
        .from("project_channels")
        .select("id, name, description, is_private, is_default, created_at")
        .eq("project_id", projectId!)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: true });
      if ((!data || data.length === 0) && workspaceId && user) {
        // Seed #general on first visit.
        await supabase.from("project_channels").insert({
          workspace_id: workspaceId, project_id: projectId, name: "general",
          description: "Team-wide channel", is_default: true, created_by: user.id,
        });
        ({ data } = await supabase
          .from("project_channels")
          .select("id, name, description, is_private, is_default, created_at")
          .eq("project_id", projectId!)
          .order("is_default", { ascending: false })
          .order("created_at", { ascending: true }));
      }
      return (data ?? []) as Channel[];
    },
  });

  useEffect(() => {
    if (!activeId && channels && channels.length > 0) setActiveId(channels[0].id);
  }, [channels, activeId]);

  const active = channels?.find((c) => c.id === activeId) ?? null;

  return (
    <div className="space-y-4">
      <PageHeader title="Inbox" description="Team & agent chatrooms for this project. @mention an agent to bring it in." />
      <div className="flex h-[calc(100vh-12rem)] overflow-hidden rounded-xl border border-border">
        {/* Channel rail */}
        <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-secondary/20">
          <div className="flex items-center justify-between px-3 py-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Channels</span>
            <button onClick={() => setCreateOpen(true)} title="New channel" className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {isLoading ? (
              <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
            ) : (
              (channels ?? []).map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    activeId === c.id ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )}
                >
                  {c.is_private ? <Lock className="h-3.5 w-3.5 shrink-0" /> : <Hash className="h-3.5 w-3.5 shrink-0" />}
                  <span className="truncate">{c.name}</span>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Conversation */}
        <div className="flex min-w-0 flex-1 flex-col">
          {active ? (
            <ChannelView channel={active} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Select a channel</div>
          )}
        </div>
      </div>

      <CreateChannelDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => { queryClient.invalidateQueries({ queryKey: ["pm_channels", projectId] }); setActiveId(id); }}
      />
    </div>
  );
}

function ChannelView({ channel }: { channel: Channel }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showMention, setShowMention] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const { data: messages } = useQuery({
    queryKey: ["pm_messages", channel.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("project_messages")
        .select("id, channel_id, author_kind, user_id, agent_id, body, mentions, created_at")
        .eq("channel_id", channel.id)
        .order("created_at", { ascending: true })
        .limit(200);
      return (data ?? []) as Message[];
    },
  });

  // Project agents (for @mention + author display).
  const { data: agents } = useQuery({
    queryKey: ["pm_inbox_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agents")
        .select("id, name, avatar_emoji, accent_color")
        .eq("project_id", projectId!)
        .eq("is_archived", false)
        .eq("chat_enabled", true);
      return (data ?? []) as AgentLite[];
    },
  });
  const agentById = useMemo(() => {
    const m: Record<string, AgentLite> = {};
    (agents ?? []).forEach((a) => { m[a.id] = a; });
    return m;
  }, [agents]);

  // Realtime: push new messages into the cache as they arrive.
  useEffect(() => {
    const ch = supabase
      .channel(`pm_messages:${channel.id}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "project_messages", filter: `channel_id=eq.${channel.id}` },
        (payload) => {
          queryClient.setQueryData(["pm_messages", channel.id], (old: Message[] | undefined) => {
            const next = payload.new as Message;
            if ((old ?? []).some((m) => m.id === next.id)) return old;
            return [...(old ?? []), next];
          });
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [channel.id, queryClient]);

  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [messages?.length]);

  // Resolve @mentions in the text to agent ids (case-insensitive, name match).
  function resolveMentions(text: string): string[] {
    const ids: string[] = [];
    for (const a of agents ?? []) {
      const handle = a.name.replace(/\s+/g, "");
      const re = new RegExp(`@${handle}\\b`, "i");
      if (re.test(text.replace(/\s+/g, "")) || text.toLowerCase().includes(`@${a.name.toLowerCase()}`)) ids.push(a.id);
    }
    return ids;
  }

  async function send() {
    const text = input.trim();
    if (!text || !workspaceId || !projectId || sending) return;
    setSending(true);
    try {
      const mentions = resolveMentions(text);
      setInput("");
      await callEdge("project-inbox-post", {
        workspace_id: workspaceId, project_id: projectId, channel_id: channel.id,
        body: text, mentions,
      });
      // Realtime delivers the row; refetch as a fallback.
      queryClient.invalidateQueries({ queryKey: ["pm_messages", channel.id] });
    } finally {
      setSending(false);
    }
  }

  function insertMention(a: AgentLite) {
    setInput((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}@${a.name} `);
    setShowMention(false);
  }

  return (
    <>
      {/* Channel header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        {channel.is_private ? <Lock className="h-4 w-4 text-muted-foreground" /> : <Hash className="h-4 w-4 text-muted-foreground" />}
        <span className="text-sm font-semibold">{channel.name}</span>
        {channel.description && <span className="truncate text-xs text-muted-foreground">· {channel.description}</span>}
      </div>

      {/* Messages */}
      <div ref={scrollerRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {(messages ?? []).length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <Hash className="h-6 w-6 opacity-50" />
            This is the start of #{channel.name}. Say hi — or @mention an agent.
          </div>
        ) : (
          (messages ?? []).map((m) => (
            <MessageRow key={m.id} m={m} agent={m.agent_id ? agentById[m.agent_id] : undefined} mine={m.user_id === user?.id} />
          ))
        )}
      </div>

      {/* Composer */}
      <div className="relative border-t border-border p-3">
        {showMention && (agents ?? []).length > 0 && (
          <div className="absolute bottom-full left-3 mb-1 w-64 overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
            <div className="border-b border-border px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">Mention an agent</div>
            <div className="max-h-48 overflow-y-auto">
              {(agents ?? []).map((a) => (
                <button key={a.id} onClick={() => insertMention(a)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary">
                  <span className="flex h-6 w-6 items-center justify-center rounded text-sm" style={{ backgroundColor: (a.accent_color ?? "#2F2FE4") + "22" }}>{a.avatar_emoji ?? "🤖"}</span>
                  {a.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-end gap-2">
          <button
            onClick={() => setShowMention((s) => !s)}
            title="Mention an agent"
            className="mb-1 rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <AtSign className="h-4 w-4" />
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            rows={1}
            placeholder={`Message #${channel.name}…  (@ to mention an agent)`}
            className="max-h-32 min-h-[38px] flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <Button onClick={send} disabled={sending || !input.trim()} className="mb-0.5">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </>
  );
}

function MessageRow({ m, agent, mine }: { m: Message; agent?: AgentLite; mine: boolean }) {
  const isAgent = m.author_kind === "agent";
  const name = isAgent ? (agent?.name ?? "Agent") : mine ? "You" : "Teammate";
  const emoji = isAgent ? (agent?.avatar_emoji ?? "🤖") : null;
  const accent = agent?.accent_color ?? "#2F2FE4";
  return (
    <div className="flex items-start gap-2.5">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm"
        style={{ backgroundColor: isAgent ? accent + "22" : "hsl(var(--secondary))", color: isAgent ? accent : undefined }}
      >
        {emoji ?? <span className="text-xs font-semibold">{name.slice(0, 1).toUpperCase()}</span>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          {isAgent && <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary"><Bot className="h-2.5 w-2.5" /> agent</span>}
          <span className="text-[10px] text-muted-foreground">{relTime(m.created_at)}</span>
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{m.body}</p>
      </div>
    </div>
  );
}

function CreateChannelDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [saving, setSaving] = useState(false);

  async function create() {
    const slug = name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (!slug || !workspaceId || !projectId || !user) return;
    setSaving(true);
    try {
      const { data, error } = await supabase
        .from("project_channels")
        .insert({
          workspace_id: workspaceId, project_id: projectId,
          name: slug, description: description.trim() || null,
          is_private: isPrivate, created_by: user.id,
        })
        .select("id")
        .single();
      if (error) { alert(error.message); return; }
      // Private channel: add the creator as the first member.
      if (isPrivate && data) {
        await supabase.from("project_channel_members").insert({ channel_id: data.id, user_id: user.id });
      }
      setName(""); setDescription(""); setIsPrivate(false);
      onOpenChange(false);
      if (data) onCreated(data.id);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New channel</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
            <div className="flex items-center gap-1 rounded-md border border-input bg-background px-2">
              <Hash className="h-4 w-4 text-muted-foreground" />
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="deploys"
                autoFocus
                className="flex-1 bg-transparent py-2 text-sm focus:outline-none"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Description (optional)</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's this channel for?" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} className="h-4 w-4 accent-primary" />
            <Lock className="h-4 w-4 text-muted-foreground" /> Private channel (invite-only)
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={create} disabled={saving || !name.trim()}>
              {saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Create
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
