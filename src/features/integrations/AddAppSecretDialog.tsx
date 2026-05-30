import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, AlertCircle, CheckCircle2, KeyRound, Link2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { findProvider, PROVIDERS } from "@/lib/providers";

// Backends supported by the propagate-credential edge function.
const BACKEND_PROVIDERS = [
  "supabase",
  "vercel",
  "railway",
  "render",
  "cloudflare",
  "aws-s3",
  "runpod",
  "firebase",
] as const;
type BackendProvider = (typeof BACKEND_PROVIDERS)[number];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  projectId: string;
  /** Optional preset for "Add this provider's key to my backend" */
  presetKey?: string;
  /** When the key was detected from a code scan, pre-fill the recommended provider source. */
  presetSourceProvider?: string;
  onSuccess?: () => void;
}

interface PropagationResult {
  provider: string;
  env_name: string;
  ok: boolean;
  error?: string;
}

export function AddAppSecretDialog({
  open,
  onOpenChange,
  workspaceId,
  projectId,
  presetKey,
  presetSourceProvider,
  onSuccess,
}: Props) {
  const [key, setKey] = useState(presetKey ?? "");
  const [mode, setMode] = useState<"vault" | "manual">(presetSourceProvider ? "vault" : "manual");
  const [sourceProvider, setSourceProvider] = useState<string>(presetSourceProvider ?? "");
  const [sourceField, setSourceField] = useState<string>("");
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState<Set<BackendProvider>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<PropagationResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setKey(presetKey ?? "");
      setMode(presetSourceProvider ? "vault" : "manual");
      setSourceProvider(presetSourceProvider ?? "");
      setSourceField("");
      setValue("");
      setResults(null);
      setError(null);
    }
  }, [open, presetKey, presetSourceProvider]);

  // Detect which target backends are actually connected for this project.
  const { data: connectedBackends, isLoading: loadingTargets } = useQuery({
    queryKey: ["propagation_targets", projectId],
    enabled: open && !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("connectors")
        .select("provider, metadata")
        .eq("project_id", projectId)
        .in("provider", BACKEND_PROVIDERS as unknown as string[]);
      return (data ?? []) as Array<{ provider: BackendProvider; metadata: Record<string, unknown> }>;
    },
  });

  const connectedSet = useMemo(
    () => new Set((connectedBackends ?? []).map((c) => c.provider)),
    [connectedBackends],
  );

  // All catalog connectors configured for this project — usable as a source
  // for the value (we reuse e.g. stripe.secret_key instead of asking again).
  const { data: allConnectors } = useQuery({
    queryKey: ["all_connectors_for_source", projectId],
    enabled: open && !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("connectors")
        .select("provider")
        .eq("project_id", projectId);
      return (data ?? []) as Array<{ provider: string }>;
    },
  });

  // Sources usable in "vault" mode: configured providers that are NOT a backend
  // (it makes no sense to push e.g. supabase.access_token to supabase secrets).
  const vaultSources = useMemo(() => {
    const slugs = new Set((allConnectors ?? []).map((c) => c.provider));
    return PROVIDERS.filter(
      (p) =>
        slugs.has(p.slug) &&
        !(BACKEND_PROVIDERS as readonly string[]).includes(p.slug) &&
        !p.slug.startsWith("app-secret:"),
    );
  }, [allConnectors]);

  const sourceProviderDef = sourceProvider ? findProvider(sourceProvider) : null;

  // Auto-pick the first secret field of the chosen source.
  useEffect(() => {
    if (mode === "vault" && sourceProviderDef && !sourceField) {
      const secret = sourceProviderDef.fields.find((f) => f.secret);
      if (secret) setSourceField(secret.key);
    }
  }, [mode, sourceProviderDef, sourceField]);

  // Default selection = all detected backends.
  useMemo(() => {
    if (connectedBackends && selected.size === 0 && results === null) {
      setSelected(new Set(connectedBackends.map((c) => c.provider)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedBackends]);

  function toggle(p: BackendProvider) {
    const next = new Set(selected);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setSelected(next);
  }

  const canSubmit =
    !!key.trim() &&
    selected.size > 0 &&
    (mode === "manual" ? !!value.trim() : !!sourceProvider && !!sourceField);

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setResults(null);
    try {
      const body: Record<string, unknown> = {
        workspace_id: workspaceId,
        project_id: projectId,
        key: key.trim(),
        targets: Array.from(selected).map((p) => ({ provider: p })),
      };
      if (mode === "manual") body.value = value;
      else body.source = { provider: sourceProvider, field: sourceField };

      const res = await callEdge<{ results: PropagationResult[] }>("propagate-credential", body);
      setResults(res.results);
      const allOk = res.results.every((r) => r.ok);
      if (allOk) {
        onSuccess?.();
        setTimeout(() => {
          onOpenChange(false);
        }, 1200);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setResults(null);
          setError(null);
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add an app secret</DialogTitle>
          <DialogDescription>
            FounderOS will encrypt this value in the vault and push it to the backend(s) you select.
            Plaintext is never returned to the browser.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="secret-key" className="text-xs text-muted-foreground">
              Variable name
            </label>
            <Input
              id="secret-key"
              placeholder="STRIPE_SECRET_KEY"
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              disabled={!!presetKey || submitting}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setMode("vault")}
                disabled={submitting || vaultSources.length === 0}
                className={
                  "inline-flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 transition-colors " +
                  (mode === "vault"
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground disabled:opacity-50")
                }
                title={vaultSources.length === 0 ? "No configured catalog credential to reuse" : ""}
              >
                <Link2 className="h-3.5 w-3.5" />
                Reuse from catalog
              </button>
              <button
                type="button"
                onClick={() => setMode("manual")}
                disabled={submitting}
                className={
                  "inline-flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 transition-colors " +
                  (mode === "manual"
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                <KeyRound className="h-3.5 w-3.5" />
                Enter manually
              </button>
            </div>

            {mode === "manual" ? (
              <div className="space-y-1.5">
                <label htmlFor="secret-value" className="text-xs text-muted-foreground">
                  Value
                </label>
                <Input
                  id="secret-value"
                  type="password"
                  placeholder="sk_live_…"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  disabled={submitting}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground">Source provider</label>
                  <select
                    value={sourceProvider}
                    onChange={(e) => {
                      setSourceProvider(e.target.value);
                      setSourceField("");
                    }}
                    disabled={submitting}
                    className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">Select a configured provider…</option>
                    {vaultSources.map((p) => (
                      <option key={p.slug} value={p.slug}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                {sourceProviderDef && (
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground">Field</label>
                    <select
                      value={sourceField}
                      onChange={(e) => setSourceField(e.target.value)}
                      disabled={submitting}
                      className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {sourceProviderDef.fields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label} {f.secret ? "🔒" : ""}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-muted-foreground">
                      The plaintext is read server-side from the vault and never returned to the browser.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Propagate to</span>
              {loadingTargets && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {BACKEND_PROVIDERS.map((p) => {
                const def = findProvider(p);
                const connected = connectedSet.has(p);
                const isSelected = selected.has(p);
                return (
                  <label
                    key={p}
                    className={
                      "flex cursor-pointer items-start gap-2 rounded-md border p-2.5 transition-colors " +
                      (isSelected
                        ? "border-[hsl(var(--primary-soft)/0.4)] bg-[hsl(var(--primary-soft)/0.08)]"
                        : "border-border hover:bg-secondary/40") +
                      (!connected ? " opacity-60" : "")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(p)}
                      disabled={submitting}
                      className="mt-0.5 h-4 w-4 cursor-pointer rounded border-border accent-[hsl(var(--primary-soft))]"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium">{def?.name ?? p}</span>
                        {connected ? (
                          <Badge variant="success" className="text-[10px]">
                            connected
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            not connected
                          </Badge>
                        )}
                      </div>
                      {!connected && (
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          Connect it first or select anyway to attempt.
                        </p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {results && (
            <div className="space-y-1.5 rounded-md border border-border bg-secondary/30 p-3">
              <p className="text-xs font-medium">Propagation results</p>
              {results.map((r) => (
                <div key={r.provider} className="flex items-start gap-2 text-xs">
                  {r.ok ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--accent-2))]" />
                  ) : (
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                  )}
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{findProvider(r.provider)?.name ?? r.provider}</span>
                    {!r.ok && r.error && (
                      <span className="ml-1 text-muted-foreground">— {r.error}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {results?.every((r) => r.ok) ? "Done" : "Cancel"}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || !canSubmit}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Push to {selected.size} backend{selected.size > 1 ? "s" : ""}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
