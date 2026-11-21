// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/machines/index.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.
import { Deno, defineHandler } from "../../compat/index.ts";

// machines — le parc de machines d'un espace (0304), côté humains.
//
// Appelée par une PERSONNE (son JWT), depuis l'onglet Machines :
//
//   { action: "list",     dashboard_id }                                  lecteur
//   { action: "create",   dashboard_id, name, description?, kind?, url?, token?, allow_system_packages? }   admin
//   { action: "update",   machine_id, name?, description?, kind?, url?, token?, allow_system_packages?, status? } admin
//   { action: "delete",   machine_id }                                    admin
//   { action: "probe",    machine_id }                                    lecteur
//   { action: "activity", machine_id, since? }                            membre
//   { action: "browser_view", machine_id, team_id, agent_id }             membre
//   { action: "assign",   dashboard_id, target: { type: "team"|"agent", id }, machine_id | null }  admin
//   { action: "files",    team_id, agent_id, op: "list"|"read", path?, offset? }                 membre
//   { action: "job_logs", team_id, agent_id, job_id }                     membre
//   { action: "job_stop", team_id, agent_id, job_id }                     admin
//
// Le workspace est déduit de la ressource, jamais du corps. Aucun jeton ni
// secret ne sort d'ici : l'interface sait seulement QU'une machine a son jeton.
//
// Lire les fichiers d'une machine passe par un AGENT : on lit ce que cet agent
// peut lire, avec ses secrets, et le noyau tranche. Un humain ne contourne donc
// pas un dossier protégé en ouvrant l'explorateur ; il choisit par quels yeux
// il regarde.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { requireWorkspaceMember, type WorkspaceRole } from "../_shared/authz.ts";
import { assertSafeUrl } from "../_shared/ssrf.ts";
import {
  agentCall, assignMachine, audit, buildAgentMachine, callMachine, configFor, fleetConfig, hasMachineToken, loadFleetMachine,
  loadTeamMachine, MachineError, readTeams, setMachineToken, type FleetMachine, type MachineRow,
} from "../_shared/team-machine.ts";

type Body = Record<string, unknown> & { action?: string };

const KINDS = ["docker", "vm", "cloud", "platform"] as const;
const str = (v: unknown, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export default defineHandler(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  let body: Body;
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: "invalid JSON body" }, { status: 400 }); }
  const admin = createServiceClient();
  const guard = (workspaceId: string, role: WorkspaceRole) => requireWorkspaceMember(req, workspaceId, role);

  try {
    switch (body.action) {
      case "list": {
        const board = await loadBoard(admin, str(body.dashboard_id));
        if (!board) return jsonResponse({ ok: false, error: "tableau introuvable" }, { status: 404 });
        const auth = await guard(board.workspace_id, "viewer");
        if (!auth.ok) return auth.response;
        return jsonResponse({ ok: true, ...(await listFleet(admin, board)) });
      }

      case "create": {
        const board = await loadBoard(admin, str(body.dashboard_id));
        if (!board) return jsonResponse({ ok: false, error: "tableau introuvable" }, { status: 404 });
        const auth = await guard(board.workspace_id, "admin");
        if (!auth.ok) return auth.response;
        const name = str(body.name, 80);
        if (!name) return jsonResponse({ ok: false, error: "donnez un nom à la machine" }, { status: 400 });
        const url = await checkedUrl(body.url);
        if (url instanceof Response) return url;
        const kind = KINDS.includes(body.kind as typeof KINDS[number]) ? body.kind as string : (url ? "vm" : "docker");
        const { data, error } = await admin.from("machines").insert({
          workspace_id: board.workspace_id, dashboard_id: board.id, name,
          description: str(body.description, 400) || null, kind, url,
          allow_system_packages: body.allow_system_packages === true, created_by: auth.userId,
        }).select("*").single();
        if (error) throw new Error(error.message);
        const m = data as FleetMachine;
        if (str(body.token, 400)) await setMachineToken(admin, m.id, str(body.token, 400));
        // La machine de la plateforme reprend les attributions d'avant 0304,
        // qui n'en désignaient aucune : ce sont les mêmes équipes, au même endroit.
        if (!url) {
          await admin.from("team_machines").update({ machine_id: m.id })
            .eq("workspace_id", board.workspace_id).is("machine_id", null).is("url", null);
        }
        const probe = await probeMachine(admin, m);
        return jsonResponse({ ok: true, machine: { ...m, has_token: !!str(body.token, 400) }, probe });
      }

      case "update":
      case "delete":
      case "probe":
      case "activity":
      case "browser_view": {
        const m = await loadFleetMachine(admin, str(body.machine_id));
        if (!m) return jsonResponse({ ok: false, error: "machine introuvable" }, { status: 404 });
        const role: WorkspaceRole = body.action === "probe" ? "viewer" : body.action === "activity" || body.action === "browser_view" ? "member" : "admin";
        const auth = await guard(m.workspace_id, role);
        if (!auth.ok) return auth.response;
        if (body.action === "probe") return jsonResponse({ ok: true, probe: await probeMachine(admin, m) });
        if (body.action === "activity") return jsonResponse({ ok: true, ...(await activityOf(admin, m, str(body.since, 40) || null)) });
        if (body.action === "browser_view") return jsonResponse({ ok: true, ...(await browserViewOf(admin, m, str(body.team_id, 80), str(body.agent_id, 64))) });
        if (body.action === "delete") {
          const { data: live } = await admin.from("team_machines").select("team_id").eq("machine_id", m.id).eq("status", "active");
          if ((live ?? []).length) {
            return jsonResponse({ ok: false, error: "retirez d'abord cette machine des équipes et des agents qui l'utilisent" }, { status: 409 });
          }
          await setMachineToken(admin, m.id, null);
          const { error } = await admin.from("machines").delete().eq("id", m.id);
          if (error) throw new Error(error.message);
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ ok: true, ...(await updateMachine(admin, m, body, auth.userId)) });
      }

      case "assign": {
        const board = await loadBoard(admin, str(body.dashboard_id));
        if (!board) return jsonResponse({ ok: false, error: "tableau introuvable" }, { status: 404 });
        const auth = await guard(board.workspace_id, "admin");
        if (!auth.ok) return auth.response;
        const t = (body.target ?? {}) as { type?: string; id?: string };
        const machineId = body.machine_id == null ? null : str(body.machine_id);
        const machine = machineId ? await loadFleetMachine(admin, machineId) : null;
        if (machineId && !machine) return jsonResponse({ ok: false, error: "machine introuvable" }, { status: 404 });
        if (machine && machine.status !== "active") return jsonResponse({ ok: false, error: "cette machine est en pause" }, { status: 409 });
        let target: Parameters<typeof assignMachine>[1]["target"];
        if (t.type === "team") {
          const team = readTeams(board.settings).find((x) => x.id === t.id);
          if (!team) return jsonResponse({ ok: false, error: "équipe introuvable dans ce service" }, { status: 404 });
          target = { type: "team", team };
        } else if (t.type === "agent") {
          const { data: a } = await admin.from("internal_agents").select("id, name, service_dashboard_id").eq("id", String(t.id ?? "")).maybeSingle();
          const agent = a as { id: string; name: string; service_dashboard_id: string | null } | null;
          if (!agent || agent.service_dashboard_id !== board.id) return jsonResponse({ ok: false, error: "agent introuvable dans ce service" }, { status: 404 });
          target = { type: "agent", agent };
        } else {
          return jsonResponse({ ok: false, error: "target.type : team ou agent" }, { status: 400 });
        }
        const r = await assignMachine(admin, { dashboardId: board.id, workspaceId: board.workspace_id, userId: auth.userId, target, machine });
        return jsonResponse({ ok: true, ...r });
      }

      case "files":
      case "job_logs":
      case "job_stop": {
        const loaded = await loadTeamMachine(admin, str(body.team_id, 80));
        if (!loaded) return jsonResponse({ ok: false, error: "aucune machine pour cette équipe" }, { status: 404 });
        const { machine, team } = loaded;
        const auth = await guard(machine.workspace_id, body.action === "job_stop" ? "admin" : "member");
        if (!auth.ok) return auth.response;
        if (machine.status !== "active") return jsonResponse({ ok: false, error: "cette attribution est en pause" }, { status: 409 });
        const agentId = str(body.agent_id, 64);
        if (!team.agent_ids.includes(agentId)) return jsonResponse({ ok: false, error: "cet agent n'est pas sur cette machine" }, { status: 400 });
        const { data: a } = await admin.from("internal_agents").select("id, name").eq("id", agentId).maybeSingle();
        if (!a) return jsonResponse({ ok: false, error: "agent introuvable" }, { status: 404 });
        const config = await configFor(admin, machine);
        if (!config) return jsonResponse({ ok: false, error: "machine injoignable ou en pause" }, { status: 503 });
        const am = await buildAgentMachine(admin, a as { id: string; name: string }, team, machine, config);

        if (body.action === "files") {
          const op = body.op === "read" ? "read" : "list";
          const path = str(body.path, 1024) || "~";
          const req = op === "read"
            ? (body.encoding === "base64" ? { op, path, encoding: "base64" } : { op, path, offset: Math.max(0, Number(body.offset) || 0), limit: 4000 })
            : { op, path, all: body.all === true };
          const result = await agentCall(admin, am, "fs", req, 30_000);
          if (op === "read") {
            await audit(admin, {
              team_id: team.id, workspace_id: machine.workspace_id, user_id: auth.userId, agent_id: agentId,
              action: "human_read", detail: { path: (result as { path?: string }).path ?? path },
            });
          }
          return jsonResponse({
            ok: true, result,
            where: {
              home: am.home, team_dir: am.teamDir, shared: `${am.teamDir}/commun`,
              folders: am.folders.map((f) => ({ name: f.name, path: f.path })),
              solo: machine.scope === "agent",
            },
          });
        }
        const jobId = str(body.job_id, 40);
        if (body.action === "job_logs") {
          return jsonResponse({ ok: true, job: await agentCall(admin, am, "job.logs", { id: jobId, tail: 40_000 }, 20_000) });
        }
        const job = await agentCall(admin, am, "job.stop", { id: jobId }, 20_000);
        await audit(admin, { team_id: team.id, workspace_id: machine.workspace_id, user_id: auth.userId, agent_id: agentId, action: "job_stop", detail: { job: jobId } });
        return jsonResponse({ ok: true, job });
      }

      default:
        return jsonResponse({ ok: false, error: `action inconnue : ${String(body.action ?? "")}` }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof MachineError) {
      return jsonResponse({ ok: false, error: e.message, code: e.code }, { status: e.status >= 400 && e.status < 600 ? e.status : 500 });
    }
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
});

// deno-lint-ignore no-explicit-any
type Admin = any;

interface Board { id: string; workspace_id: string; settings: unknown }

async function loadBoard(admin: Admin, id: string): Promise<Board | null> {
  if (!id) return null;
  const { data } = await admin.from("service_dashboards").select("id, workspace_id, settings").eq("id", id).maybeSingle();
  return (data as Board | null) ?? null;
}

/** Une URL de machine : vide (la machine de la plateforme), ou publique. */
async function checkedUrl(raw: unknown): Promise<string | null | Response> {
  const url = str(raw, 300).replace(/\/+$/, "");
  if (!url) return null;
  if (!/^https?:\/\/[a-z0-9.\-]+(:[0-9]{1,5})?(\/.*)?$/i.test(url)) {
    return jsonResponse({ ok: false, error: "adresse invalide : http(s)://hôte[:port]" }, { status: 400 });
  }
  const verdict = await assertSafeUrl(url);
  if (!verdict.ok) return jsonResponse({ ok: false, error: `adresse refusée : ${verdict.reason ?? "adresse interne"}` }, { status: 400 });
  return url;
}

/** Joindre la machine : /health d'abord (sans signature), puis machine.info. */
async function probeMachine(admin: Admin, m: FleetMachine) {
  const cfg = await fleetConfig(admin, m).catch(() => null);
  if (!cfg) {
    const error = m.url ? "aucun jeton : posez celui de la machine, ou TEAM_MACHINE_TOKEN côté plateforme"
      : "machine de la plateforme non configurée (TEAM_MACHINE_URL / app_config.team_machine_url, TEAM_MACHINE_TOKEN)";
    await admin.from("machines").update({ last_error: error }).eq("id", m.id);
    return { reachable: false, error };
  }
  const started = Date.now();
  try {
    const info = await callMachine<Record<string, unknown>>(cfg, "machine.info", {}, 15_000);
    const now = new Date().toISOString();
    await admin.from("machines").update({ info, last_seen_at: now, last_error: null }).eq("id", m.id);
    return { reachable: true, info, latency_ms: Date.now() - started, seen_at: now };
  } catch (e) {
    // Un superviseur d'avant 0.2.0 ne connaît pas machine.info : il répond quand même.
    if (e instanceof MachineError && e.code === "unknown_op") {
      const now = new Date().toISOString();
      const info = { version: "0.1.x" };
      await admin.from("machines").update({ info, last_seen_at: now, last_error: null }).eq("id", m.id);
      return { reachable: true, info, latency_ms: Date.now() - started, seen_at: now };
    }
    const error = e instanceof Error ? e.message : String(e);
    await admin.from("machines").update({ last_error: error }).eq("id", m.id);
    return { reachable: false, error };
  }
}

async function listFleet(admin: Admin, board: Board) {
  const [{ data: machines }, { data: rows }, { data: agents }] = await Promise.all([
    admin.from("machines").select("*").eq("workspace_id", board.workspace_id).order("created_at"),
    admin.from("team_machines")
      .select("team_id, dashboard_id, team_key, status, machine_id, scope, agent_id, machine_path, last_seen_at, last_error, updated_at")
      .eq("dashboard_id", board.id),
    admin.from("internal_agents").select("id, name, avatar_url, avatar_style, is_orchestrator")
      .eq("service_dashboard_id", board.id).order("name"),
  ]);
  const list = (machines ?? []) as FleetMachine[];
  const tokens = await hasMachineToken(admin, list.map((m) => m.id));
  const assigned = (rows ?? []) as Array<{ team_id: string; machine_id: string | null; status: string; scope: string; agent_id: string | null }>;
  const { data: usage } = await admin.from("team_machines").select("machine_id, status").eq("workspace_id", board.workspace_id).not("machine_id", "is", null);
  const uses = (usage ?? []) as Array<{ machine_id: string; status: string }>;
  const teamAgents = new Map<string, string[]>(readTeams(board.settings).map((t) => [t.id, t.agent_ids]));
  return {
    machines: list.map((m) => ({
      ...m,
      has_token: tokens.has(m.id),
      assignments: uses.filter((u) => u.machine_id === m.id && u.status === "active").length,
    })),
    assignments: assigned,
    teams: readTeams(board.settings).map((t) => ({ id: t.id, name: t.name, agent_ids: t.agent_ids, lead_id: t.lead_id })),
    agents: ((agents ?? []) as Array<{ id: string; name: string; avatar_url: string | null; avatar_style: string | null; is_orchestrator: boolean }>)
      .filter((a) => !a.is_orchestrator)
      .map(({ is_orchestrator: _o, ...a }) => ({
        ...a,
        teams: [...teamAgents.entries()].filter(([, ids]) => ids.includes(a.id)).map(([id]) => id),
      })),
    platform: { token: (Deno.env.get("TEAM_MACHINE_TOKEN") ?? "").length >= 32 },
  };
}

async function updateMachine(admin: Admin, m: FleetMachine, body: Body, userId: string | null) {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) {
    const name = str(body.name, 80);
    if (!name) throw new MachineError(400, "bad_name", "le nom ne peut pas être vide");
    patch.name = name;
  }
  if (body.description !== undefined) patch.description = str(body.description, 400) || null;
  if (body.kind !== undefined && KINDS.includes(body.kind as typeof KINDS[number])) patch.kind = body.kind;
  if (body.url !== undefined) {
    const url = await checkedUrl(body.url);
    if (url instanceof Response) throw new MachineError(400, "bad_url", "adresse refusée");
    patch.url = url;
  }
  if (typeof body.allow_system_packages === "boolean") patch.allow_system_packages = body.allow_system_packages;
  const statusChange = body.status === "paused" || body.status === "active" ? body.status as "paused" | "active" : null;
  if (statusChange) patch.status = statusChange;
  if (body.token !== undefined) await setMachineToken(admin, m.id, body.token === null ? null : str(body.token, 400) || null);

  const { error } = await admin.from("machines").update(patch).eq("id", m.id);
  if (error) throw new Error(error.message);
  // Les attributions suivent : l'adresse (pour les runtimes d'avant 0304) et
  // l'autorisation apt, que les outils des agents lisent sur leur ligne.
  const follow: Record<string, unknown> = {};
  if ("url" in patch) follow.url = patch.url;
  if ("allow_system_packages" in patch) follow.allow_system_packages = patch.allow_system_packages;
  if (Object.keys(follow).length) await admin.from("team_machines").update(follow).eq("machine_id", m.id);

  // Mettre la machine en pause arrête ce qui y tourne pour ses équipes ; la
  // relancer les réveille. Les attributions gardent leur propre état.
  if (statusChange && statusChange !== m.status) {
    const fresh = { ...m, ...patch } as FleetMachine;
    const cfg = await fleetConfig(admin, fresh).catch(() => null);
    const { data: rows } = await admin.from("team_machines").select("team_id, workspace_id").eq("machine_id", m.id).eq("status", "active");
    for (const r of (rows ?? []) as Array<{ team_id: string; workspace_id: string }>) {
      if (cfg) await callMachine(cfg, "team.suspend", { team: { id: r.team_id }, suspended: statusChange === "paused" }).catch(() => {});
      await audit(admin, { team_id: r.team_id, workspace_id: r.workspace_id, user_id: userId, action: statusChange === "paused" ? "machine_pause" : "machine_resume", detail: { machine: m.name } });
    }
  }
  const tokens = await hasMachineToken(admin, [m.id]);
  return { machine: { ...m, ...patch, has_token: tokens.has(m.id) } };
}

/** Ce qui se passe sur une machine, pour les équipes de CET espace seulement. */
/** L'écran du navigateur d'un agent de cet espace, s'il est ouvert. */
async function browserViewOf(admin: Admin, m: FleetMachine, teamId: string, agentId: string) {
  const loaded = await loadTeamMachine(admin, teamId);
  if (!loaded || loaded.machine.machine_id !== m.id || loaded.machine.workspace_id !== m.workspace_id || !loaded.team.agent_ids.includes(agentId)) {
    throw new MachineError(404, "not_here", "cet agent ne travaille pas sur cette machine");
  }
  const cfg = await fleetConfig(admin, m);
  if (!cfg) throw new MachineError(503, "machine_not_configured", "machine non configurée");
  return await callMachine<Record<string, unknown>>(cfg, "browser.view", { team: { id: teamId }, agent: { id: agentId } }, 20_000);
}

async function activityOf(admin: Admin, m: FleetMachine, since: string | null = null) {
  const { data: rows } = await admin.from("team_machines")
    .select("team_id, dashboard_id, scope, agent_id, status, team_key").eq("machine_id", m.id).eq("workspace_id", m.workspace_id);
  const assigned = (rows ?? []) as Array<MachineRow & { scope: string }>;
  const teamIds = assigned.map((r) => r.team_id);
  const none = ["-"];
  const { data: auditRows } = await admin.from("team_machine_audit")
    .select("id, team_id, agent_id, user_id, action, folder_id, detail, created_at")
    .in("team_id", teamIds.length ? teamIds : none).gte("created_at", since ?? "1970-01-01").order("created_at", { ascending: false }).limit(200);

  const cfg = await fleetConfig(admin, m).catch(() => null);
  let info: Record<string, unknown> | null = null;
  let live: Record<string, unknown> | null = null;
  let error: string | null = null;
  if (!cfg) {
    error = "machine non configurée";
  } else if (m.status !== "active") {
    error = "machine en pause";
  } else {
    try {
      const [i, a] = await Promise.all([
        callMachine<Record<string, unknown>>(cfg, "machine.info", {}, 15_000),
        callMachine<Record<string, unknown>>(cfg, "activity", { teams: teamIds, ...(since ? { since } : {}) }, 25_000),
      ]);
      info = i;
      live = a;
      await admin.from("machines").update({ info: i, last_seen_at: new Date().toISOString(), last_error: null }).eq("id", m.id);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      await admin.from("machines").update({ last_error: error }).eq("id", m.id);
    }
  }
  return {
    reachable: !!live, error, info,
    processes: (live?.processes ?? []) as unknown[],
    jobs: (live?.jobs ?? []) as unknown[],
    execs: (live?.execs ?? []) as unknown[],
    events: (live?.events ?? []) as unknown[],
    listeners: (live?.listeners ?? []) as unknown[],
    browsers: (live?.browsers ?? []) as unknown[],
    teams: assigned.map((r) => ({ team_id: r.team_id, scope: r.scope, agent_id: r.agent_id, status: r.status, dashboard_id: r.dashboard_id })),
    audit: auditRows ?? [],
  };
}
