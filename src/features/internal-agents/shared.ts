// Shared types + helpers for the internal-agents feature. Kept framework-light
// so both the detail tabs and the new deliverables hub / mission wizard can
// import them without circular deps.

import { supabase } from "@/lib/supabase";

export interface InternalAgent {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  description: string | null;
  avatar_emoji: string | null;
  accent_color: string | null;
  persona: string | null;
  instructions: string | null;
  instruction_blocks: InstructionBlock[];
  model: string;
  temperature: number;
  max_steps: number;
  max_run_cost_usd: number;
  chat_enabled: boolean;
  mission_enabled: boolean;
  // Collaboration ecosystem.
  role: string | null;
  skills: string[];
  collaboration_enabled: boolean;
  created_by: string;
  is_archived: boolean;
  created_at: string;
}

// --- collaboration ecosystem ------------------------------------------------

export interface A2AMessage {
  id: string;
  thread_id: string;
  from_agent: string;
  to_agent: string;
  content: string;
  status: "pending" | "processing" | "answered" | "ignored";
  reply_to: string | null;
  created_at: string;
}

export interface A2AThread {
  id: string;
  agent_a: string;
  agent_b: string;
  topic: string | null;
  updated_at: string;
}

export interface TeamMemory {
  id: string;
  kind: "fact" | "preference" | "learning" | "context" | "decision";
  content: string;
  author_agent: string | null;
  source: "agent" | "user";
  importance: number;
  is_pinned: boolean;
  created_at: string;
}

export type InstructionBlockKind =
  | "role"
  | "tone"
  | "steps"
  | "constraints"
  | "output_format"
  | "context"
  | "custom";

export interface InstructionBlock {
  id: string;
  kind: InstructionBlockKind;
  title: string;
  body: string;
}

export type MissionPriority = "low" | "normal" | "high" | "urgent";
export type MissionSchedule = "daily" | "weekly" | "monthly" | null;

export interface ExpectedDeliverable {
  kind: string;
  name: string;
  description?: string;
}

export interface Mission {
  id: string;
  agent_id: string;
  title: string;
  brief: string | null;
  acceptance_criteria: string | null;
  expected_deliverables: ExpectedDeliverable[];
  status: "draft" | "active" | "archived";
  priority: MissionPriority;
  due_date: string | null;
  assigned_to: string | null;
  tags: string[];
  schedule: MissionSchedule;
  board_column: BoardColumn;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

export type BoardColumn = "backlog" | "todo" | "in_progress" | "review" | "done";

export const BOARD_COLUMNS: { key: BoardColumn; label: string; accent: string }[] = [
  { key: "backlog", label: "Backlog", accent: "bg-muted-foreground/40" },
  { key: "todo", label: "To do", accent: "bg-sky-500" },
  { key: "in_progress", label: "In progress", accent: "bg-amber-500" },
  { key: "review", label: "Review", accent: "bg-violet-500" },
  { key: "done", label: "Done", accent: "bg-emerald-500" },
];

export interface MissionRun {
  id: string;
  mission_id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  triggered_via: "manual" | "schedule" | "api";
  started_at: string | null;
  finished_at: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  action_count: number;
  steps: number;
  final_output: string | null;
  error_message: string | null;
  created_at: string;
}

export interface RunEvent {
  id: string;
  run_id: string;
  kind: "llm_call" | "tool_call" | "tool_result" | "status" | "log" | "error";
  payload: Record<string, any>;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  created_at: string;
}

export interface AgentConversation {
  id: string;
  agent_id: string;
  title: string | null;
  user_id: string;
  created_at: string;
  updated_at: string;
}

export type MemoryKind = "fact" | "preference" | "learning" | "context";

export interface AgentMemory {
  id: string;
  agent_id: string;
  kind: MemoryKind;
  content: string;
  source: "agent" | "user";
  source_run_id: string | null;
  source_conversation_id: string | null;
  importance: number;
  is_pinned: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const MEMORY_KIND_META: Record<MemoryKind, { label: string; emoji: string; cls: string }> = {
  fact: { label: "Fact", emoji: "📌", cls: "bg-sky-500/15 text-sky-600" },
  preference: { label: "Preference", emoji: "⚙️", cls: "bg-violet-500/15 text-violet-600" },
  learning: { label: "Learning", emoji: "💡", cls: "bg-amber-500/15 text-amber-600" },
  context: { label: "Context", emoji: "📚", cls: "bg-emerald-500/15 text-emerald-600" },
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "failed";

export interface AgentApproval {
  id: string;
  agent_id: string;
  run_id: string | null;
  mission_id: string | null;
  tool_name: string;
  action_kind: "edge_function" | "webhook";
  payload: Record<string, any>;
  reason: string | null;
  status: ApprovalStatus;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  executed_at: string | null;
  result: Record<string, any> | null;
  error_message: string | null;
}

export interface Deliverable {
  id: string;
  run_id: string;
  mission_id: string;
  agent_id: string;
  kind: string;
  name: string;
  content: string | null;
  file_url: string | null;
  summary: string | null;
  is_pinned: boolean;
  created_at: string;
}

export interface WorkspaceMemberRow {
  user_id: string;
  email: string | null;
  full_name: string | null;
}

export const DELIVERABLE_KINDS = ["markdown", "json", "file", "url", "code"] as const;

export const PRIORITY_META: Record<
  MissionPriority,
  { label: string; color: string; dot: string }
> = {
  low: { label: "Low", color: "text-muted-foreground", dot: "bg-muted-foreground/50" },
  normal: { label: "Normal", color: "text-sky-600", dot: "bg-sky-500" },
  high: { label: "High", color: "text-amber-600", dot: "bg-amber-500" },
  urgent: { label: "Urgent", color: "text-destructive", dot: "bg-destructive" },
};

export const INSTRUCTION_BLOCK_META: Record<
  InstructionBlockKind,
  { label: string; placeholder: string; emoji: string }
> = {
  role: {
    label: "Role & purpose",
    emoji: "🎯",
    placeholder: "You are a senior product analyst. Your job is to…",
  },
  tone: {
    label: "Tone & voice",
    emoji: "🗣️",
    placeholder: "Write concisely and professionally. Avoid jargon. Be direct.",
  },
  steps: {
    label: "Process / steps",
    emoji: "📋",
    placeholder: "1. Gather the inputs\n2. Analyse\n3. Draft the output\n4. Self-review against the criteria",
  },
  constraints: {
    label: "Constraints & guardrails",
    emoji: "🚧",
    placeholder: "Never invent data. Cite sources. Stay under 800 words. Don't contact customers.",
  },
  output_format: {
    label: "Output format",
    emoji: "📄",
    placeholder: "Return a markdown document with: Summary, Findings, Recommendations.",
  },
  context: {
    label: "Background context",
    emoji: "📚",
    placeholder: "Our product is a B2B SaaS for agencies. Our ICP is…",
  },
  custom: { label: "Custom section", emoji: "✨", placeholder: "" },
};

// Render structured instruction blocks into the flat `instructions` string the
// worker reads. Keeps the worker contract unchanged while letting the editor
// store structure.
export function renderInstructionBlocks(blocks: InstructionBlock[]): string {
  return blocks
    .filter((b) => b.body.trim())
    .map((b) => {
      const title = b.title.trim() || INSTRUCTION_BLOCK_META[b.kind]?.label || "Section";
      return `## ${title}\n${b.body.trim()}`;
    })
    .join("\n\n");
}

export function newInstructionBlock(kind: InstructionBlockKind): InstructionBlock {
  return {
    id: crypto.randomUUID(),
    kind,
    title: INSTRUCTION_BLOCK_META[kind].label,
    body: "",
  };
}

// Load workspace members (with profile email/name) for assignment pickers.
export async function loadWorkspaceMembers(
  workspaceId: string,
): Promise<WorkspaceMemberRow[]> {
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

export function memberLabel(m: WorkspaceMemberRow | undefined, fallbackId?: string): string {
  if (!m) return fallbackId ? fallbackId.slice(0, 8) + "…" : "Unassigned";
  return m.full_name ?? m.email ?? m.user_id.slice(0, 8) + "…";
}

export function downloadDeliverable(d: Pick<Deliverable, "name" | "kind" | "content">) {
  const ext = d.kind === "markdown" ? "md" : d.kind === "json" ? "json" : d.kind === "code" ? "txt" : "txt";
  const mime = d.kind === "json" ? "application/json" : "text/plain";
  const blob = new Blob([d.content ?? ""], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${d.name}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

export function relativeDate(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function dueDateMeta(due: string | null): { label: string; overdue: boolean } | null {
  if (!due) return null;
  const d = new Date(due);
  const diff = d.getTime() - Date.now();
  const days = Math.round(diff / 86400000);
  const overdue = diff < 0;
  let label: string;
  if (overdue) label = `Overdue by ${Math.abs(days)}d`;
  else if (days === 0) label = "Due today";
  else if (days === 1) label = "Due tomorrow";
  else label = `Due in ${days}d`;
  return { label, overdue };
}
