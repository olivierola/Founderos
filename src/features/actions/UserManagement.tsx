import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Mail, Users, Loader2, Send, UserPlus, Settings2, Database, CreditCard } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useCapabilities, providerLabel } from "@/hooks/useConnectors";
import { AdminActionModal, type AdminActionConfig } from "./AdminActionModal";

const RESET_PASSWORD: AdminActionConfig = {
  action_type: "user.reset_password",
  title: "Send password reset email",
  description: "Triggers a Supabase Auth password reset email.",
  risk: "medium",
  fields: [{ key: "email", label: "User email", placeholder: "user@example.com" }],
};

export function UserManagementPage() {
  const navigate = useNavigate();
  const { workspaceSlug, projectSlug } = useParams();
  const { workspaceId, projectId } = useCurrentContext();
  const { users: usersConnector, billing, loading: capsLoading } = useCapabilities(projectId);
  const queryClient = useQueryClient();
  const [openModal, setOpenModal] = useState<AdminActionConfig | null>(null);
  const [initialValues, setInitialValues] = useState<Record<string, string>>({});
  const [bulkOpen, setBulkOpen] = useState(false);
  const [addUserOpen, setAddUserOpen] = useState(false);

  // Users come from TWO merged sources:
  //  - auth users from the connected auth base (Supabase via db-admin)
  //  - customers imported from the billing provider (Stripe / Lemon Squeezy / Paddle)
  const authProvider = usersConnector?.provider ?? null;
  const hasAuthSource = authProvider === "supabase";

  const { data: authUsers } = useQuery({
    queryKey: ["auth_users_mgmt", projectId],
    enabled: !!projectId && hasAuthSource,
    queryFn: async () => {
      try {
        const res = await callEdge<{ users: any[] }>("db-admin", {
          workspace_id: workspaceId,
          project_id: projectId,
          op: "list_users",
        });
        return res.users ?? [];
      } catch {
        return [];
      }
    },
  });

  const { data: customers } = useQuery({
    queryKey: ["customers_mgmt", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("customers")
        .select("id, external_id, email, name, created_at_provider, provider")
        .eq("project_id", projectId!)
        .order("created_at_provider", { ascending: false })
        .limit(500);
      return data ?? [];
    },
  });

  if (!workspaceId || !projectId) return <PageHeader title="User Management" />;

  // Merge auth users + billing customers, de-duplicated by email.
  interface MergedUser {
    key: string;
    email: string | null;
    name: string | null;
    sources: string[]; // e.g. ["auth:supabase", "billing:stripe"]
    created: string | null;
    lastSignIn: string | null;
    banned: boolean;
  }
  const byEmail = new Map<string, MergedUser>();
  const addOrMerge = (u: Partial<MergedUser> & { key: string; source: string }) => {
    const id = (u.email ?? u.key).toLowerCase();
    const existing = byEmail.get(id);
    if (existing) {
      if (!existing.sources.includes(u.source)) existing.sources.push(u.source);
      existing.name = existing.name ?? u.name ?? null;
      existing.lastSignIn = existing.lastSignIn ?? u.lastSignIn ?? null;
      existing.banned = existing.banned || !!u.banned;
    } else {
      byEmail.set(id, {
        key: u.key,
        email: u.email ?? null,
        name: u.name ?? null,
        sources: [u.source],
        created: u.created ?? null,
        lastSignIn: u.lastSignIn ?? null,
        banned: !!u.banned,
      });
    }
  };
  (authUsers ?? []).forEach((u: any) =>
    addOrMerge({
      key: u.id,
      email: u.email ?? null,
      name: null,
      source: `auth:${authProvider}`,
      created: u.created_at ?? null,
      lastSignIn: u.last_sign_in_at ?? null,
      banned: !!u.banned_until,
    }),
  );
  (customers ?? []).forEach((c: any) =>
    addOrMerge({
      key: c.external_id,
      email: c.email ?? null,
      name: c.name ?? null,
      source: `billing:${c.provider ?? "stripe"}`,
      created: c.created_at_provider ?? null,
    }),
  );
  const merged = [...byEmail.values()].sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));

  if (!capsLoading && merged.length === 0 && !hasAuthSource && !billing) {
    return (
      <div>
        <PageHeader title="User Management" description="Admin operations on your end users." />
        <EmptyState
          icon={Users}
          title="No user source connected"
          description="Connect a user source — Supabase Auth (real auth users) and/or a billing provider (Stripe/Lemon Squeezy customers) — in the catalog."
          action={
            <Button onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/integrations/catalog`)}>
              <Settings2 className="h-4 w-4" /> Open catalog
            </Button>
          }
        />
      </div>
    );
  }

  const recipients: string[] = merged.map((u) => u.email).filter((e): e is string => !!e);

  function sourceBadge(src: string) {
    const [kind, prov] = src.split(":");
    return (
      <Badge key={src} variant={kind === "auth" ? "info" : "secondary"}>
        {kind === "auth" ? <Database className="mr-1 h-3 w-3" /> : <CreditCard className="mr-1 h-3 w-3" />}
        {providerLabel(prov)}
      </Badge>
    );
  }

  return (
    <div>
      <PageHeader
        title="User Management"
        description="Combined view of auth users and billing customers from your connected tools."
        actions={
          <div className="flex items-center gap-2">
            {hasAuthSource && (
              <Button size="sm" onClick={() => setAddUserOpen(true)}>
                <UserPlus className="h-4 w-4" /> Add user
              </Button>
            )}
          </div>
        }
      />

      {merged.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No users yet"
          description="Sync your billing provider or connect Supabase Auth to populate this list."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Joined</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {merged.map((u) => (
                  <tr key={u.key}>
                    <td className="px-4 py-3">
                      <div className="font-medium">{u.email ?? "—"}</div>
                      {u.name && <div className="text-xs text-muted-foreground">{u.name}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">{u.sources.map(sourceBadge)}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {u.created ? new Date(u.created).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={u.banned ? "destructive" : "success"}>{u.banned ? "banned" : "active"}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!u.email}
                        onClick={() => {
                          setInitialValues({ email: u.email! });
                          setOpenModal(RESET_PASSWORD);
                        }}
                      >
                        <KeyRound className="h-3.5 w-3.5" /> Reset password
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardContent className="flex items-center justify-between gap-3 p-5">
          <div className="flex items-center gap-3">
            <Mail className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">Bulk transactional email</div>
              <div className="text-xs text-muted-foreground">
                Email every user with an address, via your Resend connector.
              </div>
            </div>
          </div>
          <Button size="sm" onClick={() => setBulkOpen(true)} disabled={recipients.length === 0}>
            <Mail className="h-4 w-4" /> Compose ({recipients.length})
          </Button>
        </CardContent>
      </Card>

      <BulkEmailDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        recipients={recipients}
        workspaceId={workspaceId}
        projectId={projectId}
      />

      <AddAuthUserDialog
        open={addUserOpen}
        onOpenChange={setAddUserOpen}
        workspaceId={workspaceId}
        projectId={projectId}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ["auth_users_mgmt", projectId] })}
      />

      <AdminActionModal
        open={!!openModal}
        onOpenChange={(o) => !o && setOpenModal(null)}
        action={openModal}
        workspaceId={workspaceId}
        projectId={projectId}
        initialValues={initialValues}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ["admin_actions_recent", projectId] })}
      />
    </div>
  );
}

function AddAuthUserDialog({
  open,
  onOpenChange,
  workspaceId,
  projectId,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  projectId: string;
  onSuccess: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle() {
    setSubmitting(true);
    setError(null);
    try {
      await callEdge("db-admin", {
        workspace_id: workspaceId,
        project_id: projectId,
        op: "create_user",
        email,
        password,
      });
      setEmail("");
      setPassword("");
      onOpenChange(false);
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create auth user</DialogTitle>
          <DialogDescription>Adds a confirmed user to your connected Supabase project.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input
            type="password"
            placeholder="password (min 6 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handle} disabled={submitting || !email || password.length < 6}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />} Create user
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BulkEmailDialog({
  open,
  onOpenChange,
  recipients,
  workspaceId,
  projectId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  recipients: string[];
  workspaceId: string;
  projectId: string;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  async function send() {
    setSending(true);
    setError(null);
    setDoneMsg(null);
    setProgress({ done: 0, total: recipients.length });
    let ok = 0;
    try {
      for (let i = 0; i < recipients.length; i++) {
        try {
          await callEdge("send-email", {
            workspace_id: workspaceId,
            project_id: projectId,
            to: recipients[i],
            subject,
            html: `<p>${body.replace(/\n/g, "<br/>")}</p>`,
          });
          ok++;
        } catch {
          /* continue */
        }
        setProgress({ done: i + 1, total: recipients.length });
      }
      setDoneMsg(`Sent ${ok}/${recipients.length} emails.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk email — {recipients.length} recipients</DialogTitle>
          <DialogDescription>
            Sends individually via your Resend connector. Connect Resend in Integrations → Catalog first.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <textarea
            placeholder="Body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {progress && (
            <p className="text-xs text-muted-foreground">
              Sending {progress.done}/{progress.total}…
            </p>
          )}
          {doneMsg && <p className="text-sm text-emerald-400">{doneMsg}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          <Button onClick={send} disabled={sending || !subject || !body}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Send to {recipients.length}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
