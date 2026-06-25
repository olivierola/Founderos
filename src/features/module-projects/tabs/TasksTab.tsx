import { useState } from "react";
import { Plus, Check, Circle, Trash2, Bot, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { cn } from "@/lib/utils";

interface Task {
  text: string; done: boolean; createdAt: string;
  assignee_id?: string; assignee_type?: "human" | "agent"; assignee_name?: string;
  created_by_type?: "human" | "agent"; created_by_name?: string;
}

interface Agent { id: string; name: string; avatar_emoji: string | null; accent_color: string | null }

export function TasksTab({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const { projectId } = useCurrentContext();
  const tasks: Task[] = (mp.metadata as any)?.tasks ?? [];
  const [input, setInput] = useState("");
  const [assignTo, setAssignTo] = useState("");

  const { data: agents } = useQuery({
    queryKey: ["project_agents_for_tasks", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents")
        .select("id, name, avatar_emoji, accent_color").eq("project_id", projectId!);
      return (data ?? []) as Agent[];
    },
  });

  const assignedAgentIds: string[] = (mp.metadata as any)?.assigned_agents ?? [];
  const projectAgents = (agents ?? []).filter((a) => assignedAgentIds.includes(a.id));

  async function save(next: Task[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, tasks: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function addTask() {
    if (!input.trim()) return;
    const agent = projectAgents.find((a) => a.id === assignTo);
    const task: Task = {
      text: input.trim(), done: false, createdAt: new Date().toISOString(),
      created_by_type: "human", created_by_name: "You",
      ...(agent ? { assignee_id: agent.id, assignee_type: "agent" as const, assignee_name: agent.name } :
        assignTo === "self" ? { assignee_type: "human" as const, assignee_name: "You" } : {}),
    };
    save([...tasks, task]);
    setInput("");
    setAssignTo("");
  }

  function toggle(idx: number) { save(tasks.map((t, i) => i === idx ? { ...t, done: !t.done } : t)); }
  function remove(idx: number) { save(tasks.filter((_, i) => i !== idx)); }

  const pending = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);

  return (
    <div className="space-y-4 py-6">
      {/* Add task */}
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Add a task…"
            onKeyDown={(e) => { if (e.key === "Enter") addTask(); }} />
        </div>
        <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-xs">
          <option value="">Unassigned</option>
          <option value="self">Assign to me</option>
          {projectAgents.map((a) => <option key={a.id} value={a.id}>🤖 {a.name}</option>)}
        </select>
        <Button size="sm" onClick={addTask} disabled={!input.trim()}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Pending tasks */}
      <div className="space-y-1">
        {pending.map((t, i) => {
          const realIdx = tasks.indexOf(t);
          return (
            <div key={realIdx} className="group flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-secondary/50">
              <button onClick={() => toggle(realIdx)} className="shrink-0">
                <Circle className="h-4 w-4 text-muted-foreground" />
              </button>
              <span className="flex-1 text-sm">{t.text}</span>
              {t.assignee_type && (
                <span className="flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {t.assignee_type === "agent" ? <Bot className="h-3 w-3" /> : <User className="h-3 w-3" />}
                  {t.assignee_name}
                </span>
              )}
              <button onClick={() => remove(realIdx)} className="rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Done tasks */}
      {done.length > 0 && (
        <div className="space-y-1 border-t border-border pt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Completed ({done.length})</div>
          {done.map((t) => {
            const realIdx = tasks.indexOf(t);
            return (
              <div key={realIdx} className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-secondary/30">
                <button onClick={() => toggle(realIdx)} className="shrink-0">
                  <Check className="h-4 w-4 text-emerald-500" />
                </button>
                <span className="flex-1 text-sm text-muted-foreground line-through">{t.text}</span>
                {t.assignee_type && (
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    {t.assignee_type === "agent" ? "🤖" : "👤"} {t.assignee_name}
                  </span>
                )}
                <button onClick={() => remove(realIdx)} className="rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {tasks.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No tasks yet. Humans and agents can create and assign tasks.</p>}
    </div>
  );
}
