// AgentTerminal — a real terminal surface for watching an agent work.
//
// Presentational only: the host feeds it `lines` (a command + its output, in
// order) and it renders them like a shell session, streaming, with the prompt
// at the bottom. It keeps the classic terminal chrome (window dots, status
// light, monospace) and the classic keyboard behaviour (↑/↓ history, click
// anywhere to focus, autoscroll that yields while you scroll back).
//
// The input is NOT a shell: `help` / `clear` / `grep` are handled here, the
// host can add its own read-only commands, and anything else is forwarded to
// `onCommand` (which, in this app, asks the agent to run it — the agent owns
// the runner, not the browser).
//
// Colours: none are hardcoded. The `.agent-terminal` class (globals.css) derives
// every one from the app theme tokens, so the surface follows Light, Dark and
// each named skin instead of imposing its own black-and-cyan.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TerminalLine {
  id: string;
  /** The command as it ran on the machine — rendered after the prompt. */
  command?: string;
  /** Combined stdout/stderr (the tool result). */
  output?: string;
  /** Which world it ran in: the real machine (runner) or the container (sandbox). */
  env?: "runner" | "sandbox" | null;
  /** false → the command failed (rendered red). */
  ok?: boolean;
  /** No result yet — the command is still running. */
  running?: boolean;
  /** Who ran it, shown when several agents share one terminal. */
  who?: string | null;
  /** A dim comment line (run boundary, notice) instead of a command. */
  note?: string;
  at?: string;
}

/** A read-only command the host wants the prompt to answer (e.g. `runs`). */
export interface TerminalCommand {
  name: string;
  description: string;
  /** Everything typed after the command name. Returns the text to print. */
  run: (arg: string) => string;
}

const MAX_OUTPUT_LINES = 14;

function linkify(text: string): ReactNode[] {
  const re = /(https?:\/\/[^\s<>"')]+)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <a
        key={`l${i++}`} href={m[0]} target="_blank" rel="noopener noreferrer"
        className="text-[var(--term-link)] underline-offset-2 hover:underline"
      >{m[0]}</a>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function AgentTerminal({
  lines,
  title = "agent@runner:~",
  prompt = "$",
  status = "idle",
  statusLabel,
  commands = [],
  onCommand,
  forwardHint = "envoyé à l'agent",
  emptyMessage = "Aucune commande pour l'instant.",
  footerHint,
  className,
}: {
  lines: TerminalLine[];
  title?: string;
  prompt?: string;
  /** live = something is running now, idle = nothing running, off = no machine. */
  status?: "live" | "idle" | "off";
  statusLabel?: string;
  commands?: TerminalCommand[];
  /** Unknown input is handed over here; return the text to print back. */
  onCommand?: (command: string) => Promise<string | void> | string | void;
  forwardHint?: string;
  emptyMessage?: string;
  footerHint?: string;
  className?: string;
}) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  // Local prompt output (help, grep, forwarded commands) — kept apart from the
  // streamed `lines` so a re-fetch can never drop it.
  const [echo, setEcho] = useState<TerminalLine[]>([]);
  // `clear` hides everything already streamed, without deleting anything.
  const [clearedId, setClearedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const stick = useRef(true);

  const shown = useMemo(() => {
    let base = lines;
    if (clearedId) {
      const cut = lines.findIndex((l) => l.id === clearedId);
      base = cut >= 0 ? lines.slice(cut + 1) : lines;
    }
    if (filter) {
      const q = filter.toLowerCase();
      base = base.filter((l) =>
        (l.command ?? "").toLowerCase().includes(q) ||
        (l.output ?? "").toLowerCase().includes(q) ||
        (l.note ?? "").toLowerCase().includes(q));
    }
    return [...base, ...echo];
  }, [lines, echo, clearedId, filter]);

  // Autoscroll while the user is parked at the bottom; stay put otherwise so
  // reading back through a long run isn't yanked away by new output.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  function pushEcho(command: string, output: string, running = false): string {
    const id = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setEcho((e) => [...e, { id, command, output, running, ok: true }]);
    return id;
  }
  function patchEcho(id: string, patch: Partial<TerminalLine>) {
    setEcho((e) => e.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  const helpText = () => [
    "Commandes de ce terminal :",
    "  help          cette aide",
    "  clear         vide l'affichage (rien n'est supprimé)",
    "  grep <texte>  ne garde que les lignes contenant <texte> (grep seul enlève le filtre)",
    ...commands.map((c) => `  ${c.name.padEnd(13)} ${c.description}`),
    ...(onCommand ? ["", `Toute autre saisie est ${forwardHint}.`] : []),
  ].join("\n");

  async function submit() {
    const text = value.trim();
    if (!text) return;
    setHistory((h) => [...h, text]);
    setHistIdx(-1);
    setValue("");

    const [name, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ");
    const cmd = name.toLowerCase();

    if (cmd === "clear") {
      setClearedId(lines.length ? lines[lines.length - 1].id : null);
      setEcho([]);
      return;
    }
    if (cmd === "help") return void pushEcho(text, helpText());
    if (cmd === "grep") {
      setFilter(arg);
      return void pushEcho(text, arg ? `filtre actif : ${arg}` : "filtre retiré");
    }
    const local = commands.find((c) => c.name === cmd);
    if (local) return void pushEcho(text, local.run(arg));

    if (!onCommand) {
      return void pushEcho(text, `commande inconnue : ${cmd}\ntape "help" pour la liste.`);
    }
    const id = pushEcho(text, "…", true);
    try {
      const res = await onCommand(text);
      patchEcho(id, { output: typeof res === "string" ? res : `→ ${forwardHint}`, running: false });
    } catch (e) {
      patchEcho(id, { output: e instanceof Error ? e.message : String(e), running: false, ok: false });
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!history.length) return;
      const next = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(next);
      setValue(history[history.length - 1 - next] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(histIdx - 1, -1);
      setHistIdx(next);
      setValue(next === -1 ? "" : history[history.length - 1 - next] ?? "");
    }
  }

  const dot = status === "live" ? "bg-[var(--term-ok)]" : status === "off" ? "bg-[var(--term-danger)]" : "bg-[var(--term-dim)]";
  const label = statusLabel ?? (status === "live" ? "EN COURS" : status === "off" ? "HORS LIGNE" : "AU REPOS");

  return (
    <div
      onClick={() => input.current?.focus()}
      className={cn(
        "agent-terminal flex h-full min-h-0 cursor-text flex-col overflow-hidden rounded-xl border border-[var(--term-border)] bg-[var(--term-bg)] font-mono text-[12px] leading-relaxed",
        className,
      )}
    >
      {/* Window chrome */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--term-border)] bg-[var(--term-chrome)] px-3 py-2 text-[10px] text-[var(--term-dim)]">
        <span className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--term-danger)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--term-prompt)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--term-ok)]" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[var(--term-out)]">{title}</span>
        {filter && (
          <button
            onClick={(e) => { e.stopPropagation(); setFilter(""); }}
            className="shrink-0 rounded bg-[var(--term-chip-bg)] px-1.5 py-0.5 text-[var(--term-link)] hover:text-[var(--term-fg)]"
            title="Retirer le filtre"
          >grep: {filter} ✕</button>
        )}
        <span className="flex shrink-0 items-center gap-1.5">
          <span className={cn("h-1.5 w-1.5 rounded-full", dot, status === "live" && "animate-pulse")} />
          {label}
        </span>
      </div>

      {/* Session */}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="scrollbar-slim min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2.5"
      >
        {shown.length === 0 ? (
          <p className="whitespace-pre-wrap text-[var(--term-dim)]">{emptyMessage}</p>
        ) : (
          shown.map((l) => <Line key={l.id} line={l} prompt={prompt} />)
        )}

        {/* The prompt itself lives in the scroller, at the end of the session. */}
        <div className="flex items-center gap-2 pt-0.5">
          <span className="shrink-0 text-[var(--term-prompt)]">{prompt}</span>
          <input
            ref={input}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-[var(--term-fg)] caret-[var(--term-caret)] outline-none placeholder:text-[var(--term-note)]"
            placeholder={onCommand ? "help · clear · grep <texte> · ou une commande à faire exécuter" : "help · clear · grep <texte>"}
          />
        </div>
      </div>

      {footerHint && (
        <div className="shrink-0 border-t border-[var(--term-border)] bg-[var(--term-chrome)] px-3 py-1.5 text-[10px] text-[var(--term-dim)]">
          {footerHint}
        </div>
      )}
    </div>
  );
}

function Line({ line, prompt }: { line: TerminalLine; prompt: string }) {
  const [expanded, setExpanded] = useState(false);
  if (line.note) {
    return <div className="whitespace-pre-wrap text-[var(--term-note)]"># {line.note}</div>;
  }

  const failed = line.ok === false;
  const outLines = (line.output ?? "").split("\n");
  const clipped = !expanded && outLines.length > MAX_OUTPUT_LINES;
  const text = clipped ? outLines.slice(0, MAX_OUTPUT_LINES).join("\n") : (line.output ?? "");

  return (
    <div>
      <div className="flex items-start gap-2">
        <span className={cn("shrink-0", failed ? "text-[var(--term-danger)]" : "text-[var(--term-prompt)]")}>{prompt}</span>
        {line.env && (
          <span
            className={cn(
              "mt-[2px] shrink-0 rounded px-1 text-[9px] font-semibold uppercase leading-tight",
              line.env === "runner" ? "bg-[var(--term-run-bg)] text-[var(--term-run)]" : "bg-[var(--term-sbx-bg)] text-[var(--term-sbx)]",
            )}
            title={line.env === "runner" ? "Exécuté sur le runner (machine réelle)" : "Exécuté dans la sandbox (conteneur)"}
          >{line.env === "runner" ? "run" : "sbx"}</span>
        )}
        {line.who && <span className="mt-[1px] shrink-0 text-[10px] text-[var(--term-dim)]">{line.who}</span>}
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[var(--term-fg)]">{line.command}</span>
        {line.running && <span className="shrink-0 animate-pulse text-[var(--term-ok)]">▍</span>}
      </div>
      {(line.output ?? "") !== "" && (
        <pre className={cn(
          "mt-0.5 whitespace-pre-wrap break-words pl-4",
          failed ? "text-[var(--term-danger)]" : "text-[var(--term-out)]",
        )}>{linkify(text)}</pre>
      )}
      {clipped && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(true); }}
          className="ml-4 text-[10px] text-[var(--term-dim)] hover:text-[var(--term-fg)]"
        >… {outLines.length - MAX_OUTPUT_LINES} lignes de plus</button>
      )}
    </div>
  );
}
