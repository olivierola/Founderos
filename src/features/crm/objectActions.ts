// Contextual actions per object class, shown in the record panel's "Actions"
// tab. Each action operates on the real source tables (no new edge function).
import { supabase } from "@/lib/supabase";
import type { CrmRecord } from "./objectModel";

export type ActionKind = "dialog" | "navigate" | "list";

export interface ObjectAction {
  id: string;
  label: string;
  icon: string;           // crmIcons name
  kind: ActionKind;
  // For navigate: build the in-app path. record.source_id = the real row id.
  path?: (record: CrmRecord, ctx: { workspaceSlug: string; projectSlug: string }) => string;
  // For dialog/list: an opaque key the panel maps to a component.
  component?: "assign_mission" | "deliverables" | "mission_deliverables";
}

// Actions keyed by object slug.
export const OBJECT_ACTIONS: Record<string, ObjectAction[]> = {
  autonomous_agents: [
    { id: "assign", label: "Assign a mission", icon: "Target", kind: "dialog", component: "assign_mission" },
    { id: "deliverables", label: "View deliverables", icon: "FileText", kind: "list", component: "deliverables" },
    { id: "open", label: "Open agent", icon: "Bot", kind: "navigate",
      path: (r, c) => `/app/${c.workspaceSlug}/${c.projectSlug}/agent/internal/${r.source_id}/chat` },
  ],
  public_agents: [
    { id: "open", label: "Open agent builder", icon: "Bot", kind: "navigate",
      path: (r, c) => `/app/${c.workspaceSlug}/${c.projectSlug}/agent/builder/${r.source_id}/playground` },
  ],
  missions: [
    { id: "deliverables", label: "View deliverables", icon: "FileText", kind: "list", component: "mission_deliverables" },
    { id: "open", label: "Open in agent", icon: "Bot", kind: "navigate",
      path: (r, c) => `/app/${c.workspaceSlug}/${c.projectSlug}/agent/internal-agents` },
  ],
  documents: [
    { id: "open", label: "Open document", icon: "FileText", kind: "navigate",
      path: (r, c) => `/app/${c.workspaceSlug}/${c.projectSlug}/office/document/${r.source_id}` },
  ],
  simulations: [
    { id: "open", label: "Open simulation", icon: "FlaskConical", kind: "navigate",
      path: (r, c) => `/app/${c.workspaceSlug}/${c.projectSlug}/pm/simulations` },
  ],
  discussions: [
    { id: "open", label: "Open channel", icon: "MessageSquare", kind: "navigate",
      path: (r, c) => `/app/${c.workspaceSlug}/${c.projectSlug}/pm/inbox?channel=${r.source_id}` },
  ],
  projects: [
    { id: "open", label: "Open in board", icon: "FolderKanban", kind: "navigate",
      path: (_r, c) => `/app/${c.workspaceSlug}/${c.projectSlug}/pm/boards` },
  ],
  tasks_pm: [
    { id: "open", label: "Open board", icon: "CheckSquare", kind: "navigate",
      path: (_r, c) => `/app/${c.workspaceSlug}/${c.projectSlug}/pm/boards` },
  ],
  whiteboards: [
    { id: "open", label: "Open whiteboard", icon: "PenSquare", kind: "navigate",
      path: (r, c) => `/app/${c.workspaceSlug}/${c.projectSlug}/pm/whiteboard?board=${r.source_id}` },
  ],
  inventory: [
    { id: "open", label: "Open inventory", icon: "Package", kind: "navigate",
      path: (_r, c) => `/app/${c.workspaceSlug}/${c.projectSlug}/supply/inventory` },
  ],
};

export function actionsForSlug(slug: string): ObjectAction[] {
  return OBJECT_ACTIONS[slug] ?? [];
}

// ── data helpers used by the action components ──

// Assign a mission to an agent (creates an internal_agent_missions row). The
// missions class then mirrors it live.
export async function assignMission(workspaceId: string, projectId: string, agentId: string, m: { title: string; brief: string }, userId: string | null) {
  const { error } = await supabase.from("internal_agent_missions").insert({
    workspace_id: workspaceId, project_id: projectId, agent_id: agentId,
    title: m.title, brief: m.brief || null, status: "active", created_by: userId,
  });
  if (error) throw new Error(error.message);
}

export interface Deliverable { id: string; kind: string; name: string; content: string | null; file_url: string | null; created_at: string }

export async function fetchAgentDeliverables(agentId: string): Promise<Deliverable[]> {
  const { data } = await supabase.from("internal_agent_deliverables")
    .select("id, kind, name, content, file_url, created_at").eq("agent_id", agentId)
    .order("created_at", { ascending: false }).limit(50);
  return (data ?? []) as Deliverable[];
}

export async function fetchMissionDeliverables(missionId: string): Promise<Deliverable[]> {
  const { data } = await supabase.from("internal_agent_deliverables")
    .select("id, kind, name, content, file_url, created_at").eq("mission_id", missionId)
    .order("created_at", { ascending: false }).limit(50);
  return (data ?? []) as Deliverable[];
}
