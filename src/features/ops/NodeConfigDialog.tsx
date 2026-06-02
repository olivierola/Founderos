import { useEffect, useState } from "react";
import { Plus, Trash2, Save, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { NodeKind, TopologyNode } from "./ArchitectureView";

// ============================================================================
// Per-kind field metadata.
//
// We don't render every field for every kind — the union would be hostile.
// Instead each kind opts in to a subset of "feature blocks". Common to all:
// label, id, kind, notes. The rest is per-kind and rendered conditionally.
// ============================================================================

type Feature =
  | "image" | "command" | "ports" | "env" | "volumes" | "healthcheck"
  | "restart_policy" | "depends_on" | "resources" | "replicas"
  | "domain" | "ssl" | "ip_address" | "ssh"
  | "engine_version" | "credentials"
  | "provider" | "region" | "cidr";

const KIND_FEATURES: Record<NodeKind, Feature[]> = {
  server:         ["ip_address", "ssh", "domain", "resources"],
  container:      ["image", "command", "ports", "env", "volumes", "healthcheck", "restart_policy", "depends_on", "resources", "replicas"],
  service:        ["image", "command", "ports", "env", "volumes", "healthcheck", "restart_policy", "depends_on", "replicas"],
  database:       ["image", "engine_version", "ports", "env", "volumes", "credentials", "resources"],
  cache:          ["image", "ports", "env", "volumes", "resources"],
  queue:          ["image", "ports", "env", "volumes", "resources"],
  reverse_proxy:  ["image", "ports", "domain", "ssl", "depends_on"],
  load_balancer:  ["image", "ports", "domain", "ssl", "depends_on"],
  cdn:            ["domain", "ssl", "provider"],
  object_storage: ["provider", "region", "credentials"],
  external:       ["domain", "credentials"],
  dns:            ["domain"],
  secret_store:   ["credentials"],
  scheduler:      ["image", "command", "env", "depends_on"],
  network:        ["cidr", "ports"],
};

const RESTART_POLICIES = ["no", "always", "unless-stopped", "on-failure"] as const;
const PROVIDERS = ["aws_s3", "gcs", "hetzner_object_storage", "scaleway_object", "minio", "other"] as const;

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
}

export function NodeConfigDialog({ open, onOpenChange, node, otherNodeIds, onSave, onDelete }: Props) {
  // Local draft, synced from prop on every open.
  const [draft, setDraft] = useState<TopologyNode | null>(node);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft(node); }, [node?.id, open]);

  if (!draft) return null;
  const features = KIND_FEATURES[draft.kind] ?? [];

  // Convenience meta accessors (everything past the typed columns lives in meta).
  const meta = (draft.meta ?? {}) as Record<string, any>;
  function patchMeta(patch: Record<string, any>) {
    setDraft({ ...draft!, meta: { ...meta, ...patch } });
  }

  async function submit() {
    setSaving(true);
    try {
      await onSave(draft!);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Configure node
            <Badge variant="outline" className="text-[10px] uppercase">{draft.kind.replace(/_/g, " ")}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          {/* Common identity fields */}
          <Section title="Identity">
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
          </Section>

          {features.includes("image") && (
            <Section title="Image">
              <Field label="Image">
                <Input
                  value={(draft.image ?? "") as string}
                  onChange={(e) => setDraft({ ...draft, image: e.target.value })}
                  placeholder="nginx:1.27-alpine"
                  className="font-mono"
                />
              </Field>
            </Section>
          )}

          {features.includes("command") && (
            <Section title="Command">
              <Field label="Command override">
                <Input
                  value={(draft.command ?? "") as string}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  placeholder='["npm","run","start"] or node server.js'
                  className="font-mono"
                />
              </Field>
            </Section>
          )}

          {features.includes("engine_version") && (
            <Section title="Engine">
              <Field label="Engine version">
                <Input
                  value={meta.engine_version ?? ""}
                  onChange={(e) => patchMeta({ engine_version: e.target.value })}
                  placeholder="postgres 16, redis 7…"
                  className="font-mono"
                />
              </Field>
            </Section>
          )}

          {features.includes("ports") && (
            <Section title="Ports">
              <StringList
                values={draft.ports ?? []}
                onChange={(vals) => setDraft({ ...draft, ports: vals })}
                placeholder="e.g. 80, 443, 5432"
                hint="Ports exposed by this node."
                inputClassName="font-mono"
              />
            </Section>
          )}

          {features.includes("env") && (
            <Section title="Environment variables">
              <StringList
                values={draft.env ?? []}
                onChange={(vals) => setDraft({ ...draft, env: vals })}
                placeholder="STRIPE_SECRET_KEY"
                hint="Names only — actual values come from the Vault."
                inputClassName="font-mono"
              />
            </Section>
          )}

          {features.includes("volumes") && (
            <Section title="Volumes">
              <StringList
                values={draft.volumes ?? []}
                onChange={(vals) => setDraft({ ...draft, volumes: vals })}
                placeholder="./data:/var/lib/postgres/data"
                hint="Bind mounts or named volumes (host:container)."
                inputClassName="font-mono"
              />
            </Section>
          )}

          {features.includes("healthcheck") && (
            <Section title="Healthcheck">
              <Field label="Test command">
                <Input
                  value={(draft.healthcheck ?? "") as string}
                  onChange={(e) => setDraft({ ...draft, healthcheck: e.target.value })}
                  placeholder='["CMD-SHELL","curl -f http://localhost/health || exit 1"]'
                  className="font-mono"
                />
              </Field>
              <Row>
                <Field label="Interval">
                  <Input value={meta.hc_interval ?? ""} onChange={(e) => patchMeta({ hc_interval: e.target.value })} placeholder="30s" />
                </Field>
                <Field label="Timeout">
                  <Input value={meta.hc_timeout ?? ""} onChange={(e) => patchMeta({ hc_timeout: e.target.value })} placeholder="5s" />
                </Field>
                <Field label="Retries">
                  <Input value={meta.hc_retries ?? ""} onChange={(e) => patchMeta({ hc_retries: e.target.value })} placeholder="3" />
                </Field>
              </Row>
            </Section>
          )}

          {features.includes("restart_policy") && (
            <Section title="Restart policy">
              <Field label="Policy">
                <Select
                  value={meta.restart_policy ?? "unless-stopped"}
                  onChange={(v) => patchMeta({ restart_policy: v })}
                  options={RESTART_POLICIES.map((p) => ({ value: p, label: p }))}
                />
              </Field>
            </Section>
          )}

          {features.includes("depends_on") && (
            <Section title="Depends on">
              <MultiPick
                values={(meta.depends_on ?? []) as string[]}
                onChange={(vals) => patchMeta({ depends_on: vals })}
                options={otherNodeIds.filter((id) => id !== draft.id)}
                emptyLabel="No other nodes to depend on."
              />
            </Section>
          )}

          {features.includes("resources") && (
            <Section title="Resources">
              <Row>
                <Field label="CPU limit">
                  <Input value={meta.cpu_limit ?? ""} onChange={(e) => patchMeta({ cpu_limit: e.target.value })} placeholder="1.0 (cores)" />
                </Field>
                <Field label="Memory limit">
                  <Input value={meta.mem_limit ?? ""} onChange={(e) => patchMeta({ mem_limit: e.target.value })} placeholder="512m" />
                </Field>
              </Row>
              <Row>
                <Field label="CPU request">
                  <Input value={meta.cpu_request ?? ""} onChange={(e) => patchMeta({ cpu_request: e.target.value })} placeholder="0.25" />
                </Field>
                <Field label="Memory request">
                  <Input value={meta.mem_request ?? ""} onChange={(e) => patchMeta({ mem_request: e.target.value })} placeholder="128m" />
                </Field>
              </Row>
            </Section>
          )}

          {features.includes("replicas") && (
            <Section title="Replicas">
              <Field label="Desired replicas">
                <Input
                  type="number" min={1}
                  value={meta.replicas ?? ""}
                  onChange={(e) => patchMeta({ replicas: e.target.value })}
                  placeholder="1"
                />
              </Field>
            </Section>
          )}

          {features.includes("ip_address") && (
            <Section title="Network">
              <Row>
                <Field label="IP address">
                  <Input value={meta.ip_address ?? ""} onChange={(e) => patchMeta({ ip_address: e.target.value })} placeholder="1.2.3.4" className="font-mono" />
                </Field>
                <Field label="OS / Image">
                  <Input value={meta.os ?? ""} onChange={(e) => patchMeta({ os: e.target.value })} placeholder="ubuntu-22.04" />
                </Field>
              </Row>
            </Section>
          )}

          {features.includes("ssh") && (
            <Section title="SSH">
              <Row>
                <Field label="User">
                  <Input value={meta.ssh_user ?? ""} onChange={(e) => patchMeta({ ssh_user: e.target.value })} placeholder="root" />
                </Field>
                <Field label="Port">
                  <Input type="number" value={meta.ssh_port ?? ""} onChange={(e) => patchMeta({ ssh_port: e.target.value })} placeholder="22" />
                </Field>
              </Row>
            </Section>
          )}

          {features.includes("domain") && (
            <Section title="Domain">
              <Field label="Domain name">
                <Input value={meta.domain ?? ""} onChange={(e) => patchMeta({ domain: e.target.value })} placeholder="app.example.com" />
              </Field>
            </Section>
          )}

          {features.includes("ssl") && (
            <Section title="SSL">
              <Row>
                <Field label="SSL mode">
                  <Select
                    value={meta.ssl_mode ?? "letsencrypt"}
                    onChange={(v) => patchMeta({ ssl_mode: v })}
                    options={[
                      { value: "off", label: "Off" },
                      { value: "letsencrypt", label: "Let's Encrypt" },
                      { value: "byo", label: "Bring your own cert" },
                    ]}
                  />
                </Field>
                <Field label="Email (for letsencrypt)">
                  <Input value={meta.ssl_email ?? ""} onChange={(e) => patchMeta({ ssl_email: e.target.value })} placeholder="ops@example.com" />
                </Field>
              </Row>
            </Section>
          )}

          {features.includes("provider") && (
            <Section title="Provider">
              <Field label="Provider">
                <Select
                  value={meta.provider ?? "other"}
                  onChange={(v) => patchMeta({ provider: v })}
                  options={PROVIDERS.map((p) => ({ value: p, label: p }))}
                />
              </Field>
            </Section>
          )}

          {features.includes("region") && (
            <Section title="Region">
              <Field label="Region code">
                <Input value={meta.region ?? ""} onChange={(e) => patchMeta({ region: e.target.value })} placeholder="eu-west-1, fr-par, nbg1…" className="font-mono" />
              </Field>
            </Section>
          )}

          {features.includes("cidr") && (
            <Section title="CIDR">
              <Field label="CIDR block">
                <Input value={meta.cidr ?? ""} onChange={(e) => patchMeta({ cidr: e.target.value })} placeholder="10.0.0.0/24" className="font-mono" />
              </Field>
            </Section>
          )}

          {features.includes("credentials") && (
            <Section title="Credentials">
              <Field label="Vault secret reference">
                <Input
                  value={meta.credentials_ref ?? ""}
                  onChange={(e) => patchMeta({ credentials_ref: e.target.value })}
                  placeholder="vault:projects/<id>/<secret-name>"
                  className="font-mono"
                />
              </Field>
              <p className="text-[10px] text-muted-foreground">
                Reference only — never paste secrets here.
              </p>
            </Section>
          )}

          {/* Free-form notes are universal */}
          <Section title="Notes">
            <textarea
              value={meta.notes ?? ""}
              onChange={(e) => patchMeta({ notes: e.target.value })}
              rows={2}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Anything that doesn't fit elsewhere…"
            />
          </Section>
        </div>

        <div className="flex items-center justify-between border-t border-border pt-3">
          <div>
            {onDelete && (
              <Button variant="ghost" onClick={onDelete} className="gap-1.5 text-destructive hover:text-destructive">
                <Trash2 className="h-3.5 w-3.5" /> Delete node
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={submit} disabled={saving || !draft.label.trim()} className="gap-1.5">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Tiny presentation primitives
// ============================================================================

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-card/40 p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">{title}</div>
      <div className="space-y-2">{children}</div>
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

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-2 md:grid-cols-3">{children}</div>;
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
      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function StringList({
  values, onChange, placeholder, hint, inputClassName,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  hint?: string;
  inputClassName?: string;
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
              <code className={cn("flex-1 truncate text-[11px]", inputClassName)}>{v}</code>
              <Button size="sm" variant="ghost" onClick={() => onChange(values.filter((_, j) => j !== i))}>
                <Trash2 className="h-3 w-3 text-destructive" />
              </Button>
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
          className={inputClassName}
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
