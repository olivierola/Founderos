import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Node, Edge } from "reactflow";
import {
  ArrowLeftIcon as ArrowLeft,
  CircleNotchIcon as Loader2,
  CheckIcon as Check,
  PlusIcon as Plus,
  TrashIcon as Trash2,
  PlayIcon as Play,
  SquareIcon as Square,
  FileTextIcon as FileText,
  CaretDownIcon as ChevronDown,
  CaretUpIcon as ChevronUp,
  DotsThreeIcon as MoreHorizontal,
  SlidersHorizontalIcon as Settings2,
  ArrowElbowDownRightIcon as CornerDownRight,
  GitBranchIcon as GitBranch,
  RepeatIcon as Repeat,
  ArrowUpRightIcon as ArrowUpRight,
  XIcon as X,
  WrenchIcon as Wrench,
  CodeIcon as Code2,
  ArrowLineRightIcon as ArrowRightToLine,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  BLOCK_BY_KIND, blockColorClass, blockSummary, isBlockEmpty,
  KNOWN_TOOLS, DELIVERABLE_FORMATS,
} from "./blocks";
import { roleOf } from "./graph";
import { Picker } from "./inspector-ui";
import { BlockForm } from "./BlockForm";
import { EventTriggers } from "./EventTriggers";
import { RichLine, chipToken, type ChipInfo, type SlashOption } from "./RichLine";
import {
  buildOutline, attachedTo, insertBlock, insertAttached, removeBlock, moveBlock,
  attachQualifier, detachQualifier, patchBlock, convertBlock, setLegTarget,
  type Graph, type OutlineItem, type OutlineLeg,
} from "./outline";
import { compileWorkflow, parseWorkflow } from "./compile";
import {
  fetchWorkflow, saveWorkflowContent, updateWorkflow, startRun, cancelRun,
  fetchLatestRun, fetchRunSteps, syncSchedule,
  WORKFLOW_STATUS_META, WORKFLOW_KIND_META, chipIdsIn, contextSourceOf,
  codeToolOf, outputVarOf,
  nextCronRun, buildCron, parseCron, describeCron, parseNaturalCron,
  DEFAULT_CRON_SPEC, CRON_FREQUENCIES, CRON_WEEKDAYS, type CronSpec,
  type BlockKind, type ContextRef, type RunStep, type WorkflowRun, type WorkflowStatus, type WorkflowKind,
} from "./model";

// L'éditeur de procédure : un document qu'on écrit, pas un schéma qu'on câble.
//
// Une ligne par action, numérotée. Les branches sont indentées sous la question
// qui les ouvre. Les blocs se posent DANS les phrases — « demande la commande
// [Utilise get_order_info] puis confirme » — parce qu'un contexte ou un outil
// tire son sens de l'endroit où il intervient, et qu'une carte posée à côté
// d'une étape ne dit jamais où elle s'applique.
//
// Le graphe reste le modèle (voir outline.ts) : le compilateur partagé le lit
// sans rien savoir de cet écran, et l'assistant continue d'écrire dedans.

/** L'expression cron effectivement portée par le graphe — la même lecture que
 *  `scheduleOf` côté moteur, pour comparer ce qui est armé à ce qui est écrit. */
function cronOf(g: Graph): string | null {
  const t = g.nodes.find((n) => n.type === "trigger" && (n.data as Record<string, unknown> | undefined)?.mode === "schedule");
  return String((t?.data as Record<string, unknown> | undefined)?.schedule ?? "").trim() || null;
}

const STRIP = ["__empty", "__agentName", "__attached", "__appliesTo"] as const;
function cleanGraph(g: Graph): Graph {
  return {
    nodes: g.nodes.map((n) => {
      const data = { ...(n.data ?? {}) } as Record<string, unknown>;
      for (const k of STRIP) delete data[k];
      return { id: n.id, type: n.type, position: n.position ?? { x: 0, y: 0 }, data } as Node;
    }),
    edges: g.edges.map((e) => ({
      id: e.id, source: e.source, target: e.target,
      sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle ?? null,
    } as Edge)),
  };
}

/** Des blocs d'un vocabulaire disparu traînent dans de vieux graphes. Ils ne
 *  s'ouvrent nulle part et ne compilent rien : les garder afficherait une ligne
 *  que personne ne peut lire ni réparer. */
function dropUnknown(g: Graph): { graph: Graph; removed: number } {
  const kept = g.nodes.filter((n) => BLOCK_BY_KIND.has((n.type ?? "") as BlockKind));
  if (kept.length === g.nodes.length) return { graph: g, removed: 0 };
  const ids = new Set(kept.map((n) => n.id));
  return {
    graph: { nodes: kept, edges: g.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) },
    removed: g.nodes.length - kept.length,
  };
}

// ── Vocabulaire d'affichage ──────────────────────────────────────────────────

/** La teinte d'un bloc pour un `style` inline — les classes Tailwind du
 *  catalogue n'y servent à rien. */
const HUE: Record<string, string> = {
  emerald: "#34d399", indigo: "#818cf8", rose: "#fb7185", sky: "#38bdf8",
  amber: "#fbbf24", purple: "#c084fc", cyan: "#22d3ee", teal: "#2dd4bf",
  orange: "#fb923c", slate: "#94a3b8", violet: "#a78bfa", lime: "#a3e635",
  fuchsia: "#e879f9", blue: "#60a5fa",
};
const hueOf = (kind: string | undefined) => HUE[BLOCK_BY_KIND.get((kind ?? "step") as BlockKind)?.color ?? "slate"] ?? HUE.slate;

/** Le nom court d'un bloc dans une pastille. Un bloc sans titre affiche ce
 *  qu'il CONTIENT : une pastille « sans titre » au milieu d'une phrase ne dit
 *  rien de ce qu'elle fait là. */
function chipLabelOf(n: Node): string {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const label = String(d.label ?? "").trim();
  if (label) return label;
  if (n.type === "tool") {
    const provider = String(d.provider ?? "").trim();
    const action = String(d.action ?? "").trim();
    if (provider && action) return `${provider} → ${action}`;
    const tool = String(d.tool ?? "").trim();
    // Le nom lisible plutôt que le slug : une pastille au milieu d'une phrase
    // doit se lire, et `deep_research` n'est pas du français.
    return KNOWN_TOOLS.find((t) => t.value === tool)?.label ?? tool ?? "à choisir";
  }
  if (n.type === "context") {
    const cols = (Array.isArray(d.refs) ? (d.refs as ContextRef[]) : []).filter((r) => r.kind === "collection");
    if (cols.length) return cols.map((r) => r.label).join(" · ");
    return contextSourceOf(d) === "collections" ? "à choisir" : "à rédiger";
  }
  if (n.type === "deliverable") {
    const fmt = String(d.format ?? "report");
    return DELIVERABLE_FORMATS.find((f) => f.value === fmt)?.label ?? fmt;
  }
  return BLOCK_BY_KIND.get((n.type ?? "step") as BlockKind)?.label ?? "Bloc";
}

const chipInfoOf = (n: Node): ChipInfo => ({
  id: n.id,
  verb: BLOCK_BY_KIND.get((n.type ?? "context") as BlockKind)?.attachLabel ?? "Cadrage",
  label: chipLabelOf(n),
  color: hueOf(n.type),
});

/** Ce qu'on écrit dans la procédure. Volontairement court : « ressource » et
 *  « exemple » existent toujours dans le langage — d'anciennes procédures en
 *  contiennent et compilent — mais ils ne sont plus proposés. Une ressource se
 *  dit dans un contexte, un exemple dans l'objectif, et un menu de quinze
 *  entrées oblige à connaître le vocabulaire avant d'écrire la première ligne. */
const PROCEDURE_KINDS: BlockKind[] = ["step", "decision", "loop", "approval", "handoff", "section"];

/**
 * Ce qu'une AUTOMATISATION sait enchaîner. Court, et c'est la définition même :
 * une action appelle une API, une condition compare deux valeurs, une passation
 * sort vers un agent quand il faut vraiment juger. Une « étape » — une consigne
 * rédigée — n'a de sens que pour quelqu'un qui la lit ; la proposer ici
 * produirait un bloc que le moteur sauterait en silence.
 */
const AUTOMATION_KINDS: BlockKind[] = ["tool", "decision", "handoff"];

const kindsFor = (kind: WorkflowKind): BlockKind[] =>
  (kind === "automation" ? AUTOMATION_KINDS : PROCEDURE_KINDS);

/**
 * Ce qu'une ligne vide raconte d'elle-même.
 *
 * Une ligne neuve était muette : rien ne disait que `/` ouvre un menu, ni qu'on
 * peut y poser un outil ou un agent. Ces gestes ne se devinent pas. L'invite
 * défile parce qu'il y a plusieurs choses à dire et une seule place — la place
 * déjà vide — et parce qu'une note d'aide posée à côté encombrerait le document
 * pour toujours afin d'être lue une fois.
 *
 * La PREMIÈRE phrase dit toujours à quoi sert le bloc : c'est celle que voit
 * quelqu'un qui écrit vite et ne s'arrête pas.
 */
function hintsFor(kind: BlockKind): string[] {
  const slash = "Tapez / pour un outil, une connaissance, un agent…";
  const keys = "⏎ pour valider · ⇧⏎ pour un retour à la ligne";
  switch (kind) {
    case "step":
      return ["Ce que l'agent doit faire ici…", slash, keys];
    case "approval":
      return ["Ce qu'on demande à l'humain avant de continuer…", "Le run s'arrête ici et attend la réponse.", keys];
    case "handoff":
      return ["Le brief remis au destinataire…", "Choisissez le ou les agents juste en dessous.", slash];
    default:
      return [BLOCK_BY_KIND.get(kind)!.hint, slash];
  }
}

/** Ce qu'on pose DANS une phrase, ou qui cadre toute la procédure. */
const FRAME_KINDS: BlockKind[] = ["goal", "input"];
const QUALIFIER_KINDS: BlockKind[] = ["tool", "context", "rule", "deliverable", "memory"];

// ── L'écran ──────────────────────────────────────────────────────────────────

export function WorkflowDocument({ workflowId, onBack }: { workflowId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [openBlock, setOpenBlock] = useState<string | null>(null);
  const [docOpen, setDocOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [externalChange, setExternalChange] = useState(false);
  const dirty = useRef(false);
  const loaded = useRef(false);
  const hydratedAt = useRef<string | null>(null);
  /** Ce qui est armé côté serveur, pour ne resynchroniser que sur changement. */
  const syncedCron = useRef<string | null>(null);

  const { data: workflow, isLoading } = useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: () => fetchWorkflow(workflowId),
    // L'assistant écrit dans la MÊME ligne : un éditeur qui ne lit qu'au montage
    // reste vide pendant qu'on le remplit à côté.
    refetchInterval: 4000,
  });

  const { data: agents } = useQuery({
    queryKey: ["wf_agents", workflow?.service_dashboard_id],
    enabled: !!workflow?.service_dashboard_id,
    queryFn: async () => {
      const { data } = await supabase.from("internal_agents")
        .select("id, name")
        .eq("service_dashboard_id", workflow!.service_dashboard_id!)
        .eq("is_archived", false).eq("is_orchestrator", false);
      return (data ?? []) as Array<{ id: string; name: string }>;
    },
  });
  const agentName = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a.name])), [agents]);

  const { data: collections } = useQuery({
    queryKey: ["wf_collections", workflow?.project_id],
    enabled: !!workflow?.project_id,
    queryFn: async () => {
      const { data } = await supabase.from("rag_collections")
        .select("id, name").eq("project_id", workflow!.project_id).order("name");
      return (data ?? []) as Array<{ id: string; name: string }>;
    },
  });

  const { data: run } = useQuery({
    queryKey: ["workflow_run", workflowId],
    queryFn: () => fetchLatestRun(workflowId),
    refetchInterval: (q) => ((q.state.data as WorkflowRun | null | undefined)?.status === "running" ? 3000 : false),
  });

  /**
   * Adopter ce que le serveur porte — au montage, et quand la ligne bouge SOUS
   * nous sans rien de local en attente. Le `updated_at` tranche : le nôtre est
   * ignoré, celui d'un autre est adopté si rien n'est en cours ici, et seulement
   * annoncé sinon. Jamais appliqué en silence par-dessus du travail.
   */
  useEffect(() => {
    if (!workflow) return;
    if (loaded.current) {
      if (workflow.updated_at === hydratedAt.current) return;
      if (dirty.current) { setExternalChange(true); return; }
    }
    loaded.current = true;
    hydratedAt.current = workflow.updated_at;
    setExternalChange(false);

    const stored: Graph = { nodes: workflow.blocks.nodes, edges: workflow.blocks.edges };
    syncedCron.current = cronOf(stored);
    const hasBody = stored.nodes.some((n) => n.type !== "trigger");
    // Une procédure écrite par l'assistant arrive comme un DOCUMENT avec son
    // seul déclencheur en blocs. La reconstruire à la première ouverture est ce
    // qui la rend modifiable comme n'importe quelle autre.
    if (!hasBody && workflow.document.trim()) {
      setGraph(parseWorkflow(workflow.document, stored) as Graph);
      dirty.current = true;
      return;
    }
    const { graph: clean, removed } = dropUnknown(stored);
    setGraph(clean);
    if (removed) dirty.current = true;
  }, [workflow]);

  // Une écriture par pause. Le playbook compilé part avec le graphe : ce sont
  // les deux faces d'une même procédure, et n'en écrire qu'une les fait diverger.
  useEffect(() => {
    if (!loaded.current || !dirty.current || !workflow) return;
    const t = setTimeout(async () => {
      setSaving(true);
      try {
        const g = cleanGraph(graph);
        const stamp = await saveWorkflowContent(workflowId, g, compileWorkflow(workflow, g, agentName));
        hydratedAt.current = stamp;
        dirty.current = false;
        setSavedAt(Date.now());
        /**
         * Les colonnes `schedule` / `next_run_at` sont une copie de ce que dit
         * le bloc déclencheur, et c'est cette copie que le planificateur lit.
         * Enregistrer les blocs sans la refaire laissait l'ancienne heure armée :
         * on changeait 9 h en 18 h, l'écran disait 18 h, le tick partait à 9 h.
         * Seulement quand l'expression a bougé — une resynchronisation par
         * frappe serait un appel réseau pour rien.
         */
        const expr = cronOf(g);
        if (expr !== syncedCron.current) {
          syncedCron.current = expr;
          await syncSchedule(workflowId).catch(() => {});
        }
      } finally { setSaving(false); }
    }, 800);
    return () => clearTimeout(t);
  }, [graph, workflowId, workflow, agentName]);

  /**
   * Toute modification passe par une mise à jour FONCTIONNELLE.
   *
   * Poser une pastille dans une phrase crée un bloc PUIS écrit le texte qui le
   * mentionne, dans le même geste. Avec un `setGraph(objet)`, la seconde
   * écriture repartirait du graphe capturé avant la première et supprimerait le
   * bloc qu'on vient de créer.
   */
  const apply = (fn: (g: Graph) => Graph) => { dirty.current = true; setGraph(fn); };

  const outline = useMemo(
    () => buildOutline(graph.nodes, graph.edges, workflow?.kind ?? "procedure"),
    [graph, workflow?.kind],
  );
  const compiled = useMemo(
    () => (workflow ? compileWorkflow(workflow, cleanGraph(graph), agentName) : ""),
    [workflow, graph, agentName],
  );

  if (isLoading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (!workflow) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Workflow introuvable.</div>;
  }

  const ctx: Ctx = {
    graph, apply, agents: agents ?? [], collections: collections ?? [], agentName,
    workflowId, workspaceId: workflow.workspace_id, projectId: workflow.project_id,
    openBlock, setOpenBlock,
    sections: graph.nodes.filter((n) => n.type === "section"),
    kind: workflow.kind,
    vars: [...new Set(graph.nodes
      .map((n) => outputVarOf((n.data ?? {}) as Record<string, unknown>))
      .filter(Boolean))],
  };

  return (
    // Le document défile dans le conteneur de la page, pas dans une boîte à
    // lui. Un conteneur interne en `h-full` + `overflow-y-auto` dépend d une
    // hauteur résolue par le parent ; quand elle ne l est pas, la boîte grandit
    // sans jamais défiler. Un document qui coule normalement, en-tête collant,
    // n a pas ce problème — et c est de toute façon la façon dont un document
    // se comporte.
    <div className="flex min-h-full flex-col">
      <DocHeader
        workflow={workflow}
        saving={saving} savedAt={savedAt}
        run={run ?? null}
        canRun={graph.nodes.some((n) => n.type !== "trigger")}
        onBack={onBack}
        onDocument={() => setDocOpen(true)}
        onChanged={() => {
          qc.invalidateQueries({ queryKey: ["workflow", workflowId] });
          qc.invalidateQueries({ queryKey: ["workflow_run", workflowId] });
        }}
      />

      {externalChange && (
        <button
          type="button"
          onClick={() => {
            // Explicite : adopter écraserait ce qui n'est pas enregistré ici.
            dirty.current = false; loaded.current = false;
            setExternalChange(false);
            qc.invalidateQueries({ queryKey: ["workflow", workflowId] });
          }}
          className="shrink-0 border-b border-sky-500/40 bg-sky-500/10 px-4 py-1.5 text-left text-[11px] text-sky-600 dark:text-sky-400"
        >
          Modifiée ailleurs — <span className="font-medium underline">recharger</span>
        </button>
      )}

      {/* Pas de feuille flottante : le document EST la page. Une carte posée sur
          un fond gris ajoute une bordure et une ombre qui ne délimitent rien —
          on lit déjà où le texte commence. */}
      <div className="mx-auto w-full max-w-[60rem] px-10 py-10">
            <WhenToUse
              workflow={workflow} trigger={outline.trigger} ctx={ctx}
              onChanged={() => qc.invalidateQueries({ queryKey: ["workflow", workflowId] })}
            />

            {ctx.kind === "procedure" && <PropertyStrip outline={outline} ctx={ctx} />}

            <div className="mt-8 border-t border-border/60 pt-7">
              <Procedure outline={outline} ctx={ctx} />
            </div>

            {ctx.kind === "automation" && run && <RunTrace run={run} />}

            {outline.orphans.length > 0 && (
              <div className="mt-8 rounded-xl bg-amber-500/5 p-3">
                <p className="text-[12px] font-medium text-amber-600 dark:text-amber-400">
                  {outline.orphans.length} bloc{outline.orphans.length > 1 ? "s" : ""} hors de la procédure
                </p>
                <div className="mt-2 space-y-1">
                  {outline.orphans.map((n) => (
                    <div key={n.id} className="flex items-center gap-2 rounded-lg bg-background px-2.5 py-1.5">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: hueOf(n.type) }} />
                      <span className="min-w-0 flex-1 truncate text-[12px]">{chipLabelOf(n)}</span>
                      <IconButton title="Supprimer" onClick={() => apply((g) => removeBlock(g, n.id))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconButton>
                    </div>
                  ))}
                </div>
              </div>
            )}
      </div>

      <Dialog open={docOpen} onOpenChange={setDocOpen}>
        <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4" /> workflow.md
            </DialogTitle>
          </DialogHeader>
          {/* En lecture seule : maintenant que l'éditeur EST le document, deux
              représentations modifiables chacune de son côté ne feraient que
              diverger. */}
          <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-4 font-mono text-[11px] leading-relaxed">
            {compiled}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Contexte ─────────────────────────────────────────────────────────────────

interface Ctx {
  graph: Graph;
  apply: (fn: (g: Graph) => Graph) => void;
  agents: Array<{ id: string; name: string }>;
  collections: Array<{ id: string; name: string }>;
  agentName: Map<string, string>;
  workflowId: string;
  workspaceId: string | null;
  projectId: string | null;
  openBlock: string | null;
  setOpenBlock: (id: string | null) => void;
  /** Les intertitres — les seules cibles d'un « aller à ». */
  sections: Node[];
  /** Procédure ou automatisation. Décide des blocs offerts, de la façon dont une
   *  condition s'écrit, et de qui exécutera au déclenchement. */
  kind: WorkflowKind;
  /** Les variables nommées par les blocs du workflow. Calculées une fois ici :
   *  chaque endroit qui les recalculait aurait fini par en connaître un jeu
   *  différent. */
  vars: string[];
}

// ── Primitives ───────────────────────────────────────────────────────────────

function IconButton({ children, onClick, title, className }: {
  children: React.ReactNode; onClick: () => void; title: string; className?: string;
}) {
  return (
    <button
      type="button" onClick={onClick} title={title}
      className={cn("rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", className)}
    >{children}</button>
  );
}

/** La tuile carrée à coins arrondis qui ouvre une branche. Elle porte tout le
 *  poids visuel de la structure : sans elle, un SI se lit comme une ligne de
 *  texte parmi d'autres. */
function Tile({ icon: Icon, tone = "violet" }: { icon: typeof GitBranch; tone?: "violet" | "slate" }) {
  return (
    <span className={cn(
      "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
      tone === "violet" ? "bg-violet-400/15 text-violet-500" : "bg-muted text-muted-foreground",
    )}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

/**
 * Un menu ancré. Utilisé pour ajouter, convertir et gérer une ligne — trois
 * gestes, une seule mécanique.
 *
 * La fermeture passe par une écoute au niveau du document, PAS par un calque
 * `fixed inset-0` posé derrière. Ce calque attrape bien les clics, mais il
 * attrape aussi la molette : le navigateur cherche le conteneur défilable
 * au-dessus de l'élément survolé, et un calque plein écran accroché au body
 * n'en a pas. Ouvrir un menu bloquait donc le défilement de toute la page.
 */
function Menu({ open, onClose, children, align = "left" }: {
  open: boolean; onClose: () => void; children: React.ReactNode; align?: "left" | "right";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      // Le conteneur relatif porte le bouton ET le menu : un clic sur le bouton
      // compte donc comme « dedans », et c'est son propre toggle qui referme.
      // Le traiter comme un clic extérieur ferait fermer puis rouvrir, et le
      // menu ne se refermerait jamais par où on l'a ouvert.
      const scope = ref.current?.parentElement ?? ref.current;
      if (!scope?.contains(e.target as ChildNode)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // `capture` : le bouton qui a ouvert le menu arrête souvent la propagation,
    // et sans capture son second clic ne refermerait jamais rien.
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={ref}
      className={cn(
        "absolute top-full z-50 mt-1 w-72 overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-lg",
        align === "right" ? "right-0" : "left-0",
      )}
    >{children}</div>
  );
}

function MenuRow({ kind, onClick }: { kind: BlockKind; onClick: () => void }) {
  const def = BLOCK_BY_KIND.get(kind)!;
  return (
    <button
      type="button" onClick={onClick}
      className="flex w-full items-start gap-2.5 px-3 py-1.5 text-left hover:bg-muted"
    >
      <span className={cn("mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md border", blockColorClass(def.color))}>
        <def.icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium leading-tight">{def.label}</span>
        <span className="block text-[11px] leading-snug text-muted-foreground">{def.hint}</span>
      </span>
    </button>
  );
}

/** Le point d'insertion : un `+` discret qui n'apparaît qu'au survol de
 *  l'interligne. C'est la mécanique d'un éditeur de document — on ajoute un
 *  bloc là où le curseur est, pas depuis une palette qui vit ailleurs. */
function InsertPoint({ ctx, at, always }: {
  ctx: Ctx;
  at: { afterId?: string | null; legOf?: string | null; legHandle?: string | null };
  always?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const canJump = !!at.legOf && ctx.sections.length > 0;
  const lit = always || open;
  return (
    // La bande garde SA hauteur en permanence, même bouton caché. C'est elle qui
    // met de l'air entre deux lignes, et c'est ce qui évite que le document
    // sursaute au survol : révéler un bouton ne doit pas pousser la suite.
    <div className="group/insert relative flex h-9 items-center gap-3">
      <button
        type="button" onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-dashed transition-opacity",
          lit
            ? "border-primary/50 bg-primary/5 text-primary opacity-100"
            : "border-border text-muted-foreground opacity-0 hover:border-foreground/40 hover:text-foreground group-hover/insert:opacity-100 focus-visible:opacity-100",
        )}
        title="Ajouter un bloc ici"
      ><Plus className="h-4 w-4" /></button>
      {/* Le filet dit OÙ le bloc va atterrir. Sans lui, le bouton flotte entre
          deux lignes sans désigner d'interstice. */}
      <span className={cn(
        "h-px flex-1 transition-colors",
        lit ? "bg-primary/25" : "bg-transparent group-hover/insert:bg-border",
      )} />
      <Menu open={open} onClose={() => setOpen(false)}>
        {kindsFor(ctx.kind).map((k) => (
          <MenuRow key={k} kind={k} onClick={() => { ctx.apply((g) => insertBlock(g, k, at).graph); setOpen(false); }} />
        ))}
        {canJump && (
          <div className="mt-1 border-t border-border/60 pt-1">
            {ctx.sections.map((s) => (
              <button
                key={s.id} type="button"
                onClick={() => {
                  ctx.apply((g) => setLegTarget(g, at.legOf!, at.legHandle!, s.id));
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-muted"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-sky-400/15 text-sky-500">
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 text-[13px]">
                  Aller à <span className="font-medium">{chipLabelOf(s)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </Menu>
    </div>
  );
}

// ── Trace d'exécution ────────────────────────────────────────────────────────

const STEP_TONE: Record<RunStep["status"], string> = {
  running: "bg-sky-500",
  succeeded: "bg-emerald-500",
  failed: "bg-red-500",
  // Non parcouru : la branche n'a pas été prise. Gris, pas rouge — rien n'a raté.
  skipped: "bg-muted-foreground/40",
};

/** Ce que le moteur a réellement fait, étape par étape.
 *
 *  Une procédure se raconte dans le rapport de son agent. Une automatisation ne
 *  raconte rien d'elle-même : sans ce journal, un échec se résume à « failed »
 *  et rien ne dit quelle action a cassé ni avec quels arguments. C'est aussi le
 *  seul endroit où l'on voit ce qu'une variable valait vraiment. */
function RunTrace({ run }: { run: WorkflowRun }) {
  const [open, setOpen] = useState(run.status !== "succeeded");
  const { data: steps } = useQuery({
    queryKey: ["workflow_run_steps", run.id],
    queryFn: () => fetchRunSteps(run.id),
    refetchInterval: run.status === "running" ? 2000 : false,
  });

  const list = steps ?? [];
  if (!list.length && run.status === "running") {
    return <p className="mt-8 border-t border-border/60 pt-5 text-[12px] text-muted-foreground">Exécution en cours…</p>;
  }
  if (!list.length) return null;

  return (
    <div className="mt-8 border-t border-border/60 pt-5">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-[13px] font-semibold">
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        Dernière exécution
        <span className="font-normal text-muted-foreground">
          · {list.length} étape{list.length > 1 ? "s" : ""}
          {run.started_at && ` · ${new Date(run.started_at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`}
        </span>
      </button>

      {open && (
        <div className="mt-3 space-y-1.5">
          {list.map((st) => <TraceRow key={st.id} step={st} />)}
          {run.error_message && (
            <p className="rounded-lg bg-red-500/5 px-2.5 py-2 text-[11px] leading-relaxed text-red-600 dark:text-red-400">
              {run.error_message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TraceRow({ step }: { step: RunStep }) {
  const [open, setOpen] = useState(false);
  const ms = step.finished_at ? new Date(step.finished_at).getTime() - new Date(step.started_at).getTime() : null;
  // Le détail est replié : ce qu'on cherche d'abord, c'est OÙ ça a cassé.
  const detail = { entrée: step.input, sortie: step.output };
  const hasDetail = !!step.output || Object.keys(step.input ?? {}).length > 0;

  return (
    <div className="rounded-xl bg-muted/25">
      <button type="button" disabled={!hasDetail} onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STEP_TONE[step.status])} />
        <span className="w-5 shrink-0 text-[11px] tabular-nums text-muted-foreground">{step.position}</span>
        <span className="min-w-0 flex-1 truncate text-[12px]">{step.label || step.block_kind}</span>
        {ms !== null && <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}</span>}
        {hasDetail && (open ? <ChevronUp className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />)}
      </button>
      {step.error_message && (
        <p className="px-2.5 pb-2 pl-[2.6rem] text-[11px] leading-relaxed text-red-600 dark:text-red-400">{step.error_message}</p>
      )}
      {open && (
        <pre className="mx-2.5 mb-2 max-h-56 overflow-auto rounded-lg bg-background p-2.5 font-mono text-[10px] leading-relaxed">
          {JSON.stringify(detail, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ── En-tête ──────────────────────────────────────────────────────────────────

const RUN_META: Record<string, { label: string; tone: string }> = {
  running: { label: "En cours", tone: "text-sky-500" },
  succeeded: { label: "Dernier run réussi", tone: "text-emerald-500" },
  failed: { label: "Dernier run en échec", tone: "text-red-500" },
  cancelled: { label: "Dernier run annulé", tone: "text-muted-foreground" },
  // Une condition a coupé la chaîne. Ce n'est PAS un échec : l'automatisation a
  // fait exactement ce qu'on lui a demandé, à savoir ne rien faire ce coup-ci.
  stopped: { label: "Arrêté par une condition", tone: "text-amber-500" },
};

function DocHeader({ workflow, saving, savedAt, run, canRun, onBack, onDocument, onChanged }: {
  workflow: { id: string; name: string; status: WorkflowStatus; kind: WorkflowKind };
  saving: boolean; savedAt: number | null;
  run: WorkflowRun | null; canRun: boolean;
  onBack: () => void; onDocument: () => void; onChanged: () => void;
}) {
  const [name, setName] = useState(workflow.name);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const meta = WORKFLOW_STATUS_META[workflow.status];
  const kindMeta = WORKFLOW_KIND_META[workflow.kind];
  const live = run?.status === "running";
  const runMeta = run ? RUN_META[run.status] : null;

  async function commitName() {
    setEditing(false);
    if (name.trim() && name.trim() !== workflow.name) {
      await updateWorkflow(workflow.id, { name: name.trim() });
      onChanged();
    } else setName(workflow.name);
  }

  async function toggleActive() {
    setBusy(true);
    try {
      await updateWorkflow(workflow.id, { status: workflow.status === "active" ? "paused" : "active" });
      await syncSchedule(workflow.id).catch(() => {});
      onChanged();
    } finally { setBusy(false); }
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border/60 bg-background px-4">
      <IconButton title="Retour" onClick={onBack}><ArrowLeft className="h-4 w-4" /></IconButton>
      {editing ? (
        <Input
          value={name} autoFocus
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => { if (e.key === "Enter") void commitName(); if (e.key === "Escape") { setName(workflow.name); setEditing(false); } }}
          className="h-8 max-w-sm"
        />
      ) : (
        <button onClick={() => setEditing(true)} className="min-w-0 truncate text-[15px] font-semibold hover:underline" title="Renommer">
          <span className="text-muted-foreground">{kindMeta.label} : </span>{workflow.name}
        </button>
      )}
      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium", kindMeta.tone)} title={kindMeta.long}>
        {kindMeta.short}
      </span>
      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium", meta.tone)}>{meta.label}</span>

      {runMeta && (
        <span className={cn("flex shrink-0 items-center gap-1 text-[11px]", runMeta.tone)}>
          {live && <Loader2 className="h-3 w-3 animate-spin" />} {runMeta.label}
        </span>
      )}

      <span className="ml-auto flex w-24 items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
        {saving ? <><Loader2 className="h-3 w-3 animate-spin" /> Enregistre…</>
          : savedAt && Date.now() - savedAt < 3000 ? <><Check className="h-3 w-3 text-emerald-500" /> Enregistré</>
          : null}
      </span>

      {/* Le playbook n existe que pour une procédure : personne ne LIT une
          automatisation, le moteur l exécute. Montrer un document que rien ne
          reçoit ferait croire à un contrat qui n a pas lieu. */}
      {workflow.kind === "procedure" && (
        <Button size="sm" variant="ghost" onClick={onDocument} title="Voir le playbook compilé">
          <FileText className="h-3.5 w-3.5" />
        </Button>
      )}

      {live && run ? (
        <Button size="sm" variant="outline" disabled={busy}
          onClick={async () => { setBusy(true); try { await cancelRun(run.id); onChanged(); } finally { setBusy(false); } }}>
          <Square className="mr-1.5 h-3.5 w-3.5" /> Arrêter
        </Button>
      ) : (
        <Button size="sm" variant="outline" disabled={busy || !canRun}
          title={canRun ? "Exécuter maintenant" : "Écrivez au moins une étape"}
          onClick={async () => {
            setBusy(true);
            try { await startRun(workflow.id); onChanged(); }
            catch (e) { alert(e instanceof Error ? e.message : "Lancement impossible"); }
            finally { setBusy(false); }
          }}>
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />} Tester
        </Button>
      )}
      {/* Activer ne veut pas dire la même chose des deux côtés : une
          automatisation s'arme, une procédure devient consultable par les
          agents du service. Le même mot pour les deux ferait croire qu'une
          procédure « tourne ». */}
      <Button
        size="sm" variant={workflow.status === "active" ? "ghost" : "default"} disabled={busy} onClick={toggleActive}
        title={workflow.kind === "automation"
          ? "Armer les déclencheurs"
          : "Rendre cette procédure consultable par les agents du service"}
      >
        {workflow.status === "active"
          ? (workflow.kind === "automation" ? "Mettre en pause" : "Retirer aux agents")
          : (workflow.kind === "automation" ? "Activer" : "Donner aux agents")}
      </Button>
    </header>
  );
}

// ── Tête du document ─────────────────────────────────────────────────────────

function WhenToUse({ workflow, trigger, ctx, onChanged }: {
  workflow: { id: string; description: string | null };
  trigger: Node | null;
  ctx: Ctx;
  onChanged: () => void;
}) {
  const [text, setText] = useState(workflow.description ?? "");
  useEffect(() => { setText(workflow.description ?? ""); }, [workflow.description]);

  const auto = ctx.kind === "automation";
  return (
    <section>
      {/*
        Le haut du document dit la seule chose qui met la suite en route — et ce
        n'est pas la même chose selon la nature.
        · Une AUTOMATISATION est DÉCLENCHÉE : une heure, un événement, un appel.
        · Une PROCÉDURE ne l'est pas. Personne ne la lance : un agent tombe sur
          une situation, reconnaît qu'elle la décrit, et la suit. La phrase
          ci-dessous EST cette situation — c'est elle qui la fait trouver, pas
          un cron. Lui coller un déclencheur laissait croire qu'elle tournerait
          toute seule, et faisait manquer ce qui la rend utile.
      */}
      <h2 className="mb-2.5 text-[15px] font-semibold">
        {auto ? "Ce que fait cette automatisation" : "Quand utiliser cette procédure"}
      </h2>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={async () => {
          if ((workflow.description ?? "") === text) return;
          await updateWorkflow(workflow.id, { description: text.trim() || null });
          onChanged();
        }}
        rows={2}
        placeholder={auto
          ? "Poster chaque lundi les deals gagnés de la semaine dans #revenue."
          : "Quand un client signale une commande abîmée — nourriture écrasée, sac percé, fuite…"}
        className="resize-y rounded-xl text-[14px] leading-relaxed"
      />
      {!auto && (
        <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
          C'est à cette description qu'un agent reconnaît la situation et décide de suivre ces étapes.
          Écrivez-la comme le cas se présente à lui, pas comme un titre.
        </p>
      )}
      {!auto && trigger && <StaleSchedule trigger={trigger} workflow={workflow} ctx={ctx} onChanged={onChanged} />}
      {auto && trigger && <Triggers trigger={trigger} ctx={ctx} />}
    </section>
  );
}

/**
 * Une procédure qui a gardé un déclencheur d'avant.
 *
 * Les procédures en ont porté un, puis ne devaient plus en avoir. Le graphe des
 * anciennes garde l'expression, l'écran ne la montre plus — et le planificateur,
 * lui, la lit toujours (`scheduleOf` ne regarde pas la nature). Résultat : une
 * procédure part toute seule à 9 h sans qu'aucun écran ne dise pourquoi.
 *
 * On ne la désarme pas en silence — ce serait éteindre sans prévenir quelque
 * chose qui tourne aujourd'hui. On la montre, et on donne les deux issues
 * honnêtes : retirer la planification, ou assumer que c'en est une
 * automatisation.
 */
function StaleSchedule({ trigger, workflow, ctx, onChanged }: {
  trigger: Node; workflow: { id: string }; ctx: Ctx; onChanged: () => void;
}) {
  const d = (trigger.data ?? {}) as Record<string, unknown>;
  const expr = String(d.schedule ?? "").trim();
  const mode = String(d.mode ?? "manual");
  if (!expr && mode !== "schedule" && mode !== "webhook") return null;

  return (
    <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="text-[12px] font-medium text-amber-600 dark:text-amber-400">
        Cette procédure porte encore un déclencheur
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        {expr ? <>Elle est planifiée {describeCron(expr)} et se lancera seule tant que c'est le cas.</>
          : <>Elle est réglée sur « appel entrant ».</>}{" "}
        Une procédure n'est pas déclenchée : un agent la consulte quand il rencontre la
        situation décrite au-dessus.
      </p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" className="h-7 text-[12px]"
          onClick={async () => {
            ctx.apply((g) => patchBlock(g, trigger.id, { mode: "manual", schedule: "" }));
            await syncSchedule(workflow.id).catch(() => {});
            onChanged();
          }}>
          Retirer la planification
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-[12px]"
          onClick={async () => { await updateWorkflow(workflow.id, { kind: "automation" }); onChanged(); }}>
          En faire une automatisation
        </Button>
      </div>
    </div>
  );
}

const MODES: Array<{ id: string; label: string; hint: string }> = [
  { id: "manual", label: "À la main", hint: "Lancé depuis cet écran" },
  { id: "schedule", label: "À heure fixe", hint: "Expression cron" },
  { id: "webhook", label: "Sur appel entrant", hint: "Un POST déclenche le run" },
];

/**
 * Ce qui met la procédure en route.
 *
 * Deux mécanismes bien distincts, et c'est pour ça qu'ils sont côte à côte : le
 * MODE (à la main, à heure fixe, sur appel entrant) est porté par le bloc
 * déclencheur ; les ÉVÉNEMENTS D'OUTILS (un mail arrive, un message est posté)
 * sont de vrais abonnements souscrits chez le fournisseur, avec leur filtre et
 * leur journal de réception. Les deux s'ajoutent : une procédure peut être
 * lançable à la main ET se réveiller sur un mail.
 */
function Triggers({ trigger, ctx }: { trigger: Node; ctx: Ctx }) {
  const d = (trigger.data ?? {}) as Record<string, unknown>;
  const mode = String(d.mode ?? "manual");

  return (
    <div className="mt-5">
      <h3 className="mb-2 text-[13px] font-semibold text-muted-foreground">Déclencheurs</h3>

      <div className="flex flex-wrap items-center gap-1.5">
        {MODES.map((m) => (
          <button
            key={m.id} type="button" title={m.hint}
            onClick={() => ctx.apply((g) => patchBlock(g, trigger.id, {
              mode: m.id,
              // Sans expression, « à heure fixe » ne déclenche rien du tout.
              ...(m.id === "schedule" && !String(d.schedule ?? "").trim()
                ? { schedule: DEFAULT_CRON_SPEC.expression } : {}),
            }))}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
              mode === m.id ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            {mode === m.id && <Play className="h-3 w-3" />}
            {m.label}
          </button>
        ))}
      </div>

      {mode === "schedule" && (
        <CronPicker
          value={String(d.schedule ?? "")}
          onChange={(expr) => ctx.apply((g) => patchBlock(g, trigger.id, { schedule: expr }))}
        />
      )}

      {/* Le mode « événement » du bloc n'a jamais rien souscrit : il n'écrit
          qu'une ligne de frontmatter. Le dire, plutôt que de laisser une
          procédure attendre un déclenchement qui ne viendra pas. */}
      {mode === "event" && (
        <p className="mt-2 rounded-lg bg-amber-500/5 p-2 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
          Cette procédure est réglée sur un événement nommé « {String(d.event ?? "")} », qui n'est que documentaire.
          Choisissez un mode ci-dessus et ajoutez l'événement réel juste en dessous.
        </p>
      )}

      {ctx.workspaceId && ctx.projectId && (
        <div className="mt-3">
          <EventTriggers workflowId={ctx.workflowId} workspaceId={ctx.workspaceId} projectId={ctx.projectId} />
        </div>
      )}
    </div>
  );
}

/**
 * Planifier sans écrire de cron.
 *
 * Le champ était l'expression brute. Elle se stocke très bien et ne se lit pas :
 * `0 9 * * 1` ne dit ni le jour ni l'heure à qui ne connaît pas la syntaxe, et
 * une faute de frappe donnait une automatisation qui ne partait jamais sans que
 * rien ne le signale.
 *
 * Donc : on choisit une fréquence, une heure, un jour. Ce qui est ENREGISTRÉ
 * reste une expression cron — le format que le planificateur lit déjà, et que
 * quelqu'un qui la connaît peut toujours saisir via « Expression cron ».
 *
 * Deux choses sont montrées en permanence, parce que ce sont les deux erreurs
 * qu'on fait : l'heure est en UTC (l'équivalent local est affiché à côté), et
 * la prochaine échéance réelle — la seule preuve que l'expression fait ce qu'on
 * croit.
 */
/**
 * Dire quand, en français.
 *
 * Les pastilles couvrent le courant ; elles ne savent pas dire « du lundi au
 * vendredi à 18 h » ni « toutes les 15 minutes », et il ne restait alors que
 * l'expression brute — c'est-à-dire rien, pour qui ne connaît pas la syntaxe.
 *
 * L'application se fait à ⏎ ou à la sortie du champ, jamais à la frappe : en
 * cours de saisie, « tous les jours » se lit avant « tous les jours ouvrés » et
 * enregistrerait une planification qu'on n'a pas fini d'écrire. La ligne de
 * dessous montre ce que ça donnera, avant.
 */
function NaturalCron({ onChange }: { onChange: (expr: string) => void }) {
  const [text, setText] = useState("");
  const parsed = useMemo(() => (text.trim() ? parseNaturalCron(text) : null), [text]);

  const commit = () => {
    if (!parsed) return;
    onChange(parsed);
    setText("");
  };

  return (
    <div>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        onBlur={commit}
        placeholder="Dites quand : « tous les lundis à 9h », « en semaine à 18h », « toutes les 15 minutes »…"
        className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
      />
      {text.trim() && (
        <p className={cn("mt-1 text-[11px]", parsed ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
          {parsed
            ? <>→ {describeCron(parsed)} · ⏎ pour appliquer</>
            : "Pas compris — reformulez, ou réglez avec les boutons ci-dessous."}
        </p>
      )}
    </div>
  );
}

function CronPicker({ value, onChange }: { value: string; onChange: (expr: string) => void }) {
  const spec = useMemo(() => parseCron(value || DEFAULT_CRON_SPEC.expression), [value]);
  const set = (patch: Partial<CronSpec>) => {
    const next = { ...spec, ...patch };
    onChange(next.frequency === "custom" ? next.expression : buildCron(next));
  };

  const next = useMemo(() => nextCronRun(value), [value]);
  const valid = !!next;

  return (
    <div className="mt-2.5 space-y-2.5 rounded-xl border border-border bg-muted/20 p-3">
      <NaturalCron onChange={onChange} />
      <div className="flex flex-wrap items-center gap-1.5">
        {CRON_FREQUENCIES.map((f) => (
          <button
            key={f.id} type="button"
            onClick={() => set(f.id === "custom" ? { frequency: "custom", expression: value || buildCron(spec) } : { frequency: f.id })}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[12px] transition-colors",
              spec.frequency === f.id
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
          >{f.label}</button>
        ))}
      </div>

      {spec.frequency === "custom" ? (
        <input
          value={spec.expression}
          onChange={(e) => set({ expression: e.target.value })}
          placeholder="0 9 * * 1"
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-primary/50"
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {spec.frequency === "weekly" && (
            <div className="flex flex-wrap items-center gap-1">
              {CRON_WEEKDAYS.map((w) => (
                <button
                  key={w.id} type="button" title={w.label}
                  onClick={() => set({ weekday: w.id })}
                  className={cn(
                    "h-7 w-9 rounded-lg text-[12px] capitalize transition-colors",
                    spec.weekday === w.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70",
                  )}
                >{w.short}</button>
              ))}
            </div>
          )}
          {spec.frequency === "monthly" && (
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              le
              <input
                type="number" min={1} max={28}
                value={spec.day}
                onChange={(e) => set({ day: Number(e.target.value) })}
                className="w-14 rounded-lg border border-border bg-background px-2 py-1 text-center text-[13px] tabular-nums outline-none focus:border-primary/50"
              />
            </label>
          )}
          <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            {spec.frequency === "hourly" ? "à la minute" : "à"}
            <input
              type="time"
              value={`${String(spec.hour).padStart(2, "0")}:${String(spec.minute).padStart(2, "0")}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":").map(Number);
                set({ hour: Number.isFinite(h) ? h : spec.hour, minute: Number.isFinite(m) ? m : spec.minute });
              }}
              className="rounded-lg border border-border bg-background px-2 py-1 text-[13px] tabular-nums outline-none focus:border-primary/50"
            />
            <span className="text-muted-foreground/70">UTC</span>
          </label>
        </div>
      )}

      <p className={cn("text-[11px] leading-relaxed", valid ? "text-muted-foreground" : "text-amber-500")}>
        {valid ? (
          <>
            {describeCron(value)} · prochain lancement{" "}
            <span className="font-medium text-foreground">
              {next!.toLocaleString("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}
            </span>{" "}
            <span className="text-muted-foreground/70">(votre heure)</span>
          </>
        ) : (
          "Cette expression n'est pas valide — rien ne se déclenchera."
        )}
      </p>
    </div>
  );
}

/** Le cadre de la procédure : objectif, entrées, et ce qui vaut partout.
 *  Réduit à une rangée de pastilles — c'est un préambule, il ne doit pas
 *  occuper le haut de l'écran devant les étapes. */
function PropertyStrip({ outline, ctx }: { outline: ReturnType<typeof buildOutline>; ctx: Ctx }) {
  const blocks = [...outline.frames, ...outline.globals];
  const openNode = blocks.find((n) => n.id === ctx.openBlock) ?? null;
  const [adding, setAdding] = useState(false);

  return (
    <section className="mt-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {blocks.map((n) => {
          const kind = (n.type ?? "step") as BlockKind;
          const def = BLOCK_BY_KIND.get(kind)!;
          const empty = isBlockEmpty(kind, (n.data ?? {}) as Record<string, unknown>);
          const active = ctx.openBlock === n.id;
          return (
            <button
              key={n.id} type="button"
              onClick={() => ctx.setOpenBlock(active ? null : n.id)}
              className={cn(
                "inline-flex max-w-[15rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
                active ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted",
              )}
            >
              <def.icon className="h-3 w-3 shrink-0" style={{ color: hueOf(kind) }} />
              <span className="font-medium">{def.label}</span>
              <span className={cn("min-w-0 truncate", empty ? "text-amber-500" : "text-muted-foreground")}>
                {empty ? "à remplir" : chipLabelOf(n)}
              </span>
            </button>
          );
        })}
        <div className="relative">
          <button
            type="button" onClick={() => setAdding((v) => !v)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-[12px] text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          ><Plus className="h-3 w-3" /> Cadre</button>
          <Menu open={adding} onClose={() => setAdding(false)}>
            {[...FRAME_KINDS, ...QUALIFIER_KINDS].map((k) => (
              <MenuRow key={k} kind={k} onClick={() => {
                const { graph, id } = insertBlock(ctx.graph, k, {});
                ctx.apply(() => graph);
                ctx.setOpenBlock(id);
                setAdding(false);
              }} />
            ))}
          </Menu>
        </div>
      </div>
      {openNode && <Panel ctx={ctx} node={openNode} removable />}
    </section>
  );
}

/** Les réglages d'un bloc, ouverts sous la ligne qui le porte. */
function Panel({ ctx, node, removable }: { ctx: Ctx; node: Node; removable?: boolean }) {
  return (
    <div className="mt-2 rounded-xl border border-border bg-muted/20 p-3.5">
      <BlockForm
        node={node} nodes={ctx.graph.nodes} edges={ctx.graph.edges}
        agents={ctx.agents} collections={ctx.collections}
        workflowId={ctx.workflowId} workspaceId={ctx.workspaceId} projectId={ctx.projectId}
        onPatch={(p) => ctx.apply((g) => patchBlock(g, node.id, p))}
        onAttach={(q, a) => ctx.apply((g) => attachQualifier(g, q, a))}
        onDetach={(q, a) => ctx.apply((g) => detachQualifier(g, q, a))}
      />
      <div className="mt-3 flex items-center justify-end gap-2 border-t border-border/60 pt-2.5">
        {removable && (
          <button
            type="button"
            onClick={() => { ctx.setOpenBlock(null); ctx.apply((g) => removeBlock(g, node.id)); }}
            className="flex items-center gap-1.5 text-[11px] text-destructive hover:underline"
          ><Trash2 className="h-3 w-3" /> Supprimer</button>
        )}
        <IconButton title="Fermer" onClick={() => ctx.setOpenBlock(null)}><X className="h-3.5 w-3.5" /></IconButton>
      </div>
    </div>
  );
}

// ── La procédure ─────────────────────────────────────────────────────────────

function Procedure({ outline, ctx }: { outline: ReturnType<typeof buildOutline>; ctx: Ctx }) {
  const auto = ctx.kind === "automation";
  if (outline.procedure.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border px-6 py-8 text-center">
        <p className="mx-auto max-w-sm text-[13px] leading-relaxed text-muted-foreground">
          {auto
            ? "Enchaînez les actions à exécuter. Elles partiront telles quelles, dans cet ordre, sans qu'un modèle intervienne."
            : "Écrivez la procédure comme vous l'expliqueriez à quelqu'un : une action par ligne."}
        </p>
        <Button
          size="sm" className="mt-3"
          onClick={() => ctx.apply((g) => insertBlock(g, auto ? "tool" : "step", {}).graph)}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" /> {auto ? "Première action" : "Première étape"}
        </Button>
      </div>
    );
  }
  return <ItemList items={outline.procedure} depth={0} ctx={ctx} />;
}

/** Numérotation : les étapes comptent, les intertitres non. Un titre qui prend
 *  un numéro décale toutes les étapes qui suivent, et le numéro cesse de
 *  désigner le travail à faire. */
function ItemList({ items, depth, ctx }: { items: OutlineItem[]; depth: number; ctx: Ctx }) {
  let n = 0;
  return (
    <div>
      {items.map((it, i) => {
        if (it.kind === "jump") {
          return <JumpRow key={`jump-${it.target.id}-${i}`} target={it.target} />;
        }
        const isSection = it.node.type === "section";
        const ordinal = isSection ? "" : depth === 0 ? `${++n}.` : `${String.fromCharCode(64 + ++n)}.`;
        return (
          <div key={it.node.id}>
            <BlockRow item={it} ordinal={ordinal} depth={depth} ctx={ctx} />
            <InsertPoint ctx={ctx} at={{ afterId: it.node.id }} />
          </div>
        );
      })}
      {items.length === 0 && <InsertPoint ctx={ctx} at={{}} always />}
    </div>
  );
}

function JumpRow({ target }: { target: Node }) {
  return (
    <div className="flex items-center gap-2 py-1.5 pl-9">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-sky-400/15 text-sky-500">
        <ArrowUpRight className="h-3.5 w-3.5" />
      </span>
      <span className="text-[14px]">Aller à</span>
      <span className="rounded-md bg-muted px-2 py-0.5 text-[14px]">{chipLabelOf(target)}</span>
    </div>
  );
}

function BlockRow({ item, ordinal, depth, ctx }: {
  item: Extract<OutlineItem, { kind: "block" }>;
  ordinal: string; depth: number; ctx: Ctx;
}) {
  const node = item.node;
  const kind = (node.type ?? "step") as BlockKind;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const open = ctx.openBlock === node.id;
  const branching = item.legs.length > 0;

  if (kind === "section") {
    return (
      <div className="group/row relative flex items-center gap-2 pt-6">
        <input
          value={String(d.label ?? "")}
          onChange={(e) => ctx.apply((g) => patchBlock(g, node.id, { label: e.target.value }))}
          placeholder="Titre de section"
          className="min-w-0 flex-1 bg-transparent text-[15px] font-semibold outline-none placeholder:font-normal placeholder:text-muted-foreground/50"
        />
        <RowMenu node={node} ctx={ctx} />
      </div>
    );
  }

  // Dans une AUTOMATISATION, un bloc « outil » n'est pas un cadrage posé dans
  // une phrase : c'est l'action elle-même, la ligne entière. La rendre comme
  // une pastille au bout d'un texte laisserait croire qu'un agent lit la phrase
  // et décide d'y recourir — alors que c'est exactement ce qui n'arrivera pas.
  if (ctx.kind === "automation" && kind === "tool") {
    return <ActionRow node={node} ordinal={ordinal} ctx={ctx} />;
  }

  const attached = attachedTo(ctx.graph.nodes, ctx.graph.edges, node.id);
  const body = String(d.body ?? "");
  const inlineIds = new Set(chipIdsIn(body));
  const chips = new Map(attached.map((q) => [q.id, chipInfoOf(q)]));
  /** Les cadrages attachés que la phrase ne nomme pas : ils gardent leur place
   *  en fin de ligne plutôt que de disparaître de l'écran. */
  const trailing = attached.filter((q) => !inlineIds.has(q.id));
  /** Les outils que la phrase NOMME. Leur pastille est dans le texte ; leurs
   *  paramètres, eux, ont besoin de vrais champs — voir plus bas. */
  const inlineTools = attached.filter((q) => q.type === "tool" && inlineIds.has(q.id));
  /** Ceux qui exécutent du code : leur programme s'écrit sous la ligne. */
  const codeTools = attached.filter((q) => q.type === "tool" && !!codeToolOf((q.data ?? {}) as Record<string, unknown>));
  /** Les variables déjà nommées ailleurs dans le workflow — de quoi savoir à
   *  quoi on peut faire référence sans aller relire les étapes précédentes. */
  const availableVars = ctx.graph.nodes
    .map((n) => outputVarOf((n.data ?? {}) as Record<string, unknown>))
    .filter((v) => v && v !== outputVarOf(d));
  /** Un id d'agent qui ne résout plus s'affiche quand même : un agent supprimé
   *  doit apparaître comme un problème, pas effacer la délégation en silence. */
  const delegate = d.agent_id ? (ctx.agentName.get(String(d.agent_id)) ?? "agent introuvable") : "";

  // Ce que `/` propose. Sur une ligne VIDE, on offre d'abord de changer le type
  // du bloc : c'est le geste d'un éditeur de document, et c'est ce qui évite
  // d'avoir à choisir « étape ou décision ? » avant d'avoir écrit la phrase.
  /**
   * Ce que `/` propose.
   *
   * Le principe : on choisit une CHOSE, pas un type de bloc. « Contexte » puis
   * un formulaire pour désigner la collection, c'était deux gestes pour une
   * décision — et la pastille restait « à rédiger » entre les deux. Ici, la
   * collection, l'outil, l'agent et le format de livrable sont dans la liste :
   * le choix produit une pastille complète, tout de suite.
   *
   * Les entrées qui ne PEUVENT pas être complètes d'un clic (une règle, une
   * note à écrire, une action d'app à paramétrer) restent proposées, et
   * ouvrent leurs réglages — elles sont marquées comme telles.
   */
  const slashOptions: SlashOption[] = [
    // Convertir la ligne : seulement quand elle est vide, sinon on proposerait
    // de transformer une phrase déjà écrite en autre chose.
    ...(body.trim() ? [] : kindsFor(ctx.kind).filter((k) => k !== kind).map((k) => ({
      id: `as:${k}`,
      label: BLOCK_BY_KIND.get(k)!.label,
      hint: BLOCK_BY_KIND.get(k)!.hint,
      color: hueOf(k),
      group: "Transformer cette ligne",
    }))),

    ...KNOWN_TOOLS.map((t) => ({
      id: `tool:${t.value}`,
      label: t.label,
      hint: t.value,
      color: hueOf("tool"),
      group: "Outils",
    })),
    { id: "action:", label: "Action sur une app connectée…", hint: "à paramétrer", color: hueOf("tool"), group: "Outils", create: true },

    // Réutiliser ce qu'une étape précédente a produit. En texte, pas en
    // pastille : `{{deals}}` est une VALEUR qu'on insère dans une phrase, pas
    // un bloc qu'on attache — et un agent qui lit la phrase doit voir le nom.
    ...ctx.vars.filter((v) => v !== outputVarOf(d)).map((v) => ({
      id: `var:${v}`,
      label: v,
      hint: "résultat d'une étape",
      color: hueOf("input"),
      group: "Variables",
    })),

    ...ctx.collections.map((c) => ({
      id: `col:${c.id}`,
      label: c.name,
      hint: "collection",
      color: hueOf("context"),
      group: "Connaissances",
    })),
    { id: "note:", label: "Écrire une note ici…", hint: "à rédiger", color: hueOf("context"), group: "Connaissances", create: true },

    // Déléguer : une étape nomme UN agent, une passation en nomme plusieurs.
    // Les deux écrivent au même endroit du modèle, d'où le même item.
    ...ctx.agents.map((a) => ({
      id: `agent:${a.id}`,
      label: a.name,
      hint: kind === "handoff" ? "ajouter au groupe" : "confier cette étape",
      color: hueOf("handoff"),
      group: "Confier à",
    })),

    ...DELIVERABLE_FORMATS.map((f) => ({
      id: `deliv:${f.value}`,
      label: f.label,
      hint: f.hint,
      color: hueOf("deliverable"),
      group: "Produire",
    })),

    { id: "new:rule", label: "Une règle à ne pas enfreindre…", hint: "à rédiger", color: hueOf("rule"), group: "Cadrage", create: true },
    { id: "new:memory", label: "Quelque chose à retenir…", hint: "à rédiger", color: hueOf("memory"), group: "Cadrage", create: true },

    // Réutiliser un cadrage DÉJÀ écrit ailleurs dans la procédure — en dernier,
    // parce que la liste est vide tant qu'on n'en a pas créé.
    ...ctx.graph.nodes
      .filter((x) => roleOf(x.type) === "qualifier" && !attached.some((q) => q.id === x.id))
      .map((x) => ({
        id: `use:${x.id}`,
        label: chipLabelOf(x),
        hint: BLOCK_BY_KIND.get((x.type ?? "context") as BlockKind)?.label,
        color: hueOf(x.type),
        group: "Déjà dans cette procédure",
      })),
  ];

  const onSlashPick = (optionId: string): string | null => {
    /** Créer un cadrage DÉJÀ attaché, et rendre son jeton. `open` ouvre ses
     *  réglages — seulement pour ce qui ne peut pas être complet d'un clic. */
    const add = (k: BlockKind, data: Record<string, unknown>, open = false): string => {
      const { graph, id } = insertAttached(ctx.graph, k, node.id, data);
      ctx.apply(() => graph);
      if (open) ctx.setOpenBlock(id);
      return chipToken(id);
    };

    if (optionId.startsWith("as:")) {
      ctx.apply((g) => convertBlock(g, node.id, optionId.slice(3) as BlockKind));
      return null;
    }
    if (optionId.startsWith("use:")) {
      const qid = optionId.slice(4);
      ctx.apply((g) => attachQualifier(g, qid, node.id));
      return chipToken(qid);
    }
    // Une variable s'insère comme du TEXTE : `toHtml` n'y reconnaît pas le
    // préfixe `b:` d'une pastille, donc elle est échappée telle quelle — ce
    // qu'on veut, puisque c'est le gabarit lui-même qui doit rester lisible.
    if (optionId.startsWith("var:")) return `{{${optionId.slice(4)}}}`;
    if (optionId.startsWith("tool:")) {
      return add("tool", { tool: optionId.slice(5), required: true });
    }
    if (optionId === "action:") {
      return add("tool", { tool: "", provider: "", action: "", args: {} }, true);
    }
    if (optionId.startsWith("col:")) {
      const id = optionId.slice(4);
      const col = ctx.collections.find((c) => c.id === id);
      if (!col) return null;
      // Complète du premier coup : la source est « collections », la référence
      // est posée. Rien à ouvrir.
      return add("context", {
        source: "collections",
        refs: [{ kind: "collection", id: col.id, label: col.name }],
      });
    }
    if (optionId === "note:") {
      return add("context", { source: "write", scope: "global" }, true);
    }
    if (optionId.startsWith("deliv:")) {
      return add("deliverable", { format: optionId.slice(6) }, true);
    }
    if (optionId.startsWith("agent:")) {
      const agentId = optionId.slice(6);
      // Déléguer n'est pas un cadrage : ça ne s'attache pas, ça se pose SUR le
      // bloc. Donc pas de pastille en ligne — la délégation s'affiche en fin de
      // ligne, là où elle vaut pour l'étape entière et non pour un mot.
      ctx.apply((g) => {
        if (kind !== "handoff") return patchBlock(g, node.id, { agent_id: agentId });
        // La liste est relue DANS le graphe courant, pas dans la fermeture :
        // choisir deux agents coup sur coup perdrait le premier autrement.
        const cur = g.nodes.find((n) => n.id === node.id)?.data as Record<string, unknown> | undefined;
        const prev = Array.isArray(cur?.agent_ids) ? (cur!.agent_ids as string[]) : [];
        return patchBlock(g, node.id, { agent_ids: [...new Set([...prev, agentId])] });
      });
      return null;
    }
    if (optionId.startsWith("new:")) {
      return add(optionId.slice(4) as BlockKind, {}, true);
    }
    return null;
  };

  return (
    <div className="group/row">
      <div className="flex items-start gap-3 py-1">
        <span className="mt-1 w-6 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{ordinal}</span>

        <div className="min-w-0 flex-1">
          {branching ? (
            <BranchHead node={node} ctx={ctx} />
          ) : (
            <div className="flex items-start gap-2">
              {kind !== "step" && <Tile icon={BLOCK_BY_KIND.get(kind)!.icon} tone="slate" />}
              <div className="min-w-0 flex-1 pt-px">
                <RichLine
                  value={body}
                  chips={chips}
                  placeholder={hintsFor(kind)}
                  slashOptions={slashOptions}
                  onSlashPick={onSlashPick}
                  onChange={(v) => ctx.apply((g) => patchBlock(g, node.id, { body: v }))}
                  onChipMenu={(chipId) => ctx.setOpenBlock(chipId)}
                  className="text-[14px]"
                />
              </div>
            </div>
          )}

          {/* Une passation affiche TOUJOURS sa rangée, même vide : c'est là
              qu'on choisit le destinataire, et une passation sans destinataire
              est une étape qui n'arrivera jamais. */}
          {(trailing.length > 0 || !!delegate || inlineTools.length > 0 || kind === "handoff") && (
            <div className={cn("mt-1 flex flex-wrap items-center gap-x-2 gap-y-1", branching && "ml-8")}>
              {delegate && (
                <Pill onClick={() => ctx.setOpenBlock(node.id)} color="#e879f9" verb="Confier à" label={delegate} />
              )}
              {kind === "handoff" && <HandoffPills node={node} ctx={ctx} />}
              {trailing.map((q) => (
                <span key={q.id} className="inline-flex flex-wrap items-center gap-1">
                  <Pill
                    onClick={() => ctx.setOpenBlock(q.id)}
                    color={hueOf(q.type)} verb={chipInfoOf(q).verb} label={chipLabelOf(q)}
                  />
                  <ArgPills node={q} ctx={ctx} />
                </span>
              ))}

              {/* Les paramètres d'un outil posé DANS la phrase.
                  Sa pastille vit à l'intérieur d'un innerHTML — on ne peut pas
                  y monter de champ sans faire du contenteditable une surface
                  contrôlée par React, ce que tout le reste de RichLine évite.
                  Ils se règlent donc ici, sous la ligne, rattachés au nom de
                  l'outil pour qu'on sache duquel il s'agit quand la phrase en
                  contient deux. */}
              {inlineTools.map((q) => (
                <span key={q.id} className="inline-flex flex-wrap items-center gap-1">
                  <button
                    type="button" onClick={() => ctx.setOpenBlock(q.id)}
                    className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
                    title="Régler cet outil"
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: hueOf(q.type) }} />
                    {chipLabelOf(q)}
                  </button>
                  <ArgPills node={q} ctx={ctx} />
                </span>
              ))}
            </div>
          )}

          {/* Le code, sous la ligne : c'est le seul « paramètre » qui ne tient
              pas sur une pastille, et le cacher dans un panneau reviendrait à
              masquer ce que l'étape fait réellement. */}
          {codeTools.map((q) => (
            <CodeEditor key={q.id} node={q} ctx={ctx} vars={availableVars} />
          ))}
        </div>

        <RowMenu node={node} ctx={ctx} />
      </div>

      {open && <div className="ml-9"><Panel ctx={ctx} node={node} /></div>}

      {branching && (
        <div className="ml-9 mt-1">
          {item.legs.map((leg) => <Leg key={leg.handle} node={node} leg={leg} depth={depth} ctx={ctx} />)}
        </div>
      )}
    </div>
  );
}

/**
 * Les paramètres d'un outil, posés juste à côté de lui.
 *
 * Ils vivaient uniquement dans le panneau de réglages, ce qui obligeait à
 * ouvrir un bloc pour savoir avec QUOI il sera appelé. Or c'est la moitié de
 * l'information : « Recherche web » ne dit rien, « Recherche web · query=tarifs
 * concurrents » dit tout. Modifiables sur place — la valeur est ce qu'on ajuste
 * le plus souvent, le choix de l'outil ce qu'on ajuste le moins.
 */
/**
 * Une passation, réglée sur sa ligne.
 *
 * Elle n'affichait qu'un texte gris — « Confier à des agents, avec ce qui doit
 * revenir » — qui décrit le bloc sans permettre de le remplir. Il fallait
 * ouvrir les réglages pour découvrir qu'on pouvait choisir quelqu'un. Or une
 * passation tient en deux décisions, et les deux sont courtes : QUI, et ce qui
 * REVIENT. Les mettre sur la ligne, c'est ce qui la rend lisible sans l'ouvrir.
 */
function HandoffPills({ node, ctx }: { node: Node; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const d = (node.data ?? {}) as Record<string, unknown>;
  const ids = Array.isArray(d.agent_ids) ? (d.agent_ids as string[]) : [];
  const free = ctx.agents.filter((a) => !ids.includes(a.id));

  const setIds = (next: string[]) => ctx.apply((g) => patchBlock(g, node.id, { agent_ids: next }));

  return (
    <>
      {ids.map((id) => (
        <span
          key={id}
          className="group/agent inline-flex items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5 text-[12px]"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-400" />
          <b className="font-semibold">Confier à</b>
          <span className="text-muted-foreground">{ctx.agentName.get(id) ?? "agent introuvable"}</span>
          <button
            type="button" onClick={() => setIds(ids.filter((x) => x !== id))}
            title="Retirer"
            className="rounded text-muted-foreground/60 opacity-0 transition-opacity hover:text-destructive group-hover/agent:opacity-100"
          ><X className="h-3 w-3" /></button>
        </span>
      ))}

      <span className="relative inline-flex">
        <button
          type="button" onClick={() => setOpen((v) => !v)}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] transition-colors",
            ids.length === 0
              ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
              : "text-muted-foreground/60 hover:bg-muted hover:text-foreground",
          )}
        >
          <Plus className="h-3 w-3" />
          {ids.length === 0 ? "Choisir un agent" : ""}
        </button>
        <Menu open={open} onClose={() => setOpen(false)}>
          {free.length === 0 ? (
            <p className="px-3 py-2 text-[12px] text-muted-foreground">
              {ctx.agents.length === 0 ? "Aucun agent dans ce service." : "Tous les agents sont déjà destinataires."}
            </p>
          ) : free.map((a) => (
            <button
              key={a.id} type="button"
              onClick={() => { setIds([...ids, a.id]); setOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-muted"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-fuchsia-400" />
              {a.name}
            </button>
          ))}
        </Menu>
      </span>

      {/* Le contrat de retour. C'est lui qui sépare une passation d'une simple
          délégation : sans lui, on récupère trois paragraphes là où on
          attendait un chiffre. */}
      {ids.length > 0 && (
        <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[12px]">
          <span className="text-[11px] text-muted-foreground">revient</span>
          <input
            value={String(d.expects ?? "")}
            onChange={(e) => ctx.apply((g) => patchBlock(g, node.id, { expects: e.target.value }))}
            placeholder="un tableau comparatif, un chiffre…"
            size={Math.max(18, Math.min(String(d.expects ?? "").length + 1, 40))}
            className="bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/50"
          />
        </span>
      )}
    </>
  );
}

/**
 * Le nom sous lequel le résultat d'un bloc est rangé.
 *
 * C'est ce qui rend une procédure chaînable : sans nom, l'étape suivante ne
 * peut désigner ce que celle-ci a produit qu'en citant l'identifiant du bloc,
 * qui ne veut rien dire. Avec, elle écrit `{{deals}}`.
 */
/**
 * Écrire le code d'une étape, sur la ligne.
 *
 * Un outil se CHOISIT ; du code s'ÉCRIT. Un champ « paramètres » n'a aucun sens
 * pour lui — le paramètre, c'est le programme. Et le mettre dans un panneau
 * qu'il faut ouvrir masquerait ce que l'étape fait réellement, alors que c'est
 * la seule chose qu'on veut relire.
 *
 * Les variables déjà nommées plus haut sont proposées au-dessus : le vrai
 * obstacle n'est pas d'écrire `{{deals}}`, c'est de se rappeler que `deals`
 * existe sans aller relire les étapes précédentes.
 */
function CodeEditor({ node, ctx, vars }: { node: Node; ctx: Ctx; vars: string[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const d = (node.data ?? {}) as Record<string, unknown>;
  const lang = codeToolOf(d);
  const code = String(d.code ?? "");
  if (!lang) return null;

  const write = (next: string) => ctx.apply((g) => patchBlock(g, node.id, { code: next }));

  /** Poser `{{nom}}` au curseur, pas à la fin : on insère une variable au
   *  milieu d'une ligne qu'on est en train d'écrire. */
  const insertVar = (name: string) => {
    const el = ref.current;
    const token = `{{${name}}}`;
    if (!el) { write(code + token); return; }
    const a = el.selectionStart ?? code.length;
    const b = el.selectionEnd ?? a;
    const next = code.slice(0, a) + token + code.slice(b);
    write(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + token.length, a + token.length);
    });
  };

  return (
    <div className="mt-1.5 overflow-hidden rounded-xl border border-border bg-muted/20">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
        <Code2 className="h-3.5 w-3.5 text-blue-400" />
        <span className="text-[11px] font-medium">{lang.label}</span>
        {vars.length > 0 && (
          <>
            <span className="ml-1 text-[11px] text-muted-foreground">insérer</span>
            {vars.map((v) => (
              <button
                key={v} type="button" onClick={() => insertVar(v)}
                title={`Insérer {{${v}}}`}
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              >{v}</button>
            ))}
          </>
        )}
        <span className="ml-auto">
          <OutputVarPill node={node} ctx={ctx} />
        </span>
      </div>
      <textarea
        ref={ref}
        value={code}
        onChange={(e) => write(e.target.value)}
        onKeyDown={(e) => {
          // Tab indente au lieu de quitter le champ : dans un éditeur de code,
          // perdre le focus sur Tab rend l'indentation impossible.
          if (e.key !== "Tab") return;
          e.preventDefault();
          const el = e.currentTarget;
          const a = el.selectionStart, b = el.selectionEnd;
          write(code.slice(0, a) + "  " + code.slice(b));
          requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
        }}
        rows={Math.max(3, Math.min(code.split("\n").length + 1, 20))}
        spellCheck={false}
        placeholder={lang.language === "python"
          ? "deals = {{deals}}\nretenus = [d for d in deals if d['amount'] > 1000]\nretenus"
          : "// La dernière expression est le résultat."}
        className="w-full resize-y bg-transparent px-3 py-2.5 font-mono text-[12.5px] leading-relaxed outline-none placeholder:text-muted-foreground/40"
      />
    </div>
  );
}

function OutputVarPill({ node, ctx }: { node: Node; ctx: Ctx }) {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const raw = String(d.output_var ?? "");
  const [editing, setEditing] = useState(false);

  if (!raw && !editing) {
    return (
      <button
        type="button" onClick={() => setEditing(true)}
        title="Ranger le résultat dans une variable"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
      ><ArrowRightToLine className="h-3 w-3" /> variable</button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[12px]">
      <ArrowRightToLine className="h-3 w-3 text-muted-foreground" />
      <input
        autoFocus={editing}
        value={raw}
        onChange={(e) => ctx.apply((g) => patchBlock(g, node.id, { output_var: e.target.value }))}
        onBlur={() => setEditing(false)}
        placeholder="nom"
        size={Math.max(6, Math.min(raw.length + 1, 24))}
        className="bg-transparent font-mono text-[12px] outline-none placeholder:text-muted-foreground/50"
      />
    </span>
  );
}

function ArgPills({ node, ctx }: { node: Node; ctx: Ctx }) {
  const d = (node.data ?? {}) as Record<string, unknown>;
  if (node.type !== "tool") return null;
  // Un outil qui exécute du code n'a pas de paramètres : son paramètre EST le
  // programme, écrit sur la ligne.
  if (codeToolOf(d)) return <OutputVarPill node={node} ctx={ctx} />;
  const args = (d.args ?? {}) as Record<string, unknown>;
  const entries = Object.entries(args);

  /**
   * Réécrire la table ENTIÈRE à partir des paires.
   *
   * Deux raisons. Renommer une clé autrement la déplacerait à la fin, alors que
   * l'ordre est celui dans lequel on les a écrites. Et une paire dont la clé
   * n'est pas encore tapée doit SURVIVRE : la filtrer ici ferait disparaître le
   * paramètre à l'instant où on l'ajoute. Ce sont `toolCall` et le moteur qui
   * écartent les paires incomplètes, au moment où elles comptent vraiment.
   */
  const write = (pairs: Array<[string, unknown]>) =>
    ctx.apply((g) => patchBlock(g, node.id, { args: Object.fromEntries(pairs) }));

  const grow = (v: string, min = 3, max = 24) => Math.max(min, Math.min(v.length + 1, max));

  return (
    <>
      {entries.map(([name, value], i) => (
        <span
          key={i}
          className="group/arg inline-flex items-center gap-0.5 rounded-md bg-muted/60 px-1.5 py-0.5 text-[12px]"
        >
          <input
            value={name}
            onChange={(e) => write(entries.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))}
            size={grow(name)}
            placeholder="param"
            className="bg-transparent font-mono text-[11px] text-muted-foreground outline-none"
          />
          <span className="text-muted-foreground/60">=</span>
          <input
            value={String(value ?? "")}
            onChange={(e) => write(entries.map((p, j) => (j === i ? [p[0], e.target.value] : p)))}
            size={grow(String(value ?? ""), 4, 28)}
            placeholder="valeur"
            className="bg-transparent font-mono text-[12px] outline-none"
          />
          <button
            type="button"
            onClick={() => write(entries.filter((_, j) => j !== i))}
            title="Retirer ce paramètre"
            className="ml-0.5 rounded text-muted-foreground/60 opacity-0 transition-opacity hover:text-destructive group-hover/arg:opacity-100"
          ><X className="h-3 w-3" /></button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => write([...entries, ["", ""]])}
        title="Ajouter un paramètre"
        className="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
      ><Plus className="h-3 w-3" /></button>
      <OutputVarPill node={node} ctx={ctx} />
    </>
  );
}

function Pill({ color, verb, label, onClick }: {
  color: string; verb: string; label: string; onClick: () => void;
}) {
  return (
    <button
      type="button" onClick={onClick} title="Régler ce bloc"
      className="inline-flex items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5 text-[13px] transition-colors hover:bg-muted/70"
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      <b className="font-semibold">{verb}</b>
      <span className="text-muted-foreground">{label}</span>
    </button>
  );
}

/** La tête d'une décision ou d'une boucle : la tuile, le mot-clé, puis la
 *  condition dans son propre encadré — parce qu'une condition se relit seule. */
function BranchHead({ node, ctx }: { node: Node; ctx: Ctx }) {
  const kind = (node.type ?? "decision") as BlockKind;
  const d = (node.data ?? {}) as Record<string, unknown>;
  const isLoop = kind === "loop";
  const mode = String(d.mode ?? "foreach");
  const field = isLoop ? (mode === "until" ? "until" : "over") : "body";

  return (
    <div>
      <div className="flex items-center gap-2">
        <Tile icon={isLoop ? Repeat : GitBranch} />
        <span className="font-mono text-[12px] font-medium tracking-wide">
          {isLoop ? (mode === "until" ? "TANT QUE" : "POUR CHAQUE") : "SI"}
        </span>
      </div>
      <div className="ml-8 mt-1.5">
        {/* Une condition d'automatisation est ÉVALUÉE, pas lue : elle ne peut
            pas être une phrase. Une condition de procédure est lue par un agent
            et n'a aucune raison de se réduire à trois champs. Même bloc, deux
            écritures, parce que ce ne sont pas les mêmes lecteurs. */}
        {ctx.kind === "automation" && !isLoop ? (
          <TestEditor node={node} ctx={ctx} />
        ) : (
          <Textarea
            value={String(d[field] ?? "")}
            onChange={(e) => ctx.apply((g) => patchBlock(g, node.id, { [field]: e.target.value }))}
            rows={1}
            placeholder={isLoop
              ? (mode === "until" ? "il reste des tickets à qualifier" : "compte client signalé plus haut")
              : "la photo montre clairement l'emballage percé"}
            className="min-h-[2.75rem] resize-y rounded-xl bg-background px-3.5 py-2.5 text-[14px] leading-relaxed"
          />
        )}
      </div>
    </div>
  );
}

/**
 * Une action d'automatisation : l'app, l'appel, et ce qu'on lui passe.
 *
 * Elle s'affiche telle qu'elle s'exécutera — `use_hubspot → list_deals`. C'est
 * une exigence, pas un choix esthétique : la promesse d'une automatisation est
 * qu'on puisse lire ce qui va se passer AVANT que ça se passe, et une ligne de
 * prose ne le permet pas.
 */
function ActionRow({ node, ordinal, ctx }: { node: Node; ordinal: string; ctx: Ctx }) {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const provider = String(d.provider ?? "").trim();
  const action = String(d.action ?? "").trim();
  const open = ctx.openBlock === node.id;
  const ready = !!provider && !!action;

  return (
    <div className="group/row">
      <div className="flex items-start gap-3 py-1">
        <span className="mt-1.5 w-6 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{ordinal}</span>
        <button
          type="button"
          onClick={() => ctx.setOpenBlock(open ? null : node.id)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors",
            open ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted/40",
          )}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-blue-400/15 text-blue-500">
            <Wrench className="h-3.5 w-3.5" />
          </span>
          {ready ? (
            <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
              {provider} <span className="text-muted-foreground">→</span> {action}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-[13px] text-amber-500">
              Choisir l'application et l'action
            </span>
          )}
          {String(d.label ?? "").trim() && (
            <span className="shrink-0 truncate text-[12px] text-muted-foreground">{String(d.label)}</span>
          )}
        </button>
        <RowMenu node={node} ctx={ctx} />
      </div>
      {open && (
        <div className="ml-9">
          <ErrorPolicy node={node} ctx={ctx} />
          <Panel ctx={ctx} node={node} />
        </div>
      )}
    </div>
  );
}

/**
 * Ce que fait la chaîne quand CETTE étape échoue.
 *
 * Par défaut, elle s'arrête : continuer sur une valeur qui n'existe pas est
 * pire qu'un arrêt. Mais une étape accessoire (prévenir Slack, écrire un
 * journal) ne devrait pas coûter toute l'automatisation — celle-là peut
 * continuer, et les étapes suivantes testent `steps.<id>.error`.
 * Les nouveaux essais ne concernent que les pannes passagères ; une écriture
 * n'est rejouée que si elle a été refusée avant d'être exécutée (le moteur y
 * veille, l'écran n'a pas à le demander).
 */
function ErrorPolicy({ node, ctx }: { node: Node; ctx: Ctx }) {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const onError = d.on_error === "continue" ? "continue" : "stop";
  const retries = d.retries == null || d.retries === "" ? "2" : String(d.retries);
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
      <span>En cas d'échec</span>
      <div className="w-56">
        <Picker
          value={onError}
          onChange={(v) => ctx.apply((g) => patchBlock(g, node.id, { on_error: v === "continue" ? "continue" : undefined }))}
          options={[
            { value: "stop", label: "Arrêter l'automatisation" },
            { value: "continue", label: "Continuer (étape accessoire)" },
          ]}
        />
      </div>
      <span>nouveaux essais</span>
      <div className="w-20">
        <Picker
          value={retries}
          onChange={(v) => ctx.apply((g) => patchBlock(g, node.id, { retries: Number(v) }))}
          options={["0", "1", "2", "3"].map((n) => ({ value: n, label: n }))}
        />
      </div>
    </div>
  );
}

/** Les opérateurs, repris du moteur — c'est lui qui les évalue, et une liste
 *  recopiée ici proposerait tôt ou tard un test que le moteur ne connaît pas. */
const TEST_OPS: Array<{ id: string; label: string; needsRight: boolean }> = [
  { id: "equals", label: "est égal à", needsRight: true },
  { id: "not_equals", label: "est différent de", needsRight: true },
  { id: "contains", label: "contient", needsRight: true },
  { id: "not_contains", label: "ne contient pas", needsRight: true },
  { id: "gt", label: "est supérieur à", needsRight: true },
  { id: "lt", label: "est inférieur à", needsRight: true },
  { id: "exists", label: "existe", needsRight: false },
  { id: "empty", label: "est vide", needsRight: false },
];

type TestValue = { left?: string; op?: string; right?: string };

/**
 * Une condition en trois cases : une donnée, un opérateur, une valeur — et,
 * au besoin, plusieurs conditions reliées par « toutes » ou « au moins une ».
 *
 * Pauvre exprès. Le moteur n'interprète pas d'expression et n'appelle aucun
 * modèle : ce qui n'entre pas dans ces trois cases ne serait pas évaluable, et
 * un champ libre qui accepte tout produirait des conditions qui échouent
 * silencieusement à l'exécution.
 *
 * Écrit `tests` + `match`, et recopie la première dans `test` : tout ce qui
 * lisait une condition unique (revue de l'assistant, anciens runs) continue
 * de la trouver.
 */
function TestEditor({ node, ctx }: { node: Node; ctx: Ctx }) {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const tests: TestValue[] = Array.isArray(d.tests) && (d.tests as TestValue[]).length
    ? (d.tests as TestValue[])
    : [((d.test ?? {}) as TestValue)];
  const match = d.match === "any" ? "any" : "all";
  const write = (next: TestValue[], m: string = match) =>
    ctx.apply((g) => patchBlock(g, node.id, { tests: next, test: next[0] ?? {}, match: m }));

  return (
    <div className="space-y-1.5">
      {tests.map((t, i) => (
        <div key={i} className="flex items-center gap-1.5">
          {tests.length > 1 && (
            <span className="w-14 shrink-0 text-right text-[11px] text-muted-foreground">
              {i === 0 ? "si" : match === "any" ? "ou" : "et"}
            </span>
          )}
          <TestRow
            node={node} ctx={ctx} test={t}
            onChange={(patch) => write(tests.map((x, j) => (j === i ? { ...x, ...patch } : x)))}
          />
          {tests.length > 1 && (
            <button
              type="button" title="Retirer cette condition"
              onClick={() => write(tests.filter((_, j) => j !== i))}
              className="shrink-0 rounded-md p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            ><X className="h-3.5 w-3.5" /></button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2 pl-0.5">
        <button
          type="button"
          onClick={() => write([...tests, { op: "contains" }])}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
        ><Plus className="h-3 w-3" /> condition</button>
        {tests.length > 1 && (
          <div className="w-52">
            <Picker
              value={match}
              onChange={(v) => write(tests, v)}
              options={[
                { value: "all", label: "Toutes doivent être vraies" },
                { value: "any", label: "Au moins une suffit" },
              ]}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function TestRow({ node, ctx, test, onChange }: {
  node: Node; ctx: Ctx; test: TestValue; onChange: (patch: TestValue) => void;
}) {
  const op = TEST_OPS.find((o) => o.id === (test.op ?? "contains")) ?? TEST_OPS[2];
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-background p-2">
      {/* Le champ reste libre — une condition porte souvent sur un sous-champ
          (`trigger.from`, `deals.total`) qu'aucune liste ne peut deviner. Mais
          les variables déjà nommées sont proposées : le vrai obstacle est de se
          rappeler qu'elles existent, pas de taper un point. */}
      <span className="flex min-w-[9rem] flex-1 items-center gap-1 rounded-lg bg-muted/50 px-2.5 py-1.5 focus-within:bg-muted">
        <input
          value={test.left ?? ""}
          onChange={(e) => onChange({ left: e.target.value })}
          list={`vars-${node.id}`}
          placeholder="trigger.from"
          title="Le chemin d'une donnée : trigger.<champ>, une variable, steps.<bloc>.<champ> ou liste[0].champ"
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground/50"
        />
        <datalist id={`vars-${node.id}`}>
          {ctx.vars.map((v) => <option key={v} value={v} />)}
          <option value="trigger" />
        </datalist>
      </span>
      <div className="w-40 shrink-0">
        <Picker
          value={op.id}
          onChange={(v) => onChange({ op: v })}
          options={TEST_OPS.map((o) => ({ value: o.id, label: o.label }))}
        />
      </div>
      {op.needsRight && (
        <input
          value={test.right ?? ""}
          onChange={(e) => onChange({ right: e.target.value })}
          placeholder="@acme.com"
          className="min-w-[7rem] flex-1 rounded-lg bg-muted/50 px-2.5 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground/50 focus:bg-muted"
        />
      )}
    </div>
  );
}

function Leg({ node, leg, depth, ctx }: { node: Node; leg: OutlineLeg; depth: number; ctx: Ctx }) {
  const isElse = leg.handle === "false";
  return (
    <div className="mt-2">
      {isElse && (
        <div className="mb-1 flex items-center gap-2">
          <Tile icon={CornerDownRight} />
          <span className="font-mono text-[12px] font-medium tracking-wide">SINON</span>
        </div>
      )}
      <div className="ml-3 border-l border-border pl-5">
        {leg.items.length > 0 ? (
          <ItemList items={leg.items} depth={depth + 1} ctx={ctx} />
        ) : (
          <div>
            <p className="py-1 pl-9 text-[13px] text-muted-foreground/60">
              Ce que l'agent fait dans ce cas
            </p>
            <InsertPoint ctx={ctx} at={{ legOf: node.id, legHandle: leg.handle }} always />
          </div>
        )}
      </div>
    </div>
  );
}

function RowMenu({ node, ctx }: { node: Node; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const act = (fn: () => void) => { fn(); setOpen(false); };
  return (
    <div className="relative mt-0.5 shrink-0">
      <button
        type="button" onClick={() => setOpen((v) => !v)}
        className={cn(
          "rounded-md p-1 text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground",
          open ? "opacity-100" : "opacity-0 group-hover/row:opacity-100",
        )}
        title="Options"
      ><MoreHorizontal className="h-3.5 w-3.5" /></button>
      <Menu open={open} onClose={() => setOpen(false)} align="right">
        <MenuItem icon={Settings2} label="Réglages" onClick={() => act(() => ctx.setOpenBlock(ctx.openBlock === node.id ? null : node.id))} />
        <MenuItem icon={ChevronUp} label="Monter" onClick={() => act(() => ctx.apply((g) => moveBlock(g, node.id, -1, ctx.kind)))} />
        <MenuItem icon={ChevronDown} label="Descendre" onClick={() => act(() => ctx.apply((g) => moveBlock(g, node.id, 1, ctx.kind)))} />
        <div className="my-1 border-t border-border/60" />
        {kindsFor(ctx.kind).filter((k) => k !== node.type).map((k) => (
          <MenuItem
            key={k} icon={BLOCK_BY_KIND.get(k)!.icon} label={`Transformer en ${BLOCK_BY_KIND.get(k)!.label.toLowerCase()}`}
            onClick={() => act(() => ctx.apply((g) => convertBlock(g, node.id, k)))}
          />
        ))}
        <div className="my-1 border-t border-border/60" />
        <MenuItem
          icon={Trash2} label="Supprimer" destructive
          onClick={() => act(() => { ctx.setOpenBlock(null); ctx.apply((g) => removeBlock(g, node.id)); })}
        />
      </Menu>
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, destructive }: {
  icon: typeof Trash2; label: string; onClick: () => void; destructive?: boolean;
}) {
  return (
    <button
      type="button" onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-muted",
        destructive && "text-destructive",
      )}
    ><Icon className="h-3.5 w-3.5 shrink-0" /> {label}</button>
  );
}
