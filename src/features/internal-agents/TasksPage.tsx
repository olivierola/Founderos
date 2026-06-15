import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ListTodo, Plus, Loader2, Trash2, Clock, ChevronRight, ChevronLeft, Bot, User as UserIcon,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

type Status = "open" | "in_progress" | "done" | "cancelled";
interface Task {
  id: string;
  title: string;
  detail: string | null;
  status: Status;
  priority: "low" | "medium" | "high" | "urgent";
  due_at: string | null;
  assignee: string | null;
  agent_id: string | null;
  created_at: string;
}

const COLUMNS: { key: Status; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
];

const PRIORITY: Record<Task["priority"], { label: string; variant: "secondary" | "warning" | "destructive" | "outline" }> = {
  low: { label: "low", variant: "outline" },
  medium: { label: "medium", variant: "secondary" },
  high: { label: "high", variant: "warning" },
  urgent: { label: "urgent", variant: "destructive" },
};

function relDue(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const diff = d.getTime() - Date.now();
  const days = Math.round(diff / 86400000);
  if (days < 0) return `overdue ${Math.abs(days)}d`;
  if (days === 0) return "due today";
  return `in ${days}d`;
}

export function AgentTasksPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("medium");
  const [creating, setCreating] = useState(false);

  const tasks = useQuery({
    queryKey: ["agent_tasks", projectId],
    enabled: !!projectId,
    refetchInterval: 6000,
    queryFn: async () => {
      const { data } = await supabase
        .from("agent_tasks")
        .select("id, title, detail, status, priority, due_at, assignee, agent_id, created_at")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(300);
      return (data ?? []) as Task[];
    },
  });

  const byStatus = useMemo(() => {
    const m: Record<Status, Task[]> = { open: [], in_progress: [], done: [], cancelled: [] };
    for (const t of tasks.data ?? []) (m[t.status] ??= []).push(t);
    return m;
  }, [tasks.data]);

  async function move(t: Task, status: Status) {
    await supabase.from("agent_tasks").update({ status, updated_at: new Date().toISOString() }).eq("id", t.id);
    queryClient.invalidateQueries({ queryKey: ["agent_tasks", projectId] });
  }
  async function remove(id: string) {
    await supabase.from("agent_tasks").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["agent_tasks", projectId] });
  }
  async function create() {
    if (!workspaceId || !projectId || !user || !title.trim()) return;
    setCreating(true);
    try {
      await supabase.from("agent_tasks").insert({
        workspace_id: workspaceId, project_id: projectId, created_by: user.id,
        title: title.trim(), detail: detail.trim() || null, priority,
      });
      setTitle(""); setDetail(""); setPriority("medium"); setCreateOpen(false);
      queryClient.invalidateQueries({ queryKey: ["agent_tasks", projectId] });
    } finally { setCreating(false); }
  }

  if (!projectId) return <PageHeader title="Tasks" />;
  const total = (tasks.data ?? []).length;

  return (
    <div>
      <PageHeader
        title="Tasks"
        description="Action items and to-dos filed by your agents (and you). Move them across the board as work progresses."
        actions={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> New task</Button>}
      />

      {tasks.isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : total === 0 ? (
        <EmptyState
          icon={ListTodo}
          title="No tasks yet"
          description="Agents file tasks here with create_task, or add one yourself."
          action={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> Add a task</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {COLUMNS.map((col) => (
            <div key={col.key} className="rounded-xl border border-border bg-card/30 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium">{col.label}</span>
                <span className="rounded-full bg-secondary px-1.5 text-[11px] tabular-nums text-muted-foreground">
                  {byStatus[col.key].length}
                </span>
              </div>
              <div className="space-y-2">
                {byStatus[col.key].length === 0 ? (
                  <p className="px-1 py-6 text-center text-xs text-muted-foreground">Nothing here.</p>
                ) : (
                  byStatus[col.key].map((t) => (
                    <TaskCard key={t.id} task={t} onMove={move} onRemove={remove} />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New task</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" autoFocus />
            <textarea
              value={detail} onChange={(e) => setDetail(e.target.value)} rows={3}
              className="w-full rounded-md border border-border bg-background p-2.5 text-sm"
              placeholder="Details (optional)"
            />
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">Priority</label>
              <select
                value={priority} onChange={(e) => setPriority(e.target.value as Task["priority"])}
                className="rounded-md border border-border bg-background p-1.5 text-sm"
              >
                {Object.keys(PRIORITY).map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={creating || !title.trim()}>
              {creating && <Loader2 className="h-4 w-4 animate-spin" />} Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TaskCard({ task, onMove, onRemove }: {
  task: Task;
  onMove: (t: Task, s: Status) => void;
  onRemove: (id: string) => void;
}) {
  const pri = PRIORITY[task.priority];
  const due = relDue(task.due_at);
  const overdue = due?.startsWith("overdue");
  const order: Status[] = ["open", "in_progress", "done"];
  const idx = order.indexOf(task.status);
  return (
    <div className="group rounded-lg border border-border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium leading-tight">{task.title}</span>
        <Badge variant={pri.variant} className="shrink-0">{pri.label}</Badge>
      </div>
      {task.detail && <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{task.detail}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        {task.agent_id ? (
          <span className="inline-flex items-center gap-1"><Bot className="h-3 w-3" /> agent</span>
        ) : (
          <span className="inline-flex items-center gap-1"><UserIcon className="h-3 w-3" /> you</span>
        )}
        {task.assignee && <span>· {task.assignee}</span>}
        {due && <span className={cn("inline-flex items-center gap-1", overdue && "text-destructive")}><Clock className="h-3 w-3" /> {due}</span>}
      </div>
      <div className="mt-2.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {idx > 0 && (
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => onMove(task, order[idx - 1])}>
            <ChevronLeft className="h-3 w-3" /> {COLUMN_LABEL[order[idx - 1]]}
          </Button>
        )}
        {idx < order.length - 1 && (
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => onMove(task, order[idx + 1])}>
            {COLUMN_LABEL[order[idx + 1]]} <ChevronRight className="h-3 w-3" />
          </Button>
        )}
        <Button size="icon" variant="ghost" className="ml-auto h-6 w-6" onClick={() => onRemove(task.id)} title="Delete">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

const COLUMN_LABEL: Record<Status, string> = { open: "Open", in_progress: "In progress", done: "Done", cancelled: "Cancelled" };
