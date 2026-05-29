import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, Loader2, Plus, Trash2, Copy } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";

export function SettingsTeamPage() {
  const { workspaceId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member" | "viewer">("member");
  const [inviting, setInviting] = useState(false);
  const [lastLink, setLastLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: members } = useQuery({
    queryKey: ["team_members", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase
        .from("workspace_members")
        .select("role, user_id, created_at")
        .eq("workspace_id", workspaceId!);
      return data ?? [];
    },
  });

  const { data: invitations } = useQuery({
    queryKey: ["team_invitations", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase
        .from("team_invitations")
        .select("*")
        .eq("workspace_id", workspaceId!)
        .order("created_at", { ascending: false })
        .limit(20);
      return data ?? [];
    },
  });

  async function invite() {
    if (!workspaceId || !email) return;
    setInviting(true);
    setError(null);
    try {
      const res = await callEdge<{ invitation: { token: string } }>("invite-member", {
        workspace_id: workspaceId,
        email,
        role,
      });
      const link = `${window.location.origin}/accept-invite?token=${res.invitation.token}`;
      setLastLink(link);
      setEmail("");
      queryClient.invalidateQueries({ queryKey: ["team_invitations", workspaceId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInviting(false);
    }
  }

  async function revoke(id: string) {
    await supabase.from("team_invitations").update({ status: "revoked" }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["team_invitations", workspaceId] });
  }

  return (
    <div>
      <PageHeader title="Team" description="Invite teammates and assign roles." />

      <Card className="mb-6">
        <CardContent className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-4">
          <Input placeholder="teammate@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as any)}
            className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="admin">admin</option>
            <option value="member">member</option>
            <option value="viewer">viewer</option>
          </select>
          <Button onClick={invite} disabled={inviting || !email}>
            {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Invite
          </Button>
        </CardContent>
      </Card>

      {lastLink && (
        <Card className="mb-6 border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="p-4 text-sm">
            <div className="mb-1 text-xs uppercase text-emerald-400">Invitation link</div>
            <div className="flex items-center justify-between gap-2">
              <code className="break-all text-xs">{lastLink}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(lastLink);
                  setLastLink(null);
                }}
              >
                <Copy className="h-3.5 w-3.5" /> Copy
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <div className="mb-3 text-sm font-medium">Members ({members?.length ?? 0})</div>
            {!members || members.length === 0 ? (
              <EmptyState icon={Users} title="No members" />
            ) : (
              <ul className="divide-y divide-border text-sm">
                {members.map((m: any) => (
                  <li key={m.user_id} className="flex items-center justify-between py-2">
                    <span className="font-mono text-xs text-muted-foreground">{m.user_id.slice(0, 8)}</span>
                    <Badge variant={m.role === "owner" ? "default" : "outline"}>{m.role}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="mb-3 text-sm font-medium">Pending invitations</div>
            {!invitations || invitations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending invitations.</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {invitations.map((inv: any) => (
                  <li key={inv.id} className="flex items-center justify-between py-2">
                    <div>
                      <div>{inv.email}</div>
                      <div className="text-xs text-muted-foreground">
                        {inv.role} · {inv.status}
                      </div>
                    </div>
                    {inv.status === "pending" && (
                      <Button size="icon" variant="ghost" onClick={() => revoke(inv.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
