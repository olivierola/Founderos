import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PlusIcon as Plus,
  CircleNotchIcon as Loader2,
  TrashIcon as Trash2,
  FlowArrowIcon as WorkflowIcon,
  ClockIcon as Clock,
  ArrowRightIcon as ArrowRight,
  PlugIcon as Plug,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Automation10, type AppItem } from "@/components/ui/automation10";
import { cn } from "@/lib/utils";
import { BLOCK_BY_KIND, blockColorClass } from "./blocks";
import { connectorActionProvider } from "@/features/internal-agents/connectorActionProviders";
import {
  fetchWorkflows, createWorkflow, deleteWorkflow,
  WORKFLOW_STATUS_META, WORKFLOW_KIND_META, describeCron,
  type Workflow, type BlockKind, type WorkflowKind,
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
            Une <strong className="font-medium text-foreground">procédure</strong> est lue et exécutée
            par un agent. Une <strong className="font-medium text-foreground">automatisation</strong> est
            enchaînée telle quelle par le moteur, sans modèle.
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
            Une procédure pour ce qui demande du jugement, une automatisation pour ce qui n'en
            demande pas.
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
  const kindMeta = WORKFLOW_KIND_META[workflow.kind];
  const steps = workflow.blocks.nodes.filter((n) => n.type !== "trigger");
  // Which kinds of block it is made of — the shape of the procedure at a
  // glance, without opening it. Rendered as a chain, because a workflow IS a
  // sequence: the arrows between the tiles carry real information here.
  const kinds = [...new Set(steps.map((n) => n.type as BlockKind))].slice(0, 5);
  const trigger = workflow.blocks.nodes.find((n) => n.type === "trigger");
  const mode = String((trigger?.data as Record<string, unknown> | undefined)?.mode ?? "manual");
  const triggerLabel =
    mode === "schedule" ? `planifié · ${describeCron(String((trigger?.data as Record<string, unknown>)?.schedule ?? "")).replace(" (UTC)", "")}`
    : mode === "event" ? "sur événement"
    : mode === "webhook" ? "webhook"
    : "lancement manuel";

  /**
   * La chaîne d'icônes, et elle ne dit pas la même chose selon la nature.
   *
   * Une AUTOMATISATION touche des applications nommées : montrer Stripe → Slack
   * dit en un coup d'œil ce qu'elle fait. Montrer « outil → outil → outil » ne
   * dirait rien du tout.
   *
   * Une PROCÉDURE ne touche rien de précis — c'est un agent qui décidera. Ce
   * qu'on peut montrer, c'est sa FORME : une décision, une boucle, une
   * validation humaine. C'est ce qui la distingue d'une autre sans l'ouvrir.
   */
  const providers = [...new Set(
    steps
      .filter((n) => n.type === "tool")
      .map((n) => String((n.data as Record<string, unknown> | undefined)?.provider ?? "").trim())
      .filter(Boolean),
  )].slice(0, 5);

  const chain: AppItem[] = workflow.kind === "automation" && providers.length > 0
    ? providers.map((slug) => {
        const p = connectorActionProvider(slug);
        const Icon = p?.icon ?? Plug;
        return {
          title: p?.name ?? slug,
          node: (
            <span
              title={p?.name ?? slug}
              className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground"
            >
              <Icon className="size-3.5" />
            </span>
          ),
        };
      })
    : kinds.flatMap((k) => {
        const def = BLOCK_BY_KIND.get(k);
        if (!def) return [];
        const Icon = def.icon;
        return [{
          title: def.label,
          node: (
            <span
              title={def.label}
              className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg border", blockColorClass(def.color))}
            >
              <Icon className="size-3.5" />
            </span>
          ),
        }];
      });

  return (
    <Automation10
      fill
      apps={chain}
      name={workflow.name}
      description={workflow.description ?? undefined}
      badge={
        <span className="flex shrink-0 items-center gap-1">
          {/* La nature AVANT l état : savoir si une ligne est exécutée par un
              agent ou par le moteur change la lecture de tout le reste. */}
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", kindMeta.tone)}>
            {kindMeta.label}
          </span>
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", meta.tone)}>
            {meta.label}
          </span>
        </span>
      }
      footerLeft={
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <Clock className="size-3 shrink-0" />
          <span className="truncate">{triggerLabel}</span>
          <span className="shrink-0 font-mono tabular-nums">
            · {steps.length === 0 ? "vide" : `${steps.length} bloc${steps.length > 1 ? "s" : ""}`}
          </span>
        </span>
      }
      ctaLabel="Ouvrir"
      ctaIcon={ArrowRight}
      onCtaClick={onOpen}
      onCardClick={onOpen}
      cardLabel={`Ouvrir le workflow ${workflow.name}`}
      actions={
        <button
          type="button" onClick={onRemove} title="Supprimer"
          className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/card:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      }
    />
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
  const [kind, setKind] = useState<WorkflowKind>("procedure");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim() || busy) return;
    if (!workspaceId || !projectId) { setError("Espace de travail introuvable."); return; }
    setBusy(true); setError(null);
    try {
      const id = await createWorkflow({ workspaceId, projectId, dashboardId, name, description, kind });
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
          {/* Le choix se fait ICI et pas après : les deux natures n exécutent pas
              la même chose et n offrent pas les mêmes blocs. Le demander une fois
              le contenu écrit obligerait à le retraduire. */}
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(WORKFLOW_KIND_META) as WorkflowKind[]).map((k) => {
              const meta = WORKFLOW_KIND_META[k];
              return (
                <button
                  key={k} type="button" onClick={() => setKind(k)}
                  className={cn(
                    "rounded-xl border p-3 text-left transition-colors",
                    kind === k ? "border-primary bg-primary/5" : "border-border hover:border-primary/40",
                  )}
                >
                  <span className="block text-[13px] font-medium">{meta.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{meta.long}</span>
                </button>
              );
            })}
          </div>
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
