// npm run eval [-- --live] [--repeat N] [--strict] [--filter texte] [--tag nom]
//
// Fait tourner les évals d'agent (src/evals/cases/**/*.eval.ts) contre le vrai
// moteur, sur une plateforme auto-hébergée neuve (PGlite en mémoire, toutes
// les migrations). Voir harness.ts.
//
// Code de sortie : 0 si chaque assertion bloquante passe (et, avec --strict,
// chaque assertion indicative) ; 1 sinon.

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const live = flag("live");
const strict = flag("strict");
const repeat = Math.max(1, Number(option("repeat") ?? 1) || 1);
const filter = option("filter")?.toLowerCase();
const tag = option("tag");

// ── L'environnement, AVANT tout module de l'app ───────────────────────────
const PORT = Number(process.env.EVAL_PORT ?? 18795);
process.env.PLATFORM = "self";
process.env.DATABASE_URL = "pglite://memory";
process.env.JWT_SECRET ??= "eval-secret-eval-secret-eval-secret-eval-secret";
process.env.FUNCTIONS_URL = `http://localhost:${PORT}`;
process.env.STORAGE_DIR = `${process.env.TEMP ?? "/tmp"}/founderos-evals-${process.pid}`;
process.env.MGMT_PORT = "0";
process.env.AGENT_EVALS = "1";
if (!live) {
  // Mode simulé : aucun appel sortant vers un vrai modèle ni un vrai service.
  process.env.DEEPSEEK_API_KEY = "eval";
  for (const k of ["LLM_UPSTREAM", "AUTH_SMTP_HOST", "RESEND_API_KEY", "JINA_API_KEY", "TYPESAFE_API_KEY", "GROQ_API_KEY"]) delete process.env[k];
}

import type { AssertionResult, EvalContext, EvalDefinition, ModelReply, ModelRequest, ToolCallRecord, Turn } from "./harness.ts";

// ── Le modèle simulé, branché sur fetch ───────────────────────────────────
let currentModel: EvalDefinition["model"] | null = null;
let callIndex = 0;
const LLM_HOSTS = ["https://api.deepseek.com", "https://api.groq.com"];

type WireMessage = { role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string } }>; tool_call_id?: string };

/** Ce que la boucle injecte elle-même en rôle utilisateur : pas la personne. */
const INJECTED = /^\s*(\[(Segment|The user sent|Décision|Summary)|STOP\b|#|FOCUS|Ta réponse affirme|<)/;

function modelRequest(body: { messages?: WireMessage[]; tools?: Array<{ function?: { name?: string } }> }): ModelRequest {
  const msgs = body.messages ?? [];
  const text = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? "").join("") : "");
  const human = msgs.filter((m) => m.role === "user" && !INJECTED.test(text(m.content)));
  let lastUser = -1;
  msgs.forEach((m, i) => { if (m.role === "user" && !INJECTED.test(text(m.content))) lastUser = i; });
  const names = new Map<string, string>();
  for (const m of msgs) for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
  const toolResults = msgs.slice(lastUser + 1).filter((m) => m.role === "tool")
    .map((m) => ({ name: names.get(m.tool_call_id ?? "") ?? "?", content: text(m.content) }));
  return {
    lastUserMessage: text(human[human.length - 1]?.content),
    tools: (body.tools ?? []).map((t) => t.function?.name ?? "").filter(Boolean),
    toolResults,
    transcript: msgs.map((m) => `${m.role}: ${text(m.content)}`).join("\n"),
    callIndex: callIndex++,
  } as ModelRequest;
}

function completion(reply: ModelReply): Record<string, unknown> {
  const message = "toolCalls" in reply
    ? {
      role: "assistant", content: null,
      tool_calls: reply.toolCalls.map((c, i) => ({
        id: `call_${callIndex}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    }
    : { role: "assistant", content: reply.text };
  return {
    model: "deepseek-chat",
    choices: [{ message, finish_reason: "toolCalls" in reply ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

const realFetch = globalThis.fetch;
if (!live) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (LLM_HOSTS.some((h) => url.startsWith(h))) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      // La boucle d'outils de l'agent : le scénario répond. Les appels annexes
      // (plan, contrat, classement) reçoivent un objet vide, que le moteur
      // traite comme « rien à ajouter ».
      const reply: ModelReply = Array.isArray(body.tools) && body.tools.length && currentModel
        ? currentModel(modelRequest(body))
        : { text: "{}" };
      return new Response(JSON.stringify(completion(reply)), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

// ── Découverte des évals ──────────────────────────────────────────────────
const casesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "cases");
function evalFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) out.push(...evalFiles(p));
    else if (f.endsWith(".eval.ts")) out.push(p);
  }
  return out.sort();
}

// ── Exécution ─────────────────────────────────────────────────────────────
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "awaiting_input"]);
/** Le plus long qu'on attende un tour, en millisecondes. */
const TURN_TIMEOUT_MS = 5 * 60_000;

async function main(): Promise<number> {
  const { env } = await import("../env.ts");
  const { startPlatform } = await import("../platform/platform.ts");
  const { createServer } = await import("../server.ts");
  const { createClient } = await import("@supabase/supabase-js");
  const { setEvalStubs, clearEvalStubs } = await import("../edge/_shared/eval-stubs.ts");

  const platform = await startPlatform({
    ...env.platform!, publicUrl: env.functionsUrl, anonKey: env.supabaseAnonKey, serviceKey: env.supabaseServiceRoleKey,
    workers: false,
  }, () => {});
  const server = createServer(undefined, { platform });
  await new Promise<void>((r) => server.listen(PORT, r));
  // Le moteur des agents, comme dans index.ts : le harnais OpenCode et son outillage.
  const { startHarness, stopHarness } = await import("../harness/host.ts");
  const { agentSupport, startRuntime, stopRuntime } = await import("../harness/runtime.ts");
  const { createServiceClient } = await import("../edge/_shared/supabase-admin.ts");
  const harnessAdmin = createServiceClient();
  const agents = agentSupport(harnessAdmin, { kit: true, skillsDir: `${env.harness!.dataDir}/skills` });
  const harness = await startHarness({ instances: agents.instances, dataDir: `${env.harness!.dataDir}-evals`, fetchModels: false });
  startRuntime(harness, harnessAdmin, env.supabaseServiceRoleKey, agents.support);
  const stopEngine = async () => { await stopRuntime(); await stopHarness(); };
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  // deno-lint-ignore no-explicit-any
  const admin: any = createClient(env.functionsUrl, env.supabaseServiceRoleKey, opts);

  const fail = (what: string, e: { message?: string } | null) => { if (e) throw new Error(`${what} : ${e.message}`); };
  const { data: user, error: ue } = await admin.auth.admin.createUser({ email: `eval-${Date.now()}@example.com`, password: "correct horse battery staple", email_confirm: true });
  fail("utilisateur", ue);
  const userId = user.user.id as string;
  const { data: ws, error: we } = await admin.from("workspaces").insert({ name: "Évals", slug: `evals-${Date.now()}`, owner_id: userId, plan: "enterprise" }).select("id").single();
  fail("espace", we);
  await admin.from("workspace_members").upsert({ workspace_id: ws.id, user_id: userId, role: "owner" }, { onConflict: "workspace_id,user_id" });
  await admin.from("workspace_subscriptions").upsert({ workspace_id: ws.id, plan_code: "enterprise" }, { onConflict: "workspace_id" });
  const { data: proj, error: pe } = await admin.from("projects").insert({ workspace_id: ws.id, name: "Évals", slug: "evals" }).select("id").single();
  fail("projet", pe);

  const call = async (body: Record<string, unknown>) => {
    const res = await realFetch(`${env.functionsUrl}/functions/v1/internal-agent-run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.supabaseServiceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
  };

  async function runCase(file: string, def: EvalDefinition): Promise<{ results: AssertionResult[]; error?: string }> {
    const { data: agent, error: ae } = await admin.from("internal_agents").insert({
      workspace_id: ws.id, project_id: proj.id, created_by: userId,
      name: def.agent?.name ?? "Agent d'éval",
      description: def.agent?.description ?? "Agent créé par une éval",
      instructions: def.agent?.systemPrompt ?? "Tu es un assistant précis. Tu n'annonces jamais une action que tu n'as pas faite.",
    }).select("id").single();
    fail("agent", ae);
    const { data: conv, error: ce } = await admin.from("internal_agent_conversations").insert({
      agent_id: agent.id, workspace_id: ws.id, project_id: proj.id, user_id: userId, title: `éval ${path.basename(file)}`,
    }).select("id").single();
    fail("conversation", ce);

    setEvalStubs(agent.id, def.stubs ?? []);
    currentModel = def.model;
    callIndex = 0;
    const results: AssertionResult[] = [];
    const calls: ToolCallRecord[] = [];
    let last: Turn | null = null;
    const record = (label: string, pass: boolean, severity: "gate" | "soft" = "gate", detail?: string) =>
      results.push({ label, pass, severity, detail });

    const t: EvalContext = {
      admin, agentId: agent.id, workspaceId: ws.id, projectId: proj.id,
      async send(message) {
        await admin.from("internal_agent_messages").insert({ conversation_id: conv.id, agent_id: agent.id, role: "user", content: message });
        const started = await call({ agent_id: agent.id, mode: "chat", conversation_id: conv.id });
        const runId = String(started.json.run_id ?? "");
        if (!runId) throw new Error(`le tour n'a pas démarré (${started.status} ${JSON.stringify(started.json)})`);
        let status = "running";
        let ticks = 0;
        const until = Date.now() + TURN_TIMEOUT_MS;
        while (!TERMINAL.has(status) && Date.now() < until) {
          ticks++;
          await new Promise((r) => setTimeout(r, 500));
          const { data: run } = await admin.from("internal_agent_runs").select("status").eq("id", runId).single();
          status = String(run?.status ?? "disparu");
        }
        const { data: events } = await admin.from("internal_agent_run_events")
          .select("kind, payload, created_at").eq("run_id", runId).in("kind", ["tool_call", "tool_result"]).order("created_at");
        const turnCalls: ToolCallRecord[] = [];
        for (const e of (events ?? []) as Array<{ kind: string; payload: Record<string, unknown> }>) {
          if (e.kind === "tool_call") {
            turnCalls.push({ name: String(e.payload.tool ?? ""), args: (e.payload.args ?? {}) as Record<string, unknown>, ok: true, stubbed: false, preview: "" });
          } else {
            const open = [...turnCalls].reverse().find((c) => c.name === e.payload.tool && !c.preview);
            if (open) { open.ok = e.payload.ok !== false; open.preview = String(e.payload.preview ?? "") || " "; }
          }
        }
        const { data: reply } = await admin.from("internal_agent_messages").select("content")
          .eq("conversation_id", conv.id).eq("role", "assistant").order("created_at", { ascending: false }).limit(1).maybeSingle();
        last = { runId, status, reply: String(reply?.content ?? ""), toolCalls: turnCalls, ticks };
        calls.push(...turnCalls);
        return last;
      },
      get turn() {
        if (!last) throw new Error("aucun tour terminé : appelle t.send() d'abord");
        return last;
      },
      get calls() { return calls; },
      calledTool(name, args, o) {
        const hit = calls.find((c) => c.name === name && (!args || Object.entries(args).every(([k, v]) => JSON.stringify(c.args[k]) === JSON.stringify(v))));
        record(`a appelé ${name}${args ? ` ${JSON.stringify(args)}` : ""}`, !!hit, o?.severity, hit ? undefined : `appels : ${calls.map((c) => c.name).join(", ") || "aucun"}`);
      },
      notCalledTool(name, o) {
        record(`n'a pas appelé ${name}`, !calls.some((c) => c.name === name), o?.severity);
      },
      noFailedCalls(o) {
        const failed = calls.filter((c) => !c.ok);
        record("aucun appel d'outil en échec", failed.length === 0, o?.severity, failed.map((c) => `${c.name} : ${c.preview.slice(0, 120)}`).join(" | "));
      },
      replyMatches(re, o) {
        const reply = last?.reply ?? "";
        const ok = re.test(reply) !== !!o?.not;
        record(`${o?.not ? "la réponse ne correspond pas à" : "la réponse correspond à"} ${re}`, ok, o?.severity, ok ? undefined : `réponse : « ${reply.slice(0, 200)} »`);
      },
      statusIs(status, o) {
        const want = Array.isArray(status) ? status : [status];
        record(`statut ${want.join(" ou ")}`, want.includes(last?.status ?? ""), o?.severity, `statut : ${last?.status}`);
      },
      check(label, pass, o) { record(label, pass, o?.severity, o?.detail); },
    };

    try {
      await def.test(t);
      return { results };
    } catch (e) {
      return { results, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearEvalStubs(agent.id);
      currentModel = null;
    }
  }

  let gateFailures = 0;
  let softFailures = 0;
  let ran = 0;
  for (const file of evalFiles(casesDir)) {
    const mod = await import(pathToFileURL(file).href) as { default: EvalDefinition | EvalDefinition[] };
    const defs = Array.isArray(mod.default) ? mod.default : [mod.default];
    const id = path.relative(casesDir, file).replace(/\\/g, "/").replace(/\.eval\.ts$/, "");
    for (const [i, def] of defs.entries()) {
      const name = defs.length > 1 ? `${id}#${i + 1}` : id;
      if (filter && !`${name} ${def.description}`.toLowerCase().includes(filter)) continue;
      if (tag && !(def.tags ?? []).includes(tag)) continue;
      if (def.only && def.only !== (live ? "live" : "mock")) continue;
      for (let r = 0; r < repeat; r++) {
        ran++;
        const started = Date.now();
        const { results, error } = await runCase(file, def);
        const gates = results.filter((x) => x.severity === "gate" && !x.pass).length + (error ? 1 : 0);
        const softs = results.filter((x) => x.severity === "soft" && !x.pass).length;
        gateFailures += gates;
        softFailures += softs;
        const mark = gates ? "✗" : softs ? "~" : "✔";
        console.log(`${mark} ${name}${repeat > 1 ? ` (${r + 1}/${repeat})` : ""} — ${def.description} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
        for (const x of results) {
          if (!x.pass) console.log(`    ${x.severity === "gate" ? "✗" : "~"} ${x.label}${x.detail ? `\n        ${x.detail}` : ""}`);
        }
        if (error) console.log(`    ✗ erreur : ${error}`);
      }
    }
  }

  console.log(`\n${ran} éval(s) en mode ${live ? "réel" : "simulé"} : ${gateFailures} échec(s) bloquant(s), ${softFailures} indicatif(s).`);
  await stopEngine();
  await new Promise<void>((r) => server.close(() => r()));
  await platform.close();
  return gateFailures > 0 || (strict && softFailures > 0) ? 1 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
