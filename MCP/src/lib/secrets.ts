// Identifiants vers les outils : jamais dans l'image ni dans la configuration,
// toujours tirés de Vault au moment de l'appel. Chaque cluster a SON Vault : un
// serveur ne voit que les secrets et les rôles du Vault de son cluster.
//
//   kv        KV v2 (jeton Grafana, clé PRTG, jeton de rôle Argo CD, clé de la
//             GitHub App) — mis en cache 5 minutes ;
//   vault-k8s moteur de secrets Kubernetes : un jeton de compte de service
//             éphémère, lié à ai-reader ou ai-operator, pour UN namespace —
//             mis en cache jusqu'à 60 s avant son expiration ;
//   env/file  développement local uniquement.
//
// Le serveur s'authentifie auprès de Vault avec le jeton projeté de SON compte
// de service (méthode kubernetes, rôle mcp-<outil>).

import { readFileSync } from "node:fs";
import { z } from "zod";
import { requestJson } from "./http.ts";

export const credentialRefSchema = z.discriminatedUnion("type", [
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
