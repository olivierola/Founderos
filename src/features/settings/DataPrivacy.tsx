import { useState } from "react";
import { Download, Loader2, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useAuth } from "@/lib/auth-context";
import { useCurrentContext } from "@/hooks/useCurrentContext";

export function SettingsDataPrivacyPage() {
  const { workspace, workspaceId, role } = useCurrentContext();
  const { signOut } = useAuth();
  const [confirmSlug, setConfirmSlug] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function downloadExport() {
    if (!workspaceId) return;
    const [{ data: projects }, { data: connectors }, { data: scans }, { data: customers }, { data: subs }, { data: logs }] =
      await Promise.all([
        supabase.from("projects").select("*").eq("workspace_id", workspaceId),
        supabase.from("connectors").select("provider, status, created_at").eq("workspace_id", workspaceId),
        supabase.from("scan_results").select("created_at, summary, services").eq("workspace_id", workspaceId),
        supabase.from("customers").select("email, name, external_id, created_at_provider").eq("workspace_id", workspaceId),
        supabase.from("subscriptions").select("plan_name, status, amount_cents, currency").eq("workspace_id", workspaceId),
        supabase
          .from("activity_logs")
          .select("event_type, title, created_at")
          .eq("workspace_id", workspaceId)
          .order("created_at", { ascending: false })
          .limit(500),
      ]);
    const blob = new Blob(
      [JSON.stringify({ exported_at: new Date().toISOString(), projects, connectors, scans, customers, subscriptions: subs, recent_activity: logs }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `founderos-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDelete() {
    if (!workspaceId) return;
    setDeleting(true);
    setError(null);
    try {
      await callEdge("delete-workspace", { workspace_id: workspaceId, confirm_slug: confirmSlug });
      await signOut();
      window.location.href = "/login";
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <PageHeader title="Data & Privacy" description="Export your data or delete the workspace permanently." />
      <div className="space-y-3">
        <Card>
          <CardContent className="flex items-center justify-between p-5">
            <div>
              <div className="text-sm font-medium">Export workspace data</div>
              <div className="text-xs text-muted-foreground">
                JSON snapshot — projects, connectors, scans, customers, subscriptions, last 500 activity logs.
              </div>
            </div>
            <Button size="sm" onClick={downloadExport}>
              <Download className="h-4 w-4" /> Export JSON
            </Button>
          </CardContent>
        </Card>
        <Card className="border-destructive/30">
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-sm font-medium text-destructive">
              <AlertTriangle className="h-4 w-4" /> Delete workspace
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Permanently deletes <strong className="text-foreground">{workspace?.name}</strong> and all related
              data: projects, scans, connectors, customers, costs, AI conversations… This cannot be undone.
            </p>
            {role !== "owner" ? (
              <p className="mt-3 text-xs text-muted-foreground">Only the workspace owner can delete it.</p>
            ) : (
              <div className="mt-3 space-y-2">
                <Input
                  placeholder={`Type the slug "${workspace?.slug ?? ""}" to confirm`}
                  value={confirmSlug}
                  onChange={(e) => setConfirmSlug(e.target.value)}
                />
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={deleting || confirmSlug !== (workspace?.slug ?? "__")}
                >
                  {deleting && <Loader2 className="h-4 w-4 animate-spin" />} Delete workspace permanently
                </Button>
                {error && <p className="text-xs text-destructive">{error}</p>}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
