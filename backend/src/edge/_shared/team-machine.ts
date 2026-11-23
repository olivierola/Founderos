import { Deno } from "../../compat/index.ts";

// La machine d'équipe (0296), côté plateforme.
//
// Une équipe d'agents reçoit un poste Linux partagé (team-machine/, un
// conteneur). Ce module en est le client et l'annuaire :
//
//   · il SIGNE chaque appel (HMAC du jeton propre de chaque machine, comme
//     team-machine/src/auth.mjs le vérifie) ;
//   · il tient les SECRETS — celui de chaque agent (son identité sur la
//     machine) et celui de chaque dossier protégé — chiffrés en base, et ne
//     les déchiffre que pour l'agent qui agit, et pour les seuls dossiers dont
//     il est MEMBRE ;
//   · il fait respecter les règles des dossiers protégés : membres pris dans
//     l'équipe, seul le propriétaire (ou un humain) gère les membres.
//
// Les secrets ne sortent jamais d'ici vers un modèle. Un agent qui verrait le
// secret d'un dossier pourrait le recopier dans une room, un message A2A, un
// livrable — et c'est précisément l'agent qu'on voulait tenir dehors qui le
// lirait. L'agent « possède » le secret par son identité, pas par sa mémoire.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { assertSafeUrl } from "./ssrf.ts";

// ── Formes ───────────────────────────────────────────────────────────────────

export interface TeamCfg {
  id: string;
  name: string;
  agent_ids: string[];
  lead_id: string | null;
  focus?: string;
}

export interface MachineRow {
  team_id: string;
  dashboard_id: string;
  workspace_id: string;
  team_key: string;
  status: "active" | "paused";
  allow_system_packages: boolean;
  url: string | null;
  machine_path: string | null;
  /** La machine du parc (0304). Null : la machine de la plateforme (ou `url`). */
  machine_id?: string | null;
  /** team : une équipe ; agent : un agent seul (team_id = agent-<uuid>). */
  scope?: "team" | "agent";
  agent_id?: string | null;
}

/** Une machine du parc d'un espace (0304). */
export interface FleetMachine {
  id: string;
  workspace_id: string;
  dashboard_id: string | null;
  name: string;
  description: string | null;
  kind: "docker" | "vm" | "cloud" | "platform";
  url: string | null;
  status: "active" | "paused";
  allow_system_packages: boolean;
  info: Record<string, unknown>;
  last_seen_at: string | null;
  last_error: string | null;
  /** 0311 : créée par la plateforme ('docker'), ou null si déclarée à la main. */
  managed_by?: "docker" | null;
  managed_ref?: string | null;
  provision_state?: "creating" | "ready" | "failed" | null;
}

// ── Création à la demande (0311) ─────────────────────────────────────────────

/**
 * Ce qui sait créer et détruire une machine. Seul le backend auto-hébergé
 * (Node, PLATFORM=self) en installe un — il pilote le Docker de l'hôte — sur
 * `globalThis` au démarrage. Sous Supabase, il n'y en a pas : la création à la
 * demande y est simplement indisponible.
 */
export interface MachineProvisioner {
  /** Prêt à créer ? Sinon la raison, à montrer telle quelle. */
  check(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Lance la machine et attend qu'elle réponde. Le jeton ne passe jamais par un argument de commande. */
  create(input: { machineId: string; token: string; allowApt: boolean; /** Les outils du catalogue (machines/catalog.ts). */ tools?: string[] }): Promise<{ ref: string; url: string }>;
  /** Relance le même conteneur avec d'autres réglages (mêmes volumes, même port, même jeton). */
  reconfigure(input: { ref: string; token: string; allowApt: boolean }): Promise<void>;
  /** Arrête et supprime le conteneur ; ses volumes (les dossiers des équipes) aussi si demandé. */
  destroy(input: { ref: string; volumes: boolean }): Promise<void>;
}

const PROVISIONER_KEY = "__founderosMachineProvisioner";

export function machineProvisioner(): MachineProvisioner | null {
  return ((globalThis as Record<string, unknown>)[PROVISIONER_KEY] as MachineProvisioner | undefined) ?? null;
}

export function installMachineProvisioner(p: MachineProvisioner | null): void {
  (globalThis as Record<string, unknown>)[PROVISIONER_KEY] = p ?? undefined;
}

const MACHINE_ROW_COLS = "team_id, dashboard_id, workspace_id, team_key, status, allow_system_packages, url, machine_path, machine_id, scope, agent_id";

/** L'« équipe d'un » d'un agent à qui l'on a donné sa propre machine. */
export const soloTeamId = (agentId: string) => `agent-${agentId}`;

export interface MachineFolder {
  id: string;
  name: string;
  path: string | null;
  purpose: string | null;
  role: "owner" | "member";
  members: Array<{ agent_id: string; name: string; role: "owner" | "member" }>;
}

export interface MachineConfig {
  url: string;
  token: string;
}

/** Ce qu'un agent sait de sa machine, chargé une fois par run. */
export interface AgentMachine {
  agentId: string;
  agentName: string;
  team: TeamCfg;
  machine: MachineRow;
  teammates: Array<{ id: string; name: string }>;
  unixUser: string | null;
  home: string | null;
  teamDir: string;
  folders: MachineFolder[];
  config: MachineConfig | null;
}

export interface Actor {
  agentId?: string | null;
  userId?: string | null;
}

export const FOLDER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;

// ── Pur ──────────────────────────────────────────────────────────────────────

/** Minuscule, sans accent, tirets ; une lettre en tête (même règle que la machine). */
export function slugify(input: string, max = 20): string {
  const base = String(input ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  if (!base) return "x";
  return /^[a-z]/.test(base) ? base : `x${base}`.slice(0, max);
}

const hex4 = (id: string) => (id.replace(/[^0-9a-f]/gi, "").slice(0, 4).toLowerCase() || "0000").padEnd(4, "0");

/** Le dossier d'une équipe sur la machine : stable, lisible, unique. */
export function teamKeyFor(team: { id: string; name: string }): string {
  return `${slugify(team.name || "equipe", 20)}-${hex4(team.id)}`;
}

/** Le nom d'utilisateur Linux proposé pour un agent (la machine tranche les collisions). */
export function unixUserFor(agent: { id: string; name: string }): string {
  return `${slugify(agent.name || "agent", 20)}-${hex4(agent.id)}`;
}

/** Un nom de dossier protégé, rendu sûr — ou null s'il n'en reste rien. */
export function normalizeFolderName(raw: string): string | null {
  const s = String(raw ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-.]+$/g, "")
    .slice(0, 48);
  return FOLDER_NAME_RE.test(s) ? s : null;
}

export function readTeams(settings: unknown): TeamCfg[] {
  const raw = (settings as { teams?: unknown } | null)?.teams;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof (t as { id?: unknown }).id === "string")
    .map((t) => ({
      id: String(t.id),
      name: String(t.name ?? "") || "Équipe",
      agent_ids: Array.isArray(t.agent_ids) ? (t.agent_ids as unknown[]).filter((x): x is string => typeof x === "string") : [],
      lead_id: typeof t.lead_id === "string" ? t.lead_id : null,
      focus: typeof t.focus === "string" ? t.focus : "",
    }));
}

export function findTeamOf(settings: unknown, agentId: string): TeamCfg | null {
  return readTeams(settings).find((t) => t.agent_ids.includes(agentId)) ?? null;
}

/** 32 octets aléatoires, en base64url : le format qu'attend la machine. */
export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Résout une liste de noms ou d'ids d'agents parmi des candidats. */
export function resolveAgentRefs(
  refs: unknown, candidates: Array<{ id: string; name: string }>,
): { ids: string[]; unknown: string[] } {
  const list = (Array.isArray(refs) ? refs : typeof refs === "string" ? refs.split(",") : [])
    .map((r) => String(r ?? "").trim()).filter(Boolean);
  const ids: string[] = [];
  const unknown: string[] = [];
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  for (const r of list) {
    const hit = candidates.find((c) => c.id === r) ?? candidates.find((c) => norm(c.name) === norm(r));
    if (hit) { if (!ids.includes(hit.id)) ids.push(hit.id); } else unknown.push(r);
  }
  return { ids, unknown };
}

// ── Appels signés ────────────────────────────────────────────────────────────

export class MachineError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export async function hmacHex(token: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Où et comment joindre une machine : SON adresse et SON jeton, rien d'autre.
 * Il n'y a plus de « machine de la plateforme » posée par l'environnement
 * (TEAM_MACHINE_URL, TEAM_MACHINE_TOKEN) : une machine est créée à la demande
 * (0311) ou branchée à la main avec son adresse et son jeton.
 *
 * `trusted` : une adresse que la plateforme a posée elle-même (machine créée à
 * la demande, un port local qu'aucun humain n'a choisi). Sinon l'adresse vient
 * d'un humain du workspace et passe le contrôle SSRF, sauf en auto-hébergé
 * (PLATFORM=self) où l'opérateur et le client ne font qu'un : son réseau
 * interne est le sien.
 */
export async function machineConfig(
  _admin: SupabaseClient, url?: string | null, ownToken?: string | null, trusted = false,
): Promise<MachineConfig | null> {
  const token = ownToken ?? "";
  const address = url?.trim() || "";
  if (token.length < 32 || !address) return null;
  if (!trusted && !privateAddressesAllowed()) {
    const verdict = await assertSafeUrl(address);
    if (!verdict.ok) throw new MachineError(400, "unsafe_url", `URL de machine refusée : ${verdict.reason ?? "adresse interne"}`);
  }
  return { url: address.replace(/\/+$/, ""), token };
}

/** Auto-hébergé : les machines du réseau interne de l'opérateur sont permises. */
export function privateAddressesAllowed(): boolean {
  return (Deno.env.get("PLATFORM") ?? "").toLowerCase() === "self";
}

export async function loadFleetMachine(admin: SupabaseClient, id: string): Promise<FleetMachine | null> {
  if (!id) return null;
  const { data, error } = await admin.from("machines").select("*").eq("id", id).maybeSingle();
  if (error || !data) return null;
  return data as FleetMachine;
}

/** Où et comment joindre une machine du parc : son URL et son jeton propre. */
export async function fleetConfig(admin: SupabaseClient, m: Pick<FleetMachine, "id" | "url" | "managed_by">): Promise<MachineConfig | null> {
  const own = (await readSecrets(admin, "machine", [m.id])).get(m.id) ?? null;
  // Sans adresse ni jeton (encore en création, ou incomplète), elle n'est pas
  // joignable : aucune autre machine ne la remplace.
  return machineConfig(admin, m.url, own, !!m.managed_by);
}

/**
 * La configuration d'une attribution : la machine du parc qu'elle désigne,
 * aucune si cette machine est en pause ou retirée. Une attribution d'avant
 * 0304 (sans machine) n'est plus joignable : on la rattache à une machine du
 * parc depuis l'onglet Machines.
 */
export async function configFor(admin: SupabaseClient, row: { machine_id?: string | null }): Promise<MachineConfig | null> {
  if (row.machine_id) {
    const m = await loadFleetMachine(admin, row.machine_id);
    if (!m || m.status !== "active") return null;
    return fleetConfig(admin, m);
  }
  return null;
}

/** Pose (ou retire, avec null) le jeton propre d'une machine. */
export async function setMachineToken(admin: SupabaseClient, machineId: string, token: string | null): Promise<void> {
  if (!token) {
    await admin.from("team_machine_secrets").delete().eq("kind", "machine").eq("ref_id", machineId);
    return;
  }
  if (token.length < 32) throw new MachineError(400, "bad_token", "le jeton d'une machine fait 32 caractères au moins");
  await storeSecret(admin, "machine", machineId, token);
}

/** Le jeton propre d'une machine, déchiffré (pour la relancer, jamais pour un modèle). */
export async function readMachineToken(admin: SupabaseClient, machineId: string): Promise<string | null> {
  return (await readSecrets(admin, "machine", [machineId])).get(machineId) ?? null;
}

export async function hasMachineToken(admin: SupabaseClient, machineIds: string[]): Promise<Set<string>> {
  if (!machineIds.length) return new Set();
  const { data } = await admin.from("team_machine_secrets").select("ref_id").eq("kind", "machine").in("ref_id", machineIds);
  return new Set(((data ?? []) as Array<{ ref_id: string }>).map((r) => r.ref_id));
}

export async function callMachine<T = Record<string, unknown>>(
  cfg: MachineConfig, op: string, payload: Record<string, unknown>, timeoutMs = 60_000,
): Promise<T> {
  const body = JSON.stringify({ nonce: crypto.randomUUID(), ...payload });
  const ts = Math.floor(Date.now() / 1000);
  const signature = await hmacHex(cfg.token, `${ts}.${body}`);
  let res: Response;
  try {
    res = await fetch(`${cfg.url}/v1/${op}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Machine-Ts": String(ts),
        "X-Machine-Signature": signature,
        // Le tunnel ngrok gratuit intercale sinon une page d'avertissement HTML.
        "ngrok-skip-browser-warning": "true",
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new MachineError(503, "machine_unreachable", `machine d'équipe injoignable (${e instanceof Error ? e.message : String(e)})`);
  }
  const text = await res.text();
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new MachineError(502, "machine_unreachable", "machine d'équipe injoignable : une page HTML a répondu (tunnel arrêté ou URL périmée)");
  }
  let json: { ok?: boolean; result?: T; error?: string; message?: string } = {};
  try { json = JSON.parse(text); } catch { /* traité ci-dessous */ }
  if (!res.ok || json.ok !== true) {
    throw new MachineError(res.status, json.error ?? `http_${res.status}`, json.message ?? json.error ?? `HTTP ${res.status}`);
  }
  return json.result as T;
}

// ── Secrets ──────────────────────────────────────────────────────────────────

async function storeSecret(admin: SupabaseClient, kind: "agent" | "folder" | "machine", ref: string, secret: string): Promise<void> {
  const { ciphertext, iv } = await encryptSecret(secret);
  const { data: prev } = await admin.from("team_machine_secrets").select("version").eq("kind", kind).eq("ref_id", ref).maybeSingle();
  const version = ((prev as { version?: number } | null)?.version ?? 0) + 1;
  const { error } = await admin.from("team_machine_secrets").upsert(
    { kind, ref_id: ref, ciphertext, iv, version, updated_at: new Date().toISOString() },
    { onConflict: "kind,ref_id" },
  );
  if (error) throw new Error(`secret non enregistré : ${error.message}`);
}

async function readSecrets(admin: SupabaseClient, kind: "agent" | "folder" | "machine", refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!refs.length) return out;
  const { data } = await admin.from("team_machine_secrets").select("ref_id, ciphertext, iv").eq("kind", kind).in("ref_id", refs);
  for (const row of (data ?? []) as Array<{ ref_id: string; ciphertext: string; iv: string }>) {
    try { out.set(row.ref_id, await decryptSecret(row.ciphertext, row.iv)); } catch { /* clé changée : traité comme absent */ }
  }
  return out;
}

const agentRef = (teamId: string, agentId: string) => `${teamId}:${agentId}`;

export async function audit(
  admin: SupabaseClient,
  row: { team_id: string; workspace_id: string; action: string; agent_id?: string | null; user_id?: string | null; folder_id?: string | null; detail?: Record<string, unknown> },
): Promise<void> {
  await admin.from("team_machine_audit").insert({ detail: {}, ...row }).then(() => {}, () => {});
}

// ── Lecture ──────────────────────────────────────────────────────────────────

/**
 * La machine de l'agent, s'il en a une : son équipe a une machine ACTIVE et
 * la configuration est là. Null sinon — l'agent n'a alors aucun outil team_*.
 */
export async function loadAgentMachine(
  admin: SupabaseClient,
  agent: { id: string; name: string; service_dashboard_id?: string | null },
): Promise<AgentMachine | null> {
  if (!agent.service_dashboard_id) return null;
  try {
    // Une machine donnée à l'agent lui-même passe avant celle de son équipe :
    // c'est le choix le plus précis qu'un humain ait fait pour lui.
    let team: TeamCfg | null = null;
    let machine: MachineRow | null = null;
    const { data: own } = await admin.from("team_machines").select(MACHINE_ROW_COLS)
      .eq("scope", "agent").eq("agent_id", agent.id).eq("status", "active").maybeSingle();
    if (own) {
      machine = own as MachineRow;
      team = { id: machine.team_id, name: agent.name, agent_ids: [agent.id], lead_id: agent.id };
    } else {
      const { data: board } = await admin.from("service_dashboards").select("settings").eq("id", agent.service_dashboard_id).maybeSingle();
      team = findTeamOf((board as { settings?: unknown } | null)?.settings, agent.id);
      if (!team) return null;
      const { data: m, error } = await admin.from("team_machines").select(MACHINE_ROW_COLS).eq("team_id", team.id).maybeSingle();
      if (error || !m) return null;
      machine = m as MachineRow;
    }
    if (machine.status !== "active" || machine.dashboard_id !== agent.service_dashboard_id) return null;
    const config = await configFor(admin, machine).catch(() => null);
    if (!config) return null;
    return await buildAgentMachine(admin, agent, team, machine, config);
  } catch {
    // Une machine qu'on ne sait pas lire n'en est pas une : pas d'outils, pas de run cassé.
    return null;
  }
}

/** Ce qu'un agent sait d'UNE machine donnée (son équipe, ses dossiers, son compte). */
export async function buildAgentMachine(
  admin: SupabaseClient, agent: { id: string; name: string }, team: TeamCfg, machine: MachineRow, config: MachineConfig | null,
): Promise<AgentMachine> {
  const [{ data: names }, { data: me }, { data: mine }] = await Promise.all([
    admin.from("internal_agents").select("id, name").in("id", team.agent_ids.length ? team.agent_ids : ["00000000-0000-0000-0000-000000000000"]),
    admin.from("team_machine_agents").select("unix_user, home_path").eq("team_id", team.id).eq("agent_id", agent.id).maybeSingle(),
    admin.from("team_machine_folder_members").select("folder_id, role").eq("agent_id", agent.id),
  ]);
  const nameOf = new Map(((names ?? []) as Array<{ id: string; name: string }>).map((a) => [a.id, a.name]));
  const folders = await foldersFor(admin, team.id, ((mine ?? []) as Array<{ folder_id: string; role: string }>), nameOf);
  return {
    agentId: agent.id,
    agentName: agent.name,
    team,
    machine,
    teammates: team.agent_ids.filter((id) => id !== agent.id).map((id) => ({ id, name: nameOf.get(id) ?? id.slice(0, 8) })),
    unixUser: (me as { unix_user?: string } | null)?.unix_user ?? null,
    home: (me as { home_path?: string } | null)?.home_path ?? null,
    teamDir: machine.machine_path || `/teams/${machine.team_key}`,
    folders,
    config,
  };
}

async function foldersFor(
  admin: SupabaseClient, teamId: string, memberships: Array<{ folder_id: string; role: string }>, nameOf: Map<string, string>,
): Promise<MachineFolder[]> {
  if (!memberships.length) return [];
  const { data: rows } = await admin.from("team_machine_folders")
    .select("id, name, path, purpose").eq("team_id", teamId).eq("status", "active")
    .in("id", memberships.map((m) => m.folder_id));
  const list = (rows ?? []) as Array<{ id: string; name: string; path: string | null; purpose: string | null }>;
  if (!list.length) return [];
  const { data: all } = await admin.from("team_machine_folder_members").select("folder_id, agent_id, role").in("folder_id", list.map((f) => f.id));
  const members = (all ?? []) as Array<{ folder_id: string; agent_id: string; role: "owner" | "member" }>;
  return list.map((f) => ({
    ...f,
    role: (memberships.find((m) => m.folder_id === f.id)?.role === "owner" ? "owner" : "member") as "owner" | "member",
    members: members.filter((m) => m.folder_id === f.id)
      .map((m) => ({ agent_id: m.agent_id, name: nameOf.get(m.agent_id) ?? m.agent_id.slice(0, 8), role: m.role })),
  }));
}

/** Recharge les dossiers d'un agent (après une création, un ajout…). */
export async function refreshFolders(admin: SupabaseClient, am: AgentMachine): Promise<void> {
  const { data: mine } = await admin.from("team_machine_folder_members").select("folder_id, role").eq("agent_id", am.agentId);
  const nameOf = new Map([[am.agentId, am.agentName], ...am.teammates.map((t) => [t.id, t.name] as [string, string])]);
  am.folders = await foldersFor(admin, am.team.id, (mine ?? []) as Array<{ folder_id: string; role: string }>, nameOf);
}

// ── Identités sur la machine ─────────────────────────────────────────────────

async function ensureTeamOnMachine(admin: SupabaseClient, machine: MachineRow, team: TeamCfg, cfg: MachineConfig): Promise<void> {
  const r = await callMachine<{ key: string; path: string }>(cfg, "team.ensure", { team: { id: team.id, key: machine.team_key, name: team.name } });
  const patch: Record<string, unknown> = { machine_path: r.path, last_seen_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() };
  // La machine a pu choisir une autre clé (collision) : c'est elle qui a raison.
  if (r.key && r.key !== machine.team_key) patch.team_key = r.key;
  await admin.from("team_machines").update(patch).eq("team_id", team.id);
  machine.machine_path = r.path;
  if (r.key) machine.team_key = r.key;
}

/** L'agent existe sur la machine, avec son secret ; rend son utilisateur et son dossier perso. */
export async function ensureAgentOnMachine(admin: SupabaseClient, am: AgentMachine): Promise<{ user: string; home: string }> {
  if (!am.config) throw new MachineError(503, "machine_not_configured", "machine d'équipe non configurée");
  const ref = agentRef(am.team.id, am.agentId);
  let secret = (await readSecrets(admin, "agent", [ref])).get(ref);
  if (!secret) {
    secret = newSecret();
    await storeSecret(admin, "agent", ref, secret);
  }
  const payload = { team: { id: am.team.id }, agent: { id: am.agentId, name: am.agentName, user: unixUserFor({ id: am.agentId, name: am.agentName }), secret } };
  let r: { user: string; home: string };
  try {
    r = await callMachine(am.config, "agent.ensure", payload);
  } catch (e) {
    if (!(e instanceof MachineError) || e.code !== "team_unknown") throw e;
    await ensureTeamOnMachine(admin, am.machine, am.team, am.config);
    r = await callMachine(am.config, "agent.ensure", payload);
    // Une machine neuve pour l'équipe (déplacée, ou recréée) : ses dossiers
    // protégés s'y redéclarent avec leurs secrets.
    await redeclareFolders(admin, am);
  }
  await admin.from("team_machine_agents").upsert({
    team_id: am.team.id, agent_id: am.agentId, workspace_id: am.machine.workspace_id,
    unix_user: r.user, home_path: r.home, last_used_at: new Date().toISOString(),
  }, { onConflict: "team_id,agent_id" });
  am.unixUser = r.user;
  am.home = r.home;
  return r;
}

/** Ce que l'agent présente à la machine : son secret, et celui de SES dossiers. */
async function principalFor(admin: SupabaseClient, am: AgentMachine) {
  const ref = agentRef(am.team.id, am.agentId);
  // Membre aujourd'hui, pas au chargement du run : un retrait prend effet au
  // prochain appel, sans attendre le run suivant.
  const { data: rows } = await admin.from("team_machine_folder_members").select("folder_id").eq("agent_id", am.agentId);
  const candidates = ((rows ?? []) as Array<{ folder_id: string }>).map((r) => r.folder_id);
  let folderIds: string[] = [];
  if (candidates.length) {
    const { data: live } = await admin.from("team_machine_folders").select("id")
      .eq("team_id", am.team.id).eq("status", "active").in("id", candidates);
    folderIds = ((live ?? []) as Array<{ id: string }>).map((f) => f.id);
  }
  const [agentSecrets, folderSecrets] = await Promise.all([
    readSecrets(admin, "agent", [ref]),
    readSecrets(admin, "folder", folderIds),
  ]);
  const secret = agentSecrets.get(ref);
  if (!secret) throw new MachineError(404, "agent_unknown", "identité d'agent absente");
  return {
    team: { id: am.team.id },
    agent: { id: am.agentId, secret },
    folders: folderIds.filter((id) => folderSecrets.has(id)).map((id) => ({ id, secret: folderSecrets.get(id)! })),
  };
}

/**
 * Une opération AU NOM de l'agent. Se répare seule quand la machine a été
 * recréée (équipe ou agent inconnus) : on les recrée et on rejoue une fois.
 */
export async function agentCall<T = Record<string, unknown>>(
  admin: SupabaseClient, am: AgentMachine, op: string, args: Record<string, unknown>, timeoutMs = 90_000,
): Promise<T> {
  if (!am.config) throw new MachineError(503, "machine_not_configured", "machine d'équipe non configurée");
  if (!am.unixUser) await ensureAgentOnMachine(admin, am);
  const once = async () => callMachine<T>(am.config!, op, { principal: await principalFor(admin, am), args }, timeoutMs);
  try {
    return await once();
  } catch (e) {
    if (!(e instanceof MachineError) || !["team_unknown", "agent_unknown"].includes(e.code)) throw e;
    await ensureAgentOnMachine(admin, am);
    // Machine recréée (volume d'état perdu) : ses dossiers protégés aussi. On
    // les redéclare avec LEURS secrets — vides, mais aux mêmes règles.
    if (e.code === "team_unknown") await redeclareFolders(admin, am);
    return await once();
  }
}

async function redeclareFolders(admin: SupabaseClient, am: AgentMachine): Promise<void> {
  const { data } = await admin.from("team_machine_folders").select("id, name").eq("team_id", am.team.id).eq("status", "active");
  const rows = (data ?? []) as Array<{ id: string; name: string }>;
  const secrets = await readSecrets(admin, "folder", rows.map((r) => r.id));
  for (const f of rows) {
    const secret = secrets.get(f.id);
    if (!secret) continue;
    await callMachine(am.config!, "folder.create", { team: { id: am.team.id }, folder: { id: f.id, name: f.name, secret } }).catch(() => {});
  }
}

// ── Gestion ──────────────────────────────────────────────────────────────────

export async function loadTeamMachine(admin: SupabaseClient, teamId: string): Promise<{ machine: MachineRow; team: TeamCfg } | null> {
  const { data: m } = await admin.from("team_machines").select(MACHINE_ROW_COLS).eq("team_id", teamId).maybeSingle();
  if (!m) return null;
  const machine = m as MachineRow;
  if (machine.scope === "agent" && machine.agent_id) {
    const { data: a } = await admin.from("internal_agents").select("id, name").eq("id", machine.agent_id).maybeSingle();
    if (!a) return null;
    const agent = a as { id: string; name: string };
    return { machine, team: { id: teamId, name: agent.name, agent_ids: [agent.id], lead_id: agent.id } };
  }
  const { data: board } = await admin.from("service_dashboards").select("settings").eq("id", machine.dashboard_id).maybeSingle();
  const team = readTeams((board as { settings?: unknown } | null)?.settings).find((t) => t.id === teamId);
  return team ? { machine, team } : null;
}

/** Donne une machine à une équipe (ou la réveille). */
/** La première machine active d'un tableau (la plus ancienne), ou null. */
async function firstActiveMachine(admin: SupabaseClient, dashboardId: string): Promise<string | null> {
  const { data } = await admin.from("machines").select("id").eq("dashboard_id", dashboardId).eq("status", "active")
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

export async function enableTeamMachine(
  admin: SupabaseClient,
  input: { dashboardId: string; workspaceId: string; team: TeamCfg; userId: string | null; allowSystemPackages?: boolean; machineId?: string | null },
): Promise<MachineRow> {
  const { data: existing } = await admin.from("team_machines").select("*").eq("team_id", input.team.id).maybeSingle();
  if (existing && (existing as MachineRow).dashboard_id !== input.dashboardId) {
    throw new MachineError(409, "team_conflict", "cette équipe a déjà une machine dans un autre service");
  }
  // La machine du parc qui la portera : celle demandée, celle qu'elle avait,
  // sinon la première machine active du tableau. Il n'y a plus de machine de
  // la plateforme vers laquelle se rabattre.
  const machineId = input.machineId ?? (existing as { machine_id?: string | null } | null)?.machine_id ?? await firstActiveMachine(admin, input.dashboardId);
  if (!machineId) {
    throw new MachineError(409, "no_machine", "aucune machine dans ce service : créez-en une dans l'onglet Machines");
  }
  const row = existing
    ? { ...(existing as MachineRow), status: "active" as const, machine_id: machineId }
    : {
      team_id: input.team.id, dashboard_id: input.dashboardId, workspace_id: input.workspaceId,
      team_key: teamKeyFor(input.team), status: "active" as const,
      allow_system_packages: !!input.allowSystemPackages, url: null, machine_path: null, machine_id: machineId,
    };
  const { error } = await admin.from("team_machines").upsert({
    ...row, created_by: input.userId, updated_at: new Date().toISOString(),
  }, { onConflict: "team_id" });
  if (error) throw new Error(error.message);
  const cfg = await configFor(admin, row);
  if (cfg) {
    try {
      await ensureTeamOnMachine(admin, row, input.team, cfg);
      if (existing) await callMachine(cfg, "team.suspend", { team: { id: input.team.id }, suspended: false });
    } catch (e) {
      // La machine est éteinte : l'équipe est inscrite, elle sera créée au
      // premier appel d'un agent. On le dit, sans échouer.
      await admin.from("team_machines").update({ last_error: e instanceof Error ? e.message : String(e) }).eq("team_id", input.team.id);
    }
  }
  await audit(admin, { team_id: input.team.id, workspace_id: input.workspaceId, user_id: input.userId, action: existing ? "resume" : "enable" });
  return row;
}

/**
 * Attribue une machine du parc à une équipe ou à un agent seul — ou la
 * retire (machine = null : l'attribution passe en pause, les fichiers restent
 * sur la machine).
 *
 * Changer de machine ne déplace pas les fichiers : l'équipe repart d'un
 * dossier vide sur la nouvelle, avec les mêmes agents et les mêmes dossiers
 * protégés (redéclarés au premier appel). L'ancienne garde ce qu'elle avait.
 */
export async function assignMachine(
  admin: SupabaseClient,
  input: {
    dashboardId: string; workspaceId: string; userId: string | null;
    target: { type: "team"; team: TeamCfg } | { type: "agent"; agent: { id: string; name: string } };
    machine: FleetMachine | null;
  },
): Promise<{ team_id: string; status: "active" | "paused" | "none"; moved: boolean }> {
  const team: TeamCfg = input.target.type === "team"
    ? input.target.team
    : { id: soloTeamId(input.target.agent.id), name: input.target.agent.name, agent_ids: [input.target.agent.id], lead_id: input.target.agent.id };
  const { data: prev } = await admin.from("team_machines").select(MACHINE_ROW_COLS).eq("team_id", team.id).maybeSingle();
  const existing = (prev ?? null) as MachineRow | null;
  if (existing && existing.dashboard_id !== input.dashboardId) {
    throw new MachineError(409, "team_conflict", "cette attribution appartient à un autre service");
  }

  if (!input.machine) {
    if (!existing) return { team_id: team.id, status: "none", moved: false };
    if (existing.status === "active") await pauseTeamMachine(admin, existing, input.userId);
    return { team_id: team.id, status: "paused", moved: false };
  }
  const m = input.machine;
  if (m.workspace_id !== input.workspaceId) throw new MachineError(403, "machine_foreign", "cette machine n'est pas dans cet espace");

  const moved = !!existing && (existing.machine_id ?? null) !== m.id;
  // Ce qui tournait sur l'ancienne machine s'arrête ; ses fichiers y restent.
  if (moved && existing!.status === "active") await pauseTeamMachine(admin, existing!, input.userId).catch(() => {});
  const row: MachineRow = {
    team_id: team.id, dashboard_id: input.dashboardId, workspace_id: input.workspaceId,
    team_key: existing && !moved ? existing.team_key : teamKeyFor(team),
    status: "active", allow_system_packages: m.allow_system_packages,
    // L'URL est recopiée : un runtime d'avant 0304 sait encore joindre la machine.
    url: m.url, machine_path: existing && !moved ? existing.machine_path : null,
    machine_id: m.id,
    scope: input.target.type,
    agent_id: input.target.type === "agent" ? input.target.agent.id : null,
  };
  const { error } = await admin.from("team_machines").upsert({ ...row, created_by: input.userId, updated_at: new Date().toISOString() }, { onConflict: "team_id" });
  if (error) throw new Error(error.message);
  // Les comptes Linux sont propres à chaque machine : on les recrée sur la nouvelle.
  if (moved) await admin.from("team_machine_agents").delete().eq("team_id", team.id);

  const cfg = await fleetConfig(admin, m);
  if (cfg) {
    try {
      await ensureTeamOnMachine(admin, row, team, cfg);
      if (existing && !moved) await callMachine(cfg, "team.suspend", { team: { id: team.id }, suspended: false });
    } catch (e) {
      await admin.from("team_machines").update({ last_error: e instanceof Error ? e.message : String(e) }).eq("team_id", team.id);
    }
  }
  await audit(admin, {
    team_id: team.id, workspace_id: input.workspaceId, user_id: input.userId,
    action: moved ? "move" : existing ? "resume" : "enable", detail: { machine: m.name, machine_id: m.id, scope: input.target.type },
  });
  return { team_id: team.id, status: "active", moved };
}

/** Met la machine de l'équipe en pause : ses processus s'arrêtent, ses fichiers restent. */
export async function pauseTeamMachine(admin: SupabaseClient, machine: MachineRow, userId: string | null): Promise<{ stopped: number | null }> {
  await admin.from("team_machines").update({ status: "paused", updated_at: new Date().toISOString() }).eq("team_id", machine.team_id);
  let stopped: number | null = null;
  const cfg = await configFor(admin, machine).catch(() => null);
  if (cfg) {
    try {
      stopped = (await callMachine<{ stopped: number }>(cfg, "team.suspend", { team: { id: machine.team_id }, suspended: true })).stopped;
    } catch (e) {
      if (!(e instanceof MachineError) || e.code !== "team_unknown") throw e;
    }
  }
  await audit(admin, { team_id: machine.team_id, workspace_id: machine.workspace_id, user_id: userId, action: "pause", detail: { stopped } });
  return { stopped };
}

async function machineFor(admin: SupabaseClient, machine: MachineRow, team: TeamCfg): Promise<MachineConfig> {
  const cfg = await configFor(admin, machine);
  if (!cfg) throw new MachineError(503, "machine_not_configured", "aucune machine joignable pour cette équipe : créez-en une ou rattachez-la à une machine dans l'onglet Machines");
  if (!machine.machine_path) await ensureTeamOnMachine(admin, machine, team, cfg);
  return cfg;
}

/** Crée un dossier protégé : un secret neuf, un groupe sur la machine, des membres pris dans l'équipe. */
export async function createFolder(
  admin: SupabaseClient,
  input: { machine: MachineRow; team: TeamCfg; name: string; purpose?: string | null; memberIds: string[]; ownerAgentId?: string | null; actor: Actor },
): Promise<{ id: string; name: string; path: string; members: string[] }> {
  const name = normalizeFolderName(input.name);
  if (!name) throw new MachineError(400, "bad_folder_name", "nom de dossier invalide : lettres, chiffres, « . _ - », 48 caractères au plus");
  const members = [...new Set([...(input.ownerAgentId ? [input.ownerAgentId] : []), ...input.memberIds])];
  const outsiders = members.filter((id) => !input.team.agent_ids.includes(id));
  if (outsiders.length) throw new MachineError(400, "not_in_team", "les membres d'un dossier protégé sont pris dans l'équipe");
  if (!members.length) throw new MachineError(400, "no_members", "un dossier protégé a au moins un membre");
  const { data: taken } = await admin.from("team_machine_folders").select("id").eq("team_id", input.team.id).eq("name", name).eq("status", "active").maybeSingle();
  if (taken) throw new MachineError(409, "folder_name_taken", `un dossier « ${name} » existe déjà dans l'équipe`);

  const cfg = await machineFor(admin, input.machine, input.team);
  const id = crypto.randomUUID();
  const secret = newSecret();
  // Le secret est gardé AVANT d'être confié à la machine : un dossier créé
  // là-bas dont on aurait perdu la clé serait inouvrable.
  await storeSecret(admin, "folder", id, secret);
  let created: { path: string };
  try {
    created = await callMachine<{ path: string }>(cfg, "folder.create", { team: { id: input.team.id }, folder: { id, name, secret } });
  } catch (e) {
    await admin.from("team_machine_secrets").delete().eq("kind", "folder").eq("ref_id", id);
    throw e;
  }
  const { error } = await admin.from("team_machine_folders").insert({
    id, team_id: input.team.id, workspace_id: input.machine.workspace_id, name, path: created.path,
    purpose: input.purpose?.slice(0, 500) || null,
    created_by_agent: input.actor.agentId ?? null, created_by_user: input.actor.userId ?? null,
  });
  if (error) throw new Error(error.message);
  const owner = input.ownerAgentId ?? null;
  await admin.from("team_machine_folder_members").insert(members.map((agent_id) => ({
    folder_id: id, agent_id, role: agent_id === owner ? "owner" : "member",
    added_by_agent: input.actor.agentId ?? null, added_by_user: input.actor.userId ?? null,
  })));
  await audit(admin, {
    team_id: input.team.id, workspace_id: input.machine.workspace_id, agent_id: input.actor.agentId ?? null,
    user_id: input.actor.userId ?? null, folder_id: id, action: "folder_create", detail: { name, members },
  });
  return { id, name, path: created.path, members };
}

export interface FolderRow { id: string; team_id: string; workspace_id: string; name: string; path: string | null; status: string }

export async function loadFolder(admin: SupabaseClient, folderId: string): Promise<FolderRow | null> {
  const { data } = await admin.from("team_machine_folders").select("id, team_id, workspace_id, name, path, status").eq("id", folderId).maybeSingle();
  return (data as FolderRow | null) ?? null;
}

async function membersOf(admin: SupabaseClient, folderId: string) {
  const { data } = await admin.from("team_machine_folder_members").select("agent_id, role").eq("folder_id", folderId);
  return (data ?? []) as Array<{ agent_id: string; role: "owner" | "member" }>;
}

/** Un agent ne gère que les dossiers dont il est propriétaire ; un humain, tous (son rôle est vérifié avant). */
async function assertManager(admin: SupabaseClient, folder: FolderRow, actor: Actor): Promise<void> {
  if (actor.userId && !actor.agentId) return;
  const m = (await membersOf(admin, folder.id)).find((x) => x.agent_id === actor.agentId);
  if (m?.role !== "owner") throw new MachineError(403, "not_owner", `seul le propriétaire du dossier « ${folder.name} » (ou un humain) gère ses membres et son secret`);
}

/** Ajoute et retire des membres. Un membre retiré perd l'accès sur-le-champ : ses processus qui tenaient le dossier sont arrêtés. */
export async function changeFolderMembers(
  admin: SupabaseClient,
  input: { folder: FolderRow; team: TeamCfg; machine: MachineRow; add?: string[]; remove?: string[]; actor: Actor },
): Promise<{ added: string[]; removed: string[] }> {
  const { folder, team, machine, actor } = input;
  if (folder.status !== "active") throw new MachineError(409, "folder_archived", "dossier archivé");
  await assertManager(admin, folder, actor);
  const current = await membersOf(admin, folder.id);
  const add = [...new Set(input.add ?? [])].filter((id) => !current.some((m) => m.agent_id === id));
  if (add.some((id) => !team.agent_ids.includes(id))) throw new MachineError(400, "not_in_team", "les membres d'un dossier protégé sont pris dans l'équipe");
  const remove = [...new Set(input.remove ?? [])].filter((id) => current.some((m) => m.agent_id === id));
  if (current.length - remove.length + add.length < 1) throw new MachineError(400, "no_members", "un dossier protégé garde au moins un membre — archive-le plutôt");
  if (add.length) {
    await admin.from("team_machine_folder_members").insert(add.map((agent_id) => ({
      folder_id: folder.id, agent_id, role: "member", added_by_agent: actor.agentId ?? null, added_by_user: actor.userId ?? null,
    })));
  }
  if (remove.length) {
    await admin.from("team_machine_folder_members").delete().eq("folder_id", folder.id).in("agent_id", remove);
    // Le propriétaire parti, le plus ancien membre restant le devient.
    if (current.some((m) => m.role === "owner" && remove.includes(m.agent_id))) await promoteOwner(admin, folder.id);
    const cfg = await configFor(admin, machine).catch(() => null);
    if (cfg) {
      for (const agentId of remove) {
        await callMachine(cfg, "folder.revoke", { folder: { id: folder.id }, agent: { id: agentId } }).catch(() => {});
      }
    }
  }
  for (const [action, ids] of [["member_add", add], ["member_remove", remove]] as const) {
    if (ids.length) {
      await audit(admin, {
        team_id: folder.team_id, workspace_id: folder.workspace_id, agent_id: actor.agentId ?? null,
        user_id: actor.userId ?? null, folder_id: folder.id, action, detail: { agents: ids },
      });
    }
  }
  return { added: add, removed: remove };
}

async function promoteOwner(admin: SupabaseClient, folderId: string): Promise<void> {
  const { data } = await admin.from("team_machine_folder_members").select("agent_id, role").eq("folder_id", folderId).order("added_at").limit(1);
  const next = ((data ?? []) as Array<{ agent_id: string; role: string }>)[0];
  if (next && next.role !== "owner") {
    await admin.from("team_machine_folder_members").update({ role: "owner" }).eq("folder_id", folderId).eq("agent_id", next.agent_id);
  }
}

/** Un agent quitte un dossier de lui-même. */
export async function leaveFolder(
  admin: SupabaseClient, input: { folder: FolderRow; machine: MachineRow; agentId: string },
): Promise<void> {
  const current = await membersOf(admin, input.folder.id);
  const me = current.find((m) => m.agent_id === input.agentId);
  if (!me) return;
  if (current.length === 1) throw new MachineError(400, "last_member", "tu es le dernier membre : un humain peut archiver le dossier, mais il ne peut pas rester sans membre");
  await admin.from("team_machine_folder_members").delete().eq("folder_id", input.folder.id).eq("agent_id", input.agentId);
  if (me.role === "owner") await promoteOwner(admin, input.folder.id);
  const cfg = await configFor(admin, input.machine).catch(() => null);
  if (cfg) await callMachine(cfg, "folder.revoke", { folder: { id: input.folder.id }, agent: { id: input.agentId } }).catch(() => {});
  await audit(admin, { team_id: input.folder.team_id, workspace_id: input.folder.workspace_id, agent_id: input.agentId, folder_id: input.folder.id, action: "leave" });
}

/** Nouveau secret : l'ancien n'ouvre plus rien, les processus qui le tenaient s'arrêtent. */
export async function rotateFolderSecret(
  admin: SupabaseClient, input: { folder: FolderRow; team: TeamCfg; machine: MachineRow; actor: Actor },
): Promise<void> {
  const { folder, actor } = input;
  if (folder.status !== "active") throw new MachineError(409, "folder_archived", "dossier archivé");
  await assertManager(admin, folder, actor);
  const cfg = await machineFor(admin, input.machine, input.team);
  const old = (await readSecrets(admin, "folder", [folder.id])).get(folder.id);
  const next = newSecret();
  // Sans l'ancien secret (base restaurée, clé changée), seul un humain force.
  if (!old && actor.agentId) throw new MachineError(409, "secret_lost", "secret du dossier illisible : un humain doit le régénérer");
  await callMachine(cfg, "folder.rotate", { folder: { id: folder.id, secret: old, new_secret: next }, force: !old });
  await storeSecret(admin, "folder", folder.id, next);
  await admin.from("team_machine_folders").update({ secret_rotated_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", folder.id);
  await audit(admin, { team_id: folder.team_id, workspace_id: folder.workspace_id, agent_id: actor.agentId ?? null, user_id: actor.userId ?? null, folder_id: folder.id, action: "rotate" });
}

/** Archive : le dossier sort de l'atteinte de tous les agents. Rien n'est effacé sur la machine. */
export async function archiveFolder(
  admin: SupabaseClient, input: { folder: FolderRow; machine: MachineRow; userId: string },
): Promise<{ archivedPath: string | null }> {
  const cfg = await configFor(admin, input.machine);
  let archivedPath: string | null = null;
  if (cfg) {
    try {
      archivedPath = (await callMachine<{ path: string | null }>(cfg, "folder.archive", { folder: { id: input.folder.id } })).path;
    } catch (e) {
      if (!(e instanceof MachineError) || e.code !== "folder_unknown") throw e;
    }
  }
  await admin.from("team_machine_folders").update({ status: "archived", updated_at: new Date().toISOString() }).eq("id", input.folder.id);
  await admin.from("team_machine_secrets").delete().eq("kind", "folder").eq("ref_id", input.folder.id);
  await audit(admin, { team_id: input.folder.team_id, workspace_id: input.folder.workspace_id, user_id: input.userId, folder_id: input.folder.id, action: "archive", detail: { archived_path: archivedPath } });
  return { archivedPath };
}

/** Un humain redonne une identité à un agent (secret perdu) : ses fichiers restent les siens. */
export async function resetAgentSecret(
  admin: SupabaseClient, input: { machine: MachineRow; team: TeamCfg; agentId: string; userId: string },
): Promise<void> {
  const cfg = await machineFor(admin, input.machine, input.team);
  const secret = newSecret();
  try {
    await callMachine(cfg, "agent.reset_secret", { team: { id: input.team.id }, agent: { id: input.agentId, secret } });
  } catch (e) {
    if (!(e instanceof MachineError) || e.code !== "agent_unknown") throw e;
  }
  await storeSecret(admin, "agent", agentRef(input.team.id, input.agentId), secret);
  await audit(admin, { team_id: input.team.id, workspace_id: input.machine.workspace_id, user_id: input.userId, agent_id: input.agentId, action: "agent_reset" });
}
