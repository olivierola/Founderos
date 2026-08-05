// Shared presentation helpers for agent run events — used by the live
// RunTimeline (chat) and the Artifacts tab. One place so the "what does this
// tool call mean to a human" logic stays consistent everywhere.
import type React from "react";
import { createElement } from "react";
import {
  Globe, Search, FileText, TerminalSquare, Package, Brain, Target,
  MessagesSquare, ListTree, Mail, Cpu, Download, FolderCog,
} from "lucide-react";

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
