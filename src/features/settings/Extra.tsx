import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Plus, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";

// --- Projects --------------------------------------------------------
export function SettingsProjectsPage() {
  const { workspaceId } = useCurrentContext();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["all_projects_settings", workspaceId],
    enabled: !!workspaceId,
    queryFn: async () => {
      const { data } = await supabase
        .from("projects")
        .select("*")
        .eq("workspace_id", workspaceId!)
        .order("created_at", { ascending: false });
      return data ?? [];
    },
  });

  async function createProject() {
    if (!workspaceId || !name || !slug) return;
    setCreating(true);
    try {
      await supabase.from("projects").insert({ workspace_id: workspaceId, name, slug });
      setName("");
      setSlug("");
      await queryClient.invalidateQueries({ queryKey: ["all_projects_settings", workspaceId] });
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <PageHeader title="Projects" description="Manage projects in your workspace." />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" /> New project
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Slug (lowercase)" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
          <Button onClick={createProject} disabled={creating || !name || !slug}>
            {creating && <Loader2 className="h-4 w-4 animate-spin" />} Create
          </Button>
        </CardContent>
      </Card>

      {isLoading ? (
        <EmptyState icon={Loader2} title="Loading…" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Boxes} title="No projects yet" />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {data.map((p: any) => (
            <Card key={p.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{p.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{p.slug}</div>
                  </div>
                  <Badge variant="outline">{p.health_score ?? 0}/100</Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Notifications (persisted in profiles.notification_prefs) ---------
const NOTIF_FIELDS = [
  { key: "emailDigest", label: "Daily email digest" },
  { key: "criticalAlerts", label: "Critical security alerts" },
  { key: "costAlerts", label: "Budget threshold alerts" },
  { key: "scanAlerts", label: "Scan failures" },
] as const;

export function SettingsNotificationsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(false);

  const { data } = useQuery({
    queryKey: ["notification_prefs", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("notification_prefs")
        .eq("id", user!.id)
        .maybeSingle();
      return (data?.notification_prefs ?? {}) as Record<string, boolean>;
    },
  });

  useEffect(() => {
    if (data) {
      const merged: Record<string, boolean> = {};
      NOTIF_FIELDS.forEach((f) => (merged[f.key] = data[f.key] ?? true));
      setPrefs(merged);
    }
  }, [data]);

  async function toggle(key: string, value: boolean) {
    if (!user) return;
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    setSaved(false);
    await supabase.from("profiles").upsert({ id: user.id, notification_prefs: next });
    await queryClient.invalidateQueries({ queryKey: ["notification_prefs", user.id] });
    setSaved(true);
  }

  return (
    <div>
      <PageHeader title="Notifications" description="What FounderOS pings you about. Saved to your account." />
      <Card>
        <CardContent className="space-y-4 p-5">
          {NOTIF_FIELDS.map((f) => (
            <label key={f.key} className="flex items-center justify-between">
              <span className="text-sm">{f.label}</span>
              <input
                type="checkbox"
                checked={prefs[f.key] ?? true}
                onChange={(e) => toggle(f.key, e.target.checked)}
                className="h-4 w-4 cursor-pointer accent-primary"
              />
            </label>
          ))}
          {saved && <p className="text-xs text-emerald-400">Preferences saved.</p>}
          <p className="text-xs text-muted-foreground">
            Stored on your account. The daily digest job honors these when a Resend connector is configured.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
