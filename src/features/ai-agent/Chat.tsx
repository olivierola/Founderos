import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, FileText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PageHeader } from "@/components/PageHeader";
import { ChatComposer } from "@/components/ui/chat-composer";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { DocumentCanvas } from "./DocumentCanvas";

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
  const [docMarkdown, setDocMarkdown] = useState<string | null>(null);
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

  // Sync the active conversation with the ?c= param driven by the sidebar.
  const urlConvoId = searchParams.get("c");
  useEffect(() => {
    setCurrentConvoId(urlConvoId);
  }, [urlConvoId]);

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
      if (!currentConvoId) {
        setCurrentConvoId(res.conversation_id);
        // Reflect the new conversation in the URL so the sidebar can highlight it.
        setSearchParams({ c: res.conversation_id }, { replace: true });
      }
      await queryClient.invalidateQueries({ queryKey: ["sidebar_ai_conversations", projectId] });
      await queryClient.invalidateQueries({ queryKey: ["ai_messages", res.conversation_id] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  if (!workspaceId || !projectId) return <PageHeader title="AI Chat" />;

  const isEmpty = !currentConvoId || !messages || messages.length === 0;

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col overflow-hidden">
      <div ref={scrollerRef} className="flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center px-6 py-12">
            <div className="mb-8 text-center">
              <h1 className="text-3xl font-semibold tracking-tight">Ask anything about your SaaS.</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                The agent reads your metrics, latest scan, connectors and open alerts.
              </p>
            </div>

            <ChatComposer
              value={input}
              onValueChange={setInput}
              onSubmit={({ message }) => handleSend(message)}
              loading={sending}
              footerHint="AI can make mistakes. Please check important information."
            />

            <div className="mt-6 grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => handleSend(s)}
                  disabled={sending}
                  className="rounded-md border border-border bg-card p-3 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4 px-6 py-6">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} onOpenAsDocument={(md) => setDocMarkdown(md)} />
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
              </div>
            )}
          </div>
        )}
      </div>

      {/* Composer pinned at bottom when a conversation is active */}
      {!isEmpty && (
        <div className="bg-background/80 px-6 py-4 backdrop-blur">
          <ChatComposer
            value={input}
            onValueChange={setInput}
            onSubmit={({ message }) => handleSend(message)}
            loading={sending}
            placeholder="Reply…"
          />
          {error && <p className="mx-auto mt-2 max-w-2xl text-center text-xs text-destructive">{error}</p>}
        </div>
      )}

      <DocumentCanvas
        open={docMarkdown !== null}
        onOpenChange={(o) => { if (!o) setDocMarkdown(null); }}
        initialMarkdown={docMarkdown ?? ""}
      />
    </div>
  );
}

/** Heuristic: detect when an assistant reply is structured enough to warrant
 *  being opened in a dedicated document canvas. */
function looksLikeDocument(content: string): boolean {
  if (!content) return false;
  const hasHeading = /^#{1,3}\s+\S/m.test(content);
  const wordCount = content.trim().split(/\s+/).length;
  // Heading + body OR a clearly long structured answer.
  return hasHeading || wordCount > 250;
}

function MessageBubble({
  message,
  onOpenAsDocument,
}: {
  message: AiMessage;
  onOpenAsDocument?: (markdown: string) => void;
}) {
  const isUser = message.role === "user";
  const isDocLike = !isUser && looksLikeDocument(message.content);

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl border border-[hsl(var(--primary-soft)/0.3)] bg-[hsl(var(--primary-soft)/0.1)] px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[95%]">
        {isDocLike && onOpenAsDocument && (
          <div className="mb-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => onOpenAsDocument(message.content)}
              className="gap-1.5"
            >
              <FileText className="h-3.5 w-3.5" />
              Open as document
            </Button>
          </div>
        )}
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p className="mb-3 text-sm leading-relaxed last:mb-0">{children}</p>,
            h1: ({ children }) => <h1 className="mb-3 mt-4 text-xl font-semibold first:mt-0">{children}</h1>,
            h2: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h2>,
            h3: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
            ul: ({ children }) => <ul className="mb-3 ml-5 list-disc space-y-1 text-sm last:mb-0">{children}</ul>,
            ol: ({ children }) => <ol className="mb-3 ml-5 list-decimal space-y-1 text-sm last:mb-0">{children}</ol>,
            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[hsl(var(--primary-soft))] underline underline-offset-2 hover:opacity-80"
              >
                {children}
              </a>
            ),
            strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
            em: ({ children }) => <em className="italic">{children}</em>,
            code: ({ inline, children, ...props }: any) =>
              inline ? (
                <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.85em]" {...props}>
                  {children}
                </code>
              ) : (
                <code className="block" {...props}>
                  {children}
                </code>
              ),
            pre: ({ children }) => (
              <pre className="mb-3 overflow-x-auto rounded-lg border border-border bg-secondary p-3 text-xs leading-relaxed last:mb-0">
                {children}
              </pre>
            ),
            blockquote: ({ children }) => (
              <blockquote className="mb-3 border-l-2 border-border pl-3 text-sm italic text-muted-foreground last:mb-0">
                {children}
              </blockquote>
            ),
            hr: () => <hr className="my-4 border-border" />,
            table: ({ children }) => (
              <div className="mb-3 overflow-x-auto last:mb-0">
                <table className="w-full text-left text-sm">{children}</table>
              </div>
            ),
            th: ({ children }) => <th className="border-b border-border px-2 py-1.5 font-semibold">{children}</th>,
            td: ({ children }) => <td className="border-b border-border/50 px-2 py-1.5">{children}</td>,
          }}
        >
          {message.content}
        </ReactMarkdown>
        {message.metadata?.provider && (
          <p className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            {message.metadata.provider} · {message.metadata.model}
          </p>
        )}
      </div>
    </div>
  );
}
