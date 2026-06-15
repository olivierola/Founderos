import { supabase } from "@/lib/supabase";

export interface Employee {
  id: string;
  full_name: string;
  email: string | null;
  job_title: string | null;
  department: string | null;
  manager_id: string | null;
  employment_type: "full_time" | "part_time" | "contractor" | "intern";
  status: "active" | "on_leave" | "terminated" | "candidate";
  start_date: string | null;
  end_date: string | null;
  location: string | null;
  salary_cents: number | null;
  currency: string;
  avatar_emoji: string | null;
  notes: string | null;
  created_at: string;
}

export interface LeaveRequest {
  id: string;
  employee_id: string;
  kind: "paid" | "unpaid" | "sick" | "parental" | "other";
  start_date: string;
  end_date: string;
  days: number | null;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  created_at: string;
}

export interface JobOpening {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  employment_type: string;
  description: string | null;
  status: "draft" | "open" | "paused" | "closed";
  created_at: string;
}

export interface Candidate {
  id: string;
  opening_id: string | null;
  full_name: string;
  email: string | null;
  resume_url: string | null;
  stage: "applied" | "screening" | "interview" | "offer" | "hired" | "rejected";
  rating: number | null;
  notes: string | null;
  created_at: string;
}

export interface HrDocument {
  id: string;
  employee_id: string;
  kind: "contract" | "payslip" | "id" | "certificate" | "other";
  name: string;
  file_url: string | null;
  content: string | null;
  period: string | null;
  created_at: string;
}

export const EMPLOYMENT_TYPES = ["full_time", "part_time", "contractor", "intern"] as const;
export const EMP_STATUS_META: Record<Employee["status"], { label: string; cls: string }> = {
  active: { label: "Active", cls: "bg-emerald-500/15 text-emerald-600" },
  on_leave: { label: "On leave", cls: "bg-amber-500/15 text-amber-600" },
  terminated: { label: "Terminated", cls: "bg-muted text-muted-foreground" },
  candidate: { label: "Candidate", cls: "bg-sky-500/15 text-sky-600" },
};

export const LEAVE_STATUS_META: Record<LeaveRequest["status"], { label: string; cls: string }> = {
  pending: { label: "Pending", cls: "bg-amber-500/15 text-amber-600" },
  approved: { label: "Approved", cls: "bg-emerald-500/15 text-emerald-600" },
  rejected: { label: "Rejected", cls: "bg-destructive/15 text-destructive" },
  cancelled: { label: "Cancelled", cls: "bg-muted text-muted-foreground" },
};

export const RECRUIT_STAGES = ["applied", "screening", "interview", "offer", "hired", "rejected"] as const;
export const STAGE_META: Record<Candidate["stage"], { label: string; accent: string }> = {
  applied: { label: "Applied", accent: "bg-zinc-400" },
  screening: { label: "Screening", accent: "bg-sky-500" },
  interview: { label: "Interview", accent: "bg-violet-500" },
  offer: { label: "Offer", accent: "bg-amber-500" },
  hired: { label: "Hired", accent: "bg-emerald-500" },
  rejected: { label: "Rejected", accent: "bg-destructive" },
};

export function fmtMoney(cents: number | null | undefined, currency = "eur"): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(cents / 100);
}

export function daysBetween(a: string, b: string): number {
  const d = (new Date(b).getTime() - new Date(a).getTime()) / 86400000;
  return Math.max(0, Math.round(d) + 1);
}

export async function loadEmployees(projectId: string): Promise<Employee[]> {
  const { data } = await supabase
    .from("hr_employees")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  return (data ?? []) as Employee[];
}
