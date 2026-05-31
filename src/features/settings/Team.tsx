import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Loader2, Plus, Trash2, Mail, Shield, Copy } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : (members ?? []).length === 0 ? (
        <EmptyState icon={Users} title="No members yet" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Member</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Joined</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(members ?? []).map((m) => {
                  const email = emails?.get(m.user_id) ?? m.user_id;
                  return (
                    <tr key={m.id} className="hover:bg-secondary/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-xs font-semibold">
                            {email.slice(0, 1).toUpperCase()}
                          </div>
                          <span className="text-sm">{email}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Can perm="settings.team.manage" fallback={<RoleChip role={m.roles} />}>
                          <select
                            value={m.role_id}
                            onChange={(e) => updateRole(m, e.target.value)}
                            className="h-8 rounded-md border border-border bg-card px-2 text-xs"
                          >
                            {(roles ?? []).map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                        </Can>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {new Date(m.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Can perm="settings.team.manage">
                          <Button size="sm" variant="ghost" onClick={() => removeMember(m)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </Can>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {(invitations ?? []).length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold">Pending invitations</h3>
          <Card>
            <CardContent className="space-y-2 p-4">
              {invitations!.map((inv) => {
                const role = (roles ?? []).find((r) => r.id === inv.role_id);
                const inviteUrl = `${location.origin}/accept-invite?token=${inv.token}`;
                return (
                  <div
                    key={inv.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-secondary/30 p-3 text-sm"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <span className="truncate">{inv.email}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {role?.name ?? "?"}
                      </Badge>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        navigator.clipboard.writeText(inviteUrl);
                        toast.success("Invitation link copied");
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" /> Copy link
                    </Button>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}

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
          callEdge<{ kind: string; token?: string }>("project-invite-member", {
            workspace_id: workspaceId,
            project_id: projectId,
            email: email.trim(),
            role_id: roleId,
          }),
        {
          loading: "Sending invitation…",
          success: (r) => (r.kind === "added" ? "Member added" : "Invitation created"),
          error: "Invitation failed",
        },
      );
      if (res.kind === "invited" && res.token) {
        const url = `${location.origin}/accept-invite?token=${res.token}`;
        try {
          await navigator.clipboard.writeText(url);
          toast.info("Invitation link copied", url);
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
