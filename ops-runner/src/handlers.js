// Job-type handlers.
//
// Each handler receives ({ job, connection, api, log }) and returns
// { status, result, exitCode, error }. The poll loop persists that to FounderOS.
//
// Handlers that touch a server fetch the connection via api.credential() —
// they do NOT receive the credential from the job payload, so a malicious
// or replayed job can't escalate to a different server.

import { execOverSsh } from "./ssh.js";

// Single source of truth for the discovery / health probe.
async function probeServer({ connection, log }) {
  const commands = [
    { step: "os", run: "cat /etc/os-release | head -n 5" },
    { step: "arch", run: "uname -m" },
    { step: "cpu", run: "nproc" },
    { step: "ram", run: "awk '/MemTotal/ {print $2}' /proc/meminfo" },
    { step: "disk", run: "df -BG / | tail -n 1 | awk '{print $2}' | tr -d 'G'" },
    { step: "docker", run: "command -v docker >/dev/null && echo yes || echo no", allow_failure: true },
    { step: "nginx", run: "command -v nginx >/dev/null && echo yes || echo no", allow_failure: true },
    { step: "ufw", run: "ufw status 2>/dev/null | head -n 1 || echo 'Status: inactive'", allow_failure: true },
    { step: "fail2ban", run: "systemctl is-active fail2ban 2>/dev/null || echo inactive", allow_failure: true },
    { step: "ssh_root", run: "grep -E '^PermitRootLogin' /etc/ssh/sshd_config | head -n 1", allow_failure: true },
    { step: "ssh_password", run: "grep -E '^PasswordAuthentication' /etc/ssh/sshd_config | head -n 1", allow_failure: true },
    { step: "open_ports", run: "ss -tlnp | awk 'NR>1 {print $4}' | awk -F: '{print $NF}' | sort -u | tr '\\n' ',' | sed 's/,$//'", allow_failure: true },
  ];
  return await execOverSsh(connection, commands, log);
}

function parseProbe(outputs) {
  const byStep = Object.fromEntries(outputs.map((o) => [o.step, (o.stdout ?? "").trim()]));
  // Extract OS name + version from /etc/os-release.
  const osNameMatch = byStep.os?.match(/^NAME="?([^"\n]+)/m);
  const osVerMatch = byStep.os?.match(/^VERSION_ID="?([^"\n]+)/m);
  const docker = byStep.docker === "yes";
  const nginx = byStep.nginx === "yes";
  const ufw = (byStep.ufw ?? "").toLowerCase().includes("active");
  const fail2ban = byStep.fail2ban === "active";
  const sshRoot = byStep.ssh_root ?? "";
  const sshPassword = byStep.ssh_password ?? "";
  const openPorts = (byStep.open_ports ?? "").split(",").filter(Boolean);
  const minimalPorts = openPorts.every((p) => ["22", "80", "443"].includes(p));

  // Security score — keep aligned with frontend hardening checklist weights.
  let score = 0;
  if (sshPassword.toLowerCase().includes("no")) score += 25;
  if (sshRoot.toLowerCase().includes("no") || sshRoot.toLowerCase().includes("prohibit")) score += 15;
  if (ufw) score += 15;
  if (fail2ban) score += 15;
  if (minimalPorts) score += 10;
  if (!docker || !byStep.docker_exposed) score += 10; // unknown; conservative
  // Unattended upgrades: not detected by these probes yet, leave 0.

  return {
    os_name: osNameMatch?.[1] ?? null,
    os_version: osVerMatch?.[1] ?? null,
    architecture: byStep.arch || null,
    cpu_count: Number(byStep.cpu) || null,
    ram_mb: byStep.ram ? Math.round(Number(byStep.ram) / 1024) : null,
    disk_gb: Number(byStep.disk) || null,
    docker_installed: docker,
    nginx_installed: nginx,
    ufw_enabled: ufw,
    fail2ban_enabled: fail2ban,
    security_score: score,
    last_check_result: {
      ssh_password_disabled: sshPassword.toLowerCase().includes("no"),
      ssh_root_disabled: sshRoot.toLowerCase().includes("no") || sshRoot.toLowerCase().includes("prohibit"),
      minimal_ports: minimalPorts,
      open_ports: openPorts,
      docker_not_exposed: null,
      unattended_upgrades: null,
    },
  };
}

async function handleServerTest({ job, api, log }) {
  if (!job.server_id) return { status: "failed", error: "server_test job missing server_id" };
  let connection;
  try { connection = (await api.credential(job.server_id)).connection; }
  catch (e) {
    return { status: "failed", error: `Could not fetch credentials: ${e.message}` };
  }
  const probe = await probeServer({ connection, log });
  if (!probe.ok) {
    await api.updateServer(job.server_id, { status: "offline", last_check_result: { error: probe.error } });
    return { status: "failed", error: probe.error };
  }
  const patch = parseProbe(probe.outputs);
  await api.updateServer(job.server_id, { ...patch, status: "online" });
  return { status: "succeeded", result: patch };
}

async function handleServerHealth(ctx) {
  // Same as server_test for v1 — kept distinct so we can lighten later.
  return await handleServerTest(ctx);
}

async function handleSecurityAudit(ctx) {
  // Same probes — score is recomputed.
  return await handleServerTest(ctx);
}

async function handleDockerInstall({ job, api, log }) {
  if (!job.server_id) return { status: "failed", error: "missing server_id" };
  const { connection } = await api.credential(job.server_id);
  const result = await execOverSsh(connection, [
    { step: "update", run: "sudo apt-get update -y" },
    { step: "deps", run: "sudo apt-get install -y ca-certificates curl gnupg" },
    {
      step: "key",
      run: "sudo install -m 0755 -d /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg && sudo chmod a+r /etc/apt/keyrings/docker.gpg",
    },
    {
      step: "repo",
      run: `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null && sudo apt-get update -y`,
    },
    { step: "install", run: "sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin" },
    { step: "verify", run: "sudo docker --version" },
  ], log);
  if (!result.ok) return { status: "failed", error: result.error };
  await api.updateServer(job.server_id, { docker_installed: true });
  return { status: "succeeded", result: { installed: true } };
}

async function handleFirewallSetup({ job, api, log }) {
  if (!job.server_id) return { status: "failed", error: "missing server_id" };
  const { connection } = await api.credential(job.server_id);
  const result = await execOverSsh(connection, [
    { step: "install", run: "sudo apt-get install -y ufw fail2ban" },
    { step: "deny", run: "sudo ufw default deny incoming" },
    { step: "allow_ssh", run: "sudo ufw allow OpenSSH" },
    { step: "allow_http", run: "sudo ufw allow 80/tcp" },
    { step: "allow_https", run: "sudo ufw allow 443/tcp" },
    { step: "enable", run: "echo y | sudo ufw enable" },
    { step: "fail2ban", run: "sudo systemctl enable --now fail2ban" },
    { step: "status", run: "sudo ufw status verbose" },
  ], log);
  if (!result.ok) return { status: "failed", error: result.error };
  await api.updateServer(job.server_id, { ufw_enabled: true, fail2ban_enabled: true });
  return { status: "succeeded", result: { firewall_active: true } };
}

async function handleSshExec({ job, api, log }) {
  if (!job.server_id) return { status: "failed", error: "missing server_id" };
  const commands = job.input?.commands ?? [];
  if (!Array.isArray(commands) || commands.length === 0) {
    return { status: "failed", error: "ssh_exec requires input.commands array" };
  }
  const { connection } = await api.credential(job.server_id);
  const result = await execOverSsh(connection, commands, log);
  return result.ok
    ? { status: "succeeded", result: { outputs: result.outputs } }
    : { status: "failed", error: result.error, result: { outputs: result.outputs } };
}

async function handleNginxSetup({ job, api, log }) {
  if (!job.server_id) return { status: "failed", error: "missing server_id" };
  const { connection } = await api.credential(job.server_id);
  const result = await execOverSsh(connection, [
    { step: "install", run: "sudo apt-get install -y nginx" },
    { step: "enable", run: "sudo systemctl enable --now nginx" },
    { step: "verify", run: "nginx -v" },
  ], log);
  if (!result.ok) return { status: "failed", error: result.error };
  await api.updateServer(job.server_id, { nginx_installed: true });
  return { status: "succeeded", result: { installed: true } };
}

async function handleSslSetup({ job, api, log }) {
  if (!job.server_id) return { status: "failed", error: "missing server_id" };
  const domain = job.input?.domain;
  const email = job.input?.email;
  if (!domain || !email) return { status: "failed", error: "ssl_setup requires input.domain and input.email" };
  const { connection } = await api.credential(job.server_id);
  const result = await execOverSsh(connection, [
    { step: "install", run: "sudo apt-get install -y certbot python3-certbot-nginx" },
    { step: "issue", run: `sudo certbot --nginx -n --agree-tos -m ${email} -d ${domain}` },
  ], log);
  return result.ok
    ? { status: "succeeded", result: { domain } }
    : { status: "failed", error: result.error };
}

async function handleNotImplemented({ job }) {
  return {
    status: "failed",
    error: `Job type '${job.job_type}' is not yet implemented in this runner (v1).`,
  };
}

export const handlers = {
  server_test: handleServerTest,
  server_health: handleServerHealth,
  security_audit: handleSecurityAudit,
  docker_install: handleDockerInstall,
  firewall_setup: handleFirewallSetup,
  nginx_setup: handleNginxSetup,
  ssl_setup: handleSslSetup,
  ssh_exec: handleSshExec,
  // Stubs — return a clear "not implemented" so the UI surfaces it.
  ansible_apply: handleNotImplemented,
  terraform_plan: handleNotImplemented,
  terraform_apply: handleNotImplemented,
  terraform_destroy: handleNotImplemented,
  k8s_apply: handleNotImplemented,
  k8s_rollout: handleNotImplemented,
  k8s_rollback: handleNotImplemented,
  docker_compose_up: handleNotImplemented,
  docker_compose_down: handleNotImplemented,
  app_deploy: handleNotImplemented,
  app_rollback: handleNotImplemented,
  app_restart: handleNotImplemented,
  backup_setup: handleNotImplemented,
  custom: handleNotImplemented,
};
