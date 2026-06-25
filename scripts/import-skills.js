// Import skills from skills_repo into Supabase agent_skills table.
// Usage: node scripts/import-skills.js

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SKILLS_ROOT = join(import.meta.dirname, "..", "skills_repo");

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const eq = line.indexOf(":");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.startsWith("'") || val.startsWith('"')) val = val.slice(1, -1);
    meta[key] = val;
  }
  return { meta, body: m[2].trim() };
}

function collectScripts(skillDir) {
  const scriptsDir = join(skillDir, "scripts");
  if (!existsSync(scriptsDir)) return [];
  return readdirSync(scriptsDir)
    .filter((f) => f.endsWith(".py") || f.endsWith(".js") || f.endsWith(".sh") || f.endsWith(".sql"))
    .map((f) => ({
      name: f,
      content: readFileSync(join(scriptsDir, f), "utf-8").slice(0, 5000),
    }));
}

function collectReferences(skillDir) {
  const refsDir = join(skillDir, "references");
  if (!existsSync(refsDir)) return [];
  return readdirSync(refsDir)
    .filter((f) => f.endsWith(".md") || f.endsWith(".txt") || f.endsWith(".json"))
    .map((f) => ({
      name: f,
      content: readFileSync(join(refsDir, f), "utf-8").slice(0, 3000),
    }));
}

function findSkillDirs(root) {
  const result = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    const skillFile = join(dir, "SKILL.md");
    if (existsSync(skillFile)) {
      result.push(dir);
      return; // Don't recurse into sub-skills
    }
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
    }
  }
  walk(root);
  return result;
}

const CATEGORY_MAP = {
  "Anthropic-Cybersecurity-Skills": "cybersecurity",
  "data-analytics-skills": "data-analytics",
  "skills": "general",
};

async function main() {
  const repos = ["Anthropic-Cybersecurity-Skills", "data-analytics-skills", "skills"];
  let total = 0;
  let inserted = 0;

  for (const repo of repos) {
    const repoDir = repo === "skills" ? join(SKILLS_ROOT, repo, "skills") : join(SKILLS_ROOT, repo);
    if (repo === "Anthropic-Cybersecurity-Skills") {
      // Skills are in skills/ subdir
      const skillsDir = join(SKILLS_ROOT, repo, "skills");
      const dirs = findSkillDirs(skillsDir);
      console.log(`${repo}: ${dirs.length} skills found`);

      for (const dir of dirs) {
        const content = readFileSync(join(dir, "SKILL.md"), "utf-8");
        const { meta, body } = parseFrontmatter(content);
        const scripts = collectScripts(dir);
        const references = collectReferences(dir);
        const slug = meta.name || basename(dir);

        const row = {
          workspace_id: null,
          name: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          slug,
          description: (meta.description || "").slice(0, 500),
          category: CATEGORY_MAP[repo] || "general",
          icon: "Shield",
          system_prompt_extension: body.slice(0, 8000),
          required_tools: ["web_search", "deep_research"],
          config: {
            domain: meta.domain || null,
            subdomain: meta.subdomain || null,
            tags: meta.tags ? meta.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
            scripts: scripts.length > 0 ? scripts : undefined,
            references: references.length > 0 ? references : undefined,
          },
          is_system: true,
        };

        const { error } = await supabase.from("agent_skills").insert(row);
        if (error) {
          if (error.message.includes("duplicate") || error.message.includes("unique")) { /* skip duplicate */ }
          else console.error(`  skip ${slug}: ${error.message}`);
        } else {
          inserted++;
        }
        total++;
      }
    } else {
      const dirs = findSkillDirs(repoDir);
      console.log(`${repo}: ${dirs.length} skills found`);

      for (const dir of dirs) {
        const content = readFileSync(join(dir, "SKILL.md"), "utf-8");
        const { meta, body } = parseFrontmatter(content);
        const scripts = collectScripts(dir);
        const references = collectReferences(dir);
        const slug = meta.name || basename(dir);

        const category = CATEGORY_MAP[repo] || "general";
        const icon = category === "data-analytics" ? "BarChart3" : "Zap";

        const row = {
          workspace_id: null,
          name: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          slug,
          description: (meta.description || "").slice(0, 500),
          category,
          icon,
          system_prompt_extension: body.slice(0, 8000),
          required_tools: category === "data-analytics" ? ["db_read", "deep_research"] : ["web_search"],
          config: {
            scripts: scripts.length > 0 ? scripts : undefined,
            references: references.length > 0 ? references : undefined,
          },
          is_system: true,
        };

        const { error } = await supabase.from("agent_skills").upsert(row, { onConflict: "slug" }).select("id");
        if (error) {
          console.error(`  skip ${slug}: ${error.message}`);
        } else {
          inserted++;
        }
        total++;
      }
    }
  }

  console.log(`\nDone: ${inserted}/${total} skills imported.`);
}

main().catch(console.error);
