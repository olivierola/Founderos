import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Route, Loader2, ArrowRight, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { formatCompact, cn } from "@/lib/utils";

interface ActivityEvent {
  id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

const STORAGE_KEY = "founderos.user-journey-steps";

function loadSteps(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function saveSteps(steps: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(steps));
  } catch {
    // ignore
  }
}

export function UserJourneysPage() {
  const { projectId } = useCurrentContext();
  const [steps, setSteps] = useState<string[]>(() => loadSteps());
  const [draft, setDraft] = useState("");

  function addStep() {
    if (!draft.trim()) return;
    const next = [...steps, draft.trim()];
    setSteps(next);
    saveSteps(next);
    setDraft("");
  }

  function removeStep(i: number) {
    const next = steps.filter((_, idx) => idx !== i);
    setSteps(next);
    saveSteps(next);
  }

  // Fetch enough events to compute the funnel.
  const { data: events, isLoading } = useQuery({
    queryKey: ["journey_events", projectId],
    enabled: !!projectId && steps.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("activity_logs")
        .select("id, event_type, payload, created_at")
        .eq("project_id", projectId!)
        .in("event_type", steps)
        .order("created_at", { ascending: true })
        .limit(5000);
      return (data ?? []) as ActivityEvent[];
    },
  });

  // List of available event types from a sample to help the user.
  const { data: knownTypes } = useQuery({
    queryKey: ["known_event_types", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("activity_logs")
        .select("event_type")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(2000);
      const set = new Set((data ?? []).map((e: { event_type: string | null }) => e.event_type).filter(Boolean));
      return Array.from(set).sort() as string[];
    },
  });

  // Compute funnel: per actor (best-effort by payload.user_id / actor_user_id),
  // count those who reached each step in order.
  const funnel = useMemo(() => {
    if (!events || steps.length === 0) return [];
    // Group events by actor key.
    const byActor = new Map<string, ActivityEvent[]>();
    events.forEach((e) => {
      const p = e.payload ?? {};
      const actor =
        (p as any).user_id ?? (p as any).actor_user_id ?? (p as any).customer_id ?? (p as any).email ?? null;
      if (!actor) return;
      const arr = byActor.get(String(actor)) ?? [];
      arr.push(e);
      byActor.set(String(actor), arr);
    });

    const reach = steps.map(() => 0);
    byActor.forEach((evs) => {
      let cursor = 0;
      // events are ascending in time; walk through and advance through steps.
      for (const ev of evs) {
        if (ev.event_type === steps[cursor]) {
          reach[cursor] += 1;
          cursor += 1;
          if (cursor >= steps.length) break;
        }
      }
    });

    return steps.map((step, i) => ({
      step,
      count: reach[i],
      conversionFromPrev: i === 0 ? 1 : reach[i - 1] > 0 ? reach[i] / reach[i - 1] : 0,
      conversionFromStart: reach[0] > 0 ? reach[i] / reach[0] : 0,
    }));
  }, [events, steps]);

  return (
    <div>
      <PageHeader
        title="User journeys"
        description="Build a funnel from any activity event sequence to see where users drop off."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        {/* Funnel viz */}
        <Card>
          <CardContent className="p-5">
            {steps.length === 0 ? (
              <EmptyState
                icon={Route}
                title="Define a journey"
                description="Add event types one by one to build your funnel."
              />
            ) : isLoading ? (
              <EmptyState icon={Loader2} title="Computing funnel…" />
            ) : funnel.length === 0 || funnel[0].count === 0 ? (
              <EmptyState
                icon={Route}
                title="No matching events"
                description="Make sure the event names match your activity_logs.event_type values."
              />
            ) : (
              <div className="space-y-3">
                {funnel.map((f, i) => {
                  const widthPct = funnel[0].count > 0 ? (f.count / funnel[0].count) * 100 : 0;
                  return (
                    <div key={f.step} className="space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold">
                            {i + 1}
                          </span>
                          <span className="font-mono text-xs">{f.step}</span>
                        </div>
                        <div className="flex items-center gap-3 text-xs tabular-nums">
                          <span className="font-semibold">{formatCompact(f.count)}</span>
                          {i > 0 && (
                            <span
                              className={cn(
                                f.conversionFromPrev > 0.5
                                  ? "text-[hsl(var(--accent-2))]"
                                  : f.conversionFromPrev > 0.2
                                    ? "text-amber-400"
                                    : "text-destructive",
                              )}
                            >
                              {(f.conversionFromPrev * 100).toFixed(0)}% from prev
                            </span>
                          )}
                          {i > 0 && (
                            <span className="text-muted-foreground">
                              {(f.conversionFromStart * 100).toFixed(0)}% overall
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="h-6 w-full overflow-hidden rounded bg-secondary">
                        <div
                          className="h-full rounded bg-[hsl(var(--primary-soft))] transition-all"
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Step editor */}
        <Card>
          <CardContent className="space-y-3 p-5">
            <div>
              <h3 className="text-sm font-semibold">Journey steps</h3>
              <p className="text-xs text-muted-foreground">
                In order. Each step is an activity_logs.event_type.
              </p>
            </div>

            <div className="space-y-1.5">
              {steps.map((s, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-md border border-border bg-secondary/30 px-2.5 py-1.5"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-secondary text-[9px] font-semibold">
                      {i + 1}
                    </span>
                    <span className="font-mono">{s}</span>
                  </div>
                  <button
                    onClick={() => removeStep(i)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex gap-1.5">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addStep()}
                placeholder="user.signup"
                className="text-xs"
                list="known-event-types"
              />
              <Button size="sm" onClick={addStep} disabled={!draft.trim()}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
              <datalist id="known-event-types">
                {(knownTypes ?? []).map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>

            {(knownTypes ?? []).length > 0 && (
              <div className="space-y-1.5 pt-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Suggested events
                </div>
                <div className="flex flex-wrap gap-1">
                  {(knownTypes ?? []).slice(0, 12).map((t) => (
                    <Badge
                      key={t}
                      variant="outline"
                      className="cursor-pointer text-[10px]"
                      onClick={() => setDraft(t)}
                    >
                      {t}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <p className="pt-2 text-[10px] text-muted-foreground">
              Funnel is computed by linking events via <code>payload.user_id</code>,{" "}
              <code>actor_user_id</code>, <code>customer_id</code> or <code>email</code>.
              <ArrowRight className="ml-1 inline h-3 w-3" />
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
