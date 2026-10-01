import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CaretUpIcon as ChevronUp,
  CaretDownIcon as ChevronDown,
  CaretRightIcon as ChevronRight,
  PlayIcon as Play,
  SquareIcon as Square,
  CircleNotchIcon as Loader2,
  TerminalWindowIcon as Terminal,
  BracketsCurlyIcon as Braces,
  ArrowsOutSimpleIcon as Expand,
  ArrowsInSimpleIcon as Collapse,
  FlaskIcon as Flask,
  XIcon as X,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { varsOf, normalizeVarName } from "./blocks";
import {
  fetchRunSteps, fetchRunEvents, outputVarOf,
  type RunStep, type RunEvent, type WorkflowRun, type WorkflowKind,
} from "./model";
import type { Graph } from "./outline";
import type { Ctx } from "./editor-ctx";

// La CONSOLE — ce qui se passe, pendant que ça se passe.
//
// Un workflow se testait jusqu'ici en cliquant « Tester » puis en attendant :
// l'écran disait « en cours », puis « réussi » ou « échoué ». Entre les deux,
// rien. Pour une automatisation de six appels, « échoué » ne dit ni lequel a
// cassé, ni avec quels arguments, ni ce que l'API a répondu — et pour une
// procédure, le travail de l'agent n'était visible que depuis sa propre fiche,
// ailleurs dans l'application.
//
// Les deux natures ont chacune leur trace, et elles ne se ressemblent pas :
//
//   automation — `agent_workflow_run_steps`, écrit par le moteur, une ligne par
//                bloc parcouru, avec ses entrées et sa sortie.
//   procedure  — les événements du run de l'agent : ses appels d'outils, ses
//                messages, ses erreurs.
//
// Elles sont ramenées ici à une seule forme de ligne, parce que la question
// posée est la même : qu'est-ce qui vient de se produire, et où ça a coincé.

export interface LogLine {
  id: string;
  at: string;
  /** Le bloc concerné, quand on sait le nommer — c'est lui qui s'allume sur le
   *  canevas pendant l'exécution. */
  blockId?: string;
  status: "running" | "succeeded" | "failed" | "skipped" | "info";
  title: string;
  hint?: string;
  detail?: unknown;
  error?: string | null;
  ms?: number | null;
  position?: number;
}

export interface RunLog {
  lines: LogLine[];
  /** L'état de chaque bloc parcouru — lu par les cartes du canevas. */
  statusByBlock: Map<string, string>;
  /** Ce que valait chaque variable à la fin du run. */
  values: Record<string, unknown>;
  /** La charge du déclenchement, telle que le run l'a reçue. */
  trigger: Record<string, unknown> | null;
  live: boolean;
}

const EMPTY: RunLog = { lines: [], statusByBlock: new Map(), values: {}, trigger: null, live: false };

/**
 * Le journal d'une exécution, quelle que soit sa nature.
 *
 * Interroge en boucle tant que le run tourne, et s'arrête dès qu'il est fini :
 * une console qui continue d'interroger une exécution terminée est un appel
 * réseau par seconde pour afficher deux fois la même chose.
 */
export function useRunLog(run: WorkflowRun | null, kind: WorkflowKind, graph: Graph): RunLog {
  const qc = useQueryClient();
  const live = run?.status === "running";
  const isAutomation = kind === "automation";

  const { data: steps } = useQuery({
    queryKey: ["workflow_run_steps", run?.id],
    enabled: !!run?.id && isAutomation,
    queryFn: () => fetchRunSteps(run!.id),
    refetchInterval: live ? 1200 : false,
  });

  const { data: events } = useQuery({
    queryKey: ["workflow_run_events", run?.agent_run_id],
    enabled: !!run?.agent_run_id && !isAutomation,
    queryFn: () => fetchRunEvents(run!.agent_run_id!),
    refetchInterval: live ? 2500 : false,
  });

  // Le temps réel en plus du sondage, pas à la place : la table des événements
  // d'agent est publiée, celle des étapes d'automatisation ne l'est pas, et une
  // console qui ne marcherait que pour une nature sur deux ne vaut rien.
  useEffect(() => {
    if (!live || isAutomation || !run?.agent_run_id) return;
    const ch = supabase
      .channel(`wf-run-${run.agent_run_id}-${Math.random().toString(36).slice(2, 7)}`)
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "internal_agent_run_events",
        filter: `run_id=eq.${run.agent_run_id}`,
      }, () => qc.invalidateQueries({ queryKey: ["workflow_run_events", run.agent_run_id] }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [live, isAutomation, run?.agent_run_id, qc]);

  return useMemo(() => {
    if (!run) return EMPTY;
    return isAutomation
      ? fromSteps(steps ?? [], run, graph)
      : fromEvents(events ?? [], run);
  }, [run, steps, events, isAutomation, graph]);
}

/** Le journal d'une automatisation : une ligne par bloc parcouru. */
function fromSteps(steps: RunStep[], run: WorkflowRun, graph: Graph): RunLog {
  const lines: LogLine[] = [];
  const statusByBlock = new Map<string, string>();
  const values: Record<string, unknown> = {};

  // Les variables déclarées valent ce que le bloc dit, dès avant le premier
  // pas : ce sont des constantes, pas des résultats. Celles d'un bloc
  // « Valeurs » ne sont PAS semées ici — elles n'existent qu'une fois l'étape
  // passée, et les afficher d'avance ferait croire qu'elles sont déjà là.
  for (const n of graph.nodes) {
    if (n.type !== "variables") continue;
    for (const v of varsOf((n.data ?? {}) as Record<string, unknown>)) {
      const name = normalizeVarName(v.name);
      if (name) values[name] = v.secret ? "••••••" : (v.value ?? "");
    }
  }

  const varOfBlock = new Map<string, string>();
  for (const n of graph.nodes) {
    const v = outputVarOf((n.data ?? {}) as Record<string, unknown>);
    if (v) varOfBlock.set(n.id, v);
  }

  for (const st of steps) {
    statusByBlock.set(st.block_id, st.status);
    const v = varOfBlock.get(st.block_id);
    if (v && st.status === "succeeded") values[v] = st.output;
    lines.push({
      id: `s${st.id}`,
      at: st.finished_at ?? st.started_at,
      blockId: st.block_id,
      status: st.status,
      position: st.position,
      title: st.label || labelOfBlock(graph, st.block_id) || st.block_kind,
      hint: st.block_kind,
      detail: { entrée: st.input, sortie: st.output },
      error: st.error_message,
      ms: st.finished_at ? new Date(st.finished_at).getTime() - new Date(st.started_at).getTime() : null,
    });
  }

  if (run.error_message) {
    lines.push({
      id: "run-error", at: run.finished_at ?? run.started_at, status: "failed",
      title: "L'exécution s'est arrêtée", error: run.error_message,
    });
  }
  if (run.status === "stopped") {
    lines.push({
      id: "run-stopped", at: run.finished_at ?? run.started_at, status: "info",
      title: "Arrêté par une condition",
      hint: "Ce n'est pas un échec : le filtre a fait son travail.",
    });
  }

  return {
    lines, statusByBlock, values,
    trigger: run.trigger_payload ?? null,
    live: run.status === "running",
  };
}

/** Le journal d'une procédure : ce que l'agent a fait, dans l'ordre. */
function fromEvents(events: RunEvent[], run: WorkflowRun): RunLog {
  const lines: LogLine[] = [];
  const pendingCall = new Map<string, number>();

  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (ev.kind === "tool_call") {
      const tool = String(p.tool ?? p.name ?? "outil");
      pendingCall.set(tool, lines.length);
      lines.push({
        id: ev.id, at: ev.created_at, status: "running",
        title: tool, hint: "appel d'outil",
        detail: p.args ?? p.arguments ?? {},
      });
    } else if (ev.kind === "tool_result") {
      const tool = String(p.tool ?? "");
      const at = pendingCall.get(tool);
      const preview = String(p.preview ?? "");
      const ok = p.ok !== false && !preview.startsWith("ERROR");
      if (at != null) {
        lines[at] = {
          ...lines[at],
          status: ok ? "succeeded" : "failed",
          detail: { arguments: lines[at].detail, résultat: preview },
          error: ok ? null : preview.slice(0, 600),
        };
        pendingCall.delete(tool);
      } else {
        lines.push({ id: ev.id, at: ev.created_at, status: ok ? "succeeded" : "failed", title: tool || "résultat", detail: preview });
      }
    } else if (ev.kind === "error") {
      lines.push({
        id: ev.id, at: ev.created_at, status: "failed",
        title: "Erreur", error: String(p.error ?? p.message ?? "").slice(0, 600),
      });
    } else if (ev.kind === "status" || ev.kind === "log") {
      const text = String(p.message ?? p.text ?? "").trim();
      if (text) lines.push({ id: ev.id, at: ev.created_at, status: "info", title: text.slice(0, 300) });
    }
  }

  if (run.error_message) {
    lines.push({
      id: "run-error", at: run.finished_at ?? run.started_at, status: "failed",
      title: "L'exécution s'est arrêtée", error: run.error_message,
    });
  }

  return {
    lines, statusByBlock: new Map(), values: {},
    trigger: run.trigger_payload ?? null,
    live: run.status === "running",
  };
}

function labelOfBlock(graph: Graph, blockId: string): string {
  const n = graph.nodes.find((x) => x.id === blockId);
  return String((n?.data as Record<string, unknown> | undefined)?.label ?? "").trim();
}

// ── L'écran ──────────────────────────────────────────────────────────────────

const DOT: Record<string, string> = {
  running: "bg-sky-400 animate-pulse",
  succeeded: "bg-emerald-500",
  failed: "bg-red-500",
  skipped: "bg-muted-foreground/40",
  info: "bg-muted-foreground/60",
};

export function RunConsole({
  ctx, run, log, open, onOpenChange, onTest, onCancel, busy, canRun,
}: {
  ctx: Ctx;
  run: WorkflowRun | null;
  log: RunLog;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Lance une exécution avec la charge de déclenchement donnée. */
  onTest: (payload: Record<string, unknown>) => void;
  onCancel: () => void;
  busy: boolean;
  canRun: boolean;
}) {
  const [tab, setTab] = useState<"log" | "vars">("log");
  const [tall, setTall] = useState(false);
  const [payloadOpen, setPayloadOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const count = log.lines.length;

  // Suivre le fil pendant qu'il s'écrit. Seulement quand ça tourne : sur un run
  // terminé, l'écran doit rester où on l'a laissé.
  useEffect(() => {
    if (!log.live || !open) return;
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [count, log.live, open]);

  const failed = log.lines.filter((l) => l.status === "failed").length;

  return (
    <div className="shrink-0 border-t border-border/70 bg-background">
      <div className="flex h-10 items-center gap-2 px-3">
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />}
          <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[12.5px] font-medium">Logs</span>
          {run ? (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className={cn("h-1.5 w-1.5 rounded-full", DOT[log.live ? "running" : run.status === "succeeded" ? "succeeded" : run.status === "failed" ? "failed" : "info"])} />
              {log.live ? "en cours" : runLabel(run.status)}
              {count > 0 && <> · {count} ligne{count > 1 ? "s" : ""}</>}
              {failed > 0 && <span className="text-red-500"> · {failed} en échec</span>}
              <> · {new Date(run.started_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</>
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">aucune exécution — lancez un test</span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setPayloadOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
          title="Choisir la donnée de déclenchement du test"
        >
          <Flask className="h-3.5 w-3.5" /> Donnée de test
        </button>

        {log.live ? (
          <Button size="sm" variant="outline" className="h-7" onClick={onCancel} disabled={busy}>
            <Square className="mr-1.5 h-3 w-3" /> Arrêter
          </Button>
        ) : (
          <Button
            size="sm" variant="outline" className="h-7"
            disabled={busy || !canRun}
            title={canRun ? "Exécuter maintenant" : "Ajoutez au moins un bloc"}
            onClick={() => { onOpenChange(true); onTest(readPayload(ctx.workflowId)); }}
          >
            {busy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Play className="mr-1.5 h-3 w-3" />} Tester
          </Button>
        )}

        {open && (
          <button type="button" onClick={() => setTall((v) => !v)}
            className="rounded-lg p-1 text-muted-foreground hover:bg-muted" title={tall ? "Réduire" : "Agrandir"}>
            {tall ? <Collapse className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {payloadOpen && (
        <PayloadEditor ctx={ctx} onClose={() => setPayloadOpen(false)} onRun={(p) => { setPayloadOpen(false); onOpenChange(true); onTest(p); }} />
      )}

      {open && (
        <div className={cn("flex flex-col border-t border-border/60", tall ? "h-[60vh]" : "h-[248px]")}>
          <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
            <Tab active={tab === "log"} onClick={() => setTab("log")} icon={Terminal} label="Journal" />
            <Tab active={tab === "vars"} onClick={() => setTab("vars")} icon={Braces} label="Variables" count={ctx.vars.length} />
          </div>

          {tab === "log" ? (
            <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {log.lines.length === 0 ? (
                <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">
                  {log.live ? "L'exécution démarre…" : "Rien à montrer. Lancez un test pour voir chaque étape s'écrire ici."}
                </p>
              ) : (
                <div className="space-y-0.5">
                  {log.lines.map((l) => <LogRow key={l.id} line={l} onFocus={() => l.blockId && ctx.setOpenBlock(l.blockId)} />)}
                </div>
              )}
            </div>
          ) : (
            <VariablesTab ctx={ctx} log={log} />
          )}
        </div>
      )}
    </div>
  );
}

const runLabel = (s: string) => (
  s === "succeeded" ? "réussi" : s === "failed" ? "en échec"
    : s === "cancelled" ? "annulé" : s === "stopped" ? "arrêté par une condition" : s
);

function Tab({ active, onClick, icon: Icon, label, count }: {
  active: boolean; onClick: () => void; icon: typeof Terminal; label: string; count?: number;
}) {
  return (
    <button
      type="button" onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] transition-colors",
        active ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50",
      )}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
      {count != null && count > 0 && <span className="text-[10px] text-muted-foreground">{count}</span>}
    </button>
  );
}

function LogRow({ line, onFocus }: { line: LogLine; onFocus: () => void }) {
  const [open, setOpen] = useState(false);
  const hasDetail = line.detail !== undefined && line.detail !== null;

  return (
    <div className={cn("rounded-lg", line.status === "failed" && "bg-red-500/5")}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={() => hasDetail && setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {hasDetail
            ? <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
            : <span className="w-3 shrink-0" />}
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT[line.status])} />
          <span className="w-8 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {line.position != null ? String(line.position).padStart(2, "0") : new Date(line.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px]">{line.title}</span>
          {line.hint && <span className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline">{line.hint}</span>}
          {line.ms != null && (
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
              {line.ms < 1000 ? `${line.ms} ms` : `${(line.ms / 1000).toFixed(1)} s`}
            </span>
          )}
        </button>
        {line.blockId && (
          <button type="button" onClick={onFocus}
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground">
            voir le bloc
          </button>
        )}
      </div>
      {line.error && (
        <p className="px-2 pb-1.5 pl-[3.4rem] text-[11px] leading-relaxed text-red-600 dark:text-red-400">{line.error}</p>
      )}
      {open && hasDetail && (
        <pre className="mx-2 mb-2 max-h-60 overflow-auto rounded-lg bg-muted/50 p-2.5 font-mono text-[10px] leading-relaxed">
          {safeJson(line.detail)}
        </pre>
      )}
    </div>
  );
}

const safeJson = (v: unknown) => {
  try { return typeof v === "string" ? v : JSON.stringify(v, null, 2); }
  catch { return String(v); }
};

// ── Les variables, vues par le run ───────────────────────────────────────────

function VariablesTab({ ctx, log }: { ctx: Ctx; log: RunLog }) {
  const declared = useMemo(() => {
    const out: Array<{ name: string; value: string; from: string; secret?: boolean }> = [];
    for (const n of ctx.graph.nodes) {
      if (n.type !== "variables" && n.type !== "set") continue;
      const where = n.type === "set"
        ? String((n.data as Record<string, unknown>)?.label ?? "").trim() || "posée en cours de chaîne"
        : "déclarée";
      for (const v of varsOf((n.data ?? {}) as Record<string, unknown>)) {
        const name = normalizeVarName(v.name);
        if (name) out.push({ name, value: String(v.value ?? ""), from: where, secret: v.secret });
      }
    }
    return out;
  }, [ctx.graph]);

  const produced = useMemo(() => {
    const out: Array<{ name: string; from: string; blockId: string }> = [];
    for (const n of ctx.graph.nodes) {
      const v = outputVarOf((n.data ?? {}) as Record<string, unknown>);
      if (!v) continue;
      out.push({ name: v, from: String((n.data as Record<string, unknown>)?.label ?? n.type ?? "bloc"), blockId: n.id });
    }
    return out;
  }, [ctx.graph]);

  const copy = (name: string) => {
    navigator.clipboard?.writeText(`{{${name}}}`).catch(() => {});
  };

  const trigger = log.trigger && Object.keys(log.trigger).length ? log.trigger : null;

  if (!declared.length && !produced.length && !trigger) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <p className="text-center text-[12px] text-muted-foreground">
          Aucune variable. Ajoutez un bloc « Variables » pour poser des valeurs réutilisables,
          ou nommez la sortie d'une action pour que la suivante s'y réfère.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <table className="w-full table-fixed">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="w-44 px-2 py-1 text-left font-medium">Nom</th>
            <th className="px-2 py-1 text-left font-medium">Valeur</th>
            <th className="w-40 px-2 py-1 text-left font-medium">D'où elle vient</th>
          </tr>
        </thead>
        <tbody>
          {trigger && (
            <VarRow
              name="trigger" from="reçue au déclenchement"
              value={safeJson(trigger)}
              onCopy={() => navigator.clipboard?.writeText("{{trigger.}}").catch(() => {})}
            />
          )}
          {declared.map((v) => (
            <VarRow
              key={`d-${v.name}`} name={v.name} from={v.from}
              value={v.secret ? "••••••" : v.value || "(vide)"}
              onCopy={() => copy(v.name)}
            />
          ))}
          {produced.map((v) => {
            const value = log.values[v.name];
            return (
              <VarRow
                key={`p-${v.name}-${v.blockId}`} name={v.name} from={v.from}
                value={value === undefined ? "— pas encore produite" : safeJson(value)}
                pending={value === undefined}
                onCopy={() => copy(v.name)}
                onFocus={() => ctx.setOpenBlock(v.blockId)}
              />
            );
          })}
        </tbody>
      </table>
      <p className="px-2 pt-2 text-[10.5px] leading-relaxed text-muted-foreground">
        Écrivez <code className="rounded bg-muted px-1 font-mono">{"{{nom}}"}</code> dans n'importe quel champ pour insérer la valeur.
        La donnée du déclencheur se lit avec <code className="rounded bg-muted px-1 font-mono">{"{{trigger.…}}"}</code>.
      </p>
    </div>
  );
}

function VarRow({ name, value, from, pending, onCopy, onFocus }: {
  name: string; value: string; from: string; pending?: boolean;
  onCopy: () => void; onFocus?: () => void;
}) {
  return (
    <tr className="border-t border-border/40 align-top">
      <td className="px-2 py-1.5">
        <button type="button" onClick={onCopy} title="Copier {{nom}}"
          className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted">
          {name}
        </button>
      </td>
      <td className={cn("px-2 py-1.5 font-mono text-[11px]", pending && "text-muted-foreground")}>
        <div className="max-h-16 overflow-y-auto whitespace-pre-wrap break-words">{value}</div>
      </td>
      <td className="px-2 py-1.5 text-[11px] text-muted-foreground">
        {onFocus ? (
          <button type="button" onClick={onFocus} className="truncate hover:text-foreground hover:underline">{from}</button>
        ) : from}
      </td>
    </tr>
  );
}

// ── La donnée de test ────────────────────────────────────────────────────────

const payloadKey = (id: string) => `wf-test-payload-${id}`;

export function readPayload(workflowId: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(payloadKey(workflowId));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch { return {}; }
}

/**
 * Ce qu'un vrai déclencheur aurait apporté.
 *
 * Sans elle, un test n'éprouve que la moitié d'un workflow — celle qui ne lit
 * rien de `{{trigger.…}}` — et la première exécution réelle découvre l'autre.
 * Le brouillon est gardé par workflow : on teste vingt fois d'affilée en
 * changeant une valeur, et retaper la charge à chaque fois est le meilleur
 * moyen de ne plus tester du tout.
 */
function PayloadEditor({ ctx, onClose, onRun }: {
  ctx: Ctx; onClose: () => void; onRun: (p: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(() => {
    const stored = readPayload(ctx.workflowId);
    if (Object.keys(stored).length) return JSON.stringify(stored, null, 2);
    // Amorcée avec les entrées déclarées : le premier test ne commence pas
    // devant une page blanche dont personne ne connaît la forme attendue.
    const seed: Record<string, unknown> = {};
    for (const n of ctx.graph.nodes) {
      if (n.type !== "input") continue;
      const params = Array.isArray((n.data as Record<string, unknown>)?.params)
        ? ((n.data as Record<string, unknown>).params as Array<{ name?: string }>)
        : [];
      for (const p of params) if (p?.name?.trim()) seed[p.name.trim()] = "";
    }
    return JSON.stringify(seed, null, 2);
  });
  const [error, setError] = useState<string | null>(null);

  const parse = (): Record<string, unknown> | null => {
    const raw = text.trim();
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("La charge doit être un objet JSON — { \"clé\": \"valeur\" }.");
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch (e) {
      setError(e instanceof Error ? e.message : "JSON invalide");
      return null;
    }
  };

  return (
    <div className="border-t border-border/60 bg-muted/20 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Flask className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[12px] font-medium">Donnée de déclenchement</span>
        <span className="text-[11px] text-muted-foreground">
          lue par <code className="rounded bg-muted px-1 font-mono text-[10px]">{"{{trigger.…}}"}</code>
        </span>
        <button type="button" onClick={onClose} className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setError(null); }}
        rows={6}
        spellCheck={false}
        className="w-full resize-y rounded-lg border border-input bg-background p-2.5 font-mono text-[11px] leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
        placeholder={'{\n  "from": "client@exemple.fr",\n  "subject": "Demande de devis"\n}'}
      />
      {error && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm" className="h-7"
          onClick={() => {
            const p = parse();
            if (!p) return;
            try { localStorage.setItem(payloadKey(ctx.workflowId), JSON.stringify(p)); } catch { /* sans mémoire, le test marche quand même */ }
            onRun(p);
          }}
        >
          <Play className="mr-1.5 h-3 w-3" /> Lancer avec cette donnée
        </Button>
        <Button
          size="sm" variant="ghost" className="h-7 text-[12px]"
          onClick={() => {
            const p = parse();
            if (!p) return;
            try { localStorage.setItem(payloadKey(ctx.workflowId), JSON.stringify(p)); } catch { /* idem */ }
            onClose();
          }}
        >
          Enregistrer seulement
        </Button>
      </div>
    </div>
  );
}
