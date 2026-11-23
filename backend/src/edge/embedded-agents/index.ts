import { defineHandler } from "../../compat/index.ts";

// embedded-agents — les agents embarqués d'un service (0316, docs/harness-opencode/05).
//
//   { action: "list",          dashboard_id }                         lecteur
//   { action: "create",        dashboard_id, name, persona?, instructions? }   admin
//   { action: "update_config", agent_id, ...réglages }                admin
//   { action: "export",        agent_id }   → une version : manifeste figé + archive du conteneur (base64)
//   { action: "create_key",    agent_id, label? } → la clé, montrée UNE fois    admin
//   { action: "revoke_key",    key_id }                                admin
//   { action: "command",       agent_id, command, instance_id? }       membre (pause, resume, reload, stop)
//   { action: "run_local",     agent_id, instance_name? }  construit et lance le conteneur sur ce Docker   admin
//   { action: "stop_local",    instance_id, volumes? }                 admin
//
// L'agent lui-même (consignes, pools, skills, modèles) se règle sur sa fiche,
// comme un collaborateur : un agent embarqué EST un agent FounderOS, seul
// l'endroit où il tourne change (internal_agents.deployment = 'embedded').

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { requireWorkspaceMember, type WorkspaceRole } from "../_shared/authz.ts";
import { env } from "../../env.ts";
import { makeBundle, imageTag, slugOf } from "../../embedded/bundle.ts";
import { newKey } from "../../embedded/keys.ts";
import { compileManifest, CONFIG_COLUMNS, type EmbeddedConfig } from "../../embedded/manifest.ts";
import { snapshotFor, toJsonl } from "../../embedded/knowledge.ts";
import { embeddedDocker } from "../../platform/embedded-docker.ts";

type Body = Record<string, unknown> & { action?: string };
const str = (v: unknown, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown, max = 50) => (Array.isArray(v) ? v.map((x) => str(x, 200)).filter(Boolean).slice(0, max) : []);

/** L'adresse de FounderOS telle qu'un conteneur la joint (sur cet hôte : par host.docker.internal). */
const founderosUrl = (local = false) => {
  const url = (process.env.EMBEDDED_PUBLIC_URL || process.env.PUBLIC_URL || env.functionsUrl).replace(/\/+$/, "");
  return local ? url.replace(/\/\/(localhost|127\.0\.0\.1)(?=[:/]|$)/, "//host.docker.internal") : url;
};

export default defineHandler(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  let body: Body;
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: "corps JSON invalide" }, { status: 400 }); }
  // deno-lint-ignore no-explicit-any
  const admin: any = createServiceClient();
  const guard = (workspaceId: string, role: WorkspaceRole) => requireWorkspaceMember(req, workspaceId, role);

  const loadAgent = async (agentId: string) => {
    const { data } = await admin.from("internal_agents")
      .select("id, name, workspace_id, project_id, service_dashboard_id, deployment").eq("id", agentId).maybeSingle();
    const a = data as { id: string; name: string; workspace_id: string; project_id: string; service_dashboard_id: string | null; deployment: string } | null;
    return a && a.deployment === "embedded" ? a : null;
  };
  const nextVersion = async (agentId: string) => {
    const { data } = await admin.from("embedded_agent_builds").select("version").eq("agent_id", agentId).order("version", { ascending: false }).limit(1).maybeSingle();
    return (Number((data as { version?: number } | null)?.version) || 0) + 1;
  };
  /** Une version : le manifeste figé, enregistré, et l'archive du conteneur. */
  const exportVersion = async (agentId: string, userId: string | null) => {
    const { manifest, sha, config } = await compileManifest(admin, agentId);
    const version = await nextVersion(agentId);
    // La connaissance embarquée : ce que l'agent peut lire, figé dans l'image.
    const snap = config.knowledge_snapshot ? await snapshotFor(admin, manifest) : null;
    const { data: build, error } = await admin.from("embedded_agent_builds").insert({
      agent_id: agentId, workspace_id: config.workspace_id, version, manifest, manifest_sha: sha, status: "exported",
      image_ref: imageTag(manifest, version), created_by: userId,
      log: snap ? `connaissance embarquée : ${snap.rows.length} passages${snap.truncated ? " (tronquée à la limite)" : ""}` : null,
    }).select("id, version, manifest_sha, status, image_ref, created_at").single();
    if (error) throw new Error(error.message);
    const bundle = await makeBundle({ manifest, sha, version, config, founderosUrl: founderosUrl(), knowledge: snap ? toJsonl(snap.rows) : "" });
    return { build, bundle, manifest, config, version, filename: `${slugOf(manifest.agent.name)}-v${version}.zip` };
  };

  try {
    switch (body.action) {
      case "list": {
        const { data: board } = await admin.from("service_dashboards").select("id, workspace_id").eq("id", str(body.dashboard_id)).maybeSingle();
        if (!board) return jsonResponse({ ok: false, error: "tableau introuvable" }, { status: 404 });
        const auth = await guard(board.workspace_id, "viewer");
        if (!auth.ok) return auth.response;
        const { data: agents } = await admin.from("internal_agents")
          .select("id, name, persona, avatar_url, avatar_style, accent_color, created_at, is_archived")
          .eq("service_dashboard_id", board.id).eq("deployment", "embedded").eq("is_archived", false).order("created_at");
        const ids = ((agents ?? []) as Array<{ id: string }>).map((a) => a.id);
        const none = ids.length ? ids : ["00000000-0000-0000-0000-000000000000"];
        const [configs, builds, instances, keys] = await Promise.all([
          admin.from("embedded_agent_configs").select(CONFIG_COLUMNS).in("agent_id", none),
          admin.from("embedded_agent_builds").select("id, agent_id, version, manifest_sha, status, image_ref, log, created_at").in("agent_id", none).order("version", { ascending: false }).limit(200),
          admin.from("embedded_agent_instances").select("id, agent_id, name, status, container_ref, manifest_sha, version, info, last_seen_at, created_at").in("agent_id", none).order("created_at"),
          admin.from("embedded_agent_api_keys").select("id, agent_id, label, prefix, created_at, last_used_at, revoked_at").in("agent_id", none).order("created_at", { ascending: false }),
        ]);
        const docker = embeddedDocker();
        return jsonResponse({
          ok: true,
          agents: agents ?? [], configs: configs.data ?? [], builds: builds.data ?? [], instances: instances.data ?? [], keys: keys.data ?? [],
          local: docker ? await docker.check() : { ok: false, reason: "La construction locale n'est disponible qu'en plateforme auto-hébergée : téléchargez l'archive et lancez-la ailleurs." },
          founderos_url: founderosUrl(),
        });
      }

      case "create": {
        const { data: board } = await admin.from("service_dashboards").select("id, workspace_id, project_id").eq("id", str(body.dashboard_id)).maybeSingle();
        if (!board) return jsonResponse({ ok: false, error: "tableau introuvable" }, { status: 404 });
        const auth = await guard(board.workspace_id, "admin");
        if (!auth.ok) return auth.response;
        const name = str(body.name, 80);
        if (!name) return jsonResponse({ ok: false, error: "donnez un nom à l'agent" }, { status: 400 });
        const { data: agent, error } = await admin.from("internal_agents").insert({
          workspace_id: board.workspace_id, project_id: board.project_id, service_dashboard_id: board.id,
          name, persona: str(body.persona, 400) || null, instructions: str(body.instructions, 20_000) || null,
          deployment: "embedded", created_by: auth.userId, chat_enabled: true, mission_enabled: true,
        }).select("id, name").single();
        if (error) throw new Error(error.message);
        const { error: cfgErr } = await admin.from("embedded_agent_configs").insert({
          agent_id: agent.id, workspace_id: board.workspace_id, project_id: board.project_id, service_dashboard_id: board.id,
        });
        if (cfgErr) throw new Error(cfgErr.message);
        return jsonResponse({ ok: true, agent });
      }

      case "update_config": {
        const agent = await loadAgent(str(body.agent_id));
        if (!agent) return jsonResponse({ ok: false, error: "agent embarqué introuvable" }, { status: 404 });
        const auth = await guard(agent.workspace_id, "admin");
        if (!auth.ok) return auth.response;
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        const pick = <K extends keyof EmbeddedConfig>(k: K, ok: (v: unknown) => boolean, conv: (v: unknown) => EmbeddedConfig[K]) => {
          if (body[k] !== undefined && ok(body[k])) patch[k] = conv(body[k]);
        };
        pick("connectivity", (v) => ["connected", "intermittent", "isolated"].includes(String(v)), (v) => String(v) as never);
        pick("llm_route", (v) => ["founderos", "direct"].includes(String(v)), (v) => String(v) as never);
        pick("llm_base_url", (v) => v === null || /^https?:\/\//i.test(String(v)), (v) => (v === null ? null : str(v, 300)) as never);
        pick("llm_model", () => true, (v) => (str(v, 200) || null) as never);
        pick("sync_level", (v) => ["full", "summary", "metadata"].includes(String(v)), (v) => String(v) as never);
        pick("knowledge_snapshot", (v) => typeof v === "boolean", (v) => v as never);
        pick("shell_enabled", (v) => typeof v === "boolean", (v) => v as never);
        pick("cpus", (v) => Number(v) > 0 && Number(v) <= 64, (v) => Number(v) as never);
        pick("memory_mb", (v) => Number(v) >= 256 && Number(v) <= 262144, (v) => Math.round(Number(v)) as never);
        pick("disk_mb", (v) => Number(v) >= 512 && Number(v) <= 1048576, (v) => Math.round(Number(v)) as never);
        pick("egress", Array.isArray, (v) => list(v) as never);
        pick("apt_packages", Array.isArray, (v) => list(v) as never);
        pick("pip_packages", Array.isArray, (v) => list(v) as never);
        pick("npm_packages", Array.isArray, (v) => list(v) as never);
        pick("runtime_version", (v) => /^[0-9a-z.-]{1,20}$/i.test(String(v)), (v) => String(v) as never);
        if (Array.isArray(body.seed_files)) {
          patch.seed_files = (body.seed_files as Array<Record<string, unknown>>).slice(0, 50)
            .map((f) => ({ path: str(f?.path, 200), content: typeof f?.content === "string" ? f.content.slice(0, 200_000) : "" }))
            .filter((f) => f.path);
        }
        const { error } = await admin.from("embedded_agent_configs").update(patch).eq("agent_id", agent.id);
        if (error) throw new Error(error.message);
        return jsonResponse({ ok: true });
      }

      case "export": {
        const agent = await loadAgent(str(body.agent_id));
        if (!agent) return jsonResponse({ ok: false, error: "agent embarqué introuvable" }, { status: 404 });
        const auth = await guard(agent.workspace_id, "admin");
        if (!auth.ok) return auth.response;
        const out = await exportVersion(agent.id, auth.userId);
        return jsonResponse({ ok: true, build: out.build, filename: out.filename, zip_base64: Buffer.from(out.bundle).toString("base64") });
      }

      case "create_key": {
        const agent = await loadAgent(str(body.agent_id));
        if (!agent) return jsonResponse({ ok: false, error: "agent embarqué introuvable" }, { status: 404 });
        const auth = await guard(agent.workspace_id, "admin");
        if (!auth.ok) return auth.response;
        const k = newKey();
        const { data, error } = await admin.from("embedded_agent_api_keys").insert({
          agent_id: agent.id, workspace_id: agent.workspace_id, label: str(body.label, 80) || "clé", prefix: k.prefix, key_hash: k.hash, created_by: auth.userId,
        }).select("id, label, prefix, created_at").single();
        if (error) throw new Error(error.message);
        return jsonResponse({ ok: true, key: k.key, row: data });
      }

      case "revoke_key": {
        const { data: row } = await admin.from("embedded_agent_api_keys").select("id, workspace_id").eq("id", str(body.key_id)).maybeSingle();
        if (!row) return jsonResponse({ ok: false, error: "clé introuvable" }, { status: 404 });
        const auth = await guard(row.workspace_id, "admin");
        if (!auth.ok) return auth.response;
        await admin.from("embedded_agent_api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", row.id);
        return jsonResponse({ ok: true });
      }

      case "command": {
        const agent = await loadAgent(str(body.agent_id));
        if (!agent) return jsonResponse({ ok: false, error: "agent embarqué introuvable" }, { status: 404 });
        const auth = await guard(agent.workspace_id, "member");
        if (!auth.ok) return auth.response;
        const command = str(body.command);
        if (!["pause", "resume", "reload", "stop"].includes(command)) return jsonResponse({ ok: false, error: "ordre inconnu" }, { status: 400 });
        await admin.from("embedded_agent_commands").insert({
          agent_id: agent.id, instance_id: str(body.instance_id) || null, command, created_by: auth.userId,
        });
        if (command === "stop" && str(body.instance_id)) {
          await admin.from("embedded_agent_instances").update({ status: "stopped" }).eq("id", str(body.instance_id)).eq("agent_id", agent.id);
        }
        return jsonResponse({ ok: true });
      }

      case "run_local": {
        const agent = await loadAgent(str(body.agent_id));
        if (!agent) return jsonResponse({ ok: false, error: "agent embarqué introuvable" }, { status: 404 });
        const auth = await guard(agent.workspace_id, "admin");
        if (!auth.ok) return auth.response;
        const docker = embeddedDocker();
        if (!docker) return jsonResponse({ ok: false, error: "construction locale indisponible ici : téléchargez l'archive" }, { status: 501 });
        const ready = await docker.check();
        if (!ready.ok) return jsonResponse({ ok: false, error: ready.reason }, { status: 503 });
        const instanceName = (str(body.instance_name, 40) || "local").replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
        const out = await exportVersion(agent.id, auth.userId);
        const buildId = (out.build as { id: string }).id;
        await admin.from("embedded_agent_builds").update({ status: "building" }).eq("id", buildId);
        // En arrière-plan : une image se construit en minutes ; l'onglet suit la version.
        void (async () => {
          try {
            const log = await docker.build({ bundle: out.bundle, tag: imageTag(out.manifest, out.version), runtimeVersion: out.config.runtime_version });
            const k = newKey();
            await admin.from("embedded_agent_api_keys").insert({
              agent_id: agent.id, workspace_id: agent.workspace_id, label: `local:${instanceName}`, prefix: k.prefix, key_hash: k.hash, created_by: auth.userId,
            });
            const container = await docker.run({
              agentId: agent.id, tag: imageTag(out.manifest, out.version), apiKey: k.key, instanceName,
              founderosUrl: founderosUrl(true), cpus: out.config.cpus, memoryMb: out.config.memory_mb,
            });
            await admin.from("embedded_agent_instances").upsert({
              agent_id: agent.id, workspace_id: agent.workspace_id, name: instanceName, status: "online", build_id: buildId,
              container_ref: container, version: out.version,
            }, { onConflict: "agent_id,name" });
            await admin.from("embedded_agent_builds").update({ status: "built", log: log.slice(-8000) }).eq("id", buildId);
          } catch (e) {
            await admin.from("embedded_agent_builds").update({ status: "failed", log: `échec : ${e instanceof Error ? e.message : String(e)}`.slice(0, 8000) }).eq("id", buildId);
          }
        })();
        return jsonResponse({ ok: true, build: out.build });
      }

      case "stop_local": {
        const { data: inst } = await admin.from("embedded_agent_instances").select("id, agent_id, workspace_id, container_ref").eq("id", str(body.instance_id)).maybeSingle();
        if (!inst) return jsonResponse({ ok: false, error: "instance introuvable" }, { status: 404 });
        const auth = await guard(inst.workspace_id, "admin");
        if (!auth.ok) return auth.response;
        const docker = embeddedDocker();
        if (docker && inst.container_ref) await docker.remove({ name: inst.container_ref, volumes: body.volumes === true });
        await admin.from("embedded_agent_instances").update({ status: "stopped" }).eq("id", inst.id);
        return jsonResponse({ ok: true });
      }

      default:
        return jsonResponse({ ok: false, error: `action inconnue : ${String(body.action ?? "")}` }, { status: 400 });
    }
  } catch (e) {
    return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
});
