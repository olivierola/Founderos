// Deterministic patchers that update generated infra files from canvas edits.
//
// Each function takes the current file content + the post-edit topology and
// returns the new content (string-equal if no change is needed). All patchers
// are non-IA: they parse, merge, and re-serialise so the user-visible diff is
// minimal and predictable.
//
// They are intentionally conservative: when in doubt about an existing block
// they preserve the original lines and only touch the structured fields that
// the canvas surfaces (image, command, ports, env vars, healthcheck,
// resources, replicas, depends_on, volumes, restart policy).

import yaml from "js-yaml";
import type { Topology, TopologyNode } from "./ArchitectureView";

// ---- Public API -----------------------------------------------------------

export interface PatchResult {
  /** Files keyed by id with their new content. Only changed files are returned. */
  patched: Map<string, string>;
}

/**
 * Patch every file in a bundle from the new topology. The caller passes the
 * full list of files (id + path + type + content) and receives a Map of
 * file-id → new content for files whose content actually changed.
 */
export function patchBundle(
  files: Array<{ id: string; file_type: string; file_path: string; content: string }>,
  topology: Topology,
): PatchResult {
  const patched = new Map<string, string>();
  for (const f of files) {
    let next: string | null = null;
    try {
      switch (f.file_type) {
        case "docker_compose":     next = patchDockerCompose(f.content, topology); break;
        case "nginx_conf":         next = patchNginxConf(f.content, topology); break;
        case "env_example":        next = patchEnvFile(f.content, topology); break;
        case "kubernetes_manifest": next = patchKubernetesManifest(f.content, topology); break;
        case "dockerfile":         next = patchDockerfile(f.content, topology); break;
        case "ansible_playbook":   next = patchAnsiblePlaybook(f.content, topology); break;
        case "ansible_inventory":  next = patchAnsibleInventory(f.content, topology); break;
        case "terraform":          next = patchTerraform(f.content, f.file_path, topology); break;
        default: next = null;
      }
    } catch (e) {
      // Parsing failed (likely a templated/non-standard file) — skip silently.
      next = null;
    }
    if (next !== null && next !== f.content) patched.set(f.id, next);
  }
  return { patched };
}

// ---- Docker Compose -------------------------------------------------------

interface ComposeFile {
  version?: string;
  services?: Record<string, any>;
  volumes?: Record<string, any>;
  networks?: Record<string, any>;
  [k: string]: unknown;
}

/** Strict-ish service-kind detector for compose. Any node we'd render as a
 *  long-running compose service. We deliberately exclude k8s_* / cloud kinds. */
function isComposeServiceNode(n: TopologyNode): boolean {
  return [
    "container", "service", "database", "cache", "queue",
    "reverse_proxy", "load_balancer", "scheduler", "vector_db",
  ].includes(n.kind);
}

function patchDockerCompose(content: string, topology: Topology): string {
  const doc = yaml.load(content) as ComposeFile | undefined;
  if (!doc || typeof doc !== "object" || !doc.services) return content;

  // Build a lookup of canvas nodes by their id so we can match services.
  const nodeById = new Map(topology.nodes.filter(isComposeServiceNode).map((n) => [n.id, n]));

  for (const [svcId, svc] of Object.entries(doc.services)) {
    const node = nodeById.get(svcId);
    if (!node) continue; // Service in compose that doesn't exist in topology — leave it alone.

    if (typeof node.image === "string" && node.image.length > 0) svc.image = node.image;
    if (typeof node.command === "string" && node.command.length > 0) svc.command = node.command;

    // ports — overwrite if topology has any
    if (node.ports && node.ports.length > 0) svc.ports = [...node.ports];

    // env — merge: keep existing pairs whose key is in the new set, then add the rest as bare names
    if (node.env && node.env.length > 0) {
      svc.environment = mergeEnv(svc.environment, node.env);
    }

    // volumes — overwrite
    if (node.volumes && node.volumes.length > 0) svc.volumes = [...node.volumes];

    // healthcheck
    if (typeof node.healthcheck === "string" && node.healthcheck.length > 0) {
      svc.healthcheck = { test: node.healthcheck, ...((svc.healthcheck as any) ?? {}) };
      const m = (node.meta ?? {}) as Record<string, string>;
      if (m.hc_interval)   svc.healthcheck.interval = m.hc_interval;
      if (m.hc_timeout)    svc.healthcheck.timeout = m.hc_timeout;
      if (m.hc_retries)    svc.healthcheck.retries = Number(m.hc_retries);
      if (m.hc_start_period) svc.healthcheck.start_period = m.hc_start_period;
    }

    const m = (node.meta ?? {}) as Record<string, any>;
    if (m.restart_policy) svc.restart = m.restart_policy;
    if (m.user)           svc.user = String(m.user);
    if (m.workdir)        svc.working_dir = m.workdir;
    if (m.entrypoint)     svc.entrypoint = m.entrypoint;
    if (m.depends_on && Array.isArray(m.depends_on) && m.depends_on.length > 0) {
      svc.depends_on = [...m.depends_on];
    }
    if (m.env_files && Array.isArray(m.env_files) && m.env_files.length > 0) {
      svc.env_file = [...m.env_files];
    }
    // Replicas — compose v3 syntax under deploy.
    if (m.replicas) {
      svc.deploy = { ...(svc.deploy ?? {}), replicas: Number(m.replicas) };
    }
    // Resources — under deploy.resources.limits / reservations.
    if (m.cpu_limit || m.mem_limit || m.cpu_request || m.mem_request) {
      svc.deploy = svc.deploy ?? {};
      svc.deploy.resources = svc.deploy.resources ?? {};
      if (m.cpu_limit || m.mem_limit) {
        svc.deploy.resources.limits = {
          ...(svc.deploy.resources.limits ?? {}),
          ...(m.cpu_limit ? { cpus: String(m.cpu_limit) } : {}),
          ...(m.mem_limit ? { memory: String(m.mem_limit) } : {}),
        };
      }
      if (m.cpu_request || m.mem_request) {
        svc.deploy.resources.reservations = {
          ...(svc.deploy.resources.reservations ?? {}),
          ...(m.cpu_request ? { cpus: String(m.cpu_request) } : {}),
          ...(m.mem_request ? { memory: String(m.mem_request) } : {}),
        };
      }
    }
    // Logging
    if (m.log_driver) {
      svc.logging = {
        driver: m.log_driver,
        options: {
          ...(m.log_max_size ? { "max-size": m.log_max_size } : {}),
          ...(m.log_max_files ? { "max-file": String(m.log_max_files) } : {}),
        },
      };
    }
    // Init
    if (m.init !== undefined) svc.init = !!m.init;
  }

  return yaml.dump(doc, { indent: 2, lineWidth: 120, noRefs: true });
}

/** Merge env arrays. compose env can be an object or an array — we normalise
 *  to array form because that's what the AI produces and what the canvas knows. */
function mergeEnv(existing: unknown, fromTopology: string[]): string[] {
  const out = new Map<string, string>();
  // Normalise existing into a name → value (or empty) map.
  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (typeof item !== "string") continue;
      const eq = item.indexOf("=");
      if (eq >= 0) out.set(item.slice(0, eq), item.slice(eq + 1));
      else out.set(item, "");
    }
  } else if (existing && typeof existing === "object") {
    for (const [k, v] of Object.entries(existing as Record<string, unknown>)) {
      out.set(k, v == null ? "" : String(v));
    }
  }
  // Drop env vars that disappeared from the topology and add the new ones.
  const wanted = new Set(fromTopology.map((e) => e.split("=")[0]));
  for (const k of [...out.keys()]) {
    if (!wanted.has(k)) out.delete(k);
  }
  for (const e of fromTopology) {
    const eq = e.indexOf("=");
    if (eq >= 0) out.set(e.slice(0, eq), e.slice(eq + 1));
    else if (!out.has(e)) out.set(e, "");
  }
  return [...out.entries()].map(([k, v]) => v ? `${k}=${v}` : k);
}

// ---- Nginx ----------------------------------------------------------------

function patchNginxConf(content: string, topology: Topology): string {
  // Conservative: only patch server_name when there's a reverse_proxy /
  // load_balancer / cdn node with a configured domain. The rest stays.
  const domains = topology.nodes
    .filter((n) => ["reverse_proxy", "load_balancer", "api_gateway", "cdn"].includes(n.kind))
    .map((n) => (n.meta as Record<string, unknown> | undefined)?.domain as string | undefined)
    .filter((d): d is string => typeof d === "string" && d.length > 0);
  if (domains.length === 0) return content;

  // Replace the first server_name with all domains joined.
  const newDirective = `server_name ${domains.join(" ")};`;
  const next = content.replace(/server_name\s+[^;]+;/, newDirective);
  return next;
}

// ---- .env files -----------------------------------------------------------

function patchEnvFile(content: string, topology: Topology): string {
  // Walk every node's env array and union them; emit any missing variable as a
  // commented stub at the bottom. Keep existing values intact.
  const existing = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) existing.set(m[1], m[2]);
  }
  const desired = new Set<string>();
  for (const n of topology.nodes) {
    for (const e of n.env ?? []) {
      const name = e.split("=")[0];
      if (/^[A-Z_][A-Z0-9_]*$/.test(name)) desired.add(name);
    }
  }
  // Add missing ones to the end as commented stubs.
  const toAdd = [...desired].filter((k) => !existing.has(k));
  if (toAdd.length === 0) return content;

  const trailing = content.endsWith("\n") ? "" : "\n";
  const block = `\n# Added by canvas edit\n${toAdd.map((k) => `# ${k}=`).join("\n")}\n`;
  return content + trailing + block;
}

// ---- Dockerfile -----------------------------------------------------------

function patchDockerfile(content: string, _topology: Topology): string {
  // No-op for now — the canvas does not expose Dockerfile-level fields.
  // Kept as a hook so the orchestrator can call patchBundle uniformly.
  return content;
}

// ---- Kubernetes manifest --------------------------------------------------

interface K8sManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; labels?: Record<string, string>; [k: string]: any };
  spec?: any;
  [k: string]: unknown;
}

function patchKubernetesManifest(content: string, topology: Topology): string {
  // Multi-document YAML support.
  let docs: K8sManifest[];
  try { docs = yaml.loadAll(content) as K8sManifest[]; }
  catch { return content; }
  if (!Array.isArray(docs) || docs.length === 0) return content;

  let changed = false;

  for (const doc of docs) {
    if (!doc || typeof doc !== "object" || !doc.kind || !doc.metadata?.name) continue;
    const name = doc.metadata.name;

    // Try to match by id (kebab-case) — k8s resource names are kebab-case
    // so direct equality usually works.
    const node = topology.nodes.find((n) => n.id === name);
    if (!node) continue;

    if (doc.kind === "Deployment" || doc.kind === "StatefulSet") {
      const spec = (doc.spec ??= {}) as any;
      const tmpl = (spec.template ??= {});
      const tmplSpec = (tmpl.spec ??= {});
      const containers: any[] = tmplSpec.containers ??= [];
      // Pick the matching container by name fallback to the first.
      let c = containers.find((x) => x?.name === name) ?? containers[0];
      if (!c) { c = { name }; containers.push(c); }

      if (node.image)   { c.image = node.image; changed = true; }
      if (node.command) { c.command = node.command.split(/\s+/); changed = true; }

      if (node.ports && node.ports.length > 0) {
        c.ports = node.ports.map((p) => {
          const port = Number(String(p).split(":").pop());
          return Number.isFinite(port) ? { containerPort: port } : null;
        }).filter(Boolean);
        changed = true;
      }

      if (node.env && node.env.length > 0) {
        c.env = node.env.map((e) => {
          const [k, v] = e.split("=");
          return v ? { name: k, value: v } : { name: k, valueFrom: { secretKeyRef: { name: `${name}-secret`, key: k } } };
        });
        changed = true;
      }

      const m = (node.meta ?? {}) as Record<string, any>;
      if (m.replicas) { spec.replicas = Number(m.replicas); changed = true; }
      if (m.cpu_limit || m.mem_limit || m.cpu_request || m.mem_request) {
        c.resources = c.resources ?? {};
        if (m.cpu_limit || m.mem_limit) {
          c.resources.limits = {
            ...(c.resources.limits ?? {}),
            ...(m.cpu_limit ? { cpu: String(m.cpu_limit) } : {}),
            ...(m.mem_limit ? { memory: String(m.mem_limit) } : {}),
          };
        }
        if (m.cpu_request || m.mem_request) {
          c.resources.requests = {
            ...(c.resources.requests ?? {}),
            ...(m.cpu_request ? { cpu: String(m.cpu_request) } : {}),
            ...(m.mem_request ? { memory: String(m.mem_request) } : {}),
          };
        }
        changed = true;
      }
      if (m.liveness_path) {
        c.livenessProbe = c.livenessProbe ?? { httpGet: { path: m.liveness_path, port: c.ports?.[0]?.containerPort ?? 80 } };
        c.livenessProbe.httpGet = { path: m.liveness_path, port: c.ports?.[0]?.containerPort ?? 80 };
        changed = true;
      }
      if (m.readiness_path) {
        c.readinessProbe = c.readinessProbe ?? { httpGet: { path: m.readiness_path, port: c.ports?.[0]?.containerPort ?? 80 } };
        c.readinessProbe.httpGet = { path: m.readiness_path, port: c.ports?.[0]?.containerPort ?? 80 };
        changed = true;
      }
      if (m.labels && Array.isArray(m.labels) && m.labels.length > 0) {
        doc.metadata!.labels = {
          ...(doc.metadata!.labels ?? {}),
          ...labelsArrayToObject(m.labels as string[]),
        };
        changed = true;
      }
    }

    if (doc.kind === "Service" && node.ports && node.ports.length > 0) {
      const spec = (doc.spec ??= {}) as any;
      spec.ports = node.ports.map((p) => {
        const port = Number(String(p).split(":").pop());
        return Number.isFinite(port) ? { port, targetPort: port, protocol: "TCP" } : null;
      }).filter(Boolean);
      changed = true;
    }

    if (doc.kind === "HorizontalPodAutoscaler") {
      const m = (node.meta ?? {}) as Record<string, any>;
      if (m.autoscale_enabled) {
        const spec = (doc.spec ??= {}) as any;
        if (m.autoscale_min) spec.minReplicas = Number(m.autoscale_min);
        if (m.autoscale_max) spec.maxReplicas = Number(m.autoscale_max);
        if (m.autoscale_cpu) {
          spec.metrics = [{
            type: "Resource",
            resource: { name: "cpu", target: { type: "Utilization", averageUtilization: Number(m.autoscale_cpu) } },
          }];
        }
        changed = true;
      }
    }
  }

  if (!changed) return content;
  return docs.map((d) => yaml.dump(d, { indent: 2, lineWidth: 120, noRefs: true })).join("---\n");
}

function labelsArrayToObject(labels: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of labels) {
    const eq = l.indexOf("=");
    if (eq > 0) out[l.slice(0, eq)] = l.slice(eq + 1);
  }
  return out;
}

// ---- Ansible --------------------------------------------------------------

function patchAnsiblePlaybook(content: string, _topology: Topology): string {
  // Ansible playbooks have too much structural variety (roles vs plays vs
  // tasks) for a safe non-AI patch. We leave them as-is for now; future work
  // could replace the inventory vars block with topology-driven values.
  return content;
}

function patchAnsibleInventory(content: string, topology: Topology): string {
  // Replace ansible_host values when the topology provides ip_address on a
  // matching node (matched by inventory entry name).
  const nodesWithIp = topology.nodes.filter((n) => {
    const ip = (n.meta as Record<string, unknown> | undefined)?.ip_address;
    return typeof ip === "string" && ip.length > 0;
  });
  if (nodesWithIp.length === 0) return content;

  let out = content;
  for (const n of nodesWithIp) {
    const ip = (n.meta as Record<string, string>).ip_address;
    // Match a line like:   name ansible_host=<anything>
    const re = new RegExp(`^(\\s*${escapeRe(n.id)}\\s+ansible_host=)\\S+`, "gm");
    out = out.replace(re, (_m, prefix) => `${prefix}${ip}`);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- Terraform ------------------------------------------------------------

function patchTerraform(content: string, filePath: string, topology: Topology): string {
  // We touch tfvars files only (low-risk, well-structured). Patching .tf is
  // too risky without a proper HCL parser.
  if (!filePath.endsWith(".tfvars.example") && !filePath.endsWith(".tfvars")) return content;

  // Set known variables when topology provides them.
  const setters: Record<string, string | undefined> = {
    domain: pickStringMeta(topology.nodes, "domain"),
    region: pickStringMeta(topology.nodes, "region"),
    instance_type: pickStringMeta(topology.nodes, "instance_type"),
    server_image: pickStringMeta(topology.nodes, "os"),
  };

  let out = content;
  for (const [key, val] of Object.entries(setters)) {
    if (!val) continue;
    const re = new RegExp(`^(\\s*${escapeRe(key)}\\s*=\\s*).*$`, "m");
    if (re.test(out)) out = out.replace(re, `$1"${val}"`);
    else out += `\n${key} = "${val}"\n`;
  }
  return out;
}

function pickStringMeta(nodes: TopologyNode[], key: string): string | undefined {
  for (const n of nodes) {
    const v = (n.meta as Record<string, unknown> | undefined)?.[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
