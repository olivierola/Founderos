// Diagnostic de l'installation (G4) : chaque brique testée, et nommée avec sa
// cause quand elle est en panne. Les dépendances (base, fetch, environnement)
// sont injectées : les tests jouent chaque panne sans rien démarrer.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createLocalJWKSet, jwtVerify } from "jose";
import { decryptSecret, encryptSecret } from "../edge/_shared/crypto.ts";
import { approvalJwks, signFounderosToken } from "../edge/_shared/founderos-jwt.ts";
import { adaptChatBody, pinnedChatTarget } from "../edge/_shared/llm-upstream.ts";

export type CheckStatus = "ok" | "warn" | "error" | "skipped";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Ce qu'il faut faire, quand ce n'est pas « ok ». */
  fix?: string;
  ms?: number;
}

export interface CheckDeps {
  admin: SupabaseClient;
  /** L'environnement effectif (variables, puis réglages d'installation). */
  env: (key: string) => string | undefined;
  fetch: typeof fetch;
  /** Ce backend, pour les appels entre fonctions (/functions/v1/…). */
  functionsUrl: string;
  mgmtPort: number;
  /** La session de la personne, pour tester ses serveurs MCP sous sa RLS. */
  authHeader: string;
  workspaceId: string;
  timeoutMs?: number;
}

type Partial_ = Omit<CheckResult, "id" | "label" | "ms">;

async function timed(id: string, label: string, run: () => Promise<Partial_>): Promise<CheckResult> {
  const started = Date.now();
  try {
    return { id, label, ...(await run()), ms: Date.now() - started };
  } catch (e) {
    return { id, label, status: "error", detail: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
  }
}

function withTimeout(deps: CheckDeps, init: RequestInit = {}): RequestInit {
  return { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) };
}

const missingTable = (msg: string) => /does not exist|relation .* not exist|schema cache/i.test(msg);

export async function checkDatabase(deps: CheckDeps): Promise<CheckResult> {
  return timed("database", "Base de données", async () => {
    const { count, error } = await deps.admin.from("workspaces").select("id", { count: "exact", head: true });
    if (error) return { status: "error", detail: `Supabase refuse : ${error.message}`, fix: "Vérifiez SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY." };
    // Les dernières migrations du chantier entreprise : une table de chacune.
    const expected: Array<[string, string]> = [
      ["0281", "approval_policies"], ["0282", "enterprise_sso_domains"], ["0283", "installation_settings"],
    ];
    const absent: string[] = [];
    for (const [migration, table] of expected) {
      const { error: e } = await deps.admin.from(table).select("*", { head: true, count: "exact" }).limit(1);
      if (e && missingTable(e.message)) absent.push(`${migration} (${table})`);
    }
    if (absent.length) {
      return { status: "error", detail: `Migrations non appliquées : ${absent.join(", ")}.`, fix: "Appliquez les migrations de supabase/migrations (supabase db push, ou le job de migration du chart)." };
    }
    return { status: "ok", detail: `Joignable, ${count ?? 0} organisation(s), migrations à jour.` };
  });
}

export async function checkEncryption(deps: CheckDeps): Promise<CheckResult> {
  return timed("encryption", "Chiffrement des secrets", async () => {
    if (!deps.env("CREDENTIAL_ENCRYPTION_KEY")) {
      return { status: "error", detail: "CREDENTIAL_ENCRYPTION_KEY absente : aucun secret (jetons, en-têtes, identifiants) ne peut être enregistré.", fix: "Générez-la : openssl rand -base64 32, et ajoutez-la à l'environnement." };
    }
    const probe = `diag-${Date.now()}`;
    const { ciphertext, iv } = await encryptSecret(probe);
    if ((await decryptSecret(ciphertext, iv)) !== probe) return { status: "error", detail: "Le déchiffrement ne rend pas la valeur chiffrée." };
    return { status: "ok", detail: "Chiffrement et déchiffrement AES-GCM en ordre." };
  });
}

export async function checkApprovalKey(deps: CheckDeps): Promise<CheckResult> {
  return timed("approval_key", "Clé de signature et JWKS public", async () => {
    const issuer = deps.env("APPROVAL_ISSUER");
    if (!deps.env("APPROVAL_SIGNING_KEY") || !issuer) {
      return { status: "warn", detail: "APPROVAL_SIGNING_KEY ou APPROVAL_ISSUER absent : pas d'approbation signée ni de contexte signé.", fix: "Clé EC P-256 en PKCS#8 (openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256), et l'émetteur dans Installation." };
    }
    const jwks = await approvalJwks();
    const { token } = await signFounderosToken({ typ: "JWT", audience: "founderos-diagnostic", subject: "diagnostic", ttlS: 60, claims: {} });
    await jwtVerify(token, createLocalJWKSet(jwks as never), { issuer, audience: "founderos-diagnostic" });
    const url = `${deps.functionsUrl}/functions/v1/approval-jwks`;
    try {
      const res = await deps.fetch(url, withTimeout(deps));
      const body = await res.json().catch(() => null) as { keys?: unknown[] } | null;
      if (!res.ok || !Array.isArray(body?.keys) || !body!.keys.length) {
        return { status: "warn", detail: `Signature en ordre, mais le JWKS public répond ${res.status} à ${url}.`, fix: "Les serveurs MCP et les outils le lisent : vérifiez FUNCTIONS_URL et la Route du backend." };
      }
      return { status: "ok", detail: `Signature vérifiée ; JWKS public servi (${body!.keys.length} clé(s)), émetteur ${issuer}.` };
    } catch (e) {
      return { status: "warn", detail: `Signature en ordre, mais ${url} est injoignable : ${e instanceof Error ? e.message : String(e)}.`, fix: "Vérifiez FUNCTIONS_URL." };
    }
  });
}

export async function checkLlm(deps: CheckDeps): Promise<CheckResult> {
  return timed("llm", "Passerelle LLM", async () => {
    const target = await pinnedChatTarget();
    if (!target) {
      const keys = ["DEEPSEEK_API_KEY", "GROQ_API_KEY"].filter((k) => deps.env(k));
      return keys.length
        ? { status: "ok", detail: `Pas de passerelle imposée : fournisseurs par défaut (${keys.join(", ")}).` }
        : { status: "error", detail: "Ni passerelle imposée (LLM_UPSTREAM) ni clé de fournisseur par défaut : les agents ne peuvent pas répondre.", fix: "Réglez la passerelle dans Installation, ou ajoutez DEEPSEEK_API_KEY." };
    }
    const body = adaptChatBody(target.url, { model: target.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 });
    const res = await deps.fetch(target.url, withTimeout(deps, {
      method: "POST", headers: { ...target.headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      const fix = res.status === 401 || res.status === 403 ? "Clé refusée : LLM_API_KEY, LLM_AGENT_KEYS ou la clé Azure."
        : res.status === 404 ? "Alias ou déploiement inconnu de la passerelle." : undefined;
      return { status: "error", detail: `La passerelle répond ${res.status} pour ${target.model} : ${text}`, ...(fix ? { fix } : {}) };
    }
    return { status: "ok", detail: `${new URL(target.url).host} répond (${target.model}).` };
  });
}

export async function checkIdp(deps: CheckDeps): Promise<CheckResult> {
  return timed("idp", "Fournisseurs d'identité (SSO)", async () => {
    const { data } = await deps.admin.from("enterprise_sso_providers")
      .select("name, protocol, issuer, metadata_url, enabled").eq("enabled", true).limit(10);
    const providers = (data ?? []) as Array<{ name: string; protocol: string; issuer: string | null; metadata_url: string | null }>;
    if (!providers.length) return { status: "skipped", detail: "Aucun fournisseur SSO actif." };
    const failures: string[] = [];
    for (const p of providers) {
      try {
        if (p.protocol === "oidc" && p.issuer) {
          const res = await deps.fetch(`${p.issuer}/.well-known/openid-configuration`, withTimeout(deps));
          const doc = await res.json().catch(() => null) as { issuer?: string } | null;
          if (!res.ok) failures.push(`${p.name} : découverte HTTP ${res.status}`);
          else if (String(doc?.issuer ?? "").replace(/\/+$/, "") !== p.issuer.replace(/\/+$/, "")) failures.push(`${p.name} : l'IdP se déclare « ${doc?.issuer} »`);
        } else if (p.metadata_url) {
          const res = await deps.fetch(p.metadata_url, withTimeout(deps));
          if (!res.ok) failures.push(`${p.name} : métadonnées HTTP ${res.status}`);
        }
      } catch (e) {
        failures.push(`${p.name} : ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return failures.length
      ? { status: "error", detail: failures.join(" ; "), fix: "Vérifiez l'issuer ou l'URL des métadonnées, et que le backend joint l'IdP (proxy, pare-feu)." }
      : { status: "ok", detail: `${providers.length} fournisseur(s) joignable(s) : ${providers.map((p) => p.name).join(", ")}.` };
  });
}

export async function checkRelays(deps: CheckDeps): Promise<CheckResult> {
  return timed("relays", "Relais", async () => {
    const { data } = await deps.admin.from("connector_relays")
      .select("name, status, last_seen_at").eq("workspace_id", deps.workspaceId).eq("status", "active");
    const relays = (data ?? []) as Array<{ name: string; last_seen_at: string | null }>;
    if (!relays.length) return { status: "skipped", detail: "Aucun relais actif dans cette organisation." };
    const now = Date.now();
    const age = (r: { last_seen_at: string | null }) => (r.last_seen_at ? now - Date.parse(r.last_seen_at) : Infinity);
    const down = relays.filter((r) => age(r) > 3_600_000);
    const late = relays.filter((r) => age(r) > 120_000 && age(r) <= 3_600_000);
    const fmt = (r: { name: string; last_seen_at: string | null }) =>
      `${r.name} (${r.last_seen_at ? `vu il y a ${Math.round(age(r) / 60_000)} min` : "jamais vu"})`;
    if (down.length) return { status: "error", detail: `Sans contact : ${down.map(fmt).join(", ")}.`, fix: "Le pod du relais tourne-t-il ? Il lui faut une sortie vers ce backend." };
    if (late.length) return { status: "warn", detail: `En retard : ${late.map(fmt).join(", ")}.` };
    return { status: "ok", detail: `${relays.length} relais en contact.` };
  });
}

export async function checkMcpServers(deps: CheckDeps): Promise<CheckResult> {
  return timed("mcp", "Serveurs MCP (tools/list)", async () => {
    const { data } = await deps.admin.from("mcp_servers")
      .select("id, name").eq("workspace_id", deps.workspaceId).eq("enabled", true).limit(15);
    const servers = (data ?? []) as Array<{ id: string; name: string }>;
    if (!servers.length) return { status: "skipped", detail: "Aucun serveur MCP actif dans cette organisation." };
    const results: Array<{ name: string; ok: boolean; info: string }> = [];
    const queue = [...servers];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        try {
          // Par mcp-gateway, sous la session de la personne : les mêmes en-têtes
          // et le même relais que pour un agent, et le cache des tools mis à jour.
          const res = await deps.fetch(`${deps.functionsUrl}/functions/v1/mcp-gateway`, withTimeout({ ...deps, timeoutMs: deps.timeoutMs ?? 25_000 }, {
            method: "POST", headers: { Authorization: deps.authHeader, "Content-Type": "application/json" },
            body: JSON.stringify({ action: "discover", server_id: s.id }),
          }));
          const out = await res.json().catch(() => ({})) as { ok?: boolean; count?: number; error?: string };
          results.push(out.ok ? { name: s.name, ok: true, info: `${out.count ?? 0} tools` } : { name: s.name, ok: false, info: out.error ?? `HTTP ${res.status}` });
        } catch (e) {
          results.push({ name: s.name, ok: false, info: e instanceof Error ? e.message : String(e) });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const bad = results.filter((r) => !r.ok);
    const all = results.map((r) => `${r.name} : ${r.info}`).join(" ; ");
    if (!bad.length) return { status: "ok", detail: all };
    return {
      status: bad.length === results.length ? "error" : "warn", detail: all,
      fix: "Le détail de chaque serveur est dans Ressources → Serveurs MCP (bouton Tester).",
    };
  });
}

export async function checkMetrics(deps: CheckDeps): Promise<CheckResult> {
  return timed("metrics", "Métriques Prometheus", async () => {
    if (!deps.mgmtPort) return { status: "skipped", detail: "MGMT_PORT=0 : port de gestion désactivé." };
    const res = await deps.fetch(`http://127.0.0.1:${deps.mgmtPort}/metrics`, withTimeout(deps));
    const text = await res.text().catch(() => "");
    if (!res.ok || !text.includes("# HELP")) return { status: "error", detail: `Le port de gestion ${deps.mgmtPort} répond ${res.status}.` };
    return { status: "ok", detail: `Servies sur :${deps.mgmtPort}/metrics (à joindre par le ServiceMonitor, jamais par une Route).` };
  });
}

export async function checkOpa(deps: CheckDeps): Promise<CheckResult> {
  return timed("opa", "OPA", async () => {
    const url = (deps.env("OPA_URL") ?? "").replace(/\/+$/, "");
    if (!url) return { status: "skipped", detail: "OPA_URL non réglé : pas de pré-décision côté FounderOS (le serveur MCP décide de toute façon)." };
    const res = await deps.fetch(`${url}/health`, withTimeout(deps));
    return res.ok ? { status: "ok", detail: `${url} répond.` } : { status: "error", detail: `${url}/health répond ${res.status}.` };
  });
}

export async function checkSsoGuard(deps: CheckDeps, mode: string): Promise<CheckResult> {
  return timed("sso_guard", "Garde des connexions SSO", async () => {
    if (mode !== "shared") return { status: "skipped", detail: mode === "dedicated" ? "Installation dédiée : pas de contrôle par domaine." : "SSO fermé (SSO_MODE=off)." };
    const { data, error } = await deps.admin.rpc("sso_guard_installed");
    if (error || data !== true) {
      return { status: "error", detail: "Le déclencheur sur auth.identities (0282) est absent : le SSO partagé reste fermé.", fix: "Appliquez 0282 avec un rôle qui a les droits sur le schéma auth." };
    }
    return { status: "ok", detail: "Une connexion SSO hors des domaines vérifiés de son organisation est refusée." };
  });
}

export async function runChecks(deps: CheckDeps, ssoMode: string): Promise<CheckResult[]> {
  return await Promise.all([
    checkDatabase(deps), checkEncryption(deps), checkApprovalKey(deps), checkLlm(deps), checkIdp(deps),
    checkSsoGuard(deps, ssoMode), checkRelays(deps), checkMcpServers(deps), checkMetrics(deps), checkOpa(deps),
  ]);
}
