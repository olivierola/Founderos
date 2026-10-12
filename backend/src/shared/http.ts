import type { ErrorRequestHandler } from "express";

/**
 * Erreur porteuse d'un statut HTTP. Une route la lance, le gestionnaire
 * d'erreurs la transforme en `{ error, ...extra }` — la forme que lit déjà
 * `callEdge` côté front.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    message: string,
    opts: { extra?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.status = status;
    this.extra = opts.extra ?? {};
    this.headers = opts.headers ?? {};
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  // Réponse déjà entamée (flux) : seul le gestionnaire par défaut d'Express
  // peut encore couper proprement la connexion.
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof HttpError) {
    res.set(err.headers).status(err.status).json({ error: err.message, ...err.extra });
    return;
  }
  // Erreurs levées par express.json() avant d'atteindre la route.
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json({ error: "Request body too large" });
    return;
  }
  console.error("[backend] erreur non gérée :", err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
};
