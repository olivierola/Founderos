import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";

export interface Ticket {
  id: string;
  subject: string;
  body: string | null;
  requester_email: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  status: "open" | "pending" | "on_hold" | "solved" | "closed";
  category: string | null;
  channel: string | null;
  assignee_id: string | null;
  tags: string[];
  first_response_at: string | null;
  first_response_due: string | null;
  resolution_due: string | null;
  solved_at: string | null;
  csat: number | null;
  csat_comment: string | null;
  last_activity_at: string | null;
  created_at: string;
}

export interface TicketMessage {
  id: string;
  ticket_id: string;
  author: "agent" | "customer";
  body: string;
  is_internal: boolean;
  via_ai: boolean;
  created_at: string;
}

export interface Macro {
  id: string;
  title: string;
  body: string;
  category: string | null;
  created_at: string;
}

export interface Article {
  id: string;
  title: string;
  body: string | null;
  category: string | null;
  status: "draft" | "published" | "archived";
  created_at: string;
}

export const STATUS_META: Record<Ticket["status"], { label: string; cls: string }> = {
  open: { label: "Open", cls: "bg-sky-500/15 text-sky-600" },
  pending: { label: "Pending", cls: "bg-amber-500/15 text-amber-600" },
  on_hold: { label: "On hold", cls: "bg-muted text-muted-foreground" },
  solved: { label: "Solved", cls: "bg-emerald-500/15 text-emerald-600" },
  closed: { label: "Closed", cls: "bg-muted text-muted-foreground" },
};
export const PRIORITY_META: Record<Ticket["priority"], { label: string; dot: string }> = {
  low: { label: "Low", dot: "bg-muted-foreground/50" },
  normal: { label: "Normal", dot: "bg-sky-500" },
  high: { label: "High", dot: "bg-amber-500" },
  urgent: { label: "Urgent", dot: "bg-destructive" },
};

// SLA targets (hours) by priority: [first response, resolution].
export const SLA_HOURS: Record<Ticket["priority"], [number, number]> = {
  urgent: [1, 8],
  high: [4, 24],
  normal: [8, 72],
  low: [24, 120],
};

export function computeSla(priority: Ticket["priority"], from = new Date()): { first_response_due: string; resolution_due: string } {
  const [fr, res] = SLA_HOURS[priority];
  return {
    first_response_due: new Date(from.getTime() + fr * 3600_000).toISOString(),
    resolution_due: new Date(from.getTime() + res * 3600_000).toISOString(),
  };
}

// SLA status for the queue: which clock is running and whether it's breached.
export function slaState(t: Ticket): { label: string; breached: boolean; soon: boolean } | null {
  if (t.status === "solved" || t.status === "closed") return null;
  const now = Date.now();
  // First-response clock until the agent first replies; then resolution clock.
  const target = !t.first_response_at && t.first_response_due
    ? { due: t.first_response_due, kind: "1st reply" }
    : t.resolution_due
      ? { due: t.resolution_due, kind: "resolve" }
      : null;
  if (!target) return null;
  const diff = new Date(target.due).getTime() - now;
  const mins = Math.round(diff / 60000);
  const breached = diff < 0;
  const soon = !breached && diff < 60 * 60000;
  let label: string;
  if (breached) label = `${target.kind} overdue ${fmtDur(-mins)}`;
  else label = `${target.kind} in ${fmtDur(mins)}`;
  return { label, breached, soon };
}

function fmtDur(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function relativeDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export interface MemberRow { user_id: string; email: string | null; full_name: string | null }

export async function loadWorkspaceMembers(workspaceId: string): Promise<MemberRow[]> {
  const { data } = await supabase
    .from("workspace_members")
    .select("user_id, profiles:profiles!workspace_members_user_id_fkey(email, full_name)")
    .eq("workspace_id", workspaceId);
  return (data ?? []).map((m: any) => ({
    user_id: m.user_id,
    email: m.profiles?.email ?? null,
    full_name: m.profiles?.full_name ?? null,
  }));
}

export function memberLabel(m: MemberRow | undefined, fallbackId?: string | null): string {
  if (!m) return fallbackId ? fallbackId.slice(0, 8) + "…" : "Unassigned";
  return m.full_name ?? m.email ?? m.user_id.slice(0, 8) + "…";
}

export async function callSupportAi(
  workspaceId: string, projectId: string, ticketId: string,
  action: "suggest_reply" | "summarize" | "sentiment",
): Promise<string> {
  const res = await callEdge<{ content: string }>("support-ai", {
    workspace_id: workspaceId, project_id: projectId, ticket_id: ticketId, action,
  });
  return res.content;
}
