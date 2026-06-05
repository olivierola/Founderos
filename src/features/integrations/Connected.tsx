import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, Plug, ShieldCheck, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { findProvider } from "@/lib/providers";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface ConnectorRow {
  id: string;
  provider: string;
  status: string;
  permissions: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export function ConnectedPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: connectors, isLoading } = useQuery({
    queryKey: ["connectors", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("connectors")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as ConnectorRow[];
    },
  });

  const [togglingWrite, setTogglingWrite] = useState<string | null>(null);

  // Providers for which the agent can perform writes (currently GitHub code instrumentation).
  const WRITABLE_PROVIDERS = new Set(["github"]);

  async function toggleWriteAccess(c: ConnectorRow) {
    if (!projectId) return;
    const enabling = c.permissions !== "write_enabled";
    if (
      enabling &&
      !confirm(
        "Enable WRITE access for the agent on this repository?\n\nThe agent will be able to PROPOSE code changes (events, feature flags, SDK). Nothing is written without an owner/admin approving each change.",
      )
    )
      return;
    setTogglingWrite(c.id);
    try {
      await supabase
        .from("connectors")
        .update({ permissions: enabling ? "write_enabled" : "read_only" })
        .eq("id", c.id);
      await queryClient.invalidateQueries({ queryKey: ["connectors", projectId] });
    } finally {
      setTogglingWrite(null);
    }
  }

  async function handleDisconnect(provider: string) {
    if (!workspaceId || !projectId) return;
    if (!confirm(`Disconnect ${provider}? Stored credentials will be erased.`)) return;
    setDisconnecting(provider);
    try {
      await callEdge("disconnect-provider", {
        workspace_id: workspaceId,
        project_id: projectId,
        provider,
      });
      await queryClient.invalidateQueries({ queryKey: ["connectors", projectId] });
    } finally {
      setDisconnecting(null);
    }
  }

  if (isLoading || !workspaceId) {
    return (
      <div>
        <PageHeader title="Connected" />
        <EmptyState icon={Loader2} title="Loading…" />
      </div>
    );
  }

  if (!connectors || connectors.length === 0) {
    return (
      <div>
        <PageHeader title="Connected" description="Active integrations for this project." />
        <EmptyState
          icon={Plug}
          title="No connectors yet"
          description="Head over to the Catalog tab to connect Stripe, GitHub, Vercel or your AI providers."
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Connected" description="Active integrations for this project." />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {connectors.map((c) => {
          const def = findProvider(c.provider);
          const Icon = def?.icon ?? Plug;
          return (
            <Card key={c.id}>
              <CardContent className="flex items-start justify-between gap-3 p-4">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{def?.name ?? c.provider}</span>
                      <Badge variant={c.status === "connected" ? "success" : "warning"}>{c.status}</Badge>
                      <Badge variant={c.permissions === "write_enabled" ? "warning" : "outline"}>
                        {c.permissions === "write_enabled" ? "write enabled" : c.permissions}
                      </Badge>
                    </div>
                    {WRITABLE_PROVIDERS.has(c.provider) && (
                      <button
                        type="button"
                        onClick={() => toggleWriteAccess(c)}
                        disabled={togglingWrite === c.id}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-50"
                        title="Allow the agent to propose code changes to this repo (each change still needs approval)"
                      >
                        {togglingWrite === c.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : c.permissions === "write_enabled" ? (
                          <ShieldCheck className="h-3.5 w-3.5 text-amber-400" />
                        ) : (
                          <ShieldAlert className="h-3.5 w-3.5" />
                        )}
                        {c.permissions === "write_enabled" ? "Agent write: ON — click to disable" : "Enable agent write access"}
                      </button>
                    )}
                    {Object.entries(c.metadata ?? {}).length > 0 && (
                      <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                        {Object.entries(c.metadata).slice(0, 4).map(([k, v]) => (
                          <li key={k}>
                            <span className="text-foreground/60">{k}:</span> {String(v ?? "—")}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-2 text-xs text-muted-foreground">
                      connected {new Date(c.created_at).toLocaleString()}
                    </div>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDisconnect(c.provider)}
                  disabled={disconnecting === c.provider}
                  title="Disconnect"
                >
                  {disconnecting === c.provider ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
