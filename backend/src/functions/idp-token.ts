// idp-token — le jeton de la personne connectée auprès de l'IdP de l'entreprise,
// conservé côté serveur pour les appels d'outils faits en son nom
// (docs/openshift-implementation.md D2, généralisé par docs/enterprise-generalisation.md G1).
//
// Body : { action: "store", refresh_token, provider }  au retour du SSO (src/lib/auth-context.tsx)
//        { action: "status", provider? }                 y a-t-il une session SSO conservée ?
//        { action: "revoke", provider? }                 à la déconnexion
//
// `provider` : le fournisseur de la connexion (« custom:keycloak »). Il doit
// déléguer aux agents (Administration → Authentification), sinon il n'y a rien
// à conserver et la fonction le dit sans erreur.
//
// Fonction native du backend : elle n'existe que sur l'installation dédiée, et
// ne compte pas parmi les edge functions de l'instance SaaS.

import type { Request, Response } from "express";
import { resolveIdpConfig, supabaseIdpDirectory } from "../edge/_shared/idp-directory.ts";
import {
  IdpError, revokeUserRefreshToken, storeUserRefreshToken, supabaseIdpTokenStore, type IdpConfig,
} from "../edge/_shared/idp-tokens.ts";
import { requireUser } from "../shared/authz.ts";
import { HttpError } from "../shared/http.ts";
import { createServiceClient } from "../shared/supabase.ts";

const PROVIDER_RE = /^custom:[a-z0-9][a-z0-9-]{0,40}$/;

export async function idpToken(req: Request, res: Response): Promise<void> {
  const userId = await requireUser(req);
  const admin = createServiceClient();
  const store = supabaseIdpTokenStore(admin);
  const action = String(req.body?.action ?? "");
  const rawProvider = req.body?.provider;
  if (rawProvider !== undefined && rawProvider !== null && (typeof rawProvider !== "string" || !PROVIDER_RE.test(rawProvider))) {
    throw new HttpError(400, "provider invalide");
  }

  let cfg: IdpConfig | null;
  try {
    cfg = await resolveIdpConfig(supabaseIdpDirectory(admin), rawProvider ?? null);
  } catch (err) {
    if (err instanceof IdpError) throw new HttpError(400, err.message, { extra: { code: err.code } });
    throw err;
  }
  if (!cfg) {
    // Fournisseur qui ne délègue pas, ou aucun : rien à conserver.
    res.json({ ok: true, stored: false, reason: "not_delegating" });
    return;
  }

  if (action === "status") {
    const row = await store.get(userId, cfg.provider);
    res.json({ ok: true, provider: cfg.provider, stored: !!row });
    return;
  }

  if (action === "revoke") {
    await revokeUserRefreshToken(cfg, store, userId);
    res.json({ ok: true });
    return;
  }

  if (action === "store") {
    const refreshToken = String(req.body?.refresh_token ?? "");
    if (!refreshToken || refreshToken.length > 8192) throw new HttpError(400, "refresh_token requis");

    // La personne attendue vient de l'identité que Supabase Auth a enregistrée
    // pour CET utilisateur au retour du SSO — jamais de la requête.
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data?.user) throw new HttpError(404, "Utilisateur introuvable");
    const identity = (data.user.identities ?? []).find((i) => i.provider === cfg.provider);
    const expectedSubject = expectedSubjectOf(cfg, identity);
    if (!expectedSubject) {
      throw new HttpError(403, `Cette personne ne s'est pas connectée par ${cfg.provider}.`);
    }

    try {
      const out = await storeUserRefreshToken(cfg, store, userId, refreshToken, expectedSubject);
      res.json({ ok: true, ...out });
    } catch (err) {
      if (err instanceof IdpError) {
        const status = err.code === "subject_mismatch" ? 403 : err.code === "invalid_grant" ? 400 : 502;
        throw new HttpError(status, err.message, { extra: { code: err.code } });
      }
      throw err;
    }
    return;
  }

  throw new HttpError(400, `Action inconnue : ${action || "(vide)"}`);
}

/**
 * La personne de l'IdP selon l'identité enregistrée par Supabase Auth : le
 * claim `subjectClaim` (`sub`, ou `oid` chez Entra ID), au premier niveau des
 * données d'identité ou sous `custom_claims`.
 */
export function expectedSubjectOf(
  cfg: Pick<IdpConfig, "subjectClaim">,
  identity: { id?: string; identity_data?: Record<string, unknown> | null } | undefined,
): string {
  if (!identity) return "";
  const data = (identity.identity_data ?? {}) as Record<string, unknown>;
  const custom = (data.custom_claims ?? {}) as Record<string, unknown>;
  const v = data[cfg.subjectClaim] ?? custom[cfg.subjectClaim];
  if (typeof v === "string" && v) return v;
  return cfg.subjectClaim === "sub" ? String(identity.id ?? "") : "";
}
