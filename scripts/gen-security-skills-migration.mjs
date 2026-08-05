// Generates supabase/migrations/0131_security_skills.sql from the strix
// playbooks (Apache-2.0). Each strix skill category becomes a founderOS agent
// skill (agent_skills, is_system, workspace_id=null) with a concise methodology
// system_prompt_extension; every playbook markdown becomes an agent_skill_files
// row so the agent pulls a specific one on demand (progressive disclosure via
// read_skill_file). Uses Postgres dollar-quoting so markdown needs no escaping.
//
// Run:  node scripts/gen-security-skills-migration.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const STRIX = join(ROOT, "strix", "strix", "skills");
const OUT = join(ROOT, "supabase", "migrations", "0131_security_skills.sql");

// A dollar tag guaranteed not to collide with markdown content.
const TAG = "$SKILL$";
const q = (s) => `${TAG}${s}${TAG}`;

// One founderOS skill per useful strix category. Each pulls its playbooks from
// the matching strix folder(s).
const SKILLS = [
  {
    slug: "pentest-web-app",
    name: "Web Application Pentester",
    icon: "ShieldAlert",
    description:
      "Authorized web-app penetration testing: methodology + on-demand playbooks for SQLi, XSS, SSRF, IDOR, XXE, RCE, SSTI, auth/JWT, CSRF, path traversal and more. Validates findings with real proofs-of-concept.",
    folders: ["vulnerabilities", "protocols", "technologies"],
    methodology: [
      "You are an expert web-application penetration tester operating under EXPLICIT AUTHORIZATION.",
      "",
      "AUTHORIZATION FIRST — non-negotiable:",
      "- Before ANY active test (crafted requests, scanners, exploit attempts) confirm the target is IN an authorized pentest scope. Call pentest_scope to read the approved targets; if the target is not covered, STOP and ask a human to authorize it (do not test it).",
      "- Never test third-party systems, production data you could damage, or anything outside the declared scope. Prefer non-destructive proofs; never exfiltrate real user data beyond a minimal proof.",
      "",
      "METHODOLOGY (adapt, don't blindly follow):",
      "1. RECON & MAP — enumerate the surface: routes, params, auth flows, APIs, tech stack, headers. Use shell_exec (curl, nmap, ffuf, whatweb…) and sandbox_browser for JS-heavy apps. Log every endpoint with notes/update_todos.",
      "2. PRIORITIZE — pick the vuln classes the surface actually exposes. Read the matching playbook with read_skill_file(slug=\"pentest-web-app\", path=\"vulnerabilities/<class>.md\") RIGHT BEFORE testing that class — one at a time, keep context lean.",
      "3. TEST — craft precise requests with http_request (a security-testing repeater: any method/headers/body, in scope only) and shell tools. Iterate: baseline → mutate → observe differentials.",
      "4. VALIDATE — confirm each finding with a concrete, minimal proof-of-concept. No PoC ⇒ not a finding (avoid false positives).",
      "5. REPORT — for each confirmed issue create_deliverable(kind=\"report\") with: title, severity (CVSS-ish), affected endpoint/param, reproduction steps, PoC, impact, and a concrete fix. Rank by real risk.",
      "",
      "Use render_ui for a findings table (columns: severity, class, endpoint, status) and a severity breakdown chart in your summary. Real data only.",
    ].join("\n"),
  },
  {
    slug: "pentest-recon",
    name: "Recon & Attack Surface",
    icon: "Radar",
    description:
      "Authorized reconnaissance & attack-surface mapping: passive/active discovery, subdomains, ports, services, tech fingerprinting, exposed assets — feeding a prioritized target list.",
    folders: ["scan_modes"],
    methodology: [
      "You map the attack surface of AUTHORIZED targets only (confirm via pentest_scope first).",
      "",
      "1. PASSIVE FIRST — public sources, DNS, cert transparency, wayback, tech fingerprints. Non-intrusive.",
      "2. ACTIVE (in scope) — subdomain enumeration, port/service scan (nmap), content discovery (ffuf/gobuster), header/TLS review. Run these via shell_exec in the sandbox; pace them, don't hammer.",
      "3. FINGERPRINT — identify frameworks, servers, WAFs, third-party services and their known weak spots.",
      "4. PRIORITIZE — produce a ranked target list (asset, exposure, why it matters) as a create_deliverable report; hand off high-value targets to a web-app pentester agent (delegate_mission) when useful.",
      "Choose scan depth with read_skill_file(slug=\"pentest-recon\", path=\"scan_modes/<quick|standard|deep>.md\").",
    ].join("\n"),
  },
  {
    slug: "appsec-code-review",
    name: "AppSec Code Reviewer",
    icon: "ShieldCheck",
    description:
      "Security-focused source code review: finds injection, authz gaps, secrets, insecure deserialization, SSRF and crypto misuse in the code itself — with exact file/line and a fix.",
    folders: ["vulnerabilities"],
    filesOnly: true, // reuse the vuln playbooks as reference, no separate methodology folder scan
    methodology: [
      "You review SOURCE CODE for security defects (SAST-style, but precise — no false-positive noise).",
      "",
      "1. MAP — read the repo layout, entry points, routes, auth middleware, data access. Use file_read / shell_exec (ripgrep) to trace tainted input from source to sink.",
      "2. HUNT — for each risky sink (SQL, shell, template, deserialization, file path, outbound fetch) trace whether untrusted input reaches it unsanitized. Pull the matching playbook with read_skill_file(slug=\"appsec-code-review\", path=\"vulnerabilities/<class>.md\") for exploitation nuances.",
      "3. CONFIRM — cite the exact file and line; explain the tainted path. Skip anything you can't substantiate.",
      "4. REPORT — create_deliverable(kind=\"report\"): severity, file:line, vulnerable code excerpt, why it's exploitable, and a concrete patch. Group by severity.",
      "Never invent findings; a finding needs a real tainted source→sink path.",
    ].join("\n"),
  },
];

function readPlaybooks(folder) {
  const dir = join(STRIX, folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort()
    .map((f, i) => ({ path: `${folder}/${f}`, content: readFileSync(join(dir, f), "utf-8"), sort: i }));
}

function assertNoTag(content, path) {
  if (content.includes(TAG)) throw new Error(`Playbook ${path} contains the dollar tag ${TAG} — pick another tag.`);
}

const out = [];
out.push("-- 0131_security_skills.sql");
out.push("-- AUTO-GENERATED by scripts/gen-security-skills-migration.mjs from the");
out.push("-- strix playbooks (Apache-2.0). Do not edit by hand — regenerate instead.");
out.push("-- System agent skills (workspace_id = null) for authorized security testing,");
out.push("-- with each vulnerability/recon playbook as a progressive-disclosure file.");
out.push("");

for (const skill of SKILLS) {
  let files = [];
  let s = 0;
  for (const folder of skill.folders) {
    for (const pb of readPlaybooks(folder)) {
      assertNoTag(pb.content, pb.path);
      files.push({ ...pb, sort: s++ });
    }
  }
  out.push(`-- ── ${skill.name} (${files.length} playbooks) ──────────────────────────`);
  // Idempotent regen without ON CONFLICT inference (the unique index on the
  // nullable workspace_id can't serve as an arbiter): delete the system skill
  // by slug (files cascade), then re-insert.
  out.push(`delete from public.agent_skills where workspace_id is null and slug = ${q(skill.slug)};`);
  out.push(`insert into public.agent_skills (workspace_id, name, slug, description, category, icon, system_prompt_extension, required_tools, is_system)`);
  out.push(`values (null, ${q(skill.name)}, ${q(skill.slug)}, ${q(skill.description)}, ${q("cybersecurity")}, ${q(skill.icon)}, ${q(skill.methodology)},`);
  out.push(`  '{shell_exec,http_request,sandbox_browser,file_read,web_search}', true);`);
  out.push("");
  for (const f of files) {
    assertNoTag(f.path, f.path);
    out.push(`insert into public.agent_skill_files (skill_id, path, content, sort)`);
    out.push(`  select id, ${q(f.path)}, ${q(f.content)}, ${f.sort} from public.agent_skills where workspace_id is null and slug = ${q(skill.slug)};`);
  }
  out.push("");
}

writeFileSync(OUT, out.join("\n"), "utf-8");
const totalFiles = SKILLS.reduce((n, sk) => n + sk.folders.reduce((m, f) => m + readPlaybooks(f).length, 0), 0);
console.log(`Wrote ${OUT}\n  ${SKILLS.length} skills · ${totalFiles} playbook files`);
