// Shared types and helpers for the RAG Agent → Onboarding pages.

export type FlowKind = "flow" | "tour" | "checklist";

export interface OnboardingFlow {
  id: string;
  workspace_id: string;
  project_id: string;
  agent_id: string;
  name: string;
  description: string | null;
  kind: FlowKind;
  trigger: { event?: string; route?: string };
  enabled: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface OnboardingStep {
  id: string;
  flow_id: string;
  position: number;
  title: string;
  body: string | null;
  cta_label: string | null;
  cta_url: string | null;
  page_route: string | null;
  element_selector: string | null;
  complete_on: { event?: string; route?: string };
  metadata: Record<string, unknown>;
}

export interface OnboardingRun {
  id: string;
  agent_id: string;
  flow_id: string;
  visitor_id: string | null;
  external_user_id: string | null;
  status: "in_progress" | "completed" | "abandoned";
  current_step_position: number;
  started_at: string;
  last_activity_at: string;
  completed_at: string | null;
}

export const KIND_LABEL: Record<FlowKind, string> = {
  flow: "Flow",
  tour: "Tour",
  checklist: "Checklist",
};
