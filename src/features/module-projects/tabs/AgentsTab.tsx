import { useState } from "react";
import { Plus, Trash2, Bot, Send, Loader2, MessageSquare, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";

interface Agent { id: string; name: string; description: string | null; avatar_emoji: string | null; accent_color: string | null }
interface A2AMessage { id: string; from_agent_id: string; content: string; timestamp: string }

export function AgentsTab({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const { projectId } = useCurrentContext();
  const assignedIds: string[] = (mp.metadata as any)?.assigned_agents ?? [];
  const a2aMessages: A2AMessage[] = (mp.metadata as any)?.a2a_messages ?? [];

  const [pickerOpen, setPickerOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState<string | null>(null);
  const [msgInput, setMsgInput] = useState("");

  const { data: allAgents } = useQuery({
    queryKey: ["all_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents")
        .select("id, name, description, avatar_emoji, accent_color")
        .eq("project_id", projectId!).order("name");
      return (data ?? []) as Agent[];
    },
  });

  const assigned = (allAgents ?? []).filter((a) => assignedIds.includes(a.id));
  const available = (allAgents ?? []).filter((a) => !assignedIds.includes(a.id));
  const agentById = Object.fromEntries((allAgents ?? []).map((a) => [a.id, a]));

  async function save(nextIds: string[], nextMessages?: A2AMessage[]) {
    const patch: Record<string, any> = { ...mp.metadata, assigned_agents: nextIds };
    if (nextMessages !== undefined) patch.a2a_messages = nextMessages;
    await updateModuleProject(mp.id, { metadata: patch });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function addAgent(id: string) {
    save([...assignedIds, id]);
    setPickerOpen(false);
  }

  function removeAgent(id: string) {
    save(assignedIds.filter((x) => x !== id));
  }

  function sendMessage(fromId: string) {
    if (!msgInput.trim()) return;
    const msg: A2AMessage = { id: crypto.randomUUID(), from_agent_id: fromId, content: msgInput.trim(), timestamp: new Date().toISOString() };
    save(assignedIds, [...a2aMessages, msg]);
    setMsgInput("");
  }

  return (
    <div className="space-y-6 py-6">
      {/* ── Assigned agents ── */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5"><Bot className="h-4 w-4 text-muted-foreground" /> Project agents ({assigned.length})</h3>
        <Button size="sm" variant="outline" onClick={() => setPickerOpen(!pickerOpen)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add agent
        </Button>
      </div>

      {/* Agent picker */}
      {pickerOpen && (
        <div className="rounded-lg border border-border p-2 space-y-1">
          {available.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground text-center">No more agents available. Hire new agents in AI Workforce.</p>
          ) : available.map((a) => (
            <button key={a.id} onClick={() => addAgent(a.id)}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left text-sm hover:bg-secondary/60">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm"
                style={{ backgroundColor: (a.accent_color ?? "#6366f1") + "20" }}>
                {a.avatar_emoji ?? "🤖"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-xs">{a.name}</div>
                {a.description && <div className="truncate text-[10px] text-muted-foreground">{a.description}</div>}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Agent cards */}
      {assigned.length === 0 && !pickerOpen && (
        <div className="rounded-xl border border-dashed border-border py-10 text-center">
          <Bot className="mx-auto h-8 w-8 text-muted-foreground/30" />
          <p className="mt-2 text-sm text-muted-foreground">No agents assigned. Add AI agents to work on this project.</p>
        </div>
      )}

      <div className="space-y-2">
        {assigned.map((a) => (
          <div key={a.id} className="rounded-xl border border-border bg-card">
            <div className="flex items-center gap-3 p-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base"
                style={{ backgroundColor: (a.accent_color ?? "#6366f1") + "20" }}>
                {a.avatar_emoji ?? "🤖"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{a.name}</div>
                {a.description && <div className="text-[11px] text-muted-foreground truncate">{a.description}</div>}
              </div>
              <button onClick={() => setChatOpen(chatOpen === a.id ? null : a.id)}
                className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
                <MessageSquare className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => removeAgent(a.id)}
                className="rounded p-1 text-muted-foreground hover:text-destructive">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* A2A chat for this agent */}
            {chatOpen === a.id && (
              <div className="border-t border-border">
                <div className="max-h-48 overflow-y-auto p-3 space-y-2">
                  {a2aMessages.length === 0 && (
                    <p className="py-3 text-center text-xs text-muted-foreground">No messages yet. Agents will communicate here.</p>
                  )}
                  {a2aMessages.map((m) => {
                    const sender = agentById[m.from_agent_id];
                    return (
                      <div key={m.id} className="flex items-start gap-2">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px]"
                          style={{ backgroundColor: (sender?.accent_color ?? "#6366f1") + "20" }}>
                          {sender?.avatar_emoji ?? "🤖"}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 text-[10px]">
                            <span className="font-medium">{sender?.name ?? "Agent"}</span>
                            <span className="text-muted-foreground">{new Date(m.timestamp).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
                          </div>
                          <p className="text-xs text-foreground/90">{m.content}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2 border-t border-border p-2">
                  <Input value={msgInput} onChange={(e) => setMsgInput(e.target.value)}
                    placeholder={`Message as ${a.name}…`} className="h-7 text-xs flex-1"
                    onKeyDown={(e) => { if (e.key === "Enter") sendMessage(a.id); }} />
                  <Button size="sm" className="h-7 px-2" onClick={() => sendMessage(a.id)} disabled={!msgInput.trim()}>
                    <Send className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
