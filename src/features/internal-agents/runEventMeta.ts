// Shared presentation helpers for agent run events — used by the live
// RunTimeline (chat) and the Artifacts tab. One place so the "what does this
// tool call mean to a human" logic stays consistent everywhere.
import type React from "react";
import { createElement } from "react";
import {
  GlobeIcon as Globe,
  MagnifyingGlassIcon as Search,
  FileTextIcon as FileText,
  TerminalWindowIcon as TerminalSquare,
  PackageIcon as Package,
  BrainIcon as Brain,
  TargetIcon as Target,
  ChatsIcon as MessagesSquare,
  TreeViewIcon as ListTree,
  EnvelopeSimpleIcon as Mail,
  CpuIcon as Cpu,
  DownloadSimpleIcon as Download,
  FolderIcon as FolderCog,
} from "@phosphor-icons/react";

// Hybrid namespaces execution tools (runner_* / sandbox_*). The world a call ran
// in, or null for un-namespaced tools (single-world agents / non-execution tools).
export function toolEnv(tool: string): "runner" | "sandbox" | null {
  if (tool.startsWith("runner_")) return "runner";
  if (tool.startsWith("sandbox_")) return "sandbox";
  return null;
}

// Strip the world prefix so the summary/icon logic matches on the base tool —
// except the sandbox's own descriptive tools (sandbox_browser / sandbox_env),
// which are their own switch cases and must keep their full name.
function baseTool(tool: string): string {
  if (tool.startsWith("runner_")) return tool.slice("runner_".length);
  if (tool.startsWith("sandbox_")) {
    const rest = tool.slice("sandbox_".length);
    return rest === "browser" || rest === "env" ? tool : rest;
  }
  return tool;
}

// Human-readable one-liner for a tool call.
export function toolSummary(tool: string, args: any): string {
  const a = args ?? {};
  switch (baseTool(tool)) {
    case "shell_exec": return `$ ${String(a.command ?? "").slice(0, 80)}`;
    case "python_exec": return `python: ${String(a.code ?? "").replace(/\n/g, " ").slice(0, 60)}…`;
    case "nodejs_exec": return `node: ${String(a.code ?? "").replace(/\n/g, " ").slice(0, 60)}…`;
    case "jupyter_exec": return `jupyter: ${String(a.code ?? "").replace(/\n/g, " ").slice(0, 60)}…`;
    case "file_write": return `Write → ${String(a.file ?? "").slice(0, 60)}`;
    case "file_read": return `Read ← ${String(a.file ?? "").slice(0, 60)}`;
    case "file_edit": return `Edit ${String(a.file ?? "").slice(0, 55)}`;
    case "list_files": return `List ${String(a.path ?? "/home/gem").slice(0, 50)}`;
    case "file_search": return `Search ${a.grep ? `"${String(a.grep).slice(0, 35)}"` : String(a.glob ?? "")}`;
    case "manage_files": return `${String(a.action ?? "manage")} ${String(a.path ?? a.from ?? "").slice(0, 45)}${a.to ? ` → ${String(a.to).slice(0, 30)}` : ""}`;
    case "download_file": return `Download ${String(a.url ?? "").slice(0, 55)}`;
    case "run_background": return `Run bg: ${String(a.command ?? "").slice(0, 55)}`;
    case "list_processes": return `List processes`;
    case "process_logs": return `Logs ${String(a.proc_id ?? "")}`;
    case "process_stop": return `Stop ${String(a.proc_id ?? "")}`;
    case "machine_info": return `Machine info`;
    case "sandbox_browser": return `Browser: ${a.action}${a.url ? ` → ${String(a.url).slice(0, 45)}` : a.selector ? ` ${String(a.selector).slice(0, 30)}` : ""}`;
    case "sandbox_env": return `Env: ${a.action ?? ""}`;
    case "browse_web": return a.url ? `Browse → ${String(a.url).slice(0, 55)}` : `Browser: ${a.action ?? ""}`;
    case "http_get": return `GET ${String(a.url ?? "").slice(0, 60)}`;
    case "web_search": return `Search: "${String(a.query ?? "").slice(0, 50)}"`;
    case "deep_research": return `Research: "${String(a.query ?? "").slice(0, 50)}"`;
    case "read_url": return `Fetch ${String(a.url ?? "").slice(0, 55)}`;
    case "search_knowledge": return `Knowledge: "${String(a.query ?? "").slice(0, 45)}"`;
    case "query_table": return `SQL ${String(a.table ?? "")}`;
    case "create_deliverable": return `Deliverable: ${String(a.name ?? "")}`;
    case "update_todos": return `Todo list updated`;
    case "update_plan_step": return `Step ${String(a.step_id ?? "")} → ${String(a.status ?? "")}`;
    case "use_skill": return `Skill: ${String(a.slug ?? "")}`;
    case "create_task": return `Task: ${String(a.title ?? "")}`;
    case "create_mission": return `Mission: ${String(a.title ?? "")}`;
    case "delegate_mission": return `Delegate: ${String(a.title ?? "")}`;
    case "send_message_to_agent": return `Message → agent`;
    case "save_memory": return `Remember: ${String(a.content ?? "").slice(0, 45)}…`;
    case "search_memory": return `Recall: "${String(a.query ?? "").slice(0, 45)}"`;
    case "team_memory": return `Team memory: ${String(a.action ?? a.content ?? "").slice(0, 40)}`;
    case "ask_user": return `Question → user`;
    case "send_email": return `Email → ${String(a.to ?? "")}`;
    default: return tool.replace(/_/g, " ");
  }
}

// Icon component (not JSX — this is a .ts module) per tool family.
export function toolIcon(toolName: string): React.ReactNode {
  const cls = { className: "h-3.5 w-3.5" };
  const tool = baseTool(toolName);
  if (tool.includes("browser") || tool === "browse_web" || tool === "http_get" || tool === "read_url") return createElement(Globe, cls);
  if (tool === "download_file") return createElement(Download, cls);
  if (tool === "manage_files") return createElement(FolderCog, cls);
  if (tool.includes("process") || tool === "run_background" || tool === "list_processes" || tool === "machine_info") return createElement(Cpu, cls);
  if (tool.includes("search") || tool === "deep_research") return createElement(Search, cls);
  if (tool.includes("file") || tool === "list_files") return createElement(FileText, cls);
  if (tool.includes("python") || tool.includes("nodejs") || tool.includes("shell") || tool.includes("jupyter")) return createElement(TerminalSquare, cls);
  if (tool === "create_deliverable") return createElement(Package, cls);
  if (tool.includes("memory")) return createElement(Brain, cls);
  if (tool.includes("mission") || tool === "create_task") return createElement(Target, cls);
  if (tool === "send_message_to_agent" || tool === "ask_user") return createElement(MessagesSquare, cls);
  if (tool === "update_todos" || tool === "update_plan_step") return createElement(ListTree, cls);
  if (tool === "send_email") return createElement(Mail, cls);
  return createElement(TerminalSquare, cls);
}

export interface RunTodo {
  id: string;
  title: string;
  status: "pending" | "active" | "done" | "blocked";
  /** Id of the parent task when this item is a subtask (recursive decomposition). */
  parent_id?: string;
  note?: string;
}

export interface RunEventRow {
  id: string;
  run_id: string;
  kind: string;
  payload: any;
  created_at: string;
}

// ── Tool → category, for the ToolCallsSection rows ──────────────────────────
// The category drives the icon, so it has to name the thing a human would
// recognise: for an integration that is the connector slug (→ its real logo),
// for everything else the capability family. The runtime encodes the first
// case in the tool name — `use_<slug>` for connectors and Composio toolkits,
// `mcp_<server>_<tool>` for MCP servers (see slugToToolName /
// buildInternalToolset in _shared/internal-agent-tools.ts).
const FAMILY_BY_TOOL: Array<[RegExp, string]> = [
  [/^(browse_web|http_get|http_request|read_url|user_browser|sandbox_browser)$/, "web"],
  [/^(web_search|deep_research|search_knowledge|search_context|search_history|search_past_work|recall_findings)$/, "search"],
  [/^(file_|list_files|manage_files|download_file)/, "files"],
  [/^(shell_exec|python_exec|nodejs_exec|jupyter_exec|run_background|list_processes|process_|machine_info|sandbox_env)/, "execution"],
  [/^(create_deliverable|create_artifact|update_artifact|read_artifact|list_artifacts|publish_artifact|add_block|report_section)$/, "artifacts"],
  [/memory$/, "memory"],
  [/^(create_mission|list_missions|move_mission|delegate_mission|propose_mission|create_task)$/, "missions"],
  [/^(spawn_parallel_agents|create_agent|list_team_agents|send_message_to_agent)$/, "handoff"],
  [/^(ask_user|say)$/, "messaging"],
  // Guider quelqu'un dans SON écran n'est ni du web ni de la messagerie : la
  // timeline doit distinguer « l'agent a cliqué » de « l'agent a montré ».
  [/^(guide_user|training)$/, "training"],
  [/^(update_todos|update_plan_step|use_skill|read_skill_file|load_toolset|need_tools)$/, "planning"],
  [/^send_email$/, "email"],
  [/^(query_table|crm|list_connectors|list_assets)$/, "data"],
  [/^(security_scan|pentest_scope)$/, "security"],
  [/^(testing|simulation)$/, "testing"],
  [/^(render_ui|vibe_code|create_workflow)$/, "generation"],
];

/** Category for one tool call: a connector slug when there is one, else the
 *  capability family. Falls back to "general" rather than to the tool name,
 *  so unknown tools group instead of each claiming their own icon. */
export function toolCategory(toolName: string): string {
  if (toolName.startsWith("mcp_")) {
    // mcp_<server>_<tool> — the server is the integration worth showing.
    return toolName.slice(4).split("_")[0] || "integration";
  }
  const t = baseTool(toolName);
  if (t.startsWith("use_")) {
    // Tool names normalise every separator to "_", but connector slugs are
    // kebab-case ("google-calendar", "linkedin-talent"), which is what the
    // logo lookup keys on — so try the hyphenated form first.
    const raw = t.slice(4);
    return raw.replace(/_/g, "-");
  }
  for (const [re, family] of FAMILY_BY_TOOL) if (re.test(t)) return family;
  return "general";
}

// ── Tool → thinking-orb state ───────────────────────────────────────────────
// The live orb (thinking-orbs) shows *what kind* of work the agent is doing,
// so it keys on the same families as the tool rows. Each family picks the
// animation whose metaphor matches: a scanning globe for search, a wiring
// constellation for integrations, plaited strands for multi-agent work…
export type AgentOrbState =
  | "working" | "searching" | "solving" | "listening" | "connecting"
  | "weaving" | "composing" | "breathing" | "shaping";

const ORB_BY_FAMILY: Record<string, AgentOrbState> = {
  search: "searching",
  web: "searching",
  execution: "solving",
  security: "solving",
  testing: "solving",
  files: "working",
  artifacts: "composing",
  generation: "composing",
  email: "composing",
  planning: "shaping",
  missions: "shaping",
  handoff: "weaving",
  memory: "weaving",
  messaging: "listening",
  training: "listening",
  data: "connecting",
  general: "working",
};

/** Orb animation for one tool call. Connector / MCP calls (anything that isn't
 *  a known capability family) are the agent reaching out to another system. */
export function orbStateForTool(toolName: string): AgentOrbState {
  const cat = toolCategory(toolName);
  return ORB_BY_FAMILY[cat] ?? "connecting";
}

/** Orb animation for a run, from its status and the latest meaningful event. */
export function orbStateForRun(
  status: string | null | undefined,
  last: { kind: string; payload: any } | null | undefined,
): AgentOrbState {
  if (status === "awaiting_input") return "listening";
  if (status === "queued" || !last) return "breathing";
  if (last.kind === "question") return "listening";
  // A controller iteration that isn't business-as-usual = the agent is
  // re-checking its work or replanning.
  if (last.kind === "loop") return last.payload?.action && last.payload.action !== "continue" ? "solving" : "shaping";
  if (last.kind === "todos") return "shaping";
  if (last.kind === "tool_call") return orbStateForTool(String(last.payload?.tool ?? last.payload?.name ?? ""));
  return "working";
}

/** Short French verb for the state, for the one-word "agent is …" labels. */
export const ORB_STATE_LABEL: Record<AgentOrbState, string> = {
  working: "travaille…",
  searching: "recherche…",
  solving: "résout…",
  listening: "attend votre réponse…",
  connecting: "se connecte…",
  weaving: "coordonne…",
  composing: "rédige…",
  breathing: "réfléchit…",
  shaping: "planifie…",
};

/** Execution-world tools carry no brand; label them by the world they ran in
 *  so the row still says something true. */
export function toolIntegrationName(toolName: string): string | undefined {
  const env = toolEnv(toolName);
  if (env) return env === "runner" ? "Runner" : "Bac à sable";
  if (toolName.startsWith("mcp_")) return `MCP · ${toolName.slice(4).split("_")[0]}`;
  return undefined;
}
