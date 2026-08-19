// AgentTerminalPanel — the agent's shell, live.
//
// An agent that has a runner or a sandbox spends part of its time executing
// commands. Those calls were only visible folded inside the run timeline, one
// truncated line each; this panel replays them as what they actually are: a
// terminal session, in order, with the real command and its real output,
// streaming while the agent works.
//
// Source of truth: `internal_agent_run_events` (tool_call paired with its
// tool_result), filtered to the execution tools. Nothing is stored for this
// view, so it also works on runs that finished days ago.
import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { AgentTerminal, type TerminalLine } from "@/components/ui/agent-terminal";
import { toolEnv, type RunEventRow } from "./runEventMeta";

interface RunRow {
  id: string;
  agent_id: string;
  status: string;
  triggered_via: string | null;
  created_at: string;
}

const ACTIVE = ["queued", "running", "awaiting_input"];

const STATUS_FR: Record<string, string> = {
  queued: "en file", running: "en cours", awaiting_input: "question posée",
  succeeded: "terminé", failed: "échec", cancelled: "annulé",
};

/** Strip the hybrid world prefix (runner_ / sandbox_) off a tool name. */
function baseTool(tool: string): string {
  if (tool.startsWith("runner_")) return tool.slice(7);
  if (tool.startsWith("sandbox_")) return tool.slice(8);
  return tool;
}

/**
 * The execution tools, and how each one reads as a command line. Only these
 * appear in the terminal — a browser action or a memory write is not a command,
 * and the run timeline already covers them.
 */
const COMMAND_TOOLS: Record<string, (a: Record<string, any>) => string> = {
  shell_exec: (a) => String(a.command ?? ""),
  run_background: (a) => `${String(a.command ?? "")} &`,
  python_exec: (a) => `python - <<'PY'\n${String(a.code ?? "")}\nPY`,
  nodejs_exec: (a) => `node - <<'JS'\n${String(a.code ?? "")}\nJS`,
  jupyter_exec: (a) => `jupyter run <<'PY'\n${String(a.code ?? "")}\nPY`,
  list_processes: () => "list_processes",
  process_logs: (a) => `process_logs ${String(a.proc_id ?? "")}`,
  process_stop: (a) => `process_stop ${String(a.proc_id ?? "")}`,
  machine_info: () => "machine_info",
};

function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
}

export function AgentTerminalPanel({
  agents, runLimit = 6, onCommand, className,
}: {
  /** The agents this terminal watches — one (a chat) or several (a room). */
  agents: { id: string; name: string }[];
  runLimit?: number;
  /** Wired by the host: hands a typed command to the agent to execute. */
  onCommand?: (command: string) => Promise<string | void>;
  className?: string;
}) {
  const qc = useQueryClient();
  const agentIds = agents.map((a) => a.id);
  const nameOf = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);
  const key = agentIds.slice().sort().join(",");

  const { data: runs } = useQuery({
    queryKey: ["agent_terminal_runs", key, runLimit],
    enabled: agentIds.length > 0,
    refetchInterval: 5000,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_runs")
        .select("id, agent_id, status, triggered_via, created_at")
        .in("agent_id", agentIds)
        .order("created_at", { ascending: false })
        .limit(runLimit);
      return (data ?? []) as RunRow[];
    },
  });

  const runIds = (runs ?? []).map((r) => r.id);
  const anyActive = (runs ?? []).some((r) => ACTIVE.includes(r.status));

  const { data: events } = useQuery({
    queryKey: ["agent_terminal_events", runIds.join(",")],
    enabled: runIds.length > 0,
    // Newest-first + reverse: on a long run the terminal must keep the LAST
    // commands, not the first ones.
    refetchInterval: anyActive ? 2500 : false,
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_run_events")
        .select("id, run_id, kind, payload, created_at")
        .in("run_id", runIds)
        .in("kind", ["tool_call", "tool_result"])
        .order("created_at", { ascending: false })
        .limit(400);
      return ((data ?? []) as RunEventRow[]).slice().reverse();
    },
  });

  const lines = useMemo<TerminalLine[]>(() => {
    const runById = new Map((runs ?? []).map((r) => [r.id, r]));
    // Pair each execution tool_call with the tool_result that follows it in the
    // SAME run (events of concurrent runs interleave).
    const perRun = new Map<string, RunEventRow[]>();
    for (const ev of events ?? []) {
      const arr = perRun.get(ev.run_id);
      if (arr) arr.push(ev);
      else perRun.set(ev.run_id, [ev]);
    }

    const out: Array<TerminalLine & { runId: string }> = [];
    for (const [runId, evs] of perRun) {
      const run = runById.get(runId);
      const live = run ? ACTIVE.includes(run.status) : false;
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        if (ev.kind !== "tool_call") continue;
        const tool = String(ev.payload?.tool ?? ev.payload?.name ?? "");
        const render = COMMAND_TOOLS[baseTool(tool)];
        if (!render) continue;
        const args = (ev.payload?.args ?? ev.payload?.arguments ?? {}) as Record<string, any>;

        let output: string | undefined;
        let ok: boolean | undefined;
        for (let j = i + 1; j < evs.length; j++) {
          if (evs[j].kind === "tool_call") break;
          if (evs[j].kind === "tool_result" && String(evs[j].payload?.tool ?? "") === tool) {
            output = String(evs[j].payload?.preview ?? "");
            ok = evs[j].payload?.ok !== false && !output.startsWith("ERROR");
            break;
          }
        }
        out.push({
          id: ev.id,
          runId,
          command: render(args),
          output,
          ok,
          running: output === undefined && live,
          env: toolEnv(tool),
          who: agents.length > 1 ? (nameOf.get(run?.agent_id ?? "") ?? null) : null,
          at: ev.created_at,
        });
      }
    }

    out.sort((a, b) => String(a.at).localeCompare(String(b.at)));

    // A dim header whenever the stream moves to another run, so a session that
    // spans several turns doesn't read as one continuous shell.
    const withNotes: TerminalLine[] = [];
    let prevRun = "";
    for (const l of out) {
      if (l.runId !== prevRun) {
        const run = runById.get(l.runId);
        const who = nameOf.get(run?.agent_id ?? "") ?? "agent";
        withNotes.push({
          id: `note-${l.runId}`,
          note: `${who} · run ${l.runId.slice(0, 8)} · ${STATUS_FR[run?.status ?? ""] ?? run?.status ?? "?"} · ${fmtTime(l.at ?? "")}`,
        });
        prevRun = l.runId;
      }
      withNotes.push(l);
    }
    return withNotes;
  }, [events, runs, agents.length, nameOf]);

  const commands = useMemo(() => [
    {
      name: "runs",
      description: "les derniers runs de cet agent",
      run: () => ((runs ?? []).length === 0
        ? "aucun run."
        : (runs ?? []).map((r) =>
          `${r.id.slice(0, 8)}  ${(STATUS_FR[r.status] ?? r.status).padEnd(14)} ${nameOf.get(r.agent_id) ?? ""}  ${new Date(r.created_at).toLocaleString("fr-FR")}`,
        ).join("\n")),
    },
    {
      name: "refresh",
      description: "recharge le flux maintenant",
      run: () => {
        qc.invalidateQueries({ queryKey: ["agent_terminal_runs", key, runLimit] });
        qc.invalidateQueries({ queryKey: ["agent_terminal_events", runIds.join(",")] });
        return "flux rechargé.";
      },
    },
  ], [runs, nameOf, qc, key, runLimit, runIds]);

  const commandCount = lines.filter((l) => !l.note).length;

  return (
    <AgentTerminal
      className={className}
      lines={lines}
      title={agents.length === 1 ? `${agents[0].name}@founderos:~` : `room@founderos:~ · ${agents.length} agents`}
      status={anyActive ? "live" : "idle"}
      commands={commands}
      onCommand={onCommand}
      forwardHint="demandé à l'agent"
      emptyMessage={
        "Aucune commande exécutée sur les derniers runs.\n\n" +
        "Ce terminal rejoue en direct les commandes que l'agent lance sur son runner\n" +
        "ou dans sa sandbox (shell, python, node, processus).\n" +
        'Tape "help" pour les commandes de ce terminal.'
      }
      footerHint={`${commandCount} commande${commandCount > 1 ? "s" : ""} · ↑/↓ historique · lecture en direct des runs`}
    />
  );
}
