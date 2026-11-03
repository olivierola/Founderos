import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleNotchIcon as Loader2,
  ArrowCounterClockwiseIcon as Undo,
  CheckIcon as Check,
  XIcon as X,
  CaretDownIcon as ChevronDown,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { InternalAgent } from "./shared";

/**
 * Le journal d'auto-apprentissage (0288) : chaque remarque de l'utilisateur
 * que le système a lue comme une correction, la leçon qu'il en a tirée, et le
 * fichier qu'il a touché. Une ligne apparue toute seule dans des instructions
 * écrites par un humain doit pouvoir s'expliquer et s'annuler — c'est tout
 * l'objet de cet écran.
 */

type Mode = "off" | "suggest" | "auto";
type Status = "applied" | "proposed" | "rejected" | "reverted" | "skipped";

interface Learning {
  id: string;
  source: "chat" | "room";
  feedback: string;
  agent_output: string | null;
  kind: string | null;
  target_file: "instructions" | "soul" | "preferences";
  lesson: string;
  rationale: string | null;
  confidence: number | null;
  patch: { op?: string; find?: string; replace?: string };
  status: Status;
  detail: string | null;
  created_at: string;
}

const MODES: Array<{ key: Mode; label: string; blurb: string }> = [
  { key: "auto", label: "Automatique", blurb: "Applique les corrections sûres, propose les autres." },
  { key: "suggest", label: "Suggestion", blurb: "Propose chaque correction, vous l'appliquez." },
  { key: "off", label: "Désactivé", blurb: "Les remarques ne modifient jamais les fichiers." },
];

const STATUS: Record<Status, { label: string; tone: string }> = {
  applied: { label: "Appliquée", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  proposed: { label: "À valider", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-500" },
  rejected: { label: "Rejetée", tone: "bg-muted text-muted-foreground" },
  reverted: { label: "Annulée", tone: "bg-muted text-muted-foreground" },
  skipped: { label: "Non appliquée", tone: "bg-muted text-muted-foreground" },
};

const FILE: Record<Learning["target_file"], string> = {
  instructions: "instructions.md", soul: "soul.md", preferences: "preferences.md",
};

export function AgentLearnings({ agent, onFilesChanged }: {
  agent: InternalAgent;
  /** A decision rewrote a file: the editor must pick up the new text. */
  onFilesChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>(agent.self_learning ?? "auto");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["agent_learnings", agent.id],
    queryFn: async () => {
      const { data, error: err } = await supabase.from("internal_agent_learnings")
        .select("id, source, feedback, agent_output, kind, target_file, lesson, rationale, confidence, patch, status, detail, created_at")
        .eq("agent_id", agent.id).order("created_at", { ascending: false }).limit(100);
      if (err) throw err;
      return (data ?? []) as Learning[];
    },
  });

  async function changeMode(next: Mode) {
    const prev = mode;
    setMode(next);
    setError(null);
    const { error: err } = await supabase.from("internal_agents").update({ self_learning: next }).eq("id", agent.id);
    if (err) { setMode(prev); setError(err.message); return; }
    queryClient.invalidateQueries({ queryKey: ["internal_agent", agent.id] });
  }

  async function decide(id: string, action: "apply" | "revert" | "reject") {
    setBusy(id);
    setError(null);
    const { error: err } = await supabase.rpc("agent_learning_decide", { p_learning: id, p_action: action });
    setBusy(null);
    if (err) { setError(err.message); return; }
    queryClient.invalidateQueries({ queryKey: ["agent_learnings", agent.id] });
    if (action !== "reject") onFilesChanged();
  }

  const pending = rows.filter((r) => r.status === "proposed").length;

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col">
      <div className="pb-3">
        <h2 className="text-base font-semibold">Apprentissage</h2>
        <p className="text-xs text-muted-foreground">
          Quand vous reprenez {agent.name} sur ce qu'il vient de faire, il en tire une leçon et corrige le fichier
          qui aurait dû l'éviter. Chaque correction est listée ici et s'annule en un clic.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => void changeMode(m.key)}
            title={m.blurb}
            className={cn(
              "rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors",
              m.key === mode ? "border-foreground/30 bg-secondary text-foreground" : "border-transparent text-muted-foreground hover:bg-secondary/60",
            )}
          >
            <span className="font-medium">{m.label}</span>
            <span className="ml-1.5 hidden text-muted-foreground sm:inline">{m.blurb}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
      )}
      {pending > 0 && (
        <p className="mb-2 text-xs text-amber-700 dark:text-amber-500">
          {pending} correction{pending > 1 ? "s" : ""} en attente de validation.
        </p>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {isLoading && <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />}
        {!isLoading && rows.length === 0 && (
          <p className="pt-8 text-center text-xs text-muted-foreground">
            Aucune leçon pour l'instant. Dites-lui simplement ce qui n'allait pas (« tu as oublié de joindre le devis »,
            « la prochaine fois, passe par le CRM ») : la correction apparaîtra ici.
          </p>
        )}
        {rows.map((r) => {
          const expanded = open === r.id;
          return (
            <div key={r.id} className="rounded-lg border px-3 py-2.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className={cn("rounded px-1.5 py-0.5 font-medium", STATUS[r.status].tone)}>{STATUS[r.status].label}</span>
                    <span className="font-mono">{FILE[r.target_file]}</span>
                    <span>· {r.source === "room" ? "room" : "chat"}</span>
                    {r.confidence != null && <span>· confiance {Math.round(r.confidence * 100)} %</span>}
                    <span>· {new Date(r.created_at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</span>
                  </div>
                  <p className="mt-1 text-sm">{r.lesson}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">Remarque : « {r.feedback} »</p>
                  {r.detail && <p className="mt-0.5 text-xs text-muted-foreground">{r.detail}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {r.status === "proposed" && (
                    <>
                      <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => void decide(r.id, "reject")}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" disabled={busy === r.id} onClick={() => void decide(r.id, "apply")}>
                        {busy === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        <span className="ml-1">Appliquer</span>
                      </Button>
                    </>
                  )}
                  {r.status === "applied" && (
                    <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => void decide(r.id, "revert")}>
                      {busy === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo className="h-3.5 w-3.5" />}
                      <span className="ml-1">Annuler</span>
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : r.id)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
                    title="Détail"
                  >
                    <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
                  </button>
                </div>
              </div>
              {expanded && (
                <div className="mt-2 space-y-2 border-t pt-2 text-xs">
                  {r.rationale && <p className="text-muted-foreground">{r.rationale}</p>}
                  {r.patch?.replace != null && (
                    <div className="space-y-1 font-mono">
                      {r.patch.find ? (
                        <pre className="whitespace-pre-wrap rounded bg-red-500/5 px-2 py-1 text-red-700 dark:text-red-400">- {r.patch.find.slice(-600)}</pre>
                      ) : null}
                      <pre className="whitespace-pre-wrap rounded bg-emerald-500/5 px-2 py-1 text-emerald-700 dark:text-emerald-400">+ {r.patch.replace.slice(-600)}</pre>
                    </div>
                  )}
                  {r.agent_output && (
                    <p className="line-clamp-4 text-muted-foreground">Réponse de l'agent : {r.agent_output}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
