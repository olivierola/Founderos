import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Hash, Lock, Loader2, Send, Bot, AtSign, Info, Users, Paperclip, Link2, Image as ImageIcon, X,
  Plus, Trash2,
} from "lucide-react";
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
  created_by: string | null;
}
interface Message {
  id: string; channel_id: string; author_kind: "user" | "agent" | "system";
  user_id: string | null; agent_id: string | null; body: string;
  mentions: string[]; created_at: string;
}
interface AgentLite { id: string; name: string; avatar_emoji: string | null; accent_color: string | null }

const URL_RE = /(https?:\/\/[^\s]+)/g;
const IMG_RE = /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i;

function relTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

export function PmInboxPage() {
  const { projectId, workspaceId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const channelParam = searchParams.get("channel");
  const wantNew = searchParams.get("new") === "1";
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (wantNew) { setCreateOpen(true); setSearchParams({}, { replace: true }); }
  }, [wantNew, setSearchParams]);

  // Ensure #general exists, then resolve the active channel.
  const { data: channels } = useQuery({
    queryKey: ["pm_channels", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      let { data } = await supabase
        .from("project_channels")
        .select("id, name, description, is_private, is_default, created_at, created_by")
        .eq("project_id", projectId!)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: true });
      if ((!data || data.length === 0) && workspaceId && user) {
        await supabase.from("project_channels").insert({
          workspace_id: workspaceId, project_id: projectId, name: "general",
          description: "Team-wide channel", is_default: true, created_by: user.id,
        });
        ({ data } = await supabase
          .from("project_channels")
          .select("id, name, description, is_private, is_default, created_at, created_by")
          .eq("project_id", projectId!)
          .order("is_default", { ascending: false })
          .order("created_at", { ascending: true }));
      }
      return (data ?? []) as Channel[];
    },
  });

  const active = useMemo(
    () => channels?.find((c) => c.id === channelParam) ?? channels?.[0] ?? null,
    [channels, channelParam],
  );

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full flex-col">
      {active ? (
        <ChannelView key={active.id} channel={active} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {channels ? "Create a channel to get started." : <Loader2 className="h-4 w-4 animate-spin" />}
        </div>
      )}
      <CreateChannelDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => { queryClient.invalidateQueries({ queryKey: ["pm_channels", projectId] }); queryClient.invalidateQueries({ queryKey: ["sidebar_pm_channels", projectId] }); setSearchParams({ channel: id }); }}
      />
    </div>
  );
}

type DetailTab = "about" | "members" | "files" | "links" | "images";

function ChannelView({ channel }: { channel: Channel }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showMention, setShowMention] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab | null>("about");
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Resizable right detail sidebar (persisted), dragged from its left edge.
  const [detailWidth, setDetailWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("pm_inbox_detail_width"));
    return saved >= 280 && saved <= 640 ? saved : 384;
  });
  function startResizeDetail(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = detailWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(640, Math.max(280, startW + (startX - ev.clientX)));
      setDetailWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      setDetailWidth((w) => { localStorage.setItem("pm_inbox_detail_width", String(w)); return w; });
    };
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const { data: messages } = useQuery({
    queryKey: ["pm_messages", channel.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("project_messages")
        .select("id, channel_id, author_kind, user_id, agent_id, body, mentions, created_at")
        .eq("channel_id", channel.id)
        .order("created_at", { ascending: true })
        .limit(300);
      return (data ?? []) as Message[];
    },
  });

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
  const agentById = useMemo(() => Object.fromEntries((agents ?? []).map((a) => [a.id, a])), [agents]);

  // Realtime stream.
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

  // Shared links / images extracted from message bodies.
  const { links, images } = useMemo(() => {
    const links: { url: string; at: string }[] = [];
    const images: { url: string; at: string }[] = [];
    for (const m of messages ?? []) {
      const urls = m.body.match(URL_RE) ?? [];
      for (const u of urls) (IMG_RE.test(u) ? images : links).push({ url: u, at: m.created_at });
    }
    return { links, images };
  }, [messages]);

  function resolveMentions(text: string): string[] {
    const ids: string[] = [];
    const compact = text.replace(/\s+/g, "").toLowerCase();
    for (const a of agents ?? []) {
      const handle = a.name.replace(/\s+/g, "").toLowerCase();
      if (compact.includes(`@${handle}`) || text.toLowerCase().includes(`@${a.name.toLowerCase()}`)) ids.push(a.id);
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
        workspace_id: workspaceId, project_id: projectId, channel_id: channel.id, body: text, mentions,
      });
      queryClient.invalidateQueries({ queryKey: ["pm_messages", channel.id] });
    } finally {
      setSending(false);
    }
  }

  function insertMention(a: AgentLite) {
    setInput((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}@${a.name} `);
    setShowMention(false);
  }

  const detailTabs: { key: DetailTab; label: string; icon: typeof Info }[] = [
    { key: "about", label: "About", icon: Info },
    { key: "members", label: "Members", icon: Users },
    { key: "files", label: "Files", icon: Paperclip },
    { key: "links", label: "Links", icon: Link2 },
    { key: "images", label: "Images", icon: ImageIcon },
  ];

  return (
    <div className="flex min-h-0 flex-1">
      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Channel header */}
        <div className="flex h-12 items-center gap-2 border-b border-border px-4">
          {channel.is_private ? <Lock className="h-4 w-4 text-muted-foreground" /> : <Hash className="h-4 w-4 text-muted-foreground" />}
          <span className="text-sm font-semibold">{channel.name}</span>
          {channel.description && <span className="truncate text-xs text-muted-foreground">· {channel.description}</span>}
          <button
            onClick={() => setDetailTab((t) => (t ? null : "about"))}
            className={cn("ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground", detailTab && "bg-secondary text-foreground")}
            title="Channel details"
          >
            <Info className="h-4 w-4" />
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollerRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
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
            <button onClick={() => setShowMention((s) => !s)} title="Mention an agent" className="mb-1 rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
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
      </div>

      {/* Right detail sidebar (resizable) */}
      {detailTab && (
        <aside className="relative flex shrink-0 flex-col border-l border-border bg-secondary/10" style={{ width: detailWidth }}>
          {/* Drag handle on the left edge */}
          <div
            onMouseDown={startResizeDetail}
            className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-primary/30"
            title="Drag to resize"
          />
          <div className="flex h-12 items-center justify-between border-b border-border px-3">
            <span className="text-sm font-semibold">Details</span>
            <button onClick={() => setDetailTab(null)} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"><X className="h-4 w-4" /></button>
          </div>
          <div className="flex gap-0.5 border-b border-border px-2 py-1.5">
            {detailTabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setDetailTab(t.key)}
                title={t.label}
                className={cn("flex flex-1 items-center justify-center rounded-md py-1.5 transition-colors", detailTab === t.key ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")}
              >
                <t.icon className="h-4 w-4" />
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
            <DetailPanel tab={detailTab} channel={channel} agents={agents ?? []} agentById={agentById} links={links} images={images} />
          </div>
        </aside>
      )}
    </div>
  );
}

function DetailPanel({
  tab, channel, agents, agentById, links, images,
}: {
  tab: DetailTab;
  channel: Channel;
  agents: AgentLite[];
  agentById: Record<string, AgentLite>;
  links: { url: string; at: string }[];
  images: { url: string; at: string }[];
}) {
  if (tab === "about") {
    return (
      <div className="space-y-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Channel</div>
          <div className="mt-1 flex items-center gap-1.5 font-medium">
            {channel.is_private ? <Lock className="h-3.5 w-3.5" /> : <Hash className="h-3.5 w-3.5" />}{channel.name}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Description</div>
          <p className="mt-1 text-muted-foreground">{channel.description || "No description."}</p>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Visibility</div>
          <p className="mt-1 text-muted-foreground">{channel.is_private ? "Private — invite only" : "Public — all project members"}</p>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Created</div>
          <p className="mt-1 text-muted-foreground">{new Date(channel.created_at).toLocaleDateString()}</p>
        </div>
      </div>
    );
  }

  if (tab === "members") {
    return <MembersTab channel={channel} agents={agents} agentById={agentById} />;
  }

  if (tab === "links") {
    return links.length === 0 ? <Empty label="No links shared yet." /> : (
      <ul className="space-y-2">
        {links.map((l, i) => (
          <li key={i}>
            <a href={l.url} target="_blank" rel="noreferrer" className="flex items-start gap-2 text-xs text-primary hover:underline">
              <Link2 className="mt-0.5 h-3 w-3 shrink-0" /><span className="truncate">{l.url}</span>
            </a>
          </li>
        ))}
      </ul>
    );
  }

  if (tab === "images") {
    return images.length === 0 ? <Empty label="No images shared yet." /> : (
      <div className="grid grid-cols-2 gap-2">
        {images.map((im, i) => (
          <a key={i} href={im.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-border">
            <img src={im.url} alt="" className="h-20 w-full object-cover" />
          </a>
        ))}
      </div>
    );
  }

  // files — we don't have uploads yet; list non-image links as "files" hint.
  return <Empty label="File uploads are coming soon. Paste a link to share a file for now." />;
}

function Empty({ label }: { label: string }) {
  return <p className="py-6 text-center text-xs text-muted-foreground">{label}</p>;
}

interface MemberRow { id: string; user_id: string | null; agent_id: string | null }
interface PersonLite { user_id: string; name: string }

// Members tab: list humans + agents in the channel; add/remove based on
// permissions. Manage rights = workspace owner/admin OR the channel creator.
function MembersTab({
  channel, agents, agentById,
}: {
  channel: Channel;
  agents: AgentLite[];
  agentById: Record<string, AgentLite>;
}) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: myRole } = useQuery({
    queryKey: ["pm_my_ws_role", workspaceId, user?.id],
    enabled: !!workspaceId && !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("workspace_members").select("role")
        .eq("workspace_id", workspaceId!).eq("user_id", user!.id).maybeSingle();
      return (data?.role ?? "viewer") as string;
    },
  });
  const canManage = myRole === "owner" || myRole === "admin" || channel.created_by === user?.id;

  // Membership rows (drive both private-channel ACL and agent membership).
  const { data: memberRows } = useQuery({
    queryKey: ["pm_channel_member_rows", channel.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("project_channel_members")
        .select("id, user_id, agent_id")
        .eq("channel_id", channel.id);
      return (data ?? []) as MemberRow[];
    },
  });
  const memberUserIds = new Set((memberRows ?? []).filter((r) => r.user_id).map((r) => r.user_id!));
  const memberAgentIds = new Set((memberRows ?? []).filter((r) => r.agent_id).map((r) => r.agent_id!));

  // Workspace people (names) for display + invite candidates.
  const { data: people } = useQuery({
    queryKey: ["pm_ws_people", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase
        .from("workspace_members")
        .select("user_id, profiles:profiles(full_name, email)")
        .eq("workspace_id", workspaceId!)
        .limit(200);
      return (data ?? []).map((r: any) => ({ user_id: r.user_id, name: r.profiles?.full_name || r.profiles?.email || "Member" })) as PersonLite[];
    },
  });
  const personById = useMemo(() => Object.fromEntries((people ?? []).map((p) => [p.user_id, p.name])), [people]);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["pm_channel_member_rows", channel.id] });
  }

  async function addUser(userId: string) {
    await supabase.from("project_channel_members").insert({ channel_id: channel.id, user_id: userId });
    invalidate();
  }
  async function addAgent(agentId: string) {
    await supabase.from("project_channel_members").insert({ channel_id: channel.id, agent_id: agentId });
    invalidate();
  }
  async function removeRow(id: string) {
    await supabase.from("project_channel_members").delete().eq("id", id);
    invalidate();
  }

  // Displayed people: for private channels, the explicit member rows; for public
  // channels, everyone in the workspace (no per-channel rows needed).
  const peopleRows = channel.is_private
    ? (memberRows ?? []).filter((r) => r.user_id)
    : (people ?? []).map((p) => ({ id: `ws:${p.user_id}`, user_id: p.user_id, agent_id: null } as MemberRow));
  const agentRows = (memberRows ?? []).filter((r) => r.agent_id);

  const candidatePeople = (people ?? []).filter((p) => p.user_id !== user?.id && !memberUserIds.has(p.user_id));
  const candidateAgents = agents.filter((a) => !memberAgentIds.has(a.id));

  return (
    <div className="space-y-5">
      {/* People */}
      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
          People{channel.is_private ? "" : " · everyone in the workspace"}
        </div>
        <div className="space-y-1">
          {peopleRows.length === 0 ? <p className="text-xs text-muted-foreground">No members.</p> :
            peopleRows.map((r) => {
              const name = personById[r.user_id!] ?? "Member";
              return (
                <div key={r.id} className="group flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded bg-secondary text-[10px] font-semibold">{name.slice(0, 1).toUpperCase()}</span>
                  <span className="truncate text-xs">{name}{r.user_id === user?.id && " (you)"}</span>
                  {canManage && channel.is_private && r.user_id !== user?.id && (
                    <button onClick={() => removeRow(r.id)} title="Remove" className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </button>
                  )}
                </div>
              );
            })}
        </div>
        {/* Invite people (private channels only — public = everyone already) */}
        {canManage && channel.is_private && candidatePeople.length > 0 && (
          <details className="mt-2 rounded-md border border-border bg-background/50">
            <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
              <Plus className="h-3 w-3" /> Add people
            </summary>
            <div className="max-h-40 overflow-y-auto px-1 pb-1">
              {candidatePeople.map((p) => (
                <button key={p.user_id} onClick={() => addUser(p.user_id)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-secondary">
                  <span className="flex h-5 w-5 items-center justify-center rounded bg-secondary text-[9px] font-semibold">{p.name.slice(0, 1).toUpperCase()}</span>
                  {p.name}
                </button>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* Agents */}
      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">Agents in this channel</div>
        <div className="space-y-1">
          {agentRows.length === 0 ? <p className="text-xs text-muted-foreground">No agents added. @mention one, or add it below.</p> :
            agentRows.map((r) => {
              const a = agentById[r.agent_id!];
              return (
                <div key={r.id} className="group flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded text-xs" style={{ backgroundColor: (a?.accent_color ?? "#2F2FE4") + "22" }}>{a?.avatar_emoji ?? "🤖"}</span>
                  <span className="truncate text-xs">{a?.name ?? "Agent"}</span>
                  <Bot className="h-3 w-3 text-primary" />
                  {canManage && (
                    <button onClick={() => removeRow(r.id)} title="Remove" className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">
                      <Trash2 className="h-3 w-3 text-destructive" />
                    </button>
                  )}
                </div>
              );
            })}
        </div>
        {canManage && candidateAgents.length > 0 && (
          <details className="mt-2 rounded-md border border-border bg-background/50">
            <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
              <Plus className="h-3 w-3" /> Add agent
            </summary>
            <div className="max-h-40 overflow-y-auto px-1 pb-1">
              {candidateAgents.map((a) => (
                <button key={a.id} onClick={() => addAgent(a.id)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-secondary">
                  <span className="flex h-5 w-5 items-center justify-center rounded text-[10px]" style={{ backgroundColor: (a.accent_color ?? "#2F2FE4") + "22" }}>{a.avatar_emoji ?? "🤖"}</span>
                  {a.name}
                </button>
              ))}
            </div>
          </details>
        )}
        <p className="mt-2 text-[10px] text-muted-foreground">@mention any agent in the channel to get a reply.</p>
        {!canManage && <p className="mt-1 text-[10px] text-muted-foreground">You need admin or channel-owner rights to manage members.</p>}
      </div>
    </div>
  );
}

function MessageRow({ m, agent, mine }: { m: Message; agent?: AgentLite; mine: boolean }) {
  const isAgent = m.author_kind === "agent";
  const name = isAgent ? (agent?.name ?? "Agent") : mine ? "You" : "Teammate";
  const emoji = isAgent ? (agent?.avatar_emoji ?? "🤖") : null;
  const accent = agent?.accent_color ?? "#2F2FE4";

  const avatar = (
    <div
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm"
      style={{ backgroundColor: isAgent ? accent + "22" : "hsl(var(--secondary))", color: isAgent ? accent : undefined }}
    >
      {emoji ?? <span className="text-xs font-semibold">{name.slice(0, 1).toUpperCase()}</span>}
    </div>
  );

  // My own messages: right-aligned with a filled bubble.
  if (mine) {
    return (
      <div className="flex items-start justify-end gap-2.5">
        <div className="flex min-w-0 max-w-[75%] flex-col items-end">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">{relTime(m.created_at)}</span>
            <span className="text-sm font-medium">You</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-primary/85 px-3 py-2 text-sm leading-relaxed text-primary-foreground">
            {m.body}
          </p>
        </div>
        {avatar}
      </div>
    );
  }

  // Others (teammates / agents): left-aligned with a subtle bubble.
  return (
    <div className="flex items-start gap-2.5">
      {avatar}
      <div className="min-w-0 max-w-[75%]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          {isAgent && <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary"><Bot className="h-2.5 w-2.5" /> agent</span>}
          <span className="text-[10px] text-muted-foreground">{relTime(m.created_at)}</span>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words rounded-2xl rounded-tl-sm bg-secondary/60 px-3 py-2 text-sm leading-relaxed text-foreground/90">
          {m.body}
        </p>
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
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="deploys" autoFocus className="flex-1 bg-transparent py-2 text-sm focus:outline-none" />
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
