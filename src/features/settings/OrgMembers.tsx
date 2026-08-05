import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  UsersThreeIcon, PaperPlaneTiltIcon, CopyIcon, TrashIcon, ClockIcon,
  CheckCircleIcon, ProhibitIcon, ArrowClockwiseIcon,
} from "@phosphor-icons/react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useToast } from "@/components/ToastProvider";
import { cn } from "@/lib/utils";

// Roles an organisation membership can hold (matches the CHECK on
// workspace_members.role and on team_invitations.role).
const ROLES = [
  { id: "owner", label: "Owner", hint: "Tout, y compris la facturation et la suppression" },
  { id: "admin", label: "Admin", hint: "Invite, gère les membres et les réglages" },
  { id: "member", label: "Membre", hint: "Travaille dans l'organisation" },
  { id: "viewer", label: "Lecteur", hint: "Lecture seule" },
] as const;

interface Membership { id: string; user_id: string; role: string; created_at: string }
interface Invitation {
  id: string; email: string; role: string; token: string; status: string;
  created_at: string; expires_at: string | null;
}

const inviteLink = (token: string) => `${window.location.origin}/accept-invite?token=${token}`;
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString() : "—");

/**
 * Organisation members + invitations. The workspace is the billing and access
 * boundary, so this is where people are let in — project membership (see
 * SettingsTeamPage) narrows access once they're already in the org.
 */
export function OrgMembersPage() {
  const { workspaceId, workspace } = useCurrentContext();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("member");
  const [inviting, setInviting] = useState(false);
  const [lastLink, setLastLink] = useState<string | null>(null);

  const { data: members, isLoading } = useQuery({
    queryKey: ["workspace_roster", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("workspace_members")
        .select("id, user_id, role, created_at")
        .eq("workspace_id", workspaceId!)
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as Membership[];
    },
  });

  const { data: emails } = useQuery({
    queryKey: ["workspace_emails", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase.rpc("emails_for_workspace", { p_workspace: workspaceId });
      const map = new Map<string, string>();
      for (const r of (data ?? []) as Array<{ id: string; email: string }>) map.set(r.id, r.email);
      return map;
    },
  });

  const { data: invitations } = useQuery({
    queryKey: ["workspace_invitations", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase
        .from("team_invitations")
        .select("id, email, role, token, status, created_at, expires_at")
        .eq("workspace_id", workspaceId!)
        .order("created_at", { ascending: false });
      return (data ?? []) as Invitation[];
    },
  });

  const myRole = (members ?? []).find((m) => m.user_id === user?.id)?.role ?? "member";
  const canManage = myRole === "owner" || myRole === "admin";
  const owners = (members ?? []).filter((m) => m.role === "owner").length;
  const pending = (invitations ?? []).filter((i) => i.status === "pending");
  const settled = (invitations ?? []).filter((i) => i.status !== "pending");

  async function invite() {
    const target = email.trim().toLowerCase();
    if (!target || !workspaceId || inviting) return;
    if ((members ?? []).some((m) => emails?.get(m.user_id)?.toLowerCase() === target)) {
      toast.error("Cette personne est déjà membre.");
      return;
    }
    setInviting(true);
    try {
      const res = await callEdge<{ invitation: Invitation; email_sent?: boolean }>(
        "invite-member", { workspace_id: workspaceId, email: target, role },
      );
      const link = res.invitation?.token ? inviteLink(res.invitation.token) : null;
      setLastLink(link);
      setEmail("");
      queryClient.invalidateQueries({ queryKey: ["workspace_invitations", workspaceId] });
      // Email delivery needs a Resend connector on the workspace; without it the
      // invitation is still valid — the link just has to be shared by hand.
      if (res.email_sent) toast.success(`Invitation envoyée à ${target}`);
      else toast.success("Invitation créée — copiez le lien ci-dessous");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Invitation impossible");
    } finally { setInviting(false); }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Lien copié");
    } catch { toast.error("Copie impossible"); }
  }

  async function revoke(inv: Invitation) {
    if (!confirm(`Révoquer l'invitation de ${inv.email} ?`)) return;
    const { error } = await supabase.from("team_invitations").update({ status: "revoked" }).eq("id", inv.id);
    if (error) { toast.error(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["workspace_invitations", workspaceId] });
  }

  async function changeRole(m: Membership, next: string) {
    const { error } = await supabase.from("workspace_members").update({ role: next }).eq("id", m.id);
    if (error) { toast.error(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["workspace_roster", workspaceId] });
  }

  async function remove(m: Membership) {
    const who = emails?.get(m.user_id) ?? "ce membre";
    if (!confirm(m.user_id === user?.id ? "Quitter cette organisation ?" : `Retirer ${who} de l'organisation ?`)) return;
    const { error } = await supabase.from("workspace_members").delete().eq("id", m.id);
    if (error) { toast.error(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["workspace_roster", workspaceId] });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <header>
        <h1 className="text-[26px] font-semibold tracking-tight">Membres de l'organisation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {workspace?.name ?? "Organisation"} · {(members ?? []).length} membre(s){pending.length > 0 && `, ${pending.length} invitation(s) en attente`}
        </p>
      </header>

      {/* Invite */}
      {canManage && (
        <section className="rounded-2xl border border-border p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <PaperPlaneTiltIcon className="h-4 w-4 text-muted-foreground" /> Inviter quelqu'un
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <Input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && invite()}
              placeholder="personne@exemple.com" className="min-w-[220px] flex-1"
            />
            <select
              value={role} onChange={(e) => setRole(e.target.value)}
              className="h-10 rounded-md border border-input bg-background px-2 text-sm"
            >
              {ROLES.filter((r) => r.id !== "owner" || myRole === "owner").map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
            <Button onClick={invite} disabled={inviting || !email.trim()}>
              {inviting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Inviter
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{ROLES.find((r) => r.id === role)?.hint}</p>

          {lastLink && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-muted/40 p-2.5">
              <code className="min-w-0 flex-1 truncate text-xs">{lastLink}</code>
              <Button size="sm" variant="outline" onClick={() => copy(lastLink)}>
                <CopyIcon className="mr-1.5 h-3.5 w-3.5" /> Copier
              </Button>
            </div>
          )}
        </section>
      )}

      {/* Roster */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <UsersThreeIcon className="h-4 w-4 text-muted-foreground" /> Membres
        </h2>
        {isLoading ? (
          <div className="flex h-24 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-1.5">
            {(members ?? []).map((m) => {
              const mail = emails?.get(m.user_id);
              const isMe = m.user_id === user?.id;
              const lastOwner = m.role === "owner" && owners === 1;
              return (
                <div key={m.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    {(mail ?? "?").slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{mail ?? m.user_id}{isMe && <span className="ml-1.5 text-xs text-muted-foreground">(vous)</span>}</span>
                    <span className="block text-[11px] text-muted-foreground">Depuis le {fmtDate(m.created_at)}</span>
                  </span>
                  {canManage && !lastOwner ? (
                    <select
                      value={m.role} onChange={(e) => changeRole(m, e.target.value)}
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                    >
                      {ROLES.filter((r) => r.id !== "owner" || myRole === "owner").map((r) => (
                        <option key={r.id} value={r.id}>{r.label}</option>
                      ))}
                    </select>
                  ) : (
                    <span className="rounded-md bg-muted px-2 py-1 text-xs capitalize text-muted-foreground">{m.role}</span>
                  )}
                  {(canManage || isMe) && !lastOwner && (
                    <button
                      onClick={() => remove(m)} title={isMe ? "Quitter l'organisation" : "Retirer"}
                      className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Pending invitations */}
      {canManage && (
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <ClockIcon className="h-4 w-4 text-muted-foreground" /> Invitations en attente
          </h2>
          {pending.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Aucune invitation en attente.
            </p>
          ) : (
            <div className="space-y-1.5">
              {pending.map((inv) => (
                <div key={inv.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{inv.email}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {ROLES.find((r) => r.id === inv.role)?.label ?? inv.role} · expire le {fmtDate(inv.expires_at)}
                    </span>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => copy(inviteLink(inv.token))}>
                    <CopyIcon className="mr-1.5 h-3.5 w-3.5" /> Lien
                  </Button>
                  <button
                    onClick={() => revoke(inv)} title="Révoquer"
                    className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  >
                    <ProhibitIcon className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {settled.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">Historique ({settled.length})</summary>
              <div className="mt-2 space-y-1">
                {settled.slice(0, 20).map((inv) => (
                  <div key={inv.id} className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                    {inv.status === "accepted"
                      ? <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-500" />
                      : inv.status === "revoked"
                        ? <ProhibitIcon className="h-3.5 w-3.5" />
                        : <ArrowClockwiseIcon className="h-3.5 w-3.5" />}
                    <span className="min-w-0 flex-1 truncate">{inv.email}</span>
                    <span className={cn(inv.status === "accepted" && "text-emerald-500")}>{inv.status}</span>
                    <span>{fmtDate(inv.created_at)}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
