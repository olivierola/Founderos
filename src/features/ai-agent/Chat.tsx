import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Sparkles, Send, MessageSquare } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface Conversation {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface AiMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: { provider?: string; model?: string };
  created_at: string;
}

const STARTERS = [
  "What's my MRR and how did it evolve?",
  "Which services in my stack look risky?",
  "Where can I cut LLM costs?",
  "Summarize my latest scan in 3 bullets.",
];

export function AiChatPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const [currentConvoId, setCurrentConvoId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Prefill from a prompt template (?prompt=...), then clear the param.
  useEffect(() => {
    const p = searchParams.get("prompt");
    if (p) {
      setInput(p);
      setCurrentConvoId(null);
      searchParams.delete("prompt");
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: conversations } = useQuery({
    queryKey: ["ai_conversations", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_conversations")
        .select("id, title, created_at, updated_at")
        .eq("project_id", projectId!)
        .order("updated_at", { ascending: false })
        .limit(50);
      return (data ?? []) as Conversation[];
    },
  });

  const { data: messages } = useQuery({
    queryKey: ["ai_messages", currentConvoId],
    enabled: !!currentConvoId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_messages")
        .select("*")
        .eq("conversation_id", currentConvoId!)
        .order("created_at", { ascending: true });
      return (data ?? []) as AiMessage[];
    },
  });

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [messages?.length, sending]);

  async function handleSend(text?: string) {
    const content = (text ?? input).trim();
    if (!content || !workspaceId || !projectId) return;
    setSending(true);
    setError(null);
    setInput("");
    try {
      const res = await callEdge<{ conversation_id: string }>("ai-agent-chat", {
        workspace_id: workspaceId,
        project_id: projectId,
        conversation_id: currentConvoId,
        message: content,
      });
      if (!currentConvoId) setCurrentConvoId(res.conversation_id);
      await queryClient.invalidateQueries({ queryKey: ["ai_conversations", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["ai_messages", res.conversation_id] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  if (!workspaceId || !projectId) return <PageHeader title="AI Chat" />;

  return (
    <div className="flex h-[calc(100vh-7rem)] overflow-hidden rounded-lg border border-border">
      {/* Conversation list */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar/40">
        <div className="border-b border-border p-3">
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-start"
            onClick={() => {
              setCurrentConvoId(null);
              setInput("");
            }}
          >
            <Plus className="h-4 w-4" /> New chat
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {(conversations ?? []).length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">No conversations yet.</p>
          ) : (
            (conversations ?? []).map((c) => (
              <button
                key={c.id}
                onClick={() => setCurrentConvoId(c.id)}
                className={cn(
                  "mb-1 flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                  currentConvoId === c.id
                    ? "bg-sidebar-accent text-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )}
              >
                <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{c.title ?? "Untitled"}</span>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Main chat */}
      <div className="flex flex-1 flex-col">
        <div ref={scrollerRef} className="flex-1 overflow-y-auto p-6">
          {!currentConvoId || !messages || messages.length === 0 ? (
            <div className="mx-auto max-w-2xl">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
                <Sparkles className="h-4 w-4 text-primary" />
                AI Agent · context-aware
              </div>
              <h1 className="mt-2 text-2xl font-semibold">Ask anything about your SaaS.</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                The agent reads your metrics, latest scan, connectors and open alerts.
              </p>
              <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    onClick={() => handleSend(s)}
                    disabled={sending}
                    className="rounded-md border border-border bg-card p-3 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl space-y-4">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              {sending && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
                </div>
              )}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-border bg-background/80 p-4 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              rows={1}
              placeholder="Ask about MRR, costs, dependencies, security… (Enter to send)"
              className="min-h-[44px] flex-1 resize-none rounded-md border border-input bg-background px-3 py-2.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button onClick={() => handleSend()} disabled={sending || !input.trim()}>
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send
            </Button>
          </div>
          {error && <p className="mx-auto mt-2 max-w-3xl text-xs text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: AiMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <Card className={cn("max-w-[85%]", isUser ? "bg-primary/15 border-primary/30" : "")}>
        <CardContent className="space-y-2 px-4 py-3">
          <div className="flex items-center justify-between gap-3 text-xs">
            <Badge variant={isUser ? "default" : "outline"}>{isUser ? "you" : "assistant"}</Badge>
            {message.metadata?.provider && (
              <span className="text-muted-foreground">
                {message.metadata.provider} · {message.metadata.model}
              </span>
            )}
          </div>
          <div className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</div>
        </CardContent>
      </Card>
    </div>
  );
}
