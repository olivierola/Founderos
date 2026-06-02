// Type definitions shared across the Ops module pages.
// Kept in one file so the pages stay focused on UI logic.

export type OpsServerStatus = "unknown" | "online" | "offline" | "degraded" | "provisioning" | "error";
export type OpsServerEnv = "production" | "staging" | "development" | "sandbox";
export type OpsServerProvider =
  | "vps" | "hetzner" | "digitalocean" | "aws" | "gcp" | "azure" | "scaleway" | "ovh" | "other";

export interface OpsServer {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  description: string | null;
  /** "server" = VPS managed via SSH/Ansible. "managed" = PaaS via connector API. */
  target_kind: "server" | "managed";
  /** When target_kind = "managed", the connectors row id holding credentials. */
  connector_id: string | null;
  /** When target_kind = "managed", denormalised provider name (vercel, netlify…). */
  managed_provider: string | null;
  provider: OpsServerProvider;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  ssh_key_secret_id: string | null;
  os_name: string | null;
  os_version: string | null;
  architecture: string | null;
  cpu_count: number | null;
  ram_mb: number | null;
  disk_gb: number | null;
  docker_installed: boolean | null;
  nginx_installed: boolean | null;
  ufw_enabled: boolean | null;
  fail2ban_enabled: boolean | null;
  environment: OpsServerEnv;
  domain: string | null;
  status: OpsServerStatus;
  last_checked_at: string | null;
  last_check_result: Record<string, any>;
  security_score: number | null;
  tags: string[];
  metadata: Record<string, any>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type OpsJobStatus =
  | "draft" | "awaiting_approval" | "approved" | "queued" | "running"
  | "succeeded" | "failed" | "cancelled" | "rolled_back";

export type OpsJobType =
  | "server_test" | "server_health" | "security_audit"
  | "ansible_apply" | "docker_install" | "nginx_setup" | "ssl_setup" | "firewall_setup" | "backup_setup"
  | "terraform_plan" | "terraform_apply" | "terraform_destroy"
  | "k8s_apply" | "k8s_rollout" | "k8s_rollback"
  | "docker_compose_up" | "docker_compose_down" | "app_deploy" | "app_rollback" | "app_restart"
  | "ssh_exec" | "custom";

export type OpsAutonomyMode = "advisor" | "assisted" | "controlled" | "autopilot";
export type OpsRiskLevel = "low" | "medium" | "high" | "critical";

export interface OpsJob {
  id: string;
  workspace_id: string;
  project_id: string;
  server_id: string | null;
  bundle_id: string | null;
  job_type: OpsJobType;
  autonomy_mode: OpsAutonomyMode;
  risk_level: OpsRiskLevel;
  status: OpsJobStatus;
  requires_approval: boolean;
  approved_by: string | null;
  approved_at: string | null;
  input: Record<string, any>;
  result: Record<string, any>;
  exit_code: number | null;
  error_message: string | null;
  rollback_job_id: string | null;
  parent_job_id: string | null;
  runner_id: string | null;
  attempts: number;
  scheduled_at: string;
  picked_up_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface OpsJobLog {
  id: string;
  job_id: string;
  level: "debug" | "info" | "warn" | "error" | "stdout" | "stderr";
  message: string;
  step: string | null;
  metadata: Record<string, any>;
  created_at: string;
}

export type OpsFileType =
  | "dockerfile" | "docker_compose" | "nginx_conf" | "ansible_playbook" | "ansible_inventory"
  | "terraform" | "kubernetes_manifest" | "helm_chart" | "env_example" | "script" | "readme" | "other";

export interface OpsGeneratedFile {
  id: string;
  workspace_id: string;
  project_id: string;
  bundle_id: string;
  bundle_label: string | null;
  file_path: string;
  file_type: OpsFileType;
  content: string;
  status: "draft" | "reviewed" | "applied" | "superseded";
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export type OpsCheckCategory = "technical" | "product" | "security";
export type OpsProbeType =
  | "http_status" | "http_contains" | "http_latency" | "ssl_valid" | "dns_resolve"
  | "tcp_port" | "container_running" | "disk_usage" | "memory_usage" | "custom_ssh";

export interface OpsCheckDefinition {
  id: string;
  workspace_id: string;
  project_id: string;
  server_id: string | null;
  name: string;
  category: OpsCheckCategory;
  probe_type: OpsProbeType;
  config: Record<string, any>;
  baseline: Record<string, any>;
  mode: "post_deploy" | "baseline_compare" | "scheduled";
  enabled: boolean;
  created_at: string;
}

export interface OpsCheckRun {
  id: string;
  workspace_id: string;
  project_id: string;
  definition_id: string | null;
  deployment_id: string | null;
  job_id: string | null;
  status: "passed" | "failed" | "warn" | "skipped";
  measured_value: Record<string, any>;
  delta: Record<string, any>;
  message: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface OpsSettings {
  project_id: string;
  workspace_id: string;
  runner_url: string | null;
  runner_token_hash: string | null;
  default_autonomy_mode: OpsAutonomyMode;
  command_denylist: string[];
  command_allowlist: string[];
  notify_on_job_status: string[];
  updated_at: string;
}

// ---- UI helpers -----------------------------------------------------------

export const JOB_TYPE_LABEL: Record<OpsJobType, string> = {
  server_test: "Server test",
  server_health: "Health probe",
  security_audit: "Security audit",
  ansible_apply: "Ansible apply",
  docker_install: "Install Docker",
  nginx_setup: "Setup Nginx",
  ssl_setup: "Issue SSL",
  firewall_setup: "Setup firewall",
  backup_setup: "Setup backups",
  terraform_plan: "Terraform plan",
  terraform_apply: "Terraform apply",
  terraform_destroy: "Terraform destroy",
  k8s_apply: "Kubernetes apply",
  k8s_rollout: "Kubernetes rollout",
  k8s_rollback: "Kubernetes rollback",
  docker_compose_up: "docker compose up",
  docker_compose_down: "docker compose down",
  app_deploy: "App deploy",
  app_rollback: "App rollback",
  app_restart: "App restart",
  ssh_exec: "SSH command",
  custom: "Custom",
};

export const RISK_COLOR: Record<OpsRiskLevel, string> = {
  low: "text-emerald-500",
  medium: "text-amber-500",
  high: "text-orange-500",
  critical: "text-destructive",
};

export const STATUS_COLOR: Record<OpsJobStatus, string> = {
  draft: "text-muted-foreground",
  awaiting_approval: "text-amber-500",
  approved: "text-blue-500",
  queued: "text-blue-500",
  running: "text-blue-500",
  succeeded: "text-emerald-500",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
  rolled_back: "text-orange-500",
};
