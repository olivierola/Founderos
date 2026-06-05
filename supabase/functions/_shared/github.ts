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
      "User-Agent": "FounderOS-Scanner",
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
      "User-Agent": "FounderOS-Agent",
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
    opts.prBody || "Automated changes proposed by the FounderOS agent.",
  );
  return { mode: "pull_request", branch: head, commit_sha: commitSha, pull_request: pr };
}
