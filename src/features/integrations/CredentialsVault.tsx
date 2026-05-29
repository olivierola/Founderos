import { useQuery } from "@tanstack/react-query";
import { Key, ShieldCheck, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { findProvider } from "@/lib/providers";
import { useCurrentContext } from "@/hooks/useCurrentContext";

interface CredentialRow {
  id: string;
  connector_id: string;
  key_version: string;
  created_at: string;
  updated_at: string;
  connectors: { provider: string } | null;
}

export function CredentialsVaultPage() {
  const { workspaceId } = useCurrentContext();

  // Credentials are read-only and never expose plaintext to the client.
  // We fetch through connectors join so RLS gives us the visible rows.
  const { data: credentials, isLoading } = useQuery({
    queryKey: ["credentials", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase
        .from("connectors")
        .select("id, provider, encrypted_credentials(id, key_version, created_at, updated_at)")
        .eq("workspace_id", workspaceId!);
      const rows: CredentialRow[] = [];
      (data ?? []).forEach((c: any) => {
        (c.encrypted_credentials ?? []).forEach((cred: any) =>
          rows.push({ ...cred, connector_id: c.id, connectors: { provider: c.provider } }),
        );
      });
      return rows;
    },
  });

  return (
    <div>
      <PageHeader
        title="Credentials Vault"
        description="All connector credentials are encrypted with AES-GCM before storage. Plaintext is never returned to the browser."
        actions={
          <div className="flex gap-2">
            <ExportMenu
              rows={(credentials ?? []).map((c) => ({
                provider: c.connectors?.provider,
                key_version: c.key_version,
                created: c.created_at,
                updated: c.updated_at,
              }))}
              filename="credentials"
            />
            <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-emerald-400" /> AES-GCM 256-bit
            </div>
          </div>
        }
      />

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !credentials || credentials.length === 0 ? (
        <EmptyState
          icon={Key}
          title="No credentials stored"
          description="Connect a provider in the Catalog and credentials will appear here, fully encrypted."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Provider</th>
                  <th className="px-4 py-3 font-medium">Key version</th>
                  <th className="px-4 py-3 font-medium">Stored</th>
                  <th className="px-4 py-3 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {credentials.map((c) => {
                  const def = findProvider(c.connectors?.provider ?? "");
                  const Icon = def?.icon ?? Key;
                  return (
                    <tr key={c.id}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Icon className="h-4 w-4 text-muted-foreground" />
                          <span>{def?.name ?? c.connectors?.provider}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline">{c.key_version}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(c.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(c.updated_at).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
