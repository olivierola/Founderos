// AgentActivityOrb — the dotted "thinking orb" (thinking-orbs) that shows what
// kind of work a live agent is doing: searching, composing, wiring an
// integration… The state comes from the run's latest event (see
// orbStateForRun in runEventMeta), so the animation changes as the agent moves
// from one tool family to the next.
//
// The library ships exactly two tuned sizes (20 = inline text, 64 = avatar);
// anything else snaps to the nearer one. Theme is `auto`: it follows the
// `data-theme` attribute on <html>, like the rest of the app.
import { useQuery } from "@tanstack/react-query";
import { ThinkingOrb } from "thinking-orbs";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { orbStateForRun, ORB_STATE_LABEL, type AgentOrbState } from "./runEventMeta";

export function AgentActivityOrb({ state, size = 20, className, label }: {
  state: AgentOrbState;
  size?: number;
  className?: string;
  /** Accessible label; defaults to the per-state French verb. */
  label?: string;
}) {
  const preset = size >= 42 ? 64 : 20;
  return (
    <ThinkingOrb
      state={state}
      size={preset}
      aria-label={label ?? `L'agent ${ORB_STATE_LABEL[state]}`}
      className={cn("shrink-0", className)}
      style={{ width: preset, height: preset }}
    />
  );
}

const SIGNIFICANT_KINDS = ["tool_call", "question", "loop", "todos"];

/** Orb state for a run the caller doesn't already hold events for. Reads the
 *  run status + its latest significant event, polling while `enabled`. */
export function useRunOrbState(runId: string | null | undefined, enabled = true): AgentOrbState {
  const { data } = useQuery({
    queryKey: ["run_orb_state", runId],
    enabled: !!runId && enabled,
    refetchInterval: enabled ? 2500 : false,
    queryFn: async () => {
      const [{ data: run }, { data: ev }] = await Promise.all([
        supabase.from("internal_agent_runs").select("status").eq("id", runId!).maybeSingle(),
        supabase
          .from("internal_agent_run_events")
          .select("kind, payload")
          .eq("run_id", runId!)
          .in("kind", SIGNIFICANT_KINDS)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      return orbStateForRun((run as { status?: string } | null)?.status, ev as { kind: string; payload: any } | null);
    },
  });
  return data ?? "breathing";
}
