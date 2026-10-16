// Identifiants vers les outils : jamais dans l'image ni dans la configuration,
// résolus au moment de l'appel.
//
//   k8s-token  un jeton de courte durée pour un compte de service dédié du
//              cluster (mcp-<cluster>-reader, mcp-<cluster>-operator), obtenu
//              par l'API TokenRequest (kubernetes.ts) : le cas par défaut pour
//              l'API Kubernetes, sans Vault ;
//   file       un fichier monté depuis un Secret Kubernetes (jeton Argo CD,
//              Grafana, clé PRTG, clé de la GitHub App), relu à chaque appel
//              pour suivre ses rotations ;
//   env        une variable d'environnement (développement) ;
//   kv,        en option, si l'entreprise a un Vault (VAULT_ADDR) : KV v2, et le
//   vault-k8s  moteur de secrets Kubernetes de Vault. Le serveur s'y authentifie
//              avec le jeton projeté de son compte de service.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { requestJson } from "./http.ts";
import type { KubernetesTokenCache } from "./kubernetes.ts";

const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export const credentialRefSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("k8s-token"),
    serviceAccount: z.string().regex(DNS1123).max(253),
    /** Défaut : le namespace du pod. */
    namespace: z.string().regex(DNS1123).max(63).optional(),
    /** 600 s au moins (minimum de Kubernetes), une heure au plus. */
    expirationSeconds: z.number().int().min(600).max(3600).optional(),
  }),
  z.object({ type: z.literal("kv"), path: z.string().min(1), key: z.string().min(1), mount: z.string().optional() }),
  z.object({ type: z.literal("vault-k8s"), role: z.string().min(1), mount: z.string().optional(), clusterWide: z.boolean().optional() }),
  z.object({ type: z.literal("env"), name: z.string().min(1) }),
  z.object({ type: z.literal("file"), path: z.string().min(1) }),
]);
export type CredentialRef = z.infer<typeof credentialRefSchema>;

export interface SecretResolver {
  /** `namespace` est requis pour vault-k8s (sauf clusterWide) : le jeton ne vaut que pour lui. */
  resolve(ref: CredentialRef, opts?: { namespace?: string }): Promise<string>;
}

export interface VaultOptions {
  addr: string;
  role: string;
  authMount?: string;
  kvMount?: string;
  k8sSecretsMount?: string;
  /** Jeton projeté du compte de service du serveur. */
  jwtFile?: string;
  caFile?: string;
  /** Vault Enterprise : espace de noms. */
  namespace?: string;
}

interface Cached { value: string; expiresAt: number }

export class VaultSecretResolver implements SecretResolver {
  private clientToken: Cached | null = null;
  private cache = new Map<string, Cached>();

  constructor(private readonly opts: VaultOptions) {}

  private headers(token?: string): Record<string, string> {
    return {
      ...(token ? { "X-Vault-Token": token } : {}),
      ...(this.opts.namespace ? { "X-Vault-Namespace": this.opts.namespace } : {}),
    };
  }

  private url(path: string): string {
    return `${this.opts.addr.replace(/\/$/, "")}/v1/${path}`;
  }

  private async token(): Promise<string> {
    if (this.clientToken && this.clientToken.expiresAt > Date.now() + 30_000) return this.clientToken.value;
    const jwt = readFileSync(this.opts.jwtFile ?? "/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim();
    const res = await requestJson<{ auth: { client_token: string; lease_duration: number } }>(
      this.url(`auth/${this.opts.authMount ?? "kubernetes"}/login`),
      { method: "POST", json: { role: this.opts.role, jwt }, headers: this.headers(), caFile: this.opts.caFile },
    );
    this.clientToken = { value: res.auth.client_token, expiresAt: Date.now() + res.auth.lease_duration * 1000 };
    return this.clientToken.value;
  }

  async resolve(ref: CredentialRef, opts: { namespace?: string } = {}): Promise<string> {
    if (ref.type === "env" || ref.type === "file") return resolveLocal(ref);
    if (ref.type === "k8s-token") throw new Error("k8s-token se résout par l'API Kubernetes, pas par Vault (ClusterSecretResolver)");

    const cacheKey = ref.type === "kv"
      ? `kv:${ref.mount ?? ""}:${ref.path}:${ref.key}`
      : `k8s:${ref.mount ?? ""}:${ref.role}:${ref.clusterWide ? "*" : opts.namespace ?? ""}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const token = await this.token();
    if (ref.type === "kv") {
      const res = await requestJson<{ data: { data: Record<string, unknown> } }>(
        this.url(`${ref.mount ?? this.opts.kvMount ?? "secret"}/data/${ref.path}`),
        { headers: this.headers(token), caFile: this.opts.caFile },
      );
      const value = res?.data?.data?.[ref.key];
      if (typeof value !== "string" || !value) throw new Error(`Vault : ${ref.path}#${ref.key} absent`);
      this.cache.set(cacheKey, { value, expiresAt: Date.now() + 300_000 });
      return value;
    }

    if (!ref.clusterWide && !opts.namespace) throw new Error(`Vault : namespace requis pour le rôle ${ref.role}`);
    const res = await requestJson<{ data: { service_account_token: string }; lease_duration: number }>(
      this.url(`${ref.mount ?? this.opts.k8sSecretsMount ?? "kubernetes"}/creds/${ref.role}`),
      {
        method: "POST",
        json: ref.clusterWide ? { cluster_role_binding: true } : { kubernetes_namespace: opts.namespace },
        headers: this.headers(token),
        caFile: this.opts.caFile,
      },
    );
    const value = res.data.service_account_token;
    this.cache.set(cacheKey, { value, expiresAt: Date.now() + Math.max(res.lease_duration - 60, 30) * 1000 });
    return value;
  }
}

function resolveLocal(ref: Extract<CredentialRef, { type: "env" | "file" }>): string {
  const value = ref.type === "env" ? process.env[ref.name] : readFileSync(ref.path, "utf8").trim();
  if (!value) throw new Error(`identifiant local absent : ${ref.type === "env" ? ref.name : ref.path}`);
  return value;
}

/** Développement et tests : seulement env et file. */
export class LocalSecretResolver implements SecretResolver {
  async resolve(ref: CredentialRef): Promise<string> {
    if (ref.type !== "env" && ref.type !== "file") throw new Error(`${ref.type} exige Vault (VAULT_ADDR)`);
    return resolveLocal(ref);
  }
}

/**
 * Le résolveur du serveur : env et file en local, k8s-token par l'API
 * Kubernetes du cluster, kv et vault-k8s par Vault s'il est configuré.
 */
export class ClusterSecretResolver implements SecretResolver {
  constructor(private readonly opts: { kubernetes?: KubernetesTokenCache; vault?: SecretResolver } = {}) {}

  async resolve(ref: CredentialRef, opts: { namespace?: string } = {}): Promise<string> {
    if (ref.type === "env" || ref.type === "file") return resolveLocal(ref);
    if (ref.type === "k8s-token") {
      if (!this.opts.kubernetes) throw new Error("k8s-token : accès à l'API Kubernetes non configuré");
      return this.opts.kubernetes.token(ref.serviceAccount, { namespace: ref.namespace, expirationSeconds: ref.expirationSeconds });
    }
    if (!this.opts.vault) throw new Error(`${ref.type} exige Vault (VAULT_ADDR) ; sans Vault, utilisez k8s-token ou file`);
    return this.opts.vault.resolve(ref, opts);
  }
}
