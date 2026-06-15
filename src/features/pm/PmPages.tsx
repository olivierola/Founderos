import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FolderKanban, Loader2, Plus, Trash2, ArrowLeft, CheckSquare,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

interface Board { id: string; name: string; description: string | null; color: string; status: string; created_at: string }
interface Task {
  id: string; board_id: string; title: string; description: string | null;
  column_key: "backlog" | "todo" | "in_progress" | "review" | "done";
  priority: "low" | "normal" | "high" | "urgent"; assignee_id: string | null; due_date: string | null;
  labels: string[]; created_at: string;
}

const COLUMNS: { key: Task["column_key"]; label: string; accent: string }[] = [
  { key: "backlog", label: "Backlog", accent: "bg-muted-foreground/40" },
  { key: "todo", label: "To do", accent: "bg-sky-500" },
  { key: "in_progress", label: "In progress", accent: "bg-amber-500" },
  { key: "review", label: "Review", accent: "bg-violet-500" },
  { key: "done", label: "Done", accent: "bg-emerald-500" },
];
const PRIORITY_DOT: Record<Task["priority"], string> = {
  low: "bg-muted-foreground/50", normal: "bg-sky-500", high: "bg-amber-500", urgent: "bg-destructive",
};

// ===================================================================== BOARDS
export function PmBoardsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [activeBoard, setActiveBoard] = useState<Board | null>(null);

  const { data: boards, isLoading } = useQuery({
    queryKey: ["pm_boards", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("pm_projects").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Board[];
    },
  });

  if (activeBoard) return <BoardView board={activeBoard} onBack={() => setActiveBoard(null)} />;

  return (
    <div className="space-y-5">
      <PageHeader title="Boards" description="Plan and track work across boards." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New board</Button>} />
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (boards ?? []).length === 0 ? <EmptyState icon={FolderKanban} title="No boards yet" description="Create a board to organise tasks." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New board</Button>} />
        : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(boards ?? []).map((b) => (
              <Card key={b.id} className="cursor-pointer transition-colors hover:border-foreground/30" onClick={() => setActiveBoard(b)}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full" style={{ backgroundColor: b.color }} />
                    <span className="font-medium">{b.name}</span>
                  </div>
                  {b.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{b.description}</p>}
                  <Badge variant="outline" className="mt-2 text-[10px] capitalize">{b.status}</Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

      <BoardDialog open={open} onOpenChange={setOpen} onCreate={async (d) => {
        if (!workspaceId || !projectId || !user) return;
        await supabase.from("pm_projects").insert({ ...d, workspace_id: workspaceId, project_id: projectId, created_by: user.id });
        queryClient.invalidateQueries({ queryKey: ["pm_boards", projectId] });
        setOpen(false);
      }} />
    </div>
  );
}

function BoardView({ board, onBack }: { board: Board; onBack: () => void }) {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [addCol, setAddCol] = useState<Task["column_key"] | null>(null);

  const { data: tasks } = useQuery({
    queryKey: ["pm_tasks", board.id],
    queryFn: async () => {
      const { data } = await supabase.from("pm_tasks").select("*").eq("board_id", board.id).order("position");
      return (data ?? []) as Task[];
    },
  });

  const byCol = useMemo(() => {
    const m: Record<string, Task[]> = {};
    COLUMNS.forEach((c) => (m[c.key] = []));
    (tasks ?? []).forEach((t) => { (m[t.column_key] ??= []).push(t); });
    return m;
  }, [tasks]);

  async function move(t: Task, col: Task["column_key"]) {
    await supabase.from("pm_tasks").update({ column_key: col, updated_at: new Date().toISOString() }).eq("id", t.id);
    queryClient.invalidateQueries({ queryKey: ["pm_tasks", board.id] });
  }
  async function addTask(col: Task["column_key"], title: string) {
    if (!workspaceId || !projectId || !user || !title.trim()) return;
    await supabase.from("pm_tasks").insert({ board_id: board.id, workspace_id: workspaceId, project_id: projectId, title, column_key: col, created_by: user.id });
    queryClient.invalidateQueries({ queryKey: ["pm_tasks", board.id] });
    setAddCol(null);
  }
  async function remove(id: string) {
    await supabase.from("pm_tasks").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["pm_tasks", board.id] });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft className="mr-1 h-3.5 w-3.5" /> Boards</Button>
        <span className="h-3 w-3 rounded-full" style={{ backgroundColor: board.color }} />
        <h2 className="text-base font-semibold">{board.name}</h2>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {COLUMNS.map((col) => (
          <div key={col.key} className="rounded-lg border border-border bg-muted/20 p-2">
            <div className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium">
              <span className={cn("h-2 w-2 rounded-full", col.accent)} /> {col.label}
              <span className="ml-auto text-muted-foreground">{byCol[col.key]?.length ?? 0}</span>
            </div>
            <div className="space-y-2">
              {(byCol[col.key] ?? []).map((t) => (
                <div key={t.id} className="group rounded-md border border-border bg-card p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm">{t.title}</span>
                    <button onClick={() => remove(t.id)} className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"><Trash2 className="h-3 w-3" /></button>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <span className={cn("h-1.5 w-1.5 rounded-full", PRIORITY_DOT[t.priority])} />
                    {t.due_date && <span className="text-[10px] text-muted-foreground">{t.due_date}</span>}
                    <select value={t.column_key} onChange={(e) => move(t, e.target.value as Task["column_key"])} className="ml-auto rounded border border-input bg-background px-1 py-0.5 text-[10px]">
                      {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                  </div>
                </div>
              ))}
              {addCol === col.key ? (
                <InlineAdd onAdd={(title) => addTask(col.key, title)} onCancel={() => setAddCol(null)} />
              ) : (
                <button onClick={() => setAddCol(col.key)} className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/5">
                  <Plus className="h-3 w-3" /> Add task
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function InlineAdd({ onAdd, onCancel }: { onAdd: (t: string) => void; onCancel: () => void }) {
  const [v, setV] = useState("");
  return (
    <div className="rounded-md border border-border bg-card p-1.5">
      <Input value={v} onChange={(e) => setV(e.target.value)} autoFocus placeholder="Task title…" className="h-7 text-sm"
        onKeyDown={(e) => { if (e.key === "Enter") onAdd(v); if (e.key === "Escape") onCancel(); }} />
      <div className="mt-1 flex gap-1">
        <Button size="sm" className="h-6 px-2 text-xs" onClick={() => onAdd(v)}>Add</Button>
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function BoardDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: Partial<Board>) => Promise<void> }) {
  const [d, setD] = useState<Partial<Board>>({ color: "#CB2957", status: "active" });
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.name?.trim()) return; setSaving(true); try { await onCreate(d); setD({ color: "#CB2957", status: "active" }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New board</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label><Input value={d.name ?? ""} onChange={(e) => setD((p) => ({ ...p, name: e.target.value }))} autoFocus /></div>
          <div><label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label><Input value={d.description ?? ""} onChange={(e) => setD((p) => ({ ...p, description: e.target.value }))} /></div>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Create</Button></div>
      </DialogContent>
    </Dialog>
  );
}

// =================================================================== MY TASKS
export function PmMyTasksPage() {
  const { projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: tasks, isLoading } = useQuery({
    queryKey: ["pm_my_tasks", projectId, user?.id],
    enabled: !!projectId && !!user,
    queryFn: async () => {
      const { data } = await supabase.from("pm_tasks").select("*").eq("project_id", projectId!).eq("assignee_id", user!.id).neq("column_key", "done").order("due_date", { ascending: true });
      return (data ?? []) as Task[];
    },
  });
  async function complete(t: Task) {
    await supabase.from("pm_tasks").update({ column_key: "done" }).eq("id", t.id);
    queryClient.invalidateQueries({ queryKey: ["pm_my_tasks", projectId] });
  }
  return (
    <div className="space-y-5">
      <PageHeader title="My tasks" description="Tasks assigned to you across all boards." />
      {isLoading ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (tasks ?? []).length === 0 ? <EmptyState icon={CheckSquare} title="Nothing assigned" description="Tasks assigned to you (and not done) show up here." />
        : (
          <div className="space-y-2">
            {(tasks ?? []).map((t) => (
              <Card key={t.id}><CardContent className="flex items-center gap-3 p-3">
                <button onClick={() => complete(t)} className="flex h-5 w-5 items-center justify-center rounded border border-border hover:border-emerald-500"><CheckSquare className="h-3.5 w-3.5 text-muted-foreground" /></button>
                <span className={cn("h-2 w-2 rounded-full", PRIORITY_DOT[t.priority])} />
                <span className="flex-1 text-sm">{t.title}</span>
                {t.due_date && <span className="text-xs text-muted-foreground">{t.due_date}</span>}
                <Badge variant="outline" className="text-[10px] capitalize">{t.column_key.replace("_", " ")}</Badge>
              </CardContent></Card>
            ))}
          </div>
        )}
    </div>
  );
}
