// internal-agent-run — execute an internal (autonomous) agent in "chat" or
// "mission" mode.
//
// Body: { agent_id, mode: "chat" | "mission", conversation_id?, run_id? }
//
// v2: a real agentic loop. The agent's granted tools (internal_agent_tools)
// are compiled into executable tool definitions and the LLM iterates —
// searching the web, reading URLs, querying allowlisted project tables,
// searching the RAG knowledge base, invoking edge functions / webhooks — until
// the task is done or a budget is hit. Compared to v1:
//
//   - Tools are EXECUTED (v1 only mentioned them in the prompt).
//   - Every step is appended to internal_agent_run_events → live timeline.
//   - Runs can be cancelled mid-flight (status flips to 'cancelled').
//   - Per-agent budgets: max_steps bounds the loop, max_run_cost_usd marks
//     over-budget runs.
//   - Sensitive tools (requires_approval) are queued as approvals instead of
//     executing; internal-agent-approve runs them after a human decision.
//   - Deliverables are materialised by the agent itself via create_deliverable.
//   - Callers are authenticated: a user JWT must carry agent access; the
//     scheduler authenticates with the service-role key.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi, callAiWithTools, runToolRounds, safeParseJson, type ChatMessage } from "../_shared/ai.ts";
import { embedTexts, toVectorLiteral } from "../_shared/jina.ts";
import { logLlmUsage } from "../_shared/llm-tracking.ts";
import {
  buildInternalToolset, RunCancelledError, AwaitingInputError, embedMemoryVector,
  type AgentToolRow, type InternalToolContext,
} from "../_shared/internal-agent-tools.ts";

interface AgentRow {
  id: string;
  name: string;
  persona: string | null;
  instructions: string | null;
  model: string;
  temperature: number;
  max_steps: number;
  max_run_cost_usd: number;
  workspace_id: string;
  project_id: string;
  is_archived: boolean;
  collaboration_enabled: boolean;
  sandbox_mode: "cloud" | "runner" | "sandbox";
  sandbox_url: string | null;
}

// Rough per-1k-token rates (USD). Adjust as providers change pricing.
const RATES: Record<string, { in: number; out: number }> = {
  groq: { in: 0.00005, out: 0.0001 },
  deepseek: { in: 0.00014, out: 0.00028 },
};
function estimateCost(
  usage: { prompt_tokens: number; completion_tokens: number } | undefined,
  provider: "groq" | "deepseek",
): number {
  if (!usage) return 0;
  const r = RATES[provider] ?? { in: 0, out: 0 };
  return (usage.prompt_tokens * r.in + usage.completion_tokens * r.out) / 1000;
}

// All internal agents run on DeepSeek for stronger reasoning, unless an agent
// explicitly pins "groq" or DeepSeek isn't configured (then we fall back).
function providerFor(agent: AgentRow): "groq" | "deepseek" {
  // DeepSeek is strongly preferred for agents — much better at tool calling.
  // Only use Groq if explicitly set AND no DeepSeek key is available.
  if (Deno.env.get("DEEPSEEK_API_KEY")) return "deepseek";
  return "groq";
}
const AGENT_MODEL: Record<"groq" | "deepseek", string | undefined> = {
  deepseek: Deno.env.get("AGENT_MODEL_DEEPSEEK") || "deepseek-v4-pro",
  groq: undefined, // use ai.ts default
};

// Run the tool loop on the agent's provider; if DeepSeek fails (key/model
// unavailable), fall back to Groq so a chat/mission never hard-fails.
// `modelOverride` lets missions route to a stronger / more tool-call-reliable
// model (set env AGENT_MODEL_MISSION) without changing chat behaviour.
async function runTools(
  provider: "groq" | "deepseek",
  opts: Omit<Parameters<typeof callAiWithTools>[0], "provider" | "model">,
  modelOverride?: string,
) {
  try {
    return await callAiWithTools({ ...opts, provider, model: modelOverride || AGENT_MODEL[provider] });
  } catch (e) {
    if (provider === "deepseek") {
      return await callAiWithTools({ ...opts, provider: "groq" });
    }
    throw e;
  }
}

function buildSystemPrompt(
  agent: AgentRow,
  capabilitySummary: string,
  mode: "chat" | "mission",
  memorySection: string,
  teamMemorySection: string,
  skillPrompts: string = "",
  recentWorkSection: string = "",
): string {
  const lines: string[] = [];
  lines.push(`You are ${agent.persona || agent.name}, an autonomous internal agent for a SaaS team.`);
  lines.push(`You work as part of a TEAM of agents — you can discover, message and delegate to peers, and share knowledge through the team memory.`);
  if (agent.instructions) {
    lines.push("", "Your detailed instructions:", agent.instructions);
  }
  if (skillPrompts) {
    lines.push(
      "",
      "## Activated skills (your specialised playbooks)",
      "These skills are activated for you. They are NOT loaded yet — when a step needs one, call use_skill(<slug>) to pull its full playbook into context, then apply it. Plan which skill each step needs.",
      skillPrompts,
    );
  }
  if (memorySection) {
    lines.push(
      "",
      "Your persistent memory (knowledge carried over from previous sessions and runs):",
      memorySection,
    );
  }
  if (teamMemorySection) {
    lines.push(
      "",
      "Shared TEAM memory (knowledge contributed by you and your teammate agents):",
      teamMemorySection,
    );
  }
  if (recentWorkSection) {
    lines.push(
      "",
      "## Your recent work (latest runs — you already did this; build on it, don't redo it)",
      recentWorkSection,
    );
  }
  lines.push(
    "",
    "Your capabilities (real, executable tools):",
    capabilitySummary,
    "",
    "Operating rules:",
    "- THINK & PLAN FIRST, THEN ACT. Before touching any tool you reason about the goal and draft an explicit execution plan (an ordered list of tasks, each naming the tools you'll use and how). You have already produced that plan — it is shown to you below. Follow it task by task, in order; only deviate when a tool result genuinely forces a change, and say so.",
    "- KEEP YOUR TODO CHECKLIST CURRENT (update_todos): the user watches it live. Your plan was seeded as todos. Right before starting a step, send the FULL list with that step 'active'; right after finishing AND verifying it, send it again with the step 'done' (one-line note of what you verified). Exactly ONE item 'active' at a time. Mark 'blocked' with the reason when stuck; add newly discovered steps. Never leave the checklist stale while you work.",
    "- VERIFY each step's result before moving on. Don't fire the next tool blindly — read the result, confirm it succeeded, and only then proceed.",
    "- ASK ONLY WHEN NECESSARY: you are autonomous — decide and act on your own whenever you reasonably can. Use ask_user(question, options?) to pause and ask the human ONLY when you genuinely cannot proceed correctly: a truly ambiguous/under-specified request, a missing input you can't obtain, a real fork in direction, or confirmation before an irreversible action. After ask_user the run pauses for the human's reply.",
    "- COMPLETE THE WHOLE JOB — DON'T STOP EARLY. You are NOT finished until EVERY plan step is done AND every expected deliverable has been created with create_deliverable. Never end your turn after just the analysis/exploration phase: keep going through modelling, file outputs and the final report. If plan steps remain, continue working — do not hand back a partial result.",
    "- RESUME, DON'T RESTART. Your sandbox filesystem AND this conversation PERSIST between turns. Before (re)doing any step, CHECK whether its output already exists — list files (list_files / shell_exec \"ls -la\"), and re-read earlier results in the conversation. If the user says \"continue\" (or similar), pick up at the FIRST UNFINISHED step; never re-download, re-install or re-compute work that is already done.",
    "- Use your tools to gather real data — never invent numbers or facts.",
    "- Some tools require human approval: calling them queues the action for review. Acknowledge the pending approval and keep going.",
    "- If a tool errors, adapt: try another approach or state the limitation clearly.",
    "- SAVE TO MEMORY AS YOU WORK (save_memory) — don't wait until the end. The moment you learn something durable, persist it so you're never out of sync next session. Concretely, save: stable facts about the project/user, user/team PREFERENCES, packages or tools you INSTALLED and datasets/files you produced (with their sandbox paths), and the KEY RESULT or conclusion of each mission. Keep each memory one self-contained line; skip transient details and anything already in the memory above.",
    "- Collaborate: if a teammate's skills fit part of the work better, message them (send_message_to_agent) or delegate it (delegate_mission) instead of doing everything yourself. Record team-wide decisions/findings with team_memory.",
  );
  if (mode === "mission") {
    lines.push(
      "- Materialise every expected deliverable with create_deliverable before finishing.",
      "- Your final message is a concise mission report (markdown): what you did, key findings, deliverables produced, pending approvals if any.",
    );
  } else {
    lines.push(
      "- Respond in concise markdown, in the user's language. Avoid filler.",
      "- BE CONVERSATIONAL & THINK FIRST. If the request is ambiguous, under-specified, or could go several ways, ASK a brief clarifying question before acting (e.g. which target, which period, which audience). Don't guess on important details. A short back-and-forth is better than a wrong deliverable.",
      "- Confirm scope on big/irreversible actions before doing them.",
      "- You can turn work into a tracked task with create_task, or kick off a full background mission with create_mission (use it when the user asks you to 'do X' as ongoing/standalone work, or to schedule recurring work).",
      "- When the user asks for an analysis, report, summary of data, or anything substantial, produce it with create_deliverable (prefer kind=\"report\" with KPIs/charts/tables). Then reply with a short summary — the full report opens as an artifact card in the chat.",
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Upfront reasoning & planning
//
// Before the agent touches any tool, it runs a dedicated planning pass: it
// restates the goal, reasons about the approach, and breaks the work into an
// ORDERED list of concrete tasks — each naming the tools to call and how. The
// plan is logged as a `plan` run event (rendered in the live timeline) and fed
// back into the execution loop so the agent commits to its own plan. Planning
// is best-effort: if it fails, the agent falls back to direct execution.
// ---------------------------------------------------------------------------

interface PlanTaskTool {
  tool: string;
  how: string;
  /** What the tool does & when it's useful — filled from the tool catalog. */
  desc?: string;
}
interface PlanTask {
  /** Stable id (step-1, step-2, …) the agent uses with update_plan_step. */
  id: string;
  title: string;
  detail: string;
  tools: PlanTaskTool[];
}
interface ExecutionPlan {
  understanding: string;
  reasoning: string;
  tasks: PlanTask[];
  risks?: string;
  done_when?: string;
}

function planToMarkdown(plan: ExecutionPlan): string {
  const out: string[] = [];
  if (plan.understanding) out.push(`**Goal:** ${plan.understanding}`);
  if (plan.reasoning) out.push(`**Approach:** ${plan.reasoning}`);
  out.push("", "**Plan:**");
  (Array.isArray(plan.tasks) ? plan.tasks : []).forEach((t, i) => {
    out.push(`${i + 1}. **${t.title}**${t.detail ? ` — ${t.detail}` : ""}`);
    (Array.isArray(t.tools) ? t.tools : []).forEach((tl) => {
      if (tl?.tool) out.push(`   - \`${tl.tool}\`${tl.how ? ` — ${tl.how}` : ""}`);
    });
  });
  if (plan.risks) out.push("", `**Risks / watch-outs:** ${plan.risks}`);
  if (plan.done_when) out.push("", `**Done when:** ${plan.done_when}`);
  return out.join("\n");
}

function safeParsePlan(content: string): ExecutionPlan | null {
  if (!content) return null;
  let txt = content.trim();
  const fence = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) txt = fence[1].trim();
  const start = txt.indexOf("{");
  const end = txt.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(txt.slice(start, end + 1)) as ExecutionPlan;
    if (!obj || !Array.isArray(obj.tasks) || obj.tasks.length === 0) return null;
    return obj;
  } catch {
    return null;
  }
}

async function produceExecutionPlan(opts: {
  provider: "groq" | "deepseek";
  agent: AgentRow;
  toolDefs: Array<{ name: string; description: string }>;
  taskText: string;
  contextText?: string;
}): Promise<{ plan: ExecutionPlan; markdown: string } | null> {
  const { provider, agent, toolDefs, taskText, contextText } = opts;
  // Rich tool catalog: name + what it does & when it's useful. The planner reads
  // this to choose the right tool per step and to explain each tool to the user.
  const descByName = new Map(toolDefs.map((d) => [d.name, d.description]));
  const toolCatalog = toolDefs.map((d) => `- ${d.name}: ${d.description}`).join("\n");
  const systemPrompt = [
    `You are ${agent.persona || agent.name}, an autonomous agent. Before doing ANY work, you ALWAYS produce a concrete execution plan — this is the planning step, you do not act yet.`,
    `Think it through: (1) restate the goal in your own words, (2) reason about the best approach, (3) break the work into an ORDERED, SEQUENCED list of concrete tasks. For EACH task, list which tools to call, IN ORDER, and HOW (what inputs/arguments you'll pass and what you expect back). Plan to VERIFY each task's output before the next.`,
    ``,
    `You may ONLY use these tools — refer to them by their EXACT name. Each line is "name: what it does":`,
    toolCatalog || "(no external tools available — plan using your own reasoning and knowledge)",
    ``,
    `Respond with STRICT JSON only (no prose, no code fence), matching exactly:`,
    `{`,
    `  "understanding": "one sentence restating the goal",`,
    `  "reasoning": "2-4 sentences on your approach and key decisions",`,
    `  "tasks": [`,
    `    { "title": "short task title", "detail": "what to do, why, and how you'll verify it succeeded", "tools": [ { "tool": "exact_tool_name", "how": "how/with what inputs you'll use it" } ] }`,
    `  ],`,
    `  "risks": "main risks, ambiguities or assumptions (optional)",`,
    `  "done_when": "objective definition of done"`,
    `}`,
    `Keep it tight: 3-8 tasks. Only include tools that genuinely apply to a task (a task may need zero tools). Do not invent tool names. If the request is too ambiguous to plan responsibly, make your first task use the ask_user tool.`,
    `RESUME-AWARE: if the context below shows work already done (files created, steps completed) — e.g. the user said "continue" — plan ONLY the REMAINING steps. Make the first task verify existing state (list files / re-read prior results) and then proceed from the first unfinished step. Never re-plan finished work from scratch.`,
  ].join("\n");

  const userPrompt = [
    `# Task to plan`,
    taskText,
    contextText ? `\n# Relevant context (memory / prior work)\n${contextText.slice(0, 4000)}` : "",
  ].join("\n");

  const callOnce = (p: "groq" | "deepseek") =>
    callAi({
      task: "architecture_reasoning",
      systemPrompt,
      userPrompt,
      provider: p,
      model: AGENT_MODEL[p],
      jsonMode: true,
      maxTokens: 1800,
      temperature: 0.3,
    });

  try {
    let res;
    try {
      res = await callOnce(provider);
    } catch (e) {
      if (provider === "deepseek") res = await callOnce("groq");
      else throw e;
    }
    const parsed = safeParsePlan(res.content);
    if (!parsed) return null;
    // Assign stable ids and attach each tool's catalog description (function &
    // utility) so the live timeline can explain every tool to the user.
    parsed.tasks = parsed.tasks.slice(0, 10).map((t, i) => ({
      ...t,
      id: `step-${i + 1}`,
      tools: (Array.isArray(t.tools) ? t.tools : []).map((tl) => ({
        ...tl,
        desc: descByName.get(tl.tool) ? String(descByName.get(tl.tool)).slice(0, 240) : undefined,
      })),
    }));
    return { plan: parsed, markdown: planToMarkdown(parsed) };
  } catch {
    // Planning is best-effort: on failure the agent executes without a plan.
    return null;
  }
}

// Build the messages that inject a committed plan into the execution loop.
function planMessages(markdown: string, mode: "chat" | "mission"): ChatMessage[] {
  const nudge = mode === "mission"
    ? "The plan is approved. Execute it now, task by task, in order, calling the tools exactly as you outlined. Do not re-plan from scratch — follow the plan, adapting only when a tool result requires it. Begin with task 1."
    : "Proceed with this plan now, task by task, calling the tools as outlined. Adapt only when a result requires it. If something critical is genuinely ambiguous, ask one short clarifying question first; otherwise begin.";
  return [
    { role: "assistant", content: `Here is my execution plan before I act:\n\n${markdown}` },
    { role: "user", content: nudge },
  ];
}

async function loadAgentAndTools(agentId: string) {
  const admin = createServiceClient();
  const [{ data: agent, error: agentErr }, { data: tools }] = await Promise.all([
    admin
      .from("internal_agents")
      .select("id, name, persona, instructions, model, temperature, max_steps, max_run_cost_usd, workspace_id, project_id, is_archived, collaboration_enabled, sandbox_mode, sandbox_url")
      .eq("id", agentId)
      .maybeSingle(),
    admin
      .from("internal_agent_tools")
      .select("id, kind, name, description, config, enabled, requires_approval")
      .eq("agent_id", agentId),
  ]);
  if (agentErr) throw new Error(`Could not load agent: ${agentErr.message}`);
  if (!agent) throw new Error(`Agent not found (id=${agentId})`);
  if ((agent as AgentRow).is_archived) throw new Error("Agent is archived");
  return { agent: agent as AgentRow, tools: (tools ?? []) as AgentToolRow[] };
}

// Top-of-mind memory injected into every prompt: pinned first, then by
// importance and recency, capped so it can't crowd out the context window.
// The agent reaches older entries through search_memory.
async function loadMemorySection(
  admin: ReturnType<typeof createServiceClient>,
  agentId: string,
  taskText?: string,
): Promise<string> {
  const { data } = await admin
    .from("internal_agent_memories")
    .select("id, kind, content, importance, is_pinned")
    .eq("agent_id", agentId)
    .order("is_pinned", { ascending: false })
    .order("importance", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(25);
  if (!data || data.length === 0) return "";
  type Mem = { id?: string; kind: string; content: string; importance: number; is_pinned: boolean };
  let rows = data as Mem[];

  // Semantic recall: when we know the current task, pull the memories most
  // RELEVANT to it (not just the most important) and rank them first after the
  // pinned ones. Best-effort — falls back to the static top-N.
  if (taskText && Deno.env.get("JINA_API_KEY")) {
    try {
      const [qvec] = await embedTexts([taskText.slice(0, 1500)], "retrieval.query");
      if (qvec) {
        const { data: sem } = await admin.rpc("match_agent_memories", {
          p_agent_id: agentId, p_query_embedding: toVectorLiteral(qvec), p_match_count: 8,
        });
        if (Array.isArray(sem) && sem.length) {
          const pinned = rows.filter((m) => m.is_pinned);
          const seen = new Set(pinned.map((m) => m.content));
          const semantic = (sem as Mem[]).filter((m) => !seen.has(m.content));
          for (const m of semantic) seen.add(m.content);
          const rest = rows.filter((m) => !seen.has(m.content));
          rows = [...pinned, ...semantic, ...rest];
        }
      }
    } catch { /* static fallback */ }

    // Lazy backfill: embed a few legacy memories that predate the embedding
    // column so they become findable next time. Fire-and-forget.
    (async () => {
      try {
        const { data: missing } = await admin
          .from("internal_agent_memories").select("id, content")
          .eq("agent_id", agentId).is("embedding", null).limit(5);
        for (const m of missing ?? []) {
          const v = await embedMemoryVector(m.content as string);
          if (v) await admin.from("internal_agent_memories").update({ embedding: v }).eq("id", m.id);
        }
      } catch { /* best-effort */ }
    })();
  }

  const lines: string[] = [];
  let budget = 3500;
  for (const m of rows) {
    const line = `- [${m.kind}${m.is_pinned ? ", pinned" : ""}] ${m.content}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }
  return lines.join("\n");
}

// Shared team knowledge pool, injected so agents share context across the team.
// "Recent work" for the chat system prompt: the agent's last mission runs, so a
// conversation starts aware of what it just did (paths, results, failures)
// instead of rediscovering — or worse, redoing — its own work.
async function loadRecentWorkSection(
  admin: ReturnType<typeof createServiceClient>,
  agentId: string,
): Promise<string> {
  try {
    const { data: runs } = await admin
      .from("internal_agent_runs")
      .select("status, finished_at, final_output, error_message, mission_id")
      .eq("agent_id", agentId)
      .in("status", ["succeeded", "failed"])
      .not("mission_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(3);
    if (!runs?.length) return "";
    const missionIds = [...new Set(runs.map((r: any) => r.mission_id))];
    const { data: missions } = await admin
      .from("internal_agent_missions").select("id, title").in("id", missionIds);
    const titleOf = new Map((missions ?? []).map((m: any) => [m.id, m.title]));
    return runs.map((r: any) => {
      const when = String(r.finished_at ?? "").slice(0, 16);
      const head = `- [${r.status === "succeeded" ? "OK" : "ÉCHEC"}] "${titleOf.get(r.mission_id) ?? "mission"}" (${when})`;
      const body = r.status === "failed"
        ? ` — erreur: ${String(r.error_message ?? "inconnue").slice(0, 200)}`
        : ` — ${String(r.final_output ?? "").replace(/[#*`>_\n]+/g, " ").trim().slice(0, 400)}`;
      return head + body;
    }).join("\n");
  } catch { return ""; }
}

async function loadTeamMemorySection(
  admin: ReturnType<typeof createServiceClient>,
  projectId: string,
): Promise<string> {
  const { data } = await admin
    .from("internal_agent_team_memories")
    .select("kind, content, is_pinned")
    .eq("project_id", projectId)
    .order("is_pinned", { ascending: false })
    .order("importance", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(15);
  if (!data || data.length === 0) return "";
  return (data as Array<{ kind: string; content: string; is_pinned: boolean }>)
    .map((m) => `- [${m.kind}${m.is_pinned ? ", pinned" : ""}] ${m.content}`)
    .join("\n");
}

// Load the skills activated for this agent (full fields). Their playbooks are
// NOT injected up-front — only an index goes in the prompt; the agent pulls a
// skill's full instructions on demand via use_skill (progressive disclosure).
async function loadActivatedSkills(
  admin: ReturnType<typeof createServiceClient>,
  agentId: string,
): Promise<Array<{ slug: string; name: string; description: string | null; category: string | null; instructions: string | null; tools: string[] | null }>> {
  const { data } = await admin
    .from("agent_skill_activations")
    .select("skill:agent_skills(slug, name, description, category, system_prompt_extension, required_tools)")
    .eq("agent_id", agentId);
  return ((data ?? []) as any[])
    .map((a) => a.skill)
    .filter(Boolean)
    .map((s: any) => ({
      slug: s.slug,
      name: s.name,
      description: s.description ?? null,
      category: s.category ?? null,
      instructions: s.system_prompt_extension ?? null,
      tools: s.required_tools ?? null,
    }));
}

// One-line-per-skill index for the system prompt (the agent's global view of
// the skills it can pull in with use_skill).
function skillsIndex(skills: Array<{ slug: string; name: string; description: string | null; category: string | null }>): string {
  return skills
    .map((s) => `- ${s.name} (${s.slug})${s.category ? ` [${s.category}]` : ""}${s.description ? `: ${s.description}` : ""}`)
    .join("\n");
}

function nextRunAt(schedule: string, from: Date): string {
  const d = new Date(from);
  if (schedule === "daily") d.setDate(d.getDate() + 1);
  else if (schedule === "weekly") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Tool context wiring
// ---------------------------------------------------------------------------

// Runtime infra config read FRESH from the DB on every run. Edge workers cache
// env secrets until they're recycled (the pg_cron drainer keeps them warm), so a
// re-synced SANDBOX_URL secret could stay stale for hours — the root cause of
// the 03/07 "Sandbox unreachable" fork-bomb incident. app_config is always live.
async function loadRuntimeConfig(
  admin: ReturnType<typeof createServiceClient>,
): Promise<{ sandboxUrl: string | null; runnerUrl: string | null }> {
  try {
    const { data } = await admin.from("app_config").select("key, value").in("key", ["sandbox_url", "runner_browser_url"]);
    const map = new Map((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
    return {
      sandboxUrl: map.get("sandbox_url") || null,
      runnerUrl: map.get("runner_browser_url") || null,
    };
  } catch {
    return { sandboxUrl: null, runnerUrl: null };
  }
}

// Circuit breaker: one cheap probe of the sandbox API before starting real
// work. Returns null when healthy, else a short diagnostic. Prevents the
// "grind for hours against a dead tunnel" failure mode.
async function probeSandbox(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${url.replace(/\/$/, "")}/v1/bash/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
      body: JSON.stringify({ command: "echo ok", timeout: 5 }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    if (!res.ok) return `HTTP ${res.status}`;
    if (!text.trim().startsWith("{")) return "réponse HTML — tunnel mort ou intersticiel";
    return null;
  } catch (e) {
    return (e instanceof Error ? e.message : String(e)).slice(0, 120);
  }
}

const SANDBOX_DOWN_MSG =
  "⚠️ Sandbox d'exécution injoignable — l'infrastructure locale (Docker/ngrok/runner) est arrêtée ou le tunnel a changé. " +
  "Relance-la en une commande : powershell -ExecutionPolicy Bypass -File scripts\\start-agents-infra.ps1 — puis relance la mission.";

// Circuit breaker for RUNNER mode: same idea as probeSandbox, but the runner
// exposes a plain /health endpoint (browser.js). Returns null when healthy.
async function probeRunner(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
      method: "GET",
      headers: { "ngrok-skip-browser-warning": "true" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    if (!res.ok) return `HTTP ${res.status}`;
    if (!text.trim().startsWith("{")) return "réponse HTML — tunnel mort ou intersticiel";
    return null;
  } catch (e) {
    return (e instanceof Error ? e.message : String(e)).slice(0, 120);
  }
}

const RUNNER_DOWN_MSG =
  "⚠️ Runner injoignable — la machine self-hosted (runner + tunnel) est arrêtée ou son URL a changé. " +
  "Relance-la : powershell -ExecutionPolicy Bypass -File scripts\\start-agents-infra.ps1 — puis relance la mission.";

function makeToolContext(opts: {
  admin: ReturnType<typeof createServiceClient>;
  agent: AgentRow;
  runId: string | null;
  missionId: string | null;
  conversationId?: string | null;
  delegationDepth?: number;
  /** DB-backed infra config (loadRuntimeConfig) — takes precedence over env. */
  runtimeConfig?: { sandboxUrl: string | null; runnerUrl: string | null };
}): InternalToolContext {
  const { admin, agent, runId, missionId } = opts;
  let lastCancelCheck = 0;
  let cancelled = false;
  return {
    admin,
    workspaceId: agent.workspace_id,
    projectId: agent.project_id,
    agentId: agent.id,
    agentName: agent.name,
    collaborationEnabled: agent.collaboration_enabled,
    // Autopilot = the agent may execute write actions without per-action
    // approval. There is no per-agent autopilot flag on internal_agents, so we
    // default to NOT autopilot — write gating is driven per-tool by each tool's
    // own requires_approval flag.
    autopilot: false,
    runId,
    conversationId: opts.conversationId ?? null,
    // Precedence: per-agent override → live DB config → env fallback.
    sandboxUrl: agent.sandbox_mode === "sandbox"
      ? (agent.sandbox_url || opts.runtimeConfig?.sandboxUrl || Deno.env.get("SANDBOX_URL") || null)
      : null,
    runnerEnabled: agent.sandbox_mode === "runner",
    runnerUrl: opts.runtimeConfig?.runnerUrl || null,
    missionMode: opts.missionId != null,
    delegationDepth: opts.delegationDepth ?? 0,
    createDeliverable: async (d) => {
      await admin.from("internal_agent_deliverables").insert({
        run_id: runId,
        mission_id: missionId,
        conversation_id: opts.conversationId ?? null,
        agent_id: agent.id,
        kind: d.kind,
        name: d.name,
        content: d.content,
        summary: d.summary,
      });
    },
    requestApproval: async (r) => {
      const { data, error } = await admin
        .from("internal_agent_approvals")
        .insert({
          agent_id: agent.id,
          run_id: runId,
          mission_id: missionId,
          workspace_id: agent.workspace_id,
          project_id: agent.project_id,
          tool_name: r.tool_name,
          action_kind: r.action_kind,
          payload: r.payload,
          reason: r.reason,
        })
        .select("id")
        .single();
      if (error) throw new Error(`Could not queue approval: ${error.message}`);
      return (data as { id: string }).id;
    },
    logEvent: async (kind, payload) => {
      if (!runId) return;
      await admin.from("internal_agent_run_events").insert({
        run_id: runId,
        agent_id: agent.id,
        kind,
        payload,
      });
    },
    isCancelled: async () => {
      if (!runId || cancelled) return cancelled;
      // Throttle: at most one status check per 2s.
      const now = Date.now();
      if (now - lastCancelCheck < 2000) return false;
      lastCancelCheck = now;
      const { data } = await admin
        .from("internal_agent_runs")
        .select("status")
        .eq("id", runId)
        .maybeSingle();
      cancelled = data?.status === "cancelled";
      return cancelled;
    },
  };
}

// ---------------------------------------------------------------------------
// Chat mode
// ---------------------------------------------------------------------------

async function runChat(agent: AgentRow, tools: AgentToolRow[], conversationId: string) {
  const admin = createServiceClient();

  // Mid-run steering: if a run is already in flight for this conversation, DON'T
  // start a competing one. The user's message is already persisted; the running
  // tick loop will fold it in on its next tick (see the sync block in
  // runMissionTick). This lets you correct/add to the task while it works.
  const { data: activeState } = await admin
    .from("internal_agent_run_state").select("run_id").eq("conversation_id", conversationId).limit(1);
  if (activeState && activeState.length > 0) {
    return jsonResponse({ ok: true, run_id: activeState[0].run_id, injected: true });
  }

  // Create a lightweight run so tool calls are logged and visible in real-time.
  const { data: chatRun } = await admin.from("internal_agent_runs").insert({
    agent_id: agent.id,
    workspace_id: agent.workspace_id,
    project_id: agent.project_id,
    status: "running",
    started_at: new Date().toISOString(),
    triggered_via: "chat",
  }).select("id").single();
  const chatRunId = chatRun?.id ?? null;
  if (!chatRunId) return jsonResponse({ ok: false, error: "could not create chat run" }, { status: 500 });

  // Build the initial messages + plan, persist resumable state and enqueue the
  // FIRST tick — synchronously, so the enqueue is guaranteed before we respond
  // (init is light: one planning call + an upsert). The long tool loop then runs
  // across many short ticks (runMissionTick handles chat too), never bounded by
  // the Edge wall-clock that used to kill long chats and orphan the run.
  await initChatRun(admin, agent, tools, conversationId, chatRunId);
  return jsonResponse({ ok: true, run_id: chatRunId, queued: true });
}

async function initChatRun(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  tools: AgentToolRow[],
  conversationId: string,
  chatRunId: string,
): Promise<void> {
 try {
  const { data: history } = await admin
    .from("internal_agent_messages")
    .select("role, content, tool_calls")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(30);

  const runtimeConfig = await loadRuntimeConfig(admin);
  const ctx = makeToolContext({ admin, agent, runId: chatRunId, missionId: null, conversationId, runtimeConfig });
  // Circuit breaker (chat = graceful degrade): if the sandbox is down, strip the
  // execution tools for this turn and tell the model why, instead of letting it
  // grind against a dead tunnel.
  let sandboxDownNote = "";
  if (ctx.sandboxUrl) {
    const probe = await probeSandbox(ctx.sandboxUrl);
    if (probe) {
      ctx.sandboxUrl = null;
      sandboxDownNote = `\n\nNOTE INFRA: the execution sandbox is currently OFFLINE (${probe}) — execution tools are unavailable for this turn. If the user asks for execution work, answer that the local infra must be relaunched first (scripts/start-agents-infra.ps1) and do NOT attempt workarounds via meta-tools.`;
      await ctx.logEvent("status", { message: `Sandbox hors-ligne (${probe}) — outils d'exécution désactivés pour ce tour.` }).catch(() => {});
    }
  }
  // Same graceful-degrade for RUNNER mode: strip the machine/browser tools this
  // turn if the self-hosted runner is unreachable, instead of grinding.
  if (ctx.runnerEnabled && ctx.runnerUrl) {
    const probe = await probeRunner(ctx.runnerUrl);
    if (probe) {
      ctx.runnerEnabled = false;
      ctx.runnerUrl = null;
      sandboxDownNote += `\n\nNOTE INFRA: the self-hosted runner is currently OFFLINE (${probe}) — browser/shell/code/file tools are unavailable for this turn. If the user asks for execution work, answer that the runner must be relaunched first (scripts/start-agents-infra.ps1) and do NOT attempt workarounds via meta-tools.`;
      await ctx.logEvent("status", { message: `Runner hors-ligne (${probe}) — outils d'exécution désactivés pour ce tour.` }).catch(() => {});
    }
  }
  // Semantic memory recall keyed on the user's latest message.
  const lastUserText = String([...(history ?? [])].reverse().find((m) => m.role === "user")?.content ?? "");
  const [memorySection, teamMemorySection, chatSkills, recentWorkSection] = await Promise.all([
    loadMemorySection(admin, agent.id, lastUserText || undefined),
    loadTeamMemorySection(admin, agent.project_id),
    loadActivatedSkills(admin, agent.id),
    loadRecentWorkSection(admin, agent.id),
  ]);
  ctx.skills = chatSkills;
  const { defs, capabilitySummary } = buildInternalToolset(tools, ctx);
  const chatSkillIndex = skillsIndex(chatSkills);

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(agent, capabilitySummary + sandboxDownNote, "chat", memorySection, teamMemorySection, chatSkillIndex, recentWorkSection) },
    ...(history ?? [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        // Surface what an assistant turn actually DID (tool names) so a later
        // "continue" can resume instead of restarting — chat history otherwise
        // drops the tool_calls and the agent forgets its own progress.
        const tcs = Array.isArray((m as any).tool_calls) ? (m as any).tool_calls : [];
        const names = [...new Set(tcs.map((t: any) => t?.name).filter(Boolean))];
        const note = m.role === "assistant" && names.length ? `\n\n[tools used this turn: ${names.join(", ")}]` : "";
        return { role: m.role as "user" | "assistant", content: (m.content ?? "") + note };
      }),
  ];
  if (messages.length === 1) messages.push({ role: "user", content: "Greet the user." });

  await ctx.logEvent("status", { message: "Chat started — thinking…" });

  const provider = providerFor(agent);

  // Plan-first (chat): for a substantive request, reason and draft an ordered
  // plan before acting. Skipped for greetings / very short turns so quick Q&A
  // stays snappy.
  const lastUserMsg = String([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
  // "continue"/"poursuis"/… are short but DO need a (resume-aware) plan.
  const isContinuation = /^\s*(continue|continu|poursuis|reprends?|resume|go on|keep going|next|suite|encore|vas[-\s]?y|ok\b)/i.test(lastUserMsg.trim());
  if ((lastUserMsg.trim().length >= 24 || isContinuation) && lastUserMsg !== "Greet the user.") {
    if (chatRunId) await ctx.logEvent("status", { message: "Reasoning & planning…" });
    // On a continuation, give the planner the prior reply so it resumes the
    // unfinished work rather than restarting from scratch.
    const prevReply = isContinuation ? String([...(history ?? [])].reverse().find((m: any) => m.role === "assistant")?.content ?? "") : "";
    const progressNote = prevReply ? `\n\n# Work already underway in this conversation (RESUME — do not restart)\nYour previous turn:\n${prevReply.slice(0, 1800)}` : "";
    const planContext = [memorySection, teamMemorySection].filter(Boolean).join("\n\n") + progressNote;
    const planTask = isContinuation
      ? `${lastUserMsg}\n\n(The user is asking you to CONTINUE the task already underway in this conversation. Plan ONLY the remaining steps — first verify what already exists on disk, then resume from the first unfinished step.)`
      : lastUserMsg;
    const toolDefs = defs.map((d) => ({ name: d.function.name, description: d.function.description }));
    const planned = await produceExecutionPlan({ provider, agent, toolDefs, taskText: planTask, contextText: planContext });
    if (planned) {
      if (chatRunId) await ctx.logEvent("plan", { plan: planned.plan, markdown: planned.markdown });
      messages.push(...planMessages(planned.markdown, "chat"));
      // Seed the structured todo checklist (live UI + maintained via update_todos).
      const todos = planned.plan.tasks.map((t, i) => ({
        id: t.id, title: t.title.slice(0, 140), status: i === 0 ? "active" : "pending",
      }));
      await admin.from("internal_agent_runs").update({ todos }).eq("id", chatRunId);
      if (chatRunId) await ctx.logEvent("todos", { todos });
    }
  }

  // Persist resumable state + enqueue the first tick. The tool loop now runs in
  // the durable tick processor (runMissionTick handles chat too), so a long chat
  // survives Edge wall-clock recycling instead of being killed mid-run.
  await admin.from("internal_agent_run_state").upsert({
    run_id: chatRunId,
    mode: "chat",
    agent_id: agent.id,
    conversation_id: conversationId,
    mission_id: null,
    messages,
    round: 0,
    max_rounds: 400,
    provider,
    model: Deno.env.get("AGENT_MODEL_CHAT") || null,
    processing_until: null,
    // The triggering message is already in `messages`; only fold in turns that
    // arrive AFTER this point (mid-run steering).
    last_input_at: new Date().toISOString(),
  });
  await admin.rpc("agent_tick_enqueue", { p_run_id: chatRunId });
  return;
 } catch (e) {
   // Any unexpected failure in the background worker: mark the run failed and
   // post an error reply so the client's poll terminates (not stuck "running").
   const msg = e instanceof Error ? e.message : String(e);
   if (chatRunId) await admin.from("internal_agent_runs").update({ status: "failed", finished_at: new Date().toISOString(), error_message: msg.slice(0, 500) }).eq("id", chatRunId).then(() => {}, () => {});
   await admin.from("internal_agent_messages").insert({ conversation_id: conversationId, agent_id: agent.id, role: "assistant", content: `⚠️ Le run a échoué : ${msg.slice(0, 400)}` }).then(() => {}, () => {});
   await admin.from("internal_agent_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId).then(() => {}, () => {});
 }
}

// ---------------------------------------------------------------------------
// Mission mode
// ---------------------------------------------------------------------------

async function runMission(agent: AgentRow, tools: AgentToolRow[], runId: string) {
  const admin = createServiceClient();

  const { data: run } = await admin
    .from("internal_agent_runs")
    .select("id, mission_id, status")
    .eq("id", runId)
    .maybeSingle();
  if (!run) throw new Error("Run not found");
  // Idempotence: only a queued run may start (double invocations are no-ops).
  if (run.status !== "queued") {
    return jsonResponse({ ok: false, error: `Run is ${run.status}, not queued` }, { status: 409 });
  }

  const { data: mission } = await admin
    .from("internal_agent_missions")
    .select("id, title, brief, acceptance_criteria, expected_deliverables, schedule, report_back_to_agent, delegation_depth")
    .eq("id", run.mission_id)
    .maybeSingle();
  if (!mission) throw new Error("Mission not found");

  await admin
    .from("internal_agent_runs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", runId);
  // Kanban: a running mission sits in "in_progress".
  await admin
    .from("internal_agent_missions")
    .update({ board_column: "in_progress" })
    .eq("id", run.mission_id)
    .in("board_column", ["backlog", "todo"]);

  const runtimeConfig = await loadRuntimeConfig(admin);
  const ctx = makeToolContext({ admin, agent, runId, missionId: mission.id, delegationDepth: (mission as { delegation_depth?: number }).delegation_depth ?? 0, runtimeConfig });

  // Circuit breaker (missions = HARD FAIL): a mission whose agent runs in
  // sandbox mode exists to EXECUTE. If the sandbox is unreachable, fail in
  // seconds with an actionable ops message instead of grinding for hours
  // (the 03/07 incident: 100% tool failure → 269 self-spawned missions).
  if (ctx.sandboxUrl) {
    const probe = await probeSandbox(ctx.sandboxUrl);
    if (probe) {
      const msg = `${SANDBOX_DOWN_MSG} (diagnostic: ${probe})`;
      await ctx.logEvent("error", { error: msg });
      await admin.from("internal_agent_runs").update({
        status: "failed", finished_at: new Date().toISOString(), error_message: msg.slice(0, 500),
      }).eq("id", runId);
      await admin.from("internal_agent_missions").update({ board_column: "todo" })
        .eq("id", mission.id).eq("board_column", "in_progress");
      await autoSaveMemory(admin, agent, runId, {
        kind: "learning", importance: 3, dedupePrefix: "Sandbox down:",
        content: `Sandbox down: run de la mission "${mission.title}" échoué le ${new Date().toISOString().slice(0, 10)} — sandbox injoignable (${probe}). L'infra locale doit être relancée (start-agents-infra.ps1) avant toute mission d'exécution.`,
      });
      await postMissionReportToChannel(admin, mission.id, msg).catch(() => {});
      return jsonResponse({ ok: false, error: "sandbox unreachable", detail: probe });
    }
  }
  // Same HARD-FAIL for RUNNER-mode missions: no runner → no execution, fail fast.
  if (ctx.runnerEnabled && ctx.runnerUrl) {
    const probe = await probeRunner(ctx.runnerUrl);
    if (probe) {
      const msg = `${RUNNER_DOWN_MSG} (diagnostic: ${probe})`;
      await ctx.logEvent("error", { error: msg });
      await admin.from("internal_agent_runs").update({
        status: "failed", finished_at: new Date().toISOString(), error_message: msg.slice(0, 500),
      }).eq("id", runId);
      await admin.from("internal_agent_missions").update({ board_column: "todo" })
        .eq("id", mission.id).eq("board_column", "in_progress");
      await autoSaveMemory(admin, agent, runId, {
        kind: "learning", importance: 3, dedupePrefix: "Runner down:",
        content: `Runner down: run de la mission "${mission.title}" échoué le ${new Date().toISOString().slice(0, 10)} — runner injoignable (${probe}). La machine self-hosted doit être relancée (start-agents-infra.ps1) avant toute mission d'exécution.`,
      });
      await postMissionReportToChannel(admin, mission.id, msg).catch(() => {});
      return jsonResponse({ ok: false, error: "runner unreachable", detail: probe });
    }
  }

  // Semantic memory recall keyed on the mission itself (title + brief).
  const missionTaskText = `${mission.title ?? ""}\n${(mission as { brief?: string | null }).brief ?? ""}`.trim();
  const [memorySection, teamMemorySection, missionSkills] = await Promise.all([
    loadMemorySection(admin, agent.id, missionTaskText || undefined),
    loadTeamMemorySection(admin, agent.project_id),
    loadActivatedSkills(admin, agent.id),
  ]);
  ctx.skills = missionSkills;
  const { defs, capabilitySummary } = buildInternalToolset(tools, ctx);
  await ctx.logEvent("log", { message: `Run started (ticked) — budget: ${agent.max_steps} steps, $${agent.max_run_cost_usd}` });

  const skillPrompts = skillsIndex(missionSkills);

  // Continuity for re-runs: the last runs of this mission — successes to build
  // on, failures so the agent doesn't retry an approach that already failed.
  const { data: prevRuns } = await admin
    .from("internal_agent_runs")
    .select("finished_at, status, final_output, error_message")
    .eq("mission_id", mission.id)
    .in("status", ["succeeded", "failed"])
    .neq("id", runId)
    .order("created_at", { ascending: false })
    .limit(3);
  let previousRunSection = "";
  if (prevRuns && prevRuns.length > 0) {
    const parts = (prevRuns as Array<{ finished_at: string | null; status: string; final_output: string | null; error_message: string | null }>).map((r) => {
      const head = `### ${r.status === "succeeded" ? "✅ Succès" : "❌ Échec"} — ${String(r.finished_at ?? "").slice(0, 16)}`;
      const err = r.status === "failed" ? `\nErreur: ${String(r.error_message ?? "inconnue").slice(0, 300)}` : "";
      const body = String(r.final_output ?? "").slice(0, 1200);
      return `${head}${err}${body ? `\n${body}` : ""}`;
    });
    previousRunSection = `\n## Previous runs of this mission (newest first)\nDo NOT redo what already succeeded; do NOT retry an approach that already failed the same way.\n${parts.join("\n\n")}\n`;
  }

  const deliverablesSpec = (Array.isArray(mission.expected_deliverables) ? mission.expected_deliverables : [])
    .map((d: { kind: string; name: string; description?: string }) =>
      `- ${d.kind}: ${d.name}${d.description ? ` — ${d.description}` : ""}`)
    .join("\n");

  const userPrompt = `# Mission: ${mission.title}

## Brief
${mission.brief ?? "(no brief provided)"}

${mission.acceptance_criteria ? `## Acceptance criteria\n${mission.acceptance_criteria}\n` : ""}
${deliverablesSpec ? `## Expected deliverables\n${deliverablesSpec}\n` : ""}${previousRunSection}
Execute this mission now. Use your tools to gather what you need, save each expected deliverable with create_deliverable, then write your final mission report.`;

  const provider = providerFor(agent);

  // Plan-first: the agent reasons about the goal and drafts an ordered task
  // plan (tools per task + how) BEFORE executing. Logged as a `plan` event and
  // injected into the loop so the agent commits to its own plan.
  await ctx.logEvent("status", { message: "Reasoning & planning the mission…" });
  const planContext = [memorySection, teamMemorySection, previousRunSection].filter(Boolean).join("\n\n");
  const toolDefs = defs.map((d) => ({ name: d.function.name, description: d.function.description }));
  const planned = await produceExecutionPlan({ provider, agent, toolDefs, taskText: userPrompt, contextText: planContext });
  if (planned) {
    await ctx.logEvent("plan", { plan: planned.plan, markdown: planned.markdown });
    // Seed the STRUCTURED todo checklist from the plan (the UI renders this
    // live; the agent maintains it with update_todos).
    const todos = planned.plan.tasks.map((t, i) => ({
      id: t.id, title: t.title.slice(0, 140), status: i === 0 ? "active" : "pending",
    }));
    await admin.from("internal_agent_runs").update({ todos }).eq("id", runId);
    await ctx.logEvent("todos", { todos });
  }

  // Persist the initial conversation as resumable state and enqueue the FIRST
  // tick. The long loop then runs across many short ticks (runMissionTick),
  // never bounded by the Edge wall-clock.
  const initialMessages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(agent, capabilitySummary, "mission", memorySection, teamMemorySection, skillPrompts) },
    { role: "user", content: userPrompt },
    ...(planned ? planMessages(planned.markdown, "mission") : []),
  ];
  await admin.from("internal_agent_run_state").upsert({
    run_id: runId,
    mode: "mission",
    agent_id: agent.id,
    mission_id: mission.id,
    messages: initialMessages,
    round: 0,
    // No real round limit — the mission stops only when the task is verified
    // done. This is just an absolute backstop against a truly runaway loop.
    max_rounds: 400,
    provider,
    model: Deno.env.get("AGENT_MODEL_MISSION") || null,
    processing_until: null,
  });
  await admin.rpc("agent_tick_enqueue", { p_run_id: runId });
  return jsonResponse({ ok: true, run_id: runId, queued: true });
}

// Finalize a successful (or budget-exhausted) mission: deliverable safety net,
// run → succeeded, kanban → review, scheduling, delegation report-back, usage.
// Deterministic, best-effort memory write — so the agent's memory populates
// from real lifecycle events instead of only when the model remembers to call
// save_memory. `dedupePrefix` replaces any prior memory with that prefix so a
// recurring mission keeps ONE up-to-date entry instead of piling up.
async function autoSaveMemory(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  runId: string | null,
  opts: { kind: "fact" | "preference" | "learning" | "context"; content: string; importance?: number; dedupePrefix?: string },
) {
  const content = opts.content.replace(/\s+/g, " ").trim().slice(0, 600);
  if (!content) return;
  try {
    if (opts.dedupePrefix) {
      const esc = opts.dedupePrefix.replace(/[%_]/g, (m) => `\\${m}`);
      await admin.from("internal_agent_memories").delete().eq("agent_id", agent.id).ilike("content", `${esc}%`);
    }
    const { count } = await admin
      .from("internal_agent_memories")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agent.id);
    if ((count ?? 0) >= 300) return; // respect the cap silently
    await admin.from("internal_agent_memories").insert({
      agent_id: agent.id, workspace_id: agent.workspace_id, project_id: agent.project_id,
      kind: opts.kind, content, importance: opts.importance ?? 3,
      source: "agent", source_run_id: runId,
      embedding: await embedMemoryVector(content),
    });
  } catch { /* best-effort: never block finalization on memory */ }
}

async function finalizeMissionSuccess(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  runId: string,
  mission: { id: string; title?: string; schedule?: string | null; report_back_to_agent?: string | null },
  finalOutput: string,
  stats: { tokIn: number; tokOut: number; cost: number; actions: number; provider: "groq" | "deepseek"; model: string },
) {
  const { count } = await admin
    .from("internal_agent_deliverables")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId);
  if (!count) {
    await admin.from("internal_agent_deliverables").insert({
      run_id: runId, mission_id: mission.id, agent_id: agent.id, kind: "markdown",
      name: "Mission output", content: finalOutput,
      summary: finalOutput.replace(/[#*`>_\n]+/g, " ").trim().slice(0, 200) || null,
    });
  }
  await admin.from("internal_agent_runs").update({
    status: "succeeded", finished_at: new Date().toISOString(), final_output: finalOutput,
    tokens_in: stats.tokIn, tokens_out: stats.tokOut, cost_usd: stats.cost,
    action_count: stats.actions, steps: stats.actions,
  }).eq("id", runId);
  await completeRunTodos(admin, runId);

  const missionUpdate: Record<string, unknown> = { last_run_at: new Date().toISOString() };
  if (mission.schedule) missionUpdate.next_run_at = nextRunAt(mission.schedule, new Date());
  await admin.from("internal_agent_missions").update(missionUpdate).eq("id", mission.id);
  await admin.from("internal_agent_missions").update({ board_column: "review" }).eq("id", mission.id).eq("board_column", "in_progress");

  // Consign the mission outcome to the agent's persistent memory so future
  // sessions know what was done, what it produced, and the key conclusion.
  try {
    const title = mission.title ?? "mission";
    const { data: delivs } = await admin
      .from("internal_agent_deliverables").select("name").eq("run_id", runId).limit(8);
    const delivList = (delivs ?? []).map((d: any) => d.name).filter(Boolean).join(", ");
    const summary = finalOutput.replace(/[#*`>_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    await autoSaveMemory(admin, agent, runId, {
      kind: "context",
      importance: 4,
      dedupePrefix: `Mission "${title}"`,
      content: `Mission "${title}" — completed ${new Date().toISOString().slice(0, 10)}.${summary ? ` Result: ${summary}` : ""}${delivList ? ` · Deliverables: ${delivList}.` : ""}`,
    });
  } catch { /* best-effort */ }

  if (mission.report_back_to_agent) {
    try {
      const [a, b] = [agent.id, mission.report_back_to_agent as string].sort();
      let threadId: string;
      const { data: existing } = await admin.from("internal_agent_a2a_threads").select("id").eq("agent_a", a).eq("agent_b", b).maybeSingle();
      if (existing) threadId = (existing as { id: string }).id;
      else {
        const { data: created } = await admin.from("internal_agent_a2a_threads")
          .insert({ workspace_id: agent.workspace_id, project_id: agent.project_id, agent_a: a, agent_b: b, topic: `Re: ${mission.title}` })
          .select("id").single();
        threadId = (created as { id: string }).id;
      }
      const { data: rb } = await admin.from("internal_agent_a2a_messages").insert({
        thread_id: threadId, workspace_id: agent.workspace_id, project_id: agent.project_id,
        from_agent: agent.id, to_agent: mission.report_back_to_agent,
        content: `Delegated mission "${mission.title}" complete. Report:\n\n${finalOutput.slice(0, 3500)}`,
      }).select("id").single();
      if (rb) {
        const base = Deno.env.get("SUPABASE_URL"); const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
        if (base && key) {
          fetch(`${base}/functions/v1/internal-agent-a2a`, {
            method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ message_id: (rb as { id: string }).id }),
          }).catch(() => {});
        }
      }
    } catch { /* best-effort */ }
  }

  await logLlmUsage({
    workspace_id: agent.workspace_id, project_id: agent.project_id,
    provider: stats.provider, model: stats.model,
    task: "content_generation", feature: "internal-agent-mission",
    usage: { prompt_tokens: stats.tokIn, completion_tokens: stats.tokOut, total_tokens: stats.tokIn + stats.tokOut },
  });
  // If the mission was created from a channel (e.g. a Slack "mission: …"), post
  // the completion report back into that thread.
  await postMissionReportToChannel(admin, mission.id, finalOutput);
}

// Post a mission's completion report to its bound channel (Slack thread).
async function postMissionReportToChannel(
  admin: ReturnType<typeof createServiceClient>,
  missionId: string,
  report: string,
) {
  try {
    const { data: m } = await admin
      .from("internal_agent_missions")
      .select("title, channel_id, external_channel_ref, external_thread_ref")
      .eq("id", missionId).maybeSingle();
    if (!m?.channel_id || !m.external_channel_ref) return;
    const { data: tok } = await admin
      .from("internal_agent_channel_tokens").select("access_token").eq("channel_id", m.channel_id).maybeSingle();
    if (!tok?.access_token) return;
    const body = report.replace(/[#*`>_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 2500);
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        channel: m.external_channel_ref,
        thread_ts: m.external_thread_ref || undefined,
        text: `✅ Mission *${m.title}* terminée.\n\n${body}\n\n_(Livrables complets dans l'onglet Deliverables.)_`,
      }),
    }).catch(() => {});
  } catch { /* best-effort */ }
}

// Post an agent reply back to whatever channel the conversation is bound to: an
// external Slack thread and/or an in-app project-inbox channel. Best-effort — a
// channel failure must never block finalization.
async function postReplyToBoundChannel(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  conversationId: string,
  text: string,
) {
  try {
    const { data: convo } = await admin
      .from("internal_agent_conversations")
      .select("channel_id, external_channel_ref, external_thread_ref, inbox_channel_id, workspace_id, project_id")
      .eq("id", conversationId).maybeSingle();
    if (!convo) return;

    // In-app project-inbox mirror (repairs the async-chat regression).
    if (convo.inbox_channel_id) {
      await admin.from("project_messages").insert({
        workspace_id: convo.workspace_id, project_id: convo.project_id,
        channel_id: convo.inbox_channel_id, author_kind: "agent", agent_id: agent.id,
        body: text.slice(0, 12000),
      }).then(() => {}, () => {});
    }

    // External channel (Slack thread).
    if (convo.channel_id && convo.external_channel_ref) {
      const [{ data: ch }, { data: tok }] = await Promise.all([
        admin.from("internal_agent_channels").select("provider").eq("id", convo.channel_id).maybeSingle(),
        admin.from("internal_agent_channel_tokens").select("access_token").eq("channel_id", convo.channel_id).maybeSingle(),
      ]);
      if (ch?.provider === "slack" && tok?.access_token) {
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            channel: convo.external_channel_ref,
            thread_ts: convo.external_thread_ref || undefined,
            text: text.slice(0, 3500),
          }),
        }).catch(() => {});
      }
    }
  } catch { /* best-effort */ }
}

// Mark the run's todo checklist complete on a successful finish (blocked items
// keep their status — they tell the story of what didn't work).
async function completeRunTodos(
  admin: ReturnType<typeof createServiceClient>,
  runId: string,
) {
  try {
    const { data: r } = await admin.from("internal_agent_runs").select("todos").eq("id", runId).maybeSingle();
    const todos = Array.isArray(r?.todos) ? (r!.todos as Array<Record<string, unknown>>) : [];
    if (!todos.length) return;
    const done = todos.map((t) => ({ ...t, status: t.status === "blocked" ? "blocked" : "done" }));
    await admin.from("internal_agent_runs").update({ todos: done }).eq("id", runId);
  } catch { /* best-effort */ }
}

// Finalize a chat run: post the assistant reply, mark the run succeeded and
// bump the conversation. The chat equivalent of finalizeMissionSuccess.
async function finalizeChatSuccess(
  admin: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  conversationId: string,
  runId: string,
  finalOutput: string,
  stats: { tokIn: number; tokOut: number; cost: number; actions: number; provider: "groq" | "deepseek"; model: string },
) {
  const reply = finalOutput?.trim() || "(no reply)";
  await admin.from("internal_agent_messages").insert({
    conversation_id: conversationId, agent_id: agent.id, role: "assistant",
    content: reply, run_id: runId,
    tokens_in: stats.tokIn, tokens_out: stats.tokOut, cost_usd: stats.cost,
  });
  await completeRunTodos(admin, runId);
  await admin.from("internal_agent_runs").update({
    status: "succeeded", finished_at: new Date().toISOString(), final_output: finalOutput?.slice(0, 2000),
    tokens_in: stats.tokIn, tokens_out: stats.tokOut, cost_usd: stats.cost,
    action_count: stats.actions, steps: stats.actions,
  }).eq("id", runId);
  await admin.from("internal_agent_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  // Mirror the reply to any bound channel (Slack thread / project inbox).
  await postReplyToBoundChannel(admin, agent, conversationId, reply);
  await logLlmUsage({
    workspace_id: agent.workspace_id, project_id: agent.project_id,
    provider: stats.provider, model: stats.model, task: "chat_simple", feature: "internal-agent-chat",
    usage: { prompt_tokens: stats.tokIn, completion_tokens: stats.tokOut, total_tokens: stats.tokIn + stats.tokOut },
  });
}

// ── Context compaction ────────────────────────────────────────────────────────
// run_state.messages grows across hundreds of rounds while DeepSeek's context is
// finite (~64k tokens). When the transcript gets heavy, summarize the MIDDLE
// (keeping the system prompt + mission brief/plan head, and the recent tail
// intact) into one dense "work so far" note. Mutates `messages` in place.
const COMPACT_TRIGGER_CHARS = 120_000; // ≈ 35–45k tokens
async function compactMessagesIfNeeded(messages: ChatMessage[]): Promise<boolean> {
  if (messages.length < 16) return false;
  if (JSON.stringify(messages).length < COMPACT_TRIGGER_CHARS) return false;
  const keepHead = Math.min(4, messages.length); // system + task + plan pair
  let start = messages.length - 10;              // keep the last ~10 turns verbatim
  // Never split an assistant(tool_calls) from its tool results: walk back until
  // the tail starts on a non-tool message (i.e. include the calling assistant).
  while (start > keepHead && messages[start].role === "tool") start--;
  if (start <= keepHead + 2) return false;
  const middle = messages.slice(keepHead, start);
  const transcript = middle.map((m) => {
    const calls = m.tool_calls?.map((t) => `${t.function.name}(${(t.function.arguments ?? "").slice(0, 120)})`).join("; ");
    const body = String(m.content ?? calls ?? "").slice(0, m.role === "tool" ? 300 : 500);
    return `${m.role}: ${body}`;
  }).join("\n");
  const sum = await callAi({
    task: "summary",
    provider: "groq",
    maxTokens: 1200,
    systemPrompt:
      "You compress an AI agent's working history mid-run. Produce a DENSE, factual summary the agent can rely on to continue without redoing work: goal & plan status; steps DONE (exact file paths created, commands run, key results/numbers/URLs); current state; errors hit and how they were fixed; what remains. Bullet points, no fluff.",
    userPrompt: transcript.slice(0, 60_000),
  });
  messages.splice(keepHead, start - keepHead, {
    role: "user",
    content: `[CONTEXT COMPACTED — reliable summary of YOUR OWN earlier work in this run. Trust it; do NOT redo completed steps.]\n${sum.content}`,
  });
  return true;
}

// ── Mission self-verification ─────────────────────────────────────────────────
// Before finalizing a mission, have a fast reviewer check the outcome against
// the brief/acceptance criteria and the deliverables actually produced. A FAIL
// feeds concrete gaps back into the loop instead of shipping a partial result.
async function verifyMissionOutcome(
  admin: ReturnType<typeof createServiceClient>,
  runId: string,
  mission: { title?: string; brief?: string | null; acceptance_criteria?: string | null } | null,
  finalOutput: string,
): Promise<{ pass: boolean; feedback: string } | null> {
  if (!mission?.brief && !mission?.acceptance_criteria) return null; // nothing to check against
  const { data: delivs } = await admin
    .from("internal_agent_deliverables").select("kind, name, content, file_url")
    .eq("run_id", runId).limit(12);
  const delivList = (delivs ?? [])
    .map((d: any) => `- [${d.kind}] ${d.name} — ${d.content ? `${String(d.content).length} chars` : d.file_url ? d.file_url : "empty"}`)
    .join("\n") || "(no deliverables produced)";
  const res = await callAi({
    task: "classification",
    provider: "groq",
    jsonMode: true,
    maxTokens: 500,
    systemPrompt:
      'You are a strict QA reviewer for an autonomous agent\'s mission. Decide if the mission is genuinely COMPLETE. PASS only if the final report answers the brief AND every acceptance criterion is satisfied AND the expected deliverables exist (non-empty). Reply as JSON: {"verdict":"pass"|"fail","missing":"short concrete list of what is missing or wrong"}.',
    userPrompt: `MISSION: ${mission.title ?? ""}\n\nBRIEF:\n${(mission.brief ?? "").slice(0, 2000)}\n\nACCEPTANCE CRITERIA:\n${(mission.acceptance_criteria ?? "(none stated)").slice(0, 1200)}\n\nDELIVERABLES PRODUCED:\n${delivList}\n\nFINAL REPORT:\n${finalOutput.slice(0, 3500)}`,
  });
  const j = safeParseJson<{ verdict?: string; missing?: string }>(res.content);
  if (!j?.verdict) return null;
  return { pass: j.verdict.toLowerCase() === "pass", feedback: String(j.missing ?? "").slice(0, 800) };
}

const TICK_ROUNDS = 4;

// Process ONE tick of a mission: lease, run a few rounds against persisted
// state, then finalize / re-enqueue. Invoked by the pg_cron drainer via pg_net.
async function runMissionTick(runId: string, msgId: number | null) {
  const admin = createServiceClient();

  // Lease the state so two deliveries can't process the same run at once.
  const nowIso = new Date().toISOString();
  const { data: leased } = await admin
    .from("internal_agent_run_state")
    .update({ processing_until: new Date(Date.now() + 3 * 60 * 1000).toISOString() })
    .eq("run_id", runId)
    .or(`processing_until.is.null,processing_until.lt.${nowIso}`)
    .select("*")
    .maybeSingle();
  if (!leased) {
    if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
    return jsonResponse({ ok: true, skipped: true });
  }
  const state = leased as {
    run_id: string; agent_id: string; mission_id: string | null; conversation_id: string | null; mode: string;
    messages: ChatMessage[];
    round: number; max_rounds: number; provider: string | null; model: string | null;
    tokens_in: number; tokens_out: number; cost_usd: number; last_input_at: string | null;
    error_count: number; replans: number; verify_fails: number; meta: Record<string, unknown> | null;
  };
  const isChat = state.mode === "chat" || !state.mission_id;

  // Run no longer active? clean up.
  const { data: runRow } = await admin.from("internal_agent_runs").select("status").eq("id", runId).maybeSingle();
  if (!runRow || ["cancelled", "failed", "succeeded"].includes(runRow.status as string)) {
    await admin.from("internal_agent_run_state").delete().eq("run_id", runId);
    if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
    return jsonResponse({ ok: true, done: true });
  }

  const { agent, tools } = await loadAgentAndTools(state.agent_id);
  const { data: mission } = state.mission_id
    ? await admin.from("internal_agent_missions")
        .select("id, title, brief, acceptance_criteria, schedule, report_back_to_agent, delegation_depth")
        .eq("id", state.mission_id).maybeSingle()
    : { data: null };
  const runtimeConfig = await loadRuntimeConfig(admin);
  const ctx = makeToolContext({ admin, agent, runId, missionId: state.mission_id, conversationId: state.conversation_id, delegationDepth: (mission as { delegation_depth?: number } | null)?.delegation_depth ?? 0, runtimeConfig });
  ctx.skills = await loadActivatedSkills(admin, agent.id);
  const { defs, executor } = buildInternalToolset(tools, ctx);
  // Compact long string args (file content, code, html…) so the live timeline
  // shows WHAT a call does without storing megabytes per event.
  const compactArgs = (a: any): any => {
    if (!a || typeof a !== "object") return a;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) {
      out[k] = typeof v === "string" && v.length > 700 ? `${v.slice(0, 700)}… (+${v.length - 700} chars)` : v;
    }
    return out;
  };
  const loggingExecutor: typeof executor = async (name, args) => {
    await ctx.logEvent("tool_call", { tool: name, args: compactArgs(args) });
    const r = await executor(name, args);
    const text = String(r);
    await ctx.logEvent("tool_result", { tool: name, preview: text.slice(0, 1000), ok: !text.startsWith("ERROR") });
    return r;
  };

  const messages = state.messages;

  // Mid-run steering: fold in any user messages that arrived AFTER this run last
  // synced, so a correction/addition sent while the agent works is taken into
  // account on this tick (chat runs only).
  let newLastInputAt = state.last_input_at;
  if (isChat && state.conversation_id) {
    const since = state.last_input_at ?? new Date(0).toISOString();
    const { data: fresh } = await admin
      .from("internal_agent_messages")
      .select("content, created_at").eq("conversation_id", state.conversation_id).eq("role", "user")
      .gt("created_at", since).order("created_at", { ascending: true }).limit(10);
    if (fresh && fresh.length) {
      for (const m of fresh) {
        messages.push({ role: "user", content: `[The user sent this while you were working — take it into account, adjust course if needed]\n${m.content}` });
      }
      newLastInputAt = fresh[fresh.length - 1].created_at as string;
      await ctx.logEvent("status", { message: `Nouveau message reçu en cours d'exécution — pris en compte (${fresh.length}).` }).catch(() => {});
    }
  }

  // Compact the transcript when it gets heavy (protects the model's context
  // window on long runs). Best-effort — a compaction failure never blocks work.
  try {
    if (await compactMessagesIfNeeded(messages)) {
      await ctx.logEvent("status", { message: "Contexte compacté — l'historique ancien a été résumé pour garder le fil." }).catch(() => {});
    }
  } catch { /* keep going uncompacted */ }

  try {
    const result = await runToolRounds({
      provider: (state.provider as "groq" | "deepseek") || providerFor(agent),
      model: state.model || undefined,
      messages, tools: defs, executor: loggingExecutor,
      temperature: agent.temperature, maxTokens: 4000, maxRounds: TICK_ROUNDS,
      onNotice: async (n) => { await ctx.logEvent("tool_error", { message: n.message, detail: n.detail }); },
    });

    let newRound = state.round + result.roundsRun;
    let tokIn = (state.tokens_in ?? 0) + (result.usage.prompt_tokens ?? 0);
    let tokOut = (state.tokens_out ?? 0) + (result.usage.completion_tokens ?? 0);
    let cost = Number(state.cost_usd ?? 0) + estimateCost(result.usage, result.provider);
    let finalProvider = result.provider;
    let finalModel = result.model;

    // ── FAIL-FAST: sandbox died MID-run ──────────────────────────────────────
    // 3+ consecutive "Sandbox unreachable" tool results = the tunnel/infra is
    // down. Fail with an actionable ops message instead of grinding/replanning.
    let consecUnreachable = 0;
    for (const m of messages.slice(-16)) {
      if (m.role !== "tool") continue;
      if (String(m.content ?? "").startsWith("ERROR: Sandbox unreachable")) consecUnreachable++;
      else consecUnreachable = 0;
    }
    if (consecUnreachable >= 3) {
      const msg = SANDBOX_DOWN_MSG;
      await ctx.logEvent("error", { error: msg }).catch(() => {});
      await admin.from("internal_agent_runs").update({
        status: "failed", finished_at: new Date().toISOString(), error_message: msg.slice(0, 500),
        tokens_in: tokIn, tokens_out: tokOut, cost_usd: cost, action_count: newRound,
      }).eq("id", runId);
      if (isChat && state.conversation_id) {
        await admin.from("internal_agent_messages").insert({
          conversation_id: state.conversation_id, agent_id: agent.id, role: "assistant",
          content: msg, run_id: runId,
        });
        await postReplyToBoundChannel(admin, agent, state.conversation_id, msg);
      } else if (state.mission_id) {
        await admin.from("internal_agent_missions").update({ board_column: "todo" })
          .eq("id", state.mission_id).eq("board_column", "in_progress");
      }
      await autoSaveMemory(admin, agent, runId, {
        kind: "learning", importance: 3, dedupePrefix: "Sandbox down:",
        content: `Sandbox down: run interrompu le ${new Date().toISOString().slice(0, 10)} — la sandbox est devenue injoignable en cours d'exécution. Relancer l'infra locale (start-agents-infra.ps1) avant de reprendre.`,
      });
      await admin.from("internal_agent_run_state").delete().eq("run_id", runId);
      if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
      return jsonResponse({ ok: false, failed: true, reason: "sandbox unreachable" });
    }

    // ── Adaptive control: accumulate errors, detect tool-call loops, re-plan ──
    const meta = (state.meta ?? {}) as Record<string, unknown>;
    let lastSig = typeof meta.last_sig === "string" ? meta.last_sig : "";
    let sigCount = Number(meta.sig_count) || 0;
    let loopDetected = false;
    for (const c of result.toolCalls) {
      const sig = `${c.name}:${JSON.stringify(c.args ?? {}).slice(0, 180)}`;
      if (sig === lastSig) sigCount++;
      else { lastSig = sig; sigCount = 1; }
      if (sigCount >= 4) loopDetected = true;
    }
    let errorCount = (state.error_count ?? 0) + result.errorCount;
    let replans = state.replans ?? 0;
    if (!result.finished && (errorCount >= 10 || loopDetected) && replans < 3) {
      replans++;
      await ctx.logEvent("status", {
        message: loopDetected
          ? `Boucle détectée (même appel répété) — replanification ${replans}/3.`
          : `Trop d'erreurs accumulées (${errorCount}) — replanification ${replans}/3.`,
      }).catch(() => {});
      messages.push({
        role: "user",
        content: loopDetected
          ? "STOP — you are LOOPING: you've repeated the same tool call with the same arguments several times and it is not working. Do NOT run it again. Step back and write a short REVISED plan: state why the approach fails, pick a genuinely different approach (different tool, different inputs, or split the step), then execute the new plan."
          : "STOP — you have accumulated many tool errors. Step back and RE-PLAN: list which steps of your plan are actually done, which failed and WHY (read the error messages), and write a short revised plan that works around the failures (different tool, different approach, or narrower scope). Then execute the revised plan. Do not repeat calls that already failed the same way.",
      });
      errorCount = 0;
      lastSig = ""; sigCount = 0;
    }

    const reachedBudget = newRound >= state.max_rounds;
    if (result.finished || reachedBudget) {
      let finalOutput = result.content?.trim() || "";

      // Budget hit mid-work: give a FINALIZATION allowance so the agent wraps up
      // (deliverables + summary for a mission, a clear reply for chat) instead of
      // ending empty.
      if (!result.finished && reachedBudget) {
        messages.push({ role: "user", content: isChat
          ? "STOP — you've reached your step budget. Wrap up now, nothing else: save any final artifact you produced with create_deliverable (e.g. a report, or a running app's public URL), then write a concise reply to the user that INCLUDES any public URL and key file paths produced. Do not start new exploration, downloads or training."
          : "STOP — you've reached your step budget. Do ONLY this now, nothing else: (1) create your final deliverable(s) with create_deliverable — at minimum a structured report (kind=\"report\") with the key results / KPIs / tables you've already gathered, plus any artifact already produced (e.g. a running app's public URL); (2) then write a concise final summary that INCLUDES that URL if any. Do not start new exploration, downloads or training." });
        try {
          const fin = await runToolRounds({
            provider: (state.provider as "groq" | "deepseek") || providerFor(agent),
            model: state.model || undefined,
            messages, tools: defs, executor: loggingExecutor,
            temperature: agent.temperature, maxTokens: 4000, maxRounds: 5,
            onNotice: async (n) => { await ctx.logEvent("tool_error", { message: n.message, detail: n.detail }); },
          });
          finalOutput = fin.content?.trim() || finalOutput;
          newRound += fin.roundsRun;
          tokIn += fin.usage.prompt_tokens ?? 0;
          tokOut += fin.usage.completion_tokens ?? 0;
          cost += estimateCost(fin.usage, fin.provider);
          finalProvider = fin.provider; finalModel = fin.model;
        } catch (e) {
          const nm = (e as { name?: string } | null)?.name;
          if (nm === "AwaitingInputError" || nm === "RunCancelledError") throw e;
          // Other errors during finalization: finalize with what we have.
        }
      }

      // ── Self-verification (missions only, on a natural finish) ──────────────
      // Check the outcome against the brief/criteria before shipping. A FAIL
      // feeds the concrete gaps back into the loop and the run continues.
      if (!isChat && result.finished && (state.verify_fails ?? 0) < 2) {
        const verdict = await verifyMissionOutcome(admin, runId, mission as any, finalOutput).catch(() => null);
        if (verdict && !verdict.pass) {
          await ctx.logEvent("status", { message: `Auto-vérification: ÉCHEC — ${verdict.feedback.slice(0, 200) || "critères non remplis"}. Reprise du travail.` }).catch(() => {});
          messages.push({
            role: "user",
            content: `SELF-CHECK FAILED — the mission is NOT complete. A QA review found these gaps:\n${verdict.feedback || "The acceptance criteria are not all satisfied."}\n\nFix exactly these gaps now (create the missing deliverables / correct the wrong ones), then produce your final report again.`,
          });
          await admin.from("internal_agent_run_state").update({
            messages, round: newRound, tokens_in: tokIn, tokens_out: tokOut, cost_usd: cost,
            error_count: errorCount, replans, verify_fails: (state.verify_fails ?? 0) + 1,
            meta: { ...meta, last_sig: lastSig, sig_count: sigCount },
            processing_until: null, updated_at: new Date().toISOString(), last_input_at: newLastInputAt,
          }).eq("run_id", runId);
          if (msgId != null) await admin.rpc("agent_tick_next", { p_msg_id: msgId, p_run_id: runId });
          else await admin.rpc("agent_tick_enqueue", { p_run_id: runId });
          return jsonResponse({ ok: true, verify_failed: true, continued: true });
        }
        if (verdict?.pass) await ctx.logEvent("status", { message: "Auto-vérification: OK — critères remplis." }).catch(() => {});
      }

      if (isChat) {
        if (!finalOutput) finalOutput = "Terminé — voir le détail des étapes ci-dessus.";
        await finalizeChatSuccess(admin, agent, state.conversation_id!, runId, finalOutput,
          { tokIn, tokOut, cost, actions: newRound, provider: finalProvider, model: finalModel });
      } else {
        if (!finalOutput) finalOutput = "Mission terminée — voir le détail des étapes et des livrables.";
        await finalizeMissionSuccess(admin, agent, runId, (mission ?? { id: state.mission_id }) as any, finalOutput,
          { tokIn, tokOut, cost, actions: newRound, provider: finalProvider, model: finalModel });
      }
      await admin.from("internal_agent_run_state").delete().eq("run_id", runId);
      // Race net: a message that landed during this FINAL tick (after the sync)
      // wasn't handled. Kick a fresh run so it doesn't sit unanswered.
      if (isChat && state.conversation_id) {
        const { data: pending } = await admin
          .from("internal_agent_messages").select("id")
          .eq("conversation_id", state.conversation_id).eq("role", "user")
          .gt("created_at", newLastInputAt ?? new Date(0).toISOString()).limit(1);
        if (pending && pending.length) {
          const base = Deno.env.get("SUPABASE_URL"); const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
          if (base && key) fetch(`${base}/functions/v1/internal-agent-run`, {
            method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ agent_id: agent.id, mode: "chat", conversation_id: state.conversation_id }),
          }).catch(() => {});
        }
      }
      if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
      return jsonResponse({ ok: true, finished: true, rounds: newRound });
    }

    // Not done → persist updated messages and chain the next tick atomically.
    await admin.from("internal_agent_run_state").update({
      messages, round: newRound, tokens_in: tokIn, tokens_out: tokOut, cost_usd: cost,
      error_count: errorCount, replans, meta: { ...meta, last_sig: lastSig, sig_count: sigCount },
      processing_until: null, updated_at: new Date().toISOString(), last_input_at: newLastInputAt,
    }).eq("run_id", runId);
    if (msgId != null) await admin.rpc("agent_tick_next", { p_msg_id: msgId, p_run_id: runId });
    else await admin.rpc("agent_tick_enqueue", { p_run_id: runId });
    return jsonResponse({ ok: true, rounds: newRound, continued: true });
  } catch (e) {
    if (e instanceof AwaitingInputError) {
      const q = e.options.length ? `${e.question}\n\n${e.options.map((o) => `- ${o}`).join("\n")}` : e.question;
      await admin.from("internal_agent_runs").update({
        status: "awaiting_input", finished_at: new Date().toISOString(),
        final_output: q.slice(0, 2000), pending_question: { question: e.question, options: e.options },
      }).eq("id", runId);
      if (isChat) {
        // Surface the question as the assistant's reply so the user can just answer.
        if (state.conversation_id) {
          await admin.from("internal_agent_messages").insert({ conversation_id: state.conversation_id, agent_id: agent.id, role: "assistant", content: q, run_id: runId });
          await admin.from("internal_agent_conversations").update({ updated_at: new Date().toISOString() }).eq("id", state.conversation_id);
          // If this chat came from a channel, ask the question there too.
          await postReplyToBoundChannel(admin, agent, state.conversation_id, q);
        }
      } else {
        await admin.from("internal_agent_missions").update({ board_column: "todo" }).eq("id", state.mission_id).eq("board_column", "in_progress");
      }
      await admin.from("internal_agent_run_state").delete().eq("run_id", runId);
      if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
      return jsonResponse({ ok: true, awaiting_input: true });
    }
    if (e instanceof RunCancelledError) {
      await admin.from("internal_agent_runs").update({ status: "cancelled", finished_at: new Date().toISOString() }).eq("id", runId);
      await admin.from("internal_agent_run_state").delete().eq("run_id", runId);
      if (msgId != null) await admin.rpc("agent_tick_ack", { p_msg_id: msgId });
      return jsonResponse({ ok: false, cancelled: true });
    }
    // Transient error: release the lease and DON'T ack → pgmq redelivers (the
    // #8 reconciler caps it if it never recovers).
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from("internal_agent_run_state").update({ processing_until: null }).eq("run_id", runId);
    await ctx.logEvent("error", { error: msg }).catch(() => {});
    return jsonResponse({ ok: false, error: msg }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Opportunistic zombie reconciler. The Edge runtime caps a worker's wall clock
// (~400s), so a background run whose worker was killed mid-flight would stay
// 'running' forever (and would shadow the live view's "latest run" lookup). On
// every invocation we cheaply fail any run that's been 'running' far longer than
// a worker can live — UNLESS it has a fresh tick state (mission OR chat ticks
// keep `internal_agent_run_state.updated_at` current), which means it's still
// progressing across ticks and must NOT be killed.
const ZOMBIE_RUN_MS = 12 * 60 * 1000;
async function reconcileZombieRuns(admin: ReturnType<typeof createServiceClient>) {
  try {
    const before = new Date(Date.now() - ZOMBIE_RUN_MS).toISOString();
    // Runs that are still actively ticking (state touched within the window).
    const { data: ticking } = await admin
      .from("internal_agent_run_state").select("run_id").gt("updated_at", before);
    const activeIds = (ticking ?? []).map((r: { run_id: string }) => r.run_id);
    let q = admin
      .from("internal_agent_runs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_message: "Run did not finish in time (worker timed out)." })
      .eq("status", "running")
      .lt("started_at", before);
    if (activeIds.length) q = q.not("id", "in", `(${activeIds.join(",")})`);
    await q;
  } catch { /* best-effort */ }
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Mobile companion app. Authenticated by (agent_id + secret), then dispatched on
// `action`. Uses the SAME agent + conversation store as the web chat, so memory,
// tools and past sessions are shared. Actions:
//   verify              → credentials check (registration)
//   list_conversations  → the agent's recent conversations
//   get_messages        → messages of a conversation (+ whether a run is running)
//   send                → append the user message and run the real agentic chat
// Body: { agent_id, secret, action?, conversation_id?, message?, verify? }
async function handleMobile(body: Record<string, unknown>): Promise<Response> {
  const admin = createServiceClient();
  const agentId = String(body.agent_id ?? "");
  const secret = String(body.secret ?? "");
  if (!agentId || !secret) {
    return jsonResponse({ error: "agent_id and secret required" }, { status: 400 });
  }

  // ── Authenticate by (agent_id, secret) ──
  const { data: sec } = await admin
    .from("internal_agents")
    .select("mobile_secret_hash, mobile_enabled, is_archived")
    .eq("id", agentId)
    .maybeSingle();
  if (!sec || sec.is_archived) return jsonResponse({ error: "unknown agent" }, { status: 404 });
  if (!sec.mobile_enabled || !sec.mobile_secret_hash) {
    return jsonResponse({ error: "mobile access is disabled for this agent" }, { status: 403 });
  }
  if ((await sha256Hex(secret)) !== sec.mobile_secret_hash) {
    return jsonResponse({ error: "invalid secret" }, { status: 401 });
  }

  const action = String(body.action ?? (body.verify ? "verify" : "send"));

  if (action === "verify") return jsonResponse({ ok: true });

  if (action === "list_conversations") {
    const { data } = await admin
      .from("internal_agent_conversations")
      .select("id, title, updated_at, created_at")
      .eq("agent_id", agentId)
      .order("updated_at", { ascending: false })
      .limit(50);
    return jsonResponse({ conversations: data ?? [] });
  }

  if (action === "get_messages") {
    const cid = String(body.conversation_id ?? "");
    if (!cid) return jsonResponse({ error: "conversation_id required" }, { status: 400 });
    const { data } = await admin
      .from("internal_agent_messages")
      .select("id, role, content, created_at, run_id")
      .eq("conversation_id", cid)
      .order("created_at", { ascending: true })
      .limit(300);
    // A run in flight for this conversation → the client keeps polling / shows "thinking".
    const { data: active } = await admin
      .from("internal_agent_run_state")
      .select("run_id")
      .eq("conversation_id", cid)
      .limit(1);
    return jsonResponse({ messages: data ?? [], running: (active ?? []).length > 0 });
  }

  if (action === "send") {
    const message = String(body.message ?? "").trim();
    if (!message) return jsonResponse({ error: "message required" }, { status: 400 });
    const { agent, tools } = await loadAgentAndTools(agentId);

    let cid = body.conversation_id ? String(body.conversation_id) : null;
    if (!cid) {
      const { data: convo } = await admin
        .from("internal_agent_conversations")
        .insert({
          agent_id: agent.id,
          workspace_id: agent.workspace_id,
          project_id: agent.project_id,
          title: message.slice(0, 60),
        })
        .select("id")
        .single();
      cid = convo?.id ?? null;
    }
    if (!cid) return jsonResponse({ error: "could not open conversation" }, { status: 500 });

    await admin.from("internal_agent_messages").insert({
      conversation_id: cid,
      agent_id: agent.id,
      role: "user",
      content: message.slice(0, 4000),
    });

    // Same agentic chat loop as the web app (tools, memory, planning) — runs in
    // the background across ticks; the reply lands in internal_agent_messages.
    const runResp = await runChat(agent, tools, cid);
    const runJson = await runResp.json().catch(() => ({}));
    return jsonResponse({ conversation_id: cid, run_id: runJson?.run_id ?? null, queued: true });
  }

  return jsonResponse({ error: "unknown mobile action" }, { status: 400 });
}

Deno.serve(async (req) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  try {
    // Reconcile stuck runs before doing anything else (best-effort, cheap).
    await reconcileZombieRuns(createServiceClient());

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const isService = token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    const body = await req.json();
    const { agent_id, mode, conversation_id, run_id, msg_id } = body as {
      agent_id?: string;
      mode?: string;
      conversation_id?: string;
      run_id?: string;
      msg_id?: number;
    };

    // Mission ticks are INTERNAL: dispatched by the pg_cron drainer via pg_net.
    // Authenticated by a dedicated shared secret (x-tick-secret) rather than the
    // service key, so it doesn't depend on the gateway/env key byte-matching.
    if (mode === "tick") {
      const tickSecret = Deno.env.get("AGENT_TICK_SECRET");
      const provided = req.headers.get("x-tick-secret");
      if (!isService && (!tickSecret || provided !== tickSecret)) {
        return jsonResponse({ error: "tick is internal-only" }, { status: 403 });
      }
      if (!run_id) return jsonResponse({ error: "run_id required for tick" }, { status: 400 });
      return await runMissionTick(run_id, typeof msg_id === "number" ? msg_id : null);
    }

    // Mobile companion app: authenticated by the agent's own (id + secret), NOT a
    // user JWT. Dispatches on body.action (verify / list_conversations /
    // get_messages / send) using the same agent + conversation store as the web.
    if (mode === "mobile" || mode === "mobile_chat") {
      return await handleMobile(body);
    }

    if (!agent_id || !mode) {
      return jsonResponse({ error: "Missing agent_id or mode" }, { status: 400 });
    }

    // Authenticated users must have access to this agent (creator or member).
    if (!isService) {
      const userClient = createUserClient(authHeader);
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
      const admin = createServiceClient();
      const { data: allowed } = await admin.rpc("has_internal_agent_access", {
        p_agent_id: agent_id,
        p_user_id: userData.user.id,
      });
      if (!allowed) return jsonResponse({ error: "Not authorized for this agent" }, { status: 403 });
    }

    const { agent, tools } = await loadAgentAndTools(agent_id);

    if (mode === "chat") {
      if (!conversation_id) return jsonResponse({ error: "conversation_id required for chat mode" }, { status: 400 });
      return await runChat(agent, tools, conversation_id);
    }
    if (mode === "mission") {
      if (!run_id) return jsonResponse({ error: "run_id required for mission mode" }, { status: 400 });
      return await runMission(agent, tools, run_id);
    }
    return jsonResponse({ error: "Unknown mode" }, { status: 400 });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : "Internal error" }, { status: 500 });
  }
});
