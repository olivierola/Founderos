// Fonctions réécrites en Express. Elles gardent leur nom et leur chemin
// (/functions/v1/<nom>) et remplacent la copie générée du même nom :
// scripts/port-edge.mjs ne génère pas une fonction qui a un fichier ici.

import express, { Router, type RequestHandler } from "express";
import { deleteWorkspace } from "./delete-workspace.ts";
import { idpToken } from "./idp-token.ts";
import { installationAdmin } from "./installation-admin.ts";
import { ragAgentPublicConfig } from "./rag-agent-public-config.ts";
import { reportError } from "./report-error.ts";

const nativeFunctions: Record<string, RequestHandler> = {
  "delete-workspace": deleteWorkspace,
  // Installation dédiée seulement : pas d'équivalent dans supabase/functions.
  "idp-token": idpToken,
  // Administration → Installation (G4) : réglages et diagnostic de ce backend.
  "installation-admin": installationAdmin,
  "rag-agent-public-config": ragAgentPublicConfig,
  "report-error": reportError,
};

export const NATIVE_FUNCTIONS: ReadonlySet<string> = new Set(Object.keys(nativeFunctions));

// Le corps n'est lu en JSON que sur ces routes : les fonctions générées
// reçoivent le corps brut (signatures de webhooks, formulaires…).
const parseJson: RequestHandler[] = [
  express.json({ limit: "10mb" }),
  // Express 5 laisse req.body à undefined quand il n'y a pas de corps JSON.
  (req, _res, next) => {
    req.body ??= {};
    next();
  },
];

export const functionsRouter = Router();
for (const [name, handler] of Object.entries(nativeFunctions)) {
  functionsRouter.post(`/${name}`, parseJson, handler);
}
