import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createClient } from "@supabase/supabase-js";

const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function findSkills(dir) {
  const result = [];
  if (!existsSync(dir)) return result;
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (!statSync(full).isDirectory()) continue;
    if (existsSync(join(full, "SKILL.md"))) result.push(full);
    else result.push(...findSkills(full));
  }
  return result;
}

function detectTools(slug, text) {
  const t = [];
  const b = text.toLowerCase();
  if (/browse|navigat|web page|screenshot|click|selenium|playwright/.test(b) || slug.includes("webapp-testing") || slug.includes("frontend")) t.push("browse_web");
  if (/\bsearch\b|research|gather information|osint|reconnaissance/.test(b)) t.push("web_search");
  if (/deep research|multiple sources|cross-reference|literature review/.test(b)) t.push("deep_research");
  if (/read.?url|fetch.?url|scrape|jina|extract.*page/.test(b)) t.push("web_fetch");
  if (/database|query|sql|\btable\b|data.*warehouse/.test(b)) t.push("db_read");
  if (/deliverable|report|document|produce|generate.*output|write.*report|create.*file/.test(b)) t.push("create_deliverable");
  if (/\bemail\b|send.*message|notification/.test(b)) t.push("send_email");
  if (/\bapi\b|\bhttp\b|endpoint|rest\b/.test(b)) t.push("http_get");
  if (/connector|hubspot|salesforce|pipedrive|intercom/.test(b)) t.push("connector_action");
  if (/\bscan\b|vulnerab|pentest|exploit|nmap|nuclei|burp/.test(b)) t.push("security_scan");
  if (/memory|remember|persist|store.*knowledge/.test(b)) t.push("save_memory");
  if (t.length === 0) t.push("create_deliverable");
  return [...new Set(t)];
}

function detectTags(slug, text) {
  const t = [];
  const b = text.toLowerCase();
  if (/docx|word doc/.test(b)) t.push("Word");
  if (/\bpdf\b/.test(b)) t.push("PDF");
  if (/pptx|presentation|slides/.test(b)) t.push("Slides");
  if (/xlsx|spreadsheet|excel/.test(b)) t.push("Excel");
  if (/markdown|documentation/.test(b)) t.push("Docs");
  if (/design|ui\b|layout|visual|css|tailwind|figma/.test(b)) t.push("Design");
  if (/\bcode\b|program|develop|build|typescript|python|rust/.test(b)) t.push("Code");
  if (/\btest|qa\b|validation|assertion|playwright/.test(b)) t.push("Testing");
  if (/analy|metric|insight|kpi|dashboard/.test(b)) t.push("Analysis");
  if (/research|investigat|osint|reconnaissance/.test(b)) t.push("Research");
  if (/\bwrite|content|copy|comms|narrative|storytell/.test(b)) t.push("Writing");
  if (/automat|workflow|pipeline|orchestrat/.test(b)) t.push("Automation");
  if (/security|vulnerab|threat|malware|forensic|incident|attack|defense|exploit/.test(b)) t.push("Security");
  if (/compliance|audit|governance|nist|iso|soc|gdpr|cmmc|pci/.test(b)) t.push("Compliance");
  if (/network|firewall|dns|packet|tcp|ids|ips/.test(b)) t.push("Network");
  if (/cloud|aws|azure|gcp|kubernetes|docker|container/.test(b)) t.push("Cloud");
  if (/\bapi\b|mcp|integration|webhook/.test(b)) t.push("API");
  if (/\bdata\b|dataset|etl|warehouse/.test(b)) t.push("Data");
  if (/visual|chart|graph|plot|dashboard/.test(b)) t.push("Visualization");
  if (/gif|image|art|canvas|illustration|svg/.test(b)) t.push("Creative");
  if (/reverse.?engineer|decompil|disassembl|binary|malware/.test(b)) t.push("Reverse Engineering");
  if (/log|siem|splunk|elastic|detect|alert|monitor/.test(b)) t.push("Detection");
  if (/crypto|encrypt|hash|tls|certificate/.test(b)) t.push("Cryptography");
  if (/active.?directory|ldap|kerberos|ntlm|windows/.test(b)) t.push("Active Directory");
  if (/phish|social.?engineer|email.*attack/.test(b)) t.push("Phishing");
  if (/incident.?response|triage|contain|eradicat/.test(b)) t.push("Incident Response");
  if (t.length === 0) t.push("General");
  return [...new Set(t)].slice(0, 4);
}

const repos = [
  { dir: join(import.meta.dirname, "..", "skills_repo", "Anthropic-Cybersecurity-Skills", "skills") },
  { dir: join(import.meta.dirname, "..", "skills_repo", "data-analytics-skills") },
  { dir: join(import.meta.dirname, "..", "skills_repo", "skills", "skills") },
];

let updated = 0, total = 0;
for (const repo of repos) {
  const dirs = findSkills(repo.dir);
  for (const d of dirs) {
    const raw = readFileSync(join(d, "SKILL.md"), "utf-8");
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const meta = {};
    if (m) for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-z_-]+)\s*:\s*(.+)$/);
      if (kv) meta[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, "");
    }
    const slug = meta.name || basename(d);
    const body = raw.replace(/^---[\s\S]*?---\r?\n?/, "");
    const fullText = body + " " + (meta.description || "") + " " + slug;

    const tools = detectTools(slug, fullText);
    const tags = detectTags(slug, fullText);

    const { error, data: rows } = await s.from("agent_skills")
      .update({ required_tools: tools, config: { tags } })
      .eq("slug", slug).is("workspace_id", null)
      .select("id");

    total++;
    if (!error && rows?.length) updated++;
  }
}

// Seed system skills
const seeds = [
  { slug: "web-researcher", tools: ["web_search", "web_fetch", "deep_research"], tags: ["Research", "Analysis"] },
  { slug: "browser-navigator", tools: ["browse_web"], tags: ["Browser", "Automation"] },
  { slug: "code-analyst", tools: ["web_fetch", "db_read"], tags: ["Code", "Analysis"] },
  { slug: "data-analyst", tools: ["db_read", "deep_research"], tags: ["Data", "Analysis"] },
  { slug: "content-writer", tools: ["web_search", "deep_research", "create_deliverable"], tags: ["Writing", "Research"] },
  { slug: "security-auditor", tools: ["web_search", "browse_web", "deep_research", "security_scan"], tags: ["Security", "Compliance"] },
  { slug: "recruiter", tools: ["web_search", "browse_web", "connector_action"], tags: ["HR", "Research"] },
];
for (const su of seeds) {
  await s.from("agent_skills").update({ required_tools: su.tools, config: { tags: su.tags } }).eq("slug", su.slug).is("workspace_id", null);
  updated++;
}

console.log(`Updated ${updated}/${total + seeds.length} skills with proper tools + tags`);
