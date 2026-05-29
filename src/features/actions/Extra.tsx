import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Send, Loader2, Webhook, Plus, Trash2, ShieldCheck, Check, X, Clock } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

// DatabaseConsolePage moved to ./DatabaseConsole.tsx (visual browse + query builder)
export { DatabaseConsolePage } from "./DatabaseConsole";

// --- Approvals queue ----------------------------------------------------
interface PendingAction {
  id: string;
  action_type: string;
  target_id: string | null;
  risk_level: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export function ApprovalsPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: pending, isLoading } = useQuery({
    queryKey: ["admin_actions_pending", projectId],
    enabled: !!projectId,
    refetchInterval: 8000,
    queryFn: async () => {
      const { data } = await supabase
        .from("admin_actions")
        .select("id, action_type, target_id, risk_level, payload, created_at")
        .eq("project_id", projectId!)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(50);
      return (data ?? []) as PendingAction[];
    },
  });

  async function decide(id: string, decision: "approve" | "reject") {
    if (!workspaceId) return;
    setBusyId(id);
    setError(null);
    try {
      await callEdge("admin-action-approve", { workspace_id: workspaceId, action_id: id, decision });
      queryClient.invalidateQueries({ queryKey: ["admin_actions_pending", projectId] });
      queryClient.invalidateQueries({ queryKey: ["admin_actions_recent", projectId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Approvals"
        description="High-risk actions submitted for approval. Only owners and admins can approve or reject them."
      />
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !pending || pending.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No pending approvals" description="Actions submitted for approval will appear here." />
      ) : (
        <div className="space-y-2">
          {pending.map((a) => (
            <Card key={a.id}>
              <CardContent className="flex flex-wrap items-center gap-3 p-3">
                <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm">{a.action_type}</span>
                    <Badge variant={["high", "critical"].includes(a.risk_level) ? "destructive" : "warning"}>{a.risk_level}</Badge>
                    {a.target_id && <span className="font-mono text-xs text-muted-foreground">{a.target_id}</span>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {new Date(a.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={busyId === a.id} onClick={() => decide(a.id, "reject")}>
                    <X className="h-4 w-4" /> Reject
                  </Button>
                  <Button size="sm" disabled={busyId === a.id} onClick={() => decide(a.id, "approve")}>
                    {busyId === a.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Approve & run
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Email Sender (real, via Resend connector) ---------------------------
export function EmailSenderPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!workspaceId || !projectId) return;
    setSending(true);
    setInfo(null);
    setError(null);
    try {
      await callEdge("send-email", {
        workspace_id: workspaceId,
        project_id: projectId,
        to,
        subject,
        html: `<p>${body.replace(/\n/g, "<br/>")}</p>`,
      });
      setInfo(`Email sent to ${to}`);
      setTo("");
      setSubject("");
      setBody("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <PageHeader title="Email Sender" description="Send transactional emails via your Resend connector." />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4" /> Compose
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input placeholder="To (email)" value={to} onChange={(e) => setTo(e.target.value)} />
          <Input placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <textarea
            placeholder="Body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button onClick={send} disabled={sending || !to || !subject || !body}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send via Resend
          </Button>
          {info && <p className="text-sm text-emerald-400">{info}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <p className="text-xs text-muted-foreground">
            Connect Resend in Integrations → Catalog if not already done.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// --- Actions Webhooks tab (manage outgoing webhooks + adaptive notifications) ---
export function ActionsWebhooksPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [creating, setCreating] = useState(false);

  // Notification (adapts to whichever messaging connector is configured)
  const [notif, setNotif] = useState("");
  const [sendingNotif, setSendingNotif] = useState(false);
  const [notifResult, setNotifResult] = useState<string | null>(null);

  const { data: messaging } = useQuery({
    queryKey: ["messaging_connectors", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("connectors")
        .select("provider")
        .eq("project_id", projectId!)
        .in("provider", ["slack", "discord", "telegram"]);
      return (data ?? []).map((c) => c.provider as string);
    },
  });

  async function sendNotif() {
    if (!workspaceId || !projectId || !notif.trim()) return;
    setSendingNotif(true);
    setNotifResult(null);
    try {
      const res = await callEdge<{ provider: string }>("send-notification", {
        workspace_id: workspaceId,
        project_id: projectId,
        message: notif.trim(),
      });
      setNotifResult(`Sent via ${res.provider}`);
      setNotif("");
    } catch (e) {
      setNotifResult(e instanceof Error ? e.message : String(e));
    } finally {
      setSendingNotif(false);
    }
  }

  const { data } = useQuery({
    queryKey: ["outgoing_webhooks", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("outgoing_webhooks")
        .select("*")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  async function create() {
    if (!workspaceId || !projectId || !name || !url) return;
    setCreating(true);
    try {
      const secret = crypto.randomUUID().replace(/-/g, "");
      await supabase.from("outgoing_webhooks").insert({
        workspace_id: workspaceId,
        project_id: projectId,
        name,
        url,
        secret,
        events: ["scan.succeeded", "alert.created", "admin_action.executed"],
      });
      setName("");
      setUrl("");
      queryClient.invalidateQueries({ queryKey: ["outgoing_webhooks", projectId] });
    } finally {
      setCreating(false);
    }
  }

  async function test(id: string) {
    await callEdge("dispatch-webhook", { webhook_id: id, event_type: "test.ping", payload: { hello: "world" } });
    queryClient.invalidateQueries({ queryKey: ["outgoing_webhooks", projectId] });
  }

  async function remove(id: string) {
    if (!confirm("Delete webhook?")) return;
    await supabase.from("outgoing_webhooks").delete().eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["outgoing_webhooks", projectId] });
  }

  return (
    <div>
      <PageHeader
        title="Webhooks & notifications"
        description="Outgoing webhooks (HMAC-signed) and one-off notifications via your messaging connector."
      />

      {/* Adaptive notification — uses whichever of Slack / Discord / Telegram is connected */}
      <Card className="mb-6">
        <CardContent className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <Send className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">Send a notification</span>
            {messaging && messaging.length > 0 ? (
              <div className="flex gap-1">
                {messaging.map((m) => (
                  <Badge key={m} variant="info">{m}</Badge>
                ))}
              </div>
            ) : (
              <Badge variant="secondary">no messaging connector</Badge>
            )}
          </div>
          {messaging && messaging.length > 0 ? (
            <div className="flex gap-2">
              <Input placeholder="Your message…" value={notif} onChange={(e) => setNotif(e.target.value)} />
              <Button onClick={sendNotif} disabled={sendingNotif || !notif.trim()}>
                {sendingNotif ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Send
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Connect Slack, Discord or Telegram in Integrations → Catalog to enable notifications.
            </p>
          )}
          {notifResult && <p className="mt-2 text-xs text-muted-foreground">{notifResult}</p>}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardContent className="flex gap-2 p-4">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="https://hooks.example.com/..." value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button onClick={create} disabled={creating || !name || !url}>
            <Plus className="h-4 w-4" /> Create
          </Button>
        </CardContent>
      </Card>
      {!data || data.length === 0 ? (
        <EmptyState icon={Webhook} title="No webhooks yet" />
      ) : (
        <div className="space-y-2">
          {data.map((w: any) => (
            <Card key={w.id}>
              <CardContent className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{w.name}</span>
                    <Badge variant={w.enabled ? "success" : "secondary"}>{w.enabled ? "enabled" : "disabled"}</Badge>
                  </div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{w.url}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => test(w.id)}>
                    Test
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => remove(w.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
