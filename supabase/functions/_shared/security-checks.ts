// Passive, non-destructive security checks runnable in an edge function (no
// special network needed). They detect exposure and prove it, never exploit.

export interface Finding {
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  detail?: string;
  evidence?: Record<string, unknown>;
  remediation?: string;
}

function normUrl(target: string): string {
  let t = target.trim();
  if (!/^https?:\/\//i.test(t)) t = `https://${t}`;
  return t.replace(/\/+$/, "");
}

// ── Security headers ─────────────────────────────────────────────────────────
export async function checkHeaders(target: string): Promise<Finding[]> {
  const url = normUrl(target);
  const out: Finding[] = [];
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", redirect: "follow" });
  } catch (e) {
    return [{ severity: "medium", title: "Site unreachable", detail: `Could not fetch ${url}: ${e instanceof Error ? e.message : String(e)}` }];
  }
  const h = res.headers;
  const want: Array<{ key: string; sev: Finding["severity"]; why: string; fix: string }> = [
    { key: "strict-transport-security", sev: "high", why: "No HSTS — connections can be downgraded to HTTP.", fix: "Add 'Strict-Transport-Security: max-age=31536000; includeSubDomains'." },
    { key: "content-security-policy", sev: "medium", why: "No CSP — higher XSS / injection risk.", fix: "Define a Content-Security-Policy restricting script/style/connect sources." },
    { key: "x-content-type-options", sev: "low", why: "No X-Content-Type-Options — MIME sniffing possible.", fix: "Add 'X-Content-Type-Options: nosniff'." },
    { key: "x-frame-options", sev: "low", why: "No X-Frame-Options / frame-ancestors — clickjacking risk.", fix: "Add 'X-Frame-Options: DENY' or a CSP frame-ancestors directive." },
    { key: "referrer-policy", sev: "info", why: "No Referrer-Policy.", fix: "Add 'Referrer-Policy: strict-origin-when-cross-origin'." },
  ];
  for (const w of want) {
    if (!h.get(w.key)) out.push({ severity: w.sev, title: `Missing header: ${w.key}`, detail: w.why, remediation: w.fix, evidence: { url } });
  }
  // Server banner disclosure.
  const server = h.get("server");
  if (server && /\d/.test(server)) {
    out.push({ severity: "low", title: "Server version disclosed", detail: `Server header reveals "${server}".`, remediation: "Hide or genericise the Server header.", evidence: { server } });
  }
  if (out.length === 0) out.push({ severity: "info", title: "Security headers look good", detail: "All key security headers are present." });
  return out;
}

// ── TLS / HTTPS ──────────────────────────────────────────────────────────────
export async function checkTls(target: string): Promise<Finding[]> {
  const httpsUrl = normUrl(target).replace(/^http:/, "https:");
  const out: Finding[] = [];
  try {
    const res = await fetch(httpsUrl, { method: "HEAD" });
    if (res.ok || res.status < 500) out.push({ severity: "info", title: "HTTPS reachable", detail: `${httpsUrl} responds over TLS.` });
  } catch {
    out.push({ severity: "high", title: "HTTPS not available", detail: `${httpsUrl} is not reachable over TLS.`, remediation: "Serve the site over HTTPS with a valid certificate." });
  }
  // Plain-HTTP should redirect to HTTPS.
  try {
    const httpUrl = httpsUrl.replace(/^https:/, "http:");
    const res = await fetch(httpUrl, { method: "GET", redirect: "manual" });
    const loc = res.headers.get("location") ?? "";
    if (res.status >= 300 && res.status < 400 && loc.startsWith("https:")) {
      out.push({ severity: "info", title: "HTTP → HTTPS redirect", detail: "Plain HTTP correctly redirects to HTTPS." });
    } else if (res.status < 400) {
      out.push({ severity: "medium", title: "HTTP served without redirect", detail: "The site answers on plain HTTP without forcing HTTPS.", remediation: "Redirect all HTTP traffic to HTTPS." });
    }
  } catch { /* http not served at all — fine */ }
  return out;
}

// ── Sensitive file / path exposure ──────────────────────────────────────────
const EXPOSED_PATHS: Array<{ path: string; sev: Finding["severity"]; what: string }> = [
  { path: "/.env", sev: "critical", what: "Environment file with secrets" },
  { path: "/.git/config", sev: "high", what: "Exposed .git repository" },
  { path: "/.git/HEAD", sev: "high", what: "Exposed .git repository" },
  { path: "/config.json", sev: "medium", what: "Config file" },
  { path: "/.aws/credentials", sev: "critical", what: "AWS credentials" },
  { path: "/backup.sql", sev: "high", what: "Database backup" },
  { path: "/.DS_Store", sev: "low", what: "Directory listing artefact" },
  { path: "/server-status", sev: "medium", what: "Apache server-status" },
  { path: "/actuator/env", sev: "high", what: "Spring actuator env" },
  { path: "/phpinfo.php", sev: "medium", what: "phpinfo()" },
];
export async function checkExposure(target: string): Promise<Finding[]> {
  const base = normUrl(target);
  const out: Finding[] = [];
  await Promise.all(EXPOSED_PATHS.map(async (e) => {
    try {
      const res = await fetch(base + e.path, { method: "GET", redirect: "manual" });
      if (res.status === 200) {
        const body = (await res.text()).slice(0, 200);
        // Soft confirmation it's not an SPA fallback returning index.html.
        const looksReal = !/<!doctype html>|<html/i.test(body) || e.path.includes(".git");
        if (looksReal) {
          out.push({
            severity: e.sev, title: `Exposed: ${e.path}`,
            detail: `${e.what} is publicly readable at ${base}${e.path}.`,
            remediation: `Block public access to ${e.path}.`,
            evidence: { url: base + e.path, status: 200, preview: body.slice(0, 120) },
          });
        }
      }
    } catch { /* unreachable = good */ }
  }));
  if (out.length === 0) out.push({ severity: "info", title: "No sensitive files exposed", detail: "Checked common sensitive paths — none publicly readable." });
  return out;
}

export async function runPassiveCheck(scanType: string, target: string): Promise<Finding[]> {
  switch (scanType) {
    case "headers": return checkHeaders(target);
    case "tls": return checkTls(target);
    case "exposure": return checkExposure(target);
    default: return [{ severity: "info", title: `Unsupported passive check: ${scanType}` }];
  }
}
