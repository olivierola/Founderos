import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Send, Loader2, Webhook, Plus, Trash2, ShieldCheck, Check, X, Clock, Users, Eye, Search } from "lucide-react";
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
              <CardContent className="p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm">{a.action_type}</span>
                      <Badge variant={["high", "critical"].includes(a.risk_level) ? "destructive" : "warning"}>{a.risk_level}</Badge>
                      {a.target_id && <span className="truncate font-mono text-xs text-muted-foreground">{a.target_id}</span>}
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
                </div>
                {a.action_type === "code.apply_changes" && <CodeChangePreview payload={a.payload} />}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// Preview of an agent-proposed code change inside the approvals queue.
function CodeChangePreview({ payload }: { payload: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const changes = Array.isArray(payload.changes)
    ? (payload.changes as { path: string; content: string }[])
    : [];
  const mode = String(payload.mode ?? "pull_request");
  const fullName = String(payload.full_name ?? "");
  const commitMessage = String(payload.commit_message ?? "");
  if (changes.length === 0) return null;

  return (
    <div className="mt-3 rounded-md border border-border bg-secondary/30 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant={mode === "direct" ? "destructive" : "info"}>
          {mode === "direct" ? "direct commit" : "pull request"}
        </Badge>
        <span className="font-mono text-muted-foreground">{fullName}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{changes.length} file(s)</span>
        {commitMessage && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="truncate text-muted-foreground">{commitMessage}</span>
          </>
        )}
        <button onClick={() => setOpen((o) => !o)} className="ml-auto text-primary hover:underline">
          {open ? "Hide diff" : "Review files"}
        </button>
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          {changes.map((c, i) => (
            <div key={i}>
              <div className="mb-1 font-mono text-xs text-foreground/80">{c.path}</div>
              <pre className="max-h-64 overflow-auto rounded border border-border bg-background p-2 font-mono text-[11px] leading-relaxed">
                {c.content.slice(0, 4000)}
                {c.content.length > 4000 ? "\n… (truncated)" : ""}
              </pre>
            </div>
          ))}
          {mode === "direct" && (
            <p className="text-xs text-destructive">
              ⚠ This is a DIRECT commit to the base branch — it does not go through a pull request.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// --- Email Sender (bulk, personalized, via Resend) -----------------------
interface EmailCustomer {
  external_id: string;
  email: string | null;
  name: string | null;
  created_at_provider: string | null;
}
interface EmailSub {
  customer_external_id: string;
  status: string;
  plan_name: string | null;
  amount_cents: number;
}

const SEGMENTS = [
  { value: "all", label: "All customers" },
  { value: "paying", label: "Paying" },
  { value: "trial", label: "On trial" },
  { value: "churned", label: "Churned" },
  { value: "new_30d", label: "New (30d)" },
] as const;

const VARS = ["first_name", "name", "email", "plan", "status", "amount", "company"];

const TEMPLATES: Record<string, { subject: string; body: string }> = {
  blank: { subject: "", body: "" },
  winback: {
    subject: "We miss you, {{first_name}} 💚",
    body: "Hi {{first_name}},\n\nWe noticed you left {{company}}. We'd love to have you back — here's 25% off your next 3 months.\n\nWelcome back anytime!",
  },
  announcement: {
    subject: "New in {{company}}: something you'll love",
    body: "Hi {{first_name}},\n\nWe just shipped a big update. As a {{plan}} customer, you get it first.\n\nHappy building!",
  },
  payment_failed: {
    subject: "Action needed: your payment failed",
    body: "Hi {{first_name}},\n\nYour last payment for {{plan}} ({{amount}}) didn't go through. Please update your card to keep your access.\n\nThanks!",
  },
};

export function EmailSenderPage() {
  const { workspaceId, projectId } = useCurrentContext();

  const [mode, setMode] = useState<"segment" | "manual">("segment");
  const [segment, setSegment] = useState<string>("all");
  const [planFilter, setPlanFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [pasted, setPasted] = useState("");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [fromAddr, setFromAddr] = useState("");
  const [sending, setSending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: customers } = useQuery({
    queryKey: ["email_customers", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("customers")
        .select("external_id, email, name, created_at_provider")
        .eq("project_id", projectId!)
        .limit(2000);
      return (data ?? []) as EmailCustomer[];
    },
  });
  const { data: subs } = useQuery({
    queryKey: ["email_subs", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("subscriptions")
        .select("customer_external_id, status, plan_name, amount_cents")
        .eq("project_id", projectId!);
      return (data ?? []) as EmailSub[];
    },
  });

  const subByCust = useMemo(() => {
    const m = new Map<string, EmailSub>();
    (subs ?? []).forEach((s) => {
      const ex = m.get(s.customer_external_id);
      if (!ex || (s.status === "active" && ex.status !== "active")) m.set(s.customer_external_id, s);
    });
    return m;
  }, [subs]);

  const plans = useMemo(() => [...new Set((subs ?? []).map((s) => s.plan_name).filter(Boolean))] as string[], [subs]);

  // Estimate the audience client-side (mirrors the edge logic) for the recipient count.
  const audienceCount = useMemo(() => {
    if (mode === "manual") return picked.size + pasted.split(/[\s,;]+/).filter((e) => e.includes("@")).length;
    const thirtyAgo = Date.now() - 30 * 86400_000;
    return (customers ?? []).filter((c) => {
      if (!c.email) return false;
      const sub = subByCust.get(c.external_id);
      const status = sub?.status ?? "none";
      const paying = ["active", "trialing", "past_due"].includes(status);
      if (segment === "paying" && !paying) return false;
      if (segment === "trial" && status !== "trialing") return false;
      if (segment === "churned" && status !== "canceled") return false;
      if (segment === "new_30d" && !(c.created_at_provider && new Date(c.created_at_provider).getTime() >= thirtyAgo)) return false;
      if (planFilter && (sub?.plan_name ?? "") !== planFilter) return false;
      if (statusFilter && status !== statusFilter) return false;
      return true;
    }).length;
  }, [mode, picked, pasted, customers, subByCust, segment, planFilter, statusFilter]);

  const searchMatches = useMemo(() => {
    const q = search.trim().toLowerCase();
    const withEmail = (customers ?? []).filter((c) => c.email);
    if (!q) return withEmail.slice(0, 12);
    return withEmail.filter((c) => (c.email ?? "").toLowerCase().includes(q) || (c.name ?? "").toLowerCase().includes(q)).slice(0, 12);
  }, [customers, search]);

  function buildPayload(test_to?: string) {
    const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.6">${body.replace(/\n/g, "<br/>")}</div>`;
    const base: Record<string, unknown> = { workspace_id: workspaceId, project_id: projectId, subject, html };
    if (fromAddr) base.from = fromAddr;
    if (test_to) base.test_to = test_to;
    if (mode === "manual") {
      const pastedList = pasted.split(/[\s,;]+/).map((e) => e.trim()).filter((e) => e.includes("@"));
      const pickedEmails = (customers ?? []).filter((c) => picked.has(c.external_id) && c.email).map((c) => c.email);
      base.emails = [...new Set([...pickedEmails, ...pastedList])];
    } else {
      base.audience = {
        segment,
        plan: planFilter || undefined,
        status: statusFilter || undefined,
      };
    }
    return base;
  }

  async function sendTest() {
    if (!workspaceId || !projectId) return;
    const test_to = prompt("Send a test email to which address?");
    if (!test_to) return;
    setTesting(true); setInfo(null); setError(null);
    try {
      const r = await callEdge<{ sent: number }>("send-bulk-email", buildPayload(test_to));
      setInfo(`Test sent to ${test_to} (${r.sent})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setTesting(false); }
  }

  async function send() {
    if (!workspaceId || !projectId || !subject || !body) return;
    if (!confirm(`Send this email to ${audienceCount} recipient(s)?`)) return;
    setSending(true); setInfo(null); setError(null);
    try {
      const r = await callEdge<{ sent: number; failed: number }>("send-bulk-email", buildPayload());
      setInfo(`Sent to ${r.sent} recipient(s)${r.failed ? `, ${r.failed} failed` : ""}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setSending(false); }
  }

  function insertVar(v: string) {
    setBody((b) => `${b}{{${v}}}`);
  }

  return (
    <div>
      <PageHeader title="Email Sender" description="Send personalized emails in bulk via Resend, with dynamic variables from your SaaS data." />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Audience */}
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Users className="h-4 w-4" /> Audience</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-1.5">
              <Button size="sm" variant={mode === "segment" ? "default" : "outline"} onClick={() => setMode("segment")}>Segment</Button>
              <Button size="sm" variant={mode === "manual" ? "default" : "outline"} onClick={() => setMode("manual")}>Manual</Button>
            </div>

            {mode === "segment" ? (
              <>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Segment</label>
                  <select value={segment} onChange={(e) => setSegment(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                    {SEGMENTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">Plan filter</label>
                    <select value={planFilter} onChange={(e) => setPlanFilter(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                      <option value="">Any plan</option>
                      {plans.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-muted-foreground">Status filter</label>
                    <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                      <option value="">Any status</option>
                      {["active", "trialing", "past_due", "canceled"].map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customers…" className="pl-8" />
                </div>
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {searchMatches.map((c) => (
                    <label key={c.external_id} className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2 text-sm">
                      <input type="checkbox" className="h-4 w-4 accent-primary" checked={picked.has(c.external_id)} onChange={() => setPicked((prev) => { const n = new Set(prev); n.has(c.external_id) ? n.delete(c.external_id) : n.add(c.external_id); return n; })} />
                      <span className="min-w-0 flex-1 truncate">{c.email}</span>
                    </label>
                  ))}
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">Or paste emails (comma / newline separated)</label>
                  <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} rows={3} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
                </div>
              </>
            )}

            <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-2.5 text-sm">
              <Users className="h-4 w-4 text-primary" />
              <span className="font-medium">{audienceCount}</span> recipient(s) will receive this email
            </div>
          </CardContent>
        </Card>

        {/* Compose */}
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Mail className="h-4 w-4" /> Compose</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Template</label>
              <select
                onChange={(e) => { const t = TEMPLATES[e.target.value]; if (t) { setSubject(t.subject); setBody(t.body); } }}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                defaultValue="blank"
              >
                <option value="blank">Blank</option>
                <option value="winback">Winback</option>
                <option value="announcement">Announcement</option>
                <option value="payment_failed">Payment failed</option>
              </select>
            </div>
            <Input placeholder="Subject (supports {{variables}})" value={subject} onChange={(e) => setSubject(e.target.value)} />
            <Input placeholder="From (optional, e.g. You <hi@yourdomain.com>)" value={fromAddr} onChange={(e) => setFromAddr(e.target.value)} />
            <div>
              <div className="mb-1 flex flex-wrap items-center gap-1">
                <span className="text-xs text-muted-foreground">Insert variable:</span>
                {VARS.map((v) => (
                  <button key={v} onClick={() => insertVar(v)} className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-primary hover:bg-secondary">{`{{${v}}}`}</button>
                ))}
              </div>
              <textarea placeholder="Body (use {{first_name}}, {{plan}}, {{amount}}…)" value={body} onChange={(e) => setBody(e.target.value)} rows={8} className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={send} disabled={sending || !subject || !body || audienceCount === 0}>
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send to {audienceCount}
              </Button>
              <Button variant="outline" onClick={sendTest} disabled={testing || !subject || !body}>
                {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Send test
              </Button>
            </div>
            {info && <p className="text-sm text-emerald-400">{info}</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <p className="text-xs text-muted-foreground">Connect Resend in Integrations → Catalog if not already done. Max 500 recipients per send.</p>
          </CardContent>
        </Card>
      </div>
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
