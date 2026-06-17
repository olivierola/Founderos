import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, Plus, UserPlus, CheckCircle2, Circle, AlertOctagon, Sparkles,
  Calendar, Trash2, X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────── types
interface Onboarding {
  id: string; name: string; role: string | null; start_date: string | null;
  status: "preboarding" | "active" | "complete" | "stalled"; created_at: string;
}
interface Task {
  id: string; onboarding_id: string; title: string;
  owner_kind: "hr" | "it" | "manager" | "employee";
  due_offset_days: number; status: "pending" | "done" | "blocked"; position: number;
}

const STATUS_META: Record<Onboarding["status"], { label: string; cls: string }> = {
  preboarding: { label: "Preboarding", cls: "bg-sky-500/15 text-sky-600" },
  active: { label: "Active", cls: "bg-amber-500/15 text-amber-600" },
  complete: { label: "Complete", cls: "bg-emerald-500/15 text-emerald-600" },
  stalled: { label: "Stalled", cls: "bg-destructive/15 text-destructive" },
};
const OWNER_META: Record<Task["owner_kind"], { label: string; cls: string }> = {
  hr: { label: "HR", cls: "bg-teal-500/15 text-teal-600" },
  it: { label: "IT", cls: "bg-violet-500/15 text-violet-600" },
  manager: { label: "Manager", cls: "bg-blue-500/15 text-blue-600" },
  employee: { label: "Employee", cls: "bg-amber-500/15 text-amber-600" },
};

// A sensible cross-functional default plan, offsets relative to start date.
const DEFAULT_PLAN: Omit<Task, "id" | "onboarding_id" | "position">[] = [
  { title: "Send welcome email + first-day logistics", owner_kind: "hr", due_offset_days: -7, status: "pending" },
  { title: "Collect signed contract & ID documents", owner_kind: "hr", due_offset_days: -5, status: "pending" },
  { title: "Provision laptop & accounts (SSO, email)", owner_kind: "it", due_offset_days: -2, status: "pending" },
  { title: "Grant tool access (per role)", owner_kind: "it", due_offset_days: -1, status: "pending" },
  { title: "Prepare desk / remote kit", owner_kind: "manager", due_offset_days: -1, status: "pending" },
  { title: "Day-1 welcome & team intro", owner_kind: "manager", due_offset_days: 0, status: "pending" },
  { title: "Complete HR onboarding forms", owner_kind: "employee", due_offset_days: 0, status: "pending" },
  { title: "Security & compliance training", owner_kind: "employee", due_offset_days: 2, status: "pending" },
  { title: "30-day goals & expectations set", owner_kind: "manager", due_offset_days: 5, status: "pending" },
  { title: "Week-1 check-in", owner_kind: "hr", due_offset_days: 7, status: "pending" },
];

function offsetLabel(d: number) {
  if (d < 0) return `Pre J${d}`;
  if (d === 0) return "Day 1";
  return `J+${d}`;
}

// ─────────────────────────────────────────────────────────────────── page
export function OnboardingPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  const { data: boards, isLoading } = useQuery({
    queryKey: ["hr_onboardings", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("hr_onboardings").select("*").eq("project_id", projectId!).order("start_date", { ascending: true });
      return (data ?? []) as Onboarding[];
    },
  });

  async function create(draft: { name: string; role: string; start_date: string }) {
    if (!workspaceId || !projectId || !draft.name.trim()) return;
    const { data } = await supabase.from("hr_onboardings").insert({
      workspace_id: workspaceId, project_id: projectId, name: draft.name.trim(),
      role: draft.role || null, start_date: draft.start_date || null,
      status: "preboarding", created_by: user?.id ?? null,
    }).select("id").single();
    // Seed the default cross-functional plan.
    if (data?.id) {
      await supabase.from("hr_onboarding_tasks").insert(
        DEFAULT_PLAN.map((t, i) => ({ ...t, onboarding_id: data.id, workspace_id: workspaceId, position: i })),
      );
    }
    queryClient.invalidateQueries({ queryKey: ["hr_onboardings", projectId] });
    setOpen(false);
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Onboarding"
        description="Coordinate new hires across HR, IT and managers — from preboarding to day-1 productivity."
        actions={<Button size="sm" onClick={() => setOpen(true)}><UserPlus className="h-4 w-4" /> New hire</Button>}
      />

      {isLoading ? <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        : (boards ?? []).length === 0 ? <EmptyState icon={UserPlus} title="No onboardings yet" description="Start an onboarding when a candidate is hired — a default plan is created automatically." />
        : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {(boards ?? []).map((b) => <BoardCard key={b.id} board={b} onOpen={() => setActive(b.id)} />)}
          </div>
        )}

      <NewHireDialog open={open} onOpenChange={setOpen} onCreate={create} />
      {active && <OnboardingDrawer id={active} onClose={() => setActive(null)} />}
    </div>
  );
}

function BoardCard({ board, onOpen }: { board: Onboarding; onOpen: () => void }) {
  const { data: tasks } = useQuery({
    queryKey: ["hr_onboarding_tasks", board.id],
    queryFn: async () => {
      const { data } = await supabase.from("hr_onboarding_tasks").select("*").eq("onboarding_id", board.id).order("position");
      return (data ?? []) as Task[];
    },
  });
  const total = (tasks ?? []).length;
  const done = (tasks ?? []).filter((t) => t.status === "done").length;
  const blocked = (tasks ?? []).filter((t) => t.status === "blocked").length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <Card className="cursor-pointer transition-colors hover:border-primary/40" onClick={onOpen}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-medium">{board.name}</div>
            {board.role && <div className="truncate text-xs text-muted-foreground">{board.role}</div>}
          </div>
          <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", STATUS_META[board.status].cls)}>{STATUS_META[board.status].label}</span>
        </div>
        {board.start_date && <div className="flex items-center gap-1 text-[11px] text-muted-foreground"><Calendar className="h-3 w-3" /> Starts {new Date(board.start_date).toLocaleDateString()}</div>}
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground"><span>{done}/{total} tasks</span><span>{pct}%</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} /></div>
        </div>
        {blocked > 0 && <div className="flex items-center gap-1 text-[11px] text-destructive"><AlertOctagon className="h-3 w-3" /> {blocked} blocked</div>}
      </CardContent>
    </Card>
  );
}

// ───────────────────────────────────────────────────────── onboarding drawer
function OnboardingDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { workspaceId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [newTask, setNewTask] = useState("");
  const [newOwner, setNewOwner] = useState<Task["owner_kind"]>("hr");

  const { data: board } = useQuery({
    queryKey: ["hr_onboarding", id],
    queryFn: async () => { const { data } = await supabase.from("hr_onboardings").select("*").eq("id", id).maybeSingle(); return data as Onboarding | null; },
  });
  const { data: tasks } = useQuery({
    queryKey: ["hr_onboarding_tasks", id],
    queryFn: async () => { const { data } = await supabase.from("hr_onboarding_tasks").select("*").eq("onboarding_id", id).order("position"); return (data ?? []) as Task[]; },
  });

  const grouped = useMemo(() => {
    const buckets: { key: string; label: string; tasks: Task[] }[] = [
      { key: "pre", label: "Preboarding", tasks: [] },
      { key: "day1", label: "Day 1", tasks: [] },
      { key: "week1", label: "Week 1", tasks: [] },
      { key: "later", label: "Ramp-up", tasks: [] },
    ];
    (tasks ?? []).forEach((t) => {
      if (t.due_offset_days < 0) buckets[0].tasks.push(t);
      else if (t.due_offset_days === 0) buckets[1].tasks.push(t);
      else if (t.due_offset_days <= 7) buckets[2].tasks.push(t);
      else buckets[3].tasks.push(t);
    });
    return buckets.filter((b) => b.tasks.length > 0);
  }, [tasks]);

  function inv() {
    queryClient.invalidateQueries({ queryKey: ["hr_onboarding_tasks", id] });
    queryClient.invalidateQueries({ queryKey: ["hr_onboardings"] });
  }
  async function cycle(t: Task) {
    const next: Task["status"] = t.status === "pending" ? "done" : t.status === "done" ? "blocked" : "pending";
    await supabase.from("hr_onboarding_tasks").update({ status: next }).eq("id", t.id);
    inv();
  }
  async function setBoardStatus(status: Onboarding["status"]) {
    await supabase.from("hr_onboardings").update({ status }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["hr_onboarding", id] });
    queryClient.invalidateQueries({ queryKey: ["hr_onboardings"] });
  }
  async function addTask() {
    if (!newTask.trim() || !workspaceId) return;
    const pos = (tasks ?? []).length;
    await supabase.from("hr_onboarding_tasks").insert({ onboarding_id: id, workspace_id: workspaceId, title: newTask.trim(), owner_kind: newOwner, due_offset_days: 0, status: "pending", position: pos });
    setNewTask(""); inv();
  }
  async function removeTask(tid: string) { await supabase.from("hr_onboarding_tasks").delete().eq("id", tid); inv(); }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside className="flex h-full w-full max-w-lg flex-col border-l border-border bg-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate font-semibold">{board?.name ?? "Onboarding"}</div>
            <div className="truncate text-xs text-muted-foreground">{board?.role || "—"}{board?.start_date && ` · starts ${new Date(board.start_date).toLocaleDateString()}`}</div>
          </div>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>

        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <span className="text-[11px] text-muted-foreground">Status</span>
          <select value={board?.status ?? "preboarding"} onChange={(e) => setBoardStatus(e.target.value as Onboarding["status"])} className="h-7 rounded-md border border-input bg-background px-2 text-xs">
            {(Object.keys(STATUS_META) as Onboarding["status"][]).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
          </select>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {grouped.map((g) => (
            <div key={g.key}>
              <div className="mb-2 text-[11px] font-medium uppercase text-muted-foreground">{g.label}</div>
              <div className="space-y-1.5">
                {g.tasks.map((t) => (
                  <div key={t.id} className="group flex items-center gap-2 rounded-md border border-border p-2">
                    <button onClick={() => cycle(t)} className="shrink-0">
                      {t.status === "done" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        : t.status === "blocked" ? <AlertOctagon className="h-4 w-4 text-destructive" />
                        : <Circle className="h-4 w-4 text-muted-foreground" />}
                    </button>
                    <span className={cn("flex-1 text-sm", t.status === "done" && "text-muted-foreground line-through")}>{t.title}</span>
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", OWNER_META[t.owner_kind].cls)}>{OWNER_META[t.owner_kind].label}</span>
                    <span className="w-12 text-right text-[10px] text-muted-foreground">{offsetLabel(t.due_offset_days)}</span>
                    <button onClick={() => removeTask(t.id)} className="rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {(tasks ?? []).length === 0 && <p className="text-xs text-muted-foreground">No tasks yet.</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-border p-3">
          <select value={newOwner} onChange={(e) => setNewOwner(e.target.value as Task["owner_kind"])} className="h-8 rounded-md border border-input bg-background px-1.5 text-xs">
            {(Object.keys(OWNER_META) as Task["owner_kind"][]).map((o) => <option key={o} value={o}>{OWNER_META[o].label}</option>)}
          </select>
          <Input value={newTask} onChange={(e) => setNewTask(e.target.value)} placeholder="Add task…" className="h-8" onKeyDown={(e) => e.key === "Enter" && addTask()} />
          <Button size="sm" onClick={addTask}><Plus className="h-3.5 w-3.5" /></Button>
        </div>
      </aside>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── dialogs
function NewHireDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: { name: string; role: string; start_date: string }) => Promise<void> }) {
  const [d, setD] = useState({ name: "", role: "", start_date: "" });
  const [saving, setSaving] = useState(false);
  async function submit() { if (!d.name.trim()) return; setSaving(true); try { await onCreate(d); setD({ name: "", role: "", start_date: "" }); } finally { setSaving(false); } }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> New hire onboarding</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label><Input value={d.name} onChange={(e) => setD((p) => ({ ...p, name: e.target.value }))} autoFocus placeholder="Jane Doe" /></div>
          <div><label className="mb-1 block text-xs font-medium text-muted-foreground">Role</label><Input value={d.role} onChange={(e) => setD((p) => ({ ...p, role: e.target.value }))} placeholder="Senior Engineer" /></div>
          <div><label className="mb-1 block text-xs font-medium text-muted-foreground">Start date</label><Input type="date" value={d.start_date} onChange={(e) => setD((p) => ({ ...p, start_date: e.target.value }))} /></div>
          <p className="text-[11px] text-muted-foreground">A default cross-functional plan (HR · IT · Manager · Employee) is created automatically and can be edited.</p>
        </div>
        <div className="flex justify-end gap-2 pt-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Create</Button></div>
      </DialogContent>
    </Dialog>
  );
}
