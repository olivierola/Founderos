// Minimal GitHub REST helper. Uses a Personal Access Token (PAT) supplied by the user.

const GITHUB_API = "https://api.github.com";

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  html_url: string;
  language: string | null;
  updated_at: string;
}

async function gh<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Anduran-Scanner",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/** POST/PATCH/PUT helper for write operations. */
async function ghWrite<T>(
  token: string,
  method: "POST" | "PATCH" | "PUT",
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Anduran-Agent",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status} on ${method} ${path}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export async function listUserRepos(token: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh<GitHubRepo[]>(
      token,
      `/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator&page=${page}`,
    );
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

export async function fetchFileContent(
  token: string,
  fullName: string,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    const data = await gh<{ content?: string; encoding?: string }>(
      token,
      `/repos/${fullName}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
    );
    if (!data.content) return null;
    if (data.encoding === "base64") {
      // GitHub returns base64 with line breaks
      const clean = data.content.replace(/\n/g, "");
      return atob(clean);
    }
    return data.content;
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) return null;
    throw err;
  }
}

export async function listRepoTree(
  token: string,
  fullName: string,
  ref: string,
): Promise<string[]> {
  const data = await gh<{ tree: { path: string; type: string }[]; truncated: boolean }>(
    token,
    `/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  );
  return data.tree.filter((n) => n.type === "blob").map((n) => n.path);
}

// ===========================================================================
// WRITE OPERATIONS — used by the agent to instrument / modify code.
// These require a token with `repo` (contents:write) scope.
// ===========================================================================

export interface FileChange {
  /** Repo-relative path, e.g. "src/analytics.ts". */
  path: string;
  /** New file content (full file). */
  content: string;
}

/** Resolve a branch name to its current commit SHA. */
export async function getBranchSha(token: string, fullName: string, branch: string): Promise<string> {
  const data = await gh<{ object: { sha: string } }>(
    token,
    `/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  return data.object.sha;
}

/** Create a new branch pointing at `fromSha`. No-op-safe: throws if it exists. */
export async function createBranch(
  token: string,
  fullName: string,
  newBranch: string,
  fromSha: string,
): Promise<void> {
  await ghWrite(token, "POST", `/repos/${fullName}/git/refs`, {
    ref: `refs/heads/${newBranch}`,
    sha: fromSha,
  });
}

/**
 * Commit a set of file changes to `branch` in a single commit using the Git
 * data API (blobs → tree → commit → update ref). Handles many files atomically.
 * Returns the new commit SHA.
 */
export async function commitFiles(
  token: string,
  fullName: string,
  branch: string,
  baseSha: string,
  changes: FileChange[],
  message: string,
): Promise<string> {
  // 1. Base commit → base tree
  const baseCommit = await gh<{ tree: { sha: string } }>(
    token,
    `/repos/${fullName}/git/commits/${baseSha}`,
  );
  const baseTreeSha = baseCommit.tree.sha;

  // 2. Create a blob per file
  const treeItems = await Promise.all(
    changes.map(async (c) => {
      const blob = await ghWrite<{ sha: string }>(token, "POST", `/repos/${fullName}/git/blobs`, {
        content: c.content,
        encoding: "utf-8",
      });
      return { path: c.path, mode: "100644" as const, type: "blob" as const, sha: blob.sha };
    }),
  );

  // 3. New tree based on the base tree
  const newTree = await ghWrite<{ sha: string }>(token, "POST", `/repos/${fullName}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeItems,
  });

  // 4. New commit
  const commit = await ghWrite<{ sha: string }>(token, "POST", `/repos/${fullName}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [baseSha],
  });

  // 5. Move the branch ref to the new commit
  await ghWrite(token, "PATCH", `/repos/${fullName}/git/refs/heads/${encodeURIComponent(branch)}`, {
    sha: commit.sha,
    force: false,
  });

  return commit.sha;
}

export interface PullRequest {
  number: number;
  html_url: string;
  state: string;
}

/** Open a pull request from `head` into `base`. */
export async function createPullRequest(
  token: string,
  fullName: string,
  head: string,
  base: string,
  title: string,
  body: string,
): Promise<PullRequest> {
  return await ghWrite<PullRequest>(token, "POST", `/repos/${fullName}/pulls`, {
    title,
    head,
    base,
    body,
    maintainer_can_modify: true,
  });
}

/** Default branch of a repo (used when caller doesn't pass one). */
export async function getDefaultBranch(token: string, fullName: string): Promise<string> {
  const data = await gh<{ default_branch: string }>(token, `/repos/${fullName}`);
  return data.default_branch;
}

// ── Fork-based contribution flow (for repos the token can read but not push) ──
export interface RepoInfo {
  full_name: string;
  default_branch: string;
  fork: boolean;
  archived?: boolean;
  disabled?: boolean;
  private?: boolean;
  owner?: { login: string; type: string };
  permissions?: { push?: boolean; admin?: boolean; maintain?: boolean };
  parent?: { full_name: string; default_branch: string } | null;
}
export async function getRepoInfo(token: string, fullName: string): Promise<RepoInfo> {
  return await gh<RepoInfo>(token, `/repos/${fullName}`);
}

/** The login of the token's owner (used to build the fork's full name). */
export async function getAuthenticatedLogin(token: string): Promise<string> {
  const u = await gh<{ login: string }>(token, "/user");
  return u.login;
}

/** Fork a repo under the token owner's account (idempotent — returns existing fork). */
export async function forkRepo(token: string, fullName: string): Promise<{ full_name: string; owner: { login: string }; default_branch: string }> {
  return await ghWrite(token, "POST", `/repos/${fullName}/forks`, {});
}

/** Poll until a branch is queryable (a freshly-created fork takes a moment). */
export async function waitForRepoBranch(token: string, fullName: string, branch: string, tries = 12): Promise<string> {
  let lastErr: unknown = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await getBranchSha(token, fullName, branch);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("fork not ready");
}

// ── CI / checks: read the state of a PR head so the agent can react to failures ─
export interface CheckRun {
  id: number;
  name: string;
  status: string;                 // queued | in_progress | completed
  conclusion: string | null;      // success | failure | timed_out | cancelled | action_required | neutral | skipped
  html_url: string | null;
  output: { title: string | null; summary: string | null } | null;
}
export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: string;       // failure | warning | notice
  message: string;
  title: string | null;
}

/** GitHub Actions / apps check-runs for a commit ref (PR head sha or branch). */
export async function listCheckRuns(token: string, fullName: string, ref: string): Promise<CheckRun[]> {
  const data = await gh<{ check_runs: CheckRun[] }>(
    token, `/repos/${fullName}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
  );
  return data.check_runs ?? [];
}

/** Per-line annotations (compiler/lint/test errors) attached to a check run. */
export async function listCheckAnnotations(token: string, fullName: string, checkRunId: number): Promise<CheckAnnotation[]> {
  try {
    return await gh<CheckAnnotation[]>(token, `/repos/${fullName}/check-runs/${checkRunId}/annotations?per_page=50`);
  } catch {
    return [];
  }
}

export interface PullDetail {
  number: number;
  title: string;
  state: string;               // open | closed
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;     // clean | blocked | dirty | unstable | behind | unknown
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
  html_url: string;
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  base: { ref: string };
}
export async function getPullRequest(token: string, fullName: string, number: number): Promise<PullDetail> {
  return await gh<PullDetail>(token, `/repos/${fullName}/pulls/${number}`);
}

/** Merge a PR. method: merge | squash | rebase. Throws on non-mergeable / no access. */
export async function mergePullRequest(
  token: string, fullName: string, number: number, method: "merge" | "squash" | "rebase" = "squash",
): Promise<{ merged: boolean; message: string; sha?: string }> {
  return await ghWrite(token, "PUT", `/repos/${fullName}/pulls/${number}/merge`, { merge_method: method });
}

/** Legacy commit-status API (some CI report here instead of check-runs). */
export async function getCombinedStatus(
  token: string, fullName: string, ref: string,
): Promise<{ state: string; statuses: { context: string; state: string; description: string | null; target_url: string | null }[] }> {
  try {
    return await gh(token, `/repos/${fullName}/commits/${encodeURIComponent(ref)}/status`);
  } catch {
    return { state: "pending", statuses: [] };
  }
}

/**
 * High-level helper: apply `changes` to a repo either as a PR (recommended) or a
 * direct commit to the base branch. Returns a summary with the commit + PR.
 */
export async function applyChanges(
  token: string,
  fullName: string,
  opts: {
    changes: FileChange[];
    commitMessage: string;
    mode: "pull_request" | "direct";
    baseBranch?: string;
    /** For PR mode: the new branch name. Auto-generated when omitted. */
    headBranch?: string;
    prTitle?: string;
    prBody?: string;
  },
): Promise<{ mode: string; branch: string; commit_sha: string; pull_request?: PullRequest }> {
  const base = opts.baseBranch || (await getDefaultBranch(token, fullName));
  const baseSha = await getBranchSha(token, fullName, base);

  if (opts.mode === "direct") {
    const commitSha = await commitFiles(token, fullName, base, baseSha, opts.changes, opts.commitMessage);
    return { mode: "direct", branch: base, commit_sha: commitSha };
  }

  // pull_request mode
  const head =
    opts.headBranch ||
    `founderos/agent-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 7)}`;
  await createBranch(token, fullName, head, baseSha);
  const commitSha = await commitFiles(token, fullName, head, baseSha, opts.changes, opts.commitMessage);
  const pr = await createPullRequest(
    token,
    fullName,
    head,
    base,
    opts.prTitle || opts.commitMessage,
    opts.prBody || "Automated changes proposed by the Anduran agent.",
  );
  return { mode: "pull_request", branch: head, commit_sha: commitSha, pull_request: pr };
}
