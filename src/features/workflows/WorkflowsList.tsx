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
import { PAGE_PAD, PAGE_SUB, PAGE_TITLE } from "@/components/PageHeader";
import { BLOCK_BY_KIND, blockColorClass } from "./blocks";
import { connectorActionProvider } from "@/features/internal-agents/connectorActionProviders";
import {
  fetchWorkflows, createWorkflow, deleteWorkflow,
  WORKFLOW_STATUS_META, WORKFLOW_KIND_META, describeCron,
  type Workflow, type BlockKind, type WorkflowKind,
} from "./model";
import { useConfirm } from "@/components/ConfirmProvider";
import { TRIGGER_MODES, triggerModeLabel } from "./TriggerSettings";
import { HandTapIcon as Hand } from "@phosphor-icons/react";
import { formatRelative } from "@/features/tracker/pickers";

export function WorkflowsList({ dashboardId, workspaceId, projectId, onOpen }: {
  dashboardId: string;
  workspaceId: string | null;
  projectId: string | null;
  onOpen: (id: string) => void;
}) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);

  const { data: workflows, isLoading } = useQuery({
    queryKey: ["workflows", dashboardId],
    queryFn: () => fetchWorkflows(dashboardId),
  });

  async function remove(w: Workflow) {
    if (!(await confirm(`Supprimer le workflow « ${w.name} » ? Cette action est définitive.`))) return;
    await deleteWorkflow(w.id);
    qc.invalidateQueries({ queryKey: ["workflows", dashboardId] });
  }

  return (
    <div className={PAGE_PAD}>
      <header className="mb-6 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className={PAGE_TITLE}>Workflows</h1>
          <p className={PAGE_SUB}>
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
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr))]">
          {(workflows ?? []).map((w) => (
            <WorkflowCard key={w.id} workflow={w} onOpen={() => onOpen(w.id)} onRemove={() => void remove(w)} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Une carte de workflow : ce qu'il s'appelle, à quoi il sert, comment il se
 * lance — et de quoi l'ouvrir.
 *
 * Elle portait aussi une chaîne d'icônes (la forme du workflow) et deux
 * badges (nature, état). Sur une carte étroite, la chaîne passait SOUS les
 * badges et l'on ne lisait plus ni l'une ni les autres. La forme se voit dès
 * qu'on ouvre le workflow ; la carte, elle, doit se lire d'un coup d'œil.
 */
// Des fonds plus profonds pour les cartes : pleins et sombres en mode sombre,
// plutôt qu'un voile clair posé sur le gris.
const KIND_DEEP: Record<string, string> = {
  procedure: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  automation: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
};
const STATUS_DEEP: Record<string, string> = {
  draft: "bg-muted text-muted-foreground dark:bg-neutral-800",
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  paused: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  archived: "bg-muted text-muted-foreground dark:bg-neutral-800",
};
const BLOCK_DEEP: Record<string, string> = {
  emerald: "dark:border-emerald-900 dark:bg-emerald-950", indigo: "dark:border-indigo-900 dark:bg-indigo-950",
  rose: "dark:border-rose-900 dark:bg-rose-950", sky: "dark:border-sky-900 dark:bg-sky-950",
  amber: "dark:border-amber-900 dark:bg-amber-950", purple: "dark:border-purple-900 dark:bg-purple-950",
  cyan: "dark:border-cyan-900 dark:bg-cyan-950", teal: "dark:border-teal-900 dark:bg-teal-950",
  orange: "dark:border-orange-900 dark:bg-orange-950", slate: "dark:border-slate-800 dark:bg-slate-900",
  violet: "dark:border-violet-900 dark:bg-violet-950", lime: "dark:border-lime-900 dark:bg-lime-950",
  fuchsia: "dark:border-fuchsia-900 dark:bg-fuchsia-950", blue: "dark:border-blue-900 dark:bg-blue-950",
};

function WorkflowCard({ workflow, onOpen, onRemove }: {
  workflow: Workflow; onOpen: () => void; onRemove: () => void;
}) {
  const nodes = workflow.blocks?.nodes ?? [];
  const trigger = nodes.find((n) => n.type === "trigger");
  const data = (trigger?.data ?? {}) as Record<string, unknown>;
  const mode = String(data.mode ?? "manual");
  const modeMeta = TRIGGER_MODES.find((m) => m.id === mode);
  const TriggerIcon = modeMeta?.icon ?? Hand;
  const cadence = mode === "schedule"
    ? describeCron(String(data.schedule ?? "")).replace(" (UTC)", "")
    : null;
  const steps = nodes.filter((n) => n.type !== "trigger");
  const kind = WORKFLOW_KIND_META[workflow.kind];
  const status = WORKFLOW_STATUS_META[workflow.status];
  // La forme du workflow, en une rangée de pastilles : les six premiers blocs
  // dans l'ordre du canevas (de haut en bas), puis le reste en nombre.
  const chain = [...steps]
    .sort((x, y) => (x.position?.y ?? 0) - (y.position?.y ?? 0) || (x.position?.x ?? 0) - (y.position?.x ?? 0))
    .slice(0, 6);

  return (
    <div
      role="button" tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      aria-label={`Ouvrir le workflow ${workflow.name}`}
      className={cn(
        "group/card flex cursor-pointer flex-col rounded-2xl border border-border/70 bg-card p-4 outline-none transition-colors",
        "hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-primary/25",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground dark:bg-neutral-800">
          <WorkflowIcon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14.5px] font-semibold tracking-tight">{workflow.name}</h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {kind && <span className={cn("rounded-md px-1.5 py-px text-[11px] font-medium", KIND_DEEP[workflow.kind] ?? kind.tone)}>{kind.label}</span>}
            {status && <span className={cn("rounded-md px-1.5 py-px text-[11px] font-medium", STATUS_DEEP[workflow.status] ?? status.tone)}>{status.label}</span>}
          </div>
        </div>
        <button
          type="button" title="Supprimer" aria-label={`Supprimer ${workflow.name}`}
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="-mr-1 -mt-1 shrink-0 rounded-lg p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover/card:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>

      <p className={cn(
        "mt-3 line-clamp-2 min-h-[2.6em] text-[13px] leading-relaxed",
        workflow.description ? "text-muted-foreground" : "text-muted-foreground/60",
      )}>
        {workflow.description || (kind ? kind.short : "Sans description")}
      </p>

      <div className="mt-3 flex items-center gap-1">
        {chain.length === 0 ? (
          <span className="text-[12px] text-muted-foreground/70">Aucune étape pour l'instant</span>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {chain.map((n, i) => {
              const def = BLOCK_BY_KIND.get(n.type as BlockKind);
              const Icon = def?.icon;
              return (
                <span key={n.id} className="flex shrink-0 items-center gap-1">
                  {i > 0 && <span className="h-px w-2 bg-border" />}
                  <span title={def?.label ?? n.type} className={cn("grid h-6 w-6 place-items-center rounded-md border", blockColorClass(def?.color ?? "slate"), BLOCK_DEEP[def?.color ?? "slate"])}>
                    {Icon && <Icon className="h-3 w-3" />}
                  </span>
                </span>
              );
            })}
            {steps.length > chain.length && <span className="ml-1 shrink-0 text-[11.5px] text-muted-foreground">+{steps.length - chain.length}</span>}
            </div>
            <span className="ml-2 shrink-0 whitespace-nowrap text-[11.5px] tabular-nums text-muted-foreground">{steps.length} étape{steps.length > 1 ? "s" : ""}</span>
          </>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-border/60 pt-3 text-[12px] text-muted-foreground">
        <span className="inline-flex min-w-0 shrink items-center gap-1.5 whitespace-nowrap">
          <TriggerIcon className="size-3.5 shrink-0" />
          <span className="font-medium text-foreground/80">{triggerModeLabel(mode)}</span>
          {cadence && <span className="truncate">· {cadence}</span>}
        </span>
        <span className="ml-auto inline-flex min-w-0 items-center gap-1 whitespace-nowrap" title={workflow.next_run_at ? `Prochaine exécution : ${new Date(workflow.next_run_at).toLocaleString("fr-FR")}` : undefined}>
          <Clock className="size-3.5 shrink-0" />
          <span className="truncate">{workflow.last_run_at ? `Exécuté ${formatRelative(workflow.last_run_at)}` : `Modifié ${formatRelative(workflow.updated_at)}`}</span>
        </span>
        <ArrowRight className="size-3.5 shrink-0 transition-transform group-hover/card:translate-x-0.5 group-hover/card:text-foreground" />
      </div>
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
