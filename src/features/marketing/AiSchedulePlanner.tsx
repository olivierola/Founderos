import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Sparkles, Loader2, CalendarClock, Trash2, AlertTriangle, Check, Wand2,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";

// A planned post returned by the edge (plan mode), made editable client-side.
interface PlanItem {
  platform: string;
  content: string;
  hashtags: string[];
  cta: string | null;
  objective: string;
  tone: string;
  scheduled_at: string; // ISO, may be "" when the model failed to resolve a date
  scheduled_invalid?: boolean;
}

const EXAMPLES = [
  "Programme 3 posts LinkedIn cette semaine, lundi mercredi vendredi à 9h, sur nos dernières fonctionnalités.",
  "Un tweet demain à 18h pour annoncer notre lancement.",
  "Publie chaque lundi pendant 4 semaines un post éducatif sur Twitter à 10h.",
];

const PLATFORM_DOT: Record<string, string> = {
  twitter: "bg-sky-400", x: "bg-sky-400", linkedin: "bg-blue-500",
  instagram: "bg-pink-400", facebook: "bg-indigo-400", threads: "bg-zinc-400", mastodon: "bg-purple-400",
};

// Convert an ISO string to the value a <input type="datetime-local"> expects
// (local time, no timezone, minute precision).
function isoToLocalInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToIso(v: string): string {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

export function AiSchedulePlanner({
  open, onOpenChange, workspaceId, projectId, onScheduled,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string | null;
  projectId: string | null;
  onScheduled?: () => void;
}) {
  const queryClient = useQueryClient();
  const [instruction, setInstruction] = useState("");
  const [planning, setPlanning] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanItem[] | null>(null);
  const [done, setDone] = useState<number | null>(null);

  function reset() {
    setInstruction(""); setPlan(null); setNotes(null); setError(null); setDone(null);
  }

  async function generatePlan() {
    if (!workspaceId || !projectId || !instruction.trim()) return;
    setPlanning(true); setError(null); setDone(null);
    try {
      const res = await callEdge<{ notes: string | null; plan: PlanItem[]; platforms_available: string[] }>(
        "marketing-schedule-nl",
        {
          workspace_id: workspaceId,
          project_id: projectId,
          instruction: instruction.trim(),
          mode: "plan",
          timezone_offset_minutes: new Date().getTimezoneOffset(),
          language: "fr",
        },
      );
      setPlan(res.plan ?? []);
      setNotes(res.notes ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  }

  function update(i: number, patch: Partial<PlanItem>) {
    setPlan((p) => (p ? p.map((it, j) => (j === i ? { ...it, ...patch } : it)) : p));
  }
  function remove(i: number) {
    setPlan((p) => (p ? p.filter((_, j) => j !== i) : p));
  }

  const hasInvalid = (plan ?? []).some((p) => !p.scheduled_at || p.scheduled_invalid);

  async function confirmSchedule() {
    if (!workspaceId || !projectId || !plan || plan.length === 0) return;
    setScheduling(true); setError(null);
    try {
      // 1) Create the draft posts and get their ids + intended schedule times.
      const res = await callEdge<{ targets: { post_id: string; schedule_at: string | null }[] }>(
        "marketing-schedule-nl",
        {
          workspace_id: workspaceId,
          project_id: projectId,
          mode: "schedule",
          plan: plan.map(({ scheduled_invalid: _omit, ...p }) => p),
        },
      );
      const targets = res.targets ?? [];

      // 2) Schedule each post via the existing publish flow (Buffer/webhook).
      let ok = 0;
      const failures: string[] = [];
      for (const t of targets) {
        try {
          await callEdge("marketing-publish", {
            workspace_id: workspaceId,
            project_id: projectId,
            post_id: t.post_id,
            schedule_at: t.schedule_at,
          });
          ok++;
        } catch (e) {
          failures.push(e instanceof Error ? e.message : String(e));
        }
      }

      queryClient.invalidateQueries({ queryKey: ["mkt_posts", projectId] });
      onScheduled?.();

      if (ok === 0 && failures.length > 0) {
        // Posts were created as drafts but none could be scheduled (e.g. no
        // channel connected). Surface the reason; drafts remain in the calendar.
        setError(`Posts créés en brouillon mais non programmés : ${failures[0]}`);
      } else {
        if (failures.length > 0) {
          setError(`${failures.length} post(s) n'ont pas pu être programmé(s).`);
        }
        setDone(ok);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScheduling(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-h-[88vh] w-[calc(100vw-2rem)] max-w-2xl grid-cols-[minmax(0,1fr)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" /> Programmer avec l'IA
          </DialogTitle>
        </DialogHeader>

        {done != null ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[hsl(var(--accent-2)/0.15)]">
              <Check className="h-6 w-6 text-[hsl(var(--accent-2))]" />
            </div>
            <div>
              <p className="font-medium">{done} post{done > 1 ? "s" : ""} programmé{done > 1 ? "s" : ""}</p>
              <p className="mt-1 text-sm text-muted-foreground">Retrouvez-les dans le calendrier.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={reset}>Programmer d'autres posts</Button>
              <Button onClick={() => onOpenChange(false)}>Fermer</Button>
            </div>
          </div>
        ) : (
          <div className="min-w-0 space-y-4">
            {/* Instruction input */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Décrivez ce que vous voulez publier, et quand
              </label>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                rows={3}
                placeholder="Ex. Programme 3 posts LinkedIn lundi, mercredi et vendredi à 9h sur nos nouveautés…"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {!plan && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      onClick={() => setInstruction(ex)}
                      className="rounded-full border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    >
                      {ex.length > 52 ? ex.slice(0, 52) + "…" : ex}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between">
              <Button onClick={generatePlan} disabled={planning || !instruction.trim()}>
                {planning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {plan ? "Regénérer le plan" : "Générer le plan"}
              </Button>
              {plan && (
                <span className="text-xs text-muted-foreground">{plan.length} post{plan.length > 1 ? "s" : ""} planifié{plan.length > 1 ? "s" : ""}</span>
              )}
            </div>

            {error && (
              <p className="flex items-center gap-1.5 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" /> {error}
              </p>
            )}

            {notes && (
              <p className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                {notes}
              </p>
            )}

            {/* Plan preview / editor */}
            {plan && plan.length > 0 && (
              <div className="space-y-2">
                {plan.map((p, i) => {
                  const invalid = !p.scheduled_at || p.scheduled_invalid;
                  return (
                    <div
                      key={i}
                      className={cn(
                        "rounded-md border p-3",
                        invalid ? "border-destructive/50 bg-destructive/5" : "border-border",
                      )}
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className="flex items-center gap-1.5">
                          <span className={cn("h-2 w-2 rounded-full", PLATFORM_DOT[p.platform] ?? "bg-primary")} />
                          <select
                            value={p.platform}
                            onChange={(e) => update(i, { platform: e.target.value })}
                            className="rounded-md border border-input bg-background px-2 py-1 text-xs capitalize"
                          >
                            {["twitter", "linkedin", "facebook", "instagram", "threads", "mastodon"].map((pl) => (
                              <option key={pl} value={pl}>{pl}</option>
                            ))}
                          </select>
                        </span>
                        <Badge variant="outline" className="text-[10px]">{p.objective}</Badge>
                        <input
                          type="datetime-local"
                          value={isoToLocalInput(p.scheduled_at)}
                          onChange={(e) => update(i, { scheduled_at: localInputToIso(e.target.value), scheduled_invalid: false })}
                          className={cn(
                            "ml-auto h-8 rounded-md border bg-background px-2 text-xs",
                            invalid ? "border-destructive" : "border-input",
                          )}
                        />
                        <button onClick={() => remove(i)} className="text-muted-foreground hover:text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      <textarea
                        value={p.content}
                        onChange={(e) => update(i, { content: e.target.value })}
                        rows={3}
                        className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                      {p.hashtags.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {p.hashtags.map((h) => <span key={h} className="text-xs text-primary">#{h}</span>)}
                        </div>
                      )}
                      {invalid && (
                        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-destructive">
                          <AlertTriangle className="h-3 w-3" /> Date à préciser (doit être dans le futur).
                        </p>
                      )}
                    </div>
                  );
                })}

                <div className="flex items-center justify-between border-t border-border pt-3">
                  {hasInvalid && (
                    <span className="text-xs text-destructive">Corrigez les dates invalides avant de programmer.</span>
                  )}
                  <Button
                    className="ml-auto"
                    onClick={confirmSchedule}
                    disabled={scheduling || hasInvalid || plan.length === 0}
                  >
                    {scheduling ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />}
                    Programmer {plan.length} post{plan.length > 1 ? "s" : ""}
                  </Button>
                </div>
              </div>
            )}

            {plan && plan.length === 0 && (
              <p className="text-sm text-muted-foreground">Aucun post n'a pu être planifié. Reformulez votre demande.</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
