import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  UsersRound, Loader2, Plus, Trash2, CalendarOff, UserPlus, Wallet,
  Check, X, Search, Building2, Mail,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { MetricCard } from "@/components/MetricCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import {
  type Employee, type LeaveRequest, type Candidate,
  EMPLOYMENT_TYPES, EMP_STATUS_META, LEAVE_STATUS_META, RECRUIT_STAGES, STAGE_META,
  fmtMoney, daysBetween,
} from "./shared";

function useEmployees() {
  const { projectId } = useCurrentContext();
  return useQuery({
    queryKey: ["hr_employees", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("hr_employees").select("*").eq("project_id", projectId!).order("full_name");
      return (data ?? []) as Employee[];
    },
  });
}

// =================================================================== OVERVIEW
export function HrOverviewPage() {
  const { data: employees } = useEmployees();
  const { projectId } = useCurrentContext();
  const { data: leave } = useQuery({
    queryKey: ["hr_leave", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("hr_leave_requests").select("*").eq("project_id", projectId!);
      return (data ?? []) as LeaveRequest[];
    },
  });
  const { data: candidates } = useQuery({
    queryKey: ["hr_candidates", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("hr_candidates").select("id, stage").eq("project_id", projectId!);
      return (data ?? []) as Pick<Candidate, "id" | "stage">[];
    },
  });

  const stats = useMemo(() => {
    const list = employees ?? [];
    const byDept = new Map<string, number>();
    list.forEach((e) => { const d = e.department || "—"; byDept.set(d, (byDept.get(d) ?? 0) + 1); });
    return {
      total: list.length,
      active: list.filter((e) => e.status === "active").length,
      onLeave: list.filter((e) => e.status === "on_leave").length,
      pendingLeave: (leave ?? []).filter((l) => l.status === "pending").length,
      openCandidates: (candidates ?? []).filter((c) => !["hired", "rejected"].includes(c.stage)).length,
      byDept: [...byDept.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [employees, leave, candidates]);

  return (
    <div className="space-y-6">
      <PageHeader title="RH — Overview" description="Headcount, absences and recruitment at a glance." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Headcount" value={String(stats.total)} icon={UsersRound} hint={`${stats.active} active`} />
        <MetricCard label="On leave" value={String(stats.onLeave)} icon={CalendarOff} hint={`${stats.pendingLeave} requests pending`} />
        <MetricCard label="In recruitment" value={String(stats.openCandidates)} icon={UserPlus} />
        <MetricCard label="Departments" value={String(stats.byDept.length)} icon={Building2} />
      </div>
      {stats.byDept.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Headcount by department</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {stats.byDept.map(([dept, n]) => (
              <div key={dept} className="flex items-center gap-3">
                <span className="w-40 truncate text-sm">{dept}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(n / stats.total) * 100}%` }} />
                </div>
                <span className="w-8 text-right text-xs text-muted-foreground">{n}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ================================================================== EMPLOYEES
export function HrEmployeesPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: employees, isLoading } = useEmployees();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    let list = employees ?? [];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((e) => e.full_name.toLowerCase().includes(q) || (e.job_title ?? "").toLowerCase().includes(q) || (e.department ?? "").toLowerCase().includes(q));
    }
    return list;
  }, [employees, search]);

  async function remove(id: string) {
    if (!confirm("Remove this employee?")) return;
    await supabase.from("hr_employees").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["hr_employees", projectId] });
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Employees"
        description="Your team directory."
        actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add employee</Button>}
      />
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search employees…" className="h-9 pl-8" />
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (employees ?? []).length === 0 ? (
        <EmptyState icon={UsersRound} title="No employees yet" description="Add your first team member." action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add employee</Button>} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((e) => {
            const meta = EMP_STATUS_META[e.status];
            return (
              <Card key={e.id} className="group">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">{e.avatar_emoji ?? "🧑"}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{e.full_name}</span>
                        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", meta.cls)}>{meta.label}</span>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{e.job_title || "—"}{e.department ? ` · ${e.department}` : ""}</div>
                      {e.email && <div className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground"><Mail className="h-3 w-3" />{e.email}</div>}
                    </div>
                    <button onClick={() => remove(e.id)} className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-[11px] text-muted-foreground">
                    <span>{e.employment_type.replace("_", " ")}</span>
                    <span>{fmtMoney(e.salary_cents, e.currency)}/yr</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <EmployeeDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (draft) => {
          if (!workspaceId || !projectId || !user) return;
          await supabase.from("hr_employees").insert({ ...draft, workspace_id: workspaceId, project_id: projectId, created_by: user.id });
          queryClient.invalidateQueries({ queryKey: ["hr_employees", projectId] });
          setOpen(false);
        }}
      />
    </div>
  );
}

function EmployeeDialog({ open, onOpenChange, onCreate }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  onCreate: (d: Partial<Employee>) => Promise<void>;
}) {
  const [d, setD] = useState<Partial<Employee>>({ employment_type: "full_time", status: "active", currency: "eur", avatar_emoji: "🧑" });
  const [saving, setSaving] = useState(false);
  function set<K extends keyof Employee>(k: K, v: Employee[K]) { setD((p) => ({ ...p, [k]: v })); }
  async function submit() {
    if (!d.full_name?.trim()) return;
    setSaving(true);
    try { await onCreate(d); setD({ employment_type: "full_time", status: "active", currency: "eur", avatar_emoji: "🧑" }); }
    finally { setSaving(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Add employee</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Full name" className="col-span-2"><Input value={d.full_name ?? ""} onChange={(e) => set("full_name", e.target.value)} autoFocus /></Field>
          <Field label="Email"><Input type="email" value={d.email ?? ""} onChange={(e) => set("email", e.target.value)} /></Field>
          <Field label="Job title"><Input value={d.job_title ?? ""} onChange={(e) => set("job_title", e.target.value)} /></Field>
          <Field label="Department"><Input value={d.department ?? ""} onChange={(e) => set("department", e.target.value)} /></Field>
          <Field label="Location"><Input value={d.location ?? ""} onChange={(e) => set("location", e.target.value)} /></Field>
          <Field label="Employment type">
            <select value={d.employment_type} onChange={(e) => set("employment_type", e.target.value as Employee["employment_type"])} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
            </select>
          </Field>
          <Field label="Annual salary (€)"><Input type="number" value={d.salary_cents ? d.salary_cents / 100 : ""} onChange={(e) => set("salary_cents", e.target.value ? Math.round(Number(e.target.value) * 100) : null)} /></Field>
          <Field label="Start date" className="col-span-2"><Input type="date" value={d.start_date ?? ""} onChange={(e) => set("start_date", e.target.value)} /></Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !d.full_name?.trim()}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Add</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={className}>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

// ================================================================== ORG CHART
export function HrOrgChartPage() {
  const { data: employees, isLoading } = useEmployees();
  const roots = useMemo(() => (employees ?? []).filter((e) => !e.manager_id), [employees]);
  const childrenOf = useMemo(() => {
    const m = new Map<string, Employee[]>();
    (employees ?? []).forEach((e) => { if (e.manager_id) { const a = m.get(e.manager_id) ?? []; a.push(e); m.set(e.manager_id, a); } });
    return m;
  }, [employees]);

  return (
    <div className="space-y-5">
      <PageHeader title="Org chart" description="Reporting structure. Set a manager on each employee to build it." />
      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (employees ?? []).length === 0 ? (
        <EmptyState icon={UsersRound} title="No employees" description="Add employees first to see the org chart." />
      ) : (
        <div className="space-y-4 overflow-x-auto">
          {roots.map((r) => <OrgNode key={r.id} emp={r} childrenOf={childrenOf} />)}
        </div>
      )}
    </div>
  );
}

function OrgNode({ emp, childrenOf }: { emp: Employee; childrenOf: Map<string, Employee[]> }) {
  const kids = childrenOf.get(emp.id) ?? [];
  return (
    <div className="flex flex-col items-start">
      <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <span className="text-lg">{emp.avatar_emoji ?? "🧑"}</span>
        <div>
          <div className="text-sm font-medium">{emp.full_name}</div>
          <div className="text-[11px] text-muted-foreground">{emp.job_title || "—"}</div>
        </div>
      </div>
      {kids.length > 0 && (
        <div className="ml-6 mt-2 space-y-2 border-l border-border pl-4">
          {kids.map((k) => <OrgNode key={k.id} emp={k} childrenOf={childrenOf} />)}
        </div>
      )}
    </div>
  );
}

// ====================================================================== LEAVE
export function HrLeavePage() {
  const { workspaceId, projectId } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: employees } = useEmployees();
  const empName = (id: string) => (employees ?? []).find((e) => e.id === id)?.full_name ?? "—";
  const [open, setOpen] = useState(false);

  const { data: requests, isLoading } = useQuery({
    queryKey: ["hr_leave", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("hr_leave_requests").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as LeaveRequest[];
    },
  });

  async function decide(id: string, status: "approved" | "rejected") {
    await supabase.from("hr_leave_requests").update({ status, decided_by: user?.id ?? null, decided_at: new Date().toISOString() }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["hr_leave", projectId] });
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Leave & absences" description="Track and approve time-off requests." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New request</Button>} />
      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (requests ?? []).length === 0 ? (
        <EmptyState icon={CalendarOff} title="No leave requests" description="Time-off requests will appear here." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                <tr><th className="px-4 py-2">Employee</th><th className="px-4 py-2">Type</th><th className="px-4 py-2">Period</th><th className="px-4 py-2 text-right">Days</th><th className="px-4 py-2">Status</th><th className="px-4 py-2" /></tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(requests ?? []).map((r) => {
                  const meta = LEAVE_STATUS_META[r.status];
                  return (
                    <tr key={r.id}>
                      <td className="px-4 py-2 font-medium">{empName(r.employee_id)}</td>
                      <td className="px-4 py-2 capitalize">{r.kind}</td>
                      <td className="px-4 py-2 text-muted-foreground">{r.start_date} → {r.end_date}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.days ?? daysBetween(r.start_date, r.end_date)}</td>
                      <td className="px-4 py-2"><span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", meta.cls)}>{meta.label}</span></td>
                      <td className="px-4 py-2 text-right">
                        {r.status === "pending" && (
                          <div className="flex justify-end gap-1">
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-600" onClick={() => decide(r.id, "approved")}><Check className="h-3.5 w-3.5" /></Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => decide(r.id, "rejected")}><X className="h-3.5 w-3.5" /></Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <LeaveDialog open={open} onOpenChange={setOpen} employees={employees ?? []} onCreate={async (draft) => {
        if (!workspaceId || !projectId) return;
        await supabase.from("hr_leave_requests").insert({ ...draft, workspace_id: workspaceId, project_id: projectId });
        queryClient.invalidateQueries({ queryKey: ["hr_leave", projectId] });
        setOpen(false);
      }} />
    </div>
  );
}

function LeaveDialog({ open, onOpenChange, employees, onCreate }: {
  open: boolean; onOpenChange: (o: boolean) => void; employees: Employee[];
  onCreate: (d: Partial<LeaveRequest>) => Promise<void>;
}) {
  const [d, setD] = useState<Partial<LeaveRequest>>({ kind: "paid" });
  const [saving, setSaving] = useState(false);
  async function submit() {
    if (!d.employee_id || !d.start_date || !d.end_date) return;
    setSaving(true);
    try { await onCreate({ ...d, days: daysBetween(d.start_date, d.end_date) }); setD({ kind: "paid" }); }
    finally { setSaving(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New leave request</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field label="Employee">
            <select value={d.employee_id ?? ""} onChange={(e) => setD((p) => ({ ...p, employee_id: e.target.value }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              <option value="">Select…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select value={d.kind} onChange={(e) => setD((p) => ({ ...p, kind: e.target.value as LeaveRequest["kind"] }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
              {["paid", "unpaid", "sick", "parental", "other"].map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="From"><Input type="date" value={d.start_date ?? ""} onChange={(e) => setD((p) => ({ ...p, start_date: e.target.value }))} /></Field>
            <Field label="To"><Input type="date" value={d.end_date ?? ""} onChange={(e) => setD((p) => ({ ...p, end_date: e.target.value }))} /></Field>
          </div>
          <Field label="Reason"><Input value={d.reason ?? ""} onChange={(e) => setD((p) => ({ ...p, reason: e.target.value }))} /></Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Submit</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ================================================================ RECRUITMENT
export function HrRecruitmentPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: candidates, isLoading } = useQuery({
    queryKey: ["hr_candidates", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("hr_candidates").select("*").eq("project_id", projectId!).order("created_at", { ascending: false });
      return (data ?? []) as Candidate[];
    },
  });

  async function move(id: string, stage: Candidate["stage"]) {
    await supabase.from("hr_candidates").update({ stage }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["hr_candidates", projectId] });
  }

  const byStage = useMemo(() => {
    const m: Record<string, Candidate[]> = {};
    RECRUIT_STAGES.forEach((s) => (m[s] = []));
    (candidates ?? []).forEach((c) => { (m[c.stage] ??= []).push(c); });
    return m;
  }, [candidates]);

  return (
    <div className="space-y-5">
      <PageHeader title="Recruitment" description="Candidate pipeline — drag stages via the menu on each card." actions={<Button size="sm" onClick={() => setOpen(true)}><UserPlus className="h-4 w-4" /> Add candidate</Button>} />
      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {RECRUIT_STAGES.map((stage) => (
            <div key={stage} className="rounded-lg border border-border bg-muted/20 p-2">
              <div className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium">
                <span className={cn("h-2 w-2 rounded-full", STAGE_META[stage].accent)} />
                {STAGE_META[stage].label}
                <span className="ml-auto text-muted-foreground">{byStage[stage]?.length ?? 0}</span>
              </div>
              <div className="space-y-2">
                {(byStage[stage] ?? []).map((c) => (
                  <div key={c.id} className="rounded-md border border-border bg-card p-2.5">
                    <div className="text-sm font-medium">{c.full_name}</div>
                    {c.email && <div className="truncate text-[11px] text-muted-foreground">{c.email}</div>}
                    <select value={c.stage} onChange={(e) => move(c.id, e.target.value as Candidate["stage"])} className="mt-1.5 w-full rounded border border-input bg-background px-1 py-0.5 text-[11px]">
                      {RECRUIT_STAGES.map((s) => <option key={s} value={s}>{STAGE_META[s].label}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <CandidateDialog open={open} onOpenChange={setOpen} onCreate={async (draft) => {
        if (!workspaceId || !projectId) return;
        await supabase.from("hr_candidates").insert({ ...draft, workspace_id: workspaceId, project_id: projectId });
        queryClient.invalidateQueries({ queryKey: ["hr_candidates", projectId] });
        setOpen(false);
      }} />
    </div>
  );
}

function CandidateDialog({ open, onOpenChange, onCreate }: {
  open: boolean; onOpenChange: (o: boolean) => void; onCreate: (d: Partial<Candidate>) => Promise<void>;
}) {
  const [d, setD] = useState<Partial<Candidate>>({ stage: "applied" });
  const [saving, setSaving] = useState(false);
  async function submit() {
    if (!d.full_name?.trim()) return;
    setSaving(true);
    try { await onCreate(d); setD({ stage: "applied" }); } finally { setSaving(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Add candidate</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Field label="Full name"><Input value={d.full_name ?? ""} onChange={(e) => setD((p) => ({ ...p, full_name: e.target.value }))} autoFocus /></Field>
          <Field label="Email"><Input type="email" value={d.email ?? ""} onChange={(e) => setD((p) => ({ ...p, email: e.target.value }))} /></Field>
          <Field label="Resume URL"><Input value={d.resume_url ?? ""} onChange={(e) => setD((p) => ({ ...p, resume_url: e.target.value }))} /></Field>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Add</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==================================================================== PAYROLL
export function HrPayrollPage() {
  const { data: employees } = useEmployees();
  const totalMonthly = useMemo(() => (employees ?? []).reduce((s, e) => s + (e.salary_cents ?? 0) / 12, 0), [employees]);
  return (
    <div className="space-y-5">
      <PageHeader title="Payroll & documents" description="Compensation overview and HR documents." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <MetricCard label="Monthly payroll" value={fmtMoney(totalMonthly, "eur")} icon={Wallet} hint="Sum of annual salaries / 12" />
        <MetricCard label="Annual payroll" value={fmtMoney((employees ?? []).reduce((s, e) => s + (e.salary_cents ?? 0), 0), "eur")} icon={Wallet} />
        <MetricCard label="Employees" value={String((employees ?? []).length)} icon={UsersRound} />
      </div>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Compensation by employee</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
              <tr><th className="px-4 py-2">Employee</th><th className="px-4 py-2">Title</th><th className="px-4 py-2">Type</th><th className="px-4 py-2 text-right">Annual</th><th className="px-4 py-2 text-right">Monthly</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(employees ?? []).map((e) => (
                <tr key={e.id}>
                  <td className="px-4 py-2 font-medium">{e.avatar_emoji} {e.full_name}</td>
                  <td className="px-4 py-2 text-muted-foreground">{e.job_title || "—"}</td>
                  <td className="px-4 py-2 capitalize">{e.employment_type.replace("_", " ")}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(e.salary_cents, e.currency)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(e.salary_cents ? e.salary_cents / 12 : null, e.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
