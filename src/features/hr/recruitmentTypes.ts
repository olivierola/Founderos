import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";

export interface Opening {
  id: string;
  title: string;
  department: string | null;
  location: string | null;
  employment_type: string;
  description: string | null;
  requirements: string | null;
  salary_range: string | null;
  status: "draft" | "open" | "paused" | "closed";
  opened_at: string | null;
  target_close: string | null;
  created_at: string;
}

export interface Stage {
  id: string;
  opening_id: string;
  name: string;
  position: number;
  kind: "applied" | "middle" | "interview" | "offer" | "hired" | "rejected";
}

export interface Candidate {
  id: string;
  opening_id: string | null;
  stage_id: string | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  source: string | null;
  source_ref: string | null;
  resume_url: string | null;
  resume_text: string | null;
  rating: number | null;
  notes: string | null;
  ai_score: number | null;
  ai_summary: string | null;
  ai_strengths: string | null;
  ai_gaps: string | null;
  ai_decision: "advance" | "review" | "reject" | null;
  human_override: boolean;
  ai_screened_at: string | null;
  applied_at: string | null;
  created_at: string;
}

export interface Criterion {
  id: string;
  opening_id: string;
  label: string;
  weight: number;
  position: number;
}

export interface Evaluation {
  id: string;
  candidate_id: string;
  criterion_id: string;
  score: number | null;
  comment: string | null;
}

export interface Interview {
  id: string;
  candidate_id: string;
  opening_id: string | null;
  title: string;
  kind: "phone" | "technical" | "culture" | "hr" | "panel" | "other";
  scheduled_at: string | null;
  duration_min: number;
  interviewers: string[];
  status: "scheduled" | "done" | "cancelled" | "no_show";
  feedback: string | null;
  rating: number | null;
  created_at: string;
}

export const OPENING_STATUS: Record<Opening["status"], { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
  open: { label: "Open", cls: "bg-emerald-500/15 text-emerald-600" },
  paused: { label: "Paused", cls: "bg-amber-500/15 text-amber-600" },
  closed: { label: "Closed", cls: "bg-muted text-muted-foreground" },
};

export const STAGE_KIND_ACCENT: Record<Stage["kind"], string> = {
  applied: "bg-zinc-400",
  middle: "bg-sky-500",
  interview: "bg-violet-500",
  offer: "bg-amber-500",
  hired: "bg-emerald-500",
  rejected: "bg-destructive",
};

export const INTERVIEW_KIND = ["phone", "technical", "culture", "hr", "panel", "other"] as const;

export async function screenCandidate(workspaceId: string, projectId: string, candidateId: string) {
  return callEdge<{ ok: boolean; score: number }>("hr-screen-candidate", {
    workspace_id: workspaceId, project_id: projectId, candidate_id: candidateId,
  });
}

// ─────────────────────────────────────────────────────────── candidate sourcing
// ATS providers we can pull candidatures from (must match CONNECTOR_ACTIONS slugs
// + the "Recruiting sources" group in connectorActionProviders.ts).
export const SOURCE_PROVIDERS: { slug: string; label: string; action: string }[] = [
  { slug: "greenhouse", label: "Greenhouse", action: "list_candidates" },
  { slug: "lever", label: "Lever", action: "list_candidates" },
  { slug: "workable", label: "Workable", action: "list_candidates" },
  { slug: "linkedin-talent", label: "LinkedIn Talent", action: "list_candidates" },
];

export interface SourcedCandidate {
  external_ref: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  resume_text: string | null;
}

// Normalize each provider's raw payload to a common shape. Providers return
// different envelopes (Lever: {data:[…]}, Workable: {candidates:[…]}, …).
export function normalizeSourced(slug: string, payload: any): SourcedCandidate[] {
  const rows: any[] =
    payload?.data ?? payload?.candidates ?? payload?.results ?? payload?.elements ??
    (Array.isArray(payload) ? payload : []);
  return rows
    .map((r): SourcedCandidate | null => {
      const name =
        r.name ?? r.full_name ??
        ([r.first_name ?? r.firstName, r.last_name ?? r.lastName].filter(Boolean).join(" ") || null);
      if (!name) return null;
      const email =
        r.email ?? r.emails?.[0] ?? r.email_addresses?.[0]?.value ??
        r.contact?.emails?.[0] ?? null;
      const phone = r.phone ?? r.phones?.[0]?.value ?? r.phone_numbers?.[0]?.value ?? null;
      const location =
        r.location ?? r.address ?? r.contact?.location?.name ?? r.headline ?? null;
      const resume =
        r.summary ?? r.headline ?? r.resume_text ??
        (Array.isArray(r.tags) ? r.tags.join(", ") : null);
      return {
        external_ref: String(r.id ?? r.candidate_id ?? email ?? name),
        full_name: name,
        email,
        phone,
        location: typeof location === "string" ? location : null,
        resume_text: typeof resume === "string" ? resume : null,
      };
    })
    .filter((x): x is SourcedCandidate => !!x);
}

export async function fetchSourcedCandidates(
  workspaceId: string, projectId: string, slug: string, action: string,
): Promise<SourcedCandidate[]> {
  const res = await callEdge<any>("connector-action", {
    workspace_id: workspaceId, project_id: projectId, provider: slug, action,
    params: { limit: 50 },
  });
  return normalizeSourced(slug, res?.result ?? res?.data ?? res);
}

// Weighted average of a candidate's evaluations (1-5) → 0-100.
export function weightedScore(evals: Evaluation[], criteria: Criterion[]): number | null {
  const byId = new Map(criteria.map((c) => [c.id, c.weight]));
  let num = 0, den = 0;
  for (const e of evals) {
    if (e.score == null) continue;
    const w = byId.get(e.criterion_id) ?? 1;
    num += e.score * w; den += 5 * w;
  }
  return den ? Math.round((num / den) * 100) : null;
}
