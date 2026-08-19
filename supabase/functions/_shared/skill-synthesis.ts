// skill-synthesis — transforme une DÉMONSTRATION en skill réutilisable.
//
// Entrée : les événements d'un skill_recordings (gestes navigateur poussés par
// le recorder Playwright + segments de narration poussés par l'app), tous datés
// en ms depuis started_at.
//
// Le travail utile est fait AVANT le LLM :
//   1. fusion chronologique des deux flux (c'est là que "ce que l'utilisateur
//      dit" rejoint "ce que l'utilisateur fait") ;
//   2. compression du bruit — les frappes successives sur un même champ
//      deviennent une ligne "fill", les scrolls consécutifs s'effondrent ;
//   3. rattachement de chaque geste au segment de narration qui le RECOUVRE ou
//      le précède immédiatement, dans une fenêtre bornée.
//
// Le LLM ne voit donc pas un journal brut mais un récit déjà structuré, dont il
// n'a plus qu'à extraire une procédure généralisable.

import { callAi, safeParseJson } from "./ai.ts";
import { logLlmUsage } from "./llm-tracking.ts";
import { createServiceClient } from "./supabase-admin.ts";

export interface RecordingEvent {
  source: string;
  seq: number;
  at_ms: number;
  kind: string;
  url: string | null;
  target: Record<string, unknown>;
  value: string | null;
  is_secret: boolean;
  duration_ms: number | null;
}

export interface RecordingRow {
  id: string;
  workspace_id: string;
  project_id: string | null;
  agent_id: string | null;
  title: string;
  goal: string | null;
  start_url: string | null;
  duration_ms: number | null;
}

// Une narration "couvre" un geste survenu pendant qu'elle était prononcée, ou
// dans les 4 s qui suivent — on décrit très souvent ce qu'on vient de faire
// ("là je valide") juste après l'avoir fait.
const NARRATION_LOOKBACK_MS = 4000;
// …et parfois juste avant ("maintenant je vais cliquer sur Créer").
const NARRATION_LOOKAHEAD_MS = 2500;

const clip = (s: unknown, max = 120): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
};

/** Libellé le plus parlant pour une cible, du plus stable au moins stable. */
export function targetLabel(target: Record<string, unknown>): string {
  const t = target ?? {};
  const label = clip(t.label ?? t.text ?? t.placeholder ?? t.name ?? "", 80);
  const role = String(t.role ?? t.tag ?? "élément");
  const testid = t.testid ? ` [data-testid=${clip(t.testid, 40)}]` : "";
  return label ? `${role} « ${label} »${testid}` : `${role}${testid || " (sans libellé)"}`;
}

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Effondre les répétitions sans intérêt. Deux règles seulement, mais elles
 * suppriment l'essentiel du volume :
 *   - saisies successives sur la MÊME cible → on ne garde que la dernière
 *     (la valeur finale du champ, pas les frappes intermédiaires) ;
 *   - scrolls consécutifs → un seul.
 */
export function compressEvents(events: RecordingEvent[]): RecordingEvent[] {
  const identity = (ev: RecordingEvent) =>
    String(ev.target?.css ?? ev.target?.label ?? ev.target?.name ?? "");
  const out: RecordingEvent[] = [];
  for (const ev of events) {
    const prev = out[out.length - 1];
    if (!prev) { out.push(ev); continue; }
    if (ev.kind === "fill" && prev.kind === "fill" && identity(prev) === identity(ev)) {
      out[out.length - 1] = ev;
      continue;
    }
    if (ev.kind === "scroll" && prev.kind === "scroll") { out[out.length - 1] = ev; continue; }
    out.push(ev);
  }
  return out;
}

/** Rendu texte d'un geste, tel que le LLM le lira. */
function renderAction(ev: RecordingEvent): string {
  const t = ev.target ?? {};
  const where = targetLabel(t);
  const val = ev.is_secret ? "«valeur masquée»" : clip(ev.value, 160);
  switch (ev.kind) {
    case "navigate":  return `aller sur ${clip(ev.url, 160)}`;
    case "click":     return `cliquer sur ${where}`;
    case "fill":      return `saisir "${val}" dans ${where}`;
    case "select":    return `choisir "${val}" dans ${where}`;
    case "check":     return `${ev.value === "false" ? "décocher" : "cocher"} ${where}`;
    case "press":     return `appuyer sur ${val || "une touche"} (focus : ${where})`;
    case "submit":    return `valider le formulaire ${where}`;
    case "upload":    return `téléverser ${val} dans ${where}`;
    case "copy":      return `copier "${val}"`;
    case "scroll":    return "faire défiler la page";
    case "tab_open":  return `ouvrir un nouvel onglet sur ${clip(ev.url, 160)}`;
    case "tab_close": return "fermer un onglet";
    case "note":      return `note de l'utilisateur : ${clip(ev.value, 200)}`;
    default:          return `${ev.kind} ${where}`;
  }
}

/**
 * Construit le récit fusionné. Chaque ligne est un geste horodaté, suivi — quand
 * il y en a une — de la phrase que l'utilisateur prononçait à ce moment-là.
 * Les narrations qui ne recouvrent aucun geste sont émises seules : ce sont
 * souvent les plus précieuses (le "pourquoi", les cas particuliers).
 */
export function buildTimeline(events: RecordingEvent[]): string {
  const actions = compressEvents(events.filter((e) => e.source !== "narration"));
  const narrations = events
    .filter((e) => e.source === "narration" && (e.value ?? "").trim())
    .sort((a, b) => a.at_ms - b.at_ms);

  const used = new Set<number>();
  const lines: string[] = [];

  // Curseur d'insertion des narrations orphelines : avant chaque geste, on émet
  // toute narration antérieure encore non consommée.
  let ni = 0;
  const flushNarrationsBefore = (limitMs: number) => {
    while (ni < narrations.length && narrations[ni].at_ms < limitMs) {
      const n = narrations[ni];
      if (!used.has(n.seq)) {
        used.add(n.seq);
        lines.push(`[${mmss(n.at_ms)}] 🗣  « ${clip(n.value, 400)} »`);
      }
      ni++;
    }
  };

  for (const ev of actions) {
    flushNarrationsBefore(ev.at_ms - NARRATION_LOOKAHEAD_MS);

    // Narration couvrant ce geste : celle dont la fenêtre
    // [début - lookahead, fin + lookback] contient l'instant du geste.
    const covering = narrations.find((n) => {
      if (used.has(n.seq)) return false;
      const start = n.at_ms - NARRATION_LOOKAHEAD_MS;
      const end = n.at_ms + (n.duration_ms ?? 0) + NARRATION_LOOKBACK_MS;
      return ev.at_ms >= start && ev.at_ms <= end;
    });

    let line = `[${mmss(ev.at_ms)}] ${renderAction(ev)}`;
    if (covering) {
      used.add(covering.seq);
      line += `\n        ↳ dit : « ${clip(covering.value, 400)} »`;
    }
    lines.push(line);
  }

  // Narrations postérieures au dernier geste (conclusion, mise en garde…).
  flushNarrationsBefore(Number.MAX_SAFE_INTEGER);

  return lines.join("\n");
}

const SYSTEM_PROMPT = `Tu es un ingénieur qui transforme la DÉMONSTRATION d'un humain en une compétence (skill) exécutable par un agent IA.

On te donne la trace chronologique d'une session : les gestes réellement effectués dans un navigateur, et — préfixées par 🗣 ou "dit :" — les phrases que l'humain prononçait EN MÊME TEMPS pour expliquer ce qu'il faisait et pourquoi.

Règles :
- La NARRATION prime pour l'INTENTION ; les GESTES priment pour les détails techniques (sélecteurs, URLs, libellés exacts). Quand l'humain énonce une règle métier ("si le client est déjà dans la liste, on passe à l'étape suivante"), elle doit figurer dans la procédure même si la démo ne l'illustre pas.
- GÉNÉRALISE. Les valeurs saisies pendant la démo sont des EXEMPLES : transforme-les en variables {{nom_variable}} et déclare-les. Toute valeur marquée «valeur masquée» est un secret : c'est TOUJOURS une variable, jamais une constante.
- N'invente pas d'étape qui n'a été ni démontrée ni énoncée. Si un passage est ambigu, signale-le dans "Points d'attention" et dans open_questions plutôt que de combler le trou.
- Le rendu doit être opérationnel : un agent qui pilote un navigateur doit pouvoir suivre le playbook sans avoir vu la démo.

Réponds UNIQUEMENT par un objet JSON :
{
  "name": "nom court et actionnable (max 60 car.)",
  "slug": "kebab-case",
  "description": "une phrase : ce que la skill permet de faire et quand l'utiliser",
  "category": "un mot-clé (crm, admin, finance, support, recherche…)",
  "icon": "un nom d'icone lucide en PascalCase (ex: ClipboardCheck)",
  "variables": [{"name": "nom_variable", "description": "…", "example": "…", "secret": true}],
  "skill_md": "le playbook complet en Markdown (plan imposé ci-dessous)",
  "steps": [{"n": 1, "action": "click|fill|navigate|select|check|press|submit|upload|verify", "target": "libellé ou sélecteur le plus stable", "value": "valeur ou {{variable}}", "url": "si navigate", "expect": "ce qui doit être vrai après cette étape"}],
  "open_questions": ["ce qui reste ambigu dans la démonstration"]
}

Plan imposé pour skill_md :
# <nom>
## Objectif
## Quand l'utiliser
## Prérequis
## Variables
## Procédure
## Vérification
## Points d'attention

Écris en français.`;

export interface SynthesisResult {
  skillId: string;
  name: string;
  slug: string;
}

function slugify(s: string): string {
  return s.trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "skill-enregistree";
}

/** Un slug libre dans le workspace (l'index unique porte sur (workspace_id, slug)). */
async function freeSlug(
  admin: ReturnType<typeof createServiceClient>,
  workspaceId: string,
  base: string,
): Promise<string> {
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const { data } = await admin.from("agent_skills")
      .select("id").eq("workspace_id", workspaceId).eq("slug", slug).maybeSingle();
    if (!data) return slug;
    slug = `${base}-${i}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Synthétise et PERSISTE la skill. Met à jour skill_recordings (status /
 * skill_id / error) dans tous les cas, pour que l'UI n'ait qu'une seule ligne à
 * observer.
 */
export async function synthesizeSkill(recordingId: string): Promise<SynthesisResult> {
  const admin = createServiceClient();

  const { data: rec } = await admin.from("skill_recordings")
    .select("id, workspace_id, project_id, agent_id, title, goal, start_url, duration_ms")
    .eq("id", recordingId).maybeSingle();
  if (!rec) throw new Error("recording introuvable");
  const recording = rec as RecordingRow;

  const fail = async (message: string) => {
    await admin.from("skill_recordings")
      .update({ status: "failed", error: message.slice(0, 500) }).eq("id", recordingId);
  };

  try {
    // La trace peut être longue : on borne à 1200 événements — bien au-delà
    // d'une démo normale — et la compression fait le reste.
    const { data: rows } = await admin.from("skill_recording_events")
      .select("source, seq, at_ms, kind, url, target, value, is_secret, duration_ms")
      .eq("recording_id", recordingId).order("at_ms").limit(1200);
    const events = (rows ?? []) as RecordingEvent[];

    const gestures = events.filter((e) => e.source !== "narration");
    if (gestures.length === 0) {
      await fail("Aucun geste n'a été enregistré — la démonstration est vide.");
      throw new Error("recording vide");
    }

    const timeline = buildTimeline(events);
    const narrationText = events.filter((e) => e.source === "narration")
      .map((e) => (e.value ?? "").trim()).filter(Boolean).join(" ");

    const userPrompt = [
      `Titre donné par l'utilisateur : ${recording.title}`,
      recording.goal ? `Objectif annoncé avant la démo : ${recording.goal}` : null,
      recording.start_url ? `URL de départ : ${recording.start_url}` : null,
      `Durée : ${mmss(recording.duration_ms ?? 0)} · ${gestures.length} gestes · ${events.length - gestures.length} segments de narration`,
      "",
      "=== TRACE CHRONOLOGIQUE ===",
      timeline,
    ].filter(Boolean).join("\n");

    const ai = await callAi({
      task: "json_extraction",
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      jsonMode: true,
      maxTokens: 6000,
      temperature: 0.2,
    });

    await logLlmUsage({
      workspace_id: recording.workspace_id,
      project_id: recording.project_id,
      provider: ai.provider,
      model: ai.model,
      task: "json_extraction",
      feature: "skill_recording_synthesis",
      usage: ai.usage,
      metadata: { recording_id: recordingId },
    });

    const parsed = safeParseJson<{
      name?: string; slug?: string; description?: string; category?: string; icon?: string;
      variables?: Array<{ name?: string; description?: string; example?: string; secret?: boolean }>;
      skill_md?: string;
      steps?: Array<Record<string, unknown>>;
      open_questions?: string[];
    }>(ai.content);

    if (!parsed?.skill_md) {
      await fail("La synthèse n'a pas produit de playbook exploitable.");
      throw new Error("synthèse invalide");
    }

    const name = (parsed.name ?? recording.title).slice(0, 80);
    const slug = await freeSlug(admin, recording.workspace_id, slugify(parsed.slug || name));

    const { data: skill, error: skillErr } = await admin.from("agent_skills").insert({
      workspace_id: recording.workspace_id,
      name,
      slug,
      description: (parsed.description ?? "").slice(0, 500),
      category: (parsed.category ?? "demonstration").slice(0, 60),
      icon: parsed.icon || "Clapperboard",
      system_prompt_extension: parsed.skill_md,
      // Rejouer la procédure demande de piloter un navigateur : on déclare
      // l'outil correspondant pour que l'activation signale ce qui manque.
      required_tools: ["sandbox_browser"],
      is_system: false,
      source_recording_id: recordingId,
      config: {
        origin: "recording",
        variables: parsed.variables ?? [],
        open_questions: parsed.open_questions ?? [],
      },
    }).select("id").single();
    if (skillErr || !skill) {
      await fail(`Écriture de la skill impossible : ${skillErr?.message ?? "inconnu"}`);
      throw new Error(skillErr?.message ?? "insert skill failed");
    }

    // Fichiers joints (divulgation progressive : l'agent les lit à la demande
    // via read_skill_file, ils n'encombrent pas son prompt système).
    const files: Array<{ path: string; content: string; sort: number }> = [];
    if (Array.isArray(parsed.steps) && parsed.steps.length) {
      files.push({ path: "steps.json", content: JSON.stringify(parsed.steps, null, 2), sort: 0 });
    }
    files.push({
      path: "demonstration.md",
      content: [
        "# Démonstration source",
        "",
        `Enregistrée le ${new Date().toLocaleDateString("fr-FR")} · ${mmss(recording.duration_ms ?? 0)} · ${gestures.length} gestes.`,
        "Cette trace est la SOURCE de vérité : si le playbook et elle divergent, c'est la trace qui a raison.",
        "",
        "## Trace chronologique (gestes + narration)",
        "",
        "```",
        timeline,
        "```",
        "",
        narrationText ? `## Narration continue\n\n${narrationText}` : "",
      ].join("\n"),
      sort: files.length,
    });

    await admin.from("agent_skill_files")
      .insert(files.map((f) => ({ skill_id: skill.id, ...f })));

    // Activation immédiate sur l'agent visé, s'il y en a un : l'utilisateur a
    // démontré POUR cet agent, il ne devrait pas avoir à l'activer à la main.
    if (recording.agent_id) {
      await admin.from("agent_skill_activations")
        .upsert({ agent_id: recording.agent_id, skill_id: skill.id }, { onConflict: "agent_id,skill_id" });
    }

    await admin.from("skill_recordings").update({
      status: "ready",
      skill_id: skill.id,
      narration: narrationText.slice(0, 20000),
      error: null,
    }).eq("id", recordingId);

    return { skillId: skill.id, name, slug };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // fail() a déjà pu écrire un message plus précis : on n'écrase pas un
    // statut déjà terminal.
    const { data: cur } = await admin.from("skill_recordings")
      .select("status").eq("id", recordingId).maybeSingle();
    if ((cur as { status?: string } | null)?.status !== "failed") await fail(message);
    throw err;
  }
}
