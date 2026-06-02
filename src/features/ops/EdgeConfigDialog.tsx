import { useEffect, useState, useRef } from "react";
import { Trash2, Save, Loader2, X, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { EdgeKind, TopologyEdge, TopologyNode } from "./ArchitectureView";

const EDGE_KINDS: Array<{ value: EdgeKind; label: string; desc: string }> = [
  { value: "http",         label: "HTTP",          desc: "Plain HTTP traffic" },
  { value: "https",        label: "HTTPS",         desc: "Encrypted HTTP — animated" },
  { value: "tcp",          label: "TCP",           desc: "Raw TCP connection" },
  { value: "ssh",          label: "SSH",           desc: "Management / deploy access" },
  { value: "env",          label: "Env var",       desc: "Configuration coupling" },
  { value: "webhook",      label: "Webhook",       desc: "Async callback — animated" },
  { value: "volume_mount", label: "Volume mount",  desc: "Filesystem dependency" },
  { value: "depends_on",   label: "Depends on",    desc: "Boot-order dependency" },
  { value: "network_link", label: "Network link",  desc: "Generic network membership" },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  edge: TopologyEdge | null;
  /** Source + target nodes, for the header label. */
  sourceNode: TopologyNode | null;
  targetNode: TopologyNode | null;
  /** All nodes — used to let the user re-route the edge. */
  allNodes: TopologyNode[];
  onSave: (next: TopologyEdge) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  /** When true, saves on every change after a short debounce. */
  autoSave?: boolean;
}

export function EdgeConfigDialog({
  open, onOpenChange, edge, sourceNode, targetNode, allNodes,
  onSave, onDelete, autoSave,
}: Props) {
  const [draft, setDraft] = useState<TopologyEdge | null>(edge);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => { setDraft(edge); setSavedAt(null); }, [edge?.id, open]);

  // Debounced auto-save.
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!autoSave || !draft || !open) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(async () => {
      try { await onSave(draft); setSavedAt(Date.now()); }
      catch { /* swallow — explicit Save still available */ }
    }, 600);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, autoSave, open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onOpenChange(false); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open || !draft) return null;
  const meta = (draft.meta ?? {}) as Record<string, any>;
  function patchMeta(patch: Record<string, any>) {
    setDraft({ ...draft!, meta: { ...meta, ...patch } });
  }

  async function explicitSave() {
    setSaving(true);
    try { await onSave(draft!); setSavedAt(Date.now()); }
    finally { setSaving(false); }
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={() => onOpenChange(false)} />
      <aside
        role="dialog"
        aria-label="Configure edge"
        className="fixed inset-y-0 right-0 z-50 flex w-[400px] max-w-[95vw] flex-col border-l border-border bg-card shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Edit connection</h2>
              <Badge variant="outline" className="text-[10px] uppercase">{draft.kind}</Badge>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="truncate font-mono">{sourceNode?.label ?? draft.source}</span>
              <ArrowRight className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono">{targetNode?.label ?? draft.target}</span>
            </div>
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
          {/* Kind picker */}
          <div className="rounded-md border border-border bg-card/40 p-3">
            <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">Connection kind</div>
            <div className="grid grid-cols-3 gap-1.5">
              {EDGE_KINDS.map((k) => (
                <button
                  key={k.value}
                  onClick={() => setDraft({ ...draft, kind: k.value })}
                  className={cn(
                    "rounded border px-2 py-1.5 text-left text-[10px] transition-colors",
                    draft.kind === k.value
                      ? "border-foreground bg-foreground/10 text-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                  )}
                  title={k.desc}
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>

          {/* Source / target reroute */}
          <Section title="Endpoints">
            <Field label="Source">
              <Select
                value={draft.source}
                onChange={(v) => setDraft({ ...draft, source: v })}
                options={allNodes.map((n) => ({ value: n.id, label: `${n.label} (${n.id})` }))}
              />
            </Field>
            <Field label="Target">
              <Select
                value={draft.target}
                onChange={(v) => setDraft({ ...draft, target: v })}
                options={allNodes.filter((n) => n.id !== draft.source).map((n) => ({ value: n.id, label: `${n.label} (${n.id})` }))}
              />
            </Field>
          </Section>

          {/* Common attributes */}
          <Section title="Attributes">
            <Field label="Label">
              <Input
                value={draft.label ?? ""}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="e.g. user requests"
              />
            </Field>
            <Field label="Port">
              <Input
                value={draft.port ?? ""}
                onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                placeholder="80, 443, 5432…"
                className="font-mono"
              />
            </Field>
            <Field label="Protocol">
              <Input
                value={draft.protocol ?? ""}
                onChange={(e) => setDraft({ ...draft, protocol: e.target.value })}
                placeholder="tcp, udp, grpc, mqtt…"
                className="font-mono"
              />
            </Field>
            <CheckRow
              label="Encrypted in transit"
              value={!!draft.encrypted}
              onChange={(v) => setDraft({ ...draft, encrypted: v })}
            />
          </Section>

          {/* Per-kind extras */}
          {draft.kind === "http" || draft.kind === "https" ? (
            <Section title="HTTP details">
              <Field label="Method">
                <Select
                  value={meta.method ?? "ANY"}
                  onChange={(v) => patchMeta({ method: v })}
                  options={["ANY", "GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m }))}
                />
              </Field>
              <Field label="Path prefix">
                <Input value={meta.path ?? ""} onChange={(e) => patchMeta({ path: e.target.value })} placeholder="/api" className="font-mono" />
              </Field>
              <Field label="Expected status">
                <Input value={meta.expected_status ?? ""} onChange={(e) => patchMeta({ expected_status: e.target.value })} placeholder="200" />
              </Field>
            </Section>
          ) : null}

          {draft.kind === "webhook" && (
            <Section title="Webhook details">
              <Field label="Event">
                <Input value={meta.event ?? ""} onChange={(e) => patchMeta({ event: e.target.value })} placeholder="payment.succeeded" className="font-mono" />
              </Field>
              <Field label="Secret env var">
                <Input value={meta.secret_env ?? ""} onChange={(e) => patchMeta({ secret_env: e.target.value })} placeholder="STRIPE_WEBHOOK_SECRET" className="font-mono" />
              </Field>
              <CheckRow label="Retry on failure" value={!!meta.retry} onChange={(v) => patchMeta({ retry: v })} />
            </Section>
          )}

          {draft.kind === "tcp" && (
            <Section title="TCP details">
              <Field label="Direction">
                <Select
                  value={meta.direction ?? "out"}
                  onChange={(v) => patchMeta({ direction: v })}
                  options={[{ value: "in", label: "Inbound" }, { value: "out", label: "Outbound" }, { value: "both", label: "Both" }]}
                />
              </Field>
            </Section>
          )}

          {draft.kind === "ssh" && (
            <Section title="SSH details">
              <Field label="User">
                <Input value={meta.ssh_user ?? ""} onChange={(e) => patchMeta({ ssh_user: e.target.value })} placeholder="deploy" />
              </Field>
              <CheckRow label="Restrict to known IPs" value={!!meta.ssh_ip_restricted} onChange={(v) => patchMeta({ ssh_ip_restricted: v })} />
            </Section>
          )}

          {draft.kind === "env" && (
            <Section title="Env coupling">
              <Field label="Variable name">
                <Input value={meta.var_name ?? ""} onChange={(e) => patchMeta({ var_name: e.target.value })} placeholder="DATABASE_URL" className="font-mono" />
              </Field>
            </Section>
          )}

          {draft.kind === "volume_mount" && (
            <Section title="Volume details">
              <Field label="Mount path (container)">
                <Input value={meta.mount_path ?? ""} onChange={(e) => patchMeta({ mount_path: e.target.value })} placeholder="/var/lib/postgres" className="font-mono" />
              </Field>
              <Field label="Access mode">
                <Select
                  value={meta.access_mode ?? "rw"}
                  onChange={(v) => patchMeta({ access_mode: v })}
                  options={[{ value: "rw", label: "Read-write" }, { value: "ro", label: "Read-only" }]}
                />
              </Field>
            </Section>
          )}

          {draft.kind === "depends_on" && (
            <Section title="Boot order">
              <Field label="Condition">
                <Select
                  value={meta.condition ?? "service_started"}
                  onChange={(v) => patchMeta({ condition: v })}
                  options={[
                    { value: "service_started", label: "Started" },
                    { value: "service_healthy", label: "Healthy" },
                    { value: "service_completed_successfully", label: "Completed OK" },
                  ]}
                />
              </Field>
            </Section>
          )}

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

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-3">
          {onDelete ? (
            <Button variant="ghost" onClick={onDelete} className="gap-1.5 text-destructive hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
            <Button onClick={explicitSave} disabled={saving} className="gap-1.5">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}

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
