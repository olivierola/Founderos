import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Key,
  ShieldCheck,
  Loader2,
  Plus,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Code2,
  Link2,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { findProvider } from "@/lib/providers";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { AddAppSecretDialog } from "./AddAppSecretDialog";
import { AddSecretPicker, suggestEnvName } from "./AddSecretPicker";

interface DetectedEnv {
  key: string;
  detected_service: string | null;
  sensitivity: string | null;
}

interface PropagatedRow {
  key: string;
  target_provider: string;
  env_name: string;
  status: string;
  last_synced_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export function CredentialsVaultPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [presetKey, setPresetKey] = useState<string | undefined>(undefined);
  const [presetSourceProvider, setPresetSourceProvider] = useState<string | undefined>(undefined);

  // 1) Env vars detected by the latest code scan (across all repositories).
  const { data: detectedEnvs, isLoading: loadingEnvs } = useQuery({
    queryKey: ["detected_env_vars", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_results")
        .select("env_vars, created_at")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(20);
      const merged = new Map<string, DetectedEnv>();
      (data ?? []).forEach((scan: { env_vars: DetectedEnv[] | null }) => {
        (scan.env_vars ?? []).forEach((e) => {
          if (!merged.has(e.key)) merged.set(e.key, e);
        });
      });
      return Array.from(merged.values()).sort((a, b) => a.key.localeCompare(b.key));
    },
  });

  // 2) Already-propagated secrets (status per backend per key).
  const { data: propagated } = useQuery({
    queryKey: ["propagated_secrets", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("propagated_secrets")
        .select("key, target_provider, env_name, status, last_synced_at, last_error, updated_at")
        .eq("project_id", projectId!)
        .order("updated_at", { ascending: false });
      return (data ?? []) as PropagatedRow[];
    },
  });

  // 3) Configured catalog connectors (so we know which can be reused).
  const { data: connectors } = useQuery({
    queryKey: ["vault_connectors_min", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("connectors")
        .select("provider")
        .eq("project_id", projectId!);
      return (data ?? []) as Array<{ provider: string }>;
    },
  });

  const configuredSlugs = useMemo(
    () => new Set((connectors ?? []).map((c) => c.provider)),
    [connectors],
  );

  // Group propagation rows by key for fast lookup.
  const byKey = useMemo(() => {
    const m = new Map<string, PropagatedRow[]>();
    (propagated ?? []).forEach((p) => {
      const arr = m.get(p.key) ?? [];
      arr.push(p);
      m.set(p.key, arr);
    });
    return m;
  }, [propagated]);

  // 3b) Catalog connectors that already store secrets in the vault — exposed
  //     as virtual entries so the user sees them even when no scan / no
  //     propagation has happened yet.
  const catalogSecrets = useMemo(() => {
    const out: Array<{
      key: string;
      provider: string;
      field: string;
      provider_name: string;
    }> = [];
    (connectors ?? []).forEach((c) => {
      const def = findProvider(c.provider);
      if (!def) return;
      def.fields.filter((f) => f.secret).forEach((f) => {
        // Synthetic env-var name: STRIPE_SECRET_KEY, GITHUB_TOKEN, ...
        const synthetic = `${c.provider.toUpperCase().replace(/-/g, "_")}_${f.key.toUpperCase()}`;
        out.push({
          key: synthetic,
          provider: c.provider,
          field: f.key,
          provider_name: def.name,
        });
      });
    });
    return out;
  }, [connectors]);

  const catalogKeyMap = useMemo(() => {
    const m = new Map<string, (typeof catalogSecrets)[number]>();
    catalogSecrets.forEach((s) => m.set(s.key, s));
    return m;
  }, [catalogSecrets]);

  // Union of (detected) + (already pushed) + (catalog-stored) keys → vault view.
  const allKnownKeys = useMemo(() => {
    const set = new Set<string>();
    (detectedEnvs ?? []).forEach((e) => set.add(e.key));
    (propagated ?? []).forEach((p) => set.add(p.key));
    catalogSecrets.forEach((c) => set.add(c.key));
    return Array.from(set).sort();
  }, [detectedEnvs, propagated, catalogSecrets]);

  // Map detected → metadata for display.
  const detectedMap = useMemo(() => {
    const m = new Map<string, DetectedEnv>();
    (detectedEnvs ?? []).forEach((e) => m.set(e.key, e));
    return m;
  }, [detectedEnvs]);

  function openDialogFor(key: string, sourceProvider?: string) {
    setPresetKey(key);
    setPresetSourceProvider(sourceProvider);
    setDialogOpen(true);
  }

  function handlePickProvider(slug: string, suggested: string) {
    openDialogFor(suggested, configuredSlugs.has(slug) ? slug : undefined);
  }

  function handlePickCustom() {
    openDialogFor("", undefined);
  }

  return (
    <div>
      <PageHeader
        title="Credentials Vault"
        description="Variables detected in your code and their propagation status across your backends. AES-GCM 256-bit encryption — plaintext is never returned to the browser."
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setPickerOpen(true)}>
              <Plus className="h-4 w-4" />
              Add secret
            </Button>
            <ExportMenu
              rows={allKnownKeys.map((k) => {
                const rows = byKey.get(k) ?? [];
                return {
                  key: k,
                  detected_in_code: detectedMap.has(k) ? "yes" : "no",
                  detected_service: detectedMap.get(k)?.detected_service ?? "",
                  backends: rows.map((r) => `${r.target_provider}:${r.status}`).join("; "),
                  last_sync: rows
                    .map((r) => r.last_synced_at)
                    .filter(Boolean)
                    .sort()
                    .at(-1) ?? "",
                };
              })}
              filename="credentials"
            />
            <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-[hsl(var(--accent-2))]" /> AES-GCM 256-bit
            </div>
          </div>
        }
      />

      {loadingEnvs ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : allKnownKeys.length === 0 ? (
        <EmptyState
          icon={Key}
          title="No credentials detected"
          description="Run a code scan to detect environment variables, or click Add secret to push one manually."
          action={
            <Button onClick={() => setPickerOpen(true)}>
              <Plus className="h-4 w-4" />
              Add secret
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Variable</th>
                  <th className="px-4 py-3 font-medium">Source</th>
                  <th className="px-4 py-3 font-medium">Backends</th>
                  <th className="px-4 py-3 font-medium">Last sync</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {allKnownKeys.map((k) => {
                  const detected = detectedMap.get(k);
                  const fromCatalog = catalogKeyMap.get(k);
                  const rows = byKey.get(k) ?? [];
                  const lastSync = rows
                    .map((r) => r.last_synced_at)
                    .filter(Boolean)
                    .sort()
                    .at(-1);
                  const detectedService = detected?.detected_service ?? fromCatalog?.provider;
                  const reusable = detectedService && configuredSlugs.has(detectedService);

                  return (
                    <tr key={k} className="hover:bg-secondary/30">
                      <td className="px-4 py-3">
                        <div className="font-mono text-xs">{k}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                          {detected && (
                            <>
                              <Code2 className="h-3 w-3" />
                              <span>detected in code</span>
                              {detected.sensitivity === "secret" && (
                                <Badge variant="outline" className="ml-1 text-[10px]">secret</Badge>
                              )}
                            </>
                          )}
                          {fromCatalog && !detected && (
                            <>
                              <ShieldCheck className="h-3 w-3 text-[hsl(var(--accent-2))]" />
                              <span>stored in vault</span>
                            </>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {detectedService ? (
                          <div className="flex items-center gap-1.5">
                            {(() => {
                              const def = findProvider(detectedService);
                              const Icon = def?.icon ?? Key;
                              return (
                                <>
                                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                                  <span className="text-xs">{def?.name ?? detectedService}</span>
                                  {reusable && (
                                    <Badge variant="success" className="gap-1 text-[10px]">
                                      <Link2 className="h-2.5 w-2.5" />
                                      in catalog
                                    </Badge>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {rows.length === 0 ? (
                          <span className="text-xs text-muted-foreground">not pushed</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {rows.map((r) => {
                              const def = findProvider(r.target_provider);
                              const Icon = def?.icon ?? Key;
                              return (
                                <span
                                  key={r.target_provider + r.env_name}
                                  title={
                                    r.status === "synced"
                                      ? `${def?.name ?? r.target_provider} · ${r.env_name}`
                                      : (r.last_error ?? "Error")
                                  }
                                  className={
                                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] " +
                                    (r.status === "synced"
                                      ? "border-[hsl(var(--accent-2)/0.3)] bg-[hsl(var(--accent-2)/0.12)] text-[hsl(var(--accent-2))]"
                                      : "border-destructive/30 bg-destructive/10 text-destructive")
                                  }
                                >
                                  <Icon className="h-3 w-3" />
                                  {def?.name ?? r.target_provider}
                                  {r.status === "synced" ? (
                                    <CheckCircle2 className="h-3 w-3" />
                                  ) : (
                                    <AlertCircle className="h-3 w-3" />
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {lastSync ? new Date(lastSync).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {rows.length === 0 ? (
                            <Button
                              size="sm"
                              onClick={() =>
                                openDialogFor(k, reusable ? detectedService ?? undefined : undefined)
                              }
                            >
                              <Plus className="h-3.5 w-3.5" />
                              <span className="hidden sm:inline">Push</span>
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                openDialogFor(k, reusable ? detectedService ?? undefined : undefined)
                              }
                              title="Update or re-push"
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                              <span className="hidden sm:inline">Re-push</span>
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {workspaceId && projectId && (
        <>
          <AddSecretPicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            configuredSlugs={configuredSlugs}
            pushedKeys={new Set((propagated ?? []).map((p) => p.key))}
            onPickProvider={handlePickProvider}
            onPickCustom={handlePickCustom}
          />
          <AddAppSecretDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            workspaceId={workspaceId}
            projectId={projectId}
            presetKey={presetKey}
            presetSourceProvider={presetSourceProvider}
            onSuccess={async () => {
              await queryClient.invalidateQueries({ queryKey: ["propagated_secrets", projectId] });
            }}
          />
        </>
      )}
    </div>
  );
}

// Re-export the env name suggester so callers can reuse it.
export { suggestEnvName };
