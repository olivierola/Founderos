import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Workflow, Plus, Play, Trash2, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  trigger_event: string;
  steps: { type: string; [k: string]: unknown }[];
  enabled: boolean;
  created_at: string;
}

const TRIGGER_EVENTS = [
  "scan.succeeded",
  "scan.failed",
  "cost.recorded",
  "stripe.synced",
  "alert.created",
  "automation.received",
];

const STEP_TYPES = ["log", "webhook", "create_alert", "create_incident"];

export function AiWorkflowsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [openCreate, setOpenCreate] = useState(false);
  const [running, setRunning] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["workflows", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("workflows")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as WorkflowRow[];
    },
  });

  async function deleteWorkflow(id: string) {
    if (!confirm("Delete workflow?")) return;
    await supabase.from("workflows").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["workflows", projectId] });
  }

  async function run(wf: WorkflowRow) {
    setRunning(wf.id);
    try {
      await callEdge("run-workflow", { workflow_id: wf.id, trigger_payload: { manual: true } });
    } finally {
      setRunning(null);
    }
  }

  async function toggleEnabled(wf: WorkflowRow) {
    await supabase.from("workflows").update({ enabled: !wf.enabled }).eq("id", wf.id);
    queryClient.invalidateQueries({ queryKey: ["workflows", projectId] });
  }

  if (!workspaceId || !projectId) return <PageHeader title="Workflows" />;

  return (
    <div>
      <PageHeader
        title="Workflows"
        description="Trigger → steps automations. Triggered by FounderOS events or manually."
        actions={
          <Button size="sm" onClick={() => setOpenCreate(true)}>
            <Plus className="h-4 w-4" /> New workflow
          </Button>
        }
      />

      {!data || data.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No workflows yet"
          description="Create your first workflow to react to events automatically."
        />
      ) : (
        <div className="space-y-3">
          {data.map((wf) => (
            <Card key={wf.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{wf.name}</span>
                      <Badge variant="outline">on {wf.trigger_event}</Badge>
                      {!wf.enabled && <Badge variant="secondary">disabled</Badge>}
                    </div>
                    {wf.description && <p className="mt-1 text-sm text-muted-foreground">{wf.description}</p>}
                    <div className="mt-2 flex flex-wrap gap-1">
                      {wf.steps.map((s, i) => (
                        <Badge key={i} variant="secondary">
                          {i + 1}. {s.type}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={() => toggleEnabled(wf)}>
                      {wf.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => run(wf)} disabled={running === wf.id}>
                      {running === wf.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      Run
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => deleteWorkflow(wf.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateWorkflowDialog
        open={openCreate}
        onOpenChange={setOpenCreate}
        workspaceId={workspaceId}
        projectId={projectId}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ["workflows", projectId] })}
      />
    </div>
  );
}

function CreateWorkflowDialog({
  open,
  onOpenChange,
  workspaceId,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  projectId: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState(TRIGGER_EVENTS[0]!);
  const [steps, setSteps] = useState<{ type: string; payload: Record<string, string> }[]>([]);
  const [saving, setSaving] = useState(false);

  function addStep() {
    setSteps([...steps, { type: "log", payload: { message: "" } }]);
  }
  function removeStep(i: number) {
    setSteps(steps.filter((_, j) => j !== i));
  }
  function updateStep(i: number, patch: Partial<{ type: string; payload: Record<string, string> }>) {
    const next = [...steps];
    next[i] = { ...next[i]!, ...patch };
    setSteps(next);
  }

  async function save() {
    setSaving(true);
    try {
      const cleanedSteps = steps.map((s) => ({ type: s.type, ...s.payload }));
      await supabase.from("workflows").insert({
        workspace_id: workspaceId,
        project_id: projectId,
        name,
        trigger_event: trigger,
        steps: cleanedSteps,
        enabled: true,
      });
      onOpenChange(false);
      setName("");
      setSteps([]);
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <div>
            <label className="text-xs text-muted-foreground">Trigger event</label>
            <select
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
              className="mt-1 flex h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
            >
              {TRIGGER_EVENTS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Steps</span>
              <Button size="sm" variant="outline" onClick={addStep}>
                <Plus className="h-3.5 w-3.5" /> Add step
              </Button>
            </div>
            <div className="space-y-2">
              {steps.map((s, i) => (
                <div key={i} className="space-y-2 rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between">
                    <select
                      value={s.type}
                      onChange={(e) => updateStep(i, { type: e.target.value, payload: {} })}
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                    >
                      {STEP_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                    <Button size="icon" variant="ghost" onClick={() => removeStep(i)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {s.type === "log" && (
                    <Input
                      placeholder="Message"
                      value={s.payload.message ?? ""}
                      onChange={(e) => updateStep(i, { payload: { ...s.payload, message: e.target.value } })}
                    />
                  )}
                  {s.type === "webhook" && (
                    <Input
                      placeholder="https://hooks.example.com/..."
                      value={s.payload.url ?? ""}
                      onChange={(e) => updateStep(i, { payload: { ...s.payload, url: e.target.value } })}
                    />
                  )}
                  {(s.type === "create_alert" || s.type === "create_incident") && (
                    <Input
                      placeholder="Title"
                      value={s.payload.title ?? ""}
                      onChange={(e) => updateStep(i, { payload: { ...s.payload, title: e.target.value } })}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving || !name || steps.length === 0}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
