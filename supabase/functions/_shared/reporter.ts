// Le Rédacteur — the one agent that writes the reports.
//
// Every other agent gathers; this one writes. A caller hands over the MATTER
// (figures, sources, findings, context) and gets back a published report. It
// does not search, does not browse, does not run missions: giving it tools would
// re-create the problem it exists to solve, an agent that half-investigates and
// half-writes and does neither well.
//
// The run happens in-process, as a child run of the caller's (run_kind='report'),
// so its authoring shows up in the timeline and the cost lands on the right
// workspace. The document accumulates in a closure rather than in run_state:
// the whole authoring pass lives inside one call, and a draft that outlives its
// call is a draft that gets published twice.
//
// The deliverable is attached to the CALLER's run, not to the child: the mission
// produced the report, the Rédacteur merely held the pen — and the success
// contract counts deliverables by run_id.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { callAiWithTools, type ChatMessage, type ToolDef } from "./ai.ts";
import { logLlmUsage } from "./llm-tracking.ts";
import {
  blockKey, blockSubstanceKey, buildReportHtml, loadReportAssets, normalizeReportDoc, reportPreviewText, reportShape,
  resolveSourceIcons, validateBlock, validateReportDoc,
  ACCENTS, BANNER_STYLES, BLOCK_TYPES, CHART_TYPES, REPEATABLE_BLOCKS, TYPEFACES,
  type ReportBlock, type ReportDoc, type ReportSource,
} from "./report-artisan.ts";

export const REPORT_BUCKET = "agent-reports";

/** Enough rounds for a real report — a dozen blocks, plus the playbooks it
 *  loads on the way. Below this the Rédacteur publishes something thin because
 *  it ran out of turns, which reads as a quality problem and is not one. */
const REPORT_ROUNDS = 26;

export interface ReportBrief {
  /** What the report is about — becomes the working title. */
  subject: string;
  /** The raw matter: figures, sources, findings, quotes, context. */
  material: string;
  /** The question the report has to answer, or what it must demonstrate. */
  angle?: string;
  /** Who reads it (a client, the team, a board) — sets the register. */
  audience?: string;
  /** Brand accent, kept constant across a client's reports. */
  accent?: string;
  /** Locale for number formatting (default fr-FR). */
  locale?: string;
}

export interface ReporterDeps {
  admin: SupabaseClient;
  workspaceId: string;
  projectId: string;
  /** The caller's run — the report is attributed to it. */
  parentRunId: string | null;
  missionId?: string | null;
  conversationId?: string | null;
  /** Who asked. Recorded on the child run so the timeline says why it exists. */
  requesterAgentId?: string | null;
  requesterName?: string | null;
  createdBy?: string | null;
  /** Emit an event on the CALLER's run, so the card appears where the work
   *  happened rather than in a child nobody opens. */
  parentLogEvent?: (kind: string, payload: Record<string, unknown>) => Promise<void>;
}

export interface ReportResult {
  ok: boolean;
  deliverableId?: string;
  title?: string;
  /** Storage paths inside REPORT_BUCKET. */
  path?: string;
  staticPath?: string;
  warnings: string[];
  /** What to hand back to the calling agent. */
  message: string;
}

// ---------------------------------------------------------------------------
// Resolution — "toujours présent" cannot depend on a trigger having fired
// ---------------------------------------------------------------------------

export interface ReporterAgent {
  id: string; name: string; persona: string | null; instructions: string | null;
  model: string | null; temperature: number | null;
}

export async function resolveReporter(admin: SupabaseClient, projectId: string): Promise<ReporterAgent | null> {
  // The RPC creates it when missing, so a project imported before this feature —
  // or one whose creation path skipped the trigger — still has a Rédacteur the
  // first time anyone asks for a report.
  const { data: id } = await admin.rpc("ensure_report_agent", { p_project: projectId });
  if (!id) return null;
  const { data } = await admin
    .from("internal_agents")
    .select("id, name, persona, instructions, model, temperature")
    .eq("id", id as string)
    .maybeSingle();
  return (data ?? null) as ReporterAgent | null;
}

// ---------------------------------------------------------------------------
// The toolset — four tools, and nothing that could distract from writing
// ---------------------------------------------------------------------------

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : v == null ? d : String(v));

function toolDefs(): ToolDef[] {
  return [
    {
      type: "function",
      incompressible: true,
      function: {
        name: "report_open",
        description:
          "Ouvre le document et fixe sa forme. À appeler UNE fois, avant tout bloc. "
          + "Le titre de la bannière porte la CONCLUSION du rapport ; `title` nomme le document — ce ne doit pas être le même texte.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Le titre du document (son <h1>)." },
            subtitle: { type: "string", description: "Une ou deux phrases sous le titre." },
            eyebrow: { type: "string", description: "Surtitre court (« Rapport de mission »)." },
            accent: { type: "string", enum: [...ACCENTS], description: "Couleur d'accent. Garde la même sur une série de rapports pour un même client." },
            typeface: { type: "string", enum: [...TYPEFACES], description: "editorial (titres en serif, chaleureux) ou modern (tout en sans, neutre)." },
            theme: { type: "string", enum: ["light", "dark"] },
            locale: { type: "string", description: "Formatage des nombres, fr-FR par défaut." },
            footer: { type: "string", description: "Mention de bas de page (« Novaris SAS — document interne »)." },
            meta: {
              type: "object",
              description: 'Paires affichées sous le sous-titre, ordre conservé : {"Client":"Novaris SAS","Période":"3 juin — 15 juillet"}.',
              additionalProperties: { type: "string" },
            },
            heroBanner: {
              type: "object",
              description: "La bannière d'ouverture. Son `title` est la conclusion du rapport, dite en une phrase.",
              properties: {
                style: { type: "string", enum: [...BANNER_STYLES] },
                eyebrow: { type: "string" },
                title: { type: "string" },
                subtitle: { type: "string" },
              },
            },
            sources: {
              type: "array",
              description:
                "Les sources du rapport, déclarées UNE fois ici. Chacune porte son nom lisible et l'URL EXACTE de la page consultée "
                + "(pas la racine du site). Le logo du site est récupéré et intégré automatiquement. "
                + 'Ensuite, dans le corps, cite-les par leur nom avec un bloc {type:"sources", data:{items:["Nom A","Nom B"]}} '
                + "placé juste après le passage qu'elles appuient.",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Nom lisible : « Stack Overflow », « BLS », « McKinsey »." },
                  url: { type: "string", description: "URL complète de la page consultée." },
                },
                required: ["name", "url"],
              },
            },
          },
          required: ["title"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      incompressible: true,
      function: {
        name: "report_add_block",
        description:
          "Ajoute UN bloc, dans l'ordre de lecture. Un appel par bloc. "
          + `Types : ${BLOCK_TYPES.join(" · ")}. `
          + `Graphiques : ${CHART_TYPES.join(" · ")}. `
          + 'CITER : le bloc sources appuie le passage qui le précède — {"type":"sources","data":{"items":["Stack Overflow","BLS"]}}, '
          + "avec les noms EXACTS déclarés dans report_open. "
          + 'Forme exacte de chaque bloc : read_skill_file(path="content-schema.md"). '
          + "Le bloc est refusé si sa forme est fausse — corrige et rappelle. "
          + "CORRIGER un bloc déjà ajouté (une rangée d'indicateurs à qui il manquait sa variation, "
          + "un graphique mal légendé) : renvoie-le complet avec les MÊMES chiffres — il remplace le précédent "
          + "sur place au lieu de s'ajouter en double.",
        parameters: {
          type: "object",
          properties: {
            block: {
              type: "object",
              description: 'Un bloc : { "type": "kpis", "data": { … } }.',
              properties: {
                type: { type: "string", enum: [...BLOCK_TYPES] },
                data: { type: "object" },
              },
              required: ["type", "data"],
            },
          },
          required: ["block"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      incompressible: true,
      function: {
        name: "report_publish",
        description:
          "Construit et publie le rapport. Valide avant d'écrire : un document invalide n'est pas publié et te revient avec ses erreurs. "
          + "Après publication, réponds en deux phrases — pas de recopie du rapport.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "read_skill_file",
        description:
          "Lis une fiche du skill Report Artisan : content-schema.md (la forme exacte de chaque bloc), "
          + "charts.md (choisir et régler un graphique), gallery.md (bannières, accents, pictogrammes).",
        parameters: {
          type: "object",
          properties: { path: { type: "string", enum: ["content-schema.md", "charts.md", "gallery.md"] } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

interface PublishOutcome { deliverableId: string; title: string; path: string; staticPath: string; warnings: string[] }

async function publish(deps: ReporterDeps, reporter: ReporterAgent, doc: ReportDoc): Promise<PublishOutcome> {
  const normalised = normalizeReportDoc(doc);
  // Belt and braces on top of the guard in report_add_block: whatever path a
  // duplicate came in by, it does not reach the file. A reader scrolling past
  // the same KPI row four times has stopped reading.
  const seen = new Set<string>();
  // Substance → where its first writing sits in `kept`, so a later rewrite
  // overwrites that slot instead of piling up under it.
  const substanceAt = new Map<string, number>();
  const kept: ReportBlock[] = [];
  for (const b of normalised.blocks ?? []) {
    if (REPEATABLE_BLOCKS.has(b.type)) { kept.push(b); continue; }
    const k = blockKey(b);
    if (seen.has(k)) continue;
    seen.add(k);
    const substance = blockSubstanceKey(b);
    const at = substance ? substanceAt.get(substance) : undefined;
    if (at !== undefined) { kept[at] = b; continue; }
    if (substance) substanceAt.set(substance, kept.length);
    kept.push(b);
  }
  const dropped = (normalised.blocks ?? []).length - kept.length;
  normalised.blocks = kept;

  // Before validation: the marks are fetched once, here, and inlined — so the
  // file still shows them offline. Best-effort; a missing one becomes a monogram.
  const icons = await resolveSourceIcons(normalised);
  const { errors, warnings } = validateReportDoc(normalised);
  if (dropped > 0) warnings.push(`${dropped} bloc(s) en double retiré(s) avant construction.`);
  if (icons.missed.length) {
    warnings.push(`Logo introuvable pour : ${icons.missed.join(", ")} — ces sources portent un monogramme.`);
  }
  if (errors.length) {
    throw new ValidationError(errors, warnings);
  }

  const assets = await loadReportAssets(deps.admin);
  const editable = buildReportHtml(normalised, assets, { static: false });
  const frozen = buildReportHtml(normalised, assets, { static: true });

  // The folder is claimed before the row exists: the first path segment is what
  // the storage policy authorises on, and the second only has to be unique.
  const reportId = crypto.randomUUID();
  const base = `${deps.workspaceId}/${reportId}`;
  const path = `${base}/rapport.html`;
  const staticPath = `${base}/rapport-fige.html`;

  const upload = async (p: string, html: string) => {
    const { error } = await deps.admin.storage.from(REPORT_BUCKET).upload(
      p,
      new Blob([html], { type: "text/html; charset=utf-8" }),
      { contentType: "text/html; charset=utf-8", upsert: true },
    );
    if (error) throw new Error(`le fichier n'a pas pu être écrit (${error.message})`);
  };
  await upload(path, editable);
  await upload(staticPath, frozen);

  const title = str(normalised.title, "Rapport").slice(0, 160);
  // The document travels WITH the deliverable: it is what makes the report
  // re-buildable (a re-brand, a fix, a static export) without asking the model
  // to write it a second time.
  const content = JSON.stringify({
    format: "report-artisan",
    version: 1,
    bucket: REPORT_BUCKET,
    path,
    static_path: staticPath,
    built_at: new Date().toISOString(),
    bytes: editable.length,
    warnings,
    doc: normalised,
  });

  const { data: row, error } = await deps.admin.from("internal_agent_deliverables").insert({
    run_id: deps.parentRunId,
    mission_id: deps.missionId ?? null,
    conversation_id: deps.conversationId ?? null,
    agent_id: reporter.id,
    kind: "report",
    name: title,
    content,
    summary: reportPreviewText(normalised).split("\n").slice(0, 3).join(" ").slice(0, 500),
  }).select("id").maybeSingle();

  const deliverableId = (row as { id?: string } | null)?.id;
  if (error || !deliverableId) {
    throw new Error(`le rapport a été construit mais pas enregistré (${error?.message ?? "aucune ligne écrite"})`);
  }

  await deps.parentLogEvent?.("ui", {
    block: { component: "deliverable", props: { id: deliverableId, name: title, kind: "report", agentId: reporter.id } },
  }).catch(() => {});

  return { deliverableId, title, path, staticPath, warnings };
}

class ValidationError extends Error {
  constructor(readonly errors: string[], readonly warnings: string[]) {
    super(errors.join(" "));
    this.name = "ValidationError";
  }
}

// ---------------------------------------------------------------------------
// The authoring pass
// ---------------------------------------------------------------------------

function buildSystemPrompt(reporter: ReporterAgent, skillPrompt: string, brief: ReportBrief): string {
  return [
    reporter.persona?.trim() || "Tu es Le Rédacteur : on te confie de la matière brute, tu en fais un document qui se lit.",
    "",
    skillPrompt.trim(),
    "",
    reporter.instructions?.trim() ?? "",
    "",
    "CE QUE TU NE FAIS PAS",
    "Tu n'enquêtes pas et tu n'as aucun outil pour le faire : pas de recherche, pas de navigation, pas d'appel d'API. La matière ci-dessous est TOUT ce que tu as.",
    "Ce qui n'y est pas ne s'invente pas. Une donnée absente s'écrit « non publié » ; une donnée incertaine porte sa réserve dans le bloc où elle apparaît.",
    "Un rapport court et juste vaut mieux qu'un rapport étoffé de généralités : si la matière porte six blocs, écris six blocs.",
    "",
    "TON DERNIER GESTE est report_publish(). Un rapport non publié n'existe pas — ne termine jamais en décrivant ce que tu allais écrire.",
    brief.audience ? `\nLECTEUR : ${brief.audience}.` : "",
  ].filter((l) => l !== null).join("\n");
}

function buildBriefMessage(brief: ReportBrief, requesterName?: string | null): string {
  const from = requesterName ? `${requesterName} te transmet` : "On te transmet";
  return [
    `${from} la matière d'un rapport.`,
    "",
    `## Sujet\n${brief.subject}`,
    brief.angle ? `\n## Ce que le rapport doit démontrer\n${brief.angle}` : "",
    brief.audience ? `\n## Lecteur\n${brief.audience}` : "",
    `\n## Matière\n${brief.material}`,
    "",
    "Écris le rapport maintenant : report_open, puis un report_add_block par bloc, puis report_publish.",
  ].filter(Boolean).join("\n");
}

export async function writeReport(deps: ReporterDeps, brief: ReportBrief): Promise<ReportResult> {
  const { admin } = deps;
  const fail = (message: string): ReportResult => ({ ok: false, warnings: [], message });

  if (!deps.projectId) return fail("ERROR: aucun projet sur ce run — impossible de joindre Le Rédacteur.");
  if (!str(brief.material).trim()) {
    return fail("ERROR: `material` est vide. Le Rédacteur n'enquête pas : passe-lui les chiffres, les sources et les constats que tu as recueillis, sinon il n'a rien à écrire.");
  }

  const reporter = await resolveReporter(admin, deps.projectId);
  if (!reporter) return fail("ERROR: Le Rédacteur est introuvable pour ce projet.");

  const { data: skill } = await admin
    .from("agent_skills")
    .select("id, system_prompt_extension")
    .is("workspace_id", null).eq("slug", "report-artisan")
    .maybeSingle();
  const skillPrompt = str((skill as { system_prompt_extension?: string } | null)?.system_prompt_extension);
  const skillId = str((skill as { id?: string } | null)?.id);
  if (!skillPrompt) {
    return fail("ERROR: le skill report-artisan n'est pas installé (migration 0206) — Le Rédacteur ne sait pas quoi produire.");
  }

  const label = `Rapport — ${str(brief.subject, "sans sujet").slice(0, 90)}`;
  const { data: child } = await admin.from("internal_agent_runs").insert({
    agent_id: reporter.id,
    workspace_id: deps.workspaceId,
    project_id: deps.projectId,
    mission_id: deps.missionId ?? null,
    parent_run_id: deps.parentRunId,
    run_kind: "report",
    label,
    is_ephemeral: true,
    status: "running",
    started_at: new Date().toISOString(),
    triggered_by: deps.createdBy ?? null,
  }).select("id").maybeSingle();
  const childRunId = (child as { id?: string } | null)?.id ?? null;

  /** No child row (the insert failed) → the authoring still runs, it just is
   *  not traced. Losing the trace must never lose the report. */
  const finishRun = async (patch: Record<string, unknown>) => {
    if (!childRunId) return;
    await admin.from("internal_agent_runs").update(patch).eq("id", childRunId).then(() => {}, () => {});
  };

  const logChild = async (kind: string, payload: Record<string, unknown>) => {
    if (!childRunId) return;
    await admin.from("internal_agent_run_events")
      .insert({ run_id: childRunId, agent_id: reporter.id, kind, payload })
      .then(() => {}, () => {});
  };
  await deps.parentLogEvent?.("status", { message: `Le Rédacteur écrit « ${str(brief.subject).slice(0, 80)} »…`, child_run_id: childRunId }).catch(() => {});

  // The document under construction. One pass, one document — see the header.
  let doc: ReportDoc | null = null;
  let published: PublishOutcome | null = null;

  const executor = async (name: string, args: Record<string, unknown>): Promise<string> => {
    await logChild("tool_call", { tool: name, args: name === "report_add_block" ? { type: (args.block as ReportBlock)?.type } : args });
    const out = await (async (): Promise<string> => {
      switch (name) {
        case "report_open": {
          const title = str(args.title).trim();
          if (!title) return "ERROR: `title` est requis.";
          doc = {
            title,
            subtitle: str(args.subtitle) || undefined,
            eyebrow: str(args.eyebrow) || undefined,
            accent: str(args.accent) || "blue",
            typeface: str(args.typeface) || "editorial",
            theme: args.theme === "dark" ? "dark" : "light",
            locale: str(args.locale) || str(brief.locale) || "fr-FR",
            lang: (str(args.locale) || str(brief.locale) || "fr-FR").slice(0, 2),
            footer: str(args.footer) || undefined,
            meta: (args.meta && typeof args.meta === "object" ? args.meta : undefined) as Record<string, string> | undefined,
            heroBanner: (args.heroBanner && typeof args.heroBanner === "object" ? args.heroBanner : undefined) as Record<string, unknown> | undefined,
            sources: (Array.isArray(args.sources) ? args.sources : [])
              .map((s) => (s && typeof s === "object" ? s : null))
              .filter(Boolean)
              .map((s) => ({ name: str((s as ReportSource).name).trim(), url: str((s as ReportSource).url).trim() }))
              .filter((s) => s.name),
            blocks: [],
          };
          const declared = (doc.sources ?? []).map((s) => s.name);
          return `Document ouvert : « ${title} ». Ajoute les blocs dans l'ordre de lecture avec report_add_block.`
            + (declared.length
              ? ` Sources déclarées : ${declared.join(", ")} — cite-les dans le corps avec un bloc {"type":"sources","data":{"items":["…"]}} juste après le passage qu'elles appuient.`
              : " Aucune source déclarée : si la matière en cite, passe-les dans `sources` pour qu'elles deviennent des liens marqués du logo du site.");
        }
        case "report_add_block": {
          if (!doc) return "ERROR: appelle d'abord report_open — un bloc n'a nulle part où aller.";
          const raw = args.block as { type?: string; data?: unknown } | null;
          if (!raw?.type) return 'ERROR: `block` doit être un objet { "type": "…", "data": { … } }.';
          const block: ReportBlock = {
            type: String(raw.type),
            data: (raw.data && typeof raw.data === "object" ? raw.data : {}) as Record<string, unknown>,
          };
          const blocks = (doc.blocks ??= []);
          // Already written: refuse the copy, not the run. The failure this
          // catches is a model repeating a call whose effect it cannot see (and
          // a replayed round after a provider hiccup) — the reader was getting
          // the same KPI row four times over.
          let replacedAt = -1;
          if (!REPEATABLE_BLOCKS.has(block.type)) {
            const key = blockKey(block);
            const at = blocks.findIndex((b) => blockKey(b) === key);
            if (at >= 0) {
              return `Ce bloc « ${block.type} » est DÉJÀ dans le document (position ${at + 1}, à l'identique) — il n'a pas été ajouté une seconde fois. `
                + `Passe à la suite du plan, ou appelle report_publish si le document est complet (${blocks.length} blocs).`;
            }
            // Same substance, different wording: this is the author CORRECTING
            // a block (typically after a warning about a missing delta), and it
            // has no other way to do it. Take the new version in place of the
            // old one rather than letting both reach the reader.
            const substance = blockSubstanceKey(block);
            if (substance) replacedAt = blocks.findIndex((b) => blockSubstanceKey(b) === substance);
          }
          const v = validateBlock(block, replacedAt >= 0 ? replacedAt : blocks.length);
          if (v.errors.length) {
            return `ERROR: ${v.errors.join(" ")} Le bloc n'a PAS été ajouté — corrige sa forme et rappelle report_add_block. En cas de doute : read_skill_file(path="content-schema.md").`;
          }
          const advice = v.warnings.length ? ` À revoir : ${v.warnings.join(" ")}` : "";
          if (replacedAt >= 0) {
            blocks[replacedAt] = block;
            return `Ce bloc « ${block.type} » reprend des données DÉJÀ présentes (position ${replacedAt + 1}) : cette version REMPLACE l'ancienne sur place, `
              + `elle n'a pas été ajoutée en double (${blocks.length} blocs au total). Passe à la suite du plan.${advice}`;
          }
          blocks.push(block);
          return `Bloc « ${block.type} » ajouté (${blocks.length} au total).${advice}`;
        }
        case "report_publish": {
          if (!doc) return "ERROR: rien à publier — appelle report_open puis report_add_block.";
          try {
            published = await publish(deps, reporter, doc);
            const warn = published.warnings.length
              ? ` ${published.warnings.length} avertissement(s) de rédaction : ${published.warnings.slice(0, 4).join(" ")}`
              : "";
            return `Rapport publié : « ${doc.title} » (${reportShape(doc)}).${warn} Termine par deux phrases de résumé — le document s'ouvre en carte.`;
          } catch (e) {
            if (e instanceof ValidationError) {
              return `ERROR: le rapport n'a PAS été publié. ${e.errors.join(" ")} Corrige les blocs fautifs (report_add_block les ajoute à la suite — republie ensuite).`;
            }
            return `ERROR: ${e instanceof Error ? e.message : String(e)}. Ne prétends pas que le rapport existe.`;
          }
        }
        case "read_skill_file": {
          const path = str(args.path);
          const { data: f } = await admin
            .from("agent_skill_files")
            .select("content")
            .eq("skill_id", skillId)
            .eq("path", path)
            .maybeSingle();
          const body = str((f as { content?: string } | null)?.content);
          return body ? `# report-artisan/${path}\n\n${body}` : `ERROR: fiche « ${path} » introuvable.`;
        }
        default:
          return `ERROR: outil « ${name} » inconnu. Tu disposes de report_open, report_add_block, report_publish, read_skill_file.`;
      }
    })();
    await logChild("tool_result", { tool: name, preview: out.slice(0, 600), ok: !out.startsWith("ERROR") });
    return out;
  };

  const provider = reporter.model === "groq" ? "groq" : "deepseek";
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(reporter, skillPrompt, brief) },
    { role: "user", content: buildBriefMessage(brief, deps.requesterName) },
  ];

  try {
    const result = await callAiWithTools({
      provider,
      messages,
      tools: toolDefs(),
      executor,
      temperature: reporter.temperature ?? 0.35,
      maxTokens: 4000,
      maxRounds: REPORT_ROUNDS,
      onNotice: async (n) => { await logChild("tool_error", { message: n.message, detail: n.detail }); },
    });

    await logLlmUsage({
      workspace_id: deps.workspaceId, project_id: deps.projectId,
      provider: result.provider, model: result.model, usage: result.usage,
      task: "report", feature: "reporter",
      metadata: { agent_id: reporter.id, run_id: childRunId, requested_by: deps.requesterAgentId ?? null },
    });

    const summary = (result.content ?? "").trim();
    if (!published) {
      await finishRun({
        status: "failed",
        error_message: "le Rédacteur n'a pas publié",
        finished_at: new Date().toISOString(),
        action_count: result.toolCalls.length,
      });
      return fail(
        "ERROR: Le Rédacteur n'a rien publié — le rapport n'existe pas. NE dis pas qu'un rapport a été produit."
        + (summary ? ` Il a répondu : ${summary.slice(0, 400)}` : "")
        + " Renvoie-lui une matière plus complète, ou signale l'échec dans ta réponse.",
      );
    }

    const out = published as PublishOutcome;
    await finishRun({
      status: "succeeded",
      final_output: summary.slice(0, 12000),
      finished_at: new Date().toISOString(),
      action_count: result.toolCalls.length,
      tokens_in: result.usage.prompt_tokens ?? 0,
      tokens_out: result.usage.completion_tokens ?? 0,
    });

    return {
      ok: true,
      deliverableId: out.deliverableId,
      title: out.title,
      path: out.path,
      staticPath: out.staticPath,
      warnings: out.warnings,
      message:
        `Rapport « ${out.title} » publié par ${reporter.name} — il s'ouvre en carte pour l'utilisateur.`
        + (summary ? `\n\n${summary}` : "")
        + "\n\nNe le recopie pas dans ta réponse : dis en une phrase ce qu'il contient.",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishRun({ status: "failed", error_message: msg.slice(0, 500), finished_at: new Date().toISOString() });
    await logChild("error", { error: msg });
    return fail(`ERROR: la rédaction a échoué (${msg}). Le rapport n'existe pas — ne prétends pas le contraire.`);
  }
}
