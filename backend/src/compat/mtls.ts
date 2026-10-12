// Certificat client mTLS de FounderOS vers les serveurs MCP internes
// (docs/openshift-implementation.md D4).
//
// mcp-client.ts passe par globalThis.__mcpFetch quand il existe. Ici, on
// l'installe si MCP_CLIENT_CERT_FILE est défini : les hôtes de
// MCP_INTERNAL_HOSTS reçoivent le certificat client et ne sont vérifiés que
// contre l'AC interne (MCP_CA_FILE) ; tous les autres passent par le fetch
// global, inchangé. Pas de dispatcher global : l'option `ca` remplacerait les
// autorités publiques pour chaque appel sortant (Azure, Keycloak…).
//
// cert-manager renouvelle le Secret monté avant expiration : le certificat est
// relu dès que le fichier change, sans redémarrage.
//
//   MCP_CLIENT_CERT_FILE, MCP_CLIENT_KEY_FILE   certificat et clé (Secret founderos-mcp-client)
//   MCP_CA_FILE                                 AC interne (défaut : autorités du système)
//   MCP_INTERNAL_HOSTS                          motifs, ex. *.apps-int.*.interne.exemple

import { readFileSync, statSync } from "node:fs";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Même règle que supabase/functions/_shared/ssrf.ts : `*` remplace un label DNS. */
function hostMatches(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((p) => {
    const labels = p.toLowerCase().split(".").map((l) => (l === "*" ? "[a-z0-9-]+" : l.replace(/[^a-z0-9-]/g, "\\$&")));
    return new RegExp(`^${labels.join("\\.")}$`).test(h);
  });
}

export interface MtlsOptions {
  certFile: string;
  keyFile: string;
  caFile?: string;
  hosts: string[];
  /** Intervalle minimal entre deux vérifications du fichier (défaut 60 s). */
  recheckMs?: number;
}

export function createMcpFetch(opts: MtlsOptions, fallback: FetchLike = fetch): FetchLike {
  let agent: Agent | null = null;
  let stamp = "";
  let checkedAt = 0;

  const current = (): Agent => {
    const now = Date.now();
    if (agent && now - checkedAt < (opts.recheckMs ?? 60_000)) return agent;
    checkedAt = now;
    const files = [opts.certFile, opts.keyFile, ...(opts.caFile ? [opts.caFile] : [])];
    const next = files.map((f) => statSync(f).mtimeMs).join(":");
    if (agent && next === stamp) return agent;
    const previous = agent;
    agent = new Agent({
      connect: {
        cert: readFileSync(opts.certFile),
        key: readFileSync(opts.keyFile),
        ...(opts.caFile ? { ca: readFileSync(opts.caFile) } : {}),
      },
    });
    stamp = next;
    void previous?.close();
    return agent;
  };

  return async (input, init) => {
    let host = "";
    try { host = new URL(input).hostname; } catch { /* laissé au fetch global, qui rejettera */ }
    if (!host || !hostMatches(host, opts.hosts)) return fallback(input, init);
    const res = await undiciFetch(input, { ...(init as UndiciRequestInit), dispatcher: current() });
    return res as unknown as Response;
  };
}

const certFile = process.env.MCP_CLIENT_CERT_FILE?.trim();
if (certFile) {
  const keyFile = process.env.MCP_CLIENT_KEY_FILE?.trim();
  if (!keyFile) throw new Error("MCP_CLIENT_CERT_FILE est défini sans MCP_CLIENT_KEY_FILE.");
  const hosts = (process.env.MCP_INTERNAL_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!hosts.length) throw new Error("MCP_CLIENT_CERT_FILE est défini sans MCP_INTERNAL_HOSTS : à quels serveurs présenter le certificat ?");
  (globalThis as { __mcpFetch?: FetchLike }).__mcpFetch = createMcpFetch({
    certFile, keyFile, caFile: process.env.MCP_CA_FILE?.trim() || undefined, hosts,
  });
}
