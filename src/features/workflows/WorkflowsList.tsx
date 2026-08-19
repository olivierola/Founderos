import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, Trash2, Workflow as WorkflowIcon, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { BLOCK_BY_KIND, blockColorClass } from "./nodes";
import {
  fetchWorkflows, createWorkflow, deleteWorkflow,
  WORKFLOW_STATUS_META, type Workflow, type BlockKind,
} from "./model";

export function WorkflowsList({ dashboardId, workspaceId, projectId, onOpen }: {
  dashboardId: string;
  workspaceId: string | null;
  projectId: string | null;
  onOpen: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  const { data: workflows, isLoading } = useQuery({
    queryKey: ["workflows", dashboardId],
    queryFn: () => fetchWorkflows(dashboardId),
  });

  async function remove(w: Workflow) {
    if (!confirm(`Supprimer le workflow « ${w.name} » ? Cette action est définitive.`)) return;
    await deleteWorkflow(w.id);
    qc.invalidateQueries({ queryKey: ["workflows", dashboardId] });
  }

  return (
    <div className="mx-auto w-full max-w-[1100px] px-10 py-8">
      <header className="mb-6 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">Workflows</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Un workflow est un <strong className="font-medium text-foreground">mode opératoire</strong> :
            vous l'assemblez par blocs sur un canvas, il se compile en document, et au déclenchement
            l'assistant du service le lit et décide qui fait quoi.
          </p>
        </div>
        <Button onClick={() => setCreating(true)} className="shrink-0">
          <Plus className="mr-1.5 h-4 w-4" /> Nouveau workflow
        </Button>
      </header>

      <NewWorkflowDialog
        open={creating} onOpenChange={setCreating}
        dashboardId={dashboardId} workspaceId={workspaceId} projectId={projectId}
        onCreated={(id) => { qc.invalidateQueries({ queryKey: ["workflows", dashboardId] }); onOpen(id); }}
      />

      {isLoading ? (
        <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (workflows ?? []).length === 0 ? (
        <div className="mx-auto max-w-md py-20 text-center">
          <WorkflowIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium">Aucun workflow</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Écrivez une procédure une fois — objectif, règles, étapes, points de validation — et
            l'assistant la déroulera à chaque déclenchement, en déléguant aux agents qu'il faut.
          </p>
          <Button className="mt-5" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Nouveau workflow
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {(workflows ?? []).map((w) => (
            <WorkflowCard key={w.id} workflow={w} onOpen={() => onOpen(w.id)} onRemove={() => void remove(w)} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowCard({ workflow, onOpen, onRemove }: {
  workflow: Workflow; onOpen: () => void; onRemove: () => void;
}) {
  const meta = WORKFLOW_STATUS_META[workflow.status];
  const steps = workflow.blocks.nodes.filter((n) => n.type !== "trigger");
  // Which kinds of block it is made of — the shape of the procedure at a
  // glance, without opening it.
  const kinds = [...new Set(steps.map((n) => n.type as BlockKind))].slice(0, 6);
  const trigger = workflow.blocks.nodes.find((n) => n.type === "trigger");
  const mode = String((trigger?.data as Record<string, unknown> | undefined)?.mode ?? "manual");

  return (
    <div className="group relative rounded-xl border border-border/60 bg-card p-4 transition-colors hover:border-primary/50">
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{workflow.name}</span>
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium", meta.tone)}>{meta.label}</span>
        </div>
        {workflow.description && (
          <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{workflow.description}</p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {kinds.map((k) => {
            const def = BLOCK_BY_KIND.get(k);
            if (!def) return null;
            return (
              <span key={k} title={def.label} className={cn("flex h-6 w-6 items-center justify-center rounded-md border", blockColorClass(def.color))}>
                <def.icon className="h-3.5 w-3.5" />
              </span>
            );
          })}
          {steps.length === 0 && <span className="text-[11px] text-muted-foreground">procédure vide</span>}
        </div>

        <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3" />
          {mode === "schedule" ? `planifié · ${String((trigger?.data as Record<string, unknown>)?.schedule ?? "—")}`
            : mode === "event" ? "sur événement"
            : mode === "webhook" ? "webhook"
            : "lancement manuel"}
          <span className="ml-auto">{steps.length} bloc{steps.length > 1 ? "s" : ""}</span>
        </div>
      </button>

      <button
        type="button" onClick={onRemove} title="Supprimer"
        className="absolute right-2 top-2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function NewWorkflowDialog({ open, onOpenChange, dashboardId, workspaceId, projectId, onCreated }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  dashboardId: string;
  workspaceId: string | null;
  projectId: string | null;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim() || busy) return;
    if (!workspaceId || !projectId) { setError("Espace de travail introuvable."); return; }
    setBusy(true); setError(null);
    try {
      const id = await createWorkflow({ workspaceId, projectId, dashboardId, name, description });
      if (!id) throw new Error("Le workflow n'a pas pu être créé.");
      setName(""); setDescription("");
      onOpenChange(false);
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur inconnue");
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Nouveau workflow</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Nom</label>
            <Input
              value={name} autoFocus onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
              placeholder="Revue hebdomadaire des retours clients"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Description</label>
            <textarea
              value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
              placeholder="À quoi sert ce workflow, et quand doit-il se déclencher."
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Le canvas s'ouvre avec son déclencheur déjà posé — il ne reste qu'à enchaîner les étapes.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Annuler</Button>
            <Button onClick={() => void submit()} disabled={!name.trim() || busy}>
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Créer
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
