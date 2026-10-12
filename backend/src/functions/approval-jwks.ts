// approval-jwks — les clés publiques des jetons d'approbation (installation
// dédiée, docs/openshift-implementation.md D6).
//
// GET /functions/v1/approval-jwks → { "keys": [ … ] }
//
// Public, sans JWT : ce sont des clés publiques. Les serveurs MCP les lisent
// ici (APPROVAL_JWKS_URL), ou dans une ConfigMap copiée depuis cette adresse
// quand leur cluster ne joint pas FounderOS (APPROVAL_JWKS_FILE). La clé
// courante vient d'APPROVAL_SIGNING_KEY ; APPROVAL_JWKS_EXTRA publie la
// suivante avant qu'elle serve (rotation, section 17.3).

import type { Request, Response } from "express";
import { approvalJwks as loadJwks } from "../edge/_shared/mcp-approval.ts";
import { HttpError } from "../shared/http.ts";

export async function approvalJwks(_req: Request, res: Response): Promise<void> {
  const jwks = await loadJwks();
  if (!jwks.keys.length) throw new HttpError(404, "Aucune clé d'approbation configurée sur cette installation.");
  res.set("Cache-Control", "public, max-age=300");
  res.json(jwks);
}
