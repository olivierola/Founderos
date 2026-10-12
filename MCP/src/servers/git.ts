// mcp-git — sur IPS : pull requests sur GitHub, au nom d'une GitHub App.
//
// L'agent ne modifie jamais l'état désiré directement : il propose. La branche
// est toujours ai/<id>, les dépôts et chemins sont des listes blanches, la
// description porte le diagnostic, les preuves, l'impact et le demandeur. La
// GitHub App n'a ni le droit d'approuver ni celui de fusionner (protection de
// branche + CODEOWNERS) ; ce serveur n'expose de toute façon aucun des deux.

import { createPrivateKey, randomBytes } from "node:crypto";
import { SignJWT } from "jose";
import { z } from "zod";
import { requestJson, UpstreamError } from "../lib/http.ts";
import { credentialRefSchema } from "../lib/secrets.ts";
import type { ServerModule } from "../lib/server.ts";
import { defineTool, ToolInputError } from "../lib/tool.ts";

export const gitConfig = z.object({
  apiUrl: z.string().url().default("https://api.github.com"),
  appId: z.string().min(1),
  installationId: z.string().min(1),
  /** Clé privée PEM de la GitHub App (KV du Vault IPS). */
  privateKey: credentialRefSchema,
  caFile: z.string().optional(),
  /** "org/dépôt" → chemins modifiables (motifs * et **) et branche de base. */
  repos: z.record(z.string().regex(/^[\w.-]+\/[\w.-]+$/), z.object({
    paths: z.array(z.string().min(1)).min(1),
    base: z.string().default("main"),
  })),
  maxFiles: z.number().int().min(1).max(50).default(10),
  maxFileBytes: z.number().int().min(1).max(1_000_000).default(100_000),
});
export type GitConfig = z.infer<typeof gitConfig>;

/** Motif de chemin → expression régulière : `**` traverse les dossiers, `*` non. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function isAllowedPath(path: string, patterns: string[]): boolean {
  if (path.startsWith("/") || path.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) return false;
  if (path === ".github" || path.startsWith(".github/")) return false; // jamais les workflows ni CODEOWNERS
  return patterns.some((p) => globToRegExp(p).test(path));
}

export const gitServer: ServerModule<GitConfig> = {
  name: "mcp-git",
  configSchema: gitConfig,
  createTools({ config, secrets }) {
    const api = config.apiUrl.replace(/\/$/, "");
    const repoEnum = z.enum(Object.keys(config.repos) as [string, ...string[]]);

    const installationToken = async (repo: string): Promise<string> => {
      const pem = await secrets.resolve(config.privateKey, {});
      const now = Math.floor(Date.now() / 1000);
      const appJwt = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(config.appId)
        .setIssuedAt(now - 60)
        .setExpirationTime(now + 540)
        .sign(createPrivateKey(pem));
      // Jeton d'installation réduit au seul dépôt visé et aux seules permissions utiles.
      const res = await requestJson<{ token: string }>(`${api}/app/installations/${config.installationId}/access_tokens`, {
        method: "POST",
        headers: { Authorization: `Bearer ${appJwt}`, Accept: "application/vnd.github+json" },
        caFile: config.caFile,
        json: { repositories: [repo.split("/")[1]], permissions: { contents: "write", pull_requests: "write" } },
      });
      return res.token;
    };

    return [
      defineTool({
        name: "pr_create",
        description: "Propose un changement de configuration par pull request (branche ai/<id>). Revue humaine obligatoire ; jamais de merge.",
        write: true,
        input: {
          repo: repoEnum,
          title: z.string().min(10).max(120),
          diagnostic: z.string().min(20).max(4000).describe("Ce qui a été constaté et pourquoi ce changement"),
          evidence: z.array(z.string().max(500)).min(1).max(20).describe("Preuves : requêtes, liens Grafana, événements"),
          impact: z.string().min(10).max(2000).describe("Impact attendu et risques"),
          files: z.array(z.object({
            path: z.string().min(1).max(300),
            content: z.string(),
          })).min(1),
        },
        validate({ repo, files }) {
          const rule = config.repos[repo];
          if (files.length > config.maxFiles) throw new ToolInputError(`${files.length} fichiers : ${config.maxFiles} au plus`);
          for (const f of files) {
            if (!isAllowedPath(f.path, rule.paths)) throw new ToolInputError(`Chemin non autorisé dans ${repo} : ${f.path}`);
            if (Buffer.byteLength(f.content) > config.maxFileBytes) throw new ToolInputError(`${f.path} dépasse ${config.maxFileBytes} octets`);
          }
          if (new Set(files.map((f) => f.path)).size !== files.length) throw new ToolInputError("Chemin en double");
        },
        async run({ repo, title, diagnostic, evidence, impact, files }, ctx) {
          const rule = config.repos[repo];
          const token = await installationToken(repo);
          const gh = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
          const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(4).toString("hex")}`;
          const branch = `ai/${id}`;

          const baseRef = await requestJson<{ object: { sha: string } }>(`${api}/repos/${repo}/git/ref/heads/${encodeURIComponent(rule.base)}`, { headers: gh, caFile: config.caFile });
          await requestJson(`${api}/repos/${repo}/git/refs`, { method: "POST", headers: gh, caFile: config.caFile, json: { ref: `refs/heads/${branch}`, sha: baseRef.object.sha } });

          for (const f of files) {
            let sha: string | undefined;
            try {
              const existing = await requestJson<{ sha: string }>(`${api}/repos/${repo}/contents/${f.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`, { headers: gh, caFile: config.caFile });
              sha = existing.sha;
            } catch (err) {
              if (!(err instanceof UpstreamError && err.status === 404)) throw err;
            }
            await requestJson(`${api}/repos/${repo}/contents/${f.path.split("/").map(encodeURIComponent).join("/")}`, {
              method: "PUT", headers: gh, caFile: config.caFile,
              json: { message: `${title}\n\nai: ${f.path}`, content: Buffer.from(f.content).toString("base64"), branch, ...(sha ? { sha } : {}) },
            });
          }

          const requester = ctx.identity.username ?? ctx.identity.sub;
          const body = [
            "## Diagnostic", diagnostic, "",
            "## Preuves", ...evidence.map((e) => `- ${e}`), "",
            "## Impact attendu", impact, "",
            "---",
            `Demandé par **${requester}**, préparé par l'agent \`${ctx.identity.azp}\` (trace \`${ctx.traceId}\`).`,
            "Revue humaine obligatoire : cette pull request ne doit pas être fusionnée sans relecture.",
          ].join("\n");
          const pr = await requestJson<{ number: number; html_url: string }>(`${api}/repos/${repo}/pulls`, {
            method: "POST", headers: gh, caFile: config.caFile,
            json: { title, head: branch, base: rule.base, body, maintainer_can_modify: true },
          });
          return { repo, number: pr.number, url: pr.html_url, branch };
        },
      }),
    ];
  },
};
