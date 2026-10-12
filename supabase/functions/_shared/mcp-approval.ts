// Approbation des actions en production (installation dédiée,
// docs/openshift-implementation.md D6).
//
// 1. Un serveur MCP répond `approval_required` (action d'écriture sur un cluster
//    soumis à approbation). L'agent enregistre une demande `mcp_tool` : l'action
//    exacte (paramètres et empreinte calculée par le serveur), la personne pour
//    qui il agit, et une échéance à 15 minutes (internal-agent-tools.ts).
// 2. Une AUTRE personne, qui détient le rôle Keycloak ai-ops-prd-approver, la
//    valide. Le rôle est relu dans un jeton Keycloak frais, pas dans un cache
//    (gateMcpDecision, appelé par internal-agent-approve).
// 3. FounderOS signe un jeton d'approbation ES256, valable 5 minutes, lié au
//    demandeur, au tool, au cluster cible et à l'empreinte des paramètres. Le
//    serveur MCP le vérifie avec la clé publique (approvalJwks) ; OPA vérifie
//    ensuite que l'approbateur n'est pas le demandeur.
// 4. FounderOS rejoue l'appel avec les MÊMES paramètres, au nom du même
//    demandeur, avec l'en-tête X-Approval-Token (executeMcpApproval).
//
// Les identités signées sont celles de Keycloak (`sub`), les seules que le
// serveur MCP connaît : `sub` = le demandeur tel qu'il apparaît dans le jeton
// d'appel, `approver` = le `sub` Keycloak de l'approbateur.
//
// Variables : APPROVAL_ISSUER, APPROVAL_SIGNING_KEY (clé privée P-256, PKCS#8 PEM),
// APPROVAL_JWKS_EXTRA (clés publiques supplémentaires, rotation),
// APPROVAL_NOTIFY_WEBHOOK (facultatif : prévenir les approbateurs).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { signFounderosToken } from "./founderos-jwt.ts";
import {
  decodeJwtPayload, getUserIdpAccessToken, IdpError, idpRolesAndGroupsOf, subjectOfClaims, supabaseIdpTokenStore,
  type IdpTokenStore,
} from "./idp-tokens.ts";
import { mcpRequestHeaders, type McpTokenExchangeAuth } from "./mcp-auth.ts";
import { mcpCallTool } from "./mcp-client.ts";
import { resolveIdpConfig, supabaseIdpDirectory, type IdpDirectory } from "./idp-directory.ts";
import { callIdentity, classifyMcpResult, reportToolCall, traceIdFor } from "./mcp-observe.ts";
import { relayFetchFor } from "./mcp-relay.ts";
import { apiTokenHeaders, apiTokenSubject, loadMcpApiTokens } from "./mcp-api-token.ts";
import { userContextRoles } from "./user-context.ts";

/** Le rôle Keycloak des approbateurs. Le même nom est écrit dans la policy de
 *  la migration 0275 et dans le catalogue OPA (`approver_role`). */
export const PRD_APPROVER_ROLE = "ai-ops-prd-approver";
export const MCP_APPROVAL_TTL_MS = 15 * 60_000;
export const APPROVAL_TOKEN_TTL_S = 300;

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

// ── 1. Réponse du serveur MCP ───────────────────────────────────────────────

export interface McpApprovalRequired {
  tool: string;
  target_cluster: string;
  params_hash: string;
  /** Paramètres tels que le serveur les a lus, masqués : pour l'affichage. */
  params: unknown;
  message: string;
}

/** Lit une réponse `approval_required` dans le texte rendu par mcpCallTool. */
export function parseApprovalRequired(text: string): McpApprovalRequired | null {
  const body = text.replace(/^ERROR:\s*/, "").trim();
  if (!body.startsWith("{") || !body.includes("approval_required")) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(body); } catch { return null; }
  if (j.error !== "approval_required") return null;
  const tool = String(j.tool ?? "");
  const target = String(j.target_cluster ?? "");
  const hash = String(j.params_hash ?? "");
  // Mêmes formes que la contrainte de 0275 : une réponse mal formée n'ouvre pas
  // de demande.
  if (!/^[a-z0-9_]{1,64}$/.test(tool) || !/^[a-z0-9-]{1,30}$/.test(target) || !/^[0-9a-f]{64}$/.test(hash)) return null;
  return { tool, target_cluster: target, params_hash: hash, params: j.params ?? null, message: String(j.message ?? "").slice(0, 500) };
}

export interface McpApprovalPayload {
  server_id: string;
  server_name: string;
  tool: string;
  /** Les arguments envoyés par l'agent, rejoués tels quels après validation. */
  args: Record<string, unknown>;
  params: unknown;
  params_hash: string;
  target_cluster: string;
  audience: string;
  /** Le demandeur pour le serveur MCP : `oid` du jeton d'appel s'il existe, sinon `sub`. */
  requester_sub: string;
  /** Le fournisseur qui a délégué (auth_ref), s'il est précisé sur la connexion. */
  provider?: string;
  /** token_exchange (l'IdP atteste la personne) ou signed_context (FounderOS l'atteste). */
  identity_mode?: "token_exchange" | "signed_context" | "api_token";
  message: string;
}

export function buildMcpApprovalPayload(input: {
  /** auth : jeton émis par l'IdP ou contexte signé ; apiTokenAudience : jeton d'API (0278). */
  server: { id: string; name: string; auth?: McpTokenExchangeAuth; apiTokenAudience?: string | null };
  args: Record<string, unknown>;
  required: McpApprovalRequired;
  /** Le jeton d'appel (JWT) : le demandeur y est lu. */
  callToken?: string;
  /** Jeton d'API : le demandeur tel que le serveur le verra (mcp-api-token.ts). */
  requesterSub?: string;
}): McpApprovalPayload {
  const auth = input.server.auth;
  const sub = input.requesterSub ?? (input.callToken ? subjectOfClaims(decodeJwtPayload(input.callToken)) : "");
  if (!sub) throw new IdpError("no_subject", "Demandeur introuvable (jeton d'appel sans `sub`) : la demande d'approbation ne peut pas lui être liée.");
  const audience = auth?.audience ?? input.server.apiTokenAudience ?? "";
  if (!audience) {
    throw new IdpError("no_audience", "Ce serveur demande une approbation : renseignez son audience (son MCP_AUDIENCE, ex. mcp-prd) dans FounderOS, pour que le jeton d'approbation lui soit adressé.");
  }
  return {
    server_id: input.server.id,
    server_name: input.server.name,
    tool: input.required.tool,
    args: input.args ?? {},
    params: input.required.params,
    params_hash: input.required.params_hash,
    target_cluster: input.required.target_cluster,
    audience,
    requester_sub: sub,
    ...(auth?.provider ? { provider: auth.provider } : {}),
    identity_mode: auth ? auth.mode : "api_token",
    message: input.required.message,
  };
}

// ── 2. Décision ─────────────────────────────────────────────────────────────

export interface McpApprovalRow {
  id: string;
  agent_id: string;
  run_id: string | null;
  workspace_id: string | null;
  tool_name: string;
  action_kind: string;
  payload: Record<string, unknown>;
  status: string;
  requested_by: string | null;
  expires_at: string | null;
}

export interface IdpIdentity {
  sub: string;
  roles: string[];
}

export type GateResult =
  | { ok: true; approver: IdpIdentity | null }
  | { ok: false; status: number; error: string; expired?: boolean };

/**
 * Les règles d'une décision sur une demande `mcp_tool`. Pure : l'identité
 * Keycloak et l'appartenance à l'espace sont fournies par l'appelant.
 *   - approuver : pas le demandeur (ni sous son compte FounderOS, ni sous son
 *     identité Keycloak), membre de l'espace, rôle ai-ops-prd-approver dans un
 *     jeton frais, avant l'échéance, une action à la fois ;
 *   - refuser : le demandeur (il retire sa demande) ou un approbateur.
 */
export async function gateMcpDecision(
  row: McpApprovalRow,
  input: {
    userId: string;
    decision: "approve" | "approve_all" | "reject";
    now?: number;
    identity: () => Promise<IdpIdentity>;
    isWorkspaceMember: () => Promise<boolean>;
  },
): Promise<GateResult> {
  if (row.status !== "pending") return { ok: false, status: 409, error: `Demande déjà traitée (${row.status}).` };
  const now = input.now ?? Date.now();
  if (!row.expires_at || Date.parse(row.expires_at) <= now) {
    return { ok: false, status: 409, error: "Demande expirée : l'agent doit refaire sa demande.", expired: true };
  }
  if (input.decision === "approve_all") {
    return { ok: false, status: 400, error: "Une action en production s'approuve une par une." };
  }
  const isRequester = !!row.requested_by && row.requested_by === input.userId;
  if (input.decision === "reject" && isRequester) return { ok: true, approver: null };
  if (input.decision === "approve" && isRequester) {
    return { ok: false, status: 403, error: "Règle des quatre yeux : vous ne pouvez pas approuver une action demandée en votre nom." };
  }
  if (!(await input.isWorkspaceMember())) {
    return { ok: false, status: 403, error: "Vous n'êtes pas membre de l'espace de cette demande." };
  }
  let identity: IdpIdentity;
  try {
    identity = await input.identity();
  } catch (err) {
    const detail = err instanceof IdpError ? err.message : "identité Keycloak illisible";
    return { ok: false, status: 403, error: `Approbation impossible sans session SSO valide : ${detail}` };
  }
  if (!identity.roles.includes(PRD_APPROVER_ROLE)) {
    return { ok: false, status: 403, error: `Le rôle ${PRD_APPROVER_ROLE} est requis pour décider d'une action en production.` };
  }
  if (input.decision === "approve" && identity.sub === String(row.payload?.requester_sub ?? "")) {
    return { ok: false, status: 403, error: "Règle des quatre yeux : votre identité Keycloak est celle du demandeur." };
  }
  return { ok: true, approver: identity };
}

/**
 * Identité de la personne auprès de l'IdP qui délègue, lue dans un jeton
 * d'accès frais : la même que celle des jetons d'appel (`oid`, sinon `sub`).
 */
export async function liveIdpIdentity(
  admin: SupabaseClient | null,
  userId: string,
  store?: IdpTokenStore,
  provider?: string | null,
  directory?: IdpDirectory | null,
): Promise<IdpIdentity> {
  const dir = directory !== undefined ? directory : (admin ? supabaseIdpDirectory(admin) : null);
  const cfg = await resolveIdpConfig(dir, provider);
  if (!cfg) throw new IdpError("not_configured", "Aucun fournisseur d'identité ne délègue (Administration → Authentification).");
  const access = await getUserIdpAccessToken(cfg, store ?? supabaseIdpTokenStore(admin!), userId);
  return { sub: subjectOfClaims(decodeJwtPayload(access)), roles: idpRolesAndGroupsOf(access) };
}

/**
 * Identité de la personne quand c'est FounderOS qui l'atteste (contexte signé) :
 * son identifiant FounderOS — celui que portent ses jetons de contexte — et ses
 * rôles auprès de l'IdP de l'entreprise.
 */
export async function founderosIdentity(admin: SupabaseClient, userId: string): Promise<IdpIdentity> {
  return { sub: userId, roles: await userContextRoles(admin, userId) };
}

// ── 3. Jeton d'approbation ──────────────────────────────────────────────────

export { approvalJwks } from "./founderos-jwt.ts";

export interface SignedApproval {
  token: string;
  jti: string;
  iat: number;
  exp: number;
  kid: string;
}

export async function signApprovalToken(input: {
  audience: string;
  requesterSub: string;
  approverSub: string;
  approvalId: string;
  tool: string;
  targetCluster: string;
  paramsHash: string;
  /** Règle à quorum (G3) : tous les approbateurs, dans l'ordre des votes. Le serveur MCP
   *  vérifie qu'aucun n'est le demandeur, et son propre quorum s'il en fixe un. */
  approvers?: string[];
  now?: number;
}): Promise<SignedApproval> {
  const { token, iat, exp, kid } = await signFounderosToken({
    typ: "JWT",
    audience: input.audience,
    subject: input.requesterSub,
    ttlS: APPROVAL_TOKEN_TTL_S,
    jti: input.approvalId,
    now: input.now,
    claims: {
      approver: input.approverSub,
      ...(input.approvers?.length ? { approvers: [...new Set([...input.approvers, input.approverSub])] } : {}),
      tool: input.tool,
      target_cluster: input.targetCluster,
      params_hash: input.paramsHash,
    },
  });
  return { token, jti: input.approvalId, iat, exp, kid };
}

// ── 4. Rejeu ────────────────────────────────────────────────────────────────

/**
 * Rejoue l'action approuvée : mêmes paramètres, même demandeur, même agent, et
 * le jeton d'approbation. Le serveur MCP refait tous ses contrôles.
 */
export async function executeMcpApproval(
  admin: SupabaseClient,
  a: {
    id?: string; payload: Record<string, unknown>; agent_id?: string | null; run_id?: string | null;
    requested_by?: string | null; workspace_id?: string | null;
  },
  approvalToken: string,
  store?: IdpTokenStore,
): Promise<{ ok: boolean; detail: string }> {
  const started = Date.now();
  const p = a.payload as unknown as McpApprovalPayload;
  const { data: server } = await admin.from("mcp_servers")
    .select("id, name, url, enabled, auth_mode, auth_config, relay_id, workspace_id").eq("id", p.server_id).maybeSingle();
  const s = server as {
    id: string; name: string; url: string; enabled: boolean; auth_mode: string; auth_config: Record<string, unknown> | null;
    relay_id: string | null; workspace_id: string;
  } | null;
  if (!s || !s.enabled) return { ok: false, detail: "Serveur MCP introuvable ou désactivé depuis la demande." };
  const mode = s.auth_mode === "signed_context" ? "signed_context"
    : s.auth_mode === "token_exchange" ? "token_exchange"
    : s.auth_mode === "api_token" ? "api_token" : null;
  if (!mode || mode !== (p.identity_mode ?? "token_exchange") || s.auth_config?.audience !== p.audience) {
    return { ok: false, detail: "La configuration du serveur MCP a changé depuis la demande : rien n'est rejoué." };
  }
  if (!a.agent_id) return { ok: false, detail: "Demande sans agent." };
  const { data: agent } = await admin.from("internal_agents").select("id, name").eq("id", a.agent_id).maybeSingle();
  if (!agent) return { ok: false, detail: "Agent introuvable." };

  const cluster = typeof s.auth_config?.cluster === "string" ? s.auth_config.cluster : null;
  let headers: Record<string, string>;
  let sub: string;
  if (mode === "api_token") {
    // Jeton d'API (0278) : le même jeton, la même personne affirmée.
    const token = (await loadMcpApiTokens(admin, [s.id])).get(s.id);
    if (!token) return { ok: false, detail: "Le jeton d'API du serveur n'est plus enregistré : rien n'est rejoué." };
    headers = apiTokenHeaders({ token, userId: a.requested_by ?? null, agentName: (agent as { name?: string }).name ?? null, runId: a.run_id ?? null });
    sub = apiTokenSubject(token, a.requested_by ?? null);
  } else {
    const auth: McpTokenExchangeAuth = {
      mode,
      audience: p.audience,
      ...(cluster ? { cluster } : {}),
      ...(typeof s.auth_config?.provider === "string" ? { provider: s.auth_config.provider } : {}),
    };
    try {
      headers = await mcpRequestHeaders(admin, {
        url: s.url, auth, agent: agent as { id: string; name: string },
        userId: a.requested_by ?? null, tool: p.tool, runId: a.run_id ?? null, viaRelay: !!s.relay_id,
      }, store);
    } catch (err) {
      return { ok: false, detail: `Jeton d'appel refusé au rejeu : ${err instanceof Error ? err.message : String(err)}` };
    }
    sub = subjectOfClaims(decodeJwtPayload(headers.Authorization.slice("Bearer ".length)));
  }
  if (sub !== p.requester_sub) {
    return { ok: false, detail: "L'identité du demandeur a changé depuis la demande : rien n'est rejoué." };
  }
  const transport = s.relay_id ? { fetch: relayFetchFor(admin, { relayId: s.relay_id, workspaceId: s.workspace_id, mcpServerId: s.id }) } : {};
  const out = await mcpCallTool(s.url, { ...headers, "X-Approval-Token": approvalToken }, p.tool, p.args ?? {}, undefined, transport);
  const outcome = classifyMcpResult(out);
  reportToolCall({
    trace_id: traceIdFor(a.run_id), session_id: a.run_id ?? null, user: a.requested_by ?? null, ...callIdentity(headers),
    agent: (agent as { name?: string }).name ?? a.agent_id, workspace_id: a.workspace_id ?? null,
    mcp_server: s.name, cluster, tool: p.tool, status: outcome.status, reason: outcome.reason,
    policy_decision: null, approval_id: a.id ?? null, duration_ms: Date.now() - started,
  });
  return { ok: outcome.status === "ok", detail: out };
}

// ── Prévenir les approbateurs ───────────────────────────────────────────────

/** Lien direct vers la demande dans « Approbations PRD », ou "" s'il manque de quoi le former. */
async function approvalPageLink(input: { approvalId: string; admin?: SupabaseClient; workspaceId?: string; projectId?: string }): Promise<string> {
  const app = env("APP_BASE_URL").replace(/\/+$/, "");
  if (!app || !input.admin || !input.workspaceId || !input.projectId) return "";
  try {
    const [{ data: ws }, { data: pj }] = await Promise.all([
      input.admin.from("workspaces").select("slug").eq("id", input.workspaceId).maybeSingle(),
      input.admin.from("projects").select("slug").eq("id", input.projectId).maybeSingle(),
    ]);
    const w = (ws as { slug?: string } | null)?.slug;
    const p = (pj as { slug?: string } | null)?.slug;
    return w && p ? `${app}/app/${w}/${p}/admin/approbations-prd?id=${input.approvalId}` : "";
  } catch {
    return "";
  }
}

/** Au mieux : un webhook (Teams, Slack, outil d'astreinte) configuré par
 *  l'exploitation. Les approbateurs voient aussi la demande dans FounderOS. */
export async function notifyPrdApprovers(input: {
  approvalId: string;
  agentName?: string | null;
  payload: McpApprovalPayload;
  expiresAt: string;
  /** Qui doit approuver (règle G3, describeApprovers). */
  who?: string;
  /** Pour le lien vers « Approbations » (/app/<espace>/<projet>/admin/…). */
  admin?: SupabaseClient;
  workspaceId?: string;
  projectId?: string;
}): Promise<void> {
  await notifyApprovers({
    ...input,
    summary: `${input.payload.tool} sur ${input.payload.target_cluster} (serveur ${input.payload.server_name})`,
    details: { tool: input.payload.tool, target_cluster: input.payload.target_cluster, server: input.payload.server_name },
  });
}

/**
 * Prévient les approbateurs d'une demande, quel qu'en soit l'outil : un
 * webhook (Teams, Slack, outil d'astreinte) configuré par l'exploitation
 * (APPROVAL_NOTIFY_WEBHOOK). Les approbateurs voient aussi la demande dans
 * FounderOS, écran « Approbations ».
 */
export async function notifyApprovers(input: {
  approvalId: string;
  agentName?: string | null;
  summary: string;
  expiresAt: string;
  who?: string;
  details?: Record<string, unknown>;
  admin?: SupabaseClient;
  workspaceId?: string;
  projectId?: string;
}): Promise<void> {
  const url = env("APPROVAL_NOTIFY_WEBHOOK");
  if (!url) return;
  const link = await approvalPageLink(input);
  const text = `Approbation demandée : ${input.summary} (${input.agentName ?? "agent"}), avant ${input.expiresAt}.` +
    (input.who ? ` Réservée à ${input.who}.` : "") + (link ? ` ${link}` : "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        approval: {
          id: input.approvalId, ...(input.details ?? {}), summary: input.summary,
          agent: input.agentName ?? null, approvers: input.who ?? null, expires_at: input.expiresAt, url: link || null,
        },
      }),
      signal: ctrl.signal,
    });
  } catch { /* au mieux */ } finally {
    clearTimeout(timer);
  }
}
