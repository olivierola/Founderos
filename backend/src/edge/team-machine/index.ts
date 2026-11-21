// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/team-machine/index.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.
import { defineHandler } from "../../compat/index.ts";

// team-machine — la machine d'équipe (0296), côté humains.
//
// Appelée par une PERSONNE (son JWT), depuis le panneau Machine d'une équipe :
//
//   { action: "status",         dashboard_id }                         membre
//   { action: "enable",         dashboard_id, team_id, allow_system_packages? }   admin
//   { action: "pause",          team_id }                              admin
//   { action: "settings",       team_id, allow_system_packages?, url? } admin
//   { action: "folder_create",  team_id, name, purpose?, member_ids, owner_id? } membre
//   { action: "folder_members", folder_id, add?, remove? }             membre
//   { action: "folder_rotate",  folder_id }                            membre
//   { action: "folder_archive", folder_id }                            admin
//   { action: "agent_reset",    team_id, agent_id }                    admin
//
// Le workspace est toujours déduit de la ressource (tableau, machine, dossier),
// jamais du corps de la requête. Aucune réponse ne contient de secret.

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { requireWorkspaceMember, type WorkspaceRole } from "../_shared/authz.ts";
import { assertSafeUrl } from "../_shared/ssrf.ts";
import {
  archiveFolder, callMachine, changeFolderMembers, createFolder, enableTeamMachine, loadFolder, loadTeamMachine,
  configFor, MachineError, machineConfig, pauseTeamMachine, readTeams, resetAgentSecret, rotateFolderSecret, type MachineRow,
} from "../_shared/team-machine.ts";

type Body = Record<string, unknown> & { action?: string };

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export default defineHandler(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  let body: Body;
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: "invalid JSON body" }, { status: 400 }); }
  const admin = createServiceClient();

  const guard = async (workspaceId: string, role: WorkspaceRole) => requireWorkspaceMember(req, workspaceId, role);

  try {
    switch (body.action) {
      case "status": {
        const { data: board } = await admin.from("service_dashboards").select("id, workspace_id, settings").eq("id", String(body.dashboard_id ?? "")).maybeSingle();
        if (!board) return jsonResponse({ ok: false, error: "tableau introuvable" }, { status: 404 });
        const auth = await guard((board as { workspace_id: string }).workspace_id, "viewer");
        if (!auth.ok) return auth.response;
        return jsonResponse({ ok: true, ...(await status(admin, board as { id: string; settings: unknown })) });
      }

      case "enable": {
        const { data: board } = await admin.from("service_dashboards").select("id, workspace_id, settings").eq("id", String(body.dashboard_id ?? "")).maybeSingle();
        if (!board) return jsonResponse({ ok: false, error: "tableau introuvable" }, { status: 404 });
        const b = board as { id: string; workspace_id: string; settings: unknown };
        const auth = await guard(b.workspace_id, "admin");
        if (!auth.ok) return auth.response;
        const team = readTeams(b.settings).find((t) => t.id === String(body.team_id ?? ""));
        if (!team) return jsonResponse({ ok: false, error: "équipe introuvable dans ce service" }, { status: 404 });
        const row = await enableTeamMachine(admin, {
          dashboardId: b.id, workspaceId: b.workspace_id, team, userId: auth.userId,
          allowSystemPackages: body.allow_system_packages === true,
        });
        return jsonResponse({ ok: true, machine: publicMachine(row) });
      }

      case "pause":
      case "settings":
      case "folder_create":
      case "agent_reset": {
        const loaded = await loadTeamMachine(admin, String(body.team_id ?? ""));
        if (!loaded) return jsonResponse({ ok: false, error: "cette équipe n'a pas de machine" }, { status: 404 });
        const { machine, team } = loaded;
        const auth = await guard(machine.workspace_id, body.action === "folder_create" ? "member" : "admin");
        if (!auth.ok) return auth.response;

        if (body.action === "pause") {
          return jsonResponse({ ok: true, ...(await pauseTeamMachine(admin, machine, auth.userId)) });
        }
        if (body.action === "settings") {
          const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
          if (typeof body.allow_system_packages === "boolean") patch.allow_system_packages = body.allow_system_packages;
          if (body.url !== undefined) {
            const url = String(body.url ?? "").trim();
            if (url) {
              const verdict = await assertSafeUrl(url);
              if (!verdict.ok) return jsonResponse({ ok: false, error: `URL refusée : ${verdict.reason ?? "adresse interne"}` }, { status: 400 });
            }
            patch.url = url || null;
          }
          const { error } = await admin.from("team_machines").update(patch).eq("team_id", machine.team_id);
          if (error) throw new Error(error.message);
          return jsonResponse({ ok: true });
        }
        if (body.action === "folder_create") {
          if (machine.status !== "active") return jsonResponse({ ok: false, error: "la machine de l'équipe est en pause" }, { status: 409 });
          const memberIds = ids(body.member_ids);
          const owner = typeof body.owner_id === "string" && memberIds.includes(body.owner_id) ? body.owner_id : null;
          const f = await createFolder(admin, {
            machine, team, name: String(body.name ?? ""), purpose: typeof body.purpose === "string" ? body.purpose : null,
            memberIds, ownerAgentId: owner, actor: { userId: auth.userId },
          });
          return jsonResponse({ ok: true, folder: f });
        }
        // agent_reset
        const agentId = String(body.agent_id ?? "");
        if (!team.agent_ids.includes(agentId)) return jsonResponse({ ok: false, error: "cet agent n'est pas dans l'équipe" }, { status: 400 });
        await resetAgentSecret(admin, { machine, team, agentId, userId: auth.userId });
        return jsonResponse({ ok: true });
      }

      case "folder_members":
      case "folder_rotate":
      case "folder_archive": {
        const folder = await loadFolder(admin, String(body.folder_id ?? ""));
        if (!folder) return jsonResponse({ ok: false, error: "dossier introuvable" }, { status: 404 });
        const auth = await guard(folder.workspace_id, body.action === "folder_archive" ? "admin" : "member");
        if (!auth.ok) return auth.response;
        const loaded = await loadTeamMachine(admin, folder.team_id);
        if (!loaded) return jsonResponse({ ok: false, error: "machine introuvable" }, { status: 404 });
        const { machine, team } = loaded;
        if (body.action === "folder_members") {
          const r = await changeFolderMembers(admin, { folder, team, machine, add: ids(body.add), remove: ids(body.remove), actor: { userId: auth.userId } });
          return jsonResponse({ ok: true, ...r });
        }
        if (body.action === "folder_rotate") {
          await rotateFolderSecret(admin, { folder, team, machine, actor: { userId: auth.userId } });
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ ok: true, ...(await archiveFolder(admin, { folder, machine, userId: auth.userId })) });
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

/** Ce qu'un humain voit d'une machine : jamais de secret, l'URL seulement si elle est propre à l'équipe. */
function publicMachine(m: MachineRow & { last_seen_at?: unknown; last_error?: unknown }) {
  return {
    team_id: m.team_id, team_key: m.team_key, status: m.status, allow_system_packages: m.allow_system_packages,
    url: m.url, machine_path: m.machine_path, last_seen_at: m.last_seen_at ?? null, last_error: m.last_error ?? null,
  };
}

// deno-lint-ignore no-explicit-any
async function status(admin: any, board: { id: string; settings: unknown }) {
  const teams = readTeams(board.settings);
  const { data: machines } = await admin.from("team_machines").select("*").eq("dashboard_id", board.id);
  const rows = (machines ?? []) as Array<MachineRow & Record<string, unknown>>;
  const teamIds = rows.map((m) => m.team_id);
  const none = ["-"];
  const [{ data: agents }, { data: folders }, { data: auditRows }] = await Promise.all([
    admin.from("team_machine_agents").select("team_id, agent_id, unix_user, home_path, last_used_at").in("team_id", teamIds.length ? teamIds : none),
    admin.from("team_machine_folders").select("id, team_id, name, path, purpose, status, created_by_agent, created_by_user, secret_rotated_at, created_at")
      .in("team_id", teamIds.length ? teamIds : none).eq("status", "active").order("created_at"),
    admin.from("team_machine_audit").select("id, team_id, agent_id, user_id, action, folder_id, detail, created_at")
      .in("team_id", teamIds.length ? teamIds : none).order("created_at", { ascending: false }).limit(60),
  ]);
  const folderList = (folders ?? []) as Array<{ id: string; team_id: string }>;
  const { data: members } = await admin.from("team_machine_folder_members").select("folder_id, agent_id, role, added_at")
    .in("folder_id", folderList.length ? folderList.map((f) => f.id) : ["00000000-0000-0000-0000-000000000000"]);

  // L'état vivant, si les machines répondent : usage disque, processus de fond.
  // Depuis 0304 chaque équipe peut être sur sa machine : on interroge chacune
  // pour les seules équipes qu'elle porte.
  let live: { reachable: boolean; error?: string; teams?: Array<Record<string, unknown>>; apt?: boolean } = { reachable: false };
  const cfg = await machineConfig(admin).catch(() => null);
  if (teamIds.length) {
    const groups = new Map<string, { cfg: Awaited<ReturnType<typeof configFor>>; teams: string[] }>();
    for (const r of rows) {
      const key = r.machine_id ?? `url:${r.url ?? ""}`;
      if (!groups.has(key)) groups.set(key, { cfg: await configFor(admin, r).catch(() => null), teams: [] });
      groups.get(key)!.teams.push(r.team_id);
    }
    const teamsLive: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    let apt = false;
    for (const g of groups.values()) {
      if (!g.cfg) continue;
      try {
        const r = await callMachine<{ teams: Array<Record<string, unknown>>; apt: boolean }>(g.cfg, "status", { teams: g.teams, usage: true }, 20_000);
        teamsLive.push(...r.teams);
        apt = apt || r.apt;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    live = teamsLive.length || !errors.length
      ? { reachable: teamsLive.length > 0 || groups.size === 0, teams: teamsLive, apt, ...(errors.length ? { error: errors[0] } : {}) }
      : { reachable: false, error: errors[0] };
  } else if (cfg) {
    try {
      const r = await callMachine<{ apt: boolean }>(cfg, "status", { teams: [] }, 10_000);
      live = { reachable: true, teams: [], apt: r.apt };
    } catch (e) {
      live = { reachable: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    configured: !!cfg,
    live,
    teams: teams.map((t) => {
      const m = rows.find((r) => r.team_id === t.id) ?? null;
      return {
        team_id: t.id,
        machine: m ? publicMachine(m) : null,
        agents: ((agents ?? []) as Array<{ team_id: string }>).filter((a) => a.team_id === t.id),
        folders: folderList.filter((f) => f.team_id === t.id).map((f) => ({
          ...f, members: ((members ?? []) as Array<{ folder_id: string }>).filter((x) => x.folder_id === f.id),
        })),
        audit: ((auditRows ?? []) as Array<{ team_id: string }>).filter((a) => a.team_id === t.id).slice(0, 30),
        live: live.teams?.find((x) => x.id === t.id) ?? null,
      };
    }),
  };
}
