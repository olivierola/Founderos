import { useEffect, useRef, useState } from "react";
import { Send, Loader2, Bot, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface ChatMessage { id: string; role: "user" | "assistant"; content: string; timestamp: string }

export function AgentChatView({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const messages: ChatMessage[] = (mp.metadata as any)?.agent_chat ?? [];
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  async function save(next: ChatMessage[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, agent_chat: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text, timestamp: new Date().toISOString() };
    const updated = [...messages, userMsg];
    await save(updated);

    // Simulate agent response (in production this would call the edge function)
    setTimeout(async () => {
      const assistantMsg: ChatMessage = { id: crypto.randomUUID(), role: "assistant", content: `I received your message: "${text}". Connect an agent asset to enable real AI responses.`, timestamp: new Date().toISOString() };
      await save([...updated, assistantMsg]);
      setSending(false);
    }, 800);
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <Bot className="h-10 w-10 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">Start a conversation with the agent.</p>
            <p className="text-xs text-muted-foreground">Add an agent asset to connect a real AI model.</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn("flex max-w-[75%] gap-2", m.role === "user" ? "flex-row-reverse" : "")}>
              <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                m.role === "user" ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground")}>
                {m.role === "user" ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
              </div>
              <div className={cn("whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm",
                m.role === "user" ? "rounded-tr-sm bg-primary text-primary-foreground" : "rounded-tl-sm bg-secondary text-foreground")}>
                {m.content}
              </div>
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-secondary"><Bot className="h-3.5 w-3.5" /></div>
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={1}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Message the agent…"
            className="max-h-32 min-h-[38px] flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          <Button onClick={send} disabled={sending || !input.trim()} size="sm">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
