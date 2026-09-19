// onboarding-agent — backend for the live GUI onboarding co-pilot powered by
// page-agent (which runs its observe→act loop CLIENT-SIDE in the user's page).
// Public (resolved by rag_agents.public_key, like rag-chat / rag-onboarding-*).
// Single action-dispatch function (respects the ~100-fn cap):
//
//   { action: "brief",    public_key, visitor_id?|external_user_id?, language? }
//     → { run_id, task, system_instructions, copilot, activation_event }
//        (creates/updates a rag_onboarding_runs row)
//   { action: "llm",      public_key, run_id?, messages, tools?, tool_choice?,
//                          response_format?, model? }
//     → the RAW OpenAI-shaped DeepSeek completion (page-agent parses it natively)
//   { action: "progress", public_key, run_id, done?, success?, note?, step? }
//     → { ok } (records progress + marks the run; emits the activation event)

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { callerIp, enforceRateLimit } from "../_shared/rate-limit.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

interface RagAgent {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  persona: string | null;
  instructions: string | null;
  onboarding_enabled: boolean;
  onboarding_copilot_enabled: boolean;
}

async function resolveAgent(admin: ReturnType<typeof createServiceClient>, publicKey: string) {
  const { data } = await admin
    .from("rag_agents")
    .select("id, workspace_id, project_id, name, persona, instructions, onboarding_enabled, onboarding_copilot_enabled")
    .eq("public_key", publicKey).eq("enabled", true)
    .maybeSingle();
  return data as RagAgent | null;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = createServiceClient();
    const body = await req.json();
    const { action, public_key } = body as { action?: string; public_key?: string };
    if (!action || !public_key) {
      return jsonResponse({ error: "action and public_key required" }, { status: 400 });
    }

    const agent = await resolveAgent(admin, public_key);
    if (!agent) return jsonResponse({ error: "Unknown agent" }, { status: 404 });
    if (!agent.onboarding_enabled) return jsonResponse({ error: "Onboarding disabled" }, { status: 403 });

    // FOS-15 — surface publique et anonyme dont l'action "llm" relaie chaque
    // tour du copilote vers DeepSeek, aux frais du proprietaire de l'agent.
    // La cle publique borne le cout total, l'IP borne un visiteur isole.
    const agentLimited = await enforceRateLimit(
      { scope: "onboardingagent:agent", identity: String(public_key), limit: 200, windowSeconds: 60 },
    );
    if (agentLimited) return agentLimited;
    const visitorLimited = await enforceRateLimit(
      { scope: "onboardingagent:ip", identity: `${public_key}:${callerIp(req)}`, limit: 40, windowSeconds: 60 },
    );
    if (visitorLimited) return visitorLimited;

    // ── brief ────────────────────────────────────────────────────────────
    if (action === "brief") {
      const { visitor_id, external_user_id, language } = body as {
        visitor_id?: string; external_user_id?: string; language?: string;
      };
      if (!visitor_id && !external_user_id) {
        return jsonResponse({ error: "visitor_id or external_user_id required" }, { status: 400 });
      }

      // Active goal for this agent drives the task + guardrails.
      const { data: goal } = await admin
        .from("onboarding_goals")
        .select("id, name, objective, constraints, activation_event")
        .eq("agent_id", agent.id).eq("status", "active")
        .order("updated_at", { ascending: false })
        .limit(1).maybeSingle();

      // Optional flow-step hints (labels/bodies) to orient the agent — NOT
      // relied on for selectors (page-agent reads the live DOM itself).
      let stepHints = "";
      if (goal) {
        const { data: flow } = await admin
          .from("rag_onboarding_flows")
          .select("id").eq("goal_id", (goal as { id: string }).id).eq("lifecycle_status", "live")
          .order("version", { ascending: false }).limit(1).maybeSingle();
        if (flow) {
          const { data: steps } = await admin
            .from("rag_onboarding_steps")
            .select("title, body").eq("flow_id", (flow as { id: string }).id)
            .order("position").limit(12);
          stepHints = (steps ?? []).map((s, i) => `${i + 1}. ${(s as any).title}${(s as any).body ? " — " + (s as any).body : ""}`).join("\n");
        }
      }

      const constraints = (goal?.constraints ?? {}) as Record<string, unknown>;
      const copilot = agent.onboarding_copilot_enabled;
      const task = goal?.objective ?? "Aide l'utilisateur à démarrer et à atteindre son premier succès dans l'application.";

      const system = [
        agent.persona ?? "Tu es un guide d'onboarding intégré au produit.",
        agent.instructions ?? "",
        "",
        "## Contexte onboarding",
        `Ton objectif pour cet utilisateur : ${task}`,
        stepHints ? `Étapes indicatives (repères, pas des sélecteurs) :\n${stepHints}` : "",
        "",
        "## Règles de pilotage de l'UI",
        "- Tu agis DANS la page réelle : lis les éléments interactifs indexés et agis dessus.",
        "- Une action à la fois, explique brièvement ce que tu fais.",
        copilot
          ? "- Tu PEUX cliquer/remplir/sélectionner pour l'utilisateur (co-pilote)."
          : "- Tu ne fais que GUIDER : pointe l'élément et demande à l'utilisateur de cliquer lui-même.",
        "- N'effectue JAMAIS d'action destructive ou irréversible automatiquement (supprimer, payer, envoyer, publier, inviter-avec-frais) : mets-la en évidence et demande confirmation.",
        constraints.tone ? `- Ton : ${constraints.tone}.` : "",
        constraints.no_block ? "- Ne bloque pas l'écran ; reste discret." : "",
        "- Quand l'objectif est atteint, appelle `report_progress` avec success=true puis `done`.",
      ].filter(Boolean).join("\n");

      // Create/refresh the run.
      const { data: run } = await admin
        .from("rag_onboarding_runs")
        .insert({
          workspace_id: agent.workspace_id, project_id: agent.project_id, agent_id: agent.id,
          goal_id: goal?.id ?? null,
          visitor_id: visitor_id ?? null, external_user_id: external_user_id ?? null,
          status: "in_progress",
        })
        .select("id").single();

      return jsonResponse({
        ok: true,
        run_id: (run as { id: string } | null)?.id ?? null,
        task,
        system_instructions: system,
        copilot,
        activation_event: goal?.activation_event ?? null,
        language: language ?? "fr-FR",
      });
    }

    // ── llm (raw OpenAI-compatible passthrough to DeepSeek) ──────────────
    if (action === "llm") {
      if (Deno.env.get("LLM_GLOBAL_BLOCK") === "1") {
        return jsonResponse({ error: "LLM calls are disabled" }, { status: 503 });
      }
      const key = Deno.env.get("DEEPSEEK_API_KEY");
      if (!key) return jsonResponse({ error: "DEEPSEEK_API_KEY not configured" }, { status: 500 });

      const { messages, tools, tool_choice, response_format, model, temperature } = body as {
        messages?: unknown; tools?: unknown; tool_choice?: unknown;
        response_format?: unknown; model?: string; temperature?: number;
      };
      if (!Array.isArray(messages)) {
        return jsonResponse({ error: "messages array required" }, { status: 400 });
      }

      const upstream = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model || DEEPSEEK_MODEL,
          messages,
          ...(tools ? { tools } : {}),
          ...(tool_choice ? { tool_choice } : {}),
          ...(response_format ? { response_format } : {}),
          temperature: typeof temperature === "number" ? temperature : 0.3,
        }),
      });
      // Relay the provider's raw JSON verbatim so page-agent's OpenAIClient
      // parses it natively.
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // ── progress ─────────────────────────────────────────────────────────
    if (action === "progress") {
      const { run_id, done, success, step } = body as {
        run_id?: string; done?: boolean; success?: boolean; step?: string;
      };
      if (!run_id) return jsonResponse({ error: "run_id required" }, { status: 400 });

      if (done) {
        await admin.from("rag_onboarding_runs")
          .update({
            status: success ? "completed" : "abandoned",
            completed_at: new Date().toISOString(),
            last_activity_at: new Date().toISOString(),
            ...(success ? { activated_at: new Date().toISOString() } : {}),
          })
          .eq("id", run_id);

        // Emit the activation event so it counts in the funnel/TTV.
        if (success) {
          const { data: run } = await admin
            .from("rag_onboarding_runs")
            .select("goal_id, visitor_id, external_user_id").eq("id", run_id).maybeSingle();
          const goalId = (run as { goal_id?: string } | null)?.goal_id;
          if (goalId) {
            const { data: goal } = await admin
              .from("onboarding_goals").select("activation_event").eq("id", goalId).maybeSingle();
            const ev = (goal as { activation_event?: string } | null)?.activation_event;
            if (ev) {
              await admin.from("product_events").insert({
                workspace_id: agent.workspace_id, project_id: agent.project_id,
                event_name: ev,
                customer_external_id: (run as any)?.external_user_id ?? (run as any)?.visitor_id ?? null,
                properties: { source: "onboarding_agent", run_id },
              }).then(() => {}, () => {});
            }
          }
        }
      } else {
        await admin.from("rag_onboarding_runs")
          .update({ last_activity_at: new Date().toISOString() })
          .eq("id", run_id);
      }
      if (step) {
        // Best-effort progress breadcrumb (no step_id → store the note in a row-less log via activity).
        await admin.from("activity_logs").insert({
          workspace_id: agent.workspace_id, project_id: agent.project_id,
          event_type: "onboarding_agent.step", title: step, payload: { run_id },
        }).then(() => {}, () => {});
      }
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: `Unknown action "${action}"` }, { status: 400 });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
