import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Trash2,
  GripVertical,
  Loader2,
  Save,
  ExternalLink,
  Code2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { OnboardingFlow, OnboardingStep, FlowKind } from "./common";

interface Props {
  agentId: string;
  workspaceId: string;
  projectId: string;
  /** Filter the flow kind shown in this editor. */
  kind: FlowKind;
  /** Page title shown above the list. */
  emptyTitle: string;
  emptyDescription: string;
}

export function FlowEditor({ agentId, workspaceId, projectId, kind, emptyTitle, emptyDescription }: Props) {
  const queryClient = useQueryClient();
  const [openFlowId, setOpenFlowId] = useState<string | null>(null);

  const { data: flows, isLoading } = useQuery({
    queryKey: ["onb_flows", agentId, kind],
    enabled: !!agentId,
    queryFn: async () => {
      const { data } = await supabase
        .from("rag_onboarding_flows")
        .select("*")
        .eq("agent_id", agentId)
        .eq("kind", kind)
        .order("position", { ascending: true });
      return (data ?? []) as OnboardingFlow[];
    },
  });

  async function createFlow() {
    const position = (flows?.length ?? 0) + 1;
    const { data } = await supabase
      .from("rag_onboarding_flows")
      .insert({
        workspace_id: workspaceId,
        project_id: projectId,
        agent_id: agentId,
        name: `New ${kind}`,
        kind,
        enabled: true,
        position,
      })
      .select()
      .single();
    if (data) setOpenFlowId(data.id);
    queryClient.invalidateQueries({ queryKey: ["onb_flows", agentId, kind] });
  }

  async function deleteFlow(id: string) {
    if (!confirm("Delete this flow and its steps?")) return;
    await supabase.from("rag_onboarding_flows").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["onb_flows", agentId, kind] });
  }

  async function updateFlow(id: string, patch: Partial<OnboardingFlow>) {
    await supabase.from("rag_onboarding_flows").update(patch).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["onb_flows", agentId, kind] });
  }

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-end">
        <Button size="sm" onClick={createFlow}>
          <Plus className="h-4 w-4" /> New {kind}
        </Button>
      </div>

      {(flows ?? []).length === 0 ? (
        <EmptyState
          icon={Plus}
          title={emptyTitle}
          description={emptyDescription}
          action={
            <Button onClick={createFlow}>
              <Plus className="h-4 w-4" /> Create your first {kind}
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {flows!.map((flow) => (
            <FlowCard
              key={flow.id}
              flow={flow}
              open={openFlowId === flow.id}
              onToggle={() => setOpenFlowId(openFlowId === flow.id ? null : flow.id)}
              onDelete={() => deleteFlow(flow.id)}
              onUpdate={(patch) => updateFlow(flow.id, patch)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface FlowCardProps {
  flow: OnboardingFlow;
  open: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onUpdate: (patch: Partial<OnboardingFlow>) => Promise<void>;
}

function FlowCard({ flow, open, onToggle, onDelete, onUpdate }: FlowCardProps) {
  const [name, setName] = useState(flow.name);
  const [description, setDescription] = useState(flow.description ?? "");
  const [triggerEvent, setTriggerEvent] = useState(flow.trigger?.event ?? "");
  const [triggerRoute, setTriggerRoute] = useState(flow.trigger?.route ?? "");
  const [enabled, setEnabled] = useState(flow.enabled);
  const [savingMeta, setSavingMeta] = useState(false);

  async function saveMeta() {
    setSavingMeta(true);
    try {
      await onUpdate({
        name,
        description: description || null,
        trigger: {
          ...(triggerEvent ? { event: triggerEvent } : {}),
          ...(triggerRoute ? { route: triggerRoute } : {}),
        },
        enabled,
      });
    } finally {
      setSavingMeta(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-0">
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/40"
        >
          <div className="flex items-center gap-3">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <div>
              <div className="text-sm font-medium">{flow.name}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {flow.description || "No description"}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {flow.trigger?.event && (
              <Badge variant="outline" className="text-[10px]">
                on {flow.trigger.event}
              </Badge>
            )}
            {flow.trigger?.route && (
              <Badge variant="outline" className="text-[10px]">
                at {flow.trigger.route}
              </Badge>
            )}
            <Badge variant={flow.enabled ? "success" : "outline"}>
              {flow.enabled ? "enabled" : "disabled"}
            </Badge>
          </div>
        </button>

        {open && (
          <div className="space-y-4 border-t border-border p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Name</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Trigger event (optional)</label>
                <Input
                  value={triggerEvent}
                  onChange={(e) => setTriggerEvent(e.target.value)}
                  placeholder="user.signup"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <label className="text-xs text-muted-foreground">Description</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Trigger route (optional)</label>
                <Input
                  value={triggerRoute}
                  onChange={(e) => setTriggerRoute(e.target.value)}
                  placeholder="/dashboard"
                  className="font-mono text-xs"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="h-4 w-4 accent-[hsl(var(--primary-soft))]"
                />
                Enabled
              </label>
            </div>

            <div className="flex justify-between gap-2 border-t border-border pt-4">
              <Button variant="ghost" size="sm" onClick={onDelete}>
                <Trash2 className="h-4 w-4" /> Delete flow
              </Button>
              <Button size="sm" onClick={saveMeta} disabled={savingMeta}>
                {savingMeta ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save
              </Button>
            </div>

            <StepsList flowId={flow.id} kind={flow.kind} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StepsList({ flowId, kind }: { flowId: string; kind: FlowKind }) {
  const queryClient = useQueryClient();
  const { data: steps } = useQuery({
    queryKey: ["onb_steps", flowId],
    queryFn: async () => {
      const { data } = await supabase
        .from("rag_onboarding_steps")
        .select("*")
        .eq("flow_id", flowId)
        .order("position", { ascending: true });
      return (data ?? []) as OnboardingStep[];
    },
  });

  async function addStep() {
    const position = (steps?.length ?? 0) + 1;
    await supabase.from("rag_onboarding_steps").insert({
      flow_id: flowId,
      position,
      title: `Step ${position}`,
      body: "",
    });
    queryClient.invalidateQueries({ queryKey: ["onb_steps", flowId] });
  }

  async function updateStep(id: string, patch: Partial<OnboardingStep>) {
    await supabase.from("rag_onboarding_steps").update(patch).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["onb_steps", flowId] });
  }

  async function deleteStep(id: string) {
    await supabase.from("rag_onboarding_steps").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["onb_steps", flowId] });
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Steps
        </span>
        <Button size="sm" variant="outline" onClick={addStep}>
          <Plus className="h-3.5 w-3.5" /> Add step
        </Button>
      </div>

      {(steps ?? []).length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          No steps yet. Add at least one for the agent to follow.
        </p>
      ) : (
        <div className="space-y-2">
          {steps!.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              kind={kind}
              onUpdate={(patch) => updateStep(step.id, patch)}
              onDelete={() => deleteStep(step.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface StepRowProps {
  step: OnboardingStep;
  kind: FlowKind;
  onUpdate: (patch: Partial<OnboardingStep>) => Promise<void>;
  onDelete: () => Promise<void>;
}

function StepRow({ step, kind, onUpdate, onDelete }: StepRowProps) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState(step);
  const [saving, setSaving] = useState(false);

  function patch<K extends keyof OnboardingStep>(key: K, value: OnboardingStep[K]) {
    setLocal({ ...local, [key]: value });
  }

  async function save() {
    setSaving(true);
    try {
      await onUpdate({
        title: local.title,
        body: local.body,
        cta_label: local.cta_label,
        cta_url: local.cta_url,
        page_route: local.page_route,
        element_selector: local.element_selector,
        complete_on: local.complete_on,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-md border border-border bg-secondary/20">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-secondary/30"
      >
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold">
          {step.position}
        </span>
        <span className="flex-1 truncate text-sm">{local.title || "Untitled step"}</span>
        {step.cta_url && (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <ExternalLink className="h-2.5 w-2.5" />
            CTA
          </Badge>
        )}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-border p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Title</label>
              <Input value={local.title} onChange={(e) => patch("title", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">CTA label (optional)</label>
              <Input
                value={local.cta_label ?? ""}
                onChange={(e) => patch("cta_label", e.target.value || null)}
                placeholder="Open billing"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <label className="text-xs text-muted-foreground">Body (markdown)</label>
              <textarea
                value={local.body ?? ""}
                onChange={(e) => patch("body", e.target.value)}
                rows={3}
                placeholder="What should the agent tell the user at this step?"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">CTA URL (optional)</label>
              <Input
                value={local.cta_url ?? ""}
                onChange={(e) => patch("cta_url", e.target.value || null)}
                placeholder="/billing"
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Auto-complete on event (optional)</label>
              <Input
                value={(local.complete_on?.event as string | undefined) ?? ""}
                onChange={(e) =>
                  patch(
                    "complete_on",
                    e.target.value
                      ? { ...(local.complete_on ?? {}), event: e.target.value }
                      : { ...(local.complete_on ?? {}), event: undefined },
                  )
                }
                placeholder="payment.first_success"
                className="font-mono text-xs"
              />
            </div>

            {kind === "tour" && (
              <>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">Page route</label>
                  <Input
                    value={local.page_route ?? ""}
                    onChange={(e) => patch("page_route", e.target.value || null)}
                    placeholder="/dashboard"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">Element selector</label>
                  <Input
                    value={local.element_selector ?? ""}
                    onChange={(e) => patch("element_selector", e.target.value || null)}
                    placeholder="#new-project-btn"
                    className="font-mono text-xs"
                  />
                </div>
              </>
            )}
          </div>

          <div className="flex justify-between gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" onClick={onDelete}>
              <Trash2 className="h-4 w-4" /> Delete step
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Code2 className="h-4 w-4" />}
              Save step
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
