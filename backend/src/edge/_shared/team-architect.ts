// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/team-architect.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.
import { Deno, FUNCTIONS_URL } from "../../compat/index.ts";

// L'architecte d'équipes : d'une phrase à une équipe d'agents qui travaille.
//
//   « Monte-moi une équipe qui gère le support client sur Intercom et tient
//     la doc Notion à jour »
//        → designTeam : un plan d'équipe (rôles, prompts, flux A2A, routines,
//          apps à brancher), contrôlé et chiffré avant d'être montré ;
//        → deployTeam : les agents créés avec leurs outils, l'équipe posée
//          dans le service avec son animateur et ses liens, les routines
//          planifiées, la mission de démarrage lancée si on le demande.
//
// Trois portes d'entrée, une implémentation : le panneau Assistant
// (assistant-tools.ts), l'assistant des rooms (internal-agent-tools.ts) et
// l'écran Teamz (internal-agent-a2a, actions team_design / team_deploy).
//
// Ce que le modèle écrit est une ENTRÉE NON FIABLE : il remplit des champs,
// normalizeBlueprint les borne, composeMemberPrompt en fait des prompts de
// forme garantie, et lintBlueprint chiffre la qualité. Un rôle sous le seuil
// est réécrit une fois ; s'il le reste, le score l'affiche honnêtement.

import type { SupabaseClient } from "@supabase/supabase-js";
import { callAi, safeParseJson } from "./ai.ts";
import { logLlmUsage } from "./llm-tracking.ts";
import {
  blueprintFromTemplate, cadenceOfCron, composeMemberPrompt, lintBlueprint, matchTemplate, normalizeBlueprint,
  normalizeMember, scheduleRowFor, TEAM_MAX, TEAMZ_TOOL_KINDS,
  type BlueprintLint, type TeamBlueprint, type TeamContext, type TeamzMember, type TeamzTemplate,
} from "./teamz.ts";
import { findTeamzTemplate, TEAMZ_CATALOG } from "./teamz-catalog.ts";
import { appBase, createAgentFull, resolveService, type OpsActor, type OpsResult, type UiBlock } from "./assistant-ops.ts";

/** Le score sous lequel un rôle est renvoyé à l'écriture. */
const REFINE_BELOW = 85;

// ── Conception ───────────────────────────────────────────────────────────────

const ARCHITECT_SYSTEM = [
  "Tu es l'ARCHITECTE D'ÉQUIPES d'une plateforme d'agents IA autonomes. On te décrit un besoin ; tu conçois l'équipe d'agents spécialisés qui le prend en charge de bout en bout, et qui travaille en groupe (A2A).",
  "",
  "PRINCIPES",
  "- Des rôles COMPLÉMENTAIRES, sans recouvrement : chaque membre a un métier que les autres n'ont pas. 3 à 5 membres en général, 2 au minimum, 6 au maximum sauf besoin évident.",
  "- Exactement UN animateur (lead) : il reçoit les demandes, découpe, répartit, arbitre et rend compte à l'humain.",
  "- Un FLUX : qui passe la main à qui (handoff), qui consulte qui (consult), qui relit qui (review). Personne n'est isolé.",
  "- Chaque rôle est écrit comme une fiche de poste opérationnelle : une mission précise (≥ 2 phrases), 3 à 5 responsabilités, une méthode de 4 à 7 étapes concrètes (avec les outils), 2 à 4 exigences de qualité VÉRIFIABLES, 2 à 4 limites (ce qu'il ne fait JAMAIS), 1 à 3 livrables.",
  "- Les actions à effet externe (envoyer, publier, payer, supprimer, fusionner) passent TOUJOURS par une validation humaine : écris-le dans les limites.",
  "- Spécifique au besoin décrit : pas de généralités interchangeables. Reprends le vocabulaire, les apps et les contraintes données.",
  "",
  "OUTILS (champ tools, par type) : " + TEAMZ_TOOL_KINDS.join(", ") + ". web_search/web_fetch = recherche ; rag_search = base de connaissances ; tracker = suivi de travail ; vibe_code = coder dans un dépôt ; testing = tests E2E ; support = file du support ; leads = qualification de leads ; soc = surveillance sécurité. Tous les agents ont déjà : livrables, mémoire, checklist, messagerie entre agents et passation (handoff_to_teammate).",
  "APPS (champ connectors et plugs) : slugs d'apps SaaS en minuscules (gmail, slack, notion, hubspot, intercom, zendesk, github, linear, jira, googlesheets, googlecalendar, googledrive, stripe, linkedin, airtable, trello, asana…). Ne cite que des apps utiles au besoin.",
  "ROUTINES : 0 à 3, cron 5 champs en heure LOCALE, formes simples seulement : « M H * * * » (chaque jour), « M H * * D » (chaque semaine, D=0..6, 1=lundi), « M H J * * » (mensuel, J≤28).",
  "",
  "Réponds UNIQUEMENT par un objet JSON :",
  '{"name":"…","emoji":"…","mission":"…","lead":"<key>","outcomes":["…"],"playbook":["règle d\'équipe"],',
  '"members":[{"key":"kebab-case","name":"Prénom","role":"…","emoji":"…","persona":"une ligne","soul":"2-3 phrases de caractère","mission":"…","responsibilities":["…"],"method":["…"],"quality":["…"],"limits":["…"],"deliverables":["…"],"tools":[{"kind":"web_search"}],"connectors":["slug"],"minutes_per_task":30}],',
  '"links":[{"from":"<key>","to":"<key>","kind":"handoff|consult|review","when":"quand…"}],',
  '"routines":[{"owner":"<key>","label":"…","cron":"0 8 * * 1","prompt":"…"}],',
  '"plugs":[{"slug":"notion","name":"Notion","why":"…","required":true}],',
  '"kickoff":{"title":"…","brief":"la première mission concrète de l\'équipe"}}',
  "Tout en français, prénoms variés et distincts.",
].join("\n");

/** Un membre du catalogue, en exemple de la qualité attendue. */
function exampleOf(t: TeamzTemplate): string {
  const lead = t.members.find((m) => m.lead) ?? t.members[0];
  const { key, name, role, mission, responsibilities, method, quality, limits, deliverables, tools, connectors } = lead;
  return JSON.stringify({
    reference_team: t.name,
    roles: t.members.map((m) => `${m.name} — ${m.role}`),
    example_member: { key, name, role, mission, responsibilities, method, quality, limits, deliverables, tools, connectors },
    example_links: t.links.slice(0, 3),
  });
}

export interface DesignInput {
  admin: SupabaseClient;
  workspaceId: string;
  projectId: string;
  brief: string;
  /** Apps déjà connectées dans le service : l'architecte les préfère. */
  connected?: string[];
  /** Forcer un modèle du catalogue comme point de départ. */
  templateKey?: string | null;
}

export interface DesignResult {
  blueprint: TeamBlueprint;
  lint: BlueprintLint;
  /** Les rôles réécrits par le contrôle qualité. */
  refined: string[];
  /** D'où vient le plan : conçu par le modèle, ou repli sur le catalogue. */
  origin: "architect" | "template" | "fallback";
  basedOn: string | null;
}

async function json<T>(input: DesignInput, system: string, user: string, maxTokens: number): Promise<T | null> {
  const res = await callAi({
    task: "architecture_reasoning", jsonMode: true, systemPrompt: system, userPrompt: user, maxTokens, temperature: 0.5,
  });
  await logLlmUsage({
    workspace_id: input.workspaceId, project_id: input.projectId,
    provider: res.provider, model: res.model, task: "architecture_reasoning", feature: "team-architect", usage: res.usage,
  }).catch(() => {});
  return safeParseJson<T>(res.content);
}

/** D'une demande en langage naturel à un plan d'équipe contrôlé. */
export async function designTeam(input: DesignInput): Promise<DesignResult> {
  const brief = input.brief.trim().slice(0, 2000);
  const forced = input.templateKey ? findTeamzTemplate(input.templateKey) : null;
  const near = forced ? { template: forced, score: 99 } : matchTemplate(brief, TEAMZ_CATALOG);

  let blueprint: TeamBlueprint | null = null;
  let origin: DesignResult["origin"] = "architect";
  try {
    const raw = await json<Record<string, unknown>>(input, ARCHITECT_SYSTEM, [
      `# Besoin\n${brief}`,
      input.connected?.length ? `\n# Apps déjà connectées dans ce service\n${input.connected.join(", ")}` : "",
      near ? `\n# Équipe de référence du catalogue (niveau de détail attendu — adapte, ne recopie pas)\n${exampleOf(near.template)}` : "",
    ].join("\n"), 9000);
    if (raw) {
      const bp = normalizeBlueprint(raw, { brief, source: "architect", templateKey: near?.template.key ?? null });
      if (bp.members.length >= 2) blueprint = bp;
    }
  } catch (e) {
    // Pas de modèle disponible (clé, crédit) : le catalogue reste un vrai plan.
    if (!near) throw e;
  }
  if (!blueprint) {
    if (!near) throw new Error("L'architecte n'a pas rendu d'équipe exploitable. Reformule le besoin, ou pars d'une Teamz du catalogue.");
    blueprint = blueprintFromTemplate(near.template, brief);
    origin = "fallback";
  }

  // ── Contrôle qualité : les rôles faibles sont réécrits une fois ────────────
  let lint = lintBlueprint(blueprint);
  const weak = lint.members.filter((m) => m.score < REFINE_BELOW);
  const refined: string[] = [];
  if (weak.length && origin === "architect") {
    try {
      const out = await json<{ members?: unknown[] }>(input, [
        ARCHITECT_SYSTEM,
        "",
        "MISSION ACTUELLE : RÉÉCRIRE des fiches de rôle jugées trop faibles par le contrôle qualité. Garde la même key, le même prénom et le même rôle ; complète et précise tout le reste. Réponds {\"members\":[…]} avec UNIQUEMENT les membres réécrits.",
      ].join("\n"), JSON.stringify({
        team: blueprint.name, mission: blueprint.mission,
        roster: blueprint.members.map((m) => `${m.key}: ${m.name} — ${m.role}`),
        to_rewrite: weak.map((w) => ({ member: blueprint!.members.find((m) => m.key === w.key), issues: w.issues })),
      }), 6000);
      for (const [i, r] of (out?.members ?? []).entries()) {
        const nm = normalizeMember(r, i);
        if (!nm) continue;
        const idx = blueprint.members.findIndex((m) => m.key === nm.key || m.name === nm.name);
        if (idx < 0) continue;
        const prev = blueprint.members[idx];
        blueprint.members[idx] = { ...nm, key: prev.key, name: prev.name, lead: prev.lead, accent: prev.accent };
        refined.push(prev.name);
      }
      lint = lintBlueprint(blueprint);
    } catch { /* le premier jet reste, avec son score affiché */ }
  }
  return { blueprint, lint, refined, origin: forced ? "template" : origin, basedOn: near?.template.key ?? null };
}

// ── Déploiement ──────────────────────────────────────────────────────────────

export interface TeamLinkRow { from: string; to: string; kind: string; when: string }

/** L'équipe telle qu'elle vit dans service_dashboards.settings.teams. */
export interface DeployedTeam {
  id: string;
  name: string;
  color: string;
  agent_ids: string[];
  lead_id: string | null;
  focus: string;
  emoji?: string;
  template_key?: string | null;
  links?: TeamLinkRow[];
  playbook?: string[];
  minutes_per_run?: number;
  hours_saved_per_week?: number;
  blueprint_id?: string | null;
  created_at?: string;
}

export interface DeployOptions {
  /** Le service où naît l'équipe (nom ou id) ; défaut : celui d'où l'on parle. */
  service?: string | null;
  /** Date#getTimezoneOffset de la personne ; défaut Paris. */
  tzOffsetMinutes?: number | null;
  /** Planifier les routines (défaut oui). */
  routines?: boolean;
  /** Lancer la mission de démarrage tout de suite (défaut non : ça consomme). */
  kickoff?: boolean;
  /** Le plan conçu (agent_team_blueprints.id), pour le marquer déployé. */
  blueprintId?: string | null;
}

export interface DeployResult {
  team: DeployedTeam;
  service: { id: string; name: string };
  agents: Array<{ id: string; key: string; name: string; role: string; lead: boolean; prompt_chars: number; tools: number; accent: string; emoji: string | null }>;
  missingPlugs: string[];
  routines: Array<{ label: string; owner: string; next_run_at: string }>;
  kickoffRunId: string | null;
  notes: string[];
  url: string | null;
}

/** L'offset de Paris maintenant (été/hiver), au format getTimezoneOffset. */
export function parisOffsetMinutes(now = new Date()): number {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", timeZoneName: "shortOffset" })
      .formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "GMT+1";
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part);
    if (!m) return -60;
    const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
    return m[1] === "+" ? -mins : mins;
  } catch {
    return -60;
  }
}

async function uniqueName(admin: SupabaseClient, serviceId: string, wanted: string, teamName: string, taken: Set<string>): Promise<string> {
  const { data } = await admin.from("internal_agents").select("name")
    .eq("service_dashboard_id", serviceId).eq("is_archived", false).limit(500);
  for (const r of (data ?? []) as Array<{ name: string }>) taken.add(r.name.toLowerCase());
  let name = wanted;
  if (taken.has(name.toLowerCase())) name = `${wanted} · ${teamName}`.slice(0, 120);
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${wanted} ${n} · ${teamName}`.slice(0, 120);
  taken.add(name.toLowerCase());
  return name;
}

/** Déploie un plan : agents, équipe, liens, routines, mission de démarrage. */
export async function deployTeam(actor: OpsActor, bp: TeamBlueprint, opts: DeployOptions = {}): Promise<DeployResult> {
  const admin = actor.admin;
  const service = await resolveService(actor, String(opts.service ?? ""));
  if (typeof service === "string") throw new Error(service.replace(/^ERREUR : /, ""));
  if (bp.members.length < 2) throw new Error("Une équipe compte au moins deux membres.");

  // Le nom de l'équipe est unique dans le service.
  const { data: board } = await admin.from("service_dashboards").select("settings").eq("id", service.id).maybeSingle();
  const existingTeams = (((board as { settings?: Record<string, unknown> } | null)?.settings?.teams) ?? []) as DeployedTeam[];
  let teamName = bp.name.trim() || "Nouvelle équipe";
  for (let n = 2; existingTeams.some((t) => t.name.toLowerCase() === teamName.toLowerCase()); n++) teamName = `${bp.name} ${n}`;

  // Les noms définitifs d'abord : chaque prompt cite ses coéquipiers par leur
  // vrai nom, y compris quand un homonyme existait déjà dans le service.
  const taken = new Set<string>();
  const finalName = new Map<string, string>();
  for (const m of bp.members.slice(0, TEAM_MAX)) finalName.set(m.key, await uniqueName(admin, service.id, m.name, teamName, taken));
  const members: TeamzMember[] = bp.members.slice(0, TEAM_MAX).map((m) => ({ ...m, name: finalName.get(m.key) ?? m.name }));
  const teamCtx: TeamContext = { name: teamName, mission: bp.mission, playbook: bp.playbook, members, links: bp.links };

  const notes: string[] = [];
  const created: DeployResult["agents"] = [];
  const idOf = new Map<string, string>();
  const missing = new Set<string>();
  const scopedActor: OpsActor = { ...actor, dashboardId: service.id, roomId: null };
  for (const m of members) {
    const prompt = composeMemberPrompt(teamCtx, m);
    const res = await createAgentFull(scopedActor, {
      name: m.name,
      role: m.role,
      description: `${m.role} · ${teamName}`.slice(0, 280),
      persona: m.persona,
      soul: m.soul,
      instructions: prompt,
      service: service.id,
      connectors: m.connectors ?? [],
      skills: m.skills ?? [],
      tools: m.tools.map((t) => ({ kind: t.kind, name: t.name ?? t.kind, config: t.config ?? {} })),
      add_to_room: false,
    });
    if (!res.agent) {
      notes.push(`${m.name} : ${res.notes[0] ?? "création impossible"}`);
      continue;
    }
    for (const s of res.missing) missing.add(s);
    idOf.set(m.key, res.agent.id);
    await admin.from("internal_agents").update({
      accent_color: m.accent ?? bp.accent,
      collaboration_enabled: true,
      updated_at: new Date().toISOString(),
    }).eq("id", res.agent.id).then(() => {}, () => {});
    created.push({
      id: res.agent.id, key: m.key, name: m.name, role: m.role, lead: m.lead === true,
      prompt_chars: prompt.length, tools: m.tools.length + (m.connectors?.length ?? 0),
      accent: m.accent ?? bp.accent, emoji: m.emoji ?? null,
    });
  }
  if (created.length < 2) {
    // Une équipe d'un seul agent n'en est pas une : on ne laisse pas de demi-équipe.
    if (created.length) {
      await admin.from("internal_agents").update({ is_archived: true }).in("id", created.map((c) => c.id)).then(() => {}, () => {});
    }
    throw new Error(`Équipe non créée : ${notes.join(" ; ") || "aucun agent n'a pu être créé"}.`);
  }

  const leadKey = members.find((m) => m.lead)?.key ?? created[0].key;
  const team: DeployedTeam = {
    id: crypto.randomUUID(),
    name: teamName,
    color: bp.accent,
    agent_ids: created.map((c) => c.id),
    lead_id: idOf.get(leadKey) ?? created[0].id,
    focus: bp.mission.slice(0, 200),
    emoji: bp.emoji,
    template_key: bp.template_key,
    links: bp.links
      .filter((l) => idOf.has(l.from) && idOf.has(l.to))
      .map((l) => ({ from: idOf.get(l.from)!, to: idOf.get(l.to)!, kind: l.kind, when: l.when })),
    playbook: bp.playbook,
    minutes_per_run: bp.minutes_per_run,
    hours_saved_per_week: bp.hours_saved_per_week,
    blueprint_id: opts.blueprintId ?? null,
    created_at: new Date().toISOString(),
  };

  // L'équipe rejoint les réglages du service — relus juste avant d'écrire :
  // une autre modification des réglages ne s'en trouve pas écrasée. Un agent
  // n'est que dans une équipe : les nouveaux sortent de celles où ils seraient.
  const { data: fresh } = await admin.from("service_dashboards").select("settings").eq("id", service.id).maybeSingle();
  const settings = ((fresh as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const teams = ((settings.teams ?? []) as DeployedTeam[]).map((t) => ({
    ...t, agent_ids: (t.agent_ids ?? []).filter((x) => !team.agent_ids.includes(x)),
  }));
  const { error: teamErr } = await admin.from("service_dashboards")
    .update({ settings: { ...settings, teams: [...teams, team] } }).eq("id", service.id);
  if (teamErr) notes.push(`Équipe non enregistrée dans les réglages (${teamErr.message}).`);

  // Les routines : des missions planifiées, comme celles de l'onglet Schedules.
  const routines: DeployResult["routines"] = [];
  if (opts.routines !== false) {
    const tz = Number.isFinite(opts.tzOffsetMinutes) ? Number(opts.tzOffsetMinutes) : parisOffsetMinutes();
    for (const r of bp.routines) {
      const agentId = idOf.get(r.owner);
      const cad = cadenceOfCron(r.cron);
      if (!agentId || !cad) continue;
      const row = scheduleRowFor(cad, tz);
      const { error } = await admin.from("internal_agent_missions").insert({
        agent_id: agentId, workspace_id: actor.workspaceId, project_id: actor.projectId,
        title: r.label.slice(0, 160), brief: r.prompt,
        ...row,
        status: "active", board_column: "todo", created_by: actor.userId,
      });
      if (error) notes.push(`Routine « ${r.label} » non planifiée (${error.message}).`);
      else routines.push({ label: r.label, owner: finalName.get(r.owner) ?? r.owner, next_run_at: row.next_run_at });
    }
  }

  // La mission de démarrage, confiée à l'animateur — seulement si on l'a demandé.
  let kickoffRunId: string | null = null;
  if (opts.kickoff && bp.kickoff && team.lead_id) {
    kickoffRunId = await launchMission(actor, team.lead_id, bp.kickoff.title, [
      bp.kickoff.brief,
      "",
      `Tu animes l'équipe « ${teamName} ». Répartis ce travail entre tes coéquipiers selon leurs rôles (handoff_to_teammate), consolide leurs livrables et rends compte.`,
    ].join("\n"));
    if (!kickoffRunId) notes.push("La mission de démarrage n'a pas pu être lancée.");
  }

  if (opts.blueprintId) {
    await admin.from("agent_team_blueprints").update({
      status: "deployed", team_id: team.id, service_dashboard_id: service.id,
      agent_ids: team.agent_ids, deployed_at: new Date().toISOString(),
    }).eq("id", opts.blueprintId).then(() => {}, () => {});
  }

  const base = await appBase(actor, service.id);
  return {
    team, service: { id: service.id, name: service.name }, agents: created,
    missingPlugs: [...missing], routines, kickoffRunId, notes, url: base ? `${base}/teamz` : null,
  };
}

/** Crée une mission pour un agent et la démarre (même chemin que delegate_mission). */
async function launchMission(actor: OpsActor, agentId: string, title: string, brief: string): Promise<string | null> {
  const admin = actor.admin;
  const { data: mission, error } = await admin.from("internal_agent_missions").insert({
    agent_id: agentId, workspace_id: actor.workspaceId, project_id: actor.projectId,
    title: title.slice(0, 160), brief, status: "active", board_column: "todo", priority: "high",
    created_by: actor.userId,
  }).select("id").single();
  if (error || !mission) return null;
  const { data: run } = await admin.from("internal_agent_runs").insert({
    mission_id: (mission as { id: string }).id, agent_id: agentId,
    workspace_id: actor.workspaceId, project_id: actor.projectId,
    status: "queued", triggered_via: "api",
  }).select("id").single();
  if (!run) return null;
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (base && key) {
    fetch(`${FUNCTIONS_URL}/functions/v1/internal-agent-run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId, mode: "mission", run_id: (run as { id: string }).id }),
    }).catch(() => {});
  }
  return (run as { id: string }).id;
}

// ── Plans enregistrés ────────────────────────────────────────────────────────

export async function saveBlueprint(actor: OpsActor, design: DesignResult, serviceId: string | null): Promise<string | null> {
  const { data, error } = await actor.admin.from("agent_team_blueprints").insert({
    workspace_id: actor.workspaceId, project_id: actor.projectId, service_dashboard_id: serviceId,
    brief: design.blueprint.brief, name: design.blueprint.name, template_key: design.basedOn,
    blueprint: design.blueprint, quality: design.lint, status: "draft", created_by: actor.userId,
  }).select("id").single();
  if (error) return null;
  return (data as { id: string }).id;
}

export async function loadBlueprint(actor: OpsActor, id: string): Promise<{ blueprint: TeamBlueprint; status: string; service_dashboard_id: string | null } | null> {
  const { data } = await actor.admin.from("agent_team_blueprints")
    .select("blueprint, status, service_dashboard_id").eq("id", id).eq("workspace_id", actor.workspaceId).maybeSingle();
  if (!data) return null;
  const row = data as { blueprint: unknown; status: string; service_dashboard_id: string | null };
  return { blueprint: normalizeBlueprint(row.blueprint, { source: (row.blueprint as TeamBlueprint)?.source, templateKey: (row.blueprint as TeamBlueprint)?.template_key }), status: row.status, service_dashboard_id: row.service_dashboard_id };
}

// ── L'outil des assistants : manage_teams ────────────────────────────────────

export const TEAM_ACTIONS = ["catalog", "design", "deploy", "install"] as const;

export const TEAM_OPS_DESCRIPTION =
  "Crée des ÉQUIPES ENTIÈRES d'agents spécialisés qui travaillent en groupe (A2A) : rôles complémentaires, prompts système détaillés, animateur, flux de passation, routines, apps à brancher. " +
  "catalog : les Teamz prêtes à installer. design : conçoit une équipe sur mesure depuis une demande en langage naturel et l'affiche (plan + score qualité) sans rien créer. " +
  "deploy : crée l'équipe d'un plan conçu (blueprint_id). install : installe directement une Teamz du catalogue (template). " +
  "Si la personne demande explicitement de CRÉER l'équipe, enchaîne design puis deploy sans redemander ; si elle veut voir d'abord, arrête-toi après design.";

const TEAM_PARAMS_DOC =
  "catalog: {}. design: {brief (la demande, telle quelle, enrichie de ce que tu sais du contexte), template?: clé du catalogue pour partir d'une Teamz, service?}. " +
  "deploy: {blueprint_id, service?, kickoff?: bool (lancer la mission de démarrage, seulement si on te le demande), routines?: bool (défaut vrai)}. " +
  "install: {template, service?, kickoff?, routines?}.";

export function teamOpsToolDef(name = "manage_teams") {
  return {
    name,
    description: TEAM_OPS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...TEAM_ACTIONS], description: "L'opération." },
        params: { type: "object", description: TEAM_PARAMS_DOC },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;

/** Les apps connectées du service, pour orienter l'architecte. */
export async function connectedApps(actor: OpsActor, serviceId: string | null): Promise<string[]> {
  const { data } = await actor.admin.from("connectors").select("provider, status, scope, service_dashboard_id")
    .eq("project_id", actor.projectId).limit(200);
  return [...new Set(((data ?? []) as Array<{ provider: string; status: string | null; scope: string | null; service_dashboard_id: string | null }>)
    .filter((c) => c.scope !== "personal" && (!c.service_dashboard_id || c.service_dashboard_id === serviceId))
    .filter((c) => !c.status || ["connected", "active", "ok"].includes(c.status))
    .map((c) => c.provider.toLowerCase()))].slice(0, 30);
}

/** Le bloc d'interface d'un plan : la carte « équipe » des assistants. */
export function blueprintCard(id: string | null, design: Pick<DesignResult, "blueprint" | "lint" | "refined" | "origin" | "basedOn">, deployed?: DeployResult | null, serviceId?: string | null): UiBlock {
  return {
    component: "team_blueprint",
    props: {
      blueprint_id: id,
      blueprint: design.blueprint,
      lint: design.lint,
      refined: design.refined,
      origin: design.origin,
      based_on: design.basedOn,
      service_id: deployed?.service.id ?? serviceId ?? null,
      deployed: deployed ? {
        team_id: deployed.team.id, team_name: deployed.team.name, service_id: deployed.service.id,
        agents: deployed.agents, missing_plugs: deployed.missingPlugs, routines: deployed.routines,
        kickoff_run_id: deployed.kickoffRunId, url: deployed.url,
      } : null,
    },
  };
}

function deployedText(r: DeployResult): string {
  const lines = [
    `Équipe « ${r.team.name} » créée dans ${r.service.name} : ${r.agents.length} agents, ${r.team.links?.length ?? 0} liens de travail.`,
    ...r.agents.map((a) => `- ${a.name} — ${a.role}${a.lead ? " (anime l'équipe)" : ""} · agent_id ${a.id}`),
  ];
  if (r.routines.length) lines.push(`Routines planifiées : ${r.routines.map((x) => `${x.label} (${x.owner})`).join(", ")}.`);
  if (r.kickoffRunId) lines.push("La mission de démarrage est lancée : l'animateur répartit le travail.");
  if (r.missingPlugs.length) lines.push(`Apps à brancher pour qu'ils s'en servent : ${r.missingPlugs.join(", ")} (cartes « Connecter » affichées).`);
  lines.push(...r.notes);
  if (r.url) lines.push(`Lien à donner tel quel : [Voir l'équipe](${r.url})`);
  return lines.join("\n");
}

export async function runTeamOps(actor: OpsActor, rawAction: string, params: Record<string, unknown>): Promise<OpsResult> {
  const action = rawAction === "create" ? "design" : rawAction === "list" ? "catalog" : rawAction;
  const p = params ?? {};
  if (action === "catalog") {
    return {
      text: TEAMZ_CATALOG.map((t) => `- ${t.key} — ${t.name} (${t.category}) : ${t.tagline} · ${t.members.length} agents (${t.members.map((m) => m.role).join(", ")}) · apps : ${t.plugs.map((x) => x.slug).join(", ")} · ≈ ${t.hours_saved_per_week} h/semaine`).join("\n"),
    };
  }
  if (!["design", "deploy", "install"].includes(action)) {
    return { text: `ERREUR : l'action « ${rawAction} » n'existe pas. Actions : ${TEAM_ACTIONS.join(", ")}.` };
  }
  if (ROLE_RANK[actor.role] < ROLE_RANK.member) {
    return { text: `ACCÈS REFUSÉ : la personne a le rôle « ${actor.role} », qui ne permet pas de créer d'agents. Dis-le-lui simplement.` };
  }
  const svc = await resolveService(actor, String(p.service ?? ""));
  if (typeof svc === "string") return { text: svc };

  try {
    if (action === "design") {
      const brief = String(p.brief ?? p.request ?? p.description ?? "").trim();
      if (brief.length < 8 && !p.template) return { text: "ERREUR : décris le besoin (brief) en une ou deux phrases." };
      const design = await designTeam({
        admin: actor.admin, workspaceId: actor.workspaceId, projectId: actor.projectId,
        brief: brief || String(p.template), templateKey: p.template ? String(p.template) : null,
        connected: await connectedApps(actor, svc.id),
      });
      const id = await saveBlueprint(actor, design, svc.id);
      const bp = design.blueprint;
      return {
        text: [
          `Plan d'équipe « ${bp.name} » conçu (blueprint_id: ${id ?? "non enregistré"}) — qualité ${design.lint.score}/100${design.refined.length ? `, ${design.refined.length} rôle(s) réécrit(s) par le contrôle qualité` : ""}${design.basedOn ? `, inspiré de la Teamz ${design.basedOn}` : ""}.`,
          ...bp.members.map((m) => `- ${m.name} — ${m.role}${m.lead ? " (anime)" : ""}`),
          `Flux : ${bp.links.length} liens · routines : ${bp.routines.length} · apps : ${bp.plugs.map((x) => x.slug).join(", ") || "aucune"}.`,
          "La carte de l'équipe est affichée sous ta réponse, avec le bouton Déployer : ne recopie pas les prompts.",
          id ? "Si la personne a demandé de créer l'équipe, appelle maintenant deploy avec ce blueprint_id." : "",
        ].filter(Boolean).join("\n"),
        ui: [blueprintCard(id, design, null, svc.id)],
      };
    }

    let bp: TeamBlueprint;
    let blueprintId: string | null = null;
    let design: Pick<DesignResult, "blueprint" | "lint" | "refined" | "origin" | "basedOn">;
    if (action === "install") {
      const t = findTeamzTemplate(String(p.template ?? p.key ?? ""));
      if (!t) return { text: `ERREUR : Teamz « ${String(p.template ?? "")} » inconnue. Catalogue : ${TEAMZ_CATALOG.map((x) => x.key).join(", ")}.` };
      bp = blueprintFromTemplate(t);
      design = { blueprint: bp, lint: lintBlueprint(bp), refined: [], origin: "template", basedOn: t.key };
    } else {
      blueprintId = String(p.blueprint_id ?? p.id ?? "");
      const saved = blueprintId ? await loadBlueprint(actor, blueprintId) : null;
      if (!saved) return { text: "ERREUR : blueprint_id inconnu. Conçois d'abord l'équipe avec design." };
      if (saved.status === "deployed") return { text: "Ce plan a déjà été déployé : l'équipe existe. Conçois-en un nouveau pour une autre équipe." };
      bp = saved.blueprint;
      design = { blueprint: bp, lint: lintBlueprint(bp), refined: [], origin: bp.source === "template" ? "template" : "architect", basedOn: bp.template_key };
    }
    const res = await deployTeam(actor, bp, {
      service: svc.id, kickoff: p.kickoff === true, routines: p.routines !== false, blueprintId,
    });
    const ui: UiBlock[] = [blueprintCard(blueprintId, design, res)];
    if (res.missingPlugs.length) {
      ui.push({
        component: "connectors",
        props: {
          agent_id: null, agent_ids: res.agents.map((a) => a.id),
          items: res.missingPlugs.map((slug) => ({ slug, name: slug, reason: `Pour l'équipe ${res.team.name}.`, status: "not_connected" })),
        },
      });
    }
    return { text: deployedText(res), ui };
  } catch (e) {
    return { text: `ERREUR : ${e instanceof Error ? e.message : String(e)}` };
  }
}

export const TEAM_OPS_DOCTRINE = [
  "ÉQUIPES D'AGENTS (manage_teams)",
  "- « Crée/monte-moi une équipe qui… » : design avec la demande complète (brief), puis deploy du blueprint_id rendu — dans la même réponse, sans redemander, si la création est demandée. Une Teamz du catalogue qui colle exactement : install.",
  "- Ne réécris jamais les prompts dans ta réponse : la carte d'équipe les montre. Termine par l'équipe créée (noms et rôles), les apps à brancher, et ce qu'il suffit de faire pour la mettre au travail.",
  "- La mission de démarrage (kickoff=true) consomme du budget : seulement si on te demande de lancer l'équipe.",
].join("\n");
