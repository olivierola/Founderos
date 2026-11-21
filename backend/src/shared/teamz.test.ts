// Teamz et durcissement du harness (2026-11-16) : le catalogue, le
// compositeur de prompts, la normalisation d'un plan rendu par un modèle, les
// routines, la passation entre coéquipiers, la preuve des actions annoncées et
// les points de cache de prompt.

import "../test-env.ts";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blueprintFromTemplate, cadenceOfCron, composeMemberPrompt, describeCron, estimateHoursPerWeek, lintBlueprint, lintMember,
  matchTemplate, normalizeBlueprint, scheduleRowFor, timeSaved, TEAMZ_TOOL_KINDS,
} from "../edge/_shared/teamz.ts";
import { TEAMZ_CATALOG } from "../edge/_shared/teamz-catalog.ts";
import { formatHandoffBrief, normalizeHandoff, teammateOf } from "../edge/_shared/team-handoff.ts";
import { findUnbackedClaims, toolTrail, type ToolTrailEntry } from "../edge/_shared/agent-loop.ts";
import { openrouterDialect, stripCacheControl, withCacheBreakpoints } from "../edge/_shared/llm-upstream.ts";
import { teamOpsToolDef } from "../edge/_shared/team-architect.ts";

describe("catalogue Teamz", () => {
  it("chaque Teamz est complète : un animateur, des liens valides, des routines planifiables", () => {
    const keys = new Set<string>();
    for (const t of TEAMZ_CATALOG) {
      assert.ok(!keys.has(t.key), `clé en double : ${t.key}`);
      keys.add(t.key);
      const bp = blueprintFromTemplate(t);
      const lint = lintBlueprint(bp);
      assert.deepEqual(lint.team, [], `${t.key} : ${lint.team.join(", ")}`);
      assert.equal(t.members.filter((m) => m.lead).length, 1, `${t.key} : un seul animateur`);
      assert.ok(t.members.length >= 3 && t.members.length <= 5, `${t.key} : 3 à 5 membres`);
      for (const r of t.routines) {
        assert.ok(cadenceOfCron(r.cron), `${t.key} : cron non planifiable « ${r.cron} »`);
        assert.ok(t.members.some((m) => m.key === r.owner), `${t.key} : routine sans propriétaire`);
      }
      assert.ok(t.plugs.some((p) => p.required), `${t.key} : au moins une app requise`);
      assert.ok(t.hours_saved_per_week > 0 && t.hours_saved_per_week <= 60);
    }
    assert.ok(TEAMZ_CATALOG.length >= 8);
  });

  it("chaque rôle du catalogue obtient 100/100 au contrôle qualité", () => {
    for (const t of TEAMZ_CATALOG) {
      for (const m of t.members) {
        const l = lintMember(m);
        assert.equal(l.score, 100, `${t.key}/${m.key} : ${l.issues.join(", ")}`);
        for (const tool of m.tools) assert.ok((TEAMZ_TOOL_KINDS as readonly string[]).includes(tool.kind), `${m.key} : outil ${tool.kind}`);
      }
    }
  });

  it("le prompt d'un membre nomme son équipe, son flux A2A et le protocole de passation", () => {
    const t = TEAMZ_CATALOG.find((x) => x.key === "support-desk")!;
    const sam = t.members.find((m) => m.key === "resolver")!;
    const prompt = composeMemberPrompt(t, sam);
    for (const section of ["## TA MISSION", "## MÉTHODE", "## TON ÉQUIPE", "## TA PLACE DANS LE FLUX (A2A)", "## PROTOCOLE DE PASSATION", "## LIMITES : CE QUE TU NE FAIS JAMAIS", "## FINIR CORRECTEMENT"]) {
      assert.ok(prompt.includes(section), `section manquante : ${section}`);
    }
    assert.match(prompt, /Nora anime l'équipe/);
    assert.match(prompt, /Tu reçois le travail de Nora/);
    assert.match(prompt, /Tu consultes Victor .*send_message_to_agent/);
    assert.match(prompt, /handoff_to_teammate/);
    assert.ok(prompt.length > 2500, `prompt trop court (${prompt.length})`);
  });

  it("une demande en langage naturel retrouve la bonne Teamz", () => {
    assert.equal(matchTemplate("Monte-moi une équipe pour gérer le support client sur Intercom", TEAMZ_CATALOG)?.template.key, "support-desk");
    assert.equal(matchTemplate("je veux automatiser ma prospection commerciale avec HubSpot", TEAMZ_CATALOG)?.template.key, "sales-pod");
    assert.equal(matchTemplate("une équipe de recrutement pour embaucher des développeurs", TEAMZ_CATALOG)?.template.key, "talent-cell");
    assert.equal(matchTemplate("bonjour", TEAMZ_CATALOG), null);
  });
});

describe("plan d'équipe rendu par un modèle (entrée non fiable)", () => {
  const messy = {
    name: "Équipe Juridique",
    lead: "Marc",
    members: [
      { name: "Marc", role: "Juriste senior", mission: "x".repeat(90), responsibilities: "Relire\nNégocier\n- Valider", method: ["1. Lire", "2) Analyser", "Écrire", "Rendre"], quality: ["a", "b"], limits: ["c", "d"], deliverables: ["note"], tools: ["web_search", "hack_the_planet", { kind: "edge_function", config: { slug: "../evil" } }], connectors: ["Notion", "pas un slug !"] },
      { name: "Marc", role: "Doublon", lead: true },
      { name: "Léa", role: "Paralégale", tools: [{ kind: "rag_search" }] },
      { name: "Isolé", role: "Sans lien" },
      { role: "sans nom" },
    ],
    links: [
      { from: "marc", to: "lea", kind: "handoff", when: "un contrat arrive" },
      { from: "lea", to: "fantome", kind: "review" },
      { from: "lea", to: "lea", kind: "consult" },
      { from: "marc", to: "lea", kind: "handoff", when: "doublon" },
    ],
    routines: [{ owner: "lea", label: "Veille", cron: "0 9 * * 1", prompt: "Veille juridique" }, { owner: "x", label: "Cassée", cron: "pas un cron", prompt: "?" }],
    hours_saved_per_week: 999,
  };

  it("borne, dédoublonne, valide les liens et les outils", () => {
    const bp = normalizeBlueprint(messy, { brief: "une équipe juridique" });
    assert.deepEqual(bp.members.map((m) => m.name), ["Marc", "Marc 2", "Léa", "Isolé"]);
    assert.equal(new Set(bp.members.map((m) => m.key)).size, 4, "clés uniques");
    assert.equal(bp.members.filter((m) => m.lead).length, 1);
    assert.equal(bp.members.find((m) => m.lead)?.name, "Marc", "l'animateur désigné par le plan");
    const marc = bp.members[0];
    assert.deepEqual(marc.responsibilities, ["Relire", "Négocier", "Valider"]);
    assert.deepEqual(marc.method, ["Lire", "Analyser", "Écrire", "Rendre"]);
    assert.deepEqual(marc.tools.map((t) => t.kind), ["web_search"], "outil inconnu et fonction hors liste blanche écartés");
    assert.deepEqual(marc.connectors, ["notion"]);
    for (const l of bp.links) {
      assert.ok(bp.members.some((m) => m.key === l.from) && bp.members.some((m) => m.key === l.to));
      assert.notEqual(l.from, l.to);
    }
    // Personne n'est isolé : l'animateur est relié à chacun.
    for (const m of bp.members) assert.ok(bp.links.some((l) => l.from === m.key || l.to === m.key), `${m.name} isolé`);
    assert.equal(bp.routines.length, 1);
    assert.equal(bp.hours_saved_per_week, 60, "estimation bornée");
    assert.ok(bp.plugs.some((p) => p.slug === "notion"), "les apps des membres deviennent des prises");
  });

  it("le contrôle qualité chiffre ce qui manque", () => {
    const bp = normalizeBlueprint(messy);
    const lint = lintBlueprint(bp);
    const lea = lint.members.find((m) => m.name === "Léa")!;
    assert.ok(lea.score < 50);
    assert.ok(lea.issues.some((i) => /méthode/.test(i)));
    assert.ok(lint.score < 60);
  });

  it("estime le temps gagné sans dépasser les bornes, et l'affiche avec sa formule", () => {
    const t = TEAMZ_CATALOG[0];
    const h = estimateHoursPerWeek(t.members, t.routines);
    assert.ok(h >= 2 && h <= 60);
    const ts = timeSaved(10, 4, 25);
    assert.equal(ts.minutes, 310);
    assert.match(ts.formula, /10 exécutions réussies × 25 min \+ 4 livrables × 15 min/);
  });
});

describe("routines : du cron local à la ligne du planificateur", () => {
  it("lundi 8 h à Paris (hiver) = lundi 7 h UTC", () => {
    const now = new Date("2026-11-16T10:00:00Z"); // lundi
    const row = scheduleRowFor(cadenceOfCron("0 8 * * 1")!, -60, now);
    assert.equal(row.schedule, "weekly");
    assert.equal(row.next_run_at, "2026-11-23T07:00:00.000Z");
    assert.equal(row.schedule_hour, 7);
    assert.equal(row.schedule_dow, 1);
  });
  it("chaque jour à 7 h 30, pas encore passé aujourd'hui", () => {
    const now = new Date("2026-11-16T05:00:00Z");
    const row = scheduleRowFor(cadenceOfCron("30 7 * * *")!, -60, now);
    assert.equal(row.next_run_at, "2026-11-16T06:30:00.000Z");
  });
  it("les formes non planifiables sont refusées et décrites", () => {
    assert.equal(cadenceOfCron("0 8 * * 1-5"), null);
    assert.equal(describeCron("0 8 * * 1"), "chaque lundi à 08:00");
  });
});

describe("passation entre coéquipiers", () => {
  const teams = [{ id: "t", name: "Support", agent_ids: ["a", "b", "c"], lead_id: "a" }];
  const names = new Map([["a", "Nora"], ["b", "Sam"], ["c", "Victor"]]);

  it("exige des critères de fin vérifiables", () => {
    assert.match(String(normalizeHandoff({ to: "Sam", objective: "Répondre au client X" })), /done_when/);
    const p = normalizeHandoff({ to: "Sam", objective: "Répondre au client X", done_when: "- réponse sourcée\n- envoyée en brouillon" });
    assert.ok(typeof p !== "string");
    assert.deepEqual((p as { doneWhen: string[] }).doneWhen, ["réponse sourcée", "envoyée en brouillon"]);
  });

  it("ne passe la main qu'à un coéquipier, par prénom ou id", () => {
    const hit = teammateOf(teams, "a", "sam", names);
    assert.ok("agentId" in hit && hit.agentId === "b");
    const miss = teammateOf(teams, "a", "Paul", names);
    assert.ok("error" in miss && /Sam \(b\)/.test(miss.error));
    assert.ok("error" in teammateOf(teams, "zz", "Sam", names));
  });

  it("le brief porte le déjà-fait et les critères", () => {
    const p = normalizeHandoff({ to: "Sam", objective: "Répondre au client X", done: "Ticket trié P2", done_when: ["réponse sourcée"], deliverables: ["https://doc/1"] });
    const brief = formatHandoffBrief(p as Exclude<typeof p, string>, "Nora", "Support");
    assert.match(brief, /Déjà fait — ne le refais pas\nTicket trié P2/);
    assert.match(brief, /Critères de fin/);
    assert.match(brief, /https:\/\/doc\/1/);
  });
});

describe("preuve des actions annoncées", () => {
  const ok = (name: string, args = "{}"): ToolTrailEntry => ({ name, args, ok: true, result: "ok" });

  it("un envoi annoncé sans appel réussi est signalé", () => {
    const claims = findUnbackedClaims("C'est fait. J'ai envoyé l'email de relance au client.", []);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].family, "send");
  });
  it("un envoi prouvé par un appel réussi passe", () => {
    assert.deepEqual(findUnbackedClaims("J'ai envoyé l'email au client.", [ok("composio_execute", '{"action":"GMAIL_SEND_EMAIL"}')]), []);
  });
  it("un brouillon ou une action en attente n'est pas une affirmation", () => {
    assert.deepEqual(findUnbackedClaims("Le brouillon est prêt à envoyer, j'attends ta validation.", []), []);
    assert.deepEqual(findUnbackedClaims("Je n'ai pas envoyé l'email : il attend ton accord.", []), []);
  });
  it("un appel en échec ou en attente d'approbation ne prouve rien", () => {
    const trail = toolTrail([
      { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "send_email", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: "ERROR: SMTP refusé" },
      { role: "assistant", content: "", tool_calls: [{ id: "2", type: "function", function: { name: "send_email", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "2", content: "Action en attente d'approbation humaine." },
    ] as never);
    assert.equal(trail.length, 2);
    assert.ok(trail.every((t) => !t.ok));
    assert.equal(findUnbackedClaims("J'ai envoyé l'email.", trail).length, 1);
  });
  it("publication et planification", () => {
    assert.equal(findUnbackedClaims("Le post a été publié sur LinkedIn.", [])[0]?.family, "publish");
    assert.deepEqual(findUnbackedClaims("J'ai planifié la réunion de lundi.", [ok("googlecalendar_create_event")]), []);
  });
});

describe("cache de prompt (Claude / Gemini via OpenRouter)", () => {
  const msgs = [
    { role: "system", content: "Tu es un agent." },
    { role: "user", content: "Fais X" },
    { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "t", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "1", content: "résultat" },
  ];

  it("marque le système et le dernier message texte, jamais un résultat d'outil", () => {
    const out = withCacheBreakpoints(msgs);
    assert.deepEqual(out[0].content, [{ type: "text", text: "Tu es un agent.", cache_control: { type: "ephemeral" } }]);
    assert.deepEqual(out[1].content, [{ type: "text", text: "Fais X", cache_control: { type: "ephemeral" } }]);
    assert.equal(out[3].content, "résultat");
    assert.equal(msgs[0].content, "Tu es un agent.", "l'original n'est pas modifié");
  });

  it("Claude : le point du système dure une heure, celui de la queue cinq minutes", () => {
    const out = withCacheBreakpoints(msgs, "anthropic/claude-sonnet-4.5");
    assert.deepEqual(out[0].content, [{ type: "text", text: "Tu es un agent.", cache_control: { type: "ephemeral", ttl: "1h" } }]);
    assert.deepEqual(out[1].content, [{ type: "text", text: "Fais X", cache_control: { type: "ephemeral" } }]);
    // Gemini ne connaît pas le TTL long : il garde le point standard.
    const gemini = withCacheBreakpoints(msgs, "google/gemini-3-pro");
    assert.deepEqual(gemini[0].content, [{ type: "text", text: "Tu es un agent.", cache_control: { type: "ephemeral" } }]);
    process.env.LLM_PROMPT_CACHE_TTL = "5m";
    try {
      const short = withCacheBreakpoints(msgs, "anthropic/claude-sonnet-4.5");
      assert.deepEqual(short[0].content, [{ type: "text", text: "Tu es un agent.", cache_control: { type: "ephemeral" } }]);
    } finally {
      delete process.env.LLM_PROMPT_CACHE_TTL;
    }
  });

  it("seulement pour les modèles qui en ont besoin", () => {
    const claude = openrouterDialect({ model: "anthropic/claude-sonnet-4.5", messages: msgs });
    assert.ok(Array.isArray((claude.messages as Array<{ content: unknown }>)[0].content));
    const gpt = openrouterDialect({ model: "openai/gpt-5", messages: msgs });
    assert.equal((gpt.messages as Array<{ content: unknown }>)[0].content, "Tu es un agent.");
  });

  it("se retire proprement quand un fournisseur le refuse", () => {
    const body = { messages: withCacheBreakpoints(msgs) as Array<Record<string, unknown>> } as Record<string, unknown>;
    assert.equal(stripCacheControl(body), true);
    assert.equal((body.messages as Array<{ content: unknown }>)[0].content, "Tu es un agent.");
    assert.equal(stripCacheControl(body), false);
  });
});

describe("outil manage_teams", () => {
  it("expose ses actions", () => {
    const def = teamOpsToolDef();
    assert.equal(def.name, "manage_teams");
    assert.deepEqual((def.parameters.properties.action as { enum: string[] }).enum, ["catalog", "design", "deploy", "install"]);
  });
});
