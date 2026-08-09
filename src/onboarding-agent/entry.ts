// Anduran onboarding co-pilot — runs page-agent's live GUI loop INSIDE the
// host page (the client's app or Anduran itself). Built into a standalone
// IIFE (public/onboarding-agent.js) that the widget injects when an agent has
// copilot onboarding on and the user opts in.
//
// The agent reads the LIVE DOM each step and drives the UI toward the
// onboarding goal. Its LLM calls are proxied through the `onboarding-agent`
// edge function (action:"llm") so NO API key ships in this bundle.
import { PageAgent } from "page-agent";
import type { PageAgentTool, PageAgentCore } from "@page-agent/core";
import * as z from "zod/v4";

// page-agent's Panel/i18n only supports en-US and zh-CN — the French content
// rides in the instructions + task (the system prompt adapts to the user's
// language), while the Panel chrome uses the nearest supported locale.
function paLang(l?: string): "en-US" | "zh-CN" {
  return l && l.startsWith("zh") ? "zh-CN" : "en-US";
}

interface StartOptions {
  /** rag_agents.public_key */
  publicKey: string;
  /** Base URL of the onboarding-agent edge function. */
  endpoint: string;
  /** Public Supabase anon key — required by the gateway on public functions. */
  anonKey?: string;
  /** Anonymous widget visitor id (mutually exclusive with userId). */
  visitorId?: string;
  /** Logged-in end-user id from the host SaaS (preferred when known). */
  userId?: string;
  language?: "fr-FR" | "en-US" | "zh-CN";
  /** Optional explicit task override; otherwise the active goal's objective. */
  task?: string;
}

// Never auto-perform irreversible actions — mirror the rule the server
// onboarding brain already enforces. Destructive labels get confirmed with the
// user instead of an auto-click.
const DESTRUCTIVE =
  /(supprim|delete|remove|effac|détru|destroy|payer|\bpay\b|achet|purchase|checkout|envoyer|\bsend\b|publier|publish|inviter|invite|désabonn|unsubscribe|resilier|cancel)/i;

let current: PageAgent | null = null;

async function post(endpoint: string, body: Record<string, unknown>, anonKey?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (anonKey) { headers["apikey"] = anonKey; headers["Authorization"] = "Bearer " + anonKey; }
  return fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
}

async function start(opts: StartOptions): Promise<void> {
  if (current) { try { current.dispose(); } catch { /* ignore */ } current = null; }

  // 1) Brief: resolve the goal-driven task + guardrail instructions + run id.
  const briefRes = await post(opts.endpoint, {
    action: "brief",
    public_key: opts.publicKey,
    ...(opts.userId ? { external_user_id: opts.userId } : { visitor_id: opts.visitorId }),
    language: opts.language,
  }, opts.anonKey);
  if (!briefRes.ok) throw new Error("onboarding brief failed: " + briefRes.status);
  const brief = (await briefRes.json()) as {
    run_id: string; task: string; system_instructions: string;
    copilot: boolean; language?: string;
  };
  const runId = brief.run_id;

  // 2) LLM proxy: page-agent's OpenAI client calls customFetch(`${baseURL}/chat/
  //    completions`, { body: <openai request> }). We ignore the URL and relay
  //    the request to our edge function, returning its raw OpenAI-shaped JSON.
  const customFetch: typeof fetch = async (_url, init) => {
    const reqBody = init?.body ? JSON.parse(init.body as string) : {};
    return post(opts.endpoint, {
      action: "llm",
      public_key: opts.publicKey,
      run_id: runId,
      messages: reqBody.messages,
      tools: reqBody.tools,
      tool_choice: reqBody.tool_choice,
      response_format: reqBody.response_format,
      temperature: reqBody.temperature,
    }, opts.anonKey);
  };

  // 3) Custom tools: progress reporting + destructive-action guardrail.
  const reportProgress: PageAgentTool = {
    description: "Report onboarding progress or completion (success when the goal is reached).",
    inputSchema: z.object({
      note: z.string().optional(),
      done: z.boolean().optional(),
      success: z.boolean().optional(),
    }),
    execute: async function (this: PageAgentCore, input: { note?: string; done?: boolean; success?: boolean }) {
      await post(opts.endpoint, {
        action: "progress", public_key: opts.publicKey, run_id: runId,
        step: input.note, done: input.done, success: input.success,
      }, opts.anonKey).catch(() => {});
      return "✅ Progress recorded.";
    },
  };

  // Override the built-in click: for destructive controls, highlight + ask the
  // user to confirm instead of auto-clicking. Non-destructive clicks fall
  // through to the normal pageController behaviour.
  const guardedClick: PageAgentTool = {
    description: "Click element by index. Destructive controls require user confirmation first.",
    inputSchema: z.object({ index: z.number().int().min(0) }),
    execute: async function (this: PageAgentCore, input: { index: number }) {
      let label = "";
      try {
        const bs = await this.pageController.getBrowserState();
        const m = (bs.content || "").match(new RegExp("\\[" + input.index + "\\]<[^>]*>([^<]*)"));
        label = (m?.[1] || "").trim();
      } catch { /* best-effort */ }

      if (DESTRUCTIVE.test(label) && this.onAskUser) {
        const answer = await this.onAskUser(
          `Cette action semble irréversible : « ${label || "?"} ». Je la fais pour vous ? (oui/non)`,
        );
        if (!/^\s*(oui|yes|o|y)\b/i.test(answer)) {
          return `Action « ${label} » annulée — l'utilisateur n'a pas confirmé.`;
        }
      }
      const result = await this.pageController.clickElement(input.index);
      return result.message;
    },
  };

  // 4) Instantiate page-agent (full PageAgent = loop + on-page Panel + mask).
  current = new PageAgent({
    model: "deepseek-chat",
    baseURL: "https://onboarding-agent.local", // ignored — customFetch owns routing
    apiKey: undefined,
    customFetch,
    language: paLang(brief.language || opts.language),
    instructions: { system: brief.system_instructions },
    customTools: {
      report_progress: reportProgress,
      // Only guard writes when the agent is actually allowed to act.
      ...(brief.copilot ? { click_element_by_index: guardedClick } : { click_element_by_index: null, input_text: null, select_dropdown_option: null }),
    },
    enableMask: true,
    maxSteps: 30,
    onAfterTask: async (_agent, result) => {
      await post(opts.endpoint, {
        action: "progress", public_key: opts.publicKey, run_id: runId,
        done: true, success: !!result.success,
      }, opts.anonKey).catch(() => {});
    },
  });

  await current.execute(opts.task || brief.task);
}

function stop(): void {
  if (current) { try { current.dispose(); } catch { /* ignore */ } current = null; }
}

declare global {
  interface Window {
    FounderOSOnboardingAgent?: { start: typeof start; stop: typeof stop };
  }
}

window.FounderOSOnboardingAgent = { start, stop };

export {};
