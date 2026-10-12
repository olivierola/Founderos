// Outils de test : clés de signature locales (Keycloak et FounderOS simulés),
// faux outils HTTP, runtime prêt à l'emploi.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import type { AuditEvent } from "../src/lib/audit.ts";
import { createApprovalVerifier } from "../src/lib/approval.ts";
import { loadCatalog, type Cluster } from "../src/lib/catalog.ts";
import { Metrics } from "../src/lib/metrics.ts";
import { BuiltinPolicyEngine } from "../src/lib/policy.ts";
import type { CredentialRef, SecretResolver } from "../src/lib/secrets.ts";
import type { ToolContext, ToolRuntime } from "../src/lib/tool.ts";

type SigningKey = Parameters<SignJWT["sign"]>[0];

export const ISSUER = "https://keycloak.test/realms/platform";
export const APPROVAL_ISSUER = "https://founderos.test";

export async function signingKey() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }), jwk };
}

export async function accessToken(
  privateKey: SigningKey,
  claims: { sub?: string; azp?: string; aud: string; scope?: string; roles?: string[]; iss?: string; lifetime?: number; preferred_username?: string },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    azp: claims.azp ?? "agent-ops-investigator",
    scope: claims.scope ?? "",
    realm_access: { roles: claims.roles ?? [] },
    ...(claims.preferred_username ? { preferred_username: claims.preferred_username } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud)
    .setSubject(claims.sub ?? "u-alice")
    .setIssuedAt(now)
    .setExpirationTime(now + (claims.lifetime ?? 300))
    .sign(privateKey);
}

export async function approvalToken(
  privateKey: SigningKey,
  claims: {
    aud: string; sub: string; approver: string; tool: string; target_cluster: string; params_hash: string; lifetime?: number;
    /** Règle à quorum (G3) ; volontairement non typé, pour les cas mal formés. */
    approvers?: unknown;
  },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    approver: claims.approver, tool: claims.tool, target_cluster: claims.target_cluster, params_hash: claims.params_hash,
    ...(claims.approvers !== undefined ? { approvers: claims.approvers } : {}),
  })
    // typ JWT : comme FounderOS ; un contexte signé (fos-ctx+jwt) n'est jamais une approbation.
    .setProtectedHeader({ alg: "RS256", kid: "k1", typ: "JWT" })
    .setIssuer(APPROVAL_ISSUER)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .setJti("approval-1")
    .setIssuedAt(now)
    .setExpirationTime(now + (claims.lifetime ?? 300))
    .sign(privateKey);
}

/** Identifiants de test : la valeur est le nom de la référence. */
export const fakeSecrets: SecretResolver & { requests: Array<{ ref: CredentialRef; namespace?: string }> } = {
  requests: [],
  async resolve(ref, opts = {}) {
    this.requests.push({ ref, namespace: opts.namespace });
    return ref.type === "kv" ? `secret-${ref.path}` : ref.type === "vault-k8s" ? `sa-token-${ref.role}-${opts.namespace ?? "*"}` : "local";
  },
};

export interface Recorded { method: string; url: string; headers: IncomingMessage["headers"]; body: string }

/** Faux outil HTTP : `routes` répond selon « MÉTHODE chemin » (sans la query). */
export async function fakeUpstream(routes: Record<string, (req: Recorded) => { status?: number; json?: unknown; text?: string }>) {
  const calls: Recorded[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rec: Recorded = { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body: Buffer.concat(chunks).toString() };
      calls.push(rec);
      const route = routes[`${rec.method} ${new URL(rec.url, "http://x").pathname}`];
      if (!route) {
        res.writeHead(404).end("no route");
        return;
      }
      const out = route(rec);
      if (out.text !== undefined) {
        res.writeHead(out.status ?? 200, { "Content-Type": "text/plain" }).end(out.text);
      } else {
        res.writeHead(out.status ?? 200, { "Content-Type": "application/json" }).end(JSON.stringify(out.json ?? {}));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    calls,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export async function runtime(serverName: string, cluster: Cluster, opts: { approvalJwks?: ReturnType<typeof createLocalJWKSet>; audience?: string } = {}) {
  const audit: AuditEvent[] = [];
  const catalog = loadCatalog();
  const rt: ToolRuntime = {
    serverName,
    cluster,
    catalog,
    policy: new BuiltinPolicyEngine(catalog),
    ...(opts.approvalJwks ? { verifyApproval: createApprovalVerifier({ issuer: APPROVAL_ISSUER, audience: opts.audience ?? `${serverName}-${cluster}`, jwks: opts.approvalJwks }) } : {}),
    audit: (e) => audit.push(e),
    metrics: new Metrics(),
    maxResultBytes: 64 * 1024,
  };
  return { rt, audit };
}

export const reader: ToolContext = {
  identity: { sub: "u-alice", azp: "agent-ops-investigator", username: "alice", scopes: ["obs:read", "fleet:read", "ocp:read", "argocd:read", "prtg:read"], roles: ["ai-ops-reader"], exp: 0 },
  traceId: "0af7651916cd43dd8448eb211c80319c",
};

export const operator: ToolContext = {
  identity: {
    sub: "u-bob", azp: "agent-ops-change", username: "bob",
    scopes: ["obs:read", "ocp:read", "argocd:read", "ocp:restart", "argocd:sync", "alert:silence", "git:pr"],
    roles: ["ai-ops-operator"], exp: 0,
  },
  traceId: "0af7651916cd43dd8448eb211c80319d",
};

/** Le texte d'un résultat de tool, et son JSON s'il en est un (sans l'en-tête « non fiable »). */
export function resultText(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((c) => c.text ?? "").join("\n");
}
export function resultJson(r: { content: Array<{ type: string; text?: string }> }): any {
  const text = resultText(r);
  const body = text.startsWith("[Résultat de") ? text.slice(text.indexOf("\n") + 1) : text;
  return JSON.parse(body);
}
