// Resolve a usable GitHub token for a project, REUSING the GitHub connection the
// user established in the Connectors tab (Composio) when present, and falling
// back to the legacy per-connector encrypted PAT (connect-github). This lets the
// GitHub repos features (list / browse / scan / vibe-code) work off a single
// connection instead of asking for a separate token.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { decryptSecret } from "./crypto.ts";
import { getComposio } from "./composio.ts";
import type { GitHubRepo } from "./github.ts";

export interface GithubTokenResult {
  token: string;
  source: "composio" | "legacy";
}

// Composio exposes the OAuth access token on the connected account for OAuth2
// toolkits; the exact field has moved across SDK versions, so probe the known
// shapes defensively.
export function extractComposioToken(acct: unknown): string | null {
  const a = (acct ?? {}) as Record<string, any>;
  const candidates = [
    a?.data?.access_token, a?.data?.oauth_token, a?.data?.token, a?.data?.authToken,
    a?.params?.access_token,
    a?.connectionParams?.val?.access_token, a?.connectionParams?.access_token,
    a?.connectionData?.val?.access_token, a?.connectionData?.access_token,
    a?.val?.access_token, a?.state?.val?.access_token,
    a?.credentials?.access_token, a?.authConfig?.credentials?.access_token,
    a?.metadata?.access_token,
  ];
  for (const c of candidates) {
    // Composio masks OAuth tokens as the literal "REDACTED" (and sometimes an
    // all-asterisks placeholder). Never treat those as usable tokens, or GitHub
    // answers "Bad credentials" — we route through Composio execution instead.
    if (typeof c === "string" && c.length > 10 && c !== "REDACTED" && !c.includes("REDACTED") && !/^\*+$/.test(c)) {
      return c;
    }
  }
  return null;
}

async function composioGithubToken(connectedAccountId: string): Promise<string | null> {
  try {
    const composio = getComposio();
    const acct = await composio.connectedAccounts.get(connectedAccountId);
    return extractComposioToken(acct);
  } catch {
    return null;
  }
}

export async function resolveGithubToken(
  admin: SupabaseClient,
  workspaceId: string,
  projectId: string,
): Promise<GithubTokenResult | null> {
  const { data: rows } = await admin
    .from("connectors")
    .select("id, source, status, composio_connected_account_id")
    .eq("workspace_id", workspaceId)
    .eq("project_id", projectId)
    .eq("provider", "github");
  const connectors = (rows ?? []) as Array<{ id: string; source: string | null; status: string | null; composio_connected_account_id: string | null }>;

  // 1) Prefer the Composio connection from the Connectors tab. We do NOT gate
  // on our cached `status`: it's only written while the connect dialog polls,
  // so a connection finalised after the dialog closed (or via a popup opened
  // separately) can sit at "pending" forever even though Composio has it
  // ACTIVE. Composio is the source of truth — a stale status must not block a
  // real connection. We only skip connections our table knows are dead.
  const DEAD = new Set(["invalid_credentials", "revoked"]);
  const cx = connectors.find((r) => r.source === "composio" && r.composio_connected_account_id && !DEAD.has(r.status ?? ""));
  if (cx?.composio_connected_account_id) {
    const token = await composioGithubToken(cx.composio_connected_account_id);
    if (token) return { token, source: "composio" };
  }

  // 2) Fall back to the legacy per-connector encrypted PAT (connect-github).
  const legacy = connectors.find((r) => r.source !== "composio");
  if (legacy) {
    const { data: cred } = await admin
      .from("encrypted_credentials")
      .select("encrypted_payload, iv")
      .eq("connector_id", legacy.id)
      .maybeSingle();
    if (cred) {
      const token = await decryptSecret((cred as { encrypted_payload: string }).encrypted_payload, (cred as { iv: string }).iv);
      if (token) return { token, source: "legacy" };
    }
  }

  return null;
}

// The Composio connected-account id for the project's GitHub connection, when
// GitHub was connected through the Connectors tab (Composio) and is active.
export async function getComposioGithubAccount(
  admin: SupabaseClient,
  workspaceId: string,
  projectId: string,
): Promise<string | null> {
  const { data: rows } = await admin
    .from("connectors")
    .select("source, status, composio_connected_account_id")
    .eq("workspace_id", workspaceId)
    .eq("project_id", projectId)
    .eq("provider", "github");
  // Same rationale as resolveGithubToken: don't require our cached status to be
  // "connected" (it lags behind Composio). Accept any Composio github connector
  // that isn't known-dead; the live Composio listing call is the real check.
  const DEAD = new Set(["invalid_credentials", "revoked"]);
  const cx = (rows ?? []).find(
    (r: Record<string, unknown>) =>
      r.source === "composio" && r.composio_connected_account_id && !DEAD.has(String(r.status ?? "")),
  ) as { composio_connected_account_id?: string } | undefined;
  return cx?.composio_connected_account_id ?? null;
}

// Composio masks the raw GitHub OAuth token, so when we can't resolve a usable
// token we instead PROXY the "list repositories for the authenticated user"
// call through Composio's tool execution (the connection does the auth). Returns
// null when the action is unavailable / fails so callers can surface an error.
const LIST_REPOS_SLUGS = [
  "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
  "GITHUB_REPOS_LIST_FOR_THE_AUTHENTICATED_USER",
];

function findRepoArray(v: unknown): Record<string, unknown>[] | null {
  const isRepoArr = (x: unknown): x is Record<string, unknown>[] =>
    Array.isArray(x) && x.every((e) => e && typeof e === "object") && x.some((e) => "full_name" in (e as object));
  if (isRepoArr(v)) return v;
  if (Array.isArray(v)) return null;
  if (v && typeof v === "object") {
    for (const k of ["data", "details", "response_data", "items", "repositories", "result", "body"]) {
      const found = findRepoArray((v as Record<string, unknown>)[k]);
      if (found) return found;
    }
  }
  return null;
}

// Composio's GitHub toolkit exposes different repo-listing actions across
// versions (there isn't always a plain "list my repos"), so DISCOVER the
// available slugs and try the listing-ish ones, then our known candidates.
async function repoListingSlugs(composio: ReturnType<typeof getComposio>): Promise<string[]> {
  try {
    const raw = (await composio.tools.getRawComposioTools({ toolkits: ["github"], limit: 300 } as Record<string, unknown>)) as unknown;
    const list = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>;
    const discovered = list
      .map((t) => String(t.slug ?? ""))
      .filter((s) => /REPO/.test(s) && /(LIST|ACCESSIBLE|SEARCH)/.test(s) && !/(CREATE|DELETE|UPDATE|FORK|WATCH|STAR|TOPIC|CONTENT|COMMIT|BRANCH|ISSUE|PULL)/.test(s));
    return [...new Set([...discovered, ...LIST_REPOS_SLUGS])];
  } catch {
    return [...LIST_REPOS_SLUGS];
  }
}

export async function listReposViaComposio(
  connectedAccountId: string,
  projectId: string,
): Promise<GitHubRepo[] | null> {
  const composio = getComposio();
  const slugs = await repoListingSlugs(composio);
  for (const slug of slugs) {
    try {
      const res = (await composio.tools.execute(slug, {
        userId: projectId,
        connectedAccountId,
        arguments: { per_page: 100 },
        dangerouslySkipVersionCheck: true,
      } as Record<string, unknown>)) as { data?: unknown; successful?: boolean };
      if (res?.successful === false) continue;
      let arr = findRepoArray(res?.data) ?? findRepoArray(res);
      if (!arr && Array.isArray(res?.data)) arr = res.data as Record<string, unknown>[];
      if (arr) {
        return arr.map((r) => ({
          id: Number(r.id),
          name: String(r.name ?? ""),
          full_name: String(r.full_name ?? ""),
          private: !!r.private,
          default_branch: String(r.default_branch ?? "main"),
          description: (r.description as string | null) ?? null,
          html_url: String(r.html_url ?? ""),
          language: (r.language as string | null) ?? null,
          updated_at: String(r.updated_at ?? ""),
        }));
      }
    } catch {
      // try the next candidate slug
    }
  }
  return null;
}
