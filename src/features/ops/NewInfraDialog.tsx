import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  Sparkles, Loader2, ArrowLeft, Brain, ListChecks, Wand2,
  AlertTriangle, Plus, Trash2, ChevronRight, Check,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { cn } from "@/lib/utils";
import { useOpsUrl } from "./hooks";

// ============================================================================
// Plan model — must stay in sync with ops-plan-infra / ops-generate-infra.
// ============================================================================

export interface PlanLayer {
  id: string;
  label: string;
  tool: "terraform" | "ansible" | "docker_compose" | "kubernetes" | "helm" | "script";
  purpose: string;
  inputs?: string[];
  outputs?: string[];
  depends_on?: string[];
  risk_level?: "low" | "medium" | "high";
  notes?: string;
}

export interface Plan {
  summary: string;
  layers: PlanLayer[];
  execution_order: string[];
  assumptions?: string[];
  open_questions?: string[];
}

const TOOLS: { value: PlanLayer["tool"]; label: string; color: string }[] = [
  { value: "terraform",      label: "Terraform",      color: "bg-violet-500/15 text-violet-500" },
  { value: "ansible",        label: "Ansible",        color: "bg-rose-500/15 text-rose-500" },
  { value: "docker_compose", label: "Docker Compose", color: "bg-blue-500/15 text-blue-500" },
  { value: "kubernetes",     label: "Kubernetes",     color: "bg-cyan-500/15 text-cyan-500" },
  { value: "helm",           label: "Helm",           color: "bg-indigo-500/15 text-indigo-500" },
  { value: "script",         label: "Script",         color: "bg-amber-500/15 text-amber-500" },
];

type Step = "brief" | "plan" | "generating";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function NewInfraDialog({ open, onOpenChange }: Props) {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const url = useOpsUrl();

  const [step, setStep] = useState<Step>("brief");
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [infraId, setInfraId] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [generating, setGenerating] = useState(false);

  function reset() {
    setStep("brief"); setName(""); setBrief("");
    setPlanning(false); setPlanError(null);
    setInfraId(null); setPlan(null); setGenerating(false);
  }

  async function runPlan() {
    if (!workspaceId || !projectId || !brief.trim()) return;
    setPlanning(true);
    setPlanError(null);
    try {
      const result = await callEdge<{ ok: boolean; infra_id?: string; plan?: Plan; message?: string }>(
        "ops-plan-infra",
        {
          workspace_id: workspaceId,
          project_id: projectId,
          name: name.trim() || "Untitled infra",
          brief: brief.trim(),
          existing_id: infraId,
        },
      );
      if (!result.ok || !result.plan || !result.infra_id) {
        throw new Error(result.message ?? "Planner failed");
      }
      setInfraId(result.infra_id);
      setPlan(result.plan);
      setStep("plan");
    } catch (e: any) {
      setPlanError(e?.message ?? "Could not produce a plan.");
    } finally {
      setPlanning(false);
    }
  }

  async function runGenerate() {
    if (!infraId || !plan) return;
    setGenerating(true);
    setStep("generating");
    try {
      await callEdge("ops-generate-infra", {
        infra_id: infraId,
        plan_overrides: plan,
      });
      queryClient.invalidateQueries({ queryKey: ["ops_infra_projects", projectId] });
      reset();
      onOpenChange(false);
      navigate(url(`/devops/infra/${infraId}`));
    } catch (e: any) {
      setPlanError(e?.message ?? "Generation failed");
      setStep("plan");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            New infrastructure
            <StepIndicator step={step} />
          </DialogTitle>
        </DialogHeader>

        {step === "brief" && (
          <BriefStep
            name={name} onName={setName}
            brief={brief} onBrief={setBrief}
            error={planError}
            planning={planning}
            onCancel={() => onOpenChange(false)}
            onNext={runPlan}
          />
        )}

        {step === "plan" && plan && (
          <PlanStep
            plan={plan}
            onPlanChange={setPlan}
            generating={generating}
            error={planError}
            onBack={() => setStep("brief")}
            onReplan={runPlan}
            replanning={planning}
            onGenerate={runGenerate}
          />
        )}

        {step === "generating" && (
          <GeneratingStep brief={brief} layerCount={plan?.layers.length ?? 0} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function StepIndicator({ step }: { step: Step }) {
  const items: { id: Step; label: string; icon: any }[] = [
    { id: "brief", label: "Brief", icon: Brain },
    { id: "plan", label: "Plan", icon: ListChecks },
    { id: "generating", label: "Generate", icon: Sparkles },
  ];
  const activeIdx = items.findIndex((i) => i.id === step);
  return (
    <div className="ml-3 flex items-center gap-1">
      {items.map((it, i) => {
        const Icon = it.icon;
        const done = i < activeIdx;
        const active = i === activeIdx;
        return (
          <div key={it.id} className="flex items-center gap-1">
            <div className={cn(
              "flex h-5 items-center gap-1 rounded-full px-1.5 text-[10px] font-medium",
              done && "bg-emerald-500/15 text-emerald-500",
              active && "bg-foreground text-background",
              !done && !active && "bg-muted text-muted-foreground",
            )}>
              <Icon className="h-2.5 w-2.5" /> {it.label}
            </div>
            {i < items.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// Step 1 — Brief
// ============================================================================

function BriefStep({
  name, onName, brief, onBrief, error, planning, onCancel, onNext,
}: {
  name: string; onName: (v: string) => void;
  brief: string; onBrief: (v: string) => void;
  error: string | null;
  planning: boolean;
  onCancel: () => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <Label>Name</Label>
        <Input value={name} onChange={(e) => onName(e.target.value)} placeholder="prod-01 infra" autoFocus />
      </div>
      <div>
        <Label>Describe the infrastructure you want</Label>
        <textarea
          value={brief}
          onChange={(e) => onBrief(e.target.value)}
          rows={10}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder={`Example:

I want Terraform to provision 2 small Hetzner Cloud VPS (Ubuntu 22.04) + a firewall + a DNS record on app.example.com.
Then use Ansible to harden both servers and install Docker.
The Node.js app and Postgres run on the first VPS as docker-compose.
The Inngest workers should run on a small managed Kubernetes cluster (Helm chart).
Backups go to a Hetzner Object Storage bucket.`}
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Be specific about clouds, sizes, domains, whether you already have servers, and what each layer should do.
        </p>
      </div>
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button onClick={onNext} disabled={!brief.trim() || planning} className="gap-1.5">
          {planning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Brain className="h-3.5 w-3.5" />}
          Generate plan
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Step 2 — Plan review/edit
// ============================================================================

function PlanStep({
  plan, onPlanChange, generating, error, onBack, onReplan, replanning, onGenerate,
}: {
  plan: Plan;
  onPlanChange: (p: Plan) => void;
  generating: boolean;
  error: string | null;
  onBack: () => void;
  onReplan: () => void;
  replanning: boolean;
  onGenerate: () => void;
}) {
  function updateLayer(idx: number, patch: Partial<PlanLayer>) {
    const next = { ...plan, layers: plan.layers.map((l, i) => i === idx ? { ...l, ...patch } : l) };
    onPlanChange(next);
  }
  function removeLayer(idx: number) {
    const removedId = plan.layers[idx].id;
    const next: Plan = {
      ...plan,
      layers: plan.layers.filter((_, i) => i !== idx),
      execution_order: (plan.execution_order ?? []).filter((id) => id !== removedId),
    };
    onPlanChange(next);
  }
  function addLayer() {
    const id = `layer-${plan.layers.length + 1}`;
    const next: Plan = {
      ...plan,
      layers: [...plan.layers, {
        id, label: "New layer", tool: "script", purpose: "Describe what this layer does",
        inputs: [], outputs: [], depends_on: [], risk_level: "medium", notes: "",
      }],
      execution_order: [...(plan.execution_order ?? []), id],
    };
    onPlanChange(next);
  }

  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="space-y-3 overflow-y-auto pr-1">
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Summary</div>
          <p className="text-xs leading-relaxed">{plan.summary}</p>
        </div>

        {plan.assumptions && plan.assumptions.length > 0 && (
          <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3">
            <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-blue-500">
              <AlertTriangle className="h-3 w-3" /> Assumptions
            </div>
            <ul className="space-y-0.5 text-xs">
              {plan.assumptions.map((a, i) => <li key={i}>• {a}</li>)}
            </ul>
          </div>
        )}

        {plan.open_questions && plan.open_questions.length > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-amber-500">
              <AlertTriangle className="h-3 w-3" /> Open questions
            </div>
            <ul className="space-y-0.5 text-xs">
              {plan.open_questions.map((q, i) => <li key={i}>• {q}</li>)}
            </ul>
            <p className="mt-2 text-[10px] text-muted-foreground">
              Answer these in the brief and click "Re-plan", or accept the assumptions above.
            </p>
          </div>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label>Layers ({plan.layers.length})</Label>
            <Button size="sm" variant="ghost" onClick={addLayer}>
              <Plus className="mr-1 h-3 w-3" /> Add layer
            </Button>
          </div>
          <div className="space-y-2">
            {plan.layers.map((layer, idx) => (
              <LayerCard
                key={layer.id}
                layer={layer}
                onChange={(patch) => updateLayer(idx, patch)}
                onRemove={() => removeLayer(idx)}
                otherIds={plan.layers.filter((_, i) => i !== idx).map((l) => l.id)}
              />
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
        <Button variant="ghost" onClick={onBack} className="gap-1">
          <ArrowLeft className="h-3 w-3" /> Edit brief
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onReplan} disabled={replanning} className="gap-1.5">
            {replanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <Brain className="h-3 w-3" />}
            Re-plan
          </Button>
          <Button onClick={onGenerate} disabled={generating || plan.layers.length === 0} className="gap-1.5">
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Generate {plan.layers.length} layer{plan.layers.length > 1 ? "s" : ""}
          </Button>
        </div>
      </div>
    </div>
  );
}

function LayerCard({
  layer, onChange, onRemove, otherIds,
}: {
  layer: PlanLayer;
  onChange: (patch: Partial<PlanLayer>) => void;
  onRemove: () => void;
  otherIds: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const tool = TOOLS.find((t) => t.value === layer.tool);

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex items-start gap-2 p-3">
        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase", tool?.color)}>
          {tool?.label ?? layer.tool}
        </span>
        <div className="min-w-0 flex-1">
          <Input
            value={layer.label}
            onChange={(e) => onChange({ label: e.target.value })}
            className="h-7 border-0 px-1 text-sm font-medium focus-visible:ring-1"
          />
          <Input
            value={layer.purpose}
            onChange={(e) => onChange({ purpose: e.target.value })}
            placeholder="Purpose (one line)"
            className="h-6 border-0 px-1 text-[11px] text-muted-foreground focus-visible:ring-1"
          />
        </div>
        <div className="flex items-center gap-1">
          <Badge variant="outline" className={cn(
            "text-[9px] uppercase",
            layer.risk_level === "high" && "text-destructive",
            layer.risk_level === "medium" && "text-amber-500",
            layer.risk_level === "low" && "text-emerald-500",
          )}>
            {layer.risk_level ?? "medium"}
          </Badge>
          <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
            {expanded ? <Check className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </Button>
          <Button size="sm" variant="ghost" onClick={onRemove}>
            <Trash2 className="h-3 w-3 text-destructive" />
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="space-y-2 border-t border-border bg-muted/20 p-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Tool</Label>
              <select
                value={layer.tool}
                onChange={(e) => onChange({ tool: e.target.value as PlanLayer["tool"] })}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {TOOLS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <Label>Risk level</Label>
              <select
                value={layer.risk_level ?? "medium"}
                onChange={(e) => onChange({ risk_level: e.target.value as PlanLayer["risk_level"] })}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </div>
          </div>
          <div>
            <Label>Depends on</Label>
            {otherIds.length === 0 ? (
              <p className="text-[10px] text-muted-foreground">No other layers to depend on.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {otherIds.map((id) => {
                  const checked = (layer.depends_on ?? []).includes(id);
                  return (
                    <button
                      key={id}
                      onClick={() => {
                        const set = new Set(layer.depends_on ?? []);
                        if (checked) set.delete(id); else set.add(id);
                        onChange({ depends_on: Array.from(set) });
                      }}
                      className={cn(
                        "rounded border px-2 py-0.5 text-[10px]",
                        checked ? "border-foreground bg-foreground/10" : "border-border text-muted-foreground",
                      )}
                    >
                      {id}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div>
            <Label>Notes</Label>
            <textarea
              value={layer.notes ?? ""}
              onChange={(e) => onChange({ notes: e.target.value })}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Step 3 — Generating
// ============================================================================

function GeneratingStep({ brief: _brief, layerCount }: { brief: string; layerCount: number }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      <p className="text-sm">Generating {layerCount} layer{layerCount > 1 ? "s" : ""}…</p>
      <p className="max-w-md text-[11px] text-muted-foreground">
        Each layer is generated by a focused LLM call. This may take a few seconds per layer.
        You'll land on the infra page when it's done.
      </p>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="mb-1 block text-xs font-medium text-muted-foreground">{children}</label>;
}
