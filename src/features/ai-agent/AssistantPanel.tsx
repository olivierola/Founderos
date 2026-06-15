import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Bot, X, Plus, History, ChevronDown, FileText, BarChart3, ArrowRight, Sparkles,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatComposer } from "@/components/ui/chat-composer";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAssistant } from "@/lib/assistant-context";
import { capturePageSnapshot, snapshotToText } from "@/lib/page-snapshot";
import { DocumentCanvas } from "./DocumentCanvas";
import { MessageArtifacts, type AiArtifact } from "./Artifacts";

const MIN_W = 340;
const MAX_W = 720;
const DEFAULT_W = 400;

// Quick-start actions shown on the empty state as actionable cards.
const QUICK_ACTIONS = [
  { icon: Sparkles, title: "Explique cette page", subtitle: "Ce que je regarde, en clair", prompt: "Explique cette page" },
  { icon: BarChart3, title: "Résume les chiffres clés", subtitle: "Les métriques à l'écran", prompt: "Résume les chiffres clés à l'écran" },
  { icon: FileText, title: "Que dois-je faire ensuite ?", subtitle: "Prochaines actions recommandées", prompt: "Que dois-je faire ensuite ?" },
] as const;

interface AiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: { provider?: string; model?: string };
  created_at: string;
}

interface Convo { id: string; title: string | null; updated_at: string }

export function AssistantPanel() {
  const { open, setOpen } = useAssistant();
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Resizable width (persisted), dragged from the left edge.
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("assistant_width"));
    return saved >= MIN_W && saved <= MAX_W ? saved : DEFAULT_W;
  });
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(MAX_W, Math.max(MIN_W, startW + (startX - ev.clientX)));
      setWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      setWidth((w) => { localStorage.setItem("assistant_width", String(w)); return w; });
    };
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width]);

  const [convoId, setConvoId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docMarkdown, setDocMarkdown] = useState<string | null>(null);
  const [docTitle, setDocTitle] = useState<string | undefined>(undefined);

  const { data: conversations } = useQuery({
    queryKey: ["assistant_convos", projectId],
    enabled: open && !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_conversations")
        .select("id, title, updated_at")
        .eq("project_id", projectId!)
        .order("updated_at", { ascending: false })
        .limit(30);
      return (data ?? []) as Convo[];
    },
  });

  const { data: messages } = useQuery({
    queryKey: ["ai_messages", convoId],
    enabled: !!convoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_messages").select("*")
        .eq("conversation_id", convoId!)
        .order("created_at", { ascending: true });
      return (data ?? []) as AiMessage[];
    },
  });

  const { data: artifacts } = useQuery({
    queryKey: ["ai_artifacts", convoId],
    enabled: !!convoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_artifacts")
        .select("id, message_id, kind, title, content, data, language, created_at")
        .eq("conversation_id", convoId!)
        .order("created_at", { ascending: true });
      return (data ?? []) as AiArtifact[];
    },
  });

  const artifactsByMessage = useMemo(() => {
    const map: Record<string, AiArtifact[]> = {};
    for (const a of artifacts ?? []) (map[a.message_id] ??= []).push(a);
    return map;
  }, [artifacts]);

  useEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [messages?.length, sending]);

  async function handleSend(text?: string) {
    const content = (text ?? input).trim();
    if (!content || !workspaceId || !projectId || sending) return;
    setSending(true);
    setError(null);
    setInput("");
    try {
      // Capture what the user is looking at right now as primary context.
      const snapshot = snapshotToText(capturePageSnapshot());
      const res = await callEdge<{ conversation_id: string }>("ai-agent-chat", {
        workspace_id: workspaceId,
        project_id: projectId,
        conversation_id: convoId,
        message: content,
        page_context: snapshot,
      });
      if (!convoId) setConvoId(res.conversation_id);
      await queryClient.invalidateQueries({ queryKey: ["assistant_convos", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["ai_messages", res.conversation_id] });
      await queryClient.invalidateQueries({ queryKey: ["ai_artifacts", res.conversation_id] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  if (!open) return null;

  const isEmpty = !convoId || !messages || messages.length === 0;
  const currentConvo = conversations?.find((c) => c.id === convoId);

  return (
    <aside
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-background text-foreground"
      style={{ width }}
    >
      {/* Resize handle (left edge). */}
      <div
        onMouseDown={startResize}
        className="absolute left-0 top-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/40"
        title="Drag to resize"
      />
      {/* Header — h-14 to align its bottom border with the app topbar. */}
      <div className="flex h-14 items-center gap-2 border-b border-border px-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/20 text-primary">
          <Bot className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold">Assistant</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="ml-1 h-7 max-w-[150px] px-2 text-xs text-muted-foreground hover:text-foreground">
              <History className="mr-1 h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{currentConvo?.title ?? "New chat"}</span>
              <ChevronDown className="ml-1 h-3 w-3 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuItem onClick={() => { setConvoId(null); setError(null); }}>
              <Plus className="mr-2 h-3.5 w-3.5" /> New chat
            </DropdownMenuItem>
            {(conversations ?? []).map((c) => (
              <DropdownMenuItem key={c.id} onClick={() => setConvoId(c.id)}>
                <span className="truncate">{c.title || "Untitled"}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon" variant="ghost" className="ml-auto h-7 w-7 text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Messages */}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-3">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center">
            <AssistantAvatar />
            <p className="text-sm font-medium text-foreground">Ask about this page</p>
            <p className="text-xs text-muted-foreground">
              I see what you're looking at. Ask me to explain, analyse, or act on it.
            </p>
            <div className="mt-2 grid w-full gap-2 text-left">
              {QUICK_ACTIONS.map((a) => (
                <button
                  key={a.prompt}
                  onClick={() => handleSend(a.prompt)}
                  disabled={sending}
                  className="group flex items-center gap-3 rounded-lg border border-border bg-card/40 p-3 transition-colors hover:border-primary/40 hover:bg-secondary disabled:opacity-50"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <a.icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{a.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{a.subtitle}</span>
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3 py-3">
            {messages!.map((m) => (
              <Bubble
                key={m.id}
                m={m}
                artifacts={artifactsByMessage[m.id] ?? []}
                onOpenDoc={(md, title) => { setDocTitle(title); setDocMarkdown(md); }}
              />
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
              </div>
            )}
          </div>
        )}
      </div>

      {/* Composer — no top separator, blends into the dark panel. */}
      <div className="px-3 py-2.5">
        <ChatComposer
          value={input}
          onValueChange={setInput}
          onSubmit={({ message }) => handleSend(message)}
          loading={sending}
          placeholder="Ask about this page…"
        />
        {error && <p className="mt-1.5 text-center text-[11px] text-destructive">{error}</p>}
      </div>

      <DocumentCanvas
        open={docMarkdown !== null}
        onOpenChange={(o) => { if (!o) { setDocMarkdown(null); setDocTitle(undefined); } }}
        initialMarkdown={docMarkdown ?? ""}
        title={docTitle}
      />
    </aside>
  );
}

// A friendly gradient robot avatar shown on the empty state.
function AssistantAvatar() {
  return (
    <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 shadow-lg shadow-violet-500/30">
      <Bot className="h-7 w-7 text-white" />
      <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-400 ring-2 ring-background">
        <span className="h-1.5 w-1.5 rounded-full bg-white" />
      </span>
    </div>
  );
}

function Bubble({
  m, artifacts, onOpenDoc,
}: {
  m: AiMessage;
  artifacts: AiArtifact[];
  onOpenDoc: (md: string, title?: string) => void;
}) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] whitespace-pre-wrap rounded-2xl bg-primary/15 px-3 py-2 text-sm leading-relaxed text-foreground">{m.content}</div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-500 text-white">
        <Bot className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "prose prose-sm max-w-none dark:prose-invert leading-relaxed",
            "prose-p:my-2 prose-p:text-foreground/90 prose-p:leading-relaxed",
            "prose-headings:text-foreground prose-headings:font-semibold prose-headings:mb-1 prose-headings:mt-3",
            "prose-strong:text-foreground prose-a:text-primary prose-a:font-medium",
            "prose-ul:my-2 prose-ul:space-y-1.5 prose-ol:my-2 prose-ol:space-y-1.5",
            "prose-li:my-0 prose-li:marker:text-muted-foreground",
            "prose-code:rounded prose-code:bg-secondary prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.8em] prose-code:before:content-none prose-code:after:content-none",
            "prose-pre:bg-secondary prose-pre:text-foreground prose-hr:border-border",
          )}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Render list items as compact rows with a clear bullet so the
              // model's quick-action lists read as a structured list, not a wall.
              li: ({ children, ...props }) => (
                <li {...props} className="flex gap-2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
                  <span className="min-w-0 flex-1">{children}</span>
                </li>
              ),
              ul: ({ children }) => <ul className="my-2 list-none space-y-1.5 pl-0">{children}</ul>,
            }}
          >
            {m.content}
          </ReactMarkdown>
        </div>
        {artifacts.length > 0 && <MessageArtifacts artifacts={artifacts} onOpenDocument={onOpenDoc} />}
      </div>
    </div>
  );
}
