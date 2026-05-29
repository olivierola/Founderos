import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Sparkles, FileText, FileCode2, Shield, Loader2, Play, Download } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { exportToJson } from "@/lib/utils";
import { useCurrentContext } from "@/hooks/useCurrentContext";

// --- Insights: aggregated AI risks/recommendations from latest scans ----
export function AiInsightsPage() {
  const { projectId } = useCurrentContext();
  const { data, isLoading } = useQuery({
    queryKey: ["ai_insights_scans", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_results")
        .select("id, ai_analysis, created_at, repositories(full_name)")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(5);
      return data ?? [];
    },
  });

  return (
    <div>
      <PageHeader title="Insights" description="AI-generated insights pulled from recent scans." />
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Sparkles} title="No insights yet" description="Run a scan first." />
      ) : (
        <div className="space-y-4">
          {data.map((scan: any) => {
            const recs = scan.ai_analysis?.recommendations ?? [];
            if (recs.length === 0) return null;
            return (
              <Card key={scan.id}>
                <CardContent className="p-5">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-sm font-medium">{scan.repositories?.full_name ?? "—"}</span>
                    <span className="text-xs text-muted-foreground">{new Date(scan.created_at).toLocaleDateString()}</span>
                  </div>
                  <ul className="space-y-2">
                    {recs.map((rec: any, i: number) => (
                      <li key={i} className="flex items-start gap-2 text-sm">
                        <Sparkles className="mt-0.5 h-3.5 w-3.5 text-primary" />
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{rec.title}</span>
                            <Badge variant="outline">{rec.category}</Badge>
                          </div>
                          <div className="text-xs text-muted-foreground">{rec.explanation}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- Reports (list of conversations + scan analyses as exportable items) -
export function AiReportsPage() {
  const { projectId } = useCurrentContext();
  const { data } = useQuery({
    queryKey: ["ai_reports", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ai_conversations")
        .select("id, title, updated_at")
        .eq("project_id", projectId!)
        .order("updated_at", { ascending: false })
        .limit(50);
      return data ?? [];
    },
  });
  async function exportConversation(id: string, title: string | null) {
    const { data: messages } = await supabase
      .from("ai_messages")
      .select("role, content, created_at")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true });
    exportToJson(
      { title: title ?? "Untitled", exported_at: new Date().toISOString(), messages: messages ?? [] },
      `ai-conversation-${(title ?? "untitled").slice(0, 30).replace(/\s+/g, "-")}.json`,
    );
  }

  return (
    <div>
      <PageHeader title="Reports" description="Saved AI conversations — export any thread as JSON." />
      {!data || data.length === 0 ? (
        <EmptyState icon={FileText} title="No reports yet" description="Start a chat from AI Agent → Chat." />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {data.map((c: any) => (
                <li key={c.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span>{c.title ?? "Untitled"}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">{new Date(c.updated_at).toLocaleString()}</span>
                    <Button size="sm" variant="outline" onClick={() => exportConversation(c.id, c.title)}>
                      <Download className="h-3.5 w-3.5" /> Export
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// AiWorkflowsPage moved to ./Workflows.tsx (real workflow builder)

// --- Prompt Templates / Guardrails ---------------------------
const TEMPLATES = [
  {
    name: "Weekly investor update",
    description: "Generates a short weekly update from Stripe metrics.",
    prompt: "Write a concise weekly investor update based on my latest metrics (MRR, ARR, churn, customers). Keep it to 5 bullet points.",
  },
  {
    name: "Cost anomaly explainer",
    description: "Explains a spike in LLM or infra costs.",
    prompt: "Look at my recent costs and LLM usage. Are there any anomalies or spikes? Explain the likely cause and how to reduce it.",
  },
  {
    name: "Scan summary",
    description: "Summarises latest scan in 3 bullets.",
    prompt: "Summarise my latest code scan in 3 bullet points: stack, top risks, and the single most important fix.",
  },
  {
    name: "Churn risk outreach",
    description: "Drafts an email to a customer with churn signals.",
    prompt: "Draft a short, friendly retention email for a customer showing churn signals (past due or canceling). Keep it under 120 words.",
  },
];

export function PromptTemplatesPage() {
  const { workspaceSlug, projectSlug } = useParams();
  const navigate = useNavigate();
  return (
    <div>
      <PageHeader title="Prompt Templates" description="One click to start a chat pre-filled with a proven prompt." />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {TEMPLATES.map((t) => (
          <Card key={t.name} className="flex flex-col">
            <CardContent className="flex flex-1 flex-col p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <FileCode2 className="h-4 w-4 text-primary" /> {t.name}
              </div>
              <p className="mt-1 flex-1 text-xs text-muted-foreground">{t.description}</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3 self-start"
                onClick={() =>
                  navigate(
                    `/app/${workspaceSlug}/${projectSlug}/ai/chat?prompt=${encodeURIComponent(t.prompt)}`,
                  )
                }
              >
                <Play className="h-3.5 w-3.5" /> Use template
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

const GUARDRAILS = [
  "The agent never executes a sensitive action without explicit user validation.",
  "The agent never displays a full secret in chat.",
  "The agent never writes to a client database without confirmation.",
  "The agent never deletes data without double confirmation.",
  "The agent never sends an email campaign without preview.",
];

export function GuardrailsPage() {
  return (
    <div>
      <PageHeader title="Guardrails" description="Hard rules the AI agent must never break." />
      <Card>
        <CardContent className="space-y-2 p-5">
          {GUARDRAILS.map((g, i) => (
            <div key={i} className="flex items-start gap-2 text-sm">
              <Shield className="mt-0.5 h-4 w-4 text-emerald-400" />
              <span>{g}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
