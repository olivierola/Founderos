import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Key, Plus, Loader2, Webhook, Workflow, Copy, Trash2, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { ExportMenu } from "@/components/ExportMenu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

// --- API Keys (real, server-side hashed) --------------------------------
export function ApiKeysPage() {
  const { workspaceId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [lastFull, setLastFull] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["api_keys", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase
        .from("founder_api_keys")
        .select("*")
        .eq("workspace_id", workspaceId!)
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  async function create() {
    if (!workspaceId || !label) return;
    setCreating(true);
    try {
      const res = await callEdge<{ api_key: string }>("issue-api-key", { workspace_id: workspaceId, label });
      setLastFull(res.api_key);
      setLabel("");
      queryClient.invalidateQueries({ queryKey: ["api_keys", workspaceId] });
    } finally {
      setCreating(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Revoke this key?")) return;
    await supabase.from("founder_api_keys").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["api_keys", workspaceId] });
  }

  return (
    <div>
      <PageHeader
        title="API Keys"
        description="Personal API keys to call FounderOS programmatically. Stored as SHA-256 hashes — the plaintext is shown once."
      />

      <Card className="mb-6">
        <CardContent className="flex gap-2 p-4">
          <Input placeholder="Key label (e.g. CI bot)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button onClick={create} disabled={creating || !label}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Generate
          </Button>
        </CardContent>
      </Card>

      {lastFull && (
        <Card className="mb-6 border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="p-4 text-sm">
            <div className="mb-1 text-xs uppercase text-emerald-400">New key — copy now, it won't show again</div>
            <div className="flex items-center justify-between gap-2">
              <code className="break-all">{lastFull}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(lastFull);
                  setLastFull(null);
                }}
              >
                <Copy className="h-3.5 w-3.5" /> Copy
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!data || data.length === 0 ? (
        <EmptyState icon={Key} title="No API keys yet" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {data.map((k: any) => (
                <li key={k.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <div>
                    <div className="font-medium">{k.label}</div>
                    <div className="font-mono text-xs text-muted-foreground">{k.key_prefix}…</div>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    {k.last_used_at && <span>last used {new Date(k.last_used_at).toLocaleDateString()}</span>}
                    <span>{new Date(k.created_at).toLocaleDateString()}</span>
                    <Button size="icon" variant="ghost" onClick={() => remove(k.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// --- Webhooks Out (deliveries list) -------------------------------------
export function WebhooksOutPage() {
  const { projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState<string | null>(null);

  async function retry(d: any) {
    if (!d.webhook_id) return;
    setRetrying(d.id);
    try {
      await callEdge("dispatch-webhook", {
        webhook_id: d.webhook_id,
        event_type: d.event_type,
        payload: d.payload ?? {},
      });
      await queryClient.invalidateQueries({ queryKey: ["webhook_deliveries", projectId] });
    } finally {
      setRetrying(null);
    }
  }

  const { data: deliveries } = useQuery({
    queryKey: ["webhook_deliveries", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("webhook_deliveries")
        .select("*, outgoing_webhooks(name, url)")
        .order("created_at", { ascending: false })
        .limit(50);
      return data ?? [];
    },
  });

  return (
    <div>
      <PageHeader
        title="Webhook deliveries"
        description="Recent webhook deliveries. Manage endpoints from Actions → Webhooks."
        actions={
          <ExportMenu
            rows={(deliveries ?? []).map((d: any) => ({
              when: d.created_at,
              webhook: d.outgoing_webhooks?.name,
              event: d.event_type,
              status: d.status_code,
            }))}
            filename="webhook-deliveries"
          />
        }
      />
      {!deliveries || deliveries.length === 0 ? (
        <EmptyState icon={Webhook} title="No deliveries yet" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Webhook</th>
                  <th className="px-4 py-3">Event</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {deliveries.map((d: any) => (
                  <tr key={d.id}>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{new Date(d.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3 text-sm">{d.outgoing_webhooks?.name ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs">{d.event_type}</td>
                    <td className="px-4 py-3">
                      <Badge variant={d.status_code && d.status_code >= 200 && d.status_code < 300 ? "success" : "destructive"}>
                        {d.status_code ?? "error"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="outline" onClick={() => retry(d)} disabled={retrying === d.id}>
                        {retrying === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        Retry
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// --- Automation (receiver endpoint info + setup) -------------------------
export function AutomationPage() {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/automation-receiver`;
  const example = `curl -X POST '${url}' \\\n  -H 'Authorization: Bearer YOUR_FOS_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{ "event": "lead.captured", "project_id": "...", "data": { "email": "x@y.com" } }'`;

  return (
    <div>
      <PageHeader
        title="Automation"
        description="Receive events from n8n / Make / Zapier or any HTTP client. Each event is tracked and can trigger a Workflow."
      />
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Workflow className="h-4 w-4" /> Webhook endpoint
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background/40 p-3">
            <code className="break-all text-xs">{url}</code>
            <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(url)}>
              <Copy className="h-3.5 w-3.5" /> Copy
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Authenticate with a FounderOS API key (Integrations → API Keys). Events are stored in product_events and
            can fire matching workflows automatically.
          </p>
          <pre className="overflow-x-auto rounded-lg border border-border bg-background/40 p-3 text-xs">{example}</pre>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-2 p-5 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <Workflow className="h-4 w-4 text-primary" /> n8n / Make / Zapier setup
          </div>
          <ol className="ml-5 list-decimal space-y-1 text-muted-foreground">
            <li>Add an HTTP Request node (POST)</li>
            <li>URL → the endpoint above</li>
            <li>
              Authorization header → <code className="text-foreground">Bearer YOUR_FOS_API_KEY</code>
            </li>
            <li>
              Body → JSON with at least <code className="text-foreground">event</code> and{" "}
              <code className="text-foreground">project_id</code>
            </li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
