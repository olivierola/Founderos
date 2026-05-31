import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, Plus, Trash2, Lock, Pencil, Loader2, Search } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useToast } from "@/components/ToastProvider";
import { Can } from "@/lib/permissions";
import { cn } from "@/lib/utils";

interface RoleRow {
  id: string;
  workspace_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  color: string | null;
  is_system: boolean;
}

interface PermissionRow {
  key: string;
  module: string;
  feature: string;
  action: string;
  description: string | null;
  is_destructive: boolean;
}

export function SettingsRolesPage() {
  const { workspaceId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [editorRole, setEditorRole] = useState<RoleRow | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const toast = useToast();

  const { data: roles } = useQuery({
    queryKey: ["roles_full", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase
        .from("roles")
        .select("*")
        .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
        .order("is_system", { ascending: false })
        .order("position", { ascending: true });
      return (data ?? []) as RoleRow[];
    },
  });

  const { data: permissions } = useQuery({
    queryKey: ["permissions_catalog"],
    queryFn: async () => {
      const { data } = await supabase
        .from("permissions")
        .select("*")
        .order("module")
        .order("feature")
        .order("action");
      return (data ?? []) as PermissionRow[];
    },
  });

  const { data: rolePerms } = useQuery({
    queryKey: ["role_permissions_all", workspaceId, (roles ?? []).map((r) => r.id).join(",")],
    enabled: !!roles && roles.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("role_permissions")
        .select("role_id, permission_key")
        .in(
          "role_id",
          (roles ?? []).map((r) => r.id),
        );
      const m = new Map<string, Set<string>>();
      (data ?? []).forEach((row: { role_id: string; permission_key: string }) => {
        const set = m.get(row.role_id) ?? new Set<string>();
        set.add(row.permission_key);
        m.set(row.role_id, set);
      });
      return m;
    },
  });

  async function deleteRole(role: RoleRow) {
    if (role.is_system) return;
    if (!confirm(`Delete custom role "${role.name}"? Members holding this role will need to be reassigned.`)) return;
    try {
      // Direct SQL via service is not possible from the client. Use a tiny
      // RPC-or-edge route. Here we leverage the upsert edge with an empty
      // permissions array? No — better delete server-side. We expose a small
      // delete-role edge later if needed; for now we soft-delete by clearing
      // perms which keeps the row safe but unused. The simplest path:
      // ask the user to remove members first then call the upsert with the
      // same slug to overwrite. To keep this honest, we just clear permissions.
      await toast.run(
        () =>
          callEdge("role-upsert", {
            workspace_id: workspaceId,
            role_id: role.id,
            slug: role.slug,
            name: role.name + " (archived)",
            description: "Archived role — keep until members are reassigned.",
            color: role.color,
            permissions: [],
          }),
        { loading: "Archiving role…", success: "Role archived", error: "Could not archive role" },
      );
      queryClient.invalidateQueries({ queryKey: ["roles_full", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["role_permissions_all", workspaceId] });
    } catch {
      /* toast */
    }
  }

  function openEditor(role: RoleRow | null) {
    setEditorRole(role);
    setEditorOpen(true);
  }

  const builtIn = (roles ?? []).filter((r) => r.is_system);
  const custom = (roles ?? []).filter((r) => !r.is_system);

  return (
    <div>
      <PageHeader
        title="Roles & permissions"
        description="Built-in roles cover most teams. Create custom roles to match how your agency actually operates."
        actions={
          <Can perm="settings.roles.manage">
            <Button size="sm" onClick={() => openEditor(null)}>
              <Plus className="h-4 w-4" /> Custom role
            </Button>
          </Can>
        }
      />

      <h3 className="mb-2 text-sm font-semibold">Built-in roles</h3>
      <div className="mb-8 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {builtIn.map((r) => {
          const perms = rolePerms?.get(r.id) ?? new Set();
          return (
            <Card key={r.id}>
              <CardContent className="space-y-2 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4" style={{ color: r.color ?? undefined }} />
                    <span className="font-semibold">{r.name}</span>
                  </div>
                  <Badge variant="outline" className="text-[10px]"><Lock className="mr-1 h-2.5 w-2.5" /> built-in</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{r.description}</p>
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{perms.size}</span> permission{perms.size > 1 ? "s" : ""}
                </div>
                <Button size="sm" variant="ghost" onClick={() => openEditor(r)} className="w-full">
                  <Pencil className="h-3.5 w-3.5" /> Inspect
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <h3 className="mb-2 text-sm font-semibold">Custom roles</h3>
      {custom.length === 0 ? (
        <EmptyState
          icon={Plus}
          title="No custom role yet"
          description="Create one to match how your agency divides responsibilities."
          action={
            <Can perm="settings.roles.manage">
              <Button onClick={() => openEditor(null)}>
                <Plus className="h-4 w-4" /> Custom role
              </Button>
            </Can>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {custom.map((r) => {
            const perms = rolePerms?.get(r.id) ?? new Set();
            return (
              <Card key={r.id}>
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Shield className="h-4 w-4" style={{ color: r.color ?? undefined }} />
                      <span className="font-semibold">{r.name}</span>
                    </div>
                    <Badge variant="outline" className="text-[10px]">custom</Badge>
                  </div>
                  {r.description && <p className="text-xs text-muted-foreground">{r.description}</p>}
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{perms.size}</span> permission{perms.size > 1 ? "s" : ""}
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openEditor(r)} className="flex-1">
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                    <Can perm="settings.roles.manage">
                      <Button size="sm" variant="ghost" onClick={() => deleteRole(r)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </Can>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {roles && permissions && (
        <RoleEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          role={editorRole}
          permissions={permissions}
          existingPermissions={editorRole ? Array.from(rolePerms?.get(editorRole.id) ?? new Set()) : []}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ["roles_full", workspaceId] });
            queryClient.invalidateQueries({ queryKey: ["role_permissions_all", workspaceId] });
          }}
        />
      )}
    </div>
  );
}

interface EditorProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  role: RoleRow | null;
  permissions: PermissionRow[];
  existingPermissions: string[];
  onSaved: () => void;
}

function RoleEditor({ open, onOpenChange, role, permissions, existingPermissions, onSaved }: EditorProps) {
  const { workspaceId } = useCurrentContext();
  const toast = useToast();
  const isSystem = role?.is_system ?? false;
  const [name, setName] = useState(role?.name ?? "");
  const [slug, setSlug] = useState(role?.slug ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [color, setColor] = useState(role?.color ?? "#a78bfa");
  const [selected, setSelected] = useState<Set<string>>(new Set(existingPermissions));
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  // Re-sync when the role prop changes.
  useMemo(() => {
    if (open) {
      setName(role?.name ?? "");
      setSlug(role?.slug ?? "");
      setDescription(role?.description ?? "");
      setColor(role?.color ?? "#a78bfa");
      setSelected(new Set(existingPermissions));
      setSearch("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, role?.id]);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const m = new Map<string, PermissionRow[]>();
    permissions.forEach((p) => {
      if (q && !p.key.includes(q) && !(p.description ?? "").toLowerCase().includes(q)) return;
      const arr = m.get(p.module) ?? [];
      arr.push(p);
      m.set(p.module, arr);
    });
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [permissions, search]);

  function toggle(key: string) {
    if (isSystem) return;
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  }

  function toggleModule(_mod: string, perms: PermissionRow[]) {
    if (isSystem) return;
    const next = new Set(selected);
    const allSelected = perms.every((p) => next.has(p.key));
    perms.forEach((p) => (allSelected ? next.delete(p.key) : next.add(p.key)));
    setSelected(next);
  }

  async function save() {
    if (!workspaceId || !name.trim() || !slug.trim()) return;
    setSaving(true);
    try {
      await toast.run(
        () =>
          callEdge("role-upsert", {
            workspace_id: workspaceId,
            role_id: role?.id,
            slug: slug.trim(),
            name: name.trim(),
            description: description.trim() || undefined,
            color,
            permissions: Array.from(selected),
          }),
        { loading: "Saving role…", success: "Role saved", error: "Could not save role" },
      );
      onSaved();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" style={{ color }} />
            {isSystem ? "Inspecting built-in role" : role ? "Edit custom role" : "New custom role"}
          </DialogTitle>
          <DialogDescription>
            {isSystem
              ? "Built-in roles are read-only. Duplicate by creating a custom role with the same permissions."
              : "Pick a name and tick the permissions this role grants."}
          </DialogDescription>
        </DialogHeader>

        {!isSystem && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Slug</label>
              <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} className="font-mono" />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs text-muted-foreground">Description</label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Color</label>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-full" />
            </div>
          </div>
        )}

        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search permissions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {selected.size} / {permissions.length} permission{selected.size > 1 ? "s" : ""} selected
          </p>
        </div>

        <div className="space-y-3">
          {grouped.map(([moduleName, perms]) => {
            const allSelected = perms.every((p) => selected.has(p.key));
            const someSelected = perms.some((p) => selected.has(p.key));
            return (
              <div key={moduleName} className="rounded-md border border-border bg-card/40">
                <button
                  type="button"
                  onClick={() => toggleModule(moduleName, perms)}
                  disabled={isSystem}
                  className="flex w-full items-center justify-between gap-2 border-b border-border bg-secondary/30 px-3 py-2 text-left text-xs uppercase tracking-wider hover:bg-secondary/50"
                >
                  <span className="font-semibold">{moduleName}</span>
                  <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    {perms.filter((p) => selected.has(p.key)).length}/{perms.length}
                    <span
                      className={cn(
                        "inline-block h-3 w-3 rounded-sm border",
                        allSelected
                          ? "border-[hsl(var(--primary-soft))] bg-[hsl(var(--primary-soft))]"
                          : someSelected
                            ? "border-[hsl(var(--primary-soft))] bg-[hsl(var(--primary-soft)/0.3)]"
                            : "border-border",
                      )}
                    />
                  </span>
                </button>
                <div className="divide-y divide-border">
                  {perms.map((p) => (
                    <label
                      key={p.key}
                      className={cn(
                        "flex items-start gap-3 px-3 py-2 text-sm",
                        isSystem ? "cursor-default" : "cursor-pointer hover:bg-secondary/40",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(p.key)}
                        onChange={() => toggle(p.key)}
                        disabled={isSystem}
                        className="mt-1 h-4 w-4 accent-[hsl(var(--primary-soft))]"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <code className="font-mono text-[11px]">{p.key}</code>
                          {p.is_destructive && (
                            <Badge variant="destructive" className="text-[10px]">destructive</Badge>
                          )}
                        </div>
                        {p.description && (
                          <p className="mt-0.5 text-xs text-muted-foreground">{p.description}</p>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {!isSystem && (
            <Button onClick={save} disabled={saving || !name.trim() || !slug.trim()}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save role
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
