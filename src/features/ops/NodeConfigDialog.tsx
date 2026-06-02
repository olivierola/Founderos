import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, Save, Loader2, X, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { NodeKind, TopologyNode } from "./ArchitectureView";

// ============================================================================
// Per-kind feature map.
//
// Every feature corresponds to a collapsible section inside the slide-over.
// The map decides which sections are visible for a given kind. Common
// identity + notes are always shown.
// ============================================================================

type Feature =
  // Core
  | "image" | "command" | "ports" | "env" | "env_file" | "volumes"
  // Runtime
  | "healthcheck" | "restart_policy" | "depends_on" | "lifecycle" | "init"
  // Scaling
  | "resources" | "replicas" | "autoscale"
  // Networking
  | "domain" | "ssl" | "ip_address" | "ssh" | "cidr" | "ingress"
  // Identity / DB / Storage
  | "engine_version" | "credentials" | "schema"
  // Cloud
  | "provider" | "region" | "instance_type"
  // Observability
  | "logging" | "metrics_export" | "tracing_export" | "alert_rules"
  // Pipeline
  | "triggers" | "stages"
  // AI/ML
  | "model_provider" | "api_keys" | "rate_limits"
  // Misc
  | "tags" | "labels" | "security";

const ALWAYS_FEATURES: Feature[] = []; // identity + notes are special-cased

const KIND_FEATURES: Record<NodeKind, Feature[]> = {
  // Compute
  server:           ["ip_address", "ssh", "domain", "tags", "resources", "security"],
  vm:               ["provider", "region", "instance_type", "image", "ip_address", "ssh", "tags"],
  container:        ["image", "command", "ports", "env", "env_file", "volumes",
                     "healthcheck", "restart_policy", "depends_on", "lifecycle",
                     "resources", "replicas", "labels", "logging", "security"],
  service:          ["image", "command", "ports", "env", "env_file", "volumes",
                     "healthcheck", "restart_policy", "depends_on", "replicas",
                     "logging", "tags"],
  scheduler:        ["image", "command", "env", "env_file", "depends_on", "logging"],
  function:         ["command", "env", "triggers", "resources", "logging"],
  edge_function:    ["env", "triggers", "logging"],
  k8s_cluster:      ["provider", "region", "resources", "tags"],
  k8s_deployment:   ["image", "command", "ports", "env", "env_file", "volumes",
                     "healthcheck", "depends_on", "resources", "replicas",
                     "autoscale", "labels", "ingress", "logging"],
  k8s_pod:          ["image", "command", "ports", "env", "volumes", "healthcheck", "labels"],
  // Data
  database:         ["image", "engine_version", "ports", "env", "volumes",
                     "credentials", "schema", "resources", "logging", "metrics_export"],
  cache:            ["image", "engine_version", "ports", "env", "volumes", "resources"],
  queue:            ["image", "engine_version", "ports", "env", "volumes", "resources"],
  object_storage:   ["provider", "region", "credentials", "tags"],
  data_warehouse:   ["provider", "region", "engine_version", "credentials"],
  vector_db:        ["image", "engine_version", "ports", "env", "credentials"],
  // Networking
  reverse_proxy:    ["image", "ports", "domain", "ssl", "depends_on", "logging"],
  load_balancer:    ["image", "ports", "domain", "ssl", "depends_on"],
  api_gateway:      ["ports", "domain", "ssl", "rate_limits", "logging"],
  cdn:              ["domain", "ssl", "provider"],
  dns:              ["domain", "provider"],
  network:          ["cidr", "ports", "tags"],
  firewall:         ["ports", "tags", "security"],
  vpn:              ["cidr", "credentials", "tags"],
  // Observability
  monitoring:       ["provider", "metrics_export", "tracing_export", "alert_rules", "env"],
  metrics:          ["provider", "metrics_export", "env"],
  logging:          ["provider", "env"],
  tracing:          ["provider", "tracing_export", "env"],
  alerting:         ["provider", "alert_rules", "env"],
  // Auth & secrets
  auth:             ["domain", "env", "credentials"],
  identity_provider:["domain", "credentials"],
  secret_store:     ["credentials", "tags"],
  // Edges
  external:         ["domain", "credentials"],
  third_party_api:  ["domain", "credentials", "rate_limits"],
  browser:          ["tags"],
  mobile_app:       ["tags"],
  iot_device:       ["tags"],
  // Pipelines
  ci_cd:            ["triggers", "stages", "env", "credentials"],
  build_pipeline:   ["triggers", "stages", "env"],
  etl_pipeline:     ["triggers", "stages", "env", "credentials"],
  // AI/ML
  llm:              ["model_provider", "api_keys", "rate_limits", "env"],
  embedding_model:  ["model_provider", "api_keys", "rate_limits", "env"],
  ml_model:         ["model_provider", "image", "ports", "env", "resources"],
};

const RESTART_POLICIES = ["no", "always", "unless-stopped", "on-failure"] as const;
const PROVIDERS = [
  "aws", "gcp", "azure", "hetzner", "scaleway", "ovh", "digitalocean",
  "fly", "render", "vercel", "netlify", "other",
] as const;
const STORAGE_PROVIDERS = [
  "aws_s3", "gcs", "azure_blob", "hetzner_object_storage",
  "scaleway_object", "minio", "r2", "other",
] as const;
const MODEL_PROVIDERS = [
  "openai", "anthropic", "groq", "deepseek", "mistral",
  "ollama", "azure_openai", "vertex_ai", "bedrock", "other",
] as const;
const OBS_PROVIDERS = [
  "prometheus", "grafana", "datadog", "newrelic", "sentry",
  "honeycomb", "betterstack", "axiom", "cloudwatch", "other",
] as const;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: TopologyNode | null;
  /** Available node ids to choose from in depends_on. */
  otherNodeIds: string[];
  /** Called on Save with the patched node. */
  onSave: (next: TopologyNode) => void | Promise<void>;
  /** Called on Delete (optional — only for user-added nodes). */
  onDelete?: () => void | Promise<void>;
  /** When true, the editor saves on every change instead of waiting for Save. */
  autoSave?: boolean;
}

export function NodeConfigDialog({
  open, onOpenChange, node, otherNodeIds, onSave, onDelete, autoSave,
}: Props) {
  // Local draft, synced from prop on every open.
  const [draft, setDraft] = useState<TopologyNode | null>(node);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Reset draft when a different node is opened.
  useEffect(() => { setDraft(node); setSavedAt(null); }, [node?.id, open]);

  // Auto-save with debouncing when enabled.
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!autoSave || !draft || !open) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(async () => {
      try {
        await onSave(draft);
        setSavedAt(Date.now());
      } catch { /* swallow — explicit save still available */ }
    }, 700);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, autoSave, open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onOpenChange(false); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open || !draft) return null;
  const features = [...ALWAYS_FEATURES, ...(KIND_FEATURES[draft.kind] ?? [])];

  const meta = (draft.meta ?? {}) as Record<string, any>;
  function patchMeta(patch: Record<string, any>) {
    setDraft({ ...draft!, meta: { ...meta, ...patch } });
  }

  async function explicitSave() {
    setSaving(true);
    try {
      await onSave(draft!);
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* Click-away backdrop (transparent — we don't want a dim layer over the canvas). */}
      <div
        className="fixed inset-0 z-40"
        onClick={() => onOpenChange(false)}
      />
      <aside
        role="dialog"
        aria-label={`Configure ${draft.label}`}
        className="fixed inset-y-0 right-0 z-50 flex w-[440px] max-w-[95vw] flex-col border-l border-border bg-card shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold">{draft.label || "Untitled node"}</h2>
              <Badge variant="outline" className="text-[10px] uppercase">{draft.kind.replace(/_/g, " ")}</Badge>
            </div>
            <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">id: {draft.id}</p>
            {autoSave && (
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {saving ? "Saving…" : savedAt ? "Auto-saved" : "Auto-save on edit"}
              </p>
            )}
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <CollapsibleSection title="Identity" defaultOpen>
            <Field label="Label">
              <Input
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="e.g. api, prod-db, nginx"
              />
            </Field>
            <Field label="ID (used in edges)">
              <Input
                value={draft.id}
                onChange={(e) => setDraft({ ...draft, id: e.target.value.replace(/[^a-z0-9-_]/gi, "-") })}
                placeholder="kebab-case"
                className="font-mono"
              />
            </Field>
          </CollapsibleSection>

          {features.includes("image") && (
            <CollapsibleSection title="Image">
              <Field label="Image">
                <Input
                  value={(draft.image ?? "") as string}
                  onChange={(e) => setDraft({ ...draft, image: e.target.value })}
                  placeholder="nginx:1.27-alpine"
                  className="font-mono"
                />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("command") && (
            <CollapsibleSection title="Command">
              <Field label="Command override">
                <Input
                  value={(draft.command ?? "") as string}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  placeholder='node server.js'
                  className="font-mono"
                />
              </Field>
              <Field label="Entrypoint">
                <Input
                  value={meta.entrypoint ?? ""}
                  onChange={(e) => patchMeta({ entrypoint: e.target.value })}
                  placeholder="/docker-entrypoint.sh"
                  className="font-mono"
                />
              </Field>
              <Field label="Working dir">
                <Input
                  value={meta.workdir ?? ""}
                  onChange={(e) => patchMeta({ workdir: e.target.value })}
                  placeholder="/app"
                  className="font-mono"
                />
              </Field>
              <Field label="User">
                <Input
                  value={meta.user ?? ""}
                  onChange={(e) => patchMeta({ user: e.target.value })}
                  placeholder="1000:1000"
                  className="font-mono"
                />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("engine_version") && (
            <CollapsibleSection title="Engine">
              <Field label="Engine version">
                <Input
                  value={meta.engine_version ?? ""}
                  onChange={(e) => patchMeta({ engine_version: e.target.value })}
                  placeholder="postgres 16, redis 7…"
                  className="font-mono"
                />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("ports") && (
            <CollapsibleSection title="Ports">
              <StringList
                values={draft.ports ?? []}
                onChange={(vals) => setDraft({ ...draft, ports: vals })}
                placeholder="80, 443, 8080:80"
                hint='Ports exposed. "host:container" for mappings.'
                mono
              />
            </CollapsibleSection>
          )}

          {features.includes("env") && (
            <CollapsibleSection title="Environment variables">
              <StringList
                values={draft.env ?? []}
                onChange={(vals) => setDraft({ ...draft, env: vals })}
                placeholder="STRIPE_SECRET_KEY"
                hint="Names only — actual values come from the Vault."
                mono
              />
            </CollapsibleSection>
          )}

          {features.includes("env_file") && (
            <CollapsibleSection title="Env files">
              <StringList
                values={meta.env_files ?? []}
                onChange={(vals) => patchMeta({ env_files: vals })}
                placeholder=".env.production"
                hint="Paths inside the bundle to load env vars from."
                mono
              />
            </CollapsibleSection>
          )}

          {features.includes("volumes") && (
            <CollapsibleSection title="Volumes">
              <StringList
                values={draft.volumes ?? []}
                onChange={(vals) => setDraft({ ...draft, volumes: vals })}
                placeholder="./data:/var/lib/postgres/data"
                hint="Bind mounts or named volumes (host:container)."
                mono
              />
            </CollapsibleSection>
          )}

          {features.includes("healthcheck") && (
            <CollapsibleSection title="Healthcheck">
              <Field label="Test command">
                <Input
                  value={(draft.healthcheck ?? "") as string}
                  onChange={(e) => setDraft({ ...draft, healthcheck: e.target.value })}
                  placeholder='curl -f http://localhost/health || exit 1'
                  className="font-mono"
                />
              </Field>
              <Row3>
                <Field label="Interval"><Input value={meta.hc_interval ?? ""} onChange={(e) => patchMeta({ hc_interval: e.target.value })} placeholder="30s" /></Field>
                <Field label="Timeout"><Input value={meta.hc_timeout ?? ""} onChange={(e) => patchMeta({ hc_timeout: e.target.value })} placeholder="5s" /></Field>
                <Field label="Retries"><Input value={meta.hc_retries ?? ""} onChange={(e) => patchMeta({ hc_retries: e.target.value })} placeholder="3" /></Field>
              </Row3>
              <Row3>
                <Field label="Start period"><Input value={meta.hc_start_period ?? ""} onChange={(e) => patchMeta({ hc_start_period: e.target.value })} placeholder="10s" /></Field>
                <Field label="Liveness path"><Input value={meta.liveness_path ?? ""} onChange={(e) => patchMeta({ liveness_path: e.target.value })} placeholder="/healthz" /></Field>
                <Field label="Readiness path"><Input value={meta.readiness_path ?? ""} onChange={(e) => patchMeta({ readiness_path: e.target.value })} placeholder="/ready" /></Field>
              </Row3>
            </CollapsibleSection>
          )}

          {features.includes("restart_policy") && (
            <CollapsibleSection title="Restart policy">
              <Field label="Policy">
                <Select
                  value={meta.restart_policy ?? "unless-stopped"}
                  onChange={(v) => patchMeta({ restart_policy: v })}
                  options={RESTART_POLICIES.map((p) => ({ value: p, label: p }))}
                />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("init") && (
            <CollapsibleSection title="Init">
              <CheckRow label="Use init process (PID 1)" value={!!meta.init} onChange={(v) => patchMeta({ init: v })} />
            </CollapsibleSection>
          )}

          {features.includes("depends_on") && (
            <CollapsibleSection title="Depends on">
              <MultiPick
                values={(meta.depends_on ?? []) as string[]}
                onChange={(vals) => patchMeta({ depends_on: vals })}
                options={otherNodeIds.filter((id) => id !== draft.id)}
                emptyLabel="No other nodes to depend on."
              />
            </CollapsibleSection>
          )}

          {features.includes("lifecycle") && (
            <CollapsibleSection title="Lifecycle hooks">
              <Field label="PostStart command">
                <Input value={meta.lifecycle_post_start ?? ""} onChange={(e) => patchMeta({ lifecycle_post_start: e.target.value })} placeholder='sh -c "rake db:migrate"' className="font-mono" />
              </Field>
              <Field label="PreStop command">
                <Input value={meta.lifecycle_pre_stop ?? ""} onChange={(e) => patchMeta({ lifecycle_pre_stop: e.target.value })} placeholder='sh -c "drain.sh"' className="font-mono" />
              </Field>
              <Field label="Termination grace period">
                <Input value={meta.termination_grace ?? ""} onChange={(e) => patchMeta({ termination_grace: e.target.value })} placeholder="30s" />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("resources") && (
            <CollapsibleSection title="Resources">
              <Row2>
                <Field label="CPU limit"><Input value={meta.cpu_limit ?? ""} onChange={(e) => patchMeta({ cpu_limit: e.target.value })} placeholder="1.0" /></Field>
                <Field label="Memory limit"><Input value={meta.mem_limit ?? ""} onChange={(e) => patchMeta({ mem_limit: e.target.value })} placeholder="512m" /></Field>
              </Row2>
              <Row2>
                <Field label="CPU request"><Input value={meta.cpu_request ?? ""} onChange={(e) => patchMeta({ cpu_request: e.target.value })} placeholder="0.25" /></Field>
                <Field label="Memory request"><Input value={meta.mem_request ?? ""} onChange={(e) => patchMeta({ mem_request: e.target.value })} placeholder="128m" /></Field>
              </Row2>
              <Row2>
                <Field label="GPU"><Input value={meta.gpu ?? ""} onChange={(e) => patchMeta({ gpu: e.target.value })} placeholder="1 (count) or 'a100'" /></Field>
                <Field label="Disk size"><Input value={meta.disk_size ?? ""} onChange={(e) => patchMeta({ disk_size: e.target.value })} placeholder="20Gi" /></Field>
              </Row2>
            </CollapsibleSection>
          )}

          {features.includes("replicas") && (
            <CollapsibleSection title="Replicas">
              <Field label="Desired replicas">
                <Input type="number" min={0} value={meta.replicas ?? ""} onChange={(e) => patchMeta({ replicas: e.target.value })} placeholder="1" />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("autoscale") && (
            <CollapsibleSection title="Autoscaling (HPA)">
              <CheckRow label="Enable autoscaling" value={!!meta.autoscale_enabled} onChange={(v) => patchMeta({ autoscale_enabled: v })} />
              <Row3>
                <Field label="Min replicas"><Input type="number" value={meta.autoscale_min ?? ""} onChange={(e) => patchMeta({ autoscale_min: e.target.value })} placeholder="2" /></Field>
                <Field label="Max replicas"><Input type="number" value={meta.autoscale_max ?? ""} onChange={(e) => patchMeta({ autoscale_max: e.target.value })} placeholder="10" /></Field>
                <Field label="Target CPU %"><Input type="number" value={meta.autoscale_cpu ?? ""} onChange={(e) => patchMeta({ autoscale_cpu: e.target.value })} placeholder="70" /></Field>
              </Row3>
              <Field label="Target memory %">
                <Input type="number" value={meta.autoscale_mem ?? ""} onChange={(e) => patchMeta({ autoscale_mem: e.target.value })} placeholder="80" />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("ip_address") && (
            <CollapsibleSection title="Host">
              <Row2>
                <Field label="IP address"><Input value={meta.ip_address ?? ""} onChange={(e) => patchMeta({ ip_address: e.target.value })} placeholder="1.2.3.4" className="font-mono" /></Field>
                <Field label="OS image"><Input value={meta.os ?? ""} onChange={(e) => patchMeta({ os: e.target.value })} placeholder="ubuntu-22.04" /></Field>
              </Row2>
              <Row2>
                <Field label="vCPU"><Input value={meta.vcpu ?? ""} onChange={(e) => patchMeta({ vcpu: e.target.value })} placeholder="4" /></Field>
                <Field label="RAM"><Input value={meta.ram ?? ""} onChange={(e) => patchMeta({ ram: e.target.value })} placeholder="8 GB" /></Field>
              </Row2>
            </CollapsibleSection>
          )}

          {features.includes("ssh") && (
            <CollapsibleSection title="SSH">
              <Row2>
                <Field label="User"><Input value={meta.ssh_user ?? ""} onChange={(e) => patchMeta({ ssh_user: e.target.value })} placeholder="root" /></Field>
                <Field label="Port"><Input type="number" value={meta.ssh_port ?? ""} onChange={(e) => patchMeta({ ssh_port: e.target.value })} placeholder="22" /></Field>
              </Row2>
              <CheckRow label="Disable password auth" value={!!meta.ssh_no_password} onChange={(v) => patchMeta({ ssh_no_password: v })} />
              <CheckRow label="Disable root login" value={!!meta.ssh_no_root} onChange={(v) => patchMeta({ ssh_no_root: v })} />
            </CollapsibleSection>
          )}

          {features.includes("domain") && (
            <CollapsibleSection title="Domain">
              <Field label="Domain name">
                <Input value={meta.domain ?? ""} onChange={(e) => patchMeta({ domain: e.target.value })} placeholder="app.example.com" />
              </Field>
              <StringList
                values={meta.aliases ?? []}
                onChange={(vals) => patchMeta({ aliases: vals })}
                placeholder="www.example.com"
                hint="Additional domain aliases."
              />
            </CollapsibleSection>
          )}

          {features.includes("ssl") && (
            <CollapsibleSection title="SSL / TLS">
              <Field label="Mode">
                <Select
                  value={meta.ssl_mode ?? "letsencrypt"}
                  onChange={(v) => patchMeta({ ssl_mode: v })}
                  options={[
                    { value: "off", label: "Off" },
                    { value: "letsencrypt", label: "Let's Encrypt" },
                    { value: "byo", label: "Bring your own cert" },
                    { value: "cloudflare", label: "Cloudflare full" },
                  ]}
                />
              </Field>
              <Field label="Email (for letsencrypt)">
                <Input value={meta.ssl_email ?? ""} onChange={(e) => patchMeta({ ssl_email: e.target.value })} placeholder="ops@example.com" />
              </Field>
              <CheckRow label="HTTP → HTTPS redirect" value={meta.ssl_redirect !== false} onChange={(v) => patchMeta({ ssl_redirect: v })} />
              <CheckRow label="HSTS" value={!!meta.ssl_hsts} onChange={(v) => patchMeta({ ssl_hsts: v })} />
            </CollapsibleSection>
          )}

          {features.includes("ingress") && (
            <CollapsibleSection title="Ingress (k8s)">
              <Field label="Ingress class">
                <Input value={meta.ingress_class ?? ""} onChange={(e) => patchMeta({ ingress_class: e.target.value })} placeholder="nginx, traefik…" />
              </Field>
              <Field label="Host">
                <Input value={meta.ingress_host ?? ""} onChange={(e) => patchMeta({ ingress_host: e.target.value })} placeholder="api.example.com" />
              </Field>
              <Field label="Path">
                <Input value={meta.ingress_path ?? ""} onChange={(e) => patchMeta({ ingress_path: e.target.value })} placeholder="/" />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("provider") && (
            <CollapsibleSection title="Provider">
              <Field label="Provider">
                <Select
                  value={meta.provider ?? "other"}
                  onChange={(v) => patchMeta({ provider: v })}
                  options={(features.includes("model_provider") ? MODEL_PROVIDERS
                    : (features.includes("metrics_export") || features.includes("alert_rules")) ? OBS_PROVIDERS
                    : (features.includes("credentials") && !features.includes("region")) ? STORAGE_PROVIDERS
                    : PROVIDERS
                  ).map((p) => ({ value: p, label: p }))}
                />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("region") && (
            <CollapsibleSection title="Region">
              <Field label="Region code">
                <Input value={meta.region ?? ""} onChange={(e) => patchMeta({ region: e.target.value })} placeholder="eu-west-1, fr-par, nbg1…" className="font-mono" />
              </Field>
              <Field label="Availability zone">
                <Input value={meta.az ?? ""} onChange={(e) => patchMeta({ az: e.target.value })} placeholder="eu-west-1a" className="font-mono" />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("instance_type") && (
            <CollapsibleSection title="Instance">
              <Field label="Instance type / size">
                <Input value={meta.instance_type ?? ""} onChange={(e) => patchMeta({ instance_type: e.target.value })} placeholder="t3.medium, cx21, e2-small" className="font-mono" />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("cidr") && (
            <CollapsibleSection title="CIDR">
              <Field label="CIDR block">
                <Input value={meta.cidr ?? ""} onChange={(e) => patchMeta({ cidr: e.target.value })} placeholder="10.0.0.0/24" className="font-mono" />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("credentials") && (
            <CollapsibleSection title="Credentials">
              <Field label="Vault secret reference">
                <Input value={meta.credentials_ref ?? ""} onChange={(e) => patchMeta({ credentials_ref: e.target.value })} placeholder="vault:projects/<id>/<secret-name>" className="font-mono" />
              </Field>
              <p className="text-[10px] text-muted-foreground">Reference only — never paste secrets here.</p>
            </CollapsibleSection>
          )}

          {features.includes("schema") && (
            <CollapsibleSection title="Schema">
              <StringList
                values={meta.databases ?? []}
                onChange={(vals) => patchMeta({ databases: vals })}
                placeholder="appdb"
                hint="Logical databases to create."
                mono
              />
              <StringList
                values={meta.extensions ?? []}
                onChange={(vals) => patchMeta({ extensions: vals })}
                placeholder="pgvector"
                hint="Postgres extensions / Redis modules to load."
                mono
              />
            </CollapsibleSection>
          )}

          {features.includes("logging") && (
            <CollapsibleSection title="Logging">
              <Field label="Driver">
                <Select
                  value={meta.log_driver ?? "json-file"}
                  onChange={(v) => patchMeta({ log_driver: v })}
                  options={[
                    { value: "json-file", label: "json-file" },
                    { value: "journald", label: "journald" },
                    { value: "syslog", label: "syslog" },
                    { value: "fluentd", label: "fluentd" },
                    { value: "loki", label: "loki" },
                  ]}
                />
              </Field>
              <Row2>
                <Field label="Max size"><Input value={meta.log_max_size ?? ""} onChange={(e) => patchMeta({ log_max_size: e.target.value })} placeholder="10m" /></Field>
                <Field label="Max files"><Input value={meta.log_max_files ?? ""} onChange={(e) => patchMeta({ log_max_files: e.target.value })} placeholder="3" /></Field>
              </Row2>
            </CollapsibleSection>
          )}

          {features.includes("metrics_export") && (
            <CollapsibleSection title="Metrics export">
              <Field label="Endpoint">
                <Input value={meta.metrics_endpoint ?? ""} onChange={(e) => patchMeta({ metrics_endpoint: e.target.value })} placeholder="/metrics" />
              </Field>
              <Field label="Port">
                <Input value={meta.metrics_port ?? ""} onChange={(e) => patchMeta({ metrics_port: e.target.value })} placeholder="9090" />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("tracing_export") && (
            <CollapsibleSection title="Tracing export">
              <Field label="Exporter">
                <Select
                  value={meta.tracing_exporter ?? "otlp"}
                  onChange={(v) => patchMeta({ tracing_exporter: v })}
                  options={["otlp", "jaeger", "zipkin", "datadog"].map((p) => ({ value: p, label: p }))}
                />
              </Field>
              <Field label="Endpoint">
                <Input value={meta.tracing_endpoint ?? ""} onChange={(e) => patchMeta({ tracing_endpoint: e.target.value })} placeholder="http://otel:4317" />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("alert_rules") && (
            <CollapsibleSection title="Alert rules">
              <StringList
                values={meta.alert_rules ?? []}
                onChange={(vals) => patchMeta({ alert_rules: vals })}
                placeholder='cpu > 80% for 5m → page'
                hint="Free-form alert rules."
              />
            </CollapsibleSection>
          )}

          {features.includes("triggers") && (
            <CollapsibleSection title="Triggers">
              <StringList
                values={meta.triggers ?? []}
                onChange={(vals) => patchMeta({ triggers: vals })}
                placeholder='push:main, schedule:0 * * * *, manual'
                hint="Event triggers (push, schedule, webhook…)."
                mono
              />
            </CollapsibleSection>
          )}

          {features.includes("stages") && (
            <CollapsibleSection title="Stages">
              <StringList
                values={meta.stages ?? []}
                onChange={(vals) => patchMeta({ stages: vals })}
                placeholder="install, build, test, deploy"
                hint="Ordered pipeline stages."
                mono
              />
            </CollapsibleSection>
          )}

          {features.includes("model_provider") && (
            <CollapsibleSection title="Model">
              <Field label="Provider">
                <Select
                  value={meta.model_provider ?? "openai"}
                  onChange={(v) => patchMeta({ model_provider: v })}
                  options={MODEL_PROVIDERS.map((p) => ({ value: p, label: p }))}
                />
              </Field>
              <Field label="Model name">
                <Input value={meta.model_name ?? ""} onChange={(e) => patchMeta({ model_name: e.target.value })} placeholder="gpt-4o, claude-3-5-sonnet, llama-3.1-70b" className="font-mono" />
              </Field>
              <Row2>
                <Field label="Temperature"><Input type="number" min={0} max={2} step={0.1} value={meta.temperature ?? ""} onChange={(e) => patchMeta({ temperature: e.target.value })} placeholder="0.3" /></Field>
                <Field label="Max tokens"><Input type="number" value={meta.max_tokens ?? ""} onChange={(e) => patchMeta({ max_tokens: e.target.value })} placeholder="2048" /></Field>
              </Row2>
              <Field label="Context window">
                <Input value={meta.context_window ?? ""} onChange={(e) => patchMeta({ context_window: e.target.value })} placeholder="128k" />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("api_keys") && (
            <CollapsibleSection title="API keys">
              <StringList
                values={meta.api_keys ?? []}
                onChange={(vals) => patchMeta({ api_keys: vals })}
                placeholder="OPENAI_API_KEY"
                hint="Vault env var names — values never leave the runner."
                mono
              />
            </CollapsibleSection>
          )}

          {features.includes("rate_limits") && (
            <CollapsibleSection title="Rate limits">
              <Row2>
                <Field label="Requests / minute"><Input type="number" value={meta.rpm ?? ""} onChange={(e) => patchMeta({ rpm: e.target.value })} placeholder="60" /></Field>
                <Field label="Tokens / minute"><Input type="number" value={meta.tpm ?? ""} onChange={(e) => patchMeta({ tpm: e.target.value })} placeholder="100000" /></Field>
              </Row2>
              <Field label="Burst">
                <Input type="number" value={meta.burst ?? ""} onChange={(e) => patchMeta({ burst: e.target.value })} placeholder="10" />
              </Field>
            </CollapsibleSection>
          )}

          {features.includes("tags") && (
            <CollapsibleSection title="Tags">
              <StringList
                values={meta.tags ?? []}
                onChange={(vals) => patchMeta({ tags: vals })}
                placeholder="env=prod, team=core"
                hint="Free-form tags for cost allocation / filtering."
                mono
              />
            </CollapsibleSection>
          )}

          {features.includes("labels") && (
            <CollapsibleSection title="Labels (k8s)">
              <StringList
                values={meta.labels ?? []}
                onChange={(vals) => patchMeta({ labels: vals })}
                placeholder="app=api, tier=backend"
                hint="Kubernetes label selectors."
                mono
              />
            </CollapsibleSection>
          )}

          {features.includes("security") && (
            <CollapsibleSection title="Security">
              <CheckRow label="Read-only filesystem" value={!!meta.read_only} onChange={(v) => patchMeta({ read_only: v })} />
              <CheckRow label="Run as non-root" value={!!meta.run_as_non_root} onChange={(v) => patchMeta({ run_as_non_root: v })} />
              <CheckRow label="Drop ALL capabilities" value={!!meta.drop_all_caps} onChange={(v) => patchMeta({ drop_all_caps: v })} />
              <Field label="Run as user (UID)">
                <Input type="number" value={meta.run_as_user ?? ""} onChange={(e) => patchMeta({ run_as_user: e.target.value })} placeholder="1000" />
              </Field>
              <Field label="Security profile">
                <Select
                  value={meta.security_profile ?? "default"}
                  onChange={(v) => patchMeta({ security_profile: v })}
                  options={["default", "restricted", "privileged"].map((p) => ({ value: p, label: p }))}
                />
              </Field>
            </CollapsibleSection>
          )}

          {/* Universal notes */}
          <CollapsibleSection title="Notes">
            <textarea
              value={meta.notes ?? ""}
              onChange={(e) => patchMeta({ notes: e.target.value })}
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Anything that doesn't fit elsewhere…"
            />
          </CollapsibleSection>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-3">
          {onDelete ? (
            <Button variant="ghost" onClick={onDelete} className="gap-1.5 text-destructive hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
            <Button onClick={explicitSave} disabled={saving || !draft.label.trim()} className="gap-1.5">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}

// ============================================================================
// Tiny presentation primitives
// ============================================================================

function CollapsibleSection({
  title, children, defaultOpen,
}: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="rounded-md border border-border bg-card/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-t-md px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:bg-muted/60"
      >
        {title}
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {open && <div className="space-y-2 border-t border-border/60 px-3 py-2">{children}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function Row2({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-2">{children}</div>;
}

function Row3({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-3 gap-2">{children}</div>;
}

function CheckRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5" />
      {label}
    </label>
  );
}

function Select<T extends string>({
  value, onChange, options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function StringList({
  values, onChange, placeholder, hint, mono,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  hint?: string;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState("");
  function add() {
    const v = draft.trim();
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
    setDraft("");
  }
  return (
    <div className="space-y-1.5">
      {values.length > 0 && (
        <div className="space-y-1">
          {values.map((v, i) => (
            <div key={i} className="flex items-center gap-2 rounded border border-border bg-background px-2 py-1">
              <code className={cn("flex-1 truncate text-[11px]", mono && "font-mono")}>{v}</code>
              <button
                onClick={() => onChange(values.filter((_, j) => j !== i))}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          className={mono ? "font-mono" : undefined}
        />
        <Button size="sm" variant="outline" onClick={add} className="gap-1">
          <Plus className="h-3 w-3" /> Add
        </Button>
      </div>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function MultiPick({
  values, onChange, options, emptyLabel,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  options: string[];
  emptyLabel?: string;
}) {
  if (options.length === 0) {
    return <p className="text-[11px] text-muted-foreground">{emptyLabel ?? "Nothing to pick."}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((id) => {
        const checked = values.includes(id);
        return (
          <button
            key={id}
            onClick={() => {
              const set = new Set(values);
              if (checked) set.delete(id); else set.add(id);
              onChange(Array.from(set));
            }}
            className={cn(
              "rounded border px-2 py-0.5 text-[10px] font-mono",
              checked ? "border-foreground bg-foreground/10" : "border-border text-muted-foreground",
            )}
          >
            {id}
          </button>
        );
      })}
    </div>
  );
}
