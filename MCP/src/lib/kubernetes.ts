// L'API Kubernetes du cluster où tourne le serveur MCP, sans Vault.
//
// Le pod tourne sous son compte de service (mcp-<cluster>), dont le seul droit
// est de demander des jetons pour deux comptes dédiés de son namespace :
//
//   mcp-<cluster>-reader    lié à ai-reader, par RoleBinding, dans chaque
//                           namespace autorisé, et nulle part ailleurs ;
//   mcp-<cluster>-operator  lié à ai-operator (ai-prd-restarter en PRD), s'il
//                           est créé : sans lui, aucune écriture n'est possible.
//
// Pour chaque appel, le serveur obtient par l'API TokenRequest un jeton de
// courte durée pour le compte voulu (10 minutes, le minimum de Kubernetes) :
// l'équivalent natif des jetons éphémères qu'émettait Vault, sans secret à
// ranger nulle part. Le jeton du pod lui-même est le jeton projeté par le
// kubelet, relu à chaque demande puisque le kubelet le fait tourner.

import { readFileSync } from "node:fs";
import { requestJson, UpstreamError } from "./http.ts";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export interface KubernetesApiOptions {
  /** Défaut : https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT, sinon https://kubernetes.default.svc. */
  url?: string;
  caFile?: string;
  tokenFile?: string;
  namespaceFile?: string;
}

export interface AccessAttributes {
  verb: string;
  resource: string;
  group?: string;
  namespace?: string;
  subresource?: string;
}

export class KubernetesApi {
  readonly url: string;
  readonly caFile: string;
  private readonly tokenFile: string;
  private readonly namespaceFile: string;
  private ns: string | null = null;

  constructor(opts: KubernetesApiOptions = {}) {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? process.env.KUBERNETES_SERVICE_PORT ?? "443";
    this.url = (opts.url ?? (host ? `https://${host.includes(":") ? `[${host}]` : host}:${port}` : "https://kubernetes.default.svc")).replace(/\/$/, "");
    this.caFile = opts.caFile ?? `${SA_DIR}/ca.crt`;
    this.tokenFile = opts.tokenFile ?? `${SA_DIR}/token`;
    this.namespaceFile = opts.namespaceFile ?? `${SA_DIR}/namespace`;
  }

  /** Le namespace du pod (celui des comptes dédiés). */
  namespace(): string {
    if (!this.ns) {
      try {
        this.ns = readFileSync(this.namespaceFile, "utf8").trim();
      } catch {
        throw new Error(`namespace du pod illisible (${this.namespaceFile}) : précisez namespace dans l'identifiant`);
      }
    }
    return this.ns;
  }

  private podToken(): string {
    try {
      return readFileSync(this.tokenFile, "utf8").trim();
    } catch {
      throw new Error(`jeton du compte de service du pod illisible (${this.tokenFile})`);
    }
  }

  /** Un jeton de courte durée pour un compte de service, par l'API TokenRequest. */
  async requestToken(serviceAccount: string, opts: { namespace?: string; expirationSeconds?: number; audiences?: string[] } = {}): Promise<{ token: string; expiresAt: number }> {
    const ns = opts.namespace ?? this.namespace();
    try {
      const res = await requestJson<{ status: { token: string; expirationTimestamp: string } }>(
        `${this.url}/api/v1/namespaces/${encodeURIComponent(ns)}/serviceaccounts/${encodeURIComponent(serviceAccount)}/token`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.podToken()}` },
          caFile: this.caFile,
          timeoutMs: 10_000,
          json: {
            apiVersion: "authentication.k8s.io/v1",
            kind: "TokenRequest",
            spec: { expirationSeconds: opts.expirationSeconds ?? 600, ...(opts.audiences?.length ? { audiences: opts.audiences } : {}) },
          },
        },
      );
      const expiresAt = Date.parse(res.status.expirationTimestamp);
      if (!res.status.token || !Number.isFinite(expiresAt)) throw new Error("réponse TokenRequest incomplète");
      return { token: res.status.token, expiresAt };
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 403) {
        throw new UpstreamError(`le compte de service du pod ne peut pas demander de jeton pour ${ns}/${serviceAccount} (RBAC : create serviceaccounts/token)`, 403);
      }
      if (err instanceof UpstreamError && err.status === 404) {
        throw new UpstreamError(`compte de service ${ns}/${serviceAccount} introuvable`, 404);
      }
      throw err;
    }
  }

  /** Le porteur de ce jeton a-t-il ce droit ? (SelfSubjectAccessReview, permis à tout compte authentifié.) */
  async can(token: string, attrs: AccessAttributes): Promise<boolean> {
    const res = await requestJson<{ status: { allowed: boolean } }>(`${this.url}/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      caFile: this.caFile,
      timeoutMs: 10_000,
      json: { apiVersion: "authorization.k8s.io/v1", kind: "SelfSubjectAccessReview", spec: { resourceAttributes: attrs } },
    });
    return res?.status?.allowed === true;
  }
}

/** Les jetons demandés, gardés jusqu'à une minute avant leur expiration ; une seule demande en vol par compte. */
export class KubernetesTokenCache {
  private cache = new Map<string, { token: string; expiresAt: number }>();
  private inflight = new Map<string, Promise<string>>();

  constructor(readonly api: KubernetesApi, private readonly now: () => number = Date.now) {}

  async token(serviceAccount: string, opts: { namespace?: string; expirationSeconds?: number } = {}): Promise<string> {
    const ns = opts.namespace ?? this.api.namespace();
    const key = `${ns}/${serviceAccount}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt - 60_000 > this.now()) return hit.token;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.api.requestToken(serviceAccount, { namespace: ns, expirationSeconds: opts.expirationSeconds })
      .then((t) => {
        this.cache.set(key, t);
        return t.token;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
