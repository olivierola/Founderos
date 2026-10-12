// installation-admin — Administration → Installation (G4, migration 0283).
//
// Body : { action: "status" }                         réglages effectifs, secrets présents, qui administre
//        { action: "claim", workspace_id }            instance neuve : revendiquer l'installation
//        { action: "save", values: { CLÉ: valeur } }   réglages sans secret (vide : retiré)
//        { action: "diagnose", workspace_id }         teste chaque brique, nomme la cause d'une panne
//
// Fonction native du backend Express (dossier backend/) : les réglages
// s'appliquent à ce processus (compat/index.ts), et le diagnostic lit son port
// de gestion. Pas d'équivalent dans supabase/functions.
//
// Qui administre (shared/installation.ts) : une adresse de INSTALLATION_ADMINS,
// ou un owner ou admin de l'organisation propriétaire de l'installation.

import type { Request, Response } from "express";
import { env as backendEnv } from "../env.ts";
import { Deno } from "../compat/index.ts";
import { configuredSsoMode, effectiveSsoMode } from "../edge/_shared/sso-domains.ts";
import { requireUser } from "../shared/authz.ts";
import { HttpError } from "../shared/http.ts";
import { createServiceClient } from "../shared/supabase.ts";
import {
  applyInstallationOverlay, applySettingChanges, effectiveSettings, loadInstallationSettings, resolveInstallationAdmin,
  secretsPresence, SettingsError,
} from "../shared/installation.ts";
import { runChecks } from "../shared/installation-checks.ts";

export async function installationAdmin(req: Request, res: Response): Promise<void> {
  const userId = await requireUser(req);
  const admin = createServiceClient();
  const action = String(req.body?.action ?? "");

  let loaded: Awaited<ReturnType<typeof loadInstallationSettings>>;
  try {
    loaded = await loadInstallationSettings(admin);
  } catch (e) {
    throw new HttpError(503, `Réglages d'installation illisibles (migration 0283 appliquée ?) : ${e instanceof Error ? e.message : String(e)}`);
  }
  const [{ data: home }, { data: user }, { data: members }, { count: workspaceCount }] = await Promise.all([
    admin.from("enterprise_sso_settings").select("home_workspace_id").maybeSingle(),
    admin.auth.admin.getUserById(userId),
    admin.from("workspace_members").select("workspace_id, role").eq("user_id", userId),
    admin.from("workspaces").select("id", { count: "exact", head: true }),
  ]);
  const roles = Object.fromEntries(((members ?? []) as Array<{ workspace_id: string; role: string }>).map((m) => [m.workspace_id, m.role]));
  const homeWorkspaceId = (home as { home_workspace_id?: string } | null)?.home_workspace_id ?? null;
  const who = resolveInstallationAdmin({
    email: user?.user?.email ?? null,
    adminsEnv: process.env.INSTALLATION_ADMINS,
    ownerWorkspaceId: loaded.ownerWorkspaceId,
    homeWorkspaceId,
    roles,
    workspaceCount: workspaceCount ?? 0,
  });
  const ssoMode = effectiveSsoMode(configuredSsoMode((k) => Deno.env.get(k)), !!homeWorkspaceId);

  const status = async () => {
    const base = { is_admin: who.isAdmin, can_claim: who.canClaim, via: who.via, owner_workspace_id: loaded.ownerWorkspaceId ?? homeWorkspaceId };
    if (!who.isAdmin) return base;
    const { data: history } = await admin.from("installation_settings_history")
      .select("key, old_value, new_value, changed_by, changed_at").order("changed_at", { ascending: false }).limit(20);
    return {
      ...base,
      settings: effectiveSettings(loaded.settings, process.env),
      secrets: secretsPresence(process.env),
      runtime: {
        functions_url: backendEnv.functionsUrl, mgmt_port: backendEnv.mgmtPort, sso_mode: ssoMode,
        gateway_mode: backendEnv.gatewayMode,
      },
      history: history ?? [],
    };
  };

  if (action === "status") {
    res.json({ ok: true, ...(await status()) });
    return;
  }

  if (action === "claim") {
    const workspaceId = String(req.body?.workspace_id ?? "");
    if (!who.canClaim || roles[workspaceId] !== "owner") {
      throw new HttpError(403, "Revendication impossible : l'installation a déjà des administrateurs, ou elle compte plusieurs organisations (renseignez alors INSTALLATION_ADMINS).");
    }
    const { error } = await admin.from("installation_settings")
      .upsert({ id: true, owner_workspace_id: workspaceId, settings: loaded.settings, updated_by: userId, updated_at: new Date().toISOString() });
    if (error) throw new HttpError(500, error.message);
    loaded = { ...loaded, ownerWorkspaceId: workspaceId };
    Object.assign(who, { isAdmin: true, canClaim: false, via: "organisation propriétaire" });
    res.json({ ok: true, ...(await status()) });
    return;
  }

  if (!who.isAdmin) throw new HttpError(403, "Réservé aux administrateurs de l'installation.");

  if (action === "save") {
    const values = req.body?.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new HttpError(400, "values : un objet { CLÉ: valeur } est attendu.");
    let next: Record<string, string>;
    let changed: Array<{ key: string; old: string | null; value: string | null }>;
    try {
      ({ next, changed } = applySettingChanges(loaded.settings, values as Record<string, unknown>, process.env));
    } catch (e) {
      if (e instanceof SettingsError) throw new HttpError(400, e.message);
      throw e;
    }
    if (changed.length) {
      const { error } = await admin.from("installation_settings").upsert({
        id: true, owner_workspace_id: loaded.ownerWorkspaceId, settings: next, updated_by: userId, updated_at: new Date().toISOString(),
      });
      if (error) throw new HttpError(500, error.message);
      await admin.from("installation_settings_history").insert(changed.map((c) => ({
        key: c.key, old_value: c.old, new_value: c.value, changed_by: userId,
      })));
      // Ce processus applique aussitôt ; les autres réplicas, en moins d'une minute.
      applyInstallationOverlay(next);
      loaded = { ...loaded, settings: next };
    }
    res.json({ ok: true, changed: changed.map((c) => c.key), ...(await status()) });
    return;
  }

  if (action === "diagnose") {
    const workspaceId = String(req.body?.workspace_id ?? "");
    if (!roles[workspaceId]) throw new HttpError(403, "workspace_id : une organisation dont vous êtes membre.");
    const checks = await runChecks({
      admin,
      env: (k) => Deno.env.get(k),
      fetch,
      functionsUrl: backendEnv.functionsUrl,
      mgmtPort: backendEnv.mgmtPort,
      authHeader: req.get("Authorization") ?? "",
      workspaceId,
    }, ssoMode);
    res.json({ ok: true, checks, at: new Date().toISOString() });
    return;
  }

  throw new HttpError(400, `Action inconnue : ${action}`);
}
