import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles, X, Plus, History, ChevronDown, MapPin } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatComposer } from "@/components/ui/chat-composer";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAssistant } from "@/lib/assistant-context";
import { capturePageSnapshot, snapshotToText } from "@/lib/page-snapshot";
import { DocumentCanvas } from "./DocumentCanvas";
import { MessageArtifacts, type AiArtifact } from "./Artifacts";

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
  const location = useLocation();
  const queryClient = useQueryClient();
  const scrollerRef = useRef<HTMLDivElement>(null);

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
  // A friendly label of where the user is (last path segment).
  const here = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() ?? "")
    .replace(/-/g, " ");

  return (
    <aside className="flex h-full w-[380px] shrink-0 flex-col border-l border-border bg-background lg:w-[420px]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">Assistant</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="ml-1 h-7 max-w-[150px] px-2 text-xs">
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
        <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" onClick={() => setOpen(false)}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Context chip */}
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <MapPin className="h-3 w-3" />
        <span className="truncate">Context: {here || "this page"}</span>
      </div>

      {/* Messages */}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-3">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <p className="text-sm font-medium">Ask about this page</p>
            <p className="text-xs text-muted-foreground">
              I see what you're looking at. Ask me to explain, analyse, or act on it.
            </p>
            <div className="mt-2 grid w-full gap-1.5">
              {["Explique cette page", "Résume les chiffres clés à l'écran", "Que dois-je faire ensuite ?"].map((s) => (
                <button
                  key={s}
                  onClick={() => handleSend(s)}
                  disabled={sending}
                  className="rounded-md border border-border bg-card px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
                >
                  {s}
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

      {/* Composer */}
      <div className="border-t border-border bg-background/80 px-3 py-2.5 backdrop-blur">
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
        <div className="max-w-[88%] whitespace-pre-wrap rounded-2xl bg-primary/10 px-3 py-2 text-sm leading-relaxed">{m.content}</div>
      </div>
    );
  }
  return (
    <div className="text-sm">
      <div className="prose prose-sm max-w-none dark:prose-invert">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
      </div>
      {artifacts.length > 0 && <MessageArtifacts artifacts={artifacts} onOpenDocument={onOpenDoc} />}
    </div>
  );
}
