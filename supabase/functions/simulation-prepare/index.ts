// simulation — unified endpoint for the MiroFish-inspired simulation engine.
// (Named "simulation-prepare" for historical/slot reasons; dispatches by action.)
//
// Actions (JSON body { action, ... }):
//   "enrich"   { simulation_id }                         user  → fetch real-world context
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
import { webSearch, readUrl, searchKnowledge } from "../_shared/internal-agent-tools.ts";
import type { InternalToolContext } from "../_shared/internal-agent-tools.ts";

const EMOJIS = ["🧑‍💼", "👩‍💻", "🧓", "🧑‍🔧", "👨‍⚕️", "🧑‍🎓", "👩‍🏫", "🧑‍🚀", "👨‍🌾", "🧑‍🍳", "👩‍🔬", "🧑‍⚖️", "👨‍🎨", "🧕", "🧔", "👵"];

const PERSONA_TYPES = [
  "early_adopter", "mainstream", "skeptic", "power_user", "decision_maker",
  "influencer", "price_sensitive", "loyalist", "churner", "edge_case",
] as const;

// Relation kinds: social-graph edges that model how influence propagates in
// real life — family/friend bonds carry trust, influencers broadcast widely,
// media shapes public opinion, rivals push in opposite directions, etc.
const RELATION_KINDS = [
  "friend", "family", "colleague", "mentor", "follower",
  "influencer_to_community", "media_influence", "competitor",
  "ally", "rival", "peer", "authority", "customer_of", "community_member",
] as const;
type RelKind = typeof RELATION_KINDS[number];

// How strongly each relation type propagates influence (higher = more pull).
const RELATION_WEIGHT: Record<string, number> = {
  family: 0.30,
  friend: 0.25,
  influencer_to_community: 0.22,
  mentor: 0.20,
  authority: 0.20,
  media_influence: 0.18,
  ally: 0.15,
  colleague: 0.12,
  community_member: 0.12,
  peer: 0.10,
  follower: 0.10,
  customer_of: 0.08,
  competitor: -0.12,
  rival: -0.15,
};

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

function clamp(v: number): number { return Math.max(-1, Math.min(1, v)); }

function truncateEnrichment(enrichment: any, maxChars = 6000): string {
  if (!enrichment) return "";
  const parts: string[] = [];
  if (Array.isArray(enrichment.web_results)) {
    parts.push("WEB SEARCH RESULTS:");
    for (const r of enrichment.web_results.slice(0, 10)) {
      parts.push(`- ${r.title}: ${r.snippet}`);
    }
  }
  if (Array.isArray(enrichment.url_contents)) {
    parts.push("\nREFERENCE DOCUMENTS:");
    for (const u of enrichment.url_contents.slice(0, 3)) {
      parts.push(`[${u.url}]\n${String(u.markdown).slice(0, 1500)}`);
    }
  }
  if (Array.isArray(enrichment.rag_chunks)) {
    parts.push("\nKNOWLEDGE BASE:");
    for (const c of enrichment.rag_chunks.slice(0, 8)) {
      parts.push(`- ${String(c.text).slice(0, 400)}`);
    }
  }
  const full = parts.join("\n");
  return full.slice(0, maxChars);
}

// ── enrich: fetch real-world context before persona generation ──────────────
async function doEnrich(admin: ReturnType<typeof createServiceClient>, simId: string) {
  const { data: sim } = await admin
    .from("sim_simulations")
    .select("id, workspace_id, project_id, seed_text, question, enrichment_config")
    .eq("id", simId).maybeSingle();
  if (!sim) return { status: 404, body: { error: "Simulation not found" } };

  const config = (sim.enrichment_config ?? {}) as {
    web_search_enabled?: boolean;
    rag_collection_ids?: string[];
    urls?: string[];
  };

  const enrichment: {
    web_results: Array<{ title: string; url: string; snippet: string }>;
    url_contents: Array<{ url: string; markdown: string }>;
    rag_chunks: Array<{ text: string; similarity?: number }>;
    fetched_at: string;
  } = { web_results: [], url_contents: [], rag_chunks: [], fetched_at: new Date().toISOString() };

  const jobs: Promise<void>[] = [];
  const question = String(sim.question || "").slice(0, 200);

  // 1) Web search — 2 queries: the question itself + a news-oriented variant
  if (config.web_search_enabled && question) {
    jobs.push((async () => {
      try {
        const raw = await webSearch(question, 5);
        const parsed = safeParseJson<{ results?: any[] }>(raw);
        if (parsed?.results) {
          enrichment.web_results.push(...parsed.results.map((r: any) => ({
            title: String(r.title ?? ""), url: String(r.url ?? ""), snippet: String(r.snippet ?? ""),
          })));
        }
      } catch { /* partial is fine */ }
    })());
    jobs.push((async () => {
      try {
        const raw = await webSearch(`${question} latest news analysis`, 5);
        const parsed = safeParseJson<{ results?: any[] }>(raw);
        if (parsed?.results) {
          enrichment.web_results.push(...parsed.results.map((r: any) => ({
            title: String(r.title ?? ""), url: String(r.url ?? ""), snippet: String(r.snippet ?? ""),
          })));
        }
      } catch { /* partial is fine */ }
    })());
  }

  // 2) Read specific URLs (max 3)
  const urls = (config.urls ?? []).filter((u: string) => /^https?:\/\//i.test(u)).slice(0, 3);
  for (const url of urls) {
    jobs.push((async () => {
      try {
        const md = await readUrl(url);
        if (!md.startsWith("ERROR:")) {
          enrichment.url_contents.push({ url, markdown: md.slice(0, 4000) });
        }
      } catch { /* skip */ }
    })());
  }

  // 3) RAG collection search
  const collectionIds = (config.rag_collection_ids ?? []).filter(Boolean);
  if (collectionIds.length > 0 && question) {
    jobs.push((async () => {
      try {
        const ctx: InternalToolContext = {
          admin, workspaceId: sim.workspace_id, projectId: sim.project_id ?? "",
          agentId: "", runId: null,
          createDeliverable: async () => {},
          requestApproval: async () => "approved",
          logEvent: async () => {},
          isCancelled: async () => false,
        } as unknown as InternalToolContext;
        const raw = await searchKnowledge(ctx, question, 10, collectionIds);
        const parsed = safeParseJson<Array<{ text?: string; similarity?: number }>>(raw);
        if (Array.isArray(parsed)) {
          enrichment.rag_chunks.push(...parsed.map((c) => ({
            text: String(c.text ?? ""), similarity: c.similarity,
          })));
        }
      } catch { /* skip */ }
    })());
  }

  await Promise.allSettled(jobs);

  // Deduplicate web results by URL
  const seen = new Set<string>();
  enrichment.web_results = enrichment.web_results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  await admin.from("sim_simulations")
    .update({ enrichment, updated_at: new Date().toISOString() })
    .eq("id", simId);

  return {
    status: 200,
    body: {
      ok: true,
      web_results: enrichment.web_results.length,
      url_contents: enrichment.url_contents.length,
      rag_chunks: enrichment.rag_chunks.length,
    },
  };
}

// ── prepare: seed + question → archetype cohorts + relations ────────────────
// V2: archetype-only model. Each archetype row represents a population cohort
// with rich demographics/psychographics. No individual agent rows.
async function doPrepare(admin: ReturnType<typeof createServiceClient>, simId: string) {
  const { data: sim } = await admin
    .from("sim_simulations")
    .select("id, workspace_id, seed_text, question, persona_count, enrichment, enrichment_config")
    .eq("id", simId).maybeSingle();
  if (!sim) return { status: 404, body: { error: "Simulation not found" } };

  await admin.from("sim_simulations").update({ status: "preparing", error: null, updated_at: new Date().toISOString() }).eq("id", simId);

  const populationSize = Math.min(Math.max(sim.persona_count || 50, 3), 100000);

  // Custom persona seeds from user configuration.
  const personaSeeds: Array<{ name: string; description: string; count: number; type?: string }> =
    Array.isArray((sim.enrichment_config as any)?.persona_seeds)
      ? (sim.enrichment_config as any).persona_seeds.filter((s: any) => s?.name)
      : [];
  const seedPopulation = personaSeeds.reduce((s, p) => s + (p.count || 1), 0);

  // Archetype count: auto-generated archetypes + custom seeds
  const autoArchCount = Math.min(Math.max(Math.round(Math.log10(Math.max(10, populationSize)) * 8), 6), 50);
  const archCount = Math.min(autoArchCount + personaSeeds.length, 60);
  const seed = String(sim.seed_text || "").slice(0, 6000);
  const enrichmentContext = truncateEnrichment(sim.enrichment, 4000);

  // Build custom seeds instruction for the LLM.
  const seedsInstruction = personaSeeds.length > 0
    ? `\n\nMANDATORY CUSTOM PERSONAS (include these as archetypes, use the exact names and descriptions):\n` +
      personaSeeds.map((s, i) => `- "${s.name}" (${s.type || "custom"}, ~${s.count} people): ${s.description}`).join("\n") +
      `\nGenerate ${autoArchCount} additional archetypes to complete the population graph.`
    : "";

  const systemPrompt =
    "You design the SOCIAL GRAPH of a realistic population to simulate reactions to an idea/scenario. " +
    "Produce diverse ARCHETYPES grounded in the seed material and real-world context provided. " +
    "Each archetype represents a COHORT of people sharing demographics, psychographics, motivations, and a nuanced opinion. " +
    "Avoid simplistic positive/neutral/negative buckets — give each archetype a specific, grounded perspective.\n\n" +
    "RELATIONS must model real-life social dynamics:\n" +
    "- friend/family: strong trust-based bonds that carry personal influence\n" +
    "- influencer_to_community: one-to-many broadcast influence (content creators, thought leaders)\n" +
    "- media_influence: news/social media shaping public opinion\n" +
    "- mentor/authority: expertise-based trust (doctors, professors, managers)\n" +
    "- colleague/peer: workplace or social-circle proximity\n" +
    "- competitor/rival: opposing interests that push sentiment in opposite directions\n" +
    "- ally/community_member: shared cause or group membership\n" +
    "- customer_of: economic dependency\n" +
    "Return STRICT JSON only.";

  const userPrompt =
    `SEED MATERIAL:\n${seed || "(none provided)"}\n\n` +
    `SCENARIO / QUESTION:\n${sim.question || "(none)"}\n\n` +
    (enrichmentContext ? `REAL-WORLD CONTEXT:\n${enrichmentContext}\n\n` : "") +
    seedsInstruction +
    `\nGenerate exactly ${archCount} archetypes and their relations as JSON:\n` +
    `{"archetypes":[{\n` +
    `  "key":"a1",\n` +
    `  "name":"short label (e.g. Tech-Savvy Millennials)",\n` +
    `  "role":"social/professional role",\n` +
    `  "bio":"2-3 sentences grounded in the context",\n` +
    `  "stance":"nuanced initial position (2 sentences)",\n` +
    `  "persona_type":"early_adopter|mainstream|skeptic|power_user|decision_maker|influencer|price_sensitive|loyalist|churner|edge_case",\n` +
    `  "demographics":{"age_range":"25-34","income_level":"low|middle|upper_middle|high","location_type":"urban|suburban|rural","tech_savviness":"low|medium|high","industry":"sector"},\n` +
    `  "psychographics":{"values":["innovation","cost-efficiency"],"motivations":["career advancement"],"pain_points":["complexity"],"risk_tolerance":"low|medium|high"},\n` +
    `  "opinion":"nuanced 2-3 sentence initial opinion grounded in real data if available",\n` +
    `  "decision_factors":["price","features","brand trust","peer recommendations"],\n` +
    `  "sentiment_spectrum":-1.0,  // float from -1 (hostile) to +1 (enthusiastic)\n` +
    `  "influence":"low|medium|high",\n` +
    `  "cluster":"group name",\n` +
    `  "weight":0.15  // relative population weight (all weights are normalised)\n` +
    `}],\n` +
    `"relations":[{"source":"a1","target":"a2",` +
    `"kind":"friend|family|colleague|mentor|follower|influencer_to_community|media_influence|competitor|ally|rival|peer|authority|customer_of|community_member",` +
    `"label":"short reason","strength":0.0_to_1.0}]}`;

  try {
    const res = await callAi({
      task: "content_generation", provider: "deepseek", systemPrompt, userPrompt,
      jsonMode: true, maxTokens: 6000, temperature: 0.7,
    });
    const parsed = safeParseJson<{ archetypes: any[]; relations: any[] }>(res.content);
    const archs = Array.isArray(parsed?.archetypes) ? parsed!.archetypes : [];
    const relations = Array.isArray(parsed?.relations) ? parsed!.relations : [];
    if (archs.length === 0) throw new Error("No archetypes generated");

    await admin.from("sim_personas").delete().eq("simulation_id", simId);
    await admin.from("sim_relations").delete().eq("simulation_id", simId);

    // 1) Distribute population across archetypes by weight.
    const weights = archs.map((a: any) => Math.max(0.01, Number(a.weight) || 0.5));
    const wsum = weights.reduce((s: number, w: number) => s + w, 0);
    let assigned = 0;
    const pops = weights.map((w: number, i: number) => {
      const base = i === weights.length - 1
        ? populationSize - assigned
        : Math.max(1, Math.round((w / wsum) * populationSize));
      assigned += base;
      return Math.max(1, base);
    });

    // 2) Insert archetypes with rich traits (is_archetype=true, population set).
    const archRows = archs.map((a: any, i: number) => {
      const sentSpectrum = Number(a.sentiment_spectrum) || 0;
      const pType = PERSONA_TYPES.includes(a.persona_type) ? a.persona_type : "mainstream";
      return {
        simulation_id: simId, workspace_id: sim.workspace_id,
        name: String(a.name || `Archetype ${i + 1}`).slice(0, 80),
        role: String(a.role || "").slice(0, 120) || null,
        bio: String(a.bio || "").slice(0, 600) || null,
        stance: String(a.stance || "").slice(0, 300) || null,
        persona_type: pType,
        traits: {
          influence: a.influence ?? "medium",
          sentiment: sentSpectrum > 0.15 ? "positive" : sentSpectrum < -0.15 ? "negative" : "neutral",
          persona_type: pType,
          demographics: a.demographics ?? {},
          psychographics: a.psychographics ?? {},
          opinion: String(a.opinion ?? "").slice(0, 500),
          decision_factors: Array.isArray(a.decision_factors) ? a.decision_factors.slice(0, 8) : [],
          sentiment_spectrum: clamp(sentSpectrum),
        },
        avatar_emoji: EMOJIS[i % EMOJIS.length],
        is_archetype: true,
        population: pops[i],
        sentiment_score: clamp(sentSpectrum),
        cluster: String(a.cluster || "").slice(0, 60) || null,
      };
    });
    const { data: archIns, error: aErr } = await admin.from("sim_personas").insert(archRows).select("id");
    if (aErr) throw new Error(aErr.message);
    const archIds = (archIns ?? []).map((r: any) => r.id);
    const idxByKey = new Map<string, number>();
    archs.forEach((a: any, i: number) => { if (a.key) idxByKey.set(String(a.key), i); });

    // 3) Insert archetype-to-archetype relations.
    const relRows: any[] = [];
    const seenRel = new Set<string>();
    for (const r of relations) {
      const si = idxByKey.get(String(r.source)), ti = idxByKey.get(String(r.target));
      if (si === undefined || ti === undefined || si === ti) continue;
      const key = `${archIds[si]}>${archIds[ti]}`;
      if (seenRel.has(key)) continue;
      seenRel.add(key);
      const kind = (RELATION_KINDS as readonly string[]).includes(r.kind) ? r.kind : "peer";
      relRows.push({
        simulation_id: simId, workspace_id: sim.workspace_id,
        source_id: archIds[si], target_id: archIds[ti],
        kind,
        label: String(r.label || "").slice(0, 60) || null,
        strength: Math.min(1, Math.max(0, Number(r.strength) || 0.5)),
      });
    }
    if (relRows.length) {
      for (let i = 0; i < relRows.length; i += 500) {
        await admin.from("sim_relations").insert(relRows.slice(i, i + 500));
      }
    }

    await admin.from("sim_simulations").update({
      status: "ready", population_size: populationSize,
      updated_at: new Date().toISOString(),
    }).eq("id", simId);

    return {
      status: 200,
      body: { ok: true, archetypes: archIds.length, population: populationSize, relations: relRows.length },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from("sim_simulations").update({ status: "failed", error: msg }).eq("id", simId);
    return { status: 502, body: { error: "Persona generation failed", detail: msg } };
  }
}

// ── round: advance the simulation by one round ───────────────────────────────
async function doRound(admin: ReturnType<typeof createServiceClient>, simId: string) {
  const { data: sim } = await admin
    .from("sim_simulations")
    .select("id, workspace_id, question, current_round, total_rounds, enrichment")
    .eq("id", simId).maybeSingle();
  if (!sim) throw new Error("Simulation gone");
  if (sim.current_round >= sim.total_rounds) return { round: sim.current_round, actions: 0, done: true };

  const round = sim.current_round + 1;

  // Fetch archetypes (the only persona rows in V2).
  const { data: allArchetypes } = await admin
    .from("sim_personas")
    .select("id, name, role, stance, population, traits, persona_type, sentiment_score")
    .eq("simulation_id", simId).eq("is_archetype", true)
    .order("created_at", { ascending: true });
  const archetypes = allArchetypes ?? [];
  if (archetypes.length === 0) throw new Error("No archetypes");

  // Rotating window: 10 archetypes per round.
  const groupSize = Math.min(10, archetypes.length);
  const offset = ((round - 1) * groupSize) % archetypes.length;
  const actors: typeof archetypes = [];
  for (let i = 0; i < groupSize; i++) {
    actors.push(archetypes[(offset + i) % archetypes.length]);
  }

  const { data: recent } = await admin
    .from("sim_actions").select("content, sentiment")
    .eq("simulation_id", simId).order("created_at", { ascending: false }).limit(20);
  const recentText = (recent ?? []).map((a: any) => `- ${a.content}`).reverse().join("\n");

  const enrichBrief = truncateEnrichment(sim.enrichment, 2000);

  const roster = actors.map((p: any) => {
    const t = p.traits ?? {};
    const demo = t.demographics ?? {};
    const psych = t.psychographics ?? {};
    return (
      `${p.name} (${p.persona_type ?? "mainstream"}, pop. ${p.population}) — ${p.role ?? "participant"}\n` +
      `  Stance: ${p.stance ?? "?"}\n` +
      `  Demographics: ${demo.age_range ?? "?"}, ${demo.income_level ?? "?"} income, tech=${demo.tech_savviness ?? "?"}\n` +
      `  Motivations: ${(psych.motivations ?? []).join(", ") || "?"}\n` +
      `  Pain points: ${(psych.pain_points ?? []).join(", ") || "?"}\n` +
      `  Current opinion: ${t.opinion ?? p.stance ?? "?"}`
    );
  }).join("\n\n");

  const systemPrompt =
    "You simulate one round of a social/market reaction among population cohorts. " +
    "Each persona represents a cohort of real people. Produce one realistic reaction per cohort, " +
    "true to their demographics, motivations, pain points and current stance. " +
    "Reactions should be specific and grounded — reference real concerns, not generic sentiments. " +
    (enrichBrief ? "Use the real-world context to inform reactions when relevant. " : "") +
    "Return STRICT JSON only.";

  const userPrompt =
    `SCENARIO: ${sim.question}\n\n` +
    (enrichBrief ? `REAL-WORLD CONTEXT:\n${enrichBrief}\n\n` : "") +
    (recentText ? `RECENT ACTIVITY:\n${recentText}\n\n` : "") +
    `COHORT PERSONAS:\n${roster}\n\n` +
    `Round ${round}/${sim.total_rounds}. Return:\n` +
    `{"actions":[{"name":"<exact cohort name>","kind":"post|reply|reaction|signal",` +
    `"content":"2-3 sentences, as a representative voice of this cohort",` +
    `"sentiment":"positive|neutral|negative",` +
    `"sentiment_value":-1.0_to_1.0}]}`;

  const res = await callAi({
    task: "content_generation", provider: "deepseek", systemPrompt, userPrompt,
    jsonMode: true, maxTokens: 3000, temperature: 0.8,
  });
  const acts = safeParseJson<{ actions: any[] }>(res.content)?.actions ?? [];
  const byName = new Map(actors.map((p: any) => [p.name.toLowerCase(), p.id]));
  const rows = (Array.isArray(acts) ? acts : []).filter((a: any) => a?.content).map((a: any) => {
    const sentValue = typeof a.sentiment_value === "number" ? clamp(a.sentiment_value) : null;
    return {
      simulation_id: simId, workspace_id: sim.workspace_id, round,
      persona_id: byName.get(String(a.name || "").toLowerCase()) ?? null,
      kind: ["post", "reply", "reaction", "signal"].includes(a.kind) ? a.kind : "post",
      content: String(a.content).slice(0, 1500),
      sentiment: ["positive", "neutral", "negative"].includes(a.sentiment) ? a.sentiment : "neutral",
      sentiment_value: sentValue,
    };
  });
  if (rows.length) await admin.from("sim_actions").insert(rows);

  await propagateInfluence(admin, simId, rows);

  const done = round >= sim.total_rounds;
  await admin.from("sim_simulations").update({ current_round: round, updated_at: new Date().toISOString() }).eq("id", simId);
  return { round, actions: rows.length, done };
}

async function propagateInfluence(
  admin: ReturnType<typeof createServiceClient>, simId: string,
  roundActions: Array<{ persona_id: string | null; sentiment: string; sentiment_value: number | null }>,
) {
  const { data: personas } = await admin
    .from("sim_personas").select("id, sentiment_score, population")
    .eq("simulation_id", simId).eq("is_archetype", true);
  const { data: rels } = await admin
    .from("sim_relations").select("source_id, target_id, strength, kind")
    .eq("simulation_id", simId);
  if (!personas) return;

  const score = new Map<string, number>(personas.map((p: any) => [p.id, Number(p.sentiment_score) || 0]));
  const pop = new Map<string, number>(personas.map((p: any) => [p.id, Number(p.population) || 1]));

  // 1) Own actions nudge score — prefer numeric sentiment_value when available.
  const SENT: Record<string, number> = { positive: 0.2, neutral: 0, negative: -0.2 };
  for (const a of roundActions) {
    if (a.persona_id && score.has(a.persona_id)) {
      const nudge = a.sentiment_value ?? (SENT[a.sentiment] ?? 0);
      score.set(a.persona_id, clamp(score.get(a.persona_id)! + nudge * 0.3));
    }
  }

  // 2) Neighbor influence — each relation kind has a characteristic weight:
  //    family/friend bonds carry strong trust, influencers broadcast widely,
  //    rivals/competitors push sentiment in the OPPOSITE direction.
  const maxPop = Math.max(1, ...pop.values());
  const next = new Map(score);
  for (const r of (rels ?? [])) {
    const s = score.get(r.source_id), t = score.get(r.target_id);
    if (s === undefined || t === undefined) continue;
    const kindW = RELATION_WEIGHT[r.kind] ?? 0.10;
    const popWeight = Math.sqrt((pop.get(r.source_id) ?? 1) / maxPop);
    const w = Math.abs(kindW) * (Number(r.strength) || 0.5) * (0.5 + 0.5 * popWeight);
    if (kindW >= 0) {
      // Attractive: pull target toward source sentiment
      next.set(r.target_id, clamp(t + (s - t) * w));
    } else {
      // Repulsive (rival/competitor): push target AWAY from source sentiment
      next.set(r.target_id, clamp(t - (s - t) * w));
    }
  }

  const updates = [...next.entries()].filter(([id, v]) => Math.abs(v - (score.get(id) ?? 0)) > 0.001);
  for (const [id, v] of updates) {
    await admin.from("sim_personas").update({ sentiment_score: v }).eq("id", id);
  }
}

// ── complete: build the prediction report ────────────────────────────────────
async function doComplete(admin: ReturnType<typeof createServiceClient>, simId: string) {
  const { data: sim } = await admin
    .from("sim_simulations").select("id, question, enrichment")
    .eq("id", simId).maybeSingle();
  if (!sim) return;

  // Fetch archetypes for segment analysis.
  const { data: archetypes } = await admin
    .from("sim_personas")
    .select("name, population, sentiment_score, persona_type, traits")
    .eq("simulation_id", simId).eq("is_archetype", true)
    .order("population", { ascending: false });
  const segs = archetypes ?? [];
  const totalPop = segs.reduce((s: number, p: any) => s + (p.population || 1), 0);
  const weightedSentiment = totalPop > 0
    ? segs.reduce((s: number, p: any) => s + (p.sentiment_score || 0) * (p.population || 1), 0) / totalPop
    : 0;

  // Action stats
  const { data: actions } = await admin
    .from("sim_actions").select("content, sentiment, sentiment_value, round")
    .eq("simulation_id", simId).order("round", { ascending: true }).limit(500);
  const feed = actions ?? [];
  const pos = feed.filter((a: any) => a.sentiment === "positive").length;
  const neg = feed.filter((a: any) => a.sentiment === "negative").length;
  const neu = feed.length - pos - neg;
  const sample = feed.slice(-60).map((a: any) => `(${a.sentiment}, ${a.sentiment_value ?? "?"}) ${a.content}`).join("\n");

  const segmentBreakdown = segs.map((p: any) =>
    `${p.name} (${p.persona_type ?? "?"}, pop ${p.population}, sentiment ${(p.sentiment_score ?? 0).toFixed(2)})`
  ).join("\n");

  const enrichBrief = truncateEnrichment(sim.enrichment, 1500);

  const systemPrompt =
    "You are a prediction analyst. From a multi-agent simulation of cohort reactions to an idea/scenario, " +
    "write a concise, decision-useful prediction report with segment-level analysis. " +
    "Use the real-world context and segment data to give specific, actionable insights. " +
    "Return STRICT JSON. Be specific; give a clear recommendation.";

  const userPrompt =
    `SCENARIO: ${sim.question}\n\n` +
    (enrichBrief ? `REAL-WORLD CONTEXT:\n${enrichBrief}\n\n` : "") +
    `POPULATION: ${totalPop.toLocaleString()} people across ${segs.length} segments\n` +
    `WEIGHTED SENTIMENT: ${weightedSentiment.toFixed(3)} (-1=hostile, +1=enthusiastic)\n\n` +
    `SEGMENT BREAKDOWN:\n${segmentBreakdown}\n\n` +
    `ACTION STATS: positive=${pos}, neutral=${neu}, negative=${neg} (of ${feed.length})\n\n` +
    `SAMPLE REACTIONS:\n${sample}\n\n` +
    `Return:\n` +
    `{"summary":"3-4 sentences",\n` +
    `"outlook":"likely|mixed|unlikely",\n` +
    `"confidence":"low|medium|high",\n` +
    `"key_drivers":["..."],\n` +
    `"risks":["..."],\n` +
    `"recommendation":"2-3 sentences",\n` +
    `"segment_analysis":[{"segment":"name","population_pct":22,"sentiment":0.7,"key_concern":"..."}],\n` +
    `"adoption_forecast":{"initial_enthusiasm":"high|medium|low","expected_adoption_rate":"65%","time_to_mainstream":"6-12 months"}}`;

  let report: Record<string, unknown> = { summary: "Report unavailable." };
  try {
    const res = await callAi({
      task: "content_generation", provider: "deepseek", systemPrompt, userPrompt,
      jsonMode: true, maxTokens: 2500, temperature: 0.4,
    });
    const parsed = safeParseJson<Record<string, unknown>>(res.content);
    if (parsed) report = parsed;
  } catch { /* fallback */ }
  report.sentiment = { positive: pos, neutral: neu, negative: neg, total: feed.length };
  report.weighted_sentiment = weightedSentiment;
  report.population = totalPop;

  // Source URLs from enrichment
  const enrichData = sim.enrichment as any;
  if (enrichData?.web_results) {
    report.sources_referenced = (enrichData.web_results as any[]).slice(0, 5).map((r: any) => r.url);
  }

  await admin.from("sim_simulations").update({
    report, status: "completed", updated_at: new Date().toISOString(),
  }).eq("id", simId);
}

// ── chat: talk to a persona ──────────────────────────────────────────────────
async function doChat(admin: ReturnType<typeof createServiceClient>, personaId: string, message: string) {
  const { data: persona } = await admin
    .from("sim_personas")
    .select("id, simulation_id, workspace_id, name, role, bio, stance, traits, population, persona_type")
    .eq("id", personaId).maybeSingle();
  if (!persona) return { status: 404, body: { error: "Persona not found" } };

  const { data: sim } = await admin
    .from("sim_simulations").select("question, enrichment")
    .eq("id", persona.simulation_id).maybeSingle();

  await admin.from("sim_messages").insert({
    simulation_id: persona.simulation_id, workspace_id: persona.workspace_id,
    persona_id: personaId, role: "user", content: message.trim(),
  });
  const { data: history } = await admin
    .from("sim_messages").select("role, content")
    .eq("persona_id", personaId).order("created_at", { ascending: true }).limit(20);

  const t = persona.traits ?? {};
  const demo = t.demographics ?? {};
  const psych = t.psychographics ?? {};
  const popNote = (persona.population ?? 1) > 100
    ? `You represent a cohort of ~${persona.population?.toLocaleString()} people who share these characteristics. Answer as a thoughtful representative of this group.\n`
    : "";

  const systemPrompt =
    `You ARE this persona and answer in the first person, in character. Stay consistent with your profile. Be candid and specific.\n` +
    `${popNote}` +
    `Name: ${persona.name}\n` +
    `Type: ${persona.persona_type ?? "mainstream"}\n` +
    `Role: ${persona.role ?? "participant"}\n` +
    `Bio: ${persona.bio ?? ""}\n` +
    `Stance: ${persona.stance ?? ""}\n` +
    `Demographics: age ${demo.age_range ?? "?"}, ${demo.income_level ?? "?"} income, ${demo.location_type ?? "?"}, tech=${demo.tech_savviness ?? "?"}\n` +
    `Motivations: ${(psych.motivations ?? []).join(", ") || "?"}\n` +
    `Pain points: ${(psych.pain_points ?? []).join(", ") || "?"}\n` +
    `Values: ${(psych.values ?? []).join(", ") || "?"}\n` +
    `Opinion: ${t.opinion ?? persona.stance ?? ""}\n` +
    (sim?.question ? `Context (scenario): ${sim.question}\n` : "");

  const convo = (history ?? []).map((m: any) => `${m.role === "user" ? "User" : persona.name}: ${m.content}`).join("\n");

  let reply = "(no reply)";
  try {
    const res = await callAi({
      task: "chat_simple", provider: "deepseek", systemPrompt,
      userPrompt: `${convo}\n${persona.name}:`,
      maxTokens: 600, temperature: 0.8,
    });
    reply = res.content?.trim() || reply;
  } catch (e) {
    reply = `(${persona.name} couldn't respond: ${e instanceof Error ? e.message : String(e)})`;
  }

  const { data: saved } = await admin
    .from("sim_messages").insert({
      simulation_id: persona.simulation_id, workspace_id: persona.workspace_id,
      persona_id: personaId, role: "assistant", content: reply,
    })
    .select("id, role, content, created_at").single();
  return { status: 200, body: { ok: true, message: saved }, workspaceId: persona.workspace_id };
}

// ── HTTP dispatcher ─────────────────────────────────────────────────────────
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

    if (action === "enrich") {
      const { data: sim } = await admin.from("sim_simulations").select("workspace_id").eq("id", body.simulation_id).maybeSingle();
      if (!sim) return jsonResponse({ error: "Simulation not found" }, { status: 404 });
      if (!(await memberOf(admin, sim.workspace_id, userId))) return jsonResponse({ error: "Not authorized" }, { status: 403 });
      const r = await doEnrich(admin, body.simulation_id);
      return jsonResponse(r.body, { status: r.status });
    }

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
