import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, Eye, Plug } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { PROVIDERS, findProvider, type ProviderDef } from "@/lib/providers";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { ConnectorDialog } from "./ConnectorDialog";

interface ConnectorRow {
  id: string;
  provider: string;
  status: string;
  permissions: string;
  metadata: Record<string, unknown>;
}

export function CatalogPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const [openProvider, setOpenProvider] = useState<ProviderDef | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  // Deep link from Dependencies: ?connect=<provider-slug> opens the config modal.
  useEffect(() => {
    const slug = searchParams.get("connect");
    if (slug) {
      const p = findProvider(slug);
      if (p) setOpenProvider(p);
      searchParams.delete("connect");
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: connectors } = useQuery({
    queryKey: ["connectors", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase.from("connectors").select("*").eq("project_id", projectId!);
      return (data ?? []) as ConnectorRow[];
    },
  });

  // Pull latest scan_results to infer which services were "detected"
  const { data: latestScan } = useQuery({
    queryKey: ["latest-scan", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("scan_results")
        .select("services")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data?.services ?? []) as { service: string; category: string }[];
    },
  });

  const detectedSet = useMemo(
    () => new Set((latestScan ?? []).map((s) => s.service)),
    [latestScan],
  );
  const connectedMap = useMemo(() => {
    const m = new Map<string, ConnectorRow>();
    (connectors ?? []).forEach((c) => m.set(c.provider, c));
    return m;
  }, [connectors]);

  if (!workspaceId || !projectId) {
    return (
      <div>
        <PageHeader title="Catalog" />
        <EmptyState icon={Plug} title="Loading workspace…" />
      </div>
    );
  }

  const groups = [
    "repo",
    "payments",
    "backend",
    "hosting",
    "ai",
    "analytics",
    "monitoring",
    "messaging",
    "email",
    "storage",
    "automation",
    "marketing",
    "crm",
    "tooling",
    "security",
  ] as const;

  return (
    <div>
      <PageHeader
        title="Catalog"
        description="Connect the services that power your SaaS. We use detected stack from your latest scan to suggest priorities."
      />

      <div className="space-y-8">
        {groups.map((group) => {
          const items = PROVIDERS.filter((p) => p.category === group);
          if (items.length === 0) return null;
          return (
            <section key={group}>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group}
              </h2>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {items.map((provider) => {
                  const Icon = provider.icon;
                  const connector = connectedMap.get(provider.slug);
                  const detected = detectedSet.has(provider.slug);
                  return (
                    <Card
                      key={provider.slug}
                      className="group cursor-pointer transition-colors hover:border-primary/40"
                      onClick={() => setOpenProvider(provider)}
                    >
                      <CardContent className="flex items-start gap-3 p-4">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary">
                          <Icon className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">{provider.name}</span>
                            {connector ? (
                              <Badge variant="success">
                                <CheckCircle2 className="mr-1 h-3 w-3" /> connected
                              </Badge>
                            ) : detected ? (
                              <Badge variant="warning">
                                <Eye className="mr-1 h-3 w-3" /> detected
                              </Badge>
                            ) : (
                              <Badge variant="secondary">
                                <CircleDashed className="mr-1 h-3 w-3" /> available
                              </Badge>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{provider.description}</p>
                          <div className="mt-3 h-8">
                            <Button
                              size="sm"
                              variant={connector ? "outline" : "default"}
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenProvider(provider);
                              }}
                              className="opacity-0 transition-opacity group-hover:opacity-100"
                            >
                              {connector ? "Reconnect" : "Connect"}
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <ConnectorDialog
        open={!!openProvider}
        onOpenChange={(o) => !o && setOpenProvider(null)}
        provider={openProvider}
        workspaceId={workspaceId}
        projectId={projectId}
        onConnected={() => {
          queryClient.invalidateQueries({ queryKey: ["connectors", projectId] });
        }}
      />
    </div>
  );
}
