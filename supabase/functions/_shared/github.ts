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
