// simulation — unified endpoint for the MiroFish-inspired simulation engine.
// (Named "simulation-prepare" for historical/slot reasons; dispatches by action.)
//
// Actions (JSON body { action, ... }):
//   "prepare"  { simulation_id }                         user  → generate personas
//   "claim"    { runner_id }                             runner→ { simulation }
//   "round"    { simulation_id, runner_id }              runner→ { round, actions, done }
//   "complete" { simulation_id, status, error? }         runner→ { ok } (+report)
//   "chat"     { persona_id, message }                   user  → persona reply
//
// Auth: runner actions need X-Runner-Token / service role; user actions need a
// workspace-member session.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";
import { callAi, safeParseJson } from "../_shared/ai.ts";

const EMOJIS = ["🧑‍💼", "👩‍💻", "🧓", "🧑‍🔧", "👨‍⚕️", "🧑‍🎓", "👩‍🏫", "🧑‍🚀", "👨‍🌾", "🧑‍🍳", "👩‍🔬", "🧑‍⚖️", "👨‍🎨", "🧕", "🧔", "👵"];

function runnerAuthorized(req: Request): boolean {
  const token = req.headers.get("X-Runner-Token");
  const platform = Deno.env.get("PLATFORM_RUNNER_TOKEN");
  if (platform && token === platform) return true;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return !!service && req.headers.get("Authorization") === `Bearer ${service}`;
}

async function memberOf(admin: ReturnType<typeof createServiceClient>, workspaceId: string, userId: string): Promise<boolean> {
  const { data } = await admin.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  return !!data;
}

const SENTIMENT_SCORE: Record<string, number> = { positive: 0.6, neutral: 0, negative: -0.6 };

// ── prepare: seed + question → archetype personas + relations ────────────────
// We generate a manageable set of ARCHETYPES (8-20) plus their relations, then
// distribute the requested population (up to 1000) across the archetypes by
// influence weight. The graph shows archetypes; rounds propagate sentiment.
async function doPrepare(admin: ReturnType<typeof createServiceClient>, simId: string) {
  const { data: sim } = await admin
    .from("sim_simulations").select("id, workspace_id, seed_text, question, persona_count").eq("id", simId).maybeSingle();
  if (!sim) return { status: 404, body: { error: "Simulation not found" } };

  await admin.from("sim_simulations").update({ status: "preparing", error: null, updated_at: new Date().toISOString() }).eq("id", simId);

  // persona_count is reused as the TOTAL population size (3..1000).
  const populationSize = Math.min(Math.max(sim.persona_count || 50, 3), 1000);
  // Archetype count scales gently with population.
  const archCount = Math.min(Math.max(Math.round(Math.sqrt(populationSize) * 1.4), 6), 20);
  const seed = String(sim.seed_text || "").slice(0, 8000);

  const systemPrompt =
    "You design the SOCIAL GRAPH of a population to simulate reactions to an idea/scenario. " +
    "Produce diverse ARCHETYPES (roles, incentives, sentiments — supporters, skeptics, neutrals, edge cases, influencers) grounded in the seed, " +
    "PLUS their relations (who influences whom). Return STRICT JSON only.";
  const userPrompt =
    `SEED MATERIAL:\n${seed || "(none provided)"}\n\nSCENARIO / QUESTION:\n${sim.question || "(none)"}\n\n` +
    `Generate exactly ${archCount} archetypes and a set of relations among them as JSON:\n` +
    `{"archetypes":[{"key":"a1","name":"short label","role":"title","bio":"2-3 sentences","stance":"one line",` +
    `"sentiment":"positive|neutral|negative","influence":"low|medium|high","cluster":"group name","weight":0.0_to_1.0}],` +
    `"relations":[{"source":"a1","target":"a2","kind":"ally|rival|mentor|follower|peer|influences","label":"short","strength":0.0_to_1.0}]}`;

  try {
    const res = await callAi({ task: "content_generation", provider: "deepseek", systemPrompt, userPrompt, jsonMode: true, maxTokens: 4000, temperature: 0.7 });
    const parsed = safeParseJson<{ archetypes: any[]; relations: any[] }>(res.content);
    const archs = Array.isArray(parsed?.archetypes) ? parsed!.archetypes : [];
    const relations = Array.isArray(parsed?.relations) ? parsed!.relations : [];
    if (archs.length === 0) throw new Error("No archetypes generated");

    await admin.from("sim_personas").delete().eq("simulation_id", simId);

    // Distribute population across archetypes by weight (min 1 each).
    const weights = archs.map((a: any) => Math.max(0.01, Number(a.weight) || 0.5));
    const wsum = weights.reduce((s, w) => s + w, 0);
    let assigned = 0;
    const pops = weights.map((w, i) => {
      const base = i === weights.length - 1 ? populationSize - assigned : Math.max(1, Math.round((w / wsum) * populationSize));
      assigned += base;
      return Math.max(1, base);
    });

    const rows = archs.map((a: any, i: number) => ({
      simulation_id: simId, workspace_id: sim.workspace_id,
      name: String(a.name || `Archetype ${i + 1}`).slice(0, 80),
      role: String(a.role || "").slice(0, 120) || null,
      bio: String(a.bio || "").slice(0, 600) || null,
      stance: String(a.stance || "").slice(0, 300) || null,
      traits: { influence: a.influence ?? "medium", sentiment: a.sentiment ?? "neutral" },
      avatar_emoji: EMOJIS[i % EMOJIS.length],
      is_archetype: true,
      population: pops[i],
      sentiment_score: SENTIMENT_SCORE[String(a.sentiment)] ?? 0,
      cluster: String(a.cluster || "").slice(0, 60) || null,
    }));
    const { data: inserted, error: insErr } = await admin.from("sim_personas").insert(rows).select("id");
    if (insErr) throw new Error(insErr.message);

    // Map archetype keys -> inserted persona ids, then insert relations.
    const idByKey = new Map<string, string>();
    archs.forEach((a: any, i: number) => { if (a.key && inserted?.[i]) idByKey.set(String(a.key), inserted[i].id); });
    const relRows = relations
      .map((r: any) => ({
        simulation_id: simId, workspace_id: sim.workspace_id,
        source_id: idByKey.get(String(r.source)) ?? null,
        target_id: idByKey.get(String(r.target)) ?? null,
        kind: ["ally", "rival", "mentor", "follower", "peer", "influences"].includes(r.kind) ? r.kind : "influences",
        label: String(r.label || "").slice(0, 60) || null,
        strength: Math.min(1, Math.max(0, Number(r.strength) || 0.5)),
      }))
      .filter((r) => r.source_id && r.target_id && r.source_id !== r.target_id);
    if (relRows.length) await admin.from("sim_relations").insert(relRows);

    await admin.from("sim_simulations").update({ status: "ready", population_size: populationSize, updated_at: new Date().toISOString() }).eq("id", simId);
    return { status: 200, body: { ok: true, archetype_count: rows.length, population: populationSize, relations: relRows.length } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from("sim_simulations").update({ status: "failed", error: msg }).eq("id", simId);
    return { status: 502, body: { error: "Persona generation failed", detail: msg } };
  }
}

// ── round: advance the simulation by one round ───────────────────────────────
async function doRound(admin: ReturnType<typeof createServiceClient>, simId: string) {
  const { data: sim } = await admin
    .from("sim_simulations").select("id, workspace_id, question, current_round, total_rounds").eq("id", simId).maybeSingle();
  if (!sim) throw new Error("Simulation gone");
  if (sim.current_round >= sim.total_rounds) return { round: sim.current_round, actions: 0, done: true };

  const round = sim.current_round + 1;
  const { data: personas } = await admin.from("sim_personas").select("id, name, role, stance").eq("simulation_id", simId).limit(30);
  const list = personas ?? [];
  if (list.length === 0) throw new Error("No personas");

  const { data: recent } = await admin.from("sim_actions").select("content").eq("simulation_id", simId).order("created_at", { ascending: false }).limit(20);
  const recentText = (recent ?? []).map((a: any) => `- ${a.content}`).reverse().join("\n");

  const groupSize = 6;
  const offset = ((round - 1) * groupSize) % Math.max(groupSize, list.length);
  const actors = [...list.slice(offset), ...list.slice(0, offset)].slice(0, groupSize);

  const roster = actors.map((p: any) => `${p.name} — ${p.role ?? "participant"} — stance: ${p.stance ?? "?"}`).join("\n");
  const systemPrompt =
    "You simulate one round of a social/market reaction. Produce one short reaction per persona (post/reply/reaction/signal), true to each persona's role and stance, reacting to recent activity. Return STRICT JSON only.";
  const userPrompt =
    `SCENARIO: ${sim.question}\n\n${recentText ? `RECENT ACTIVITY:\n${recentText}\n\n` : ""}PERSONAS:\n${roster}\n\n` +
    `Round ${round}/${sim.total_rounds}. Return: {"actions":[{"name":"<exact persona name>","kind":"post|reply|reaction|signal","content":"1-2 sentences, first person","sentiment":"positive|neutral|negative"}]}`;

  const res = await callAi({ task: "content_generation", provider: "deepseek", systemPrompt, userPrompt, jsonMode: true, maxTokens: 2200, temperature: 0.8 });
  const acts = safeParseJson<{ actions: any[] }>(res.content)?.actions ?? [];
  const byName = new Map(list.map((p: any) => [p.name.toLowerCase(), p.id]));
  const rows = (Array.isArray(acts) ? acts : []).filter((a: any) => a?.content).map((a: any) => ({
    simulation_id: simId, workspace_id: sim.workspace_id, round,
    persona_id: byName.get(String(a.name || "").toLowerCase()) ?? null,
    kind: ["post", "reply", "reaction", "signal"].includes(a.kind) ? a.kind : "post",
    content: String(a.content).slice(0, 1000),
    sentiment: ["positive", "neutral", "negative"].includes(a.sentiment) ? a.sentiment : "neutral",
  }));
  if (rows.length) await admin.from("sim_actions").insert(rows);

  // ── Influence propagation: each archetype's sentiment_score drifts toward its
  // neighbors' (weighted by relation strength), plus this round's own actions.
  await propagateInfluence(admin, simId, sim.workspace_id, rows);

  const done = round >= sim.total_rounds;
  await admin.from("sim_simulations").update({ current_round: round, updated_at: new Date().toISOString() }).eq("id", simId);
  return { round, actions: rows.length, done };
}

async function propagateInfluence(
  admin: ReturnType<typeof createServiceClient>, simId: string, _workspaceId: string,
  roundActions: Array<{ persona_id: string | null; sentiment: string }>,
) {
  const { data: personas } = await admin.from("sim_personas").select("id, sentiment_score").eq("simulation_id", simId);
  const { data: rels } = await admin.from("sim_relations").select("source_id, target_id, strength").eq("simulation_id", simId);
  if (!personas) return;
  const score = new Map<string, number>(personas.map((p: any) => [p.id, Number(p.sentiment_score) || 0]));

  // 1) Own actions nudge own score.
  const SENT: Record<string, number> = { positive: 0.25, neutral: 0, negative: -0.25 };
  for (const a of roundActions) {
    if (a.persona_id && score.has(a.persona_id)) {
      score.set(a.persona_id, clamp(score.get(a.persona_id)! + (SENT[a.sentiment] ?? 0)));
    }
  }
  // 2) Neighbors pull each other (source influences target by strength).
  const next = new Map(score);
  for (const r of (rels ?? [])) {
    const s = score.get(r.source_id), t = score.get(r.target_id);
    if (s === undefined || t === undefined) continue;
    const w = 0.15 * (Number(r.strength) || 0.5);
    next.set(r.target_id, clamp(t + (s - t) * w));
  }
  // Persist only changed scores.
  const updates = [...next.entries()].filter(([id, v]) => Math.abs(v - (score.get(id) ?? 0)) > 0.001);
  for (const [id, v] of updates) {
    await admin.from("sim_personas").update({ sentiment_score: v }).eq("id", id);
  }
}

function clamp(v: number): number { return Math.max(-1, Math.min(1, v)); }

// ── complete: build the prediction report ────────────────────────────────────
async function doComplete(admin: ReturnType<typeof createServiceClient>, simId: string) {
  const { data: sim } = await admin.from("sim_simulations").select("id, question").eq("id", simId).maybeSingle();
  if (!sim) return;
  const { data: actions } = await admin.from("sim_actions").select("content, sentiment").eq("simulation_id", simId).order("round", { ascending: true }).limit(400);
  const feed = actions ?? [];
  const pos = feed.filter((a: any) => a.sentiment === "positive").length;
  const neg = feed.filter((a: any) => a.sentiment === "negative").length;
  const neu = feed.length - pos - neg;
  const sample = feed.slice(-60).map((a: any) => `(${a.sentiment}) ${a.content}`).join("\n");

  const systemPrompt =
    "You are a prediction analyst. From a multi-agent simulation of reactions to an idea/scenario, write a concise, decision-useful prediction report. Return STRICT JSON. Be specific; give a clear recommendation.";
  const userPrompt =
    `SCENARIO: ${sim.question}\n\nSENTIMENT: positive=${pos}, neutral=${neu}, negative=${neg} (of ${feed.length}).\n\nSAMPLE REACTIONS:\n${sample}\n\n` +
    `Return: {"summary":"3-4 sentences","outlook":"likely|mixed|unlikely","confidence":"low|medium|high","key_drivers":["..."],"risks":["..."],"recommendation":"2-3 sentences"}`;

  let report: Record<string, unknown> = { summary: "Report unavailable." };
  try {
    const res = await callAi({ task: "content_generation", provider: "deepseek", systemPrompt, userPrompt, jsonMode: true, maxTokens: 1500, temperature: 0.4 });
    const parsed = safeParseJson<Record<string, unknown>>(res.content);
    if (parsed) report = parsed;
  } catch { /* fallback */ }
  report.sentiment = { positive: pos, neutral: neu, negative: neg, total: feed.length };
  await admin.from("sim_simulations").update({ report, status: "completed", updated_at: new Date().toISOString() }).eq("id", simId);
}

// ── chat: talk to a persona ──────────────────────────────────────────────────
async function doChat(admin: ReturnType<typeof createServiceClient>, personaId: string, message: string) {
  const { data: persona } = await admin
    .from("sim_personas").select("id, simulation_id, workspace_id, name, role, bio, stance").eq("id", personaId).maybeSingle();
  if (!persona) return { status: 404, body: { error: "Persona not found" }, workspaceId: null };

  const { data: sim } = await admin.from("sim_simulations").select("question").eq("id", persona.simulation_id).maybeSingle();
  await admin.from("sim_messages").insert({ simulation_id: persona.simulation_id, workspace_id: persona.workspace_id, persona_id: personaId, role: "user", content: message.trim() });
  const { data: history } = await admin.from("sim_messages").select("role, content").eq("persona_id", personaId).order("created_at", { ascending: true }).limit(20);

  const systemPrompt =
    `You ARE this persona and answer in the first person, in character. Stay consistent with your role, bio and stance. Be candid and specific.\n` +
    `Name: ${persona.name}\nRole: ${persona.role ?? "participant"}\nBio: ${persona.bio ?? ""}\nStance: ${persona.stance ?? ""}\n` +
    (sim?.question ? `Context (scenario you reacted to): ${sim.question}\n` : "");
  const convo = (history ?? []).map((m: any) => `${m.role === "user" ? "User" : persona.name}: ${m.content}`).join("\n");

  let reply = "(no reply)";
  try {
    const res = await callAi({ task: "chat_simple", provider: "deepseek", systemPrompt, userPrompt: `${convo}\n${persona.name}:`, maxTokens: 600, temperature: 0.8 });
    reply = res.content?.trim() || reply;
  } catch (e) { reply = `(${persona.name} couldn't respond: ${e instanceof Error ? e.message : String(e)})`; }

  const { data: saved } = await admin
    .from("sim_messages").insert({ simulation_id: persona.simulation_id, workspace_id: persona.workspace_id, persona_id: personaId, role: "assistant", content: reply })
    .select("id, role, content, created_at").single();
  return { status: 200, body: { ok: true, message: saved }, workspaceId: persona.workspace_id };
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const body = await req.json();
    const action = (body.action as string) || "prepare";
    const admin = createServiceClient();

    // Runner actions.
    if (action === "claim" || action === "round" || action === "complete") {
      if (!runnerAuthorized(req)) return jsonResponse({ error: "Unauthorized" }, { status: 401 });
      if (action === "claim") {
        const { data, error } = await admin.rpc("claim_simulation", { _runner: body.runner_id ?? "runner" });
        if (error) return jsonResponse({ error: error.message }, { status: 500 });
        return jsonResponse({ simulation: data ?? null });
      }
      if (action === "round") {
        const simId = body.simulation_id;
        try { return jsonResponse({ ok: true, ...(await doRound(admin, simId)) }); }
        catch (e) {
          await admin.from("sim_simulations").update({ status: "failed", error: e instanceof Error ? e.message : String(e) }).eq("id", simId);
          return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
        }
      }
      // complete
      const simId = body.simulation_id;
      if (body.status === "failed") {
        await admin.from("sim_simulations").update({ status: "failed", error: body.error ?? "Simulation failed" }).eq("id", simId);
        return jsonResponse({ ok: true });
      }
      await doComplete(admin, simId);
      return jsonResponse({ ok: true });
    }

    // User actions (need a session + workspace membership).
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
    const userId = userData.user.id;

    if (action === "prepare") {
      const { data: sim } = await admin.from("sim_simulations").select("workspace_id").eq("id", body.simulation_id).maybeSingle();
      if (!sim) return jsonResponse({ error: "Simulation not found" }, { status: 404 });
      if (!(await memberOf(admin, sim.workspace_id, userId))) return jsonResponse({ error: "Not authorized" }, { status: 403 });
      const r = await doPrepare(admin, body.simulation_id);
      return jsonResponse(r.body, { status: r.status });
    }

    if (action === "chat") {
      if (!body.persona_id || !body.message?.trim()) return jsonResponse({ error: "persona_id and message required" }, { status: 400 });
      const { data: persona } = await admin.from("sim_personas").select("workspace_id").eq("id", body.persona_id).maybeSingle();
      if (!persona) return jsonResponse({ error: "Persona not found" }, { status: 404 });
      if (!(await memberOf(admin, persona.workspace_id, userId))) return jsonResponse({ error: "Not authorized" }, { status: 403 });
      const r = await doChat(admin, body.persona_id, body.message);
      return jsonResponse(r.body, { status: r.status });
    }

    return jsonResponse({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
