// Security source — runs non-destructive TCP port scans from the serverless
// environment. Consent is enforced server-side.
import net from "node:net";
import { rpc, RUNNER_ID, ts } from "../env.js";

const COMMON_PORTS = [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 587, 993, 995, 1433, 1521, 2375, 3000, 3306, 3389, 5432, 5601, 5900, 6379, 8000, 8080, 8443, 9200, 9300, 11211, 27017];
const SERVICE = {
  21: "FTP", 22: "SSH", 23: "Telnet", 25: "SMTP", 53: "DNS", 80: "HTTP", 110: "POP3",
  143: "IMAP", 443: "HTTPS", 445: "SMB", 587: "SMTP", 993: "IMAPS", 995: "POP3S",
  1433: "MSSQL", 1521: "Oracle", 2375: "Docker API", 3000: "App", 3306: "MySQL",
  3389: "RDP", 5432: "Postgres", 5601: "Kibana", 5900: "VNC", 6379: "Redis",
  8000: "App", 8080: "HTTP-alt", 8443: "HTTPS-alt", 9200: "Elasticsearch",
  9300: "Elasticsearch", 11211: "Memcached", 27017: "MongoDB",
};
const RISKY = new Set([23, 445, 1433, 2375, 3306, 3389, 5432, 5900, 6379, 9200, 11211, 27017]);

function checkPort(host, port, timeout = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open) => { if (!done) { done = true; socket.destroy(); resolve(open); } };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function portScan(host) {
  const open = [];
  const queue = [...COMMON_PORTS];
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const port = queue.shift();
      if (await checkPort(host, port)) open.push(port);
    }
  });
  await Promise.all(workers);
  open.sort((a, b) => a - b);
  return open.map((p) => ({ port: p, service: SERVICE[p] ?? "unknown", risky: RISKY.has(p) }));
}

async function runScan(scan) {
  const findings = [];
  const host = scan.target_host;
  if (scan.scan_type === "port_scan" || scan.scan_type === "full") {
    const ports = await portScan(host);
    for (const p of ports) {
      findings.push({
        severity: p.risky ? "high" : "info",
        title: `Open port ${p.port} (${p.service})`,
        detail: p.risky
          ? `${p.service} is reachable on ${host}:${p.port}. Should not be publicly exposed.`
          : `${p.service} reachable on ${host}:${p.port}.`,
        evidence: { host, port: p.port, service: p.service },
      });
    }
    if (ports.length === 0) {
      findings.push({ severity: "info", title: "No common ports open", detail: `None of the ${COMMON_PORTS.length} common ports responded on ${host}.`, evidence: { host } });
    }
  }
  return findings;
}

export async function pollSecurity() {
  let claimed;
  try {
    const resp = await rpc("security-scan-poll", { mode: "claim", runner_id: RUNNER_ID });
    claimed = resp?.scan ?? null;
  } catch (e) {
    if (!/HTTP 40|not found/i.test(e.message)) console.error(`[${ts()}] security claim: ${e.message}`);
    return { didWork: false };
  }
  if (!claimed || !claimed.id) return { didWork: false };

  const log = [`scan ${String(claimed.id).slice(0, 8)} — ${claimed.scan_type} on ${claimed.target_host}`];
  try {
    const findings = await runScan(claimed);
    await rpc("security-scan-poll", { mode: "complete", scan_id: claimed.id, status: "completed", findings });
    log.push(`completed — ${findings.length} findings`);
  } catch (e) {
    log.push(`error: ${e.message}`);
    await rpc("security-scan-poll", { mode: "complete", scan_id: claimed.id, status: "failed", error_message: e.message }).catch(() => {});
  }
  return { didWork: true, log };
}
