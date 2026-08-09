// Generates the agent-skill catalogue migrations from skills_repo/.
//
// skills_repo/ holds four upstream skill packs in the Agent-Skills format (a
// folder per skill with SKILL.md + optional references/ and scripts/). This
// script turns each one into:
//   - an agent_skills row (workspace_id = null → system skill, available to
//     every workspace, activatable per agent, browsable in the skill library)
//   - one agent_skill_files row per bundled reference/script, so the agent
//     pulls them on demand with read_skill_file (progressive disclosure)
//     instead of carrying them in context.
//
// Why a migration and not a direct import: the DB is provisioned from
// supabase/migrations, so a catalogue that only exists in one database is a
// catalogue that disappears on the next environment. Same approach as
// scripts/gen-security-skills-migration.mjs (0131).
//
// Run:  node scripts/gen-skills-repo-migrations.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const REPO = join(ROOT, "skills_repo");
const OUTDIR = join(ROOT, "supabase", "migrations");

// ── Packs ────────────────────────────────────────────────────────────────────
// `root` is scanned recursively for folders containing a SKILL.md.
const PACKS = [
  {
    id: "engineering",
    migration: "0166_skills_engineering.sql",
    title: "Software engineering skills (agent-skills pack)",
    root: join(REPO, "agent-skills", "skills"),
    category: () => "engineering",
    icon: "Code2",
    source: "obra/agent-skills",
  },
  {
    id: "productivity",
    migration: "0167_skills_productivity.sql",
    title: "Document, design & app-building skills (Anthropic skills pack)",
    root: join(REPO, "skills", "skills"),
    category: () => "productivity",
    icon: "Sparkles",
    source: "anthropics/skills",
  },
  {
    id: "data",
    migration: "0168_skills_data_analytics.sql",
    title: "Data analytics skills",
    root: join(REPO, "data-analytics-skills"),
    // Parent folder carries the family: "01-data-quality-validation".
    category: (dir) => {
      const parent = basename(join(dir, ".."));
      return parent.replace(/^\d+-/, "") || "data-analytics";
    },
    icon: "BarChart3",
    source: "data-analytics-skills",
  },
  {
    id: "cybersecurity",
    // 817 skills — split so no generated file is unreasonably large.
    migration: (i) => `${String(169 + i).padStart(4, "0")}_skills_cybersecurity_${i + 1}.sql`,
    chunk: 105,
    title: "Cybersecurity skills",
    root: join(REPO, "Anthropic-Cybersecurity-Skills", "skills"),
    // This pack ships a ~9 KB generic Python scaffold per skill (9 MB across the
    // pack) that duplicates what our agents already do with their own execution
    // tools. Only the reference notes are worth carrying — they are what
    // read_skill_file is for.
    files: { include: /^references\/.*\.md$/, max: 4, maxBytes: 16_000 },
    // The subdomain (threat-hunting, cloud-security, digital-forensics…) is a
    // far more useful facet than the single "cybersecurity" domain.
    category: (_dir, meta) => meta.subdomain || meta.domain || "cybersecurity",
    icon: "ShieldAlert",
    source: "mukul975/Anthropic-Cybersecurity-Skills",
  },
];

// Slugs already taken by hand-written system skills (0089, 0131, 0151-0156).
// A pack skill colliding with one of them gets a pack suffix instead of
// silently overwriting it.
const RESERVED = new Set([
  "web-researcher", "browser-navigator", "code-analyst", "data-analyst",
  "content-writer", "security-auditor", "recruiter", "report-designer",
  "revenue-ops", "support-excellence", "ecommerce-ops",
  "appsec-code-review", "pentest-recon", "pentest-web-app",
]);

// Bundled files worth shipping: text only, capped, so a skill stays a skill and
// not a software distribution. Binaries/assets are skipped.
const FILE_EXTS = new Set([".md", ".txt", ".py", ".sh", ".sql", ".json", ".yaml", ".yml", ".js", ".ts", ".csv"]);
const MAX_FILE_BYTES = 32_000;
const MAX_FILES_PER_SKILL = 12;
const MAX_BODY_CHARS = 60_000;

// ── YAML-ish frontmatter ─────────────────────────────────────────────────────
// Handles the three shapes these packs actually use: `key: value`, folded/literal
// blocks (`key: >-` / `key: |`) and block sequences (`key:` then `- item`).
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content.trim() };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let val = kv[2].trim();
    i++;
    if (val === ">" || val === ">-" || val === "|" || val === "|-") {
      // Folded / literal block: consume the indented lines that follow.
      const block = [];
      while (i < lines.length && (lines[i].trim() === "" || /^\s+/.test(lines[i]))) {
        block.push(lines[i].replace(/^\s+/, ""));
        i++;
      }
      meta[key] = block.join(val.startsWith(">") ? " " : "\n").trim();
      continue;
    }
    if (val === "") {
      // Block sequence, or a plain multi-line scalar continued by indentation.
      const items = [];
      const cont = [];
      while (i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i]))) {
        const t = lines[i].trim();
        if (t.startsWith("- ")) items.push(unquote(t.slice(2).trim()));
        else if (t) cont.push(t);
        i++;
      }
      meta[key] = items.length ? items : cont.join(" ").trim();
      continue;
    }
    // Inline value, possibly continued by indented lines (the packs wrap long
    // descriptions this way).
    const cont = [unquote(val)];
    while (i < lines.length && /^\s+\S/.test(lines[i]) && !/^\s*-\s/.test(lines[i])) {
      cont.push(lines[i].trim());
      i++;
    }
    meta[key] = cont.join(" ").trim();
    // Inline list: `tags:` on its own line handled above; `[a, b]` here.
    if (/^\[.*\]$/.test(meta[key])) {
      meta[key] = meta[key].slice(1, -1).split(",").map((x) => unquote(x.trim())).filter(Boolean);
    }
  }
  return { meta, body: m[2].trim() };
}
const unquote = (s) => s.replace(/^['"]|['"]$/g, "").trim();

// ── Tool & tag inference ─────────────────────────────────────────────────────
// Same heuristics the existing catalogue uses (scripts/fix-skill-tools.js), so
// imported skills are labelled consistently with the hand-written ones.
function detectTools(slug, text, hasPy, hasSh) {
  const t = [];
  const b = text.toLowerCase();
  if (/browse|navigat|web page|screenshot|click|selenium|playwright/.test(b) || slug.includes("webapp-testing") || slug.includes("frontend")) t.push("browse_web");
  if (/\bsearch\b|research|gather information|osint|reconnaissance/.test(b)) t.push("web_search");
  if (/deep research|multiple sources|cross-reference|literature review/.test(b)) t.push("deep_research");
  if (/read.?url|fetch.?url|scrape|jina|extract.*page/.test(b)) t.push("web_fetch");
  if (/database|query|sql|\btable\b|data.*warehouse/.test(b)) t.push("db_read");
  if (/\bapi\b|\bhttp\b|endpoint|rest\b/.test(b)) t.push("http_get");
  if (/\bscan\b|vulnerab|pentest|exploit|nmap|nuclei|burp/.test(b)) t.push("security_scan");
  if (hasPy || /```python|python3?\s/.test(b)) t.push("python_exec");
  if (hasSh || /```(bash|sh)\b|\bcurl\b|\bgrep\b|command line/.test(b)) t.push("shell_exec");
  t.push("create_deliverable");
  return [...new Set(t)];
}

function detectTags(text, meta) {
  const fromMeta = Array.isArray(meta.tags) ? meta.tags : typeof meta.tags === "string" && meta.tags ? meta.tags.split(",") : [];
  const t = fromMeta.map((x) => String(x).trim()).filter(Boolean);
  const b = text.toLowerCase();
  const add = (re, tag) => { if (re.test(b) && !t.includes(tag)) t.push(tag); };
  add(/design|ui\b|layout|visual|css|tailwind|figma/, "Design");
  add(/\bcode\b|program|develop|build|typescript|python|rust/, "Code");
  add(/\btest|qa\b|validation|assertion|playwright/, "Testing");
  add(/analy|metric|insight|kpi|dashboard/, "Analysis");
  add(/research|investigat|osint|reconnaissance/, "Research");
  add(/automat|workflow|pipeline|orchestrat/, "Automation");
  add(/security|vulnerab|threat|malware|forensic|incident/, "Security");
  add(/compliance|audit|governance|nist|iso|soc|gdpr|cmmc|pci/, "Compliance");
  add(/cloud|aws|azure|gcp|kubernetes|docker|container/, "Cloud");
  add(/\bdata\b|dataset|etl|warehouse/, "Data");
  return t.slice(0, 12);
}

const ICON_BY_CATEGORY = [
  [/forensic|incident|malware|ransomware/, "Bug"],
  [/threat|hunt|intel/, "Radar"],
  [/cloud|container|kubernetes/, "Cloud"],
  [/network/, "Network"],
  [/identity|access|zero-trust/, "KeyRound"],
  [/compliance|governance/, "Scale"],
  [/red-team|penetration|offensive/, "Swords"],
  [/data|quality|analysis|analytics/, "BarChart3"],
  [/documentation|knowledge|communication|storytelling/, "FileText"],
  [/workflow|optimization/, "Workflow"],
];
function iconFor(category, fallback) {
  const c = (category || "").toLowerCase();
  for (const [re, icon] of ICON_BY_CATEGORY) if (re.test(c)) return icon;
  return fallback;
}

// ── Filesystem walk ──────────────────────────────────────────────────────────
function findSkillDirs(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    if (existsSync(join(dir, "SKILL.md"))) { out.push(dir); return; } // don't recurse into a skill
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (e === ".git" || e === "node_modules") continue;
      let st; try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.sort();
}

function collectFiles(skillDir, policy = {}) {
  const include = policy.include ?? null;
  const maxBytes = policy.maxBytes ?? MAX_FILE_BYTES;
  const max = policy.max ?? MAX_FILES_PER_SKILL;
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      let st; try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      if (e === "SKILL.md" || e === "LICENSE" || e === "LICENSE.txt") continue;
      if (!FILE_EXTS.has(extname(e).toLowerCase())) continue;
      if (st.size > maxBytes || st.size === 0) continue;
      const path = relative(skillDir, full).replace(/\\/g, "/");
      if (include && !include.test(path)) continue;
      files.push({ path, size: st.size, abs: full });
    }
  };
  walk(skillDir);
  // References before scripts, smallest first — the useful ones survive the cap.
  files.sort((a, b) => (a.path.startsWith("references/") === b.path.startsWith("references/") ? a.size - b.size : a.path.startsWith("references/") ? -1 : 1));
  return files.slice(0, max);
}

// ── SQL emission ─────────────────────────────────────────────────────────────
/** A dollar-quote tag guaranteed not to appear in the content. */
function tagFor(...contents) {
  for (const t of ["$S$", "$SK$", "$SKILL$", "$SKQ1$", "$SKQ2$", "$SKQ3$"]) {
    if (!contents.some((c) => String(c).includes(t))) return t;
  }
  throw new Error("no safe dollar-quote tag");
}
const q = (s, tag) => `${tag}${s ?? ""}${tag}`;
const pgArray = (arr) => `'{${arr.map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(",")}}'`;

function titleCase(slug) {
  return slug.split(/[-_]/).filter(Boolean)
    .map((w) => (w.length <= 3 && w === w.toLowerCase() && !["api", "sql", "dns", "iam"].includes(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/^./, (c) => c.toUpperCase());
}

function skillSql(s) {
  const tag = tagFor(s.name, s.description, s.body, s.configJson);
  const lines = [];
  lines.push(
    `insert into public.agent_skills (workspace_id, name, slug, description, category, icon, system_prompt_extension, required_tools, config, is_system) values`,
    `  (null, ${q(s.name, tag)}, ${q(s.slug, tag)}, ${q(s.description, tag)}, ${q(s.category, tag)}, ${q(s.icon, tag)}, ${q(s.body, tag)}, ${pgArray(s.tools)}, ${q(s.configJson, tag)}::jsonb, true)`,
    `on conflict (slug) where workspace_id is null do update set`,
    `  name = excluded.name, description = excluded.description, category = excluded.category,`,
    `  icon = excluded.icon, system_prompt_extension = excluded.system_prompt_extension,`,
    `  required_tools = excluded.required_tools, config = excluded.config, is_system = true;`,
  );
  for (const f of s.files) {
    const ftag = tagFor(f.content, f.path);
    lines.push(
      `insert into public.agent_skill_files (skill_id, path, content, sort)`,
      `  select id, ${q(f.path, ftag)}, ${q(f.content, ftag)}, ${f.sort} from public.agent_skills where workspace_id is null and slug = ${q(s.slug, ftag)}`,
      `on conflict (skill_id, path) do update set content = excluded.content, updated_at = now();`,
    );
  }
  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────
const seenSlugs = new Set(RESERVED);
let totalSkills = 0, totalFiles = 0;
const written = [];

for (const pack of PACKS) {
  const dirs = findSkillDirs(pack.root);
  if (dirs.length === 0) { console.warn(`! ${pack.id}: nothing found under ${pack.root}`); continue; }
  const skills = [];

  for (const dir of dirs) {
    const raw = readFileSync(join(dir, "SKILL.md"), "utf8");
    const { meta, body } = parseFrontmatter(raw);
    if (!body.trim()) continue;

    let slug = String(meta.name || basename(dir)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    if (!slug) continue;
    if (seenSlugs.has(slug)) slug = `${slug}-${pack.id}`.slice(0, 60);
    if (seenSlugs.has(slug)) continue; // still colliding → skip rather than clobber
    seenSlugs.add(slug);

    const files = collectFiles(dir, pack.files).map((f, i) => ({
      path: f.path,
      sort: i,
      content: readFileSync(f.abs, "utf8").replace(/\r\n/g, "\n"),
    })).filter((f) => f.content.trim());

    const hasPy = files.some((f) => f.path.endsWith(".py"));
    const hasSh = files.some((f) => f.path.endsWith(".sh"));
    const category = pack.category(dir, meta);
    const description = String(meta.description || "").replace(/\s+/g, " ").trim().slice(0, 500)
      || `${titleCase(slug)} — imported skill playbook.`;

    skills.push({
      slug,
      name: String(meta.title || titleCase(slug)).slice(0, 120),
      description,
      category: String(category).slice(0, 60),
      icon: iconFor(category, pack.icon),
      body: body.slice(0, MAX_BODY_CHARS),
      tools: detectTools(slug, `${description}\n${body}`, hasPy, hasSh),
      configJson: JSON.stringify({
        source: pack.source,
        pack: pack.id,
        domain: meta.domain ?? null,
        subdomain: meta.subdomain ?? null,
        tags: detectTags(`${description}\n${body}`, meta),
        files: files.length,
      }),
      files,
    });
    totalFiles += files.length;
  }
  totalSkills += skills.length;

  const chunks = pack.chunk
    ? Array.from({ length: Math.ceil(skills.length / pack.chunk) }, (_, i) => skills.slice(i * pack.chunk, (i + 1) * pack.chunk))
    : [skills];

  chunks.forEach((chunk, i) => {
    const file = typeof pack.migration === "function" ? pack.migration(i) : pack.migration;
    const header = [
      `-- ${file}`,
      `-- AUTO-GENERATED by scripts/gen-skills-repo-migrations.mjs from skills_repo/.`,
      `-- Do not edit by hand — regenerate instead.`,
      `-- ${pack.title}${chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : ""}: ${chunk.length} system skills`,
      `-- (workspace_id = null → available to every workspace, activatable per agent).`,
      `-- Source: ${pack.source}`,
      ``,
    ].join("\n");
    writeFileSync(join(OUTDIR, file), `${header}\n${chunk.map(skillSql).join("\n\n")}\n`, "utf8");
    written.push({ file, skills: chunk.length, kb: Math.round(chunk.reduce((n, s) => n + s.body.length + s.files.reduce((m, f) => m + f.content.length, 0), 0) / 1024) });
  });

  console.log(`${pack.id}: ${skills.length} skills, ${skills.reduce((n, s) => n + s.files.length, 0)} bundled files`);
}

console.log(`\n${totalSkills} skills, ${totalFiles} files → ${written.length} migration(s):`);
for (const w of written) console.log(`  ${w.file}  (${w.skills} skills, ~${w.kb} KB)`);
