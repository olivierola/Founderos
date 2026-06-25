import { useState } from "react";
import { Plus, Trash2, Workflow, CheckCircle, XCircle, Clock, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ModuleProject } from "../moduleProjectModel";
import { updateModuleProject } from "../moduleProjectModel";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface ApprovalRequest { id: string; title: string; description?: string; requester: string; status: "pending" | "approved" | "rejected"; reviewedBy?: string; createdAt: string; reviewedAt?: string }

const S_ICON = { pending: Clock, approved: CheckCircle, rejected: XCircle };
const S_CLS = { pending: "text-amber-500", approved: "text-emerald-500", rejected: "text-destructive" };

export function ApprovalWorkflowView({ moduleProject: mp }: { moduleProject: ModuleProject }) {
  const qc = useQueryClient();
  const requests: ApprovalRequest[] = (mp.metadata as any)?.approval_requests ?? [];
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", requester: "" });

  async function save(next: ApprovalRequest[]) {
    await updateModuleProject(mp.id, { metadata: { ...mp.metadata, approval_requests: next } });
    qc.invalidateQueries({ queryKey: ["module_project", mp.id] });
  }

  function add() {
    if (!form.title.trim()) return;
    save([{ id: crypto.randomUUID(), title: form.title.trim(), description: form.description.trim() || undefined, requester: form.requester.trim() || "User", status: "pending", createdAt: new Date().toISOString() }, ...requests]);
    setForm({ title: "", description: "", requester: "" });
    setAdding(false);
  }

  function setStatus(id: string, status: ApprovalRequest["status"]) {
    save(requests.map((r) => r.id === id ? { ...r, status, reviewedAt: new Date().toISOString() } : r));
  }

  const pending = requests.filter((r) => r.status === "pending").length;

  return (
    <div className="space-y-4 py-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <Workflow className="h-4 w-4 text-muted-foreground" /> Approvals
          {pending > 0 && <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-500">{pending}</span>}
        </h3>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus className="mr-1 h-3.5 w-3.5" /> New request</Button>
      </div>

      {adding && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="What needs approval?" autoFocus />
          <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder="Details (optional)"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          <Input value={form.requester} onChange={(e) => setForm({ ...form, requester: e.target.value })} placeholder="Requester name" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button size="sm" onClick={add} disabled={!form.title.trim()}>Submit</Button>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {requests.map((r) => {
          const Icon = S_ICON[r.status];
          return (
            <div key={r.id} className="group rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <Icon className={cn("h-4 w-4 shrink-0", S_CLS[r.status])} />
                <span className="flex-1 text-sm font-medium">{r.title}</span>
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground"><User className="h-3 w-3" /> {r.requester}</span>
              </div>
              {r.description && <p className="mt-1 ml-6 text-xs text-muted-foreground">{r.description}</p>}
              <div className="mt-2 ml-6 flex items-center gap-2">
                {r.status === "pending" && (
                  <>
                    <Button size="sm" className="h-6 text-[10px] px-2 bg-emerald-600 hover:bg-emerald-700" onClick={() => setStatus(r.id, "approved")}>Approve</Button>
                    <Button size="sm" variant="destructive" className="h-6 text-[10px] px-2" onClick={() => setStatus(r.id, "rejected")}>Reject</Button>
                  </>
                )}
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {new Date(r.createdAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </span>
                <button onClick={() => save(requests.filter((x) => x.id !== r.id))} className="hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"><Trash2 className="h-3 w-3" /></button>
              </div>
            </div>
          );
        })}
      </div>
      {requests.length === 0 && !adding && <p className="py-8 text-center text-sm text-muted-foreground">No approval requests yet.</p>}
    </div>
  );
}
