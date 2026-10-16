// Serveur HTTP d'un serveur MCP.
//
//   Port MCP (8443)    POST /mcp — Streamable HTTP, sans état : un McpServer par
//                      requête, qui ne porte que l'identité de CET appel.
//                      TLS terminé ici (Route en passthrough) avec certificat
//                      client exigé, signé par l'AC interne de la plateforme.
//                      Le jeton d'appel est vérifié avant toute lecture du corps.
//   Port de gestion    GET /healthz, /readyz, /metrics — HTTP simple, jamais
//   (9090)             exposé par une Route : les sondes du kubelet et Prometheus
//                      ne présentent pas de certificat client.
//
// Vérifications : chaque module déclare les siennes (droits RBAC de ses comptes
// dans chaque namespace autorisé, par exemple), le lanceur ajoute OPA et la
// livraison du jeton. Elles tournent au démarrage puis chaque minute. /readyz
// renvoie leur état ; seule une vérification critique en échec (OPA injoignable)
// retire le pod du service. Une autre en échec le signale « dégradé », dans
// /readyz, dans les journaux et dans mcp_check_ok.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TLSSocket } from "node:tls";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AuthError, type AccessTokenVerifier } from "./auth.ts";
import type { ApprovalVerifier } from "./approval.ts";
import { stdoutAudit, type AuditSink } from "./audit.ts";
import { toolsForCluster, type Catalog, type Cluster } from "./catalog.ts";
import { Metrics } from "./metrics.ts";
import type { PolicyEngine } from "./policy.ts";
import type { SecretResolver } from "./secrets.ts";
import { executeTool, type AnyToolSpec, type ToolContext, type ToolLimits, type ToolRuntime } from "./tool.ts";
import type { z } from "zod";

export interface ServerDeps<C> {
  config: C;
  cluster: Cluster;
  secrets: SecretResolver;
}

/** Une vérification : rend un détail si elle passe, lève une erreur sinon. */
export interface ReadinessCheck {
  name: string;
  /** Critique : en échec, le pod sort du service (/readyz en 503). */
  critical: boolean;
  run(): Promise<string | void>;
}

export interface CheckState {
  name: string;
  critical: boolean;
  ok: boolean;
  detail: string;
  at: string;
}

export interface ServerModule<C = unknown> {
  /** Nom du serveur, et audience attendue par défaut : mcp-<outil>. */
  name: string;
  configSchema: z.ZodType<C>;
  createTools(deps: ServerDeps<C>): AnyToolSpec[];
  /** Ce que le module vérifie au démarrage et chaque minute (droits, joignabilité). */
  checks?(deps: ServerDeps<C>): ReadinessCheck[];
}

export interface TlsOptions {
  certFile: string;
  keyFile: string;
  /** AC qui signe les certificats clients (FounderOS). */
  clientCaFile: string;
  /** CN acceptés pour le certificat client ; vide : tout certificat signé par l'AC. */
  allowedClientCNs?: string[];
}

export interface StartOptions {
  module: ServerModule<any>;
  config: unknown;
  cluster: Cluster;
  catalog: Catalog;
  policy: PolicyEngine;
  verifyToken: AccessTokenVerifier;
  verifyApproval?: ApprovalVerifier;
  secrets: SecretResolver;
  audit?: AuditSink;
  metrics?: Metrics;
  mcpPort: number;
  mgmtPort: number;
  /** Absent : HTTP en clair, accepté seulement avec insecureHttp (tests, poste local). */
  tls?: TlsOptions;
  insecureHttp?: boolean;
  maxResultBytes?: number;
  host?: string;
  /** Port de gestion (/metrics) : par défaut le même hôte que le port MCP. La passerelle
   *  d'entreprise (G7) met le port MCP sur la boucle locale et laisse /metrics joignable. */
  mgmtHost?: string;
  /** Débit par appelant, exécutions simultanées, délai, jetons d'approbation consommés. */
  limits?: ToolLimits;
  /** Vérifications en plus de celles du module (OPA, livraison du jeton). */
  checks?: ReadinessCheck[];
  /** Intervalle des vérifications (défaut 60 s ; 0 : au démarrage seulement). */
  checkIntervalMs?: number;
}

export interface RunningServer {
  mcp: Server;
  mgmt: Server;
  tools: string[];
  /** L'état des vérifications, après leur premier passage. */
  checks(): CheckState[];
  /** Relance les vérifications maintenant (tests, diagnostic). */
  runChecks(): Promise<CheckState[]>;
  close(): Promise<void>;
}

const MAX_BODY = 1024 * 1024;

/** Les tools d'un module doivent correspondre au catalogue : même nature lecture/écriture, scope connu. */
export function checkAgainstCatalog(serverName: string, tools: AnyToolSpec[], catalog: Catalog): void {
  for (const t of tools) {
    if (!catalog.scopes[t.name]) throw new Error(`${serverName} : ${t.name} n'a pas de scope dans le catalogue`);
    const catalogWrite = catalog.write_tools.includes(t.name);
    if (catalogWrite !== t.write) throw new Error(`${serverName} : ${t.name} est ${t.write ? "en écriture" : "en lecture"} dans le code, pas dans le catalogue`);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("corps de requête trop volumineux"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch {
        reject(new Error("corps JSON invalide"));
      }
    });
    req.on("error", reject);
  });
}

/** W3C traceparent : 00-<trace-id 32 hex>-<parent-id 16 hex>-<flags>. */
function traceFrom(header: string | undefined): { traceId: string; traceparent?: string } {
  const m = header?.match(/^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/);
  if (m) return { traceId: m[1], traceparent: header };
  return { traceId: randomBytes(16).toString("hex") };
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const deps: ServerDeps<unknown> = { config: opts.config, cluster: opts.cluster, secrets: opts.secrets };
  const allTools = opts.module.createTools(deps);
  checkAgainstCatalog(opts.module.name, allTools, opts.catalog);
  const allowed = toolsForCluster(opts.catalog, opts.cluster);
  // Premier verrou : ce que le catalogue ne prévoit pas pour ce cluster n'est pas enregistré.
  const tools = allTools.filter((t) => allowed.has(t.name));

  const metrics = opts.metrics ?? new Metrics();
  const rt: ToolRuntime = {
    serverName: opts.module.name,
    cluster: opts.cluster,
    catalog: opts.catalog,
    policy: opts.policy,
    verifyApproval: opts.verifyApproval,
    audit: opts.audit ?? stdoutAudit,
    metrics,
    maxResultBytes: opts.maxResultBytes ?? 64 * 1024,
    limits: opts.limits,
  };

  // Vérifications : celles du module, puis celles du lanceur.
  const checks = [...(opts.module.checks?.(deps) ?? []), ...(opts.checks ?? [])];
  let state: CheckState[] = [];
  let ran = false;
  const runChecks = async (): Promise<CheckState[]> => {
    const results = await Promise.all(checks.map(async (c): Promise<CheckState> => {
      const at = new Date().toISOString();
      try {
        const detail = await Promise.race([
          c.run(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("délai dépassé (15 s)")), 15_000).unref()),
        ]);
        return { name: c.name, critical: c.critical, ok: true, detail: detail || "ok", at };
      } catch (err) {
        return { name: c.name, critical: c.critical, ok: false, detail: (err as Error).message.slice(0, 500), at };
      }
    }));
    for (const r of results) {
      metrics.checks.set({ check: r.name }, r.ok ? 1 : 0);
      const before = state.find((s) => s.name === r.name);
      if (!r.ok && (!before || before.ok)) {
        console.warn(JSON.stringify({ ts: r.at, level: r.critical ? "error" : "warn", msg: "vérification en échec", check: r.name, critical: r.critical, detail: r.detail }));
      } else if (r.ok && before && !before.ok) {
        console.log(JSON.stringify({ ts: r.at, level: "info", msg: "vérification rétablie", check: r.name }));
      }
    }
    state = results;
    ran = true;
    return results;
  };
  const checkTimer = checks.length && (opts.checkIntervalMs ?? 60_000) > 0
    ? setInterval(() => void runChecks(), opts.checkIntervalMs ?? 60_000)
    : null;
  checkTimer?.unref();
  void runChecks();

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "not found" });
    // Sans état : pas de flux GET ni de fermeture de session.
    if (req.method !== "POST") return sendJson(res, 405, rpcError(-32000, "Method not allowed."), { Allow: "POST" });

    if (opts.tls?.allowedClientCNs?.length) {
      const cn = (req.socket as TLSSocket).getPeerCertificate?.()?.subject?.CN;
      const names = Array.isArray(cn) ? cn : [cn];
      if (!names.some((n) => n && opts.tls!.allowedClientCNs!.includes(n))) {
        return sendJson(res, 403, rpcError(-32001, "certificat client non autorisé"));
      }
    }

    const auth = req.headers.authorization ?? "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token || token === auth) {
      return sendJson(res, 401, rpcError(-32001, "jeton d'appel manquant"), { "WWW-Authenticate": 'Bearer error="invalid_request"' });
    }
    const asserted = (name: string) => {
      const v = req.headers[name];
      return (Array.isArray(v) ? v[0] : v) || undefined;
    };
    let identity;
    try {
      identity = await opts.verifyToken(token, { user: asserted("x-founderos-user"), agent: asserted("x-founderos-agent") });
    } catch (err) {
      const message = err instanceof AuthError ? err.message : "jeton refusé";
      return sendJson(res, 401, rpcError(-32001, message), { "WWW-Authenticate": 'Bearer error="invalid_token"' });
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, rpcError(-32700, (err as Error).message));
    }

    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const ctx: ToolContext = {
      identity,
      ...traceFrom(header("traceparent")),
      sessionId: header("x-session-id"),
    };
    const approvalToken = header("x-approval-token");

    const server = new McpServer({ name: opts.module.name, version: "0.1.0" });
    for (const spec of tools) {
      server.registerTool(
        spec.name,
        {
          description: spec.description,
          inputSchema: spec.input,
          annotations: { readOnlyHint: !spec.write, destructiveHint: false, openWorldHint: false },
        },
        async (args: unknown) => executeTool(rt, spec, args, ctx, approvalToken),
      );
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const onMcp = (req: IncomingMessage, res: ServerResponse) => {
    handleMcp(req, res).catch((err) => {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "requête MCP en échec", error: String(err) }));
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, "erreur interne"));
    });
  };

  let mcp: Server;
  if (opts.tls) {
    mcp = createHttpsServer({
      cert: readFileSync(opts.tls.certFile),
      key: readFileSync(opts.tls.keyFile),
      ca: readFileSync(opts.tls.clientCaFile),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    }, onMcp);
  } else if (opts.insecureHttp) {
    mcp = createHttpServer(onMcp);
  } else {
    throw new Error("TLS non configuré (TLS_CERT_FILE, TLS_KEY_FILE, TLS_CLIENT_CA_FILE) : refus de démarrer en clair sans MCP_INSECURE_HTTP=1");
  }

  const mgmt = createHttpServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    // Vivant : le processus répond. Prêt : aucune vérification critique en échec.
    if (path === "/healthz") return sendJson(res, 200, { ok: true, server: opts.module.name, cluster: opts.cluster });
    if (path === "/readyz") {
      if (checks.length && !ran) return sendJson(res, 503, { ready: false, reason: "vérifications en cours" });
      const failedCritical = state.filter((s) => s.critical && !s.ok);
      const degraded = state.filter((s) => !s.critical && !s.ok);
      return sendJson(res, failedCritical.length ? 503 : 200, {
        ready: failedCritical.length === 0,
        degraded: degraded.length > 0,
        server: opts.module.name,
        cluster: opts.cluster,
        tools: tools.length,
        checks: state,
      });
    }
    if (path === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      return res.end(metrics.render());
    }
    sendJson(res, 404, { error: "not found" });
  });

  const host = opts.host ?? "0.0.0.0";
  await new Promise<void>((resolve) => mcp.listen(opts.mcpPort, host, resolve));
  await new Promise<void>((resolve) => mgmt.listen(opts.mgmtPort, opts.mgmtHost ?? host, resolve));

  return {
    mcp,
    mgmt,
    tools: tools.map((t) => t.name),
    checks: () => state,
    runChecks,
    close: async () => {
      if (checkTimer) clearInterval(checkTimer);
      const closing = Promise.all([
        new Promise<void>((r) => mcp.close(() => r())),
        new Promise<void>((r) => mgmt.close(() => r())),
      ]);
      // Les connexions keep-alive retiendraient close() indéfiniment.
      mcp.closeAllConnections();
      mgmt.closeAllConnections();
      await closing;
    },
  };
}
