import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Loader2, Plus, Trash2, Mail, Shield, Copy } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useToast } from "@/components/ToastProvider";
import { Can } from "@/lib/permissions";

interface Member {
  id: string;
  user_id: string;
  role_id: string;
  created_at: string;
  roles: { slug: string; name: string; color: string | null };
}

interface RoleRow {
  id: string;
  workspace_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  color: string | null;
  is_system: boolean;
}

interface Invitation {
  id: string;
  email: string;
  token: string;
  expires_at: string | null;
  accepted_at: string | null;
  role_id: string;
}

export function SettingsTeamPage() {
  const { workspaceId, projectId } = useCurrentContext();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);

  const { data: members, isLoading } = useQuery({
    queryKey: ["project_members", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("project_members")
        .select("id, user_id, role_id, created_at, roles(slug, name, color)")
        .eq("project_id", projectId!)
        .order("created_at", { ascending: true });
      return (data ?? []) as unknown as Member[];
    },
  });

  // Resolve user emails via the auth admin endpoint isn't possible from the
  // client, so we expose a lightweight RPC. For now we display user_id.
  const userIds = (members ?? []).map((m) => m.user_id);
  const { data: emails } = useQuery({
    queryKey: ["member_emails", projectId, userIds.join(",")],
    enabled: userIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.rpc("emails_for_users", { p_users: userIds });
      const rows = (data ?? []) as Array<{ id: string; email: string }>;
      const map = new Map<string, string>();
      rows.forEach((u) => map.set(u.id, u.email));
      return map;
    },
  });

  const { data: roles } = useQuery({
    queryKey: ["roles_available", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase
        .from("roles")
        .select("*")
        .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
        .order("position", { ascending: true });
      return (data ?? []) as RoleRow[];
    },
  });

  const { data: invitations } = useQuery({
    queryKey: ["project_invitations", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("project_invitations")
        .select("id, email, token, expires_at, accepted_at, role_id")
        .eq("project_id", projectId!)
        .is("accepted_at", null)
        .order("created_at", { ascending: false });
      return (data ?? []) as Invitation[];
    },
  });

  async function updateRole(member: Member, role_id: string) {
    await toast.run(
      () =>
        callEdge("project-update-member-role", {
          workspace_id: workspaceId,
          project_id: projectId,
          user_id: member.user_id,
          role_id,
        }),
      { loading: "Updating role…", success: "Role updated", error: "Could not update role" },
    );
    queryClient.invalidateQueries({ queryKey: ["project_members", projectId] });
  }

  async function removeMember(member: Member) {
    if (!confirm(`Remove this member from the project?`)) return;
    await toast.run(
      () =>
        callEdge("project-update-member-role", {
          workspace_id: workspaceId,
          project_id: projectId,
          user_id: member.user_id,
          role_id: null,
        }),
      { loading: "Removing member…", success: "Member removed", error: "Could not remove member" },
    );
    queryClient.invalidateQueries({ queryKey: ["project_members", projectId] });
  }

  return (
    <div>
      <PageHeader
        title="Team & members"
        description="People who have access to this project. Each member holds a role with its own permissions."
        actions={
          <Can perm="settings.team.manage">
            <Button size="sm" onClick={() => setInviteOpen(true)}>
              <Plus className="h-4 w-4" /> Invite member
            </Button>
          </Can>
        }
      />

      <UnifiedTable
        isLoading={isLoading}
        members={members ?? []}
        invitations={invitations ?? []}
        roles={roles ?? []}
        emails={emails}
        updateRole={updateRole}
        removeMember={removeMember}
        onRevoke={async (inv) => {
          if (!confirm(`Revoke invitation to ${inv.email}?`)) return;
          await toast.run(
            () =>
              callEdge("project-revoke-invitation", {
                workspace_id: workspaceId,
                project_id: projectId,
                invitation_id: inv.id,
              }),
            { loading: "Revoking…", success: "Invitation revoked", error: "Could not revoke" },
          );
          queryClient.invalidateQueries({ queryKey: ["project_invitations", projectId] });
        }}
      />

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        roles={roles ?? []}
        onInvited={() => {
          queryClient.invalidateQueries({ queryKey: ["project_members", projectId] });
          queryClient.invalidateQueries({ queryKey: ["project_invitations", projectId] });
        }}
      />
    </div>
  );
}

interface UnifiedTableProps {
  isLoading: boolean;
  members: Member[];
  invitations: Invitation[];
  roles: RoleRow[];
  emails: Map<string, string> | undefined;
  updateRole: (m: Member, role_id: string) => Promise<void>;
  removeMember: (m: Member) => Promise<void>;
  onRevoke: (inv: Invitation) => Promise<void>;
}

function UnifiedTable({
  isLoading,
  members,
  invitations,
  roles,
  emails,
  updateRole,
  removeMember,
  onRevoke,
}: UnifiedTableProps) {
  const toast = useToast();

  if (isLoading) return <EmptyState icon={Loader2} title="Loading…" />;
  if (members.length === 0 && invitations.length === 0) {
    return <EmptyState icon={Users} title="No members yet" description="Invite teammates to give them access to this project." />;
  }

  const rolesById = new Map(roles.map((r) => [r.id, r]));

  return (
    <Card>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Member</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Since</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {/* Active members first */}
            {members.map((m) => {
              const email = emails?.get(m.user_id) ?? m.user_id;
              return (
                <tr key={"m-" + m.id} className="hover:bg-secondary/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-xs font-semibold">
                        {email.slice(0, 1).toUpperCase()}
                      </div>
                      <span className="text-sm">{email}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge kind="active" />
                  </td>
                  <td className="px-4 py-3">
                    <Can perm="settings.team.manage" fallback={<RoleChip role={m.roles} />}>
                      <select
                        value={m.role_id}
                        onChange={(e) => updateRole(m, e.target.value)}
                        className="h-8 rounded-md border border-border bg-card px-2 text-xs"
                      >
                        {roles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </Can>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    Joined {new Date(m.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Can perm="settings.team.manage">
                      <Button size="sm" variant="ghost" onClick={() => removeMember(m)} title="Remove member">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </Can>
                  </td>
                </tr>
              );
            })}

            {/* Pending invitations */}
            {invitations.map((inv) => {
              const role = rolesById.get(inv.role_id);
              const inviteUrl = `${location.origin}/accept-invite?token=${inv.token}`;
              const expired = inv.expires_at && new Date(inv.expires_at) < new Date();
              return (
                <tr key={"i-" + inv.id} className="hover:bg-secondary/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-border text-xs">
                        <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                      <span className="text-sm text-muted-foreground">{inv.email}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge kind={expired ? "expired" : "pending"} />
                  </td>
                  <td className="px-4 py-3">
                    {role ? <RoleChip role={role} /> : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {expired
                      ? "Expired"
                      : inv.expires_at
                        ? `Expires ${new Date(inv.expires_at).toLocaleDateString()}`
                        : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          navigator.clipboard.writeText(inviteUrl);
                          toast.success("Invitation link copied");
                        }}
                        title="Copy invite link"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Can perm="settings.team.manage">
                        <Button size="sm" variant="ghost" onClick={() => onRevoke(inv)} title="Revoke">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </Can>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ kind }: { kind: "active" | "pending" | "expired" }) {
  if (kind === "active") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[hsl(var(--accent-2)/0.4)] bg-[hsl(var(--accent-2)/0.12)] px-2 py-0.5 text-[10px] text-[hsl(var(--accent-2))]">
        <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent-2))]" />
        active
      </span>
    );
  }
  if (kind === "expired") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive">
        <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
        expired
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
      pending
    </span>
  );
}

function RoleChip({ role }: { role: { name: string; color: string | null } }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]"
      style={role.color ? { borderColor: role.color + "55", color: role.color, background: role.color + "12" } : {}}
    >
      <Shield className="h-3 w-3" />
      {role.name}
    </span>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  roles,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  roles: RoleRow[];
  onInvited: () => void;
}) {
  const { workspaceId, projectId } = useCurrentContext();
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState<string>("");
  const toast = useToast();

  async function submit() {
    if (!email.trim() || !roleId || !workspaceId || !projectId) return;
    try {
      const res = await toast.run(
        () =>
          callEdge<{
            kind: string;
            token?: string;
            email_sent?: boolean;
            email_error?: string | null;
            from?: string;
          }>("project-invite-member", {
            workspace_id: workspaceId,
            project_id: projectId,
            email: email.trim(),
            role_id: roleId,
          }),
        {
          loading: "Sending invitation…",
          success: (r) => {
            if (r.kind === "added") return "Member added";
            if (r.email_sent) return `Invitation sent to ${email.trim()}`;
            return "Invitation created — email not sent";
          },
          error: "Invitation failed",
        },
      );
      if (res.kind === "invited" && res.token) {
        const url = `${location.origin}/accept-invite?token=${res.token}`;
        try {
          await navigator.clipboard.writeText(url);
          if (!res.email_sent) {
            toast.info(
              "Email not sent — link copied",
              res.email_error ?? "RESEND_API_KEY is not configured. Share the copied link manually.",
            );
          } else {
            toast.info("Invitation link also copied", url);
          }
        } catch {
          /* ignore */
        }
      }
      onInvited();
      onOpenChange(false);
      setEmail("");
    } catch {
      /* toast already shown */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Email</label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@agency.com" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Role</label>
            <select
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">Pick a role…</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.is_system ? " (built-in)" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!email.trim() || !roleId}>
            Send invitation
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
